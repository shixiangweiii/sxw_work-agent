/**
 * Budget 判定（V05 §16）。
 *
 * 【定】墙钟拆分：maxActiveWallClockMs 只累计 RUNNING 且有在途步骤的时间；
 * WAITING_* 不累计 —— 等审批等一小时不该把预算耗光。
 *
 * ── R-1：阶段 1 的判定只覆盖三条轴 ──────────────────────────────────────
 *
 * 主循环原先内联判 `maxTurns` / `elapsed` / `maxConsecutiveFailures` 三项，
 * 而 `RunBudgets` 声明了 10 个字段。`maxModelCalls`（默认 40）、`maxToolCalls`
 * （100）、两条 token 轴、`maxTotalWallClockMs`、`softLimitRatio` 与
 * `handoffReserveTokens` **全部有声明、无读取点**。
 *
 * 不变量 11 是「预算不得由模型决定忽略」。在此之前模型确实绕不过 turns，
 * 但可以在一轮里发起任意多次工具调用、烧任意多 token。阶段 1 的两个工具
 * 跑不出那个量级，所以没被发现 —— 这是「用例太小掩盖了缺口」，
 * 不是「没问题」。
 *
 * 判定收进纯函数，主循环只消费结果：这样每条轴都能被单独注入验证
 * （`verify:budget` 就是逐轴撞墙），而不是散在循环里靠读代码确认。
 */

import type { ContextBudgetPolicy } from "../types/context.js";
import type { BudgetUsage, RunBudgets } from "../types/run.js";

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

// ═══════════════════════════════════════════════════════════ 判定

/** 可撞墙的轴。每一条都对应 RunBudgets 里的一个字段。 */
export type BudgetAxis =
  | "turns"
  | "activeWallClockMs"
  | "totalWallClockMs"
  | "modelCalls"
  | "toolCalls"
  | "inputTokens"
  | "outputTokens"
  | "consecutiveFailures";

export type BudgetVerdict =
  | { kind: "OK" }
  | { kind: "SOFT"; axis: BudgetAxis; used: number; limit: number; ratio: number }
  | { kind: "HARD"; axis: BudgetAxis; used: number; limit: number };

export interface CheckBudgetsInput {
  usage: BudgetUsage;
  consecutiveFailures: number;
  budgets: RunBudgets;
  /** 当前时刻。用于 totalWallClockMs（**不是** active —— 那个是累计值）。 */
  now: number;
}

/**
 * 纯函数判定。主循环只消费结果，不自己比数。
 *
 * 【定】HARD 优先于 SOFT：同一轮里既超软限又超硬限时，报硬限。
 * 反过来会让「先提醒再停」变成「只提醒不停」。
 *
 * 【定】`activeWallClockMs` 读的是 **usage 里的累计值**，不是 `now - startedAt`。
 * 这是 R-2 的落点 —— 后者会把等审批的时间、以及跨进程 resume 之间关机的
 * 那一整夜都算进来。`startedAt` 只服务 `maxTotalWallClockMs` 这条独立的轴。
 */
export function checkBudgets(input: CheckBudgetsInput): BudgetVerdict {
  const { usage, budgets, consecutiveFailures, now } = input;
  const ratio = budgets.softLimitRatio;

  /** [used, limit] 对，limit 为 undefined 表示该轴未设限。 */
  const axes: Array<[BudgetAxis, number, number | undefined]> = [
    ["turns", usage.turns, budgets.maxTurns],
    ["activeWallClockMs", usage.activeWallClockMs, budgets.maxActiveWallClockMs],
    ["totalWallClockMs", now - usage.startedAt, budgets.maxTotalWallClockMs],
    ["modelCalls", usage.modelCalls, budgets.maxModelCalls],
    ["toolCalls", usage.toolCalls, budgets.maxToolCalls],
    ["inputTokens", usage.billedInputTokens, budgets.maxInputTokens],
    ["outputTokens", usage.outputTokens, budgets.maxOutputTokens],
    ["consecutiveFailures", consecutiveFailures, budgets.maxConsecutiveFailures],
  ];

  for (const [axis, used, limit] of axes) {
    if (limit === undefined) continue;
    if (used >= limit) return { kind: "HARD", axis, used, limit };
  }

  for (const [axis, used, limit] of axes) {
    // consecutiveFailures 不报软限：它的限值通常是 3，0.8×3=2.4，
    // 第 3 次失败前一轮就提醒没有意义，只会制造噪音。
    if (limit === undefined || axis === "consecutiveFailures") continue;
    if (used >= limit * ratio) return { kind: "SOFT", axis, used, limit, ratio };
  }

  return { kind: "OK" };
}

/**
 * 把 HARD 判定映射成具名 Terminal 的 reason。
 *
 * `turns` 有自己的 Terminal（`MAX_TURNS` 带 turnCount），其余归
 * `BUDGET_EXHAUSTED` —— 具体是哪条轴由 `BudgetHardLimitReached` 事件说明，
 * 不必给每条轴造一个 Terminal。
 */
export function hardLimitIsTurns(v: BudgetVerdict): boolean {
  return v.kind === "HARD" && v.axis === "turns";
}
