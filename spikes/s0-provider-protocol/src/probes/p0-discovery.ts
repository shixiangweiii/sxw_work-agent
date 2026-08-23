/**
 * P0　能力发现（不在 §28.1 的七问之内，是前置体检）
 *
 * 目的：在花时间写负向探针之前，先确认
 *   - 配置的模型 ID 是否真实存在；
 *   - 计数 token 的端点是否存在；
 *   - 扩展思考 + 工具的组合是否可用（P2 的前提）；
 *   - Responses API 是否可用（推理块的载体）。
 *
 * 实施计划的风险对策：「候选参数名/端点已变更或不存在 → 探针先做 capability
 * discovery，所有参数名当待确认项探测而非假设」。
 */

import { probe, openRecorder, requireKey, DRY_RUN } from "../harness.js";
import {
  anthropicClient,
  ANTHROPIC_MODEL,
  ANTHROPIC_THINKING_MODEL,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_API_KEY_NAME,
} from "../clients/anthropic.js";
import {
  openaiClient,
  OPENAI_MODEL,
  OPENAI_PROVIDER_LABEL,
  OPENAI_API_KEY_NAME,
  OPENAI_BASE_URL,
} from "../clients/openai.js";
import { anthropicTools, openaiChatTools, SYSTEM_PROMPT } from "../tools.js";

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({ probe: "p0", provider: ANTHROPIC_PROVIDER_LABEL, model: ANTHROPIC_MODEL });

  rec.step("配置的模型是否存在");
  const ping = { model: ANTHROPIC_MODEL, max_tokens: 16, messages: [{ role: "user", content: "ping" }] };
  const r1 = await rec.call("最小请求", ping, () => client.messages.create(ping as any));
  if (r1.ok) rec.finding(`模型 ${ANTHROPIC_MODEL} 可用`);
  else if (!DRY_RUN) rec.unansweredItem(`模型 ${ANTHROPIC_MODEL} 不可用，请改 ANTHROPIC_MODEL 后重跑`);

  rec.step("是否存在 token 计数端点（P4 的前提）");
  const countBody = {
    model: ANTHROPIC_MODEL,
    system: SYSTEM_PROMPT,
    tools: anthropicTools,
    messages: [{ role: "user", content: "ping" }],
  };
  const r2 = await rec.call("count_tokens", countBody, () =>
    (client as any).messages.countTokens(countBody)
  );
  if (r2.ok) rec.finding(`count_tokens 可用，返回 ${JSON.stringify(r2.value)}`);
  else if (!DRY_RUN) rec.unansweredItem("count_tokens 不可用 —— P4 需改用本地 tokenizer 估算");

  rec.step("扩展思考 + 工具 是否可组合（P2 的前提）");
  // thinking 的参数形状当作待确认项探测，不假设它一定叫这个名字
  const thinkBody = {
    model: ANTHROPIC_THINKING_MODEL,
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 2048 },
    tools: anthropicTools,
    messages: [{ role: "user", content: "北京现在天气如何？调用工具查。" }],
  };
  const r3 = await rec.call("thinking + tools", thinkBody, () =>
    client.messages.create(thinkBody as any)
  );
  if (r3.ok) {
    const kinds = ((r3.value as any).content ?? []).map((b: any) => b.type);
    rec.note("响应内容块类型", kinds);
    rec.finding(`扩展思考 + 工具可组合，块类型: ${kinds.join(", ")}`);
  } else if (!DRY_RUN) {
    rec.unansweredItem("扩展思考 + 工具不可组合或参数名已变 —— P2 的 Anthropic 侧需调整");
  }

  await rec.close();
}

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({
    probe: "p0",
    provider: OPENAI_PROVIDER_LABEL,
    model: OPENAI_MODEL,
    params: { baseURL: OPENAI_BASE_URL ?? "(官方默认)" },
  });
  rec.note("端点", OPENAI_BASE_URL ?? "https://api.openai.com/v1");

  rec.step("账号实际可用的模型（不猜 ID，直接列）");
  const r0 = await rec.call("models.list", {}, () => client.models.list());
  if (r0.ok) {
    const ids = ((r0.value as any).data ?? []).map((m: any) => m.id).sort();
    rec.note("可用模型数", ids.length);
    rec.note("模型 ID 全量", ids);
    rec.finding(`账号可用模型 ${ids.length} 个，全量已入日志`);
    if (!ids.includes(OPENAI_MODEL)) {
      rec.unansweredItem(`配置的 OPENAI_MODEL=${OPENAI_MODEL} 不在列表中，请从日志里挑一个改进 .env`);
    }
  }

  rec.step("Chat Completions 是否可用");
  const chatBody = {
    model: OPENAI_MODEL,
    messages: [{ role: "user", content: "ping" }],
    tools: openaiChatTools,
  };
  const r1 = await rec.call("chat.completions", chatBody, () =>
    client.chat.completions.create(chatBody as any)
  );
  if (r1.ok) rec.finding("Chat Completions + tools 可用");

  rec.step("Responses API 是否可用（推理块的载体）");
  const respBody = { model: OPENAI_MODEL, input: "ping" };
  const r2 = await rec.call("responses.create", respBody, () =>
    (client as any).responses.create(respBody)
  );
  if (r2.ok) rec.finding(`[${OPENAI_PROVIDER_LABEL}] Responses API 可用 —— P2 走这条`);
  else if (!DRY_RUN)
    rec.unansweredItem(
      `[${OPENAI_PROVIDER_LABEL}] Responses API 不可用 —— P2 只能在 Chat Completions 上观测`
    );

  await rec.close();
}

await probe("P0", "能力发现：模型 / 计数端点 / 思考+工具 / Responses API", async () => {
  await anthropic();
  await openai();
});
