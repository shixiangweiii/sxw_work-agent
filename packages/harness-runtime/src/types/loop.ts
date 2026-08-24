/**
 * 主循环状态与迁移（V05 §8.2）。
 *
 * D-20：字段集参照 query.ts 的十字段量级；大对象外置，只留必要引用。
 *
 * LoopState 不需要可序列化 —— 可以放 Promise、AbortController、完整 Message[]。
 * 恢复走 transcript，不走状态快照。这是删掉纯 Kernel 之后剩下的唯一自由度。
 */

import type { BudgetUsage, IncompleteItem, RecoveryItem } from "./run.js";
import type { CompactTrackingState } from "./context.js";
import type { RuntimeErrorRecord } from "./error.js";
import type { ContextMessage } from "./transcript.js";

/**
 * 每个 continue 站点必须构造完整的一份，不做零散字段赋值 ——
 * 漏赋一个字段就是一条隐藏的状态泄漏（循环纪律第 1 条）。
 */
export interface LoopState {
  messages: ContextMessage[];
  turnCount: number;
  consecutiveFailures: number;
  compactTracking: CompactTrackingState | undefined;
  budgetUsage: BudgetUsage;
  maxOutputTokensOverride: number | undefined;
  modelErrorRetries: number;
  outputLimitRecoveries: number;
  /**
   * 上一次为什么 continue。首次迭代为 undefined。
   * 让验收脚本能断言某条恢复路径确实走了，而不必去翻消息内容。
   */
  transition: Continue | undefined;
}

/** 每个 continue 必须带具名 reason（循环纪律第 2 条）。 */
export type Continue =
  | { reason: "NEXT_TURN" }
  | { reason: "COMPACT_RETRY" }
  | { reason: "CONTEXT_OVERFLOW_RECOVERY" }
  | { reason: "OUTPUT_LIMIT_RECOVERY"; attempt: number }
  | { reason: "MODEL_ERROR_RETRY"; attempt: number }
  | { reason: "APPROVAL_RESUMED" }
  | { reason: "INTERJECTION_ACCEPTED" };

/**
 * 每个 return 必须是具名 Terminal（循环纪律第 2 条）。
 *
 * 【定】Terminal 是「本次循环的具名出口」，不等于「Run 已终结」。
 * `RECOVERY_REQUIRED` 就是那个反例：它是 V05 §10.4 明确的**非终态**，
 * 循环必须停下来，但 Run 还活着，等用户给出恢复决策。
 * 判据：它映射到的 RunStatus 是 RECOVERY_REQUIRED，不是 COMPLETED/FAILED/CANCELLED，
 * 且不结算 RunOutcome —— 没结束的东西没有结果可结算。
 */
export type Terminal =
  | { reason: "COMPLETED" }
  | { reason: "COMPLETED_WITH_LIMITS"; incompleteItems: IncompleteItem[] }
  | { reason: "ABORTED_STREAMING" }
  | { reason: "ABORTED_TOOLS" }
  | { reason: "CONTEXT_EXHAUSTED" }
  | { reason: "BUDGET_EXHAUSTED" }
  | { reason: "QUOTA_EXHAUSTED" }
  | { reason: "MODEL_ERROR"; error: RuntimeErrorRecord }
  | { reason: "MAX_TURNS"; turnCount: number }
  | { reason: "RECOVERY_REQUIRED"; recoveryItems: RecoveryItem[] };

export type StepKind =
  | "CONTEXT_COMPILE"
  | "COMPACT"
  | "MODEL_INVOCATION"
  | "TOOL_EXECUTION"
  | "OBSERVATION"
  | "VERIFICATION";

/**
 * 构造下一轮状态的唯一入口。
 *
 * 存在的理由就是循环纪律第 1 条：强制每个 continue 站点显式给出 transition，
 * 并让「漏赋字段」在类型层面不可能发生 —— patch 之外的字段一律从 prev 完整继承。
 */
export function nextState(
  prev: LoopState,
  patch: Partial<Omit<LoopState, "transition">>,
  transition: Continue,
): LoopState {
  return { ...prev, ...patch, transition };
}
