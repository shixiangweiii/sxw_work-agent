/**
 * P1　并行 Tool Call【必答】
 *
 * 这是整个 Spike 里最重要的探针。它决定 V03 §8.6 的两条不变量是真不变量
 * 还是过度设计：
 *   不变量 1：一次 ModelInvocation 产出的全部 Tool Call 构成一个 ActionBatch
 *   不变量 2：批内每个 Tool Call 在返回模型前必须拥有恰好一个协议合法的 result
 *
 * 价值全在负向实验。只做正向调用只能证明「正常用法能跑通」，
 * 而我们需要知道的是「违反假设时 Provider 会不会拒绝」。
 *
 * 喂给：D-01、§8.6 不变量 1/2/6、§11.5 protocolGroup 排序约束、§12.5 toolCallId 锚点
 */

import { probe, openRecorder, requireKey, DRY_RUN, type Recorder } from "../harness.js";
import {
  anthropicClient,
  ANTHROPIC_MODEL,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_API_KEY_NAME,
} from "../clients/anthropic.js";
import {
  openaiClient,
  OPENAI_MODEL,
  OPENAI_PROVIDER_LABEL,
  OPENAI_API_KEY_NAME,
} from "../clients/openai.js";
import {
  anthropicTools,
  openaiChatTools,
  fakeToolResult,
  PARALLEL_PROMPT,
  SYSTEM_PROMPT,
} from "../tools.js";

const REJECTION_PAYLOAD = JSON.stringify({
  code: "POLICY_DENIED",
  message: "该操作被本地策略拒绝，未执行，无副作用。",
  sideEffectState: "NOT_STARTED",
  retryAllowed: false,
});

