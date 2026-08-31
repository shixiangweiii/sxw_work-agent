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
import type { DataMovementDescriptor } from "./tool.js";

export type RunEvent =
  | Ev<"RunStarted", { task: string; endpointId: string; modelId: string }>
  | Ev<"TurnStarted", { turn: number }>
  | Ev<"LoopContinued", { transition: Continue }>
  | Ev<"LoopTerminated", { terminal: Terminal; outcome: RunOutcome }>
  /**
   * `trust` 是阶段 3 收口批补的。
   *
   * 【定】`hasExternalUntrusted` 为真时，Trace 上必须留得下这条事实。
   * 在此之前它只从 `compile.ts` 流到 `executeBatch` 的一个入参，
   * **从未进过任何事件** —— 也就是说「这一轮上下文里有外部不可信内容」
   * 这件事在盘上完全查不到，而 `fetch_url` 之后它是审计外泄链路的起点。
   */
  | Ev<"ContextFrameCompiled",
      {
        items: number;
        totalTokens: number;
        fixedOverheadTokens: number;
        compacted: boolean;
        trust: { hasExternalUntrusted: boolean; untrustedItems: number };
      }>
  | Ev<"ContextCompacted", { freedTokens: number; reason: string }>
  | Ev<"ModelStreamDelta", { text: string }>
  | Ev<"ModelInvocationCompleted",
      { toolCallCount: number; usage: ModelUsage; stopReason: string; durationMs: number }>
  | Ev<"ActionBatchPlanned", { batchId: ActionBatchId; callCount: number; mode: string }>
  /**
   * 【定】`riskFacts` / `dataMovement` 必须在这里，不能只活在 Resolver 的返回值里。
   *
   * `policy.ts` 把「URL scope 产出 riskFact ＋ dataMovement，让外发在 **Trace 上
   * 可审计**」列为「越界读放行」的三条护栏之一。护栏 ①②（读黑名单、私网拒绝）
   * 都在工具里真的拦着，而 ③ 此前**没有任何出口** —— 事件只带一个拼接过的
   * `effect` 字符串，「这次调用把数据发去了哪个 host、带了哪些参数名」在盘上
   * 完全查不到。一条不成立的依据支撑着一个已经生效的放开决定。
   *
   * 【定】`dataMovement.destination` 只记 host，`scope` 只记参数**名** ——
   * 记参数值会让这条审计记录自己变成第二个泄漏点（见 effect-resolver）。
   */
  | Ev<"ActionProposed",
      {
        actionId: ActionId;
        toolCallId: string;
        toolName: string;
        effect: string;
        riskFacts: string[];
        dataMovement?: DataMovementDescriptor;
      }>
  | Ev<"ActionRejected", { actionId: ActionId; stage: string; reason: string }>
  | Ev<"ApprovalRequested", { actionId: ActionId; effect: string; reason: string }>
  | Ev<"ApprovalDecided", { actionId: ActionId; approved: boolean; reason?: string }>
  | Ev<"AttemptStarted", { actionId: ActionId; toolName: string }>
  | Ev<"AttemptCompleted",
      { actionId: ActionId; status: string; sideEffectState: string; durationMs: number }>
  | Ev<"ToolProgress", { actionId: ActionId; note: string }>
  /**
   * 人工接管的等待段（阶段 3 S10，§20）。
   *
   * 【定】它必须是**成对**的。主循环靠这一对把等待时间从 active 墙钟里
   * 夹出来（与 Approval 那一对同构）—— 只发前一条，`waitingSince` 会
   * 永远悬着，从那一刻起所有时间都被当成等待扣掉，墙钟预算形同虚设。
   */
  | Ev<"InteractionRequested", { actionId: ActionId; toolName: string; detail: string }>
  /** `answered` 说的是「人应答了没有」，**不是**「任务成功了没有」（§20.3）。 */
  | Ev<"InteractionCompleted", { actionId: ActionId; toolName: string; answered: boolean }>
  /**
   * 大结果被外置（阶段 3 S6，§11.4）。
   *
   * 【定】它必须发。外置在 transcript 上表现为「一条很短的 stub」——
   * 与「工具本来就只返回了这么点」在盘上无法区分，而两者对读 trace 的人
   * 意义完全不同：前者有几百 KB 内容躺在 blob 里等着被取回。
   */
  | Ev<"ToolResultExternalized",
      { actionId: ActionId; toolName: string; ref: string; sizeBytes: number; approxTokens: number }>
  /** Artifact 登记（阶段 3 S8，§17）。它是第二层 Verification 的触发点。 */
  | Ev<"ArtifactRegistered",
      { artifactId: string; logicalId: string; version: number; role: string; kind: string }>
  /**
   * Artifact 级 Verification 的结果（§10.4 第二层）。
   *
   * `checksRun` 为空**不等于**通过 —— 那是「没有适用的检查器」。
   * 两者必须在事件上分得开，否则「我们验过了」这句话会被一个空集合背书。
   */
  | Ev<"ArtifactVerified",
      { artifactId: string; role: string; ok: boolean; checksRun: string[]; detail: string }>
  | Ev<"VerificationCompleted",
      { actionId: ActionId; status: string; required: boolean; detail: string }>
  | Ev<"ActionBatchSettled", { batchId: ActionBatchId; resultCount: number; callCount: number }>
  | Ev<"InterjectionAccepted", { content: string }>
  // ratio 一并带上：读 trace 的人不该再去翻 RunSpec 才知道 0.8 这个阈值从哪来。
  | Ev<"BudgetSoftLimitReached", { axis: string; used: number; limit: number; ratio: number }>
  | Ev<"BudgetHardLimitReached", { axis: string; used: number; limit: number }>
  | Ev<"RecoveryRequired", { items: number }>
  /** Progress Guard 判定无进展（阶段 3 S9，U-3）。 */
  | Ev<"NoProgressDetected", { toolName: string; repeats: number; inputDigest: string }>
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
  /**
   * 上次崩在「等人」那一刻，本次 resume 从那里接上（阶段 3 S10）。
   *
   * 【定】它必须发。少了它，「重新请求了一次接管」与「上次的接管其实
   * 已经完成了」在 Trace 上看起来一模一样 —— 而前者意味着人要再做一遍。
   */
  | Ev<"InteractionResumed", { pendingToolUses: string[] }>
  | Ev<"ResumeUnpairedToolUse",
      { toolCallId: string; toolName: string; branch: string ; hasPreFingerprint: boolean }>;

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
