/**
 * 合成截图的场景生成与渲染。
 *
 * 全部布局都在「逻辑点」里写（画布 1792×1120 pt = 本机屏幕的逻辑尺寸），
 * 渲染时按输出像素等比缩放。真值框因此只有一份，换算到任何尺寸都由同一个比例推出。
 *
 * 【判别力】标签全部是随机拼出的假词：模型不能靠「File 通常在最左边」这类先验蒙中，
 * 只能真的去读图。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SPIKE_ROOT } from "./env.js";
import { randomCode, shuffle } from "./harness.js";

export const LOGICAL_W = 1792;
export const LOGICAL_H = 1120;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Element {
  kind: "rect" | "ellipse" | "triangle" | "diamond" | "text";
  x: number;
  y: number;
  w?: number;
  h?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  text?: string;
  size?: number;
  weight?: "regular" | "medium" | "semibold" | "bold";
  color?: string;
  mono?: boolean;
  id?: string;
}

export interface Viewport extends Box {}

export interface RenderSpec {
  width: number;
  height: number;
  viewport: Viewport;
  background: string;
  elements: Element[];
}

export const FULL: Viewport = { x: 0, y: 0, w: LOGICAL_W, h: LOGICAL_H };

// ───────────────────────────────────────────────────────────── 渲染

const BIN = join(SPIKE_ROOT, ".bin/render");

function ensureRenderer(): void {
  if (existsSync(BIN)) return;
  // `.bin/` 被忽略，干净 checkout 里没有它 —— swiftc 不会替你建输出目录（2026-10-03 评审 CU-R12）。
  mkdirSync(dirname(BIN), { recursive: true });
  execFileSync("swiftc", ["-swift-version", "5", "-O", join(SPIKE_ROOT, "render/render.swift"), "-o", BIN], {
    stdio: "inherit",
  });
}

/** 一次进程渲染一批。任何「标签比它的框宽」都直接抛：那样的夹具，命中判定不可信。 */
export function render(specs: RenderSpec[]): Buffer[] {
  ensureRenderer();
  const dir = mkdtempSync(join(tmpdir(), "s1-render-"));
  const images = specs.map((s, i) => ({ ...s, out: join(dir, `${i}.png`) }));
  const batchFile = join(dir, "batch.json");
  writeFileSync(batchFile, JSON.stringify({ images }));
  const stdout = execFileSync(BIN, [batchFile], { encoding: "utf8" });
  for (const line of stdout.trim().split("\n")) {
    const r = JSON.parse(line) as { out: string; overflow: string[] };
    if (r.overflow.length > 0) throw new Error(`渲染溢出：${r.out} → ${r.overflow.join(", ")}`);
  }
  return images.map((s) => readFileSync(s.out));
}

// ───────────────────────────────────────────────────────────── 词表

