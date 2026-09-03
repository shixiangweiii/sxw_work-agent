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
  inlineToolResultsPerBatchLimitTokens: 12_000,
};

/**
 * ── R-1 只修了一半，补齐的那一半也值得记 ──────────────────────────────────
 *
 * R-1 当初的症状是部分预算轴有声明、无读取点。读取点后来统一接入
 * `checkBudgets`；两条 token 轴也已有生产默认值。`maxTotalWallClockMs`
 * 仍刻意不设默认值，因为它跨关机累计，隔夜 resume 不应立刻撞墙。
 *
 * 代价是实测的：2026-08-28 办公任务实跑的题 1 单次 run 烧掉 420,784 billed input token
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
  /**
   * 这条轴的限额写在 `RunBudgets` 的哪个字段上。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】它必须住在**这张表里**，不许在别处另建一份 axis → field 的映射。
   *
   * 起因是「预算轴做成真参数」那一批：CLI 的 `--max-turns`、
   * `POST /api/runs` 的请求体、界面的输入框，三处都要按 axis id 索引，
   * 然后写回 `RunBudgets` 的字段。最自然的写法是在 compose 里补一张
   * `Record<BudgetAxis, keyof RunBudgets>` —— 而那就是**第二份**。
   *
   * 第二份的后果本仓记过不止一次（`artifactKindOf` / 边界表 / Composition
   * Root）：两处对同一件事给出不同答案，而**两边都是绿的**。
   * 这里尤其毒：轴名与字段名只差一个 `max` 前缀，抄错一条要等到
   * 「我明明调大了这条轴，它还是在原来的数字上撞墙」才会被发现。
   *
   * 上面 line 202 那条【定】已经拍板「轴名、读数、限额名三者同名」——
   * 这一列只是把那句话变成机器读得懂的形态。
   * ══════════════════════════════════════════════════════════════════════
   */
  field: keyof RunBudgets;
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
 * （办公任务实跑 14/14 个 run 因此打出 1482% 假漂移）。
 *
 * 【定】所以提出来的是**读数**，不是判定：`checkBudgets` 仍然是唯一的判官，
 * Layer 2 拿到的是它用的同一张表。§5.2「合法状态迁移不由 UI 拥有」不因此松动。
 * ══════════════════════════════════════════════════════════════════════
 */
export function readBudgetAxes(input: CheckBudgetsInput): BudgetAxisReading[] {
  const { usage, budgets, consecutiveFailures, now } = input;
  return [
    { axis: "turns", field: "maxTurns", used: usage.turns, limit: budgets.maxTurns, unit: "count" },
    {
      axis: "activeWallClockMs",
      field: "maxActiveWallClockMs",
      used: usage.activeWallClockMs,
      limit: budgets.maxActiveWallClockMs,
      unit: "ms",
    },
    {
      axis: "totalWallClockMs",
      field: "maxTotalWallClockMs",
      used: now - usage.startedAt,
      limit: budgets.maxTotalWallClockMs,
      unit: "ms",
    },
    {
      axis: "modelCalls",
      field: "maxModelCalls",
      used: usage.modelCalls,
      limit: budgets.maxModelCalls,
      unit: "count",
    },
    {
      axis: "toolCalls",
      field: "maxToolCalls",
      used: usage.toolCalls,
      limit: budgets.maxToolCalls,
      unit: "count",
    },
    // 【定】轴名、读数、限额名**三者同名**（本批统一）。此前轴叫 inputTokens、
    // 读的却是 billed、限额叫 maxInputTokens —— 靠一行注释维持，而注释拦不住
    // 下一个照字面配置的人（缓存命中时两者差 5 倍以上）。
    {
      axis: "billedInputTokens",
      field: "maxBilledInputTokens",
      used: usage.billedInputTokens,
      limit: budgets.maxBilledInputTokens,
      unit: "token",
    },
    {
      axis: "outputTokens",
      field: "maxOutputTokens",
      used: usage.outputTokens,
      limit: budgets.maxOutputTokens,
      unit: "token",
    },
    {
      axis: "consecutiveFailures",
      field: "maxConsecutiveFailures",
      used: consecutiveFailures,
      limit: budgets.maxConsecutiveFailures,
      unit: "count",
    },
  ];
}

