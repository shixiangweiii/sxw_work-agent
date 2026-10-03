/**
 * P-0 补充：两个端点是否接受关闭思考 / 降低推理力度的参数（P-2 里默认思考把 8192 输出额度烧光）。
 * 每个组合一次极小的请求；看返回里有没有 thinking 块、思考多长。
 */
import { endpoint, endpointsFromArgs, type EndpointConfig } from "../env.js";
import { Evidence, call, scrub } from "../harness.js";

const VARIANTS: Array<[string, Record<string, unknown>]> = [
  ["default", {}],
  ["thinking-disabled", { thinking: { type: "disabled" } }],
  ["effort-low", { output_config: { effort: "low" } }],
];
const TASK = "一个盒子里有 3 个红球和 5 个蓝球，随机取 2 个，两个都是红球的概率是多少？给出最简分数。";

async function run(ep: EndpointConfig) {
  const ev = new Evidence("p0-thinking", ep, { variants: VARIANTS.map((v) => v[0]) });
  for (const [name, extra] of VARIANTS) {
    const body = { model: ep.model, max_tokens: 4096, messages: [{ role: "user", content: TASK }], ...extra };
    const r = await call(ep, body);
    ev.write({ kind: "call", variant: name, request: scrub(body), ok: r.ok, status: r.status, error: r.error, text: r.text, thinkingChars: r.thinkingChars, usage: r.usage });
    console.log(ep.name, name, JSON.stringify({ ok: r.ok, status: r.status, err: r.error?.message?.slice(0, 120), thinkingChars: r.thinkingChars, out: r.usage["output_tokens"], text: r.text.slice(0, 40) }));
  }
}
await Promise.all(endpointsFromArgs(process.argv).map(endpoint).map(run));