// ==================================================================== Anthropic

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({ probe: "p1", provider: ANTHROPIC_PROVIDER_LABEL, model: ANTHROPIC_MODEL });

  const userMsg = { role: "user", content: PARALLEL_PROMPT };
  const base = {
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: anthropicTools,
  };

  // ---------------------------------------------------------------- 正向
  rec.step("正向：一句话触发多次工具调用");
  const b1 = { ...base, messages: [userMsg] };
  const r1 = await rec.call("触发并行", b1, () => client.messages.create(b1 as any));

  let toolUses: any[] = [];
  let assistantContent: any[] = [];
  if (r1.ok) {
    assistantContent = (r1.value as any).content ?? [];
    toolUses = assistantContent.filter((b: any) => b.type === "tool_use");
    rec.note("stop_reason", (r1.value as any).stop_reason);
    rec.note("内容块类型序列", assistantContent.map((b: any) => b.type));
    rec.note("tool_use 数量", toolUses.length);
    rec.note("tool_use id 形态", toolUses.map((t: any) => t.id));
    rec.note("tool_use 名称与入参", toolUses.map((t: any) => ({ name: t.name, input: t.input })));
    rec.finding(
      `一次响应返回 ${toolUses.length} 个 tool_use，全部位于同一个 assistant message 内` +
        `（stop_reason=${(r1.value as any).stop_reason}）`
    );
    if (toolUses.length <= 1) {
      rec.unansweredItem(
        "本次未触发到多个 tool_use —— 换 prompt 或重跑几次；若稳定为 1，则 §8.6 的批模型需要重新论证"
      );
    }
  }

  // ---------------------------------------------------------- 参数探测：强制单条
  rec.step("参数探测：是否存在强制单条调用的开关（候选名，不假设其存在）");
  const b2 = {
    ...base,
    messages: [userMsg],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  };
  const r2 = await rec.call("tool_choice.disable_parallel_tool_use", b2, () =>
    client.messages.create(b2 as any)
  );
  if (r2.ok) {
    const n = ((r2.value as any).content ?? []).filter((b: any) => b.type === "tool_use").length;
    rec.finding(`disable_parallel_tool_use 被接受，本次返回 ${n} 个 tool_use`);
    if (n > 1) rec.unansweredItem("参数被接受但仍返回多个 —— 该开关不是硬保证，D-01 不能依赖它");
  } else if (!DRY_RUN) {
    rec.finding("disable_parallel_tool_use 不被接受（参数名不存在或已变更）—— 见日志错误体");
  }

  if (!r1.ok || toolUses.length === 0) {
    if (!DRY_RUN) rec.unansweredItem("无 tool_use，负向实验全部跳过");
    await rec.close();
    return;
  }

  const assistantMsg = { role: "assistant", content: assistantContent };
  const resultBlock = (t: any, extra: Record<string, unknown> = {}) => ({
    type: "tool_result",
    tool_use_id: t.id,
    content: fakeToolResult(t.name, t.input),
    ...extra,
  });

  // ------------------------------------------------------------ 基线（对照组）
  rec.step("基线对照：全部 tool_result 按原序正确回传 —— 应成功");
  const bBase = {
    ...base,
    messages: [userMsg, assistantMsg, { role: "user", content: toolUses.map((t) => resultBlock(t)) }],
  };
  const rBase = await rec.call("全部回传", bBase, () => client.messages.create(bBase as any));
  if (rBase.ok) rec.finding("基线成功 —— 后续负向实验的失败可归因于被改动的那一项");
  else if (!DRY_RUN)
    rec.unansweredItem("基线就失败了，负向实验不可归因 —— 先修基线");

  // ------------------------------------------------------------ 负向 A（最关键）
  rec.step("负向 A：只回传一部分 tool_result（验证 §8.6 不变量 2）");
  const bA = {
    ...base,
    messages: [userMsg, assistantMsg, { role: "user", content: [resultBlock(toolUses[0])] }],
  };
  const rA = await rec.call("只回第 1 个", bA, () => client.messages.create(bA as any));
  if (!DRY_RUN) {
    if (rA.ok)
      rec.finding(
        `【证伪风险】缺 ${toolUses.length - 1} 个 tool_result 仍被接受 —— §8.6 不变量 2 需要重新论证`
      );
    else
      rec.finding(
        `缺 tool_result 被拒绝（status=${rA.error?.status}）—— §8.6 不变量 2 得到证实。` +
          `错误是否指明缺哪一个，见日志`
      );
  }

  // ------------------------------------------------------------ 负向 B：顺序
  if (toolUses.length > 1) {
    rec.step("负向 B：tool_result 顺序打乱");
    const bB = {
      ...base,
      messages: [
        userMsg,
        assistantMsg,
        { role: "user", content: [...toolUses].reverse().map((t) => resultBlock(t)) },
      ],
    };
    const rB = await rec.call("逆序回传", bB, () => client.messages.create(bB as any));
    if (!DRY_RUN)
      rec.finding(
        rB.ok
          ? "逆序被接受 —— §11.5 的 protocolGroup 无需保证组间顺序，只需保证成组"
          : `逆序被拒绝（status=${rB.error?.status}）—— 顺序也是协议约束的一部分`
      );
  }

  // ------------------------------------------------------------ 负向 C：错 id
  rec.step("负向 C：tool_use_id 写错");
  const bC = {
    ...base,
    messages: [
      userMsg,
      assistantMsg,
      {
        role: "user",
        content: toolUses.map((t, i) =>
          i === 0 ? { ...resultBlock(t), tool_use_id: "toolu_bogus_id_000000" } : resultBlock(t)
        ),
      },
    ],
  };
  const rC = await rec.call("首个 id 篡改", bC, () => client.messages.create(bC as any));
  if (!DRY_RUN)
    rec.finding(
      rC.ok
        ? "【证伪风险】错误的 tool_use_id 被接受 —— §12.5 把 toolCallId 当锚点的前提不成立"
        : `错误 tool_use_id 被拒绝（status=${rC.error?.status}）—— §12.5 的锚点假设成立`
    );

  // ------------------------------------------------------------ 负向 D：结构化拒绝
  rec.step("负向 D：为其中一个 call 回结构化的『被拒绝』result（Runtime 合成 result 的可行形态）");
  const bD = {
    ...base,
    messages: [
      userMsg,
      assistantMsg,
      {
        role: "user",
        content: toolUses.map((t, i) =>
          i === 0 ? resultBlock(t, { content: REJECTION_PAYLOAD, is_error: true }) : resultBlock(t)
        ),
      },
    ],
  };
  const rD = await rec.call("合成拒绝 result", bD, () => client.messages.create(bD as any));
  if (!DRY_RUN) {
    if (rD.ok) {
      rec.note("模型对被拒绝调用的反应", (rD.value as any).content);
      rec.finding(
        "合成的拒绝 result 被接受（is_error 字段可用）—— §12.2 的 REJECTED_* 阶段可以合成合法 result"
      );
    } else {
      rec.finding(`合成拒绝 result 被拒（status=${rD.error?.status}）—— 需换一种合成形态，见日志`);
    }
  }

  await rec.close();
}

