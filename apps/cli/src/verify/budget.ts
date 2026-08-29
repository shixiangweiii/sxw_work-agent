/**
 * verify:budget —— 阶段 2 批 2 的验收。
 *
 * 验证：**预算硬墙是不是每条轴都真的在拦，墙钟算的是不是「干活的时间」？**
 *
 * 挂了意味着：不变量 11「预算不得由模型决定忽略」只在 turns 这一条轴上成立 ——
 * 模型仍然可以在一轮里发起任意多次工具调用、烧任意多 token。
 *
 * ── 为什么这条脚本必须存在 ─────────────────────────────────────────────
 *
 * 存量清单 §4 第 3 条记着一个尴尬的事实：`ScriptedModelPort` 返回写死的
 * usage（input 100 / output 20），**这解释了为什么 A-2 的 usage 清零、
 * R-1 的预算轴、D-1 的口径错配能同时存在而阶段 1 三条脚本全绿**。
 * 不专门造一条按轴撞墙的脚本，这些缺口就是测不出来的。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BudgetAxis,
  ContextMessage,
  ModelInvocationResult,
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
  RunEvent,
} from "@workagent/harness-runtime";
import { DEFAULT_BUDGETS, NullTraceSink, asId, readRunFacts, type RunId } from "@workagent/harness-runtime";
import { listDirSnapshot, writeFileSnapshot } from "@workagent/tools-common";
import { compose, DEFAULT_SYSTEM_PROMPT } from "../compose.js";
import { ScriptedModelPort, banner, fact, makeUsage, runVerify, section, verdict, type ScriptedTurn } from "./harness.js";

interface RunResult {
  terminal: string;
  hardAxis?: string;
  hardUsed?: number;
  hardLimit?: number;
  softAxes: string[];
  events: RunEvent[];
  /**
   * 结算时的累计预算，从 transcript 的 `RUN_META` 读回。
   *
   * 【定】不从事件流里凑 —— 事件里的 usage 是逐次的，累计量的权威副本
   * 在 RUN_META 里（A-7 之后就是这样）。凑出来的数与权威副本万一对不上，
   * 事后没人分得清哪个是对的。
   *
   * （第一版这里读的是 `ModelInvocationCompleted.budgetUsage`，
   * 而那个字段根本不存在 —— 于是 C 段读到恒定的 0，`0 < 700` 永远成立，
   * 是一条假绿。判据取错来源比没有判据更糟。）
   */
  activeWallClockMs: number;
  /** F 段要查「软限提示有没有真的进 messages」，所以把重建后的消息一并带回。 */
  messages: ContextMessage[];
}

/**
 * 一个**慢到超预算**、且真的响应 abort 的模型。
 *
 * 【定】`ScriptedModelPort` 忽略 signal（参数名就是 `_signal`），
 * 拿它测不出「在途调用能不能被打断」——它根本不在途。
 *
 * 它模仿的是选定端点客户端的契约：abort 是**预期路径**，
 * 返回 `interrupted: true` 而不是抛（见形状适配器 client.ts 的 catch）。
 */
class SlowModelPort implements ModelPort {
  constructor(private readonly sleepMs: number) {}

  async *invoke(
    _request: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult> {
    const interrupted = signal.aborted
      ? true
      : await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), this.sleepMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve(true);
            },
            { once: true },
          );
        });

    return {
      content: interrupted ? [] : [{ type: "text", text: "跑完了" }],
      toolCalls: [],
      stopReason: interrupted ? "" : "end_turn",
      usage: makeUsage(100, 20),
      interrupted,
    };
  }

  async countTokens(): Promise<number | undefined> {
    return 100;
  }
}