const ONSETS = ["b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "br", "tr", "pl", "gr", "st"];
const VOWELS = ["a", "e", "i", "o", "u", "ai", "ou"];
const CODAS = ["", "", "n", "l", "r", "s", "m", "k"];

/** 随机假词（首字母大写），同一场景内去重。 */
export function wordMaker(rand: () => number): (maxLen?: number) => string {
  const used = new Set<string>();
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  return (maxLen = 7) => {
    for (;;) {
      const syl = 2 + Math.floor(rand() * 2);
      let w = "";
      for (let i = 0; i < syl; i++) w += pick(ONSETS) + pick(VOWELS) + (i === syl - 1 ? pick(CODAS) : "");
      if (w.length < 4 || w.length > maxLen || used.has(w)) continue;
      used.add(w);
      return w[0]!.toUpperCase() + w.slice(1);
    }
  };
}

const ICON_COLORS: Array<[string, string]> = [
  ["红色", "#E5484D"],
  ["绿色", "#30A46C"],
  ["蓝色", "#3E63DD"],
  ["橙色", "#F76B15"],
  ["紫色", "#8E4EC6"],
  ["青色", "#12A594"],
  ["粉色", "#D6409F"],
  ["棕色", "#AD7F58"],
];
const ICON_SHAPES: Array<[string, Element["kind"]]> = [
  ["圆形", "ellipse"],
  ["三角形", "triangle"],
  ["菱形", "diamond"],
  ["方形", "rect"],
];

// ───────────────────────────────────────────────────────────── 公共外壳

function desktopAndWindow(word: () => string, title: string): Element[] {
  const els: Element[] = [
    { kind: "rect", x: 0, y: 0, w: LOGICAL_W, h: 24, fill: "#F4F4F4" },
    { kind: "text", x: 16, y: 4, text: word(), size: 13, weight: "bold" },
    { kind: "text", x: 1700, y: 4, text: "10:42", size: 13 },
    { kind: "rect", x: 96, y: 56, w: 1600, h: 1000, fill: "#FFFFFF", stroke: "#C8C8C8", radius: 10 },
    { kind: "rect", x: 96, y: 56, w: 1600, h: 44, fill: "#F0F0F0", radius: 10 },
    { kind: "ellipse", x: 112, y: 72, w: 12, h: 12, fill: "#FF5F57" },
    { kind: "ellipse", x: 132, y: 72, w: 12, h: 12, fill: "#FEBC2E" },
    { kind: "ellipse", x: 152, y: 72, w: 12, h: 12, fill: "#28C840" },
    { kind: "text", x: 96, y: 56, w: 1600, h: 44, text: title, size: 13, weight: "semibold" },
  ];
  return els;
}

// ───────────────────────────────────────────────────────────── P-2：应用界面

export interface Target {
  id: string;
  category: "menu" | "toolbar" | "icon" | "sidebar" | "checkbox" | "field" | "primary";
  desc: string;
  box: Box;
}

export interface AppScene {
  elements: Element[];
  targets: Target[];
}

/**
 * 一个像样的桌面应用窗口：菜单栏、工具栏、图标栏、侧边栏、复选框、输入框、表格、主按钮。
 * 目标从各类控件里随机抽，尺寸从 14 pt（复选框）到 280 pt（侧边栏整行）都有。
 */
export function appScene(rand: () => number): AppScene {
  const word = wordMaker(rand);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const els = desktopAndWindow(word, `${word()} — ${word()}`);
  const cands: Record<Target["category"], Omit<Target, "id">[]> = {
    menu: [],
    toolbar: [],
    icon: [],
    sidebar: [],
    checkbox: [],
    field: [],
    primary: [],
  };

  // 菜单栏
  for (let i = 0; i < 6; i++) {
    const label = word(6);
    const box = { x: 110 + i * 84, y: 0, w: 84, h: 24 };
    els.push({ kind: "text", ...box, text: label, size: 13, id: `menu-${label}` });
    cands.menu.push({ category: "menu", desc: `顶部菜单栏里的「${label}」菜单`, box });
  }

  // 工具栏
  for (let i = 0; i < 8; i++) {
    const label = word(7);
    const box = { x: 120 + i * 112 + Math.floor(rand() * 8), y: 112, w: 96, h: 28 };
    els.push({ kind: "rect", ...box, fill: "#FFFFFF", stroke: "#BDBDBD", radius: 6 });
    els.push({ kind: "text", ...box, text: label, size: 13, id: `tb-${label}` });
    cands.toolbar.push({ category: "toolbar", desc: `工具栏里标着「${label}」的按钮`, box });
  }

  // 图标栏：8 种颜色各一次，形状随机
  const colors = shuffle(rand, ICON_COLORS);
  for (let i = 0; i < 8; i++) {
    const [cname, chex] = colors[i]!;
    const [sname, kind] = pick(ICON_SHAPES);
    const box = { x: 124 + i * 40, y: 156, w: 18, h: 18 };
    els.push({ kind, ...box, fill: chex, radius: kind === "rect" ? 3 : undefined });
    cands.icon.push({ category: "icon", desc: `图标栏里的${cname}${sname}图标`, box });
  }

  // 侧边栏
  els.push({ kind: "rect", x: 96, y: 196, w: 280, h: 860, fill: "#F7F7F9" });
  const selected = Math.floor(rand() * 14);
  for (let i = 0; i < 14; i++) {
    const label = word(7);
    const box = { x: 96, y: 208 + i * 28, w: 280, h: 28 };
    if (i === selected) els.push({ kind: "rect", ...box, fill: "#DCE6FB" });
    els.push({ kind: "text", x: 116, y: box.y + 6, text: label, size: 13 });
    cands.sidebar.push({ category: "sidebar", desc: `左侧边栏里「${label}」这一行`, box });
  }

  // 复选框
  els.push({ kind: "text", x: 424, y: 212, text: word(), size: 15, weight: "semibold" });
  for (let c = 0; c < 2; c++) {
    for (let r = 0; r < 5; r++) {
      const label = word(7);
      const box = { x: 432 + c * 320, y: 256 + r * 36, w: 14, h: 14 };
      const checked = rand() < 0.4;
      els.push({ kind: "rect", ...box, fill: checked ? "#3E63DD" : "#FFFFFF", stroke: checked ? "#3E63DD" : "#8A8A8A", radius: 3 });
      els.push({ kind: "text", x: box.x + 24, y: box.y - 1, text: label, size: 13 });
      cands.checkbox.push({ category: "checkbox", desc: `「${label}」左边的复选框`, box });
    }
  }

  // 输入框
  for (let i = 0; i < 3; i++) {
    const ph = word(7);
    const box = { x: 432, y: 460 + i * 52, w: 300, h: 28 };
    els.push({ kind: "rect", ...box, fill: "#FFFFFF", stroke: "#BDBDBD", radius: 5 });
    els.push({ kind: "text", x: box.x + 10, y: box.y + 6, text: `${ph}…`, size: 13, color: "#9A9A9A" });
    cands.field.push({ category: "field", desc: `占位文字为「${ph}…」的输入框`, box });
  }

  // 表格（干扰物，不出目标）
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 3; c++) {
      els.push({ kind: "text", x: 820 + c * 280, y: 460 + r * 30, text: word(7), size: 12, color: "#444444" });
    }
  }

  // 右下角按钮
  const secondary = word(6);
  const primary = word(6);
  const secBox = { x: 1440, y: 990, w: 110, h: 32 };
  const priBox = { x: 1564, y: 990, w: 110, h: 32 };
  els.push({ kind: "rect", ...secBox, fill: "#FFFFFF", stroke: "#BDBDBD", radius: 7 });
  els.push({ kind: "text", ...secBox, text: secondary, size: 13, id: `sec-${secondary}` });
  els.push({ kind: "rect", ...priBox, fill: "#2F6FEB", radius: 7 });
  els.push({ kind: "text", ...priBox, text: primary, size: 13, color: "#FFFFFF", weight: "medium", id: `pri-${primary}` });
  cands.primary.push({ category: "primary", desc: `右下角蓝色的「${primary}」按钮`, box: priBox });

  const quota: Array<[Target["category"], number]> = [
    ["menu", 1],
    ["toolbar", 2],
    ["icon", 2],
    ["sidebar", 1],
    ["checkbox", 2],
    ["field", 1],
    ["primary", 1],
  ];
  const chosen: Omit<Target, "id">[] = [];
  for (const [cat, n] of quota) chosen.push(...shuffle(rand, cands[cat]).slice(0, n));
  const targets = shuffle(rand, chosen).map((t, i) => ({ ...t, id: `T${i + 1}` }));
  return { elements: els, targets };
}