// ====================================================================== OpenAI

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({ probe: "p1", provider: OPENAI_PROVIDER_LABEL, model: OPENAI_MODEL });

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: PARALLEL_PROMPT },
  ];
  const base = { model: OPENAI_MODEL, tools: openaiChatTools };

  rec.step("正向：一句话触发多次工具调用");
  const b1 = { ...base, messages };
  const r1 = await rec.call("触发并行", b1, () => client.chat.completions.create(b1 as any));

  let toolCalls: any[] = [];
  let assistantMsg: any = null;
  if (r1.ok) {
    const choice = (r1.value as any).choices?.[0];
    assistantMsg = choice?.message;
    toolCalls = assistantMsg?.tool_calls ?? [];
    rec.note("finish_reason", choice?.finish_reason);
    rec.note("tool_calls 数量", toolCalls.length);
    rec.note("tool_call id 形态", toolCalls.map((t: any) => t.id));
    rec.note("tool_calls 名称与入参", toolCalls.map((t: any) => ({ name: t.function?.name, args: t.function?.arguments })));
    rec.finding(
      `一次响应返回 ${toolCalls.length} 个 tool_call（finish_reason=${choice?.finish_reason}）`
    );
    rec.note(
      "入参是字符串还是对象",
      typeof toolCalls[0]?.function?.arguments
    );
  }

  rec.step("参数探测：parallel_tool_calls: false（候选名，不假设其存在）");
  const b2 = { ...base, messages, parallel_tool_calls: false };
  const r2 = await rec.call("parallel_tool_calls=false", b2, () =>
    client.chat.completions.create(b2 as any)
  );
  if (r2.ok) {
    const n = (r2.value as any).choices?.[0]?.message?.tool_calls?.length ?? 0;
    rec.finding(`parallel_tool_calls=false 被接受，本次返回 ${n} 个 tool_call`);
  } else if (!DRY_RUN) {
    rec.finding("parallel_tool_calls=false 不被接受 —— 见日志错误体");
  }

  if (!r1.ok || toolCalls.length === 0) {
    if (!DRY_RUN) rec.unansweredItem("无 tool_call，负向实验全部跳过");
    await rec.close();
    return;
  }

  const toolMsg = (t: any, content?: string) => ({
    role: "tool",
    tool_call_id: t.id,
    content: content ?? fakeToolResult(t.function?.name, safeParse(t.function?.arguments)),
  });

  rec.step("基线对照：全部 tool 消息按原序回传 —— 应成功");
  const bBase = { ...base, messages: [...messages, assistantMsg, ...toolCalls.map((t) => toolMsg(t))] };
  const rBase = await rec.call("全部回传", bBase, () => client.chat.completions.create(bBase as any));
  if (rBase.ok) rec.finding("基线成功");
  else if (!DRY_RUN) rec.unansweredItem("基线失败，负向实验不可归因");

  rec.step("负向 A：只回传一部分 tool 消息（验证 §8.6 不变量 2）");
  const bA = { ...base, messages: [...messages, assistantMsg, toolMsg(toolCalls[0])] };
  const rA = await rec.call("只回第 1 个", bA, () => client.chat.completions.create(bA as any));
  if (!DRY_RUN)
    rec.finding(
      rA.ok
        ? `【证伪】[${OPENAI_PROVIDER_LABEL}] 缺 ${toolCalls.length - 1} 个 tool 消息仍被接受 —— ` +
            `该实现不强制配对。§8.6 不变量 2 的理据不能是「否则 Provider 会 400」，` +
            `只能是「否则模型看到的世界失真」，执行责任 100% 在 Runtime`
        : `[${OPENAI_PROVIDER_LABEL}] 缺 tool 消息被拒绝（status=${rA.error?.status}）—— ` +
            `该实现强制配对，§8.6 不变量 2 有外部兜底`
    );

  if (toolCalls.length > 1) {
    rec.step("负向 B：tool 消息顺序打乱");
    const bB = {
      ...base,
      messages: [...messages, assistantMsg, ...[...toolCalls].reverse().map((t) => toolMsg(t))],
    };
    const rB = await rec.call("逆序回传", bB, () => client.chat.completions.create(bB as any));
    if (!DRY_RUN)
      rec.finding(
        rB.ok
          ? `[${OPENAI_PROVIDER_LABEL}] 逆序被接受 —— §11.5 的 protocolGroup 无需保证组间顺序`
          : `[${OPENAI_PROVIDER_LABEL}] 逆序被拒绝（status=${rB.error?.status}）—— 顺序也是协议约束`
      );
  }

  rec.step("负向 C：tool_call_id 写错");
  const bC = {
    ...base,
    messages: [
      ...messages,
      assistantMsg,
      ...toolCalls.map((t, i) =>
        i === 0 ? { ...toolMsg(t), tool_call_id: "call_bogus_000000" } : toolMsg(t)
      ),
    ],
  };
  const rC = await rec.call("首个 id 篡改", bC, () => client.chat.completions.create(bC as any));
  if (!DRY_RUN)
    rec.finding(
      rC.ok
        ? `【证伪】[${OPENAI_PROVIDER_LABEL}] 错误的 tool_call_id 被接受 —— ` +
            `§12.5 把 toolCallId 当锚点在本实现上只是 Runtime 的自我约定，无外部校验`
        : `[${OPENAI_PROVIDER_LABEL}] 错误 tool_call_id 被拒绝（status=${rC.error?.status}）`
    );

  rec.step("负向 D：为其中一个 call 回结构化的『被拒绝』result");
  const bD = {
    ...base,
    messages: [
      ...messages,
      assistantMsg,
      ...toolCalls.map((t, i) => (i === 0 ? toolMsg(t, REJECTION_PAYLOAD) : toolMsg(t))),
    ],
  };
  const rD = await rec.call("合成拒绝 result", bD, () => client.chat.completions.create(bD as any));
  if (!DRY_RUN) {
    if (rD.ok) {
      rec.note("模型对被拒绝调用的反应", (rD.value as any).choices?.[0]?.message);
      rec.finding(
        `[${OPENAI_PROVIDER_LABEL}] 合成的拒绝 result 被接受 —— ` +
          `该 API 形状无 is_error 等带外字段，拒绝语义只能写在 content 里，` +
          `§12.2 的 REJECTED_* 需要一个约定的结构化 payload`
      );
    } else {
      rec.finding(`合成拒绝 result 被拒（status=${rD.error?.status}）`);
    }
  }

  await rec.close();
}

function safeParse(s: any) {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return {};
  }
}

await probe("P1", "并行 Tool Call —— 正向 + 4 组负向", async () => {
  await anthropic();
  await openai();
});
