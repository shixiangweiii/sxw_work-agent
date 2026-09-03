/**
 * request_handoff —— 请求人工接管。【机制工具】
 *
 * 服务的机制：**§20 人工接管**（Run → `WAITING_FOR_INTERACTION`）。
 *
 * 不做它会怎样：接管流程**没有起点**。原方案的流程图从「Runtime 请求接管」
 * 开始，但**谁、通过什么信号请求**没有定义 —— 而模型表达这个意图的唯一途径
 * 就是工具调用。没有这个工具，模型碰到「必须人去外部系统操作才能继续」时
 * 只有两个选择：**假装做完了**，或者**报一个含糊的失败**。
 * 两者都比停下来问一句糟得多。
 *
 * ── ⚠️ 这里原本写着「它同时是 U-8 的落点 —— 两个洞是同一个」。**那句话对了一半。**
 *
 * 回源核对 U-8 原文：说的是 `WAITING_FOR_USER` 这个**枚举值零产出点**。
 * 本工具确实关掉了那个状态机的洞。没关掉的是另一半 ——
 * **「问一个没有外部动作的问题」这件事本身**。
 *
 * 判别它们的不是措辞，是 `expected_completion` 这个**必填**字段：
 * 用本工具问一个偏好问题，模型必须为它**编造**一个可观察结果，
 * 而那个字段的全部意义就是「别信口头声明，去核实」（§20.3）。
 *
 * 阶段 3.5 补了 `ask_user`（`mech/ask-user.ts`），两者的分工见 ADR-0008。
 * 【定】改本工具的 description 时必须同时看那一份 —— 两段措辞是成对的，
 * 只改一边会让模型在两个工具之间随机选。
 *
 * ── 它为什么不是场景工具 ────────────────────────────────────────────────
 *
 * 三场景确实**都有**接管需求（办公要人去外部系统确认、代码要人解冲突、
 * 聊天要人确认发送），但它服务的是 Harness 机制而不是某个业务动作：
 * 它不产生任何业务副作用，只把 Run 切到一个等待状态。
 * 按决 2 修订 1 归第二类。
 *
 * ── 形态 ────────────────────────────────────────────────────────────────
 *
 * 无副作用、幂等 → §18.2 分支一（崩溃后重新请求一次接管是安全的）。
 *
 * 【定】它**不做 PARKED lease**（决 5）。lease 的真需求来自多 Run 并发，
 * 而当前是单进程、一 Run 一循环（§18.6【定】「等待就是 await，
 * 进程死了所有等待一起死」）。
 */

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";

