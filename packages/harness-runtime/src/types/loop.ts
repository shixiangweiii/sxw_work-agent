/**
 * 主循环状态与迁移（V05 §8.2）。
 *
 * D-20：字段集参照 query.ts 的十字段量级；大对象外置，只留必要引用。
 *
 * LoopState 不需要可序列化 —— 可以放 Promise、AbortController、完整 Message[]。
 * 恢复走 transcript，不走状态快照。这是删掉纯 Kernel 之后剩下的唯一自由度。
 */

import type { BudgetUsage, RecoveryItem } from "./run.js";
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

/**
 * 每个 continue 必须带具名 reason（循环纪律第 2 条）。
 *
 * 【定】值域 == 循环里**真的存在**的 continue 站点，一个不多。
 * 此前 7 个值里 4 个零生产者，读 Trace 的人会去找一条不存在的路径。
 */
export type Continue =
  | { reason: "NEXT_TURN" }
  | { reason: "OUTPUT_LIMIT_RECOVERY"; attempt: number }
  | { reason: "MODEL_ERROR_RETRY"; attempt: number };

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
  /**
   * 【定】**不带 `incompleteItems`。**
   *
   * 它此前有这个字段，而 `LoopTerminated` 的载荷同时装 `terminal` 与
   * `outcome` —— 于是同一行 JSONL 里会出现两份「未完成项」。
   * 2026-08-31 的 current-only 清理里，为了消掉一次重复结算，
   * 这里被填成了 `[]`，两份从「必然相同」变成了**必然不同**：
   *
   *   terminal.incompleteItems = []
   *   outcome.incompleteItems  = [真实未完成项…]
   *
   * 它零消费者（全仓只有 `terminal.reason` 与 `RECOVERY_REQUIRED` 的
   * `recoveryItems` 被读过），所以处置是**删掉**，不是填回真值 ——
   * 补一份「正确的」只会留下第二个事实载体。权威在 `outcome`。
   *
   * 【定】其余变体上的字段留着（`MAX_TURNS.turnCount`、`MODEL_ERROR.error`、
   * `NO_PROGRESS.toolName/repeats`）：它们**补充**了 reason 说不出的信息，
   * 而不是复述 outcome 已有的东西 —— 那是 §19.2「Trace 里能直接读出
   * 走了哪条路径」的兑现方式。
   */
  | { reason: "COMPLETED_WITH_LIMITS" }
  | { reason: "ABORTED_STREAMING" }
  | { reason: "ABORTED_TOOLS" }
  | { reason: "CONTEXT_EXHAUSTED" }
  | { reason: "BUDGET_EXHAUSTED" }
  | { reason: "QUOTA_EXHAUSTED" }
  | { reason: "MODEL_ERROR"; error: RuntimeErrorRecord }
  | { reason: "MAX_TURNS"; turnCount: number }
  /**
   * Progress Guard 判定「在原地打转」（阶段 3 S9，§16.2）。
   *
   * 【定】它与 MAX_TURNS 是两回事：后者说「跑够久了」，前者说
   * 「跑了但没往前」。合成一个 kind 会让「模型第三次发同一个调用」
   * 和「任务本来就需要 20 轮」在 Trace 上不可区分。
   */
  | { reason: "NO_PROGRESS"; toolName: string; repeats: number }
  | { reason: "RECOVERY_REQUIRED"; recoveryItems: RecoveryItem[] };

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
