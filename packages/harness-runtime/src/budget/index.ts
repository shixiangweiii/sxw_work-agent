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
  reservedOutputTokens: 8_192,
  softInputLimitTokens: 60_000,
  hardInputLimitTokens: 100_000,
  compactTargetTokens: 40_000,
  inlineToolResultLimitTokens: 8_000,
};

/**
 * ── R-1 只修了一半，补齐的那一半也值得记 ──────────────────────────────────
 *
 * R-1 当初的症状是「八条轴里五条有声明、无读取点」。读取点后来接上了
 * （就是下面的 `checkBudgets`），但两条 token 轴与 `maxTotalWallClockMs`
 * 在 `RunBudgets` 里是**可选**的，这份默认值一个都没给 ——
 * `limit === undefined` 就 `continue`，于是**生产装配里八条轴只有五条活着**。
 *
 * 而 `verify:budget` 是逐轴注入 `Partial` 覆盖来撞墙的，它证明的是读取点能用，
 * 不是这条轴在真实 Run 里开着。两件事被同一段绿字掩盖了一个阶段。
 *
 * 代价是实测的：2026-08-28 摸底考试题 1 单次 run 烧掉 420,784 billed input token
 * 与 46,563 output token，八条轴一条都没拦。
 *
 * 【定】`handoffReserveTokens` 已删。它是同一批里**唯一没被补上读取点**的那条，
 * 而上面这段话读起来像是全都补齐了 —— 一个自称已修复的缺口比一个登记着的缺口更贵。
 */
export const DEFAULT_BUDGETS: RunBudgets = {
  maxTurns: 20,
  maxActiveWallClockMs: 10 * 60_000,
  maxModelCalls: 40,
  maxToolCalls: 100,
  /**
   * 两条 token 轴的档位锚在实测上，不是拍脑袋：题 1 那次失控是
   * billed 420,784 / output 46,563。取 3～4 倍留出正常长任务的余量，
   * 同时保证「一个 Run 烧到离谱」会被拦住而不是靠墙钟兜。
   *
   * 【验】这两个数要在前缀缓存断点前移之后复测再定档 —— 缓存修好后
   * billed 会大幅下降，届时可以收紧。
   */
  maxBilledInputTokens: 1_500_000,
  maxOutputTokens: 200_000,
  /**
   * ── 【定】`maxTotalWallClockMs` 故意留空，不要「顺手补全」它 ─────────────
   *
   * 这条轴算的是 `now - usage.startedAt`，而 `startedAt` 在 resume 时是
   * **刻意继承**的（见 run-loop 里那条【定】：重置它等于把墙钟清零，
   * 一次 crash + resume 就能白拿一整个预算周期）。
   *
   * 所以给它一个默认值 = **隔夜 resume 在第一次迭代就撞墙** ——
   * 正是 R-2 当初为 `activeWallClockMs` 修掉的那个形态，换个字段再犯一次。
   *
   * 要给它默认值，得先有「跨段的停机时间不计入 total」的语义，
   * 而那正是 active 与 total 分成两条轴的原因：total 的定义就是「含停机」。
   * 它服务的是「这个 Run 挂了多久」这类运维问题，由调用方按场景显式传。
   *
   * `verify:budget` 有一条判据专门钉住这个「空」—— 补上默认值会翻红。
   */
  maxConsecutiveFailures: 3,
  softLimitRatio: 0.8,
};

// ═══════════════════════════════════════════════════════════ 判定

/** 可撞墙的轴。每一条都对应 RunBudgets 里的一个字段。 */
export type BudgetAxis =
  | "turns"
  | "activeWallClockMs"
  | "totalWallClockMs"
  | "modelCalls"
  | "toolCalls"
  /** 【定】名字带 billed —— 它读的是 `billedInputTokens`（含缓存两项）。 */
  | "billedInputTokens"
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
  const ratio = input.budgets.softLimitRatio;
  const axes = readBudgetAxes(input);

  for (const { axis, used, limit } of axes) {
    if (limit === undefined) continue;
    if (used >= limit) return { kind: "HARD", axis, used, limit };
  }

  for (const { axis, used, limit } of axes) {
    // consecutiveFailures 不报软限：它的限值通常是 3，0.8×3=2.4，
    // 第 3 次失败前一轮就提醒没有意义，只会制造噪音。
    if (limit === undefined || axis === "consecutiveFailures") continue;
    if (used >= limit * ratio) return { kind: "SOFT", axis, used, limit, ratio };
  }

  return { kind: "OK" };
}

