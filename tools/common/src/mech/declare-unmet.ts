/**
 * declare_unmet —— 收尾前如实声明「用户明确要求的这一条没满足」。【机制工具】
 *
 * 服务的机制：**结算（§10.4）**。ADR-0019 候选 C，**按预注册实验的结果采纳**（2026-10-16）：
 * 违约侧 4/5 声明且都点名了「在云沙箱里用 pandas」（判据 ≥4/5）、守约侧 0/5（判据 ≤1/5），
 * DeepSeek 两侧方向一致。没过关的话这整套（工具、提示、信号类型）会被撤掉 —— 判据是先写进 ADR 再跑的。
 *
 * 不做它会怎样：模型如实说了「pandas 没跑起来、数值是手工累加的」，而那句话只活在自然语言总结里；
 * 结算不读自然语言（不变量 12），于是 Run 照样记 `SUCCESS`（`run_8fc75ecea093`）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它**只能降、不能升**：声明了 → `COMPLETED_WITH_LIMITS`；不声明 → 与今天一样。
 * 被测对象只能给自己扣分，所以「Run 给自己打分」那条担忧只剩一半；
 * 剩下的一半（模型把自己加的事也声明进来，守约的 Run 被成批降级）正是实验要量的东西。
 *
 * 【定】description 与 `ask_user` / `request_handoff` 成对写（ADR-0008 的纪律）：
 * 三个工具都和「人」有关，措辞一含糊模型就会在它们之间随机选。
 * 这一个**不等任何人** —— 它只是在事实表上记一句「这一条没满足」。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 形态：无副作用、幂等、只读 → §18.2 分支一（崩溃后重放一次只是重复声明同一条）。
 */

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";

const STATUSES = new Set(["NOT_DONE", "DONE_DIFFERENTLY"]);

export const declareUnmetDefinition: ToolDefinition = {
  id: asId("tool_declare_unmet"),
  version: "1.0.0",
  name: "declare_unmet",
  description:
    "收尾前，把**用户在任务里明确要求、而你没能做到**的事逐条声明出来（一次调用声明一条）。" +
    "requirement 引用任务原文里那句要求；status 写 NOT_DONE（没做到）或 DONE_DIFFERENTLY" +
    "（结果交了，但没按用户要求的做法做，比如要求「在云沙箱里用 pandas」而实际是手工算的）；why 写原因。" +
    "**只声明用户明确要求的**：你自己额外想加的复核、优化没做成，写在最终总结里就行，不要声明。" +
    "声明之后这次任务不会被记成「全部完成」——这是如实，不是失败。" +
    "**与 ask_user / request_handoff 的区别**：那两个会停下来等人；declare_unmet 不等任何人，" +
    "它只是在结算记录上如实写下「这一条没满足」。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      requirement: { type: "string", description: "任务原文里那句没满足的要求（引用原话）" },
      status: { type: "string", description: '"NOT_DONE"（没做到）或 "DONE_DIFFERENTLY"（换了做法）' },
      why: { type: "string", description: "为什么没满足，一句话" },
    },
    required: ["requirement", "status", "why"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/requirement",
      effectType: "NONE",
      scopeKind: "NONE",
      reversibility: "REVERSIBLE",
      operation: "declare_unmet",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 5_000 },
  progressReporting: { mode: "NONE" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
};

export async function executeDeclareUnmet(
  input: { requirement: string; status: string; why: string },
  _ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const requirement = input.requirement.trim();
  if (!requirement || !STATUSES.has(input.status)) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_DECLARE_UNMET_BAD_INPUT",
        source: "TOOL_INPUT",
        category: "VALIDATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage:
          'requirement 不能为空；status 只能是 "NOT_DONE" 或 "DONE_DIFFERENTLY"。',
      }),
    };
  }
  return {
    ok: true,
    output: JSON.stringify({
      status: "DECLARED",
      note: "已记下。这次任务的结算会如实标出这一条没满足；在最终总结里照常说明即可。",
    }),
    sideEffectState: "NO_EFFECT",
    completionSignal: {
      kind: "MODEL_DECLARED_UNMET",
      detail: requirement,
      note: `${input.status === "NOT_DONE" ? "没做到" : "换了做法"}：${input.why.trim() || "（未写原因）"}`,
    },
  };
}

export const declareUnmetSnapshot: ToolSnapshot = {
  toolId: declareUnmetDefinition.id,
  version: declareUnmetDefinition.version,
  definition: declareUnmetDefinition,
};