export function specOf(scene: { elements: Element[] }, width: number, height: number, viewport: Viewport = FULL): RenderSpec {
  return { width, height, viewport, background: "#D9DEE5", elements: scene.elements };
}

// ───────────────────────────────────────────────────────────── P-1：验证码屏

/** 一屏「应用界面＋一个大号验证码」。编码只出现在图里，任何文本通道里都没有。 */
export function codeScene(rand: () => number, code: string): { elements: Element[] } {
  const word = wordMaker(rand);
  const els = desktopAndWindow(word, `${word()} 安全中心`);
  for (let i = 0; i < 6; i++) {
    const box = { x: 120 + i * 112, y: 112, w: 96, h: 28 };
    els.push({ kind: "rect", ...box, fill: "#FFFFFF", stroke: "#BDBDBD", radius: 6 });
    els.push({ kind: "text", ...box, text: word(7), size: 13 });
  }
  const card = { x: 520 + Math.floor(rand() * 400), y: 360 + Math.floor(rand() * 300), w: 560, h: 180 };
  els.push({ kind: "rect", ...card, fill: "#F5F7FB", stroke: "#C9D3E6", radius: 12 });
  els.push({ kind: "text", x: card.x + 32, y: card.y + 28, text: "当前验证码", size: 20, weight: "semibold" });
  els.push({ kind: "text", x: card.x + 32, y: card.y + 84, text: code, size: 40, weight: "bold", mono: true });
  return { elements: els };
}

// ───────────────────────────────────────────────────────────── P-5：小字可读性

export interface LegibilityBox {
  label: string;
  code: string;
  size: number;
  box: Box;
}

export const LEGIBILITY_SIZES = [9, 10, 11, 12, 13, 15];

/**
 * 12 个带字母标签的框，框里是 XXX-XXX 编码，字号 9–15 pt 各两个（随机分配位置）。
 * 标签用 15 pt 粗体，永远看得清；被测的只有框里的编码。
 * 布局保证每个框完整落在四个象限之一，供「放大」条件裁片。
 */
export function legibilityScene(rand: () => number): { elements: Element[]; boxes: LegibilityBox[] } {
  const word = wordMaker(rand);
  const els = desktopAndWindow(word, `${word()} 报表`);
  const sizes = shuffle(rand, [...LEGIBILITY_SIZES, ...LEGIBILITY_SIZES]);
  const boxes: LegibilityBox[] = [];
  const letters = "ABCDEFGHIJKL";
  let k = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const box = { x: 220 + c * 360, y: 240 + r * 260, w: 170, h: 34 };
      const label = letters[k]!;
      const code = randomCode(rand, [3, 3]);
      const size = sizes[k]!;
      els.push({ kind: "text", x: box.x, y: box.y - 24, text: label, size: 15, weight: "bold" });
      els.push({ kind: "rect", ...box, fill: "#FAFAFA", stroke: "#CFCFCF", radius: 4 });
      els.push({ kind: "text", ...box, text: code, size, color: "#333333", id: `code-${label}` });
      boxes.push({ label, code, size, box });
      k++;
    }
  }
  return { elements: els, boxes };
}

export const QUADRANTS: Viewport[] = [
  { x: 0, y: 0, w: 896, h: 560 },
  { x: 896, y: 0, w: 896, h: 560 },
  { x: 0, y: 560, w: 896, h: 560 },
  { x: 896, y: 560, w: 896, h: 560 },
];

export function inside(b: Box, v: Viewport): boolean {
  return b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h;
}
