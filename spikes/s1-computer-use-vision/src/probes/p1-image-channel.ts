/**
 * P-1 图像通道：截图交回给模型的几种放法，各端点是收下、报错，还是静默丢掉？
 *
 * 【判别力】
 *   - 验证码只存在于图里，任何文本通道都没有 → 模型复述得出 = 真的收到了图；
 *   - V3 是对照组（工具结果里不带图）：它给出「看不到」时的基线行为与 token 基线；
 *   - 计费输入 token 的差值是第二个独立信号：图被静默丢掉 → 差值≈0；
 *     图被当成 base64 文本塞进上下文 → 差值暴涨到上万。
 *   - 200 放行不等于收到。百炼对协议不变量零兜底（Spike 0 实测），静默丢弃是要防的那一种。
 *
 * 历史消息用一次**真实**的 call-1 产出（模型自己调用 screenshot 工具），推理块原样回传 ——
 * DeepSeek 的声明是 VERBATIM_REQUIRED，伪造一条不带推理块的 assistant 轮会混进别的失败原因。
 */

import { endpoint, endpointsFromArgs, type EndpointConfig } from "../env.js";
import {
  Evidence,
  MAX_TOKENS,
  billedInput,
  call,
  imageBlock,
  normCode,
  pool,
  prng,
  randomCode,
  scrub,
  toRequestBlocks,
  type CallResult,
} from "../harness.js";
import { codeScene, render, specOf } from "../scenes.js";

const SEED = 1001;
const TRIALS = 2;
const W = 1280;
const H = 800;

const SCREENSHOT_TOOL = {
  name: "screenshot",
  description: "截取当前屏幕并返回截图。没有参数。",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

const SYSTEM =
  "你在测试一个截图工具。先调用一次 screenshot 工具，然后只回复屏幕上显示的验证码（格式 XXXX-XXXX），" +
  "不要输出其他内容。如果你看不到截图或看不清验证码，就只回复 UNSEEN，不要猜。";
const TASK = "读出我屏幕上的验证码。";

const VARIANTS = [
  "V0-user-image",
  "V1-tool_result[text,image]",
  "V2-tool_result[text]+trailing-image",
  "V3-tool_result[text]-control",
  "V4-tool_result[image]",
  // 不带图：验证码只出现在**紧跟工具结果的文字块**里。它回答的是另一个问题 ——
  // Atlas 的插话与 SYSTEM_NOTICE 会和工具结果合并进同一条 user 消息、排在其后
  // （adapter 的 toAnthropicMessages 按角色合并），V2 已证明百炼会静默丢掉其后的图片块。
  "V5-tool_result[text]+trailing-text",
] as const;
type Variant = (typeof VARIANTS)[number];

function summarizeResult(r: CallResult) {
  return {
    ok: r.ok,
    status: r.status,
    error: r.error,
    text: r.text,
    thinkingChars: r.thinkingChars,
    toolUses: r.toolUses,
    usage: r.usage,
    stopReason: r.stopReason,
    latencyMs: r.latencyMs,
  };
}

async function firstCall(ep: EndpointConfig, ev: Evidence): Promise<CallResult | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const body: Record<string, unknown> = {
      model: ep.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: TASK }],
      tools: [SCREENSHOT_TOOL],
      ...(attempt > 0 ? { tool_choice: { type: "any" } } : {}),
    };
    const r = await call(ep, body);
    ev.write({ kind: "call", step: "call-1", attempt, request: scrub(body), result: summarizeResult(r) });
    if (r.ok && r.toolUses.length > 0) return r;
  }
  return undefined;
}

async function runEndpoint(ep: EndpointConfig) {
  const ev = new Evidence("p1", ep, { seed: SEED, trials: TRIALS, size: `${W}x${H}`, variants: VARIANTS });
  const first = await firstCall(ep, ev);
  if (!first) console.log(`[${ep.name}] call-1 没有拿到 tool_use，工具回合的变体全部跳过`);

  const jobs: Array<{ trial: number; v: Variant; vi: number }> = [];
  for (let trial = 0; trial < TRIALS; trial++) VARIANTS.forEach((v, vi) => jobs.push({ trial, v, vi }));

  const rows = await pool(jobs, 3, async ({ trial, v, vi }) => {
    if (v !== "V0-user-image" && !first) return { v, trial, skipped: true };
    const rand = prng(SEED + trial * 100 + vi);
    const code = randomCode(rand, [4, 4]);
    const [png] = render([specOf(codeScene(rand, code), W, H)]);
    const img = imageBlock(png!);

    let body: Record<string, unknown>;
    if (v === "V0-user-image") {
      body = {
        model: ep.model,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "读出这张截图里的验证码（格式 XXXX-XXXX），只回复验证码本身；看不到就只回复 UNSEEN，不要猜。" },
              img,
            ],
          },
        ],
      };
    } else {
      const tu = first!.toolUses[0]!;
      let userContent: unknown[];
      switch (v) {
        case "V1-tool_result[text,image]":
          userContent = [
            { type: "tool_result", tool_use_id: tu.id, content: [{ type: "text", text: `截图完成（${W}x${H}）。` }, img] },
          ];
          break;
        case "V2-tool_result[text]+trailing-image":
          userContent = [
            { type: "tool_result", tool_use_id: tu.id, content: `截图完成（${W}x${H}），图像紧跟在本工具结果之后。` },
            img,
          ];
          break;
        case "V3-tool_result[text]-control":
          userContent = [{ type: "tool_result", tool_use_id: tu.id, content: `截图完成（${W}x${H}）。` }];
          break;
        case "V4-tool_result[image]":
          userContent = [{ type: "tool_result", tool_use_id: tu.id, content: [img] }];
          break;
        case "V5-tool_result[text]+trailing-text":
          userContent = [
            { type: "tool_result", tool_use_id: tu.id, content: "截图完成。截图内容的文字转写紧跟在本工具结果之后。" },
            { type: "text", text: `（截图的文字转写）屏幕上显示的验证码是 ${code}。` },
          ];
          break;
      }
      body = {
        model: ep.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        messages: [
          { role: "user", content: TASK },
          { role: "assistant", content: toRequestBlocks(first!.blocks) },
          { role: "user", content: userContent },
        ],
        tools: [SCREENSHOT_TOOL],
      };
    }

    const r = await call(ep, body);
    const found = r.text.toUpperCase().match(/[A-Z0-9]{4}-[A-Z0-9]{4}/g) ?? [];
    const correct = found.some((f) => normCode(f) === normCode(code));
    const unseen = /UNSEEN/i.test(r.text);
    ev.write({
      kind: "call",
      step: v,
      trial,
      code,
      correct,
      unseen,
      foundCodes: found,
      request: scrub(body),
      result: summarizeResult(r),
    });
    return {
      v,
      trial,
      ok: r.ok,
      status: r.status,
      error: r.error?.message?.slice(0, 160),
      correct,
      unseen,
      billed: billedInput(r.usage),
      text: r.text.replace(/\s+/g, " ").slice(0, 60),
      thinkingChars: r.thinkingChars,
      latencyMs: r.latencyMs,
    };
  });

  ev.write({ kind: "summary", rows });
  console.log(`\n══ P-1 图像通道 · ${ep.name} · ${ep.model} ══  证据：${ev.file}`);
  for (const r of rows) console.log(JSON.stringify(r));
}

const eps = endpointsFromArgs(process.argv).map(endpoint);
await Promise.all(eps.map(runEndpoint));
