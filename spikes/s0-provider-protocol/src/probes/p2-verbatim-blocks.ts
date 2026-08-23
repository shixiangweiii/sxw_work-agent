/**
 * P2　必须原样回传的块【必答】
 *
 * V03 §11.5 目前只把 tool_call/tool_result 配对列为不可拆分单元，
 * 但同一失效类里还有「Provider 要求原样回传的推理块」。
 * §11.5 的【验】标记（V03 :1505）明确写着「具体规则以 Spike 0 实测为准，
 * 在结论出来前不得在代码中固化任何一种具体形态」。
 *
 * 本探针必须产出一份清单：哪些块进 REQUIRED_VERBATIM、哪些可以摘要、组边界在哪。
 * 负向 D（多轮中只保留最后一轮）直接决定 Compact 的硬约束范围。
 *
 * 喂给：§11.5 REQUIRED_VERBATIM、原则十一、§11.6 Compact 硬约束
 */

import { probe, openRecorder, requireKey, DRY_RUN } from "../harness.js";
import {
  anthropicClient,
  ANTHROPIC_THINKING_MODEL,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_API_KEY_NAME,
} from "../clients/anthropic.js";
import {
  openaiClient,
  OPENAI_REASONING_MODEL,
  OPENAI_PROVIDER_LABEL,
  OPENAI_API_KEY_NAME,
} from "../clients/openai.js";
import {
  anthropicTools,
  openaiResponsesTools,
  fakeToolResult,
  SYSTEM_PROMPT,
} from "../tools.js";

const MULTI_STEP_PROMPT =
  "先查北京的天气，看完结果后再决定要不要查北京的时间。请一步一步来，不要一次全查。";

