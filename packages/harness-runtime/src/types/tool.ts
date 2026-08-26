/**
 * Tool、Effect 与 Action 类型（V05 §12）。
 */

import type {
  ActionBatchId,
  ActionId,
  AttemptId,
  BlobRef,
  JsonValue,
  RunId,
  Timestamp,
  ToolId,
  VersionedRef,
} from "./ids.js";
import type { RuntimeErrorRecord, SideEffectState } from "./error.js";

// ─────────────────────────────────────────────────────────── Effect

export type EffectType = "READ" | "WRITE" | "DELETE" | "EXECUTE" | "NETWORK" | "NONE";

export interface EffectScope {
  kind: "FILE" | "DIRECTORY" | "URL" | "PROCESS" | "NONE";
  /** 规范化语义对象，不以自由文本作为授权边界。 */
  value: string;
}

export interface PreconditionFingerprint {
  target: string;
  hash?: string;
  existedAt?: Timestamp;
}

export interface DataMovementDescriptor {
  destination: string;
  scope: string;
}

export interface ResolvedEffect {
  effectType: EffectType;
  operation: string;
  scope: EffectScope;
  reversibility: "REVERSIBLE" | "PARTIALLY_REVERSIBLE" | "IRREVERSIBLE";
  dataMovement?: DataMovementDescriptor;
  targetFingerprints: PreconditionFingerprint[];
  riskFacts: string[];
  resolverVersion: string;
  digest: string;
}

export interface DeclarativeScopeRule {
  /** JSON Pointer 指向输入里的目标字段。 */
  pointer: string;
  effectType: EffectType;
  scopeKind: EffectScope["kind"];
  reversibility: ResolvedEffect["reversibility"];
  operation: string;
}

export type EffectResolutionDescriptor =
  | { kind: "DECLARATIVE"; version: string; rules: DeclarativeScopeRule[] }
  | { kind: "RESOLVER"; resolverRef: VersionedRef<unknown> };

// ─────────────────────────────────────────────────────── Descriptors

export interface RedactionDescriptor {
  /** 必填。不声明的 Tool 走默认最严格 profile，而不是默认放行。 */
  profile: "STRICTEST" | "STANDARD" | "NONE";
  fieldsToRedact?: string[];
}

/**
 * 消息级恢复把它从可选优化属性抬成了恢复正确性的前提（原则十五）。
 * resume() 无法区分「工具跑没跑」，只能靠这个声明与 Observation 逼近。
 */
export interface IdempotencyDescriptor {
  isIdempotent: boolean;
  isReadOnly: boolean;
  idempotencyKeyPointer?: string;
}

export interface TimeoutPolicy {
  timeoutMs: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export interface CancellationDescriptor {
  cooperative: boolean;
}

export interface ProgressReportingDescriptor {
  mode: "NONE" | "HEARTBEAT" | "MONOTONIC_PROGRESS";
  intervalMs?: number;
}

export interface VerificationDescriptor {
  mode: "NONE" | "INLINE_RESULT" | "REOBSERVE" | "CUSTOM_VERIFIER";
  verifierRef?: string;
  /** 唯一一个能把 SUCCESS 降级为 COMPLETED_WITH_LIMITS 的信号（V05 §10.4）。 */
  requiredForSuccess: boolean;
  observationCost: "LOW" | "MEDIUM" | "HIGH";
  timeoutMs?: number;
  staleAfterMs?: number;
}

export interface ConcurrencyDescriptor {
  mode: "SAFE" | "EXCLUSIVE" | "KEYED";
  key?: string;
}

/** 一个极简的 JSON Schema 子集。够阶段 1 的两个工具用，不引入 schema 库。 */
export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean";
  description?: string;
}

