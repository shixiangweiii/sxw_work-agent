/**
 * Run 领域模型（V05 §7.7、§10）。
 */

import type {
  ActionBatchId,
  ActionId,
  AgentSpecId,
  EndpointId,
  JsonValue,
  RunId,
  RunSpecId,
  SessionId,
  Timestamp,
  WorkspaceId,
} from "./ids.js";
import type { EndpointCapabilityProfileSnapshot } from "./endpoint.js";
import type { RuntimeErrorRecord } from "./error.js";
import type { ToolSnapshot, VerificationResult } from "./tool.js";
import type { ContextBudgetPolicy } from "./context.js";

// ───────────────────────────────────────────────────────── AgentSpec

export interface ModelConfigurationSnapshot {
  endpointId: EndpointId;
  modelId: string;
  parameters: Record<string, JsonValue>;
  endpointProfileRef: string;
}

export interface AgentSpecSnapshot {
  agentSpecId: AgentSpecId;
  version: string;
  contentHash: string;
  model: ModelConfigurationSnapshot;
  systemPrompt: string;
  /**
   * IANA 时区名（如 "Asia/Shanghai"）。用于把 ClockPort 的时间戳渲染成
   * 模型能读的受信时间事实（见 context/compile.ts 的 buildFrame）。
   *
   * 【定】它属于 AgentSpec 而不是运行期环境变量 —— 一个 Run 看到的时间口径
   * 必须随 RunSpec 冻结，否则 Replay 会在不同时区下重放出不同的上下文。
   */
  timezone: string;
  toolSnapshots: ToolSnapshot[];
  contextPolicy: ContextBudgetPolicy;
  loopPolicy: LoopPolicySnapshot;
  approvalPolicy: ApprovalPolicySnapshot;
}

export interface LoopPolicySnapshot {
  maxTurns: number;
  maxConsecutiveFailures: number;
  maxModelErrorRetries: number;
  maxOutputLimitRecoveries: number;
}

export interface ApprovalPolicySnapshot {
  /** 需要审批的 effectType。TRUSTED_PERSONAL preset 下只有写与删。 */
  requiresApprovalFor: string[];
}

// ─────────────────────────────────────────────────────────── Budget

export interface RunBudgets {
  maxTurns: number;
  /** 只累计 RUNNING 且有在途步骤的时间。WAITING_* 不累计。 */
  maxActiveWallClockMs: number;
  maxTotalWallClockMs?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxConsecutiveFailures: number;
  softLimitRatio: number;
  handoffReserveTokens?: number;
}

export interface BudgetUsage {
  turns: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  billedInputTokens: number;
  activeWallClockMs: number;
  startedAt: Timestamp;
}

/**
 * resume() 必须继承的已完成事实（V05 §18.4【定】：
 * 「保留 RunId、RunSpec、已完成副作用**和预算使用**」）。
 *
 * 它不是 LoopState 的快照 —— 恢复仍然走 transcript，messages 从条目重建。
 * 这里只装那些**无法从消息序列反推**的累计量：花掉的 token、走过的轮次、
 * 已经付费测出来的 Verification 事实、以及尚未销账的 RecoveryItem。
 *
 * 【定】它必须落在 transcript 上（RUN_META 条目），不能只留在内存里。
 * 否则「反复 crash + resume」就能把预算清零，硬墙形同虚设。
 */
export interface ResumableRunFacts {
  turnCount: number;
  consecutiveFailures: number;
  budgetUsage: BudgetUsage;
  verifications: VerificationResult[];
  recoveryItems: RecoveryItem[];
  /**
   * 事件/transcript 共用序列的高水位（D-2）。
   *
   * 【定】必须落盘。事件从这条序列取号但**不落 transcript**，所以重启后
   * 单看 transcript 的最后一条只能得到一个下界 —— 从那里续号会把上一段
   * 已经发给 Trace 的号重发一遍，两份 trace 拼起来就对不上了。
   *
   * 这是「消息级恢复」这个选择的又一处代价：能从消息序列反推的都不用存，
   * 反推不出来的必须显式存（与 budgetUsage / turnCount 同理）。
   */
  lastSequence: number;
}