export const requestHandoffDefinition: ToolDefinition = {
  id: asId("tool_request_handoff"),
  version: "1.0.0",
  name: "request_handoff",
  /**
   * ── 【定】这段话是这个工具唯一的入口，改它等于改行为 ──────────────────
   *
   * 2026-08-28 办公任务实跑的题 3：模型**分析全对**（判断出合同编号本地查不到、
   * 需要人去审批系统查，还没抄诱饵编号），但它把这件事写进最终总结文本就停手了，
   * `request_handoff` 三次正式 ＋ smoke ＋ 专项 B 共五次尝试**零调用**。
   *
   * 回看措辞，两处把它引向了那条「字面合规的错路」：
   *
   * 1. **正面例子全是「操作」** —— 点确认、线下核对、解冲突、确认发送。
   *    「人到外部系统**查一条数据**」没有被任何例子覆盖，于是模型把它归进了
   *    「查不到 → 如实说明」那一类。现已补进例子里。
   *
   * 2. **原来的最后一句是一个逃逸口**：「也不要在无法完成任务时用它替代如实说明」。
   *    模型的「占位符草稿 ＋ 总结里如实说明」正是这句话引导出来的。
   *    现在把两件事分开：**「必须由人做」用工具停下来**，
   *    只有**「这件事根本不该做」**才在总结里说明。
   *
   * 【定】改这段时守住这条区分。把它们重新合并，题 3 那个形态会立刻回来。
   */
  description:
    "请人接手做一件你做不了的事，然后再继续。" +
    "适用于必须由人接触外部世界才能往下走的情况：去某个系统里点确认、线下核对、" +
    "解决一个需要判断的冲突、确认一条消息可以发出去，" +
    "以及**去你读不到的系统里查一条数据**（合同编号、工单号、审批结论这类）。" +
    "instructions 写清楚要人做什么（具体到可执行）；expected_completion 写清楚" +
    "做完之后应该出现什么可观察的结果 —— 系统会在人说做完之后**重新去观察**，" +
    "而不是直接相信。" +
    "不要用它来问你自己能查到的信息（那用 read_file / search）。" +
    "缺一样东西、而它要靠人去外部系统拿时，用这个工具停下来等，" +
    "**不要写一个占位符然后收尾** —— 占位符会被当成已经完成的交付物。" +
    "只有当那件事根本不该做时，才在总结里说明并结束。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
    properties: {
      instructions: { type: "string", description: "要人做什么，具体到可执行" },
      expected_completion: {
        type: "string",
        description: "做完之后应该出现什么可观察的结果（系统会据此重新观察）",
      },
    },
    required: ["instructions", "expected_completion"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/instructions",
      // 它不碰外部世界 —— 碰外部世界的是**人**。工具本身只是发一个信号。
      effectType: "NONE",
      scopeKind: "NONE",
      reversibility: "REVERSIBLE",
      operation: "request_handoff",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  /**
   * 【定】步骤超时必须**远大于**人的反应时间。
   *
   * 接管的本质是等人去外部世界做事 —— 10 分钟只够去点两下，
   * 而「去财务系统里核对一张单据」可能要半小时。超时太短会让
   * 接管在最需要它的场景里自动失败。
   *
   * 真正的上限由预算的墙钟轴管，而等待时间**不计入 active**（见 S10 ③），
   * 所以这里给一个宽松值不会让 Run 白白耗光预算。
   */
  timeoutPolicy: { timeoutMs: 2 * 60 * 60_000 },
  progressReporting: { mode: "NONE" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
  /**
   * 【定】这一行是 §20 的**全部触发条件**。
   *
   * Runtime 看到它才会把 Run 切到 `WAITING_FOR_INTERACTION`、
   * 并把等待时间从 active 墙钟里扣掉。少了它，用户去外部系统操作 10 分钟
   * 回来，下一轮可能直接 `BUDGET_EXHAUSTED` —— 而那 10 分钟里
   * Agent 什么都没干（R-2 的派生缺口，评审 pi 维度 6 指出的后果）。
   */
  waitsForHumanInteraction: true,
};

/**
 * 接管的等待由 Composition Root 提供 —— 它才知道「人在哪」
 * （终端、GUI、还是一个没有人的 CI）。
 *
 * 【定】返回值不是「任务成功了」，只是「人说他做完了」。
 * §20.3：**完成信号不等于任务成功，必须重新 Observation。**
 * 这是接管与「盲目继续」的唯一区别。
 */
export interface HandoffChannel {
  /**
   * 把接管请求交给人，等他说做完。
   *
   * 返回 `undefined` 表示**等不到人**（无 TTY、被取消）——
   * 【定】调用方不得把它当成「做完了」。
   */
  await(request: {
    instructions: string;
    expectedCompletion: string;
    signal: AbortSignal;
  }): Promise<{ note?: string } | undefined>;
}

export async function executeRequestHandoff(
  input: { instructions: string; expected_completion: string },
  ctx: ToolExecutionContext,
  channel: HandoffChannel | undefined,
): Promise<ToolExecutionOutcome> {
  if (!channel) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_HANDOFF_NO_CHANNEL",
        source: "RUNTIME",
        category: "INTERNAL",
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "NO_EFFECT",
        safeMessage:
          "本次装配没有接管通道，request_handoff 无法工作。" +
          "这是装配错误：能发起接管却无人接收，等于把 Run 挂死。",
      }),
    };
  }

  const answered = await channel.await({
    instructions: input.instructions,
    expectedCompletion: input.expected_completion,
    signal: ctx.signal,
  });

  if (!answered) {
    return {
      ok: false,
      output: "",
      // 【定】NO_EFFECT 而不是 UNKNOWN：没人来接管，那就是什么都没发生。
      // 报 UNKNOWN 会凭空造出一个需要人工确认的待办项 —— 而问题恰恰是没有人。
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_HANDOFF_UNANSWERED",
        source: "USER",
        category: "TIMEOUT",
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "NO_EFFECT",
        safeMessage:
          "没有人接管这次请求（非交互环境，或等待被取消）。" +
          "需要人操作外部世界的那一步没有发生 —— 不要假设它已完成。",
      }),
    };
  }

  return {
    ok: true,
    output: JSON.stringify({
      status: "HANDOFF_COMPLETED_BY_USER",
      // 【定】措辞必须让模型知道这只是**人的声明**，不是已验证的事实。
      // 写成「已完成」会让它直接往下走，而 §20.3 要求先重新观察。
      note: "用户表示他已经做完了你请求的那件事。这是**他的声明**，不是已经核实过的事实。",
      userNote: answered.note ?? "",
      expectedCompletion: input.expected_completion,
      nextStep:
        "请先用只读工具（stat / read_file / search / list_dir）去确认 expectedCompletion " +
        "描述的结果是否真的出现了，再决定下一步。确认不了就如实说明。",
    }),
    sideEffectState: "NO_EFFECT",
  };
}

export const requestHandoffSnapshot: ToolSnapshot = {
  toolId: requestHandoffDefinition.id,
  version: requestHandoffDefinition.version,
  definition: requestHandoffDefinition,
};