/** 一条轴的读数。`limit` 缺席 = 这条轴未设限（`maxTotalWallClockMs` 默认就是）。 */
export interface BudgetAxisReading {
  axis: BudgetAxis;
  used: number;
  limit?: number;
  /** 单位。界面要靠它决定「12000」是毫秒还是 token —— 两者差 4 个数量级。 */
  unit: "count" | "ms" | "token";
}

/**
 * 八条轴的当前读数。**`checkBudgets` 自己就跑在它上面**（唯一的表）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ── 它为什么在阶段 4 才出现 ────────────────────────────────────────────
 *
 * 在此之前这张表只以「撞墙时报一条」的形态对外：`BudgetSoftLimitReached` /
 * `BudgetHardLimitReached` 各带一条轴。也就是说**没撞墙的轴在外面完全不可见** ——
 * 而白盒界面要显示的恰恰是「八条轴现在各自离墙有多远」。
 *
 * 阶段 4 的研究问题是「Runtime 一行不改能不能投影出白盒界面」。这里是**唯一
 * 答不上来的一处**，如实记在这儿：不是事件流缺一个字段，是这张
 * `axis → [used, limit]` 的对应表本身是 Runtime 知识，且从来没有对外形态。
 *
 * ── 为什么不让 Layer 2 自己拼这张表 ────────────────────────────────────
 *
 * 【定】因为它拼不对，而且**错了不会有任何征兆**。
 *
 * 「哪条轴读哪个字段、配哪个限额」是 Runtime 知识：`billedInputTokens`
 * 含缓存读写两项，只读 `inputTokens` 在命中时低估达 85%
 * （摸底考试 14/14 个 run 因此打出 1482% 假漂移）。
 *
 * 【定】所以提出来的是**读数**，不是判定：`checkBudgets` 仍然是唯一的判官，
 * Layer 2 拿到的是它用的同一张表。§5.2「合法状态迁移不由 UI 拥有」不因此松动。
 * ══════════════════════════════════════════════════════════════════════
 */
export function readBudgetAxes(input: CheckBudgetsInput): BudgetAxisReading[] {
  const { usage, budgets, consecutiveFailures, now } = input;
  return [
    { axis: "turns", used: usage.turns, limit: budgets.maxTurns, unit: "count" },
    {
      axis: "activeWallClockMs",
      used: usage.activeWallClockMs,
      limit: budgets.maxActiveWallClockMs,
      unit: "ms",
    },
    {
      axis: "totalWallClockMs",
      used: now - usage.startedAt,
      limit: budgets.maxTotalWallClockMs,
      unit: "ms",
    },
    { axis: "modelCalls", used: usage.modelCalls, limit: budgets.maxModelCalls, unit: "count" },
    { axis: "toolCalls", used: usage.toolCalls, limit: budgets.maxToolCalls, unit: "count" },
    // 【定】轴名、读数、限额名**三者同名**（本批统一）。此前轴叫 inputTokens、
    // 读的却是 billed、限额叫 maxInputTokens —— 靠一行注释维持，而注释拦不住
    // 下一个照字面配置的人（缓存命中时两者差 5 倍以上）。
    {
      axis: "billedInputTokens",
      used: usage.billedInputTokens,
      limit: budgets.maxBilledInputTokens,
      unit: "token",
    },
    {
      axis: "outputTokens",
      used: usage.outputTokens,
      limit: budgets.maxOutputTokens,
      unit: "token",
    },
    {
      axis: "consecutiveFailures",
      used: consecutiveFailures,
      limit: budgets.maxConsecutiveFailures,
      unit: "count",
    },
  ];
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