// ───────────────────────────────────────────────────────── RunSpec

export type RunOrigin =
  | { kind: "SESSION_MESSAGE"; sessionId: SessionId; messageId: string }
  | { kind: "EVAL"; caseId: string }
  | { kind: "CLI"; invokedAt: Timestamp };

export interface RunInput {
  task: string;
}

export interface WorkspaceExecutionSnapshot {
  workspaceId: WorkspaceId;
  /** 授权的根目录。ResolvedEffect 必须是它的子集。 */
  mounts: Array<{ mountId: string; absolutePath: string; writable: boolean }>;
}

/**
 * 自包含 —— Runtime 执行期间不需要回查 Layer 2。
 *
 * 判据：逐 Run 变化的进 RunSpec，不变的不进。
 * 完成判定规则对所有 Run 都一样，因此不在这里（V05 §10.4）。
 */
export interface RunSpec {
  id: RunSpecId;
  origin: RunOrigin;
  correlationId: string;
  input: RunInput;
  agentSpec: AgentSpecSnapshot;
  /**
   * 冻结的理由：Replay 要求「用当时的条件重放」。如果端点行为只存在于运行时配置里，
   * 三个月后 Replay 一个旧 Run 用的是今天的端点行为 —— 而实测表明端点行为会变。
   */
  endpointProfile: EndpointCapabilityProfileSnapshot;
  workspace?: WorkspaceExecutionSnapshot;
  budgets: RunBudgets;
  runtimeEnvironmentFingerprint: string;
  createdAt: Timestamp;
}

// ────────────────────────────────────────────────── Status & Outcome

/**
 * 没有 PAUSED —— 消息级恢复下它与「cancel() 后稍后 resume()」行为一致。
 *
 * WAITING_FOR_* 不是「循环停下来等一个 durable request」，而是循环阻塞在一个 await 上。
 * 状态值保留是给 Layer 2 与 UI 用的，不驱动调度。
 */
export type RunStatus =
  | "CREATED"
  | "RUNNING"
  | "WAITING_FOR_USER"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_INTERACTION"
  | "RECOVERY_REQUIRED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface IncompleteItem {
  what: string;
  why: string;
  actionId?: ActionId;
}

export interface RecoveryItem {
  what: string;
  sideEffectState: string;
  actionId?: ActionId;
  toolCallId?: string;
}

export interface RunOutcome {
  kind:
    | "SUCCESS"
    | "COMPLETED_WITH_LIMITS"
    | "USER_REJECTED"
    | "BUDGET_EXHAUSTED"
    | "CONTEXT_EXHAUSTED"
    /** 与 CONTEXT_EXHAUSTED 分开：后者必须压缩上下文，前者压缩没用。 */
    | "QUOTA_EXHAUSTED"
    | "CANCELLED"
    | "FAILED";
  summary?: string;
  deliveredArtifactIds: string[];
  incompleteItems: IncompleteItem[];
  recoveryItems: RecoveryItem[];
  error?: RuntimeErrorRecord;
}

/** 只读投影，不是恢复来源。恢复走 transcript。 */
export interface RunSnapshot {
  runId: RunId;
  runSpecId: RunSpecId;
  status: RunStatus;
  currentBatchId?: ActionBatchId;
  waitingOn?: "USER" | "APPROVAL" | "INTERACTION" | "RECOVERY";
  turnCount: number;
  consecutiveFailures: number;
  budgetUsage: BudgetUsage;
  messageCount: number;
  updatedAt: Timestamp;
}

// ─────────────────────────────────────────────────────────── Usage

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningTokens?: number;
  /**
   * 派生字段。只读 inputTokens 会在缓存命中时低估达 85%，
   * 因为命中时 inputTokens 只剩非缓存部分。
   */
  billedInputTokens: number;
}