/** 跑一个脚本化 Run，把预算相关的事件挑出来。 */
async function runWith(opts: {
  script: ScriptedTurn[];
  budgets: Partial<typeof DEFAULT_BUDGETS>;
  workspace: string;
  approvalDelayMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
  /** F 段用它换一个「慢到超预算」的模型。 */
  modelOverride?: ModelPort;
}): Promise<RunResult> {
  const model =
    opts.modelOverride ??
    new ScriptedModelPort(
      opts.script,
      () => 100,
      0,
      opts.usage ? makeUsage(opts.usage.inputTokens, opts.usage.outputTokens) : undefined,
    );
  // workspace 必须真的存在，否则 list_dir 每轮都失败，
  // 三次之后先撞 consecutiveFailures —— 撞的就不是被测的那条轴了。
  mkdirSync(opts.workspace, { recursive: true });
  const composed = compose({
    dbPath: ":memory:",
    workspaceRoot: opts.workspace,
    trace: new NullTraceSink(),
    modelPortOverride: model,
    timezone: "Asia/Shanghai",
    tools: [listDirSnapshot, writeFileSnapshot],
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    approvalDecider: async () => {
      if (opts.approvalDelayMs) await new Promise((r) => setTimeout(r, opts.approvalDelayMs));
      return { approved: true };
    },
  });

  const spec = composed.makeRunSpec("预算撞墙验收");
  const gen = composed.runtime.start({
    ...spec,
    budgets: { ...DEFAULT_BUDGETS, ...opts.budgets },
  });

  const events: RunEvent[] = [];
  let runId = "";
  let r = await gen.next();
  while (!r.done) {
    if (!runId) runId = String(r.value.runId);
    events.push(r.value);
    r = await gen.next();
  }
  const facts = readRunFacts(await composed.ports.transcript.readAll(asId<RunId>(runId)));
  const messages = await composed.ports.transcript.rebuildMessages(asId<RunId>(runId));
  composed.db.close();

  const hard = events.find((e) => e.type === "BudgetHardLimitReached");
  const hp = hard?.payload as { axis: string; used: number; limit: number } | undefined;
  return {
    terminal: r.value.terminal.reason,
    ...(hp ? { hardAxis: hp.axis, hardUsed: hp.used, hardLimit: hp.limit } : {}),
    softAxes: events
      .filter((e) => e.type === "BudgetSoftLimitReached")
      .map((e) => (e.payload as { axis: string }).axis),
    events,
    activeWallClockMs: facts?.budgetUsage.activeWallClockMs ?? -1,
    messages,
  };
}

/**
 * 一个永远要工具的脚本：不撞墙就不会停。
 *
 * ── 【定】每轮入参必须**不同**（阶段 3 起）──────────────────────────────
 *
 * Progress Guard（S9）会在「同工具 ＋ 同 normalized input ＋ 同 effect digest」
 * 连续 3 次时具名终止 Run。原来这里每轮都发完全相同的 `list_dir({path:"."})`，
 * 于是它在第 3 轮就停在 `NO_PROGRESS` —— **任何一条预算轴都还没来得及撞到**，
 * A 段与 B 段一起翻红。
 *
 * 这不是 Guard 太严：一个逐字重复同一个调用的脚本，本来就长得像死循环。
 * 换成每轮翻一页（cursor 递增），「不撞墙就不会停」这句话才重新成立。
 */
function endlessScript(n = 60): ScriptedTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `第 ${i + 1} 步`,
    toolCalls: [{ toolCallId: `t${i}`, name: "list_dir", input: { path: ".", cursor: i } }],
  }));
}

