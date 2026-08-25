/**
 * RunEvent（V05 §19）。
 *
 * Event 不是独立的持久化轨道。它从 generator yield 给消费方，
 * 由 Trace 侧自行落盘用于诊断，恢复不读它。
 *
 * LoopContinued / LoopTerminated 携带具名 reason —— 这是循环纪律第 2 条在可观测侧的落点：
 * Trace 里能直接读出走了哪条恢复路径，不必去比对消息内容。
 */

import type { ActionBatchId, ActionId, RunId, Timestamp } from "./ids.js";
import type { Continue, Terminal } from "./loop.js";
import type { ModelUsage, RunOutcome } from "./run.js";
import type { RuntimeErrorRecord } from "./error.js";

export type RunEvent =
  | Ev<"RunStarted", { task: string; endpointId: string; modelId: string }>
  | Ev<"TurnStarted", { turn: number }>
  | Ev<"LoopContinued", { transition: Continue }>
  | Ev<"LoopTerminated", { terminal: Terminal; outcome: RunOutcome }>
  | Ev<"ContextFrameCompiled",
      { items: number; totalTokens: number; fixedOverheadTokens: number; compacted: boolean }>
  | Ev<"ContextCompacted", { freedTokens: number; reason: string }>
  | Ev<"ModelStreamDelta", { text: string }>
  | Ev<"ModelInvocationCompleted",
      { toolCallCount: number; usage: ModelUsage; stopReason: string; durationMs: number }>
  | Ev<"ActionBatchPlanned", { batchId: ActionBatchId; callCount: number; mode: string }>
  | Ev<"ActionProposed",
      { actionId: ActionId; toolCallId: string; toolName: string; effect: string }>
  | Ev<"ActionRejected", { actionId: ActionId; stage: string; reason: string }>
  | Ev<"ApprovalRequested", { actionId: ActionId; effect: string; reason: string }>
  | Ev<"ApprovalDecided", { actionId: ActionId; approved: boolean; reason?: string }>
  | Ev<"AttemptStarted", { actionId: ActionId; toolName: string }>
  | Ev<"AttemptCompleted",
      { actionId: ActionId; status: string; sideEffectState: string; durationMs: number }>
  | Ev<"ToolProgress", { actionId: ActionId; note: string }>
  | Ev<"VerificationCompleted",
      { actionId: ActionId; status: string; required: boolean; detail: string }>
  | Ev<"ActionBatchSettled", { batchId: ActionBatchId; resultCount: number; callCount: number }>
  | Ev<"InterjectionAccepted", { content: string }>
  | Ev<"BudgetSoftLimitReached", { axis: string; used: number; limit: number }>
  | Ev<"BudgetHardLimitReached", { axis: string; used: number; limit: number }>
  | Ev<"RecoveryRequired", { items: number }>
  /**
   * 用户对 RECOVERY_REQUIRED 给出的显式决策（V05 §18.2 第三条分支的出口）。
   * 【定】没有这条事件，Run 不得从 RECOVERY_REQUIRED 继续 ——
   * 「交用户决定」必须真的拿到一个决定，而不是下次 resume() 自动放行。
   */
  | Ev<"RecoveryResolved", { decision: "CONTINUE" | "ABORT"; items: number; note?: string }>
  | Ev<"RuntimeErrorOccurred", { error: RuntimeErrorRecord }>
  /** 实际行为与端点声明不符。不得静默继续（V05 §8.6 不变量 4）。 */
  | Ev<"EndpointBehaviorDrift",
      { field: string; declared: string; observed: string; disposition: "RECORD" | "FAIL_FAST" }>
  | Ev<"ResumeStarted", { fromSequence: number; rebuiltMessages: number }>
  | Ev<"ResumeUnpairedToolUse",
      { toolCallId: string; toolName: string; branch: string }>;

interface EvBase {
  runId: RunId;
  /**
   * 与 transcript 条目同一条单调序列（D-2）。取号点是
   * `TranscriptStorePort.nextSequence()`，两条轨道共用一个分配器。
   *
   * 事件本身**不落 transcript**，所以 transcript.sequence 上会出现空洞 ——
   * 那是正确的，空洞恰好表达「这两条消息之间发生过 N 个事件」，
   * 两条轨道因此可以全序比较。§23.2 的 Layer 2 投影游标依赖这一点。
   *
   * 这条注释在 D-2 修复之前就已经这么写了，但当时是**假的**：
   * runLoop 与 store 各有一个计数器，resume 后 runLoop 的还从 0 重计。
   */
  sequence: number;
  occurredAt: Timestamp;
}

type Ev<T extends string, P> = EvBase & { type: T; payload: P };

export type RunEventType = RunEvent["type"];
