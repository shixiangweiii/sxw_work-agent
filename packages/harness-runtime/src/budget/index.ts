/**
 * Budget 辅助（V05 §16）。
 *
 * 【定】墙钟拆分：maxActiveWallClockMs 只累计 RUNNING 且有在途步骤的时间；
 * WAITING_* 不累计 —— 等审批等一小时不该把预算耗光。
 *
 * 阶段 1 的判定逻辑内联在主循环里（就那几个比较），这里只放
 * 需要跨模块共享的默认值。
 */

import type { ContextBudgetPolicy } from "../types/context.js";
import type { RunBudgets } from "../types/run.js";

/**
 * reservedOutputTokens 必须同时覆盖推理与正文。
 *
 * 实测：max_completion_tokens=64 时 finish_reason=length、content=""、
 * reasoning_tokens=64 —— 预算全被推理吃掉，接口成功、无错误码、内容为空。
 * 在两个独立探针中复现。
 */
export const DEFAULT_CONTEXT_POLICY: ContextBudgetPolicy = {
  modelWindowTokens: 128_000,
  reservedOutputTokens: 8_192,
  softInputLimitTokens: 60_000,
  hardInputLimitTokens: 100_000,
  compactTargetTokens: 40_000,
  inlineToolResultLimitTokens: 8_000,
  retrievalPageLimitTokens: 4_000,
};

export const DEFAULT_BUDGETS: RunBudgets = {
  maxTurns: 20,
  maxActiveWallClockMs: 10 * 60_000,
  maxModelCalls: 40,
  maxToolCalls: 100,
  maxConsecutiveFailures: 3,
  softLimitRatio: 0.8,
  handoffReserveTokens: 2_000,
};
