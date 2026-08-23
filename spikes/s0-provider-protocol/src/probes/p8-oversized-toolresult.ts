/**
 * P8　超长 Tool Result【可延后】
 *
 * 给 §11.4 的「大结果外置阈值」一个真实下界：
 * 如果 Provider 本身对单个 tool_result 有硬上限，那外置就不只是上下文治理，
 * 而是协议要求 —— §11.4 的规则 6「具体阈值通过 Eval 决定」需要补一条硬约束。
 *
 * 用便宜模型，控制花费。
 *
 * 喂给：§11.4 ToolResult Materialization、§11.6 inlineToolResultLimitTokens
 */

import { probe, openRecorder, requireKey, DRY_RUN } from "../harness.js";
import {
  anthropicClient,
  ANTHROPIC_CHEAP_MODEL,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_API_KEY_NAME,
} from "../clients/anthropic.js";
import {
  openaiClient,
  OPENAI_CHEAP_MODEL,
  OPENAI_PROVIDER_LABEL,
  OPENAI_API_KEY_NAME,
} from "../clients/openai.js";
import { anthropicTools, openaiChatTools, SYSTEM_PROMPT } from "../tools.js";

/**
 * 逐级加码，找到被拒绝的那一档。
 *
 * 只保留 200KB：P7 已实测该端点可接受 120 万字符的用户消息（60 万 token），
 * 1MB 档大概率同样被接受，信息增量小而 token 成本实打实。
 * 若 200KB 被拒，再补测更小档位定位上限。
 */
const SIZES_KB = [200];

const payload = (kb: number) =>
  JSON.stringify({ city: "北京", bulk: "数据".repeat((kb * 1024) / 6) });

/** 推理内容回填。DeepSeek 两个形状都要求 assistant 回合带上它（见 P9），百炼两家都不要求。 */
const REASONING_TEXT = "需要查北京天气，调用 get_weather。";

/**
 * 400 未必是「太大了」。
 *
 * 实测踩过：DeepSeek 因为 assistant 回合缺推理块返回 400，探针把它读成
 * 「单块上限落在 200KB 以下」—— 一个完全错误的 §11.4 硬约束。
 * 因此拒绝原因必须由错误文案判定，判不出来就登记未解答，而不是默认归因于大小。
 */
function looksLikeSizeLimit(err: Record<string, unknown> | undefined): boolean {
  const text = JSON.stringify(err ?? {}).toLowerCase();
  // 配额/限流先排除。踩过：百炼返回 429 "Allocated quota exceeded, please increase your
  // quota limit"，同时命中 exceed 和 limit 两个词，被误判成「单块超过 200KB 上限」。
  // 那是账号配额用尽，与单块大小毫无关系。
  if ((err as any)?.status === 429 || /quota|rate.?limit|too many requests|billing/.test(text)) {
    return false;
  }
  return /too\s*(large|long|many)|exceed|maximum|max.*(length|size)|payload|entity|context.*(length|window)/.test(
    text
  );
}

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({
    probe: "p8",
    provider: ANTHROPIC_PROVIDER_LABEL,
    model: ANTHROPIC_CHEAP_MODEL,
    params: { sizesKB: SIZES_KB },
  });

  for (const kb of SIZES_KB) {
    rec.step(`tool_result 约 ${kb} KB`);
    const content = payload(kb);
    const body = {
      model: ANTHROPIC_CHEAP_MODEL,
      max_tokens: 64,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages: [
        { role: "user", content: "查北京天气" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: REASONING_TEXT, signature: "" },
            { type: "tool_use", id: "toolu_p8_0001", name: "get_weather", input: { city: "北京" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_p8_0001", content }],
        },
      ],
    };
    const r = await rec.call(`${kb}KB`, body, () => client.messages.create(body as any));
    if (!DRY_RUN) {
      if (r.ok) {
        rec.note(`${kb}KB usage`, (r.value as any).usage);
        rec.finding(
          `${kb} KB 的 tool_result 被接受，计 ${(r.value as any).usage?.input_tokens} input tokens`
        );
      } else if (looksLikeSizeLimit(r.error)) {
        rec.finding(
          `${kb} KB 被拒绝（status=${r.error?.status}）—— 单块上限落在 ${kb} KB 以下，` +
            `§11.4 的外置阈值有协议硬约束，不只是上下文治理`
        );
        break;
      } else {
        rec.finding(
          `${kb} KB 被拒绝（status=${r.error?.status}），但错误文案与大小无关 —— ` +
            `不能据此推断单块上限。原因见日志：${String((r.error as any)?.message ?? "").slice(0, 160)}`
        );
        rec.unansweredItem(`${kb} KB 档因无关原因被拒，单块大小上限未测到`);
        break;
      }
    }
  }

  await rec.close();
}

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({
    probe: "p8",
    provider: OPENAI_PROVIDER_LABEL,
    model: OPENAI_CHEAP_MODEL,
    params: { sizesKB: SIZES_KB },
  });

  for (const kb of SIZES_KB) {
    rec.step(`tool 消息约 ${kb} KB`);
    const body = {
      model: OPENAI_CHEAP_MODEL,
      max_completion_tokens: 64,
      tools: openaiChatTools,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "查北京天气" },
        {
          role: "assistant",
          // reasoning_content 是 DeepSeek 在 Chat Completions 上的推理载体，
          // 且同样要求回传（400 `The reasoning_content in the thinking mode must be passed back`）。
          // 百炼两家不要求，多带这个字段也被忽略，因此两平台可以用同一 payload。
          reasoning_content: REASONING_TEXT,
          tool_calls: [
            {
              id: "call_p8_0001",
              type: "function",
              function: { name: "get_weather", arguments: JSON.stringify({ city: "北京" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_p8_0001", content: payload(kb) },
      ],
    };
    const r = await rec.call(`${kb}KB`, body, () => client.chat.completions.create(body as any));
    if (!DRY_RUN) {
      if (r.ok) {
        rec.note(`${kb}KB usage`, (r.value as any).usage);
        rec.finding(`${kb} KB 被接受，计 ${(r.value as any).usage?.prompt_tokens} prompt tokens`);
      } else if (looksLikeSizeLimit(r.error)) {
        rec.finding(`${kb} KB 被拒绝（status=${r.error?.status}）—— 单块上限落在 ${kb} KB 以下`);
        break;
      } else {
        rec.finding(
          `${kb} KB 被拒绝（status=${r.error?.status}），但错误文案与大小无关 —— ` +
            `不能据此推断单块上限。原因见日志：${String((r.error as any)?.message ?? "").slice(0, 160)}`
        );
        rec.unansweredItem(`${kb} KB 档因无关原因被拒，单块大小上限未测到`);
        break;
      }
    }
  }

  await rec.close();
}

await probe("P8", "超长 Tool Result —— 单块大小的协议硬上限", async () => {
  await anthropic();
  await openai();
});