// ═══════════════════════════════════════════════════ 调用方可以覆盖的限额

/**
 * 只要限额、不要读数 —— 服务端把「下一个 Run 的默认预算」发给界面时用它。
 *
 * 【定】它**由 `readBudgetAxes` 推出**，不另写一张表。
 * 界面上那几个输入框的默认值必须与真正会撞的墙来自同一处，否则会出现
 * 「表单说默认 20，实际在 30 撞墙」这种在绿灯下完全看不出来的不一致。
 *
 * 传零 usage 是安全的：调用方只取 `limit`，而 `used` 那一列在这里没有消费者。
 */
export function readBudgetLimits(
  budgets: RunBudgets,
): Array<Pick<BudgetAxisReading, "axis" | "field" | "limit" | "unit">> {
  const zero: BudgetUsage = {
    turns: 0,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    billedInputTokens: 0,
    activeWallClockMs: 0,
    startedAt: 0,
  };
  return readBudgetAxes({ usage: zero, budgets, consecutiveFailures: 0, now: 0 }).map(
    ({ axis, field, limit, unit }) => ({ axis, field, limit, unit }),
  );
}

/**
 * 按 **axis id** 覆盖预算限额。CLI 的 `--max-*`、`POST /api/runs` 的请求体、
 * 界面输入框三条入口最终都汇到这里。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】非法值 **fail-fast**，缺字段按默认读（ADR-0012 二次评审 P2-2 的口径）。
 *
 * 两者不是一回事，也不能互换：
 *   缺字段  = 「用户没说」→ 用默认值，那是一句真话；
 *   非法值  = 「用户说了一句听不懂的话」→ 必须报错。
 *
 * 静默回落是本仓反复猎杀的那个形态（M-5、`--yes`、带值参数缺值）：
 * **一个被静默吞掉的参数与一个生效的参数，在用户那里完全不可区分。**
 * 这里尤其要紧 —— 一个被吞掉的 `--max-turns 60` 的症状是
 * 「跑到 20 轮就停了」，而用户会去怀疑模型，不会去怀疑参数。
 *
 * 【定】未知 axis 也要抛，并把合法值列出来。落回默认的话，
 * 那一行配置**看起来生效了、实际什么都没变** —— 与 `mcp.json` 里
 * `tools` 段工具名拼错时 `tierOf()` 静默落默认档是同一条。
 * ══════════════════════════════════════════════════════════════════════
 */
export function applyBudgetOverrides(
  base: RunBudgets,
  overrides: Readonly<Record<string, unknown>>,
): RunBudgets {
  const legal = new Map(readBudgetLimits(base).map((a) => [String(a.axis), a]));
  const next: RunBudgets = { ...base };
  for (const [axis, raw] of Object.entries(overrides)) {
    const known = legal.get(axis);
    if (!known) {
      throw new Error(
        `不认识的预算轴 "${axis}"。可用：${[...legal.keys()].join(" ")}`,
      );
    }
    const value = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `预算轴 "${axis}" 需要一个大于 0 的有限数字，收到：${JSON.stringify(raw)}`,
      );
    }
    /**
     * 【定】计数轴取整，但**只接受整数**，不静默截断。
     *
     * `--max-turns 3.7` 落成 3 的话，用户看到的是「我要了 3.7 轮，它给了 3 轮」
     * 与「我要了 3 轮」不可区分。报错比替他做决定便宜。
     * 时间轴（ms）同理 —— 半毫秒没有意义。
     */
    if (!Number.isInteger(value)) {
      throw new Error(`预算轴 "${axis}" 必须是整数，收到：${JSON.stringify(raw)}`);
    }
    // 【定】走 Object.assign 而不是 `next[field] = value`：后者要把 RunBudgets
    // 断言成带索引签名的类型，而那个断言会顺带吃掉「字段名写错」的编译期保护 ——
    // 而 `field` 的唯一来源是 readBudgetAxes，正是那张要被保护的表。
    Object.assign(next, { [known.field]: value });
  }
  return next;
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