// ==================================================================== Anthropic

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({
    probe: "p2",
    provider: ANTHROPIC_PROVIDER_LABEL,
    model: ANTHROPIC_THINKING_MODEL,
    params: { thinkingBudget: 2048 },
  });

  const base = {
    model: ANTHROPIC_THINKING_MODEL,
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 2048 },
    tools: anthropicTools,
  };
  const userMsg = { role: "user", content: MULTI_STEP_PROMPT };

  // ---------------------------------------------------------------- 正向
  rec.step("正向：拿到带推理块的响应，观察其结构");
  const b1 = { ...base, messages: [userMsg] };
  const r1 = await rec.call("第 1 轮", b1, () => client.messages.create(b1 as any));
  if (!r1.ok) {
    if (!DRY_RUN)
      rec.unansweredItem("第 1 轮失败 —— 扩展思考+工具组合不可用，P2 的 Anthropic 侧全部未解答");
    await rec.close();
    return;
  }

  const content1: any[] = (r1.value as any).content ?? [];
  const thinkingBlocks = content1.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
  const toolUses1 = content1.filter((b) => b.type === "tool_use");

  rec.note("内容块类型序列", content1.map((b) => b.type));
  rec.note("推理块数量", thinkingBlocks.length);
  rec.note(
    "推理块字段名（不看内容，只看结构）",
    thinkingBlocks.map((b) => Object.keys(b))
  );
  const hasSignature = thinkingBlocks.some((b: any) => b.signature !== undefined);
  rec.finding(
    `推理块 ${thinkingBlocks.length} 个，类型 ${[...new Set(thinkingBlocks.map((b) => b.type))].join("/")}，` +
      `${hasSignature ? "带 signature 字段" : "无 signature 字段"}`
  );

  if (toolUses1.length === 0) {
    rec.unansweredItem("第 1 轮未产生 tool_use —— 无法测「推理块 + 工具」的回传约束");
    await rec.close();
    return;
  }

  const assistant1 = { role: "assistant", content: content1 };
  const results1 = {
    role: "user",
    content: toolUses1.map((t: any) => ({
      type: "tool_result",
      tool_use_id: t.id,
      content: fakeToolResult(t.name, t.input),
    })),
  };

  // ------------------------------------------------------------ 基线（对照组）
  rec.step("基线对照：推理块原样回传 —— 应成功");
  const bBase = { ...base, messages: [userMsg, assistant1, results1] };
  const rBase = await rec.call("原样回传", bBase, () => client.messages.create(bBase as any));
  if (rBase.ok) rec.finding("基线成功 —— 负向实验的失败可归因");
  else if (!DRY_RUN) rec.unansweredItem("基线失败，负向不可归因");

  // ------------------------------------------------------------ 负向 A：删除
  rec.step("负向 A：删除推理块，只保留 tool_use");
  const strippedContent = content1.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
  const bA = {
    ...base,
    messages: [userMsg, { role: "assistant", content: strippedContent }, results1],
  };
  const rA = await rec.call("删除推理块", bA, () => client.messages.create(bA as any));
  if (!DRY_RUN)
    rec.finding(
      rA.ok
        ? "【关键】删除推理块被接受 —— 推理块不属于 REQUIRED_VERBATIM，Compact 可以丢弃它"
        : `删除推理块被拒绝（status=${rA.error?.status}）—— 推理块属于 REQUIRED_VERBATIM，` +
            `§11.5 必须把它纳入不可拆分单元`
    );

  // ------------------------------------------------------ 负向 B：改写文本保签名
  if (hasSignature) {
    rec.step("负向 B：改写推理文本但保留 signature（测签名校验）");
    const tamperedContent = content1.map((b: any) =>
      b.type === "thinking" ? { ...b, thinking: "（这段推理已被改写用于协议测试）" } : b
    );
    const bB = {
      ...base,
      messages: [userMsg, { role: "assistant", content: tamperedContent }, results1],
    };
    const rB = await rec.call("改写推理文本", bB, () => client.messages.create(bB as any));
    if (!DRY_RUN)
      rec.finding(
        rB.ok
          ? "【关键】改写推理文本被接受 —— 无签名校验，Compact 摘要推理块不会触发协议错误"
          : `改写推理文本被拒绝（status=${rB.error?.status}）—— 存在签名校验，` +
              `Compact 绝不能改写推理块内容`
      );

    rec.step("负向 C：保留推理块但删除 signature 字段");
    const noSigContent = content1.map((b: any) => {
      if (b.type !== "thinking") return b;
      const { signature, ...rest } = b;
      return rest;
    });
    const bC = {
      ...base,
      messages: [userMsg, { role: "assistant", content: noSigContent }, results1],
    };
    const rC = await rec.call("删除 signature", bC, () => client.messages.create(bC as any));
    if (!DRY_RUN)
      rec.finding(
        rC.ok
          ? "删除 signature 被接受 —— signature 非必填"
          : `删除 signature 被拒绝（status=${rC.error?.status}）—— signature 是回传的必需字段`
      );
  } else {
    rec.unansweredItem("推理块无 signature 字段，负向 B/C 跳过");
  }

  // -------------------------------------------------- 负向 D：多轮只留最后一轮
  rec.step("负向 D：进入第 2 轮，然后删除第 1 轮的推理块（决定 Compact 的硬约束范围）");
  if (rBase.ok) {
    const content2: any[] = (rBase.value as any).content ?? [];
    const assistant2 = { role: "assistant", content: content2 };
    const toolUses2 = content2.filter((b: any) => b.type === "tool_use");
    rec.note("第 2 轮内容块类型", content2.map((b: any) => b.type));

    const tail =
      toolUses2.length > 0
        ? [
            assistant2,
            {
              role: "user",
              content: toolUses2.map((t: any) => ({
                type: "tool_result",
                tool_use_id: t.id,
                content: fakeToolResult(t.name, t.input),
              })),
            },
          ]
        : [assistant2, { role: "user", content: "继续。" }];

    const bD = {
      ...base,
      messages: [
        userMsg,
        { role: "assistant", content: strippedContent }, // 第 1 轮去掉推理块
        results1,
        ...tail, // 第 2 轮保持原样
      ],
    };
    const rD = await rec.call("只删第 1 轮推理块", bD, () => client.messages.create(bD as any));
    if (!DRY_RUN)
      rec.finding(
        rD.ok
          ? "【关键】较早轮次的推理块可以删除 —— Compact 只需保护最近轮次，" +
              "§11.6 的 irreducibleTokens 不会随轮数无限增长"
          : `删除较早轮次推理块被拒绝（status=${rD.error?.status}）—— ` +
              `所有轮次的推理块都必须原样保留，这会让 irreducibleTokens 随轮数累积，` +
              `§11.6 的 Compact 机制需要重新设计`
      );
  } else {
    rec.unansweredItem("基线失败，负向 D 跳过");
  }

  await rec.close();
}