export interface ToolDefinition {
  id: ToolId;
  version: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  requiredCapabilities: string[];
  effectResolution: EffectResolutionDescriptor;
  /** 必填（V05 §12.3）。 */
  redaction: RedactionDescriptor;
  retryPolicy: RetryPolicy;
  idempotency: IdempotencyDescriptor;
  timeoutPolicy: TimeoutPolicy;
  cancellation: CancellationDescriptor;
  progressReporting: ProgressReportingDescriptor;
  verification: VerificationDescriptor;
  /**
   * 崩溃后能不能观察（决 6，阶段 2 新增）。
   *
   * ── 它为什么不能和 `verification` 是同一个字段 ────────────────────────
   *
   * 阶段 1 用 `verification.mode !== "NONE"` 回答「§18.2 该走哪条分支」，
   * 而那个字段说的是「**执行后**能不能验」。两件事真的不同：
   *
   *   `append_log` 执行后验不了（验证器不知道「该有几行」），
   *   但崩溃后能不能观察，取决于**执行前有没有留下前置指纹**。
   *
   * 更要紧的是：阶段 2 的研究问题正是「有多少次 resume 落进第三条分支」，
   * 而分流依据就是这个字段 —— 测量仪器和被测对象是同一个旋钮。
   * `write_note` 的 idempotency 注释自己承认过这件事：
   * 「覆盖写严格说是幂等的，标成非幂等是为了让分支二有工具可测」。
   *
   * 【定】声明它**不等于**崩溃后一定观察得了。真正的判据是 Action 级事实
   * （transcript 里那条 `ACTION_FACT`），不是这里。这个字段只说明
   * 「这个工具**原则上**可以这么观察」。
   */
  recoveryObservation?: RecoveryObservationDescriptor;
  concurrency?: ConcurrencyDescriptor;
}

/**
 * 崩溃后观察的声明。
 *
 * `kind` 供 VerificationPort 的实现理解「该拍什么指纹、怎么比」——
 * Runtime 只负责在执行前把指纹存下来、在恢复时取出来交回去，
 * **不理解指纹的内容**（那是工具域知识，而依赖方向禁止 Runtime 认识 Case 包）。
 */
export interface RecoveryObservationDescriptor {
  kind: "TARGET_EXISTS" | "TARGET_CONTENT_HASH" | "TARGET_APPEND_TAIL";
  /**
   * 观察是否**必须**有执行前指纹才成立。
   *
   * false：像 write_note 那样「目标内容 == 计划内容」就能判定，不需要前置状态；
   * true ：像 append_log 那样的**相对**操作 —— 目标状态取决于起始状态，
   *        没有起始状态的指纹就无从判断那一行到底追加了没有。
   */
  requiresPreFingerprint: boolean;
}

export interface ToolSnapshot {
  toolId: ToolId;
  version: string;
  contentHash: string;
  definition: ToolDefinition;
}

// ────────────────────────────────────────────────────────── Action

export type ActionStage =
  | "PROPOSED"
  | "REJECTED_SCHEMA"
  | "REJECTED_POLICY"
  | "REJECTED_APPROVAL"
  | "PREPARED"
  | "EXECUTING"
  | "SETTLED"
  | "SKIPPED";

export interface ProposedAction {
  id: ActionId;
  runId: RunId;
  batchId: ActionBatchId;
  batchIndex: number;
  /**
   * 配对锚点。在选定端点上无外部校验 —— 篡改后 200 接受。
   * 它是 Runtime 的自我约定，Runtime 必须自己保证一致性。
   */
  toolCallId: string;
  toolName: string;
  rawInput: unknown;
  stage: ActionStage;
  schemaError?: RuntimeErrorRecord;
  createdAt: Timestamp;
}

export interface PreparedAction extends ProposedAction {
  normalizedInput: JsonValue;
  inputDigest: string;
  resolvedEffect: ResolvedEffect;
  actionDigest: string;
  previewRef?: BlobRef;
  preparedAt: Timestamp;
}

export interface ExecutionAttempt {
  id: AttemptId;
  actionId: ActionId;
  startedAt: Timestamp;
  finishedAt?: Timestamp;
  status: "STARTED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "SKIPPED";
  sideEffectState: SideEffectState;
  output?: string;
  error?: RuntimeErrorRecord;
}

// ─────────────────────────────────────────────────────── ActionBatch

