/**
 * P-6 真实屏幕 × Atlas 真实工具面的定位（2026-10-03，ADR-0014 的证据）。
 *
 * 起因：第一次真桌面 live 运行（run_609acf77238c，qwen3.8-flash）里，模型要点计算器的 AC
 * （约 (239,717)/1000），给出的是 (174,374)/1000 —— 落在空白处，被执行前核对拒掉。
 * 与 P-2b 的三处不同，任何一处都可能是原因，所以这里**照搬 Atlas 实际发出的东西**：
 *   ① 截图是那次运行的真实截图（只含计算器与文本编辑的窗口），不是合成界面；
 *   ② 工具是 Atlas 的 `screenshot` ＋ `computer`（x / y 两个标量，不是 coordinate 数组），
 *      描述与 system prompt 由 compose 导出（/tmp/atlas-gui-tools.json），不在这里重写一份；
 *   ③ 思考：Atlas 不发任何思考参数（= 端点默认），P-2b 的 10/10 是关闭思考测的。
 *
 * 用法：npx tsx src/probes/p6-real-screen.ts bailian [截图路径] [每格次数]
 * 截图不进仓库（它是用户屏幕的一部分）：图只编码进请求（`ephemeralImageBlock`），不归档；
 * jsonl 里图像换成 sha256（`scrub`），证据只记坐标与命中。
 */

import { readFileSync } from "node:fs";
import { endpoint, endpointsFromArgs, type EndpointConfig } from "../env.js";
import { Evidence, call, ephemeralImageBlock, pool, scrub, toRequestBlocks, type CallResult } from "../harness.js";

const W = 1792;
const H = 1120;
const MAX = 16384;
const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--endpoint" && all[i - 1] !== "--layout");
const SHOT = args[0] ?? "/tmp/atlas-shot-latest.png";
const REPEAT = Number(args[1] ?? 1);
const atlas = JSON.parse(readFileSync("/tmp/atlas-gui-tools.json", "utf8")) as {
  tools: Array<{ name: string; description: string; input_schema: unknown }>;
  system: string;
};

/**
 * 计算器按钮中心（截图像素，人工从那张截图上量的）。两种布局：
 *   crop  —— 第一次运行那张：旧过滤器只截白名单窗口的外接矩形、放大 1.26 倍（计算器大）；
 *   full  —— 修复后的整屏截图（计算器是原尺寸，周围是大片黑色与桌面图标）。
 * 用 `--layout full` 切换。半径取按钮直径的一半多一点。
 */
const LAYOUT = process.argv.includes("--layout") ? process.argv[process.argv.indexOf("--layout") + 1] : "crop";
const COLS = LAYOUT === "full" ? [480, 534, 588, 642] : [361, 429, 497, 565];
const ROWS = LAYOUT === "full" ? [716, 770, 824, 878, 932] : [803, 871, 939, 1007, 1075];
const GRID = [
  ["⌫", "AC", "%", "÷"],
  ["7", "8", "9", "×"],
  ["4", "5", "6", "−"],
  ["1", "2", "3", "+"],
  ["±", "0", ".", "="],
];
const TARGETS = ["AC", "3", "7", "×", "2", "4", "="];
const R = LAYOUT === "full" ? 26 : 32;

function buttonAt(px: number, py: number): string {
  for (let r = 0; r < ROWS.length; r++) {
    for (let c = 0; c < COLS.length; c++) {
      if (Math.hypot(px - COLS[c]!, py - ROWS[r]!) <= R) return GRID[r]![c]!;
    }
  }
  return "（空白）";
}

const TASK = "请通过操作屏幕完成：用计算器（Calculator）点击按钮计算 37 × 24。";

async function group(ep: EndpointConfig, ev: Evidence, thinking: "default" | "disabled", png: Buffer) {
  const extra = thinking === "disabled" ? { thinking: { type: "disabled" } } : {};
  const tools = atlas.tools;
  let first: CallResult | undefined;
  for (let attempt = 0; attempt < 3 && !first; attempt++) {
    const body = {
      model: ep.model, max_tokens: MAX, system: atlas.system,
      messages: [{ role: "user", content: `${TASK}\n先截一张图。` }],
      tools, ...extra,
    };
    const r = await call(ep, body);
    ev.write({ kind: "call", step: "call-1", thinking, attempt, ok: r.ok, error: r.error, toolUses: r.toolUses, usage: r.usage });
    if (r.ok && r.toolUses.some((t) => t.name === "screenshot")) first = r;
  }
  if (!first) return [{ thinking, error: "call-1 没有拿到 screenshot 调用" }];
  const tu = first.toolUses.find((t) => t.name === "screenshot")!;
  const jobs = TARGETS.flatMap((t) => Array.from({ length: REPEAT }, () => t));
  return pool(jobs, 3, async (target) => {
    const body = {
      model: ep.model, max_tokens: MAX, system: atlas.system,
      messages: [
        { role: "user", content: `${TASK}\n先截一张图。` },
        { role: "assistant", content: toRequestBlocks(first!.blocks) },
        {
          role: "user",
          content: [
            {
              type: "tool_result", tool_use_id: tu.id,
              content: [
                { type: "text", text: JSON.stringify({ status: "OK", screenshot: { width: W, height: H }, frontmostApp: "计算器", visibleApps: ["计算器", "文本编辑"] }) },
                ephemeralImageBlock(png),
              ],
            },
            { type: "text", text: `下一步：请点击计算器上的「${target}」按钮。只调用一次 computer 工具。` },
          ],
        },
      ],
      tools, ...extra,
    };
    const r = await call(ep, body);
    const click = r.toolUses.find((u) => u.name === "computer");
    const input = (click?.input ?? {}) as { action?: unknown; x?: unknown; y?: unknown };
    const ok = typeof input.x === "number" && typeof input.y === "number";
    const px = ok ? ((input.x as number) * W) / 1000 : NaN;
    const py = ok ? ((input.y as number) * H) / 1000 : NaN;
    const landed = ok ? buttonAt(px, py) : "（无坐标）";
    const row = {
      thinking, target, action: input.action, x: input.x, y: input.y, landed, hit: landed === target,
      outputTokens: r.usage["output_tokens"], thinkingChars: r.thinkingChars, latencyMs: r.latencyMs, error: r.error?.message?.slice(0, 100),
    };
    ev.write({ kind: "call", step: "click", ...row, text: r.text, request: scrub({ ...body, messages: "(omitted)" }) });
    return row;
  });
}

async function runEndpoint(ep: EndpointConfig) {
  const png = readFileSync(SHOT);
  const ev = new Evidence("p6", ep, { shotBytes: png.length, size: `${W}x${H}`, layout: LAYOUT, targets: TARGETS, repeat: REPEAT });
  const rows: any[] = [];
  for (const thinking of ["default", "disabled"] as const) rows.push(...(await group(ep, ev, thinking, png)));
  ev.write({ kind: "summary", rows });
  console.log(`\n══ P-6 真实屏幕定位 · ${ep.name} · ${ep.model} ══  证据：${ev.file}`);
  for (const thinking of ["default", "disabled"]) {
    const rs = rows.filter((r) => r.thinking === thinking && "hit" in r);
    console.log(JSON.stringify({
      thinking, n: rs.length, hits: rs.filter((r) => r.hit).length,
      outputTokensMedian: rs.map((r) => r.outputTokens).sort((a, b) => a - b)[Math.floor(rs.length / 2)],
      detail: rs.map((r) => `${r.target}→${r.landed}(${r.x},${r.y})`),
    }));
  }
}

await Promise.all(endpointsFromArgs(process.argv).map(endpoint).map(runEndpoint));
