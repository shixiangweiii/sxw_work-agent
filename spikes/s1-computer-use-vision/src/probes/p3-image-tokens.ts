/**
 * P-3 图像计费（兼答 P-4 的一半：服务端会不会二次缩放）。
 *
 * 同一张界面图渲染成一组尺寸，各发一次「文字＋图」，与「同样文字、无图」的基线相减，
 * 得到每张图的计费 token。曲线若在某个尺寸后变平 → 服务端把大图缩到了固定预算，
 * 那就意味着客户端看不到模型实际看到的图有多大 —— 坐标反算的前提要靠 P-2 另行确认。
 *
 * 顺带：count_tokens 端点算不算图片？Atlas 的 Context 编译靠它做预算判定，
 * 如果它对图片计 0，帧级预算会系统性低估。
 */

import { endpoint, endpointsFromArgs, type EndpointConfig } from "../env.js";
import { Evidence, MAX_TOKENS, billedInput, call, client, imageBlock, pool, prng, scrub } from "../harness.js";
import { FULL, appScene, render, specOf, type Viewport } from "../scenes.js";

const SEED = 3001;
const PROMPT = "这张图里有没有一个应用窗口？只回答“有”或“没有”。";

const SIZES: Array<{ w: number; h: number; viewport: Viewport }> = [
  { w: 256, h: 160, viewport: FULL },
  { w: 512, h: 320, viewport: FULL },
  { w: 768, h: 480, viewport: FULL },
  { w: 1024, h: 640, viewport: FULL },
  { w: 1280, h: 800, viewport: FULL },
  { w: 1536, h: 960, viewport: FULL },
  { w: 1792, h: 1120, viewport: FULL },
  { w: 2560, h: 1600, viewport: FULL },
  { w: 3584, h: 2240, viewport: FULL },
  { w: 1000, h: 1000, viewport: { x: 336, y: 0, w: 1120, h: 1120 } },
];

async function countTokens(ep: EndpointConfig, messages: unknown[]) {
  try {
    const r = await client(ep).messages.countTokens({ model: ep.model, messages } as never);
    return { ok: true, input_tokens: (r as { input_tokens: number }).input_tokens };
  } catch (e: any) {
    return { ok: false, status: e?.status, message: String(e?.message ?? e).slice(0, 200) };
  }
}

async function runEndpoint(ep: EndpointConfig) {
  const ev = new Evidence("p3", ep, { seed: SEED, sizes: SIZES.map((s) => `${s.w}x${s.h}`), prompt: PROMPT });
  const scene = appScene(prng(SEED));
  const pngs = render(SIZES.map((s) => specOf(scene, s.w, s.h, s.viewport)));

  const baseMessages = [{ role: "user", content: [{ type: "text", text: PROMPT }] }];
  const baseBodies = [0, 1].map(() => ({ model: ep.model, max_tokens: MAX_TOKENS, messages: baseMessages }));
  const base = await pool(baseBodies, 2, (b) => call(ep, b));
  base.forEach((r, i) => ev.write({ kind: "call", step: "baseline", i, request: scrub(baseBodies[i]), usage: r.usage, ok: r.ok, error: r.error }));
  const baseline = Math.min(...base.filter((r) => r.ok).map((r) => billedInput(r.usage)));

  const rows = await pool(SIZES, 3, async (s, i) => {
    const messages = [{ role: "user", content: [{ type: "text", text: PROMPT }, imageBlock(pngs[i]!)] }];
    const body = { model: ep.model, max_tokens: MAX_TOKENS, messages };
    const r = await call(ep, body);
    const billed = billedInput(r.usage);
    ev.write({ kind: "call", step: `${s.w}x${s.h}`, request: scrub(body), usage: r.usage, ok: r.ok, error: r.error, text: r.text });
    return {
      size: `${s.w}x${s.h}`,
      megapixels: +((s.w * s.h) / 1e6).toFixed(3),
      ok: r.ok,
      status: r.status,
      error: r.error?.message?.slice(0, 120),
      billed,
      imageTokens: r.ok ? billed - baseline : undefined,
    };
  });

  // count_tokens：无图与 1280x800 各一次
  const i1280 = SIZES.findIndex((s) => s.w === 1280);
  const ctBase = await countTokens(ep, baseMessages);
  const ctImg = await countTokens(ep, [{ role: "user", content: [{ type: "text", text: PROMPT }, imageBlock(pngs[i1280]!)] }]);
  ev.write({ kind: "count_tokens", base: ctBase, image1280: ctImg });

  ev.write({ kind: "summary", baseline, rows });
  console.log(`\n══ P-3 图像计费 · ${ep.name} · ${ep.model} ══  基线 ${baseline}  证据：${ev.file}`);
  for (const r of rows) console.log(JSON.stringify(r));
  console.log("count_tokens", JSON.stringify({ base: ctBase, image1280: ctImg }));
}

const eps = endpointsFromArgs(process.argv).map(endpoint);
await Promise.all(eps.map(runEndpoint));