export interface BatchSettlementPolicy {
  onActionFailure: "CONTINUE_REMAINING" | "SKIP_REMAINING" | "ABORT_BATCH";
  onApprovalRejected: "SKIP_REMAINING" | "CONTINUE_REMAINING";
  onCancel: "ABORT_UNSTARTED";
}

/**
 * D-21：默认值依据 query.ts 的实际行为（已核对源码）。
 * runTools() 遍历全部 tool block，不 break、不短路；失败与拒绝在内部变成 tool_result。
 *
 * 任何取值都不影响不变量 8 —— 它只决定后续 Action 的 result 是真实结果还是 SKIPPED，
 * 不决定有没有 result。
 */
export const DEFAULT_SETTLEMENT: BatchSettlementPolicy = {
  onActionFailure: "CONTINUE_REMAINING",
  onApprovalRejected: "CONTINUE_REMAINING",
  onCancel: "ABORT_UNSTARTED",
};

export interface ActionBatch {
  id: ActionBatchId;
  runId: RunId;
  invocationId: string;
  actions: PreparedAction[];
  /**
   * v0.1 恒为 SEQUENTIAL（D-01）。理据是 Runtime 自持，不是协议保障：
   * 四个端点全部静默接受强制单条开关，其中三个不生效，没有一个会告诉你「我不支持」。
   */
  executionMode: "SEQUENTIAL" | "CONCURRENT_LIMITED";
  maxConcurrency?: number;
  approvalMode: "PER_ACTION" | "BATCH_SINGLE";
  batchDigest: string;
  settlement: BatchSettlementPolicy;
  status: "PLANNED" | "IN_PROGRESS" | "SETTLED";
  settledAt?: Timestamp;
}

// ───────────────────────────────────────────────────────── Approval

export interface Approval {
  id: string;
  runId: RunId;
  scope: "ACTION" | "BATCH";
  actionId?: ActionId;
  batchId?: ActionBatchId;
  digest: string;
  effectScope: EffectScope;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
  createdAt: Timestamp;
  decidedAt?: Timestamp;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

/**
 * 审批决策由调用方注入，不是 Runtime 内建（V05 §14.3）。
 * CLI 注入交互式实现，验收脚本注入脚本化实现 —— 后者是必需的，
 * 因为验收脚本必须能无人值守跑完。
 */
export type ApprovalDecider = (action: PreparedAction) => Promise<ApprovalDecision>;

// ───────────────────────────────────────────────────── Verification

export interface VerificationResult {
  id: string;
  actionId: ActionId;
  mode: VerificationDescriptor["mode"];
  required: boolean;
  status: "PASSED" | "FAILED" | "SKIPPED";
  detail: string;
  at: Timestamp;
  /**
   * 这条必需验证「没拿到通过」的成因（决 2，阶段 2 新增）。
   *
   * 【定】它只在 `required && status !== "PASSED"` 时有意义，
   * 且**必须来自事实**（谁拒的、哪一步失败的），不得由结算逻辑推断。
   *
   * 为什么需要它：`outcome.kind` 里 `USER_REJECTED` 有值域、无事实来源 ——
   * 结算时看到一条失败的必需验证，分不出「用户按了 N」和「工具挂了」。
   * 而这两件事对用户的意义完全不同：前者是他自己的决定，
   * 后者是需要排查的故障。
   */
  unmetCause?: UnmetCause;
}

/**
 * 【定】值域只放**有明确事实来源**的成因。
 *
 * 特意**不**包含「模型声称做不了」—— 那需要判断模型的话语意图，
 * 会把结算从「只查事实表」拖回「读模型说了什么」，直接违反不变量 12。
 * 那一类继续走 SUCCESS ＋ summary，取舍写在 ADR 里（决 2）。
 */
export type UnmetCause =
  /** 用户在审批环节明确拒绝。 */
  | "USER_REJECTED"
  /** Policy 判定越界。 */
  | "POLICY_DENIED"
  /** 工具执行失败或抛异常。 */
  | "TOOL_FAILED"
  /** 被取消（用户 cancel 或批内策略跳过）。 */
  | "CANCELLED"
  /** 走到了验证但没能得出结论。 */
  | "NOT_OBSERVED";
