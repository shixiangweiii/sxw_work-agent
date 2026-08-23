/**
 * P3　流式中断【必答】
 *
 * V03 §8.5 目前的保守默认是「半截响应中已闭合的 Tool Call 是否可用，取决于
 * Provider 是否保证其完整性【验】，在结论出来前默认整体丢弃」（V03 :906）。
 * 本探针决定能否放宽这条默认。
 *
 * 关键观测：中断时能不能从事件流本身判断「某个 tool call 已经闭合」。
 * 如果能，Runtime 就可以保留已闭合的 call；如果不能，只能整体丢弃。
 *
 * 喂给：§8.5 中断规则、V03 :906 的【验】标记
 */

import { probe, openRecorder, requireKey, DRY_RUN } from "../harness.js";
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
import { anthropicTools, openaiChatTools, PARALLEL_PROMPT, SYSTEM_PROMPT } from "../tools.js";

/** 收到第 N 个 delta 事件后中断。取值要落在「第一个 call 的参数正在流式传输」区间。 */
const ABORT_AFTER_DELTAS = 6;

// ==================================================================== Anthropic

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({
    probe: "p3",
    provider: ANTHROPIC_PROVIDER_LABEL,
    model: ANTHROPIC_MODEL,
    params: { abortAfterDeltas: ABORT_AFTER_DELTAS },
  });

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: anthropicTools,
    messages: [{ role: "user", content: PARALLEL_PROMPT }],
    stream: true,
  };

  rec.step(`流式请求，收到第 ${ABORT_AFTER_DELTAS} 个 delta 后 abort`);
  await rec.call("流式请求体（仅记录）", body, async () => ({ recorded: true }));

  if (DRY_RUN) {
    console.log("    [dry-run] 跳过流式中断");
    await rec.close();
    return;
  }

  const controller = new AbortController();
  const seen: string[] = [];
  const blocksStarted: any[] = [];
  const blocksStopped: number[] = [];
  let deltaCount = 0;
  let aborted = false;
  let finalMessage: any = null;

  try {
    const stream = await client.messages.create(body as any, { signal: controller.signal });
    for await (const ev of stream as any) {
      seen.push(ev.type);
      rec.streamEvent("anthropic", ev);

      if (ev.type === "content_block_start") blocksStarted.push({ index: ev.index, block: ev.content_block });
      if (ev.type === "content_block_stop") blocksStopped.push(ev.index);

      // 只数「工具参数的增量」，与 OpenAI 路径的 tool_calls chunk 计数口径对齐。
      // 之前数的是全部 content_block_delta，推理块会先产生大量增量，
      // 导致中断点还停在 thinking 里，两条路径测的根本不是同一件事，不可比。
      if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
        deltaCount++;
        if (deltaCount >= ABORT_AFTER_DELTAS) {
          aborted = true;
          controller.abort();
          break;
        }
      }
      if (ev.type === "message_stop") finalMessage = ev;
    }
  } catch (err: any) {
    rec.note("中断时抛出", { name: err?.name, message: err?.message });
  }

  rec.note("已收到的事件类型序列", seen);
  rec.note("已开始的内容块", blocksStarted);
  rec.note("已闭合的内容块 index", blocksStopped);
  rec.note("是否主动中断", aborted);
  rec.note("是否收到 message_stop", finalMessage !== null);

  rec.finding(
    `中断时：已开始 ${blocksStarted.length} 个内容块，其中 ${blocksStopped.length} 个收到了 content_block_stop`
  );

  if (blocksStopped.length > 0) {
    rec.finding(
      "存在 content_block_stop 事件 —— Runtime 可以据此判定某个块已闭合，" +
        "§8.5 的「整体丢弃」默认可以放宽为「保留已闭合的块」"
    );
  } else {
    rec.finding(
      "中断点之前没有任何块闭合 —— 本次无法证明可以部分保留；" +
        "调大 ABORT_AFTER_DELTAS 重跑可测更晚的中断点"
    );
  }

  // SDK 是否提供半截消息的累积视图
  rec.step("SDK 侧：abort 后能否取到 partial message");
  rec.note(
    "说明",
    "本探针用低阶 for-await 收事件。若 SDK 提供 stream.finalMessage() / accumulate()，" +
      "在中断后调用会抛错还是返回半截结果，是另一个待测点"
  );
  rec.unansweredItem("SDK 的 partial message 累积 API 在 abort 后的行为（需查 SDK 版本对应文档后补测）");

  // 负向：把参数不完整的 call 当完整送回
  rec.step("负向：把参数 JSON 不完整的 tool_use 当完整送回");
  const halfOpen = blocksStarted.find((b) => b.block?.type === "tool_use");
  if (halfOpen) {
    const bad = {
      model: ANTHROPIC_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages: [
        { role: "user", content: PARALLEL_PROMPT },
        {
          role: "assistant",
          // thinking 块必须带上：DeepSeek 拒绝只含 tool_use 的 assistant 回合（见 P9）。
          // 不带它的话这里会拿到一个与「入参完整性」毫无关系的 400，
          // 而下面的结论会把它当成「Provider 校验了入参完整性」—— 一个错误的证实。
          content: [
            { type: "thinking", thinking: "根据用户要求调用工具。", signature: "" },
            { type: "tool_use", id: halfOpen.block.id, name: halfOpen.block.name, input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: halfOpen.block.id, content: "{}" }],
        },
      ],
    };
    const rBad = await rec.call("半截 call 当完整送回", bad, () => client.messages.create(bad as any));
    // 拒绝要归因到「入参不完整」才算数。文案指向别的原因（如推理块缺失）时
    // 只能登记未解答 —— 否则会把一个无关的 400 读成「Provider 校验了入参完整性」。
    const badMsg = String((rBad.error as any)?.message ?? "");
    const aboutInput = /input|argument|parameter|schema|required|empty/i.test(badMsg);
    rec.finding(
      rBad.ok
        ? "【证伪风险】参数为空的 tool_use 被接受 —— Provider 不校验入参完整性，" +
            "完整性判定完全是 Runtime 的责任"
        : aboutInput
          ? `参数不完整的 tool_use 被拒绝（status=${rBad.error?.status}）`
          : `被拒绝（status=${rBad.error?.status}）但文案与入参无关，不能归因于入参完整性校验：${badMsg.slice(0, 160)}`
    );
    if (!rBad.ok && !aboutInput) {
      rec.unansweredItem("入参完整性是否被校验 —— 本次拒绝另有原因，未测到");
    }
  } else {
    rec.unansweredItem("中断点之前未开始任何 tool_use 块，负向实验跳过");
  }

  await rec.close();
}

