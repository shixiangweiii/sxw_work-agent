/**
 * P-5 小字可读性：本机屏幕（逻辑 1792×1120 pt，2 倍 Retina）上的界面文字，
 * 缩到端点尺寸之后还认不认得出？要不要「放大」（原分辨率裁片）？
 *
 * 不截用户的真实屏幕：那会把屏幕上的一切发往第三方端点，还会在本机触发录屏授权弹窗。
 * 改用同尺寸、同字体（AppKit 系统字体）的合成屏 —— 要回答的问题（缩放后小字是否可读）不变。
 *
 * 【判别力】编码是随机串（去掉了易混字形），语言先验帮不上忙；
 * 计分区分三种结局：读对 / 答 null（承认看不清）/ **读错**（自信地说错 —— 对 agent 最危险）。
 */

import { endpoint, endpointsFromArgs, type EndpointConfig } from "../env.js";
import { Evidence, MAX_TOKENS, call, imageBlock, normCode, pool, prng, scrub } from "../harness.js";
import { extractAnyJson } from "../p2-scoring.js";
import { FULL, LEGIBILITY_SIZES, QUADRANTS, inside, legibilityScene, render, type Viewport } from "../scenes.js";

const SEEDS = [5001, 5002];
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const THINKING = (arg("--thinking") ?? "disabled") as "default" | "disabled";

const CONDITIONS: Array<{ name: string; w: number; h: number; viewport: Viewport; seeds: number[] }> = [
  { name: "full-3584", w: 3584, h: 2240, viewport: FULL, seeds: SEEDS },
  { name: "pt-1792", w: 1792, h: 1120, viewport: FULL, seeds: SEEDS },
  { name: "fit-1280", w: 1280, h: 800, viewport: FULL, seeds: SEEDS },
  ...QUADRANTS.map((q, i) => ({ name: `zoom-q${i}`, w: 1792, h: 1120, viewport: q, seeds: [SEEDS[0]!] })),
];

const PROMPT =
  "图里有若干带字母标签的方框（字母在框的左上方），每个框里有一个形如 XXX-XXX 的编码（大写字母或数字）。" +
  "请逐个转写你在图中能看到的框里的编码；看不清的写 null，不要猜。" +
  '只输出 JSON，键是字母标签，例如 {"A": "XXX-XXX", "B": null}。只包含图中出现的字母标签。';

async function runEndpoint(ep: EndpointConfig) {
  const ev = new Evidence("p5", ep, { seeds: SEEDS, thinking: THINKING, conditions: CONDITIONS.map((c) => c.name) });
  const scenes = new Map(SEEDS.map((s) => [s, legibilityScene(prng(s))]));
  const jobs = CONDITIONS.flatMap((c) => c.seeds.map((seed) => ({ c, seed })));

  const rows = await pool(jobs, 3, async ({ c, seed }) => {
    const sc = scenes.get(seed)!;
    const [png] = render([{ width: c.w, height: c.h, viewport: c.viewport, background: "#D9DEE5", elements: sc.elements }]);
    const body: Record<string, unknown> = {
      model: ep.model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, imageBlock(png!)] }],
      ...(THINKING === "disabled" ? { thinking: { type: "disabled" } } : {}),
    };
    const r = await call(ep, body);
    const { value, mode } = extractAnyJson(r.text);
    const answer = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const visible = sc.boxes.filter((b) => inside({ x: b.box.x, y: b.box.y - 24, w: b.box.w, h: b.box.h + 24 }, c.viewport));
    const graded = visible.map((b) => {
      const v = answer[b.label];
      const outcome =
        typeof v === "string" && normCode(v) === normCode(b.code) ? "correct" : v === null || v === undefined ? "unread" : "wrong";
      return { label: b.label, size: b.size, truth: b.code, answer: v ?? null, outcome };
    });
    ev.write({ kind: "call", condition: c.name, seed, parseMode: mode, graded, text: r.text, usage: r.usage, ok: r.ok, error: r.error, request: scrub(body) });
    return { condition: c.name, seed, ok: r.ok, parseMode: mode, graded, imageTokensHint: r.usage["input_tokens"] };
  });

  ev.write({ kind: "summary", rows });
  console.log(`\n══ P-5 小字可读性 · ${ep.name} · ${ep.model} · thinking=${THINKING} ══  证据：${ev.file}`);
  const condNames = ["full-3584", "pt-1792", "fit-1280", "zoom"];
  console.log(["字号", ...condNames].join("\t"));
  for (const size of LEGIBILITY_SIZES) {
    const cells = condNames.map((cn) => {
      const gs = rows
        .filter((r) => (cn === "zoom" ? r.condition.startsWith("zoom") : r.condition === cn))
        .flatMap((r) => r.graded.filter((g) => g.size === size));
      const ok = gs.filter((g) => g.outcome === "correct").length;
      const wrong = gs.filter((g) => g.outcome === "wrong").length;
      return `${ok}/${gs.length}${wrong ? `(错${wrong})` : ""}`;
    });
    console.log([`${size}pt`, ...cells].join("\t"));
  }
}

const eps = endpointsFromArgs(process.argv).map(endpoint);
await Promise.all(eps.map(runEndpoint));