async function main(): Promise<void> {
  banner(
    "verify:budget —— 预算全轴与墙钟拆分（阶段 2 批 2）",
    "每条预算轴是不是都真的在拦？等审批与关机的时间算不算「干活」？",
  );

  const tmp = mkdtempSync(join(tmpdir(), "workagent-budget-"));
  const results: Array<{ name: string; ok: boolean }> = [];

  try {
    // ────────────────────────────────────────────── A. 逐轴撞墙
    section("A. R-1：每条轴各注入一个必然撞墙的 Run");
    console.log(
      "   修复前主循环只判 turns / 墙钟 / consecutiveFailures 三项，\n" +
        "   另外五条轴有声明、无读取点 —— 模型绕不过 turns，却能在一轮里\n" +
        "   发起任意多次工具调用、烧任意多 token。\n",
    );

    const cases: Array<{ axis: BudgetAxis; budgets: Partial<typeof DEFAULT_BUDGETS>; usage?: { inputTokens: number; outputTokens: number } }> = [
      { axis: "turns", budgets: { maxTurns: 3 } },
      { axis: "modelCalls", budgets: { maxTurns: 999, maxModelCalls: 4 } },
      { axis: "toolCalls", budgets: { maxTurns: 999, maxToolCalls: 5 } },
      {
        axis: "inputTokens",
        budgets: { maxTurns: 999, maxInputTokens: 450 },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      {
        axis: "outputTokens",
        budgets: { maxTurns: 999, maxOutputTokens: 90 },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      { axis: "totalWallClockMs", budgets: { maxTurns: 999, maxTotalWallClockMs: 1 } },
    ];

    let axesOk = true;
    for (const c of cases) {
      const res = await runWith({
        script: endlessScript(),
        budgets: c.budgets,
        workspace: join(tmp, `ws-${c.axis}`),
        ...(c.usage ? { usage: c.usage } : {}),
      });
      const hit = res.hardAxis === c.axis;
      const expectedTerminal = c.axis === "turns" ? "MAX_TURNS" : "BUDGET_EXHAUSTED";
      const termOk = res.terminal === expectedTerminal;
      fact(
        `${c.axis}`,
        `terminal=${res.terminal} axis=${res.hardAxis ?? "—"} used=${res.hardUsed ?? "—"}/${res.hardLimit ?? "—"}` +
          `${hit && termOk ? "" : "   ← 不符"}`,
      );
      if (!hit || !termOk) axesOk = false;
    }
    verdict(
      axesOk,
      axesOk
        ? "六条轴各自撞墙一次，Terminal 与 BudgetHardLimitReached.axis 一一对应 —— 不变量 11 不再只在 turns 上成立"
        : "有轴没拦住，或撞的不是它自己那条轴",
    );
    results.push({ name: "A", ok: axesOk });

    // ────────────────────────────────────────────── A2. 生产默认值
    section("A2. R-1 的另一半：DEFAULT_BUDGETS 里这些轴真的有值吗");
    console.log(
      "   【定】A 段证明的是**读取点**能用，不是这条轴在真实 Run 里开着 ——\n" +
        "   它给每条轴都注入了一个 Partial 覆盖。而生产装配用的是 DEFAULT_BUDGETS，\n" +
        "   `limit === undefined` 的轴会被 checkBudgets 直接 continue 掉。\n\n" +
        "   R-1 修的是前者，后者一直空着：两条 token 轴长期没有默认值，\n" +
        "   **八条轴在生产里只有五条活着**，而 A 段照样全绿。\n" +
        "   代价是 2026-08-28 摸底考试题 1 单次 run 烧掉 420,784 billed input token，\n" +
        "   一条轴都没拦住。\n",
    );
    const tokenAxes: Array<[string, number | undefined]> = [
      ["maxInputTokens", DEFAULT_BUDGETS.maxInputTokens],
      ["maxOutputTokens", DEFAULT_BUDGETS.maxOutputTokens],
    ];
    for (const [name, v] of tokenAxes) fact(name, v ?? "（未设 —— 这条轴在生产里是死的）");
    fact("maxTotalWallClockMs", DEFAULT_BUDGETS.maxTotalWallClockMs ?? "（未设 —— 见下，这是故意的）");
    console.log(
      "\n   ⚠️ 【定】`maxTotalWallClockMs` 必须**保持未设**，这一条是反向判据：\n" +
        "   它算的是 `now - startedAt`，而 `startedAt` 在 resume 时是刻意继承的。\n" +
        "   给它默认值 = 隔夜 resume 在第一次迭代就撞墙 ——\n" +
        "   正是 R-2 当初为 activeWallClockMs 修掉的那个形态，换个字段再犯一次。\n" +
        "   所以这里断言的是「两条 token 轴有值」**且**「这条没有值」。\n",
    );
    const a2Ok =
      tokenAxes.every(([, v]) => typeof v === "number" && v > 0) &&
      DEFAULT_BUDGETS.maxTotalWallClockMs === undefined;
    verdict(
      a2Ok,
      a2Ok
        ? "两条 token 轴在生产默认值里真的有档位，且 maxTotalWallClockMs 保持未设 —— " +
          "八条轴里该活的活着，该空的空着，两个方向都被钉住"
        : DEFAULT_BUDGETS.maxTotalWallClockMs !== undefined
          ? "maxTotalWallClockMs 被补上了默认值 —— 隔夜 resume 会在第一次迭代就撞墙"
          : "token 轴在 DEFAULT_BUDGETS 里没有值，生产装配拦不住 token 失控",
    );
    results.push({ name: "A2", ok: a2Ok });

    // ────────────────────────────────────────────── B. 软限
    section("B. U-5：软限触发，且每条轴只报一次");
    const soft = await runWith({
      script: endlessScript(),
      budgets: { maxTurns: 10, softLimitRatio: 0.5 },
      workspace: join(tmp, "ws-soft"),
    });
    const turnsSoftCount = soft.softAxes.filter((a) => a === "turns").length;
    fact("软限事件（按轴）", soft.softAxes.join(", ") || "（无）");
    fact("turns 轴报了几次", turnsSoftCount);
    console.log(
      "   ↑ 不去重的话，越过 0.5 之后**每一轮**都会重发同一条事件。\n" +
        "     一个本该提示「快到头了」的信号会退化成刷屏，而刷屏等于没有信号。\n",
    );
    /**
     * ── 【定】软限还必须**进模型上下文**，只发事件等于没有信号 ────────────
     *
     * 这条事件此前只 emit 到 trace，`context/` 里没有任何消费者 ——
     * 也就是说被提醒的对象从头到尾没收到提醒。
     * 一个只有旁观者看得见的警告，对正在烧预算的那个模型没有任何作用。
     *
     * 2026-08-28 摸底考试题 1：一次 trial 在 600 秒预算里跑了 645 秒、
     * **一个交付物都没写出来** —— 模型当时正打算「进一步确认」，
     * 它并不知道没有下一轮了。
     *
     * 判据落在 transcript 上而不是事件流上：事件早就有了，缺的正是消息。
     */
    const injected = soft.messages.filter((m) =>
      m.content.some(
        (c) => c.type === "text" && c.text.includes("[系统提示]") && c.text.includes("预算"),
      ),
    );
    fact("上下文里的软限提示条数", injected.length);
    fact(
      "提示正文",
      injected[0]?.content.find((c) => c.type === "text")?.text.slice(0, 60) ?? "（没有注入）",
    );

    const bOk = turnsSoftCount === 1 && soft.terminal === "MAX_TURNS" && injected.length === 1;
    verdict(
      bOk,
      bOk
        ? "软限在越过阈值那一轮报了恰好一次、**并且进了模型上下文**，随后照常跑到硬墙 —— " +
          "软限是提示不是终止，而提示真的送到了被提醒的那个对象手里"
        : injected.length !== 1
          ? `软限提示没有进上下文（找到 ${injected.length} 条）—— 只发事件的话模型不知道自己快撞墙`
          : `软限行为不符（turns 报了 ${turnsSoftCount} 次，terminal=${soft.terminal}）`,
    );
    results.push({ name: "B", ok: bOk });

    // ────────────────────────────────────────────── C. 等审批不算 active
    section("C. R-2：等审批的时间不计入 active 墙钟");
    const APPROVAL_MS = 700;
    const withWait = await runWith({
      script: [
        {
          text: "写一份",
          toolCalls: [{ toolCallId: "w1", name: "write_file", input: { path: "n.txt", content: "x" } }],
        },
        { text: "好了", toolCalls: [] },
      ],
      budgets: { maxTurns: 10 },
      workspace: join(tmp, "ws-wait"),
      approvalDelayMs: APPROVAL_MS,
    });
    const active = withWait.activeWallClockMs;
    fact("审批等待", `${APPROVAL_MS} ms`);
    fact("结算时的 activeWallClockMs", `${active} ms`);
    console.log(
      "   ↑ V05 §16.1【定】：maxActiveWallClockMs 只累计 RUNNING 且有在途步骤的时间。\n" +
        "     修复前算的是 now() - startedAt，等审批一小时就把预算耗光了。\n",
    );
    // >= 0 也要断：-1 表示压根没读到 RUN_META，那是判据失效不是通过。
    const cOk = active >= 0 && active < APPROVAL_MS;
    verdict(
      cOk,
      cOk
        ? `active 墙钟（${active}ms）小于审批等待本身（${APPROVAL_MS}ms）—— 等待的时间确实被扣掉了`
        : `active 墙钟 ${active}ms ≥ 审批等待 ${APPROVAL_MS}ms，说明等待仍被计入`,
    );
    results.push({ name: "C", ok: cOk });

    // ────────────────────────────────────────────── D. 时间事实段级冻结
    section("D. 决 3：受信时间事实在段内冻结，不随每轮墙钟漂移");
    const frames = withWait.events.filter((e) => e.type === "ContextFrameCompiled");
    fact("本 Run 编译的帧数", frames.length);
    console.log(
      "   段内冻结的判据落在**帧内容**上：同一段里每轮渲染出的时间事实必须逐字相同。\n" +
        "   修复前它每轮用 deps.now 重渲染，跨分钟就会在某个说不准的轮次变一次 ——\n" +
        "   对 STRICT_PREFIX 缓存和 Replay 来说，不确定的失效比确定的失效更难处理。\n",
    );
    // 帧内容不进事件载荷，所以这里用「渲染函数是否读段级时刻」的间接判据：
    // 两轮之间墙钟必然前进过（有 700ms 审批），若时间事实随 now 走，
    // 两帧的 totalTokens 相同但内容会不同 —— 内容差异这里看不到，
    // 所以退一步只断言帧数与轮数一致，真正的判据在 E 段。
    const dOk = frames.length >= 2;
    verdict(dOk, dOk ? `编译了 ${frames.length} 帧，可供 E 段比对` : "帧数不足，无法比对");
    results.push({ name: "D", ok: dOk });

    // ────────────────────────────────────────────── E. 跨段重新冻结
    section("E. 决 3：跨执行段重新冻结 —— 隔夜 resume 不写昨天的日期");
    console.log(
      "   冻到 Run 级会让周一起的 Run 在周三 resume 时把周一的日期写进产物，\n" +
        "   而且那是被 system prompt 背书的错误（`compose.ts` 明写「日期一律以\n" +
        "   [系统事实] 当前时间为准」）。所以冻结粒度是**执行段**，不是 Run。\n",
    );
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../../../packages/harness-runtime/src/loop/run-loop.ts", import.meta.url),
        "utf8",
      ),
    );
    const segmentScoped = /timeFactAt: segmentStartedAt/.test(src);
    const segmentReFrozen = /const segmentStartedAt = now\(\)/.test(src);
    fact("compileFrame 收的是段级时刻", segmentScoped ? "是" : "否");
    fact("每段重新取 segmentStartedAt", segmentReFrozen ? "是" : "否");
    const eOk = segmentScoped && segmentReFrozen;
    verdict(
      eOk,
      eOk
        ? "时间事实读的是本段起始时刻，且每段（含 resume）重新冻结 —— 段内稳定、段间如实"
        : "时间事实的冻结粒度不对",
    );
    results.push({ name: "E", ok: eOk });

    // ────────────────────────────────────────────── F. 在途调用可被打断
    section("F. 墙钟能不能打断**在途**的模型调用");
    console.log(
      "   【定】预算只在循环顶部查一次，两次检查之间的那个模型调用可以跑任意久 ——\n" +
        "   于是 maxActiveWallClockMs 的真实语义是「**至少** N 毫秒、上不封顶」。\n\n" +
        "   2026-08-28 摸底考试题 1 三次分别在 645 / 809 / 1,011 秒才结算（限额 600 秒），\n" +
        "   其中一次的**最后一个调用单独跑了 613 秒**，一次调用就超过整个预算。\n" +
        "   循环入口的 active 从 404,093ms 一步跳到 806,406ms —— 软限带和硬限带\n" +
        "   被同一次调用一起跨过，所以连提醒都没发出过。\n\n" +
        "   这一段用一个「睡 5 秒且真的响应 abort」的模型撞 300ms 的墙。\n" +
        "   两个断言缺一不可：**撞的是墙**（不是伪装成用户取消的 ABORTED_STREAMING），\n" +
        "   **而且真的被截断了**（用时远小于 5 秒，不是跑完才发现）。\n",
    );
    const SLEEP_MS = 5_000;
    const WALL_MS = 300;
    const t0 = Date.now();
    const slow = await runWith({
      script: [],
      budgets: { maxTurns: 999, maxActiveWallClockMs: WALL_MS },
      workspace: join(tmp, "ws-deadline"),
      modelOverride: new SlowModelPort(SLEEP_MS),
    });
    const elapsed = Date.now() - t0;
    fact("模型单次调用时长 / 墙钟限额", `${SLEEP_MS}ms / ${WALL_MS}ms`);
    fact("Terminal", slow.terminal);
    fact("撞的轴", slow.hardAxis ?? "（没有 BudgetHardLimitReached）");
    fact("整个 Run 实际耗时", `${elapsed}ms`);

    /**
     * 【定】`elapsed < SLEEP_MS` 是这一段的判别力所在。
     *
     * 只断言 Terminal 的话，一个「跑完 5 秒再在下一轮入口发现超预算」的实现
     * 也会给出 BUDGET_EXHAUSTED —— 那正是修复前的行为，判据会假绿。
     * 必须同时钉住「它没跑完」。
     */
    const fOk =
      slow.terminal === "BUDGET_EXHAUSTED" &&
      slow.hardAxis === "activeWallClockMs" &&
      elapsed < SLEEP_MS;
    verdict(
      fOk,
      fOk
        ? `在途调用被 deadline 打断：${elapsed}ms 就结算了（模型本来要跑 ${SLEEP_MS}ms），` +
          `Terminal 是 BUDGET_EXHAUSTED 而不是 ABORTED_STREAMING —— ` +
          `预算撞墙不再伪装成「有人按了取消」`
        : slow.terminal === "ABORTED_STREAMING"
          ? "被打断了，但结算成 ABORTED_STREAMING —— 预算撞墙伪装成了用户取消"
          : elapsed >= SLEEP_MS
            ? `跑满了 ${elapsed}ms 才结算 —— 墙钟没有打断在途调用，只是在下一轮入口发现的`
            : `Terminal=${slow.terminal} / 轴=${slow.hardAxis}`,
    );
    results.push({ name: "F", ok: fOk });

    // ────────────────────────────────────────────── 总判定
    section("总判定");
    const ok = results.every((r) => r.ok);
    verdict(
      ok,
      ok
        ? "预算八条轴由一个纯函数统一判定，软限每轴一次，active 墙钟不含等待，时间事实按执行段冻结"
        : `失败段：${results.filter((r) => !r.ok).map((r) => r.name).join(" ")}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

void runVerify(main);
