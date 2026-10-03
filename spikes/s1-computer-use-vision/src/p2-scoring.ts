/**
 * P-2 的解析与打分。探针与离线重打分（rescore-p2.ts）共用这一份 ——
 * 两处各写一遍，重打分与原始打分就会悄悄分叉。
 *
 * 解析要宽容：第一轮实测里 qwen3.8-flash 有 4 次无视「{"points":[...]}」的格式要求，
 * 改用它自己训练时的定位格式 `[{"point_2d":[x,y],"label":"T1"}]`。
 * 这本身是有价值的观察（暴露了模型的默认坐标习惯），不能当作「没答」丢掉。
 */

import { LOGICAL_H, LOGICAL_W, type Target } from "./scenes.js";

export interface Point {
  id: string;
  x: number;
  y: number;
  format: "points" | "point_2d" | "array" | "map";
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * 有记录的宽松修复。实测 qwen3.8-flash 关闭思考后常写出 `"x": 85, y": 149`、
 * `"x": [246, 270]`、`y: "234"` 这类不合法 JSON。修复只为把定位信息救回来量精度；
 * 「严格可解析」另行统计（parseMode），不许被修复掩盖。
 */
function repairJsonish(s: string): string {
  return s
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)"\s*:/g, '$1"$2":') // 缺左引号的键
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":') // 无引号的键
    .replace(/"x"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*([,}])/g, '"x": $1, "y": $2$3')
    .replace(/"(x|y)"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*\]/g, '"$1": $2')
    .replace(/"(x|y)"\s*:\s*"(-?\d+(?:\.\d+)?)"/g, '"$1": $2');
}

export type ParseMode = "strict" | "repaired" | "none";

/** 在文本里找第一个能解析的 JSON（对象或数组）。先严格，后修复。 */
export function extractAnyJson(text: string): { value: unknown; mode: ParseMode } {
  const candidates: string[] = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const s = text.indexOf(open);
    const e = text.lastIndexOf(close);
    if (s >= 0 && e > s) candidates.push(text.slice(s, e + 1));
  }
  for (const c of candidates) {
    const v = tryParse(c);
    if (v !== undefined) return { value: v, mode: "strict" };
  }
  for (const c of candidates) {
    const v = tryParse(repairJsonish(c));
    if (v !== undefined) return { value: v, mode: "repaired" };
  }
  return { value: undefined, mode: "none" };
}

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)
      ? Number(v)
      : undefined;

/** label 可能是 "T3"、"T3：…描述" 或纯描述 —— 都要能对回目标。 */
function resolveId(raw: string, targets: Target[]): string {
  const m = raw.match(/\bT(\d+)\b/);
  if (m) return `T${m[1]}`;
  const hit = targets.find((t) => raw.includes(t.desc) || t.desc.includes(raw));
  return hit ? hit.id : raw;
}

export function parsePoints(text: string, targets: Target[] = []): Point[] & { mode?: ParseMode } {
  const { value: v, mode } = extractAnyJson(text);
  const out: Point[] & { mode?: ParseMode } = [];
  out.mode = mode;
  const pushItem = (item: any, fallbackId?: string, arrayForm = false) => {
    if (!item || typeof item !== "object") return;
    const id = resolveId(String(item.id ?? item.label ?? item.target ?? fallbackId ?? ""), targets);
    if (Array.isArray(item.point_2d) && item.point_2d.length >= 2) {
      const x = num(item.point_2d[0]);
      const y = num(item.point_2d[1]);
      if (x !== undefined && y !== undefined) out.push({ id, x, y, format: "point_2d" });
      return;
    }
    const x = num(item.x);
    const y = num(item.y);
    if (x !== undefined && y !== undefined) out.push({ id, x, y, format: arrayForm ? "array" : "points" });
  };
  if (Array.isArray(v)) {
    for (const item of v) pushItem(item, undefined, true);
  } else if (v && typeof v === "object") {
    const obj = v as Record<string, any>;
    if (Array.isArray(obj["points"])) {
      for (const item of obj["points"]) pushItem(item);
    } else {
      for (const [k, val] of Object.entries(obj)) {
        if (Array.isArray(val) && val.length >= 2 && num(val[0]) !== undefined && num(val[1]) !== undefined) {
          out.push({ id: k, x: val[0], y: val[1], format: "map" });
        } else if (val && typeof val === "object") {
          pushItem(val, k);
          if (out.length && out[out.length - 1]!.format === "points") out[out.length - 1]!.format = "map";
        }
      }
    }
  }
  return out;
}

