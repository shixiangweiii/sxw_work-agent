/**
 * P-2 坐标约定与定位命中率（兼答 P-4 的另一半：服务端缩放后，模型给的坐标落在哪个坐标系）。
 *
 * 同一个布局渲染成 4 种尺寸 × 3 种坐标约定的问法：
 *   unspecified：不告诉模型用什么单位；
 *   pixel      ：明说「这张图 W×H 像素，用像素坐标」；
 *   norm1000   ：明说「用 0–1000 归一化坐标」。
 *
 * 【判别力】对每次回答拟合 x_pred = a·x_true_px + b（y 同理）：
 *   - 图片像素坐标      → a ≈ 1
 *   - 0–1000 归一化     → a_x ≈ 1000/W、a_y ≈ 1000/H（两轴斜率之比 = W/H = 1.6）
 *   - 服务端缩图后的像素 → a_x ≈ a_y ≈ r（两轴同一个缩放比）
 * 三种假设在这组尺寸下给出互不相同的预测 —— 刻意避开 1000×1000，
 * 那个尺寸上「像素」与「归一化」给出同一个数，漏掉一次换算不会有任何征兆。
 *
 * 选项：--thinking default|disabled  --max-tokens N  --seeds a,b  --sizes WxH,..  --conventions c,..
 * 第一轮（默认思考、8192 上限）DeepSeek 14/24 次把输出额度全烧在思考上、一个字没答，
 * 所以思考开关是这个探针的一个实验因子，不是固定值。
 */

import { endpoint, endpointsFromArgs, type EndpointConfig } from "../env.js";
import { Evidence, MAX_TOKENS, call, imageBlock, pool, prng, scrub } from "../harness.js";
import { analyze } from "../p2-scoring.js";
import { appScene, render, specOf, type Target } from "../scenes.js";

const CONVENTIONS = ["unspecified", "pixel", "norm1000"] as const;
type Convention = (typeof CONVENTIONS)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const THINKING = (arg("--thinking") ?? "default") as "default" | "disabled";
const MAX = Number(arg("--max-tokens") ?? MAX_TOKENS);
const SEEDS = (arg("--seeds") ?? "2001,2002").split(",").map(Number);
const SIZES: Array<[number, number]> = (arg("--sizes") ?? "640x400,1280x800,1792x1120,3584x2240")
  .split(",")
  .map((s) => s.split("x").map(Number) as [number, number]);
const CONVS = (arg("--conventions") ?? CONVENTIONS.join(",")).split(",") as Convention[];

function conventionText(c: Convention, w: number, h: number): string {
  switch (c) {
    case "unspecified":
      return "坐标格式为 {\"x\": 数字, \"y\": 数字}。";
    case "pixel":
      return `这张截图的尺寸是 ${w}x${h} 像素。坐标用这张截图上的像素坐标，原点在左上角，x 向右、y 向下。`;
    case "norm1000":
      return "坐标用归一化坐标：x 和 y 都在 0 到 1000 之间，(0,0) 是截图左上角，(1000,1000) 是截图右下角。";
  }
}

function prompt(c: Convention, w: number, h: number, targets: Target[]): string {
  return [
    "这是一张电脑屏幕截图。请给出下列每个目标的点击位置（取目标的中心点）。",
    conventionText(c, w, h),
    "目标：",
    ...targets.map((t) => `${t.id}：${t.desc}`),
    '只输出一个 JSON 对象，不要输出任何其他内容。格式：{"points":[{"id":"T1","x":数字,"y":数字}, ...]}。' +
      "找不准的目标也给出你的最佳估计。",
  ].join("\n");
}

async function runEndpoint(ep: EndpointConfig) {
  const ev = new Evidence("p2", ep, { seeds: SEEDS, sizes: SIZES, conventions: CONVS, thinking: THINKING, maxTokens: MAX });
  const scenes = SEEDS.map((s) => appScene(prng(s)));
  const pngs = scenes.map((sc) => render(SIZES.map(([w, h]) => specOf(sc, w, h))));

  const jobs: Array<{ si: number; zi: number; c: Convention }> = [];
  scenes.forEach((_, si) => SIZES.forEach((_, zi) => CONVS.forEach((c) => jobs.push({ si, zi, c }))));

  const rows = await pool(jobs, 3, async ({ si, zi, c }) => {
    const [w, h] = SIZES[zi]!;
    const sc = scenes[si]!;
    const body: Record<string, unknown> = {
      model: ep.model,
      max_tokens: MAX,
      messages: [{ role: "user", content: [{ type: "text", text: prompt(c, w, h, sc.targets) }, imageBlock(pngs[si]![zi]!)] }],
      ...(THINKING === "disabled" ? { thinking: { type: "disabled" } } : {}),
    };
    const r = await call(ep, body);
    const a = analyze(r.text, sc.targets, w, h);
    const row = {
      seed: SEEDS[si],
      size: `${w}x${h}`,
      convention: c,
      thinking: THINKING,
      maxTokens: MAX,
      ok: r.ok,
      status: r.status,
      error: r.error?.message?.slice(0, 120),
      stopReason: r.stopReason,
      outputTokens: r.usage["output_tokens"],
      parsed: a.parsed,
      formats: a.formats,
      hitPixel: a.hitPixel,
      hitNorm: a.hitNorm,
      frame: a.frame,
      fitX: a.fitX,
      fitY: a.fitY,
      thinkingChars: r.thinkingChars,
      latencyMs: r.latencyMs,
    };
    ev.write({ kind: "call", ...row, scored: a.scored, text: r.text, usage: r.usage, request: scrub(body) });
    return row;
  });

  ev.write({ kind: "summary", rows });
  console.log(`\n══ P-2 定位 · ${ep.name} · ${ep.model} · thinking=${THINKING} · max=${MAX} ══  证据：${ev.file}`);
  for (const r of rows) console.log(JSON.stringify(r));
}

const eps = endpointsFromArgs(process.argv).map(endpoint);
await Promise.all(eps.map(runEndpoint));