// ====================================================================== OpenAI

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({
    probe: "p3",
    provider: OPENAI_PROVIDER_LABEL,
    model: OPENAI_MODEL,
    params: { abortAfterDeltas: ABORT_AFTER_DELTAS },
  });

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: PARALLEL_PROMPT },
    ],
    tools: openaiChatTools,
    stream: true,
  };

  rec.step(`流式请求，收到第 ${ABORT_AFTER_DELTAS} 个含 tool_call 的 chunk 后 abort`);
  await rec.call("流式请求体（仅记录）", body, async () => ({ recorded: true }));

  if (DRY_RUN) {
    console.log("    [dry-run] 跳过流式中断");
    await rec.close();
    return;
  }

  const controller = new AbortController();
  const chunkTypes: string[] = [];
  const argAccum: Record<number, string> = {};
  let toolChunkCount = 0;
  let finishReason: string | null = null;

  try {
    const stream = await client.chat.completions.create(body as any, { signal: controller.signal });
    for await (const chunk of stream as any) {
      rec.streamEvent("openai", chunk);
      const delta = chunk.choices?.[0]?.delta;
      finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
      chunkTypes.push(delta?.tool_calls ? "tool_calls" : delta?.content ? "content" : "other");

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          argAccum[tc.index] = (argAccum[tc.index] ?? "") + (tc.function?.arguments ?? "");
        }
        toolChunkCount++;
        if (toolChunkCount >= ABORT_AFTER_DELTAS) {
          controller.abort();
          break;
        }
      }
    }
  } catch (err: any) {
    rec.note("中断时抛出", { name: err?.name, message: err?.message });
  }

  rec.note("chunk 类别序列", chunkTypes);
  rec.note("累积到的参数片段", argAccum);
  rec.note("中断时的 finish_reason", finishReason);

  const indices = Object.keys(argAccum)
    .map(Number)
    .sort((a, b) => a - b);
  const maxIndex = indices.length ? Math.max(...indices) : -1;

  const parseable = indices.map((i) => {
    const s = argAccum[i];
    let complete = false;
    try {
      JSON.parse(s);
      complete = true;
    } catch {
      /* 半截 JSON 几乎不可能解析成功 */
    }
    return {
      index: i,
      argsParseable: complete,
      // 更强的信号：后继 index 已经开始 ⟹ 本 index 必然已经收完
      supersededByLaterIndex: i < maxIndex,
      partial: complete ? undefined : s,
    };
  });
  rec.note("各 call 的闭合判据", parseable);

  rec.finding(
    `[${OPENAI_PROVIDER_LABEL}] 中断时 finish_reason=${finishReason ?? "null"}；` +
      `参数可解析的 call ${parseable.filter((p) => p.argsParseable).length}/${parseable.length} 个`
  );

  // M-1：数据里其实有比「JSON 能否解析」更强的判据，必须记成 finding 而不是留给人工发现
  const closedByOrder = parseable.filter((p) => p.supersededByLaterIndex);
  if (closedByOrder.length > 0) {
    rec.finding(
      `【闭合判据】观测到 index ${closedByOrder.map((p) => p.index).join(",")} 在后继 index 开始后不再收到增量 —— ` +
        `「index N+1 出现 ⟹ index N 已闭合」是比「参数 JSON 能否解析」更强的判据，` +
        `二者合用可让 §8.5 从「整体丢弃」放宽为「保留已闭合的 call」`
    );
  } else {
    rec.unansweredItem(
      "中断点只覆盖了一个 tool call，无法验证「后继 index 出现」这一闭合判据；" +
        "调大 ABORT_AFTER_DELTAS 重跑"
    );
  }

  if (finishReason === null) {
    rec.finding(
      `[${OPENAI_PROVIDER_LABEL}] 中断时无 finish_reason —— ` +
        `该 API 形状没有独立的「内容块闭合」事件，闭合必须由 Runtime 自行推断`
    );
  }

  await rec.close();
}

await probe("P3", "流式中断 —— 半截响应的结构与可用性", async () => {
  await anthropic();
  await openai();
});