export interface Scored {
  id: string;
  category: Target["category"];
  boxPt: Target["box"];
  pred?: { x: number; y: number };
  format?: Point["format"];
  hitPixel: boolean;
  hitNorm: boolean;
  errPixelPt?: number;
  errNormPt?: number;
}

/** 命中在逻辑点里判：同一个预测分别按「图片像素」与「0–1000 归一化」两种假设换算。 */
export function scorePoints(points: Point[], targets: Target[], w: number, h: number): Scored[] {
  return targets.map((t) => {
    const p = points.find((q) => q.id === t.id);
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    if (!p) return { id: t.id, category: t.category, boxPt: t.box, hitPixel: false, hitNorm: false };
    const asPixel = { x: (p.x * LOGICAL_W) / w, y: (p.y * LOGICAL_H) / h };
    const asNorm = { x: (p.x * LOGICAL_W) / 1000, y: (p.y * LOGICAL_H) / 1000 };
    const inBox = (q: { x: number; y: number }) =>
      q.x >= t.box.x && q.x <= t.box.x + t.box.w && q.y >= t.box.y && q.y <= t.box.y + t.box.h;
    return {
      id: t.id,
      category: t.category,
      boxPt: t.box,
      pred: { x: p.x, y: p.y },
      format: p.format,
      hitPixel: inBox(asPixel),
      hitNorm: inBox(asNorm),
      errPixelPt: Math.hypot(asPixel.x - cx, asPixel.y - cy),
      errNormPt: Math.hypot(asNorm.x - cx, asNorm.y - cy),
    };
  });
}

/** 最小二乘 y = a·x + b。 */
export function fit(xs: number[], ys: number[]): { a: number; b: number } | undefined {
  const n = xs.length;
  if (n < 3) return undefined;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  if (sxx === 0) return undefined;
  const a = sxy / sxx;
  return { a: +a.toFixed(4), b: +(my - a * mx).toFixed(1) };
}

/**
 * 由斜率推断这次回答用的坐标系。
 *   PIXEL：两轴斜率都≈1；NORM_1000：a_x≈1000/W 且 a_y≈1000/H；
 *   UNIFORM_SCALE：两轴斜率相近但不≈1（模型在一张被缩放过的图上读坐标）；其余 UNCLEAR。
 */
export function inferFrame(fx: { a: number } | undefined, fy: { a: number } | undefined, w: number, h: number): string {
  if (!fx || !fy) return "NO_FIT";
  const near = (a: number, b: number) => Math.abs(a - b) / b < 0.12;
  if (near(fx.a, 1) && near(fy.a, 1)) return "PIXEL";
  if (near(fx.a, 1000 / w) && near(fy.a, 1000 / h)) return "NORM_1000";
  if (near(fx.a, fy.a)) return `UNIFORM_SCALE(${((fx.a + fy.a) / 2).toFixed(3)})`;
  return "UNCLEAR";
}

export function analyze(text: string, targets: Target[], w: number, h: number) {
  const points = parsePoints(text, targets);
  const scored = scorePoints(points, targets, w, h);
  const withPred = scored.filter((s) => s.pred);
  const tx = withPred.map((s) => ((s.boxPt.x + s.boxPt.w / 2) * w) / LOGICAL_W);
  const ty = withPred.map((s) => ((s.boxPt.y + s.boxPt.h / 2) * h) / LOGICAL_H);
  const fx = fit(tx, withPred.map((s) => s.pred!.x));
  const fy = fit(ty, withPred.map((s) => s.pred!.y));
  return {
    scored,
    parseMode: points.mode ?? "none",
    parsed: withPred.length,
    formats: [...new Set(withPred.map((s) => s.format))],
    hitPixel: scored.filter((s) => s.hitPixel).length,
    hitNorm: scored.filter((s) => s.hitNorm).length,
    fitX: fx,
    fitY: fy,
    frame: inferFrame(fx, fy, w, h),
  };
}