// ====================================================================== OpenAI

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({
    probe: "p2",
    provider: OPENAI_PROVIDER_LABEL,
    model: OPENAI_REASONING_MODEL,
  });

  rec.step("正向：Responses API 下的推理块结构");
  const b1 = {
    model: OPENAI_REASONING_MODEL,
    instructions: SYSTEM_PROMPT,
    input: [{ role: "user", content: MULTI_STEP_PROMPT }],
    tools: openaiResponsesTools,
  };
  const r1 = await rec.call("第 1 轮", b1, () => (client as any).responses.create(b1));
  if (!r1.ok) {
    if (!DRY_RUN)
      rec.unansweredItem(`[${OPENAI_PROVIDER_LABEL}] Responses API 不可用 —— 推理块约束未解答`);
    await rec.close();
    return;
  }

  const output: any[] = (r1.value as any).output ?? [];
  rec.note("output item 类型序列", output.map((o) => o.type));
  const reasoningItems = output.filter((o) => o.type === "reasoning");
  const fnCalls = output.filter((o) => o.type === "function_call");
  rec.note("推理 item 字段名", reasoningItems.map((o) => Object.keys(o)));
  rec.finding(
    `[${OPENAI_PROVIDER_LABEL}] Responses API 返回 ${reasoningItems.length} 个 reasoning item、` +
      `${fnCalls.length} 个 function_call`
  );

  // 加密推理块是「必须原样回传 + 签名校验」这一类约束的载体。
  // 若本实现根本不产出它，那么删除/改写实验的结论就只覆盖了明文推理块，
  // 签名校验问题在此端点上无法回答 —— 必须显式登记，不能静默略过。
  const encrypted = reasoningItems.filter((o: any) => o.encrypted_content != null);
  rec.note("encrypted_content 非空的 reasoning item 数", encrypted.length);
  if (encrypted.length === 0) {
    rec.finding(
      `[${OPENAI_PROVIDER_LABEL}] 全部 reasoning item 的 encrypted_content 为空 —— ` +
        `本实现不使用加密推理块，§11.5 中「带签名、必须逐字回传」的那一类约束在此端点上不存在`
    );
    rec.unansweredItem(
      "加密推理块的签名校验行为（本端点不产出该结构，无法在此回答）"
    );
  }

  if (fnCalls.length === 0) {
    rec.unansweredItem("未产生 function_call —— 无法测推理块 + 工具的回传约束");
    await rec.close();
    return;
  }

  const toolOutputs = fnCalls.map((c: any) => ({
    type: "function_call_output",
    call_id: c.call_id,
    output: fakeToolResult(c.name, safeParse(c.arguments)),
  }));

  rec.step("基线对照：推理 item 原样回传");
  const bBase = {
    ...b1,
    input: [{ role: "user", content: MULTI_STEP_PROMPT }, ...output, ...toolOutputs],
  };
  const rBase = await rec.call("原样回传", bBase, () => (client as any).responses.create(bBase));
  if (rBase.ok) rec.finding("基线成功");
  else if (!DRY_RUN) rec.unansweredItem("基线失败，负向不可归因");

  rec.step("负向 A：删除 reasoning item");
  const bA = {
    ...b1,
    input: [
      { role: "user", content: MULTI_STEP_PROMPT },
      ...output.filter((o) => o.type !== "reasoning"),
      ...toolOutputs,
    ],
  };
  const rA = await rec.call("删除 reasoning", bA, () => (client as any).responses.create(bA));
  if (!DRY_RUN)
    rec.finding(
      rA.ok
        ? `[${OPENAI_PROVIDER_LABEL}] 删除 reasoning item 被接受 —— ` +
            `在本实现上推理块不属于 REQUIRED_VERBATIM。注意这不能推广：` +
            `需结合 encrypted_content 是否为空判断（见上一步观测）`
        : `[${OPENAI_PROVIDER_LABEL}] 删除 reasoning item 被拒绝（status=${rA.error?.status}）—— ` +
            `属于 REQUIRED_VERBATIM`
    );

  rec.step("负向 B：改写 reasoning item 的可见字段");
  const bB = {
    ...b1,
    input: [
      { role: "user", content: MULTI_STEP_PROMPT },
      ...output.map((o: any) =>
        o.type === "reasoning" ? { ...o, summary: [{ type: "summary_text", text: "已改写" }] } : o
      ),
      ...toolOutputs,
    ],
  };
  const rB = await rec.call("改写 reasoning", bB, () => (client as any).responses.create(bB));
  if (!DRY_RUN)
    rec.finding(
      rB.ok
        ? `[${OPENAI_PROVIDER_LABEL}] 改写 reasoning 的可见字段被接受 —— 无内容校验，` +
            `Compact 摘要推理块不会触发协议错误`
        : `[${OPENAI_PROVIDER_LABEL}] 改写 reasoning 被拒绝（status=${rB.error?.status}）—— 存在内容校验`
    );

  await rec.close();
}

function safeParse(s: any) {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return {};
  }
}

await probe("P2", "必须原样回传的块 —— 推理块的删除 / 改写 / 跨轮次约束", async () => {
  await anthropic();
  await openai();
});
