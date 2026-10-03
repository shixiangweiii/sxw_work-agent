/**
 * 不花钱：读取全部 P-2 证据，用同一份种子重建真值、用 p2-scoring 重新打分，输出汇总表。
 *   npx tsx spikes/s1-computer-use-vision/src/rescore-p2.ts
 *
 * 命中按「这次回答实际用的坐标系」判：
 *   pixel / norm1000 两种问法 → 按要求的那种判（模型没照做就该算不中）；
 *   unspecified → 按斜率推断出的坐标系判，推断不出时取两种假设里命中多的那个。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RAW_DIR, prng } from "./harness.js";
import { analyze, type ParseMode } from "./p2-scoring.js";
import { appScene, type Target } from "./scenes.js";

interface Row {
  group: string;
  seed: number;
  size: string;
  convention: string;
  exhausted: boolean;
  parseMode: ParseMode;
  parsed: number;
  formats: string[];
  frame: string;
  hits: number;
  categories: Array<{ category: Target["category"]; hit: boolean; errPt?: number }>;
}

const sceneCache = new Map<number, Target[]>();
const targetsOf = (seed: number) => {
  if (!sceneCache.has(seed)) sceneCache.set(seed, appScene(prng(seed)).targets);
  return sceneCache.get(seed)!;
};

const rows: Row[] = [];
for (const f of readdirSync(RAW_DIR).filter((n) => /^p2-(deepseek|bailian)-.*\.jsonl$/.test(n)).sort()) {
  const lines = readFileSync(join(RAW_DIR, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.kind === "meta");
  for (const c of lines.filter((l) => l.kind === "call")) {
    const [w, h] = String(c.size).split("x").map(Number) as [number, number];
    const thinking = c.thinking ?? meta?.params?.thinking ?? "default";
    const maxTokens = c.maxTokens ?? meta?.params?.maxTokens ?? 8192;
    const a = analyze(c.text ?? "", targetsOf(c.seed), w, h);
    let hitBy: "pixel" | "norm";
    if (c.convention === "pixel") hitBy = "pixel";
    else if (c.convention === "norm1000") hitBy = "norm";
    else if (a.frame === "PIXEL") hitBy = "pixel";
    else if (a.frame === "NORM_1000") hitBy = "norm";
    else hitBy = a.hitPixel >= a.hitNorm ? "pixel" : "norm";
    const outputTokens = c.usage?.output_tokens;
    rows.push({
      group: `${meta.endpoint} · 思考=${thinking} · 上限=${maxTokens}`,
      seed: c.seed,
      size: c.size,
      convention: c.convention,
      exhausted: a.parsed === 0 && typeof outputTokens === "number" && outputTokens >= maxTokens,
      parseMode: a.parseMode,
      parsed: a.parsed,
      formats: a.formats as string[],
      frame: a.frame,
      hits: hitBy === "pixel" ? a.hitPixel : a.hitNorm,
      categories: a.scored.map((s) => ({
        category: s.category,
        hit: hitBy === "pixel" ? s.hitPixel : s.hitNorm,
        errPt: hitBy === "pixel" ? s.errPixelPt : s.errNormPt,
      })),
    });
  }
}

const out: string[] = [];
const say = (s = "") => {
  out.push(s);
  console.log(s);
};
const groups = [...new Set(rows.map((r) => r.group))].sort();
const CONVS = ["unspecified", "pixel", "norm1000"];
const SIZES = ["640x400", "1280x800", "1792x1120", "3584x2240"];
const cats: Target["category"][] = ["menu", "toolbar", "icon", "sidebar", "checkbox", "field", "primary"];
const ratio = (rs: Row[]) => {
  const n = rs.reduce((s, r) => s + r.categories.length, 0);
  const k = rs.reduce((s, r) => s + r.hits, 0);
  return n ? `${k}/${n}` : "—";
};

say("## P-2 重打分汇总\n");
say("### 1. 能不能答出来\n");
say("| 组 | 调用 | 严格可解析 | 修复后可解析 | 额度烧光未作答 | 用了 point_2d |");
say("|---|---:|---:|---:|---:|---:|");
for (const g of groups) {
  const rs = rows.filter((r) => r.group === g);
  say(
    `| ${g} | ${rs.length} | ${rs.filter((r) => r.parseMode === "strict" && r.parsed > 0).length} | ` +
      `${rs.filter((r) => r.parseMode === "repaired" && r.parsed > 0).length} | ${rs.filter((r) => r.exhausted).length} | ` +
      `${rs.filter((r) => r.formats.includes("point_2d")).length} |`,
  );
}

say("\n### 2. 模型实际用的坐标系（按斜率推断；只统计解析出坐标的调用）\n");
say("| 组 | 问法 | 推断结果 |");
say("|---|---|---|");
for (const g of groups) {
  for (const conv of CONVS) {
    const rs = rows.filter((r) => r.group === g && r.convention === conv && r.parsed > 0);
    if (rs.length === 0) continue;
    const dist: Record<string, number> = {};
    for (const r of rs) {
      const k = r.frame.replace(/\(.*\)/, "");
      dist[k] = (dist[k] ?? 0) + 1;
    }
    say(`| ${g} | ${conv} | ${Object.entries(dist).map(([k, v]) => `${k}×${v}`).join("，")} |`);
  }
}

say("\n### 3. 命中率（按该次回答实际用的坐标系判；只统计解析出坐标的调用）\n");
say(`| 组 | 问法 | ${SIZES.join(" | ")} | 合计 |`);
say(`|---|---|${SIZES.map(() => "---:").join("|")}|---:|`);
for (const g of groups) {
  for (const conv of CONVS) {
    const base = rows.filter((r) => r.group === g && r.convention === conv && r.parsed > 0);
    if (base.length === 0) continue;
    say(`| ${g} | ${conv} | ${SIZES.map((s) => ratio(base.filter((r) => r.size === s))).join(" | ")} | ${ratio(base)} |`);
  }
}

const catTable = (title: string, pick: (r: Row) => boolean) => {
  say(`\n### ${title}\n`);
  say(`| 组 | ${cats.join(" | ")} |`);
  say(`|---|${cats.map(() => "---:").join("|")}|`);
  for (const g of groups) {
    const rs = rows.filter((r) => r.group === g && r.parsed > 0 && pick(r));
    if (rs.length === 0) continue;
    const cell = (cat: Target["category"]) => {
      const xs = rs.flatMap((r) => r.categories.filter((c) => c.category === cat));
      const errs = xs.map((x) => x.errPt).filter((e): e is number => typeof e === "number").sort((a, b) => a - b);
      const med = errs.length ? errs[Math.floor(errs.length / 2)]!.toFixed(0) : "—";
      return xs.length ? `${xs.filter((x) => x.hit).length}/${xs.length} (${med}pt)` : "—";
    };
    say(`| ${g} | ${cats.map(cell).join(" | ")} |`);
  }
};
catTable("4. 按控件类别：所有问法与尺寸合并（括号内为中位误差）", () => true);
catTable("5. 按控件类别：推荐配置（norm1000，尺寸 ≥1280×800）", (r) => r.convention === "norm1000" && r.size !== "640x400");

const file = join(RAW_DIR, `p2-rescore-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
writeFileSync(file, out.join("\n") + "\n");
console.log(`\n写入：${file}`);
