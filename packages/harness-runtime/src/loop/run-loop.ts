/**
 * 主循环（V05 §8.2）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 循环纪律五条，读这个文件时请对照：
 *
 * 1. 每个 continue 站点必须构造完整的 LoopState —— 由 nextState() 强制；
 * 2. 每个 continue 必须带具名 transition.reason；每个 return 必须是具名 Terminal；
 * 3. 消息先落盘再进 messages 数组 —— 由 appendAndPush() 强制；
 * 4. 流式 delta、进度、心跳不进 LoopState，直接 yield；
 * 5. 循环不读取端点能力声明。
 *
 * 第 5 条是原则十四在执行层的落点。本文件不得出现 profile.protocol.*、
 * profile.context.* 这类读取 —— 端点差异必须在形状适配器与 Context 层消化完毕。
 * 判据：grep -n "profile\." 本文件应无结果。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { RunEvent } from "../types/event.js";
import type { Continue, LoopState, Terminal } from "../types/loop.js";
import { nextState } from "../types/loop.js";
import type { RunSpec } from "../types/run.js";
import type { ContextMessage, TranscriptEntry } from "../types/transcript.js";
import { TRANSCRIPT_SCHEMA_VERSION } from "../types/transcript.js";
import type { ModelContent } from "../types/context.js";
import type { RunId } from "../types/ids.js";
import type { RuntimePorts } from "../ports/index.js";
import { compileFrame } from "../context/compile.js";
import { executeBatch, type BatchOutcome } from "../action/settle-batch.js";
import { settleOutcome, settleWallOutcome } from "../verification/settle-outcome.js";
import { ToolRegistry } from "../tool-runtime/index.js";
import type { ApprovalDecider, VerificationResult } from "../types/tool.js";
import type { ArtifactCheckFact, RecoveryItem, ResumableRunFacts } from "../types/run.js";
import { makeActionFactEntry, makeRunFactsEntry } from "../transcript/index.js";
import { checkBudgets, hardLimitIsTurns } from "../budget/index.js";
import { DriftDetector, EndpointDriftError } from "../model/capability/drift-detector.js";
import { RunInterrupts } from "./interrupt/index.js";
import { ProgressGuard } from "./progress-guard.js";
import { makeError } from "../types/error.js";

export interface RunLoopDeps {
  runId: RunId;
  spec: RunSpec;
  ports: RuntimePorts;
  interrupts: RunInterrupts;
  approvalDecider: ApprovalDecider;
  workspaceRoot: string;
  /** resume() 时传入已重建的 messages；start() 时为空。 */
  initialMessages?: ContextMessage[];
  /**
   * resume() 时传入上次跑到哪了（V05 §18.4【定】保留预算使用）。
   * 【定】不传就是从零开始 —— 那正是「反复 crash + resume 绕过预算」的成因，
   * 所以 resume 路径必须传，由 facade 从 transcript 的 RUN_META 读回。
   */
  resumeFrom?: ResumableRunFacts | undefined;
}

export interface RunLoopResult {
  terminal: Terminal;
  outcome: ReturnType<typeof settleOutcome>;
}

export async function* runLoop(
  deps: RunLoopDeps,
): AsyncGenerator<RunEvent, RunLoopResult> {
  const { ports, spec, runId, interrupts } = deps;
  const registry = new ToolRegistry(spec.agentSpec.toolSnapshots);
  const now = (): number => ports.clock.now();

  /**
   * D-2：事件号一律向 transcript store 要，不再维护本地计数器。
   *
   * 本地计数器的问题不是「会不会重号」，是 resume 之后它从 0 重计 ——
   * 于是第二段的事件 1..n 与第一段的事件 1..m 在 Trace 里无法定序。
   * 取号点收敛到 store 之后，两段自然接得上（见 ports 里 nextSequence 的说明）。
   *
   * 【定】lastSequence 要跟着更新 —— persistFacts() 靠它落高水位。
   */
  let lastSequence = deps.resumeFrom?.lastSequence ?? 0;
  const emit = async <T extends RunEvent["type"]>(
    type: T,
    payload: Extract<RunEvent, { type: T }>["payload"],
  ): Promise<RunEvent> => {
    lastSequence = await ports.transcript.nextSequence(runId, lastSequence);
    const e = { runId, sequence: lastSequence, occurredAt: now(), type, payload } as RunEvent;
    ports.trace.emit(e);
    return e;
  };

  /**
   * 循环纪律第 3 条的强制点。
   * 先 await 落盘，再更新内存数组 —— 崩溃后 transcript 只可能与内存一致或领先。
   */
  const appendAndPush = async (
    messages: ContextMessage[],
    message: ContextMessage,
  ): Promise<ContextMessage[]> => {
    const entry: Omit<TranscriptEntry, "sequence"> = {
      runId,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      kind: "MESSAGE",
      message,
      createdAt: now(),
    };
    // append 内部也从同一个分配器取号（D-2），把它记回来，
    // lastSequence 才不只是「最后一个事件号」。
    //
    // 注意它是**下界而非精确高水位**：persistFacts() 自己那次 append 就没有回写
    // （回写也没用，facts 的内容在 append 之前就得定下来，构不成自指）。
    // 这不影响正确性 —— resume 侧取 `max(transcript 末尾号, facts.lastSequence)`，
    // 前者恰好覆盖了这里漏掉的那一个。
    lastSequence = await ports.transcript.append(entry);
    return [...messages, message];
  };

  // ── 累积的事实。它们不进 LoopState（D-20：大对象外置），
  //    但 outcome 结算要用，所以随循环持有。
  // 【定】resume 时必须从上次的事实接着累计，不能从空数组重新开始 ——
  //    否则上一段跑出来的 Verification 与未销账的 RecoveryItem 全部蒸发。
  const verifications: VerificationResult[] = [...(deps.resumeFrom?.verifications ?? [])];
  const recoveryItems: RecoveryItem[] = [...(deps.resumeFrom?.recoveryItems ?? [])];
  // 阶段 3 S8：第二层 Verification 的事实。与 verifications 分开累计，
  // 理由见 ResumableRunFacts.artifactChecks 的注释（结算映射按 role 分流）。
  const artifactChecks: ArtifactCheckFact[] = [...(deps.resumeFrom?.artifactChecks ?? [])];

  /**
   * 模型最后说的那段话，用来填 `RunOutcome.summary`（存量清单 R-7）。
   *
   * 在此之前 `SettleInput.summary` 字段在、三个调用点一个都没传，于是模型那段
   * 「我做了什么」或「我做不了，原因如下」既不进 outcome，CLI 也就打不出来 ——
   * 用户看到的只有一个孤零零的 `SUCCESS`。2026-08-24 的实跑里模型正确地
   * 拒绝了一个无工具可用的任务，终端照样打 `COMPLETED / SUCCESS`。
   *
   * 【定】这里只补 summary，**不动 `outcome.kind` 的值域**。
   * 「模型明确声明做不了」该不该有独立的 kind，是 R-7 与 U-8 的合并设计题
   * （`outcome.kind` 要不要区分「是谁没做成」），拍板前不得在代码里固化任一候选。
   * 但即便 kind 判不准，人也应该能从 outcome 里读到究竟发生了什么 —— 这就是这一行的价值。
   */
  let lastAssistantText: string | undefined;

  /**
   * ── R-2：墙钟拆分 ────────────────────────────────────────────────────
   *
   * V05 §16.1【定】`maxActiveWallClockMs` 只累计「RUNNING 且有在途步骤」的
   * 时间，`WAITING_*` 不累计 —— 等审批一小时不该把预算耗光。
   *
   * 阶段 1 用 `now() - startedAt` 顶替，在单进程、无人值守的验收脚本里
   * 看不出差别。跨进程之后它 100% 出问题：`startedAt` 由 RUN_META 原样继承，
   * 于是「今晚关机、明早 resume」的那一整夜全被算成 active，
   * 默认 10 分钟的墙一撞就穿。
   *
   * 算法：active = 上一段继承来的累计值 ＋ 本段已跑的时间 − 本段等待的时间。
   *   · 段边界天然把关机时间排除在外（新段的 segmentStartedAt 是 now()）；
   *   · 段内的等待由 Approval 事件对夹出来。
   */
  const segmentStartedAt = now();
  const inheritedActiveMs = deps.resumeFrom?.budgetUsage.activeWallClockMs ?? 0;
  let waitedMs = 0;
  let waitingSince: number | undefined;

  const activeNow = (): number =>
    inheritedActiveMs + (now() - segmentStartedAt) - waitedMs - (waitingSince ? now() - waitingSince : 0);

  /** U-5：软限每条轴只报一次，见下面消费点的说明。 */
  const softLimitAnnounced = new Set<string>();

  /**
   * ── U-1：漂移检测接线 ────────────────────────────────────────────────
   *
   * 在此之前 `DriftDetector` 只被 export、从未实例化，`EndpointBehaviorDrift`
   * 事件从未发出 —— §8.6 不变量 4「实际行为与声明不符时不得静默继续」
   * 在运行时**没有任何载体**。
   *
   * 它是 §24.6「端点能力回归 ＋ DeepSeek 对照」的前置：对照测试的全部意义
   * 建立在能观测到漂移上，不接线的话对照跑了也读不出东西。
   *
   * 【定】主循环持有它，但**不读 profile** —— 它读的是 detector 返回的
   * observation，端点声明的比对发生在 detector 内部。循环纪律第 5 条
   * （本文件不得出现 `profile.`）因此仍然成立。
   */
  const drift = new DriftDetector(ports.protocol.profile);

  /**
   * ── U-3：Progress Guard（阶段 3 S9）────────────────────────────────────
   *
   * 【定】它是「新增事件消费点」，属于不得绕过 #11 里**允许动**的那一类：
   * 循环纪律五条一条没变 —— 它的终止仍然走 `finish()` 的具名 Terminal，
   * 它不读端点声明，它不把进展塞进 LoopState。
   *
   * 【定】它只回答**一个**问题：在原地打转吗（同工具同输入同 digest 连续 N 次）。
   * §16.2 的另一半「还活着吗」本阶段不做 —— `ToolProgress` 是批结算时才被
   * 排空的，时间戳不是进展发生的时刻，拿它判存活会得到自信的错误答案。
   * 阶段 3 收口批把那半边（一个只写不读的 `lastProgressAt`）删掉了，
   * 理由与替代方案见 progress-guard.ts 的文件头。
   */
  const progress = new ProgressGuard();
  /**
   * 每个字段只报一次。
   *
   * 与 U-5 的软限同一条理由：一个持续存在的偏差会**每轮**重发同一条事件，
   * 而刷屏的信号等于没有信号。FAIL_FAST 那一档不受影响 —— 它只会发生一次。
   */
  const driftAnnounced = new Set<string>();

  let state: LoopState = {
    messages: deps.initialMessages ?? [],
    turnCount: deps.resumeFrom?.turnCount ?? 0,
    consecutiveFailures: deps.resumeFrom?.consecutiveFailures ?? 0,
    compactTracking: undefined,
    // 【定】V05 §18.4：resume 保留预算使用。startedAt 也必须继承 ——
    // 重置它等于把墙钟清零，一次 crash + resume 就能白拿一整个预算周期。
    budgetUsage: deps.resumeFrom?.budgetUsage ?? {
      turns: 0,
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      billedInputTokens: 0,
      activeWallClockMs: 0,
      startedAt: now(),
    },
    maxOutputTokensOverride: undefined,
    modelErrorRetries: 0,
    outputLimitRecoveries: 0,
    transition: undefined,
  };

  /**
   * 把「无法从消息序列反推的累计量」落到 transcript 上。
   *
   * 【定】每个出口与每轮边界都要写一次。只留在内存里的话，进程一死就归零，
   * 反复 crash + resume 就能无限绕过 maxTurns 与墙钟（不变量 11 被架空）。
   *
   * 【定】调用顺序：**先把这一步的事件 emit 完，再调它**（D-2）。
   * 反过来的话，RUN_META 拿到号 N、随后的事件拿到 N＋1，而落盘的
   * facts.lastSequence 停在 N−1；下次 resume 从 max(N, N−1)＝N 续起，
   * 再发一个事件又是 N＋1 —— 与崩溃前那个撞号。事件不落 transcript，
   * 没有任何东西会替你发现这次重号。
   */
  const persistFacts = async (): Promise<void> => {
    const facts: ResumableRunFacts = {
      turnCount: state.turnCount,
      consecutiveFailures: state.consecutiveFailures,
      budgetUsage: state.budgetUsage,
      verifications,
      recoveryItems,
      artifactChecks,
      // D-2：事件不落 transcript，高水位只能显式存。见 ResumableRunFacts 的说明。
      lastSequence,
      /**
       * 【定】必须**原样带过来**，哪怕这一轮循环跟恢复分支毫无关系。
       *
       * `readRunFacts()` 读的是**最后一条** RUN_META。而这里每轮边界都写一条。
       * 漏掉这个字段的后果不是「这一条没有」，是**整个 Run 的分支计数被抹掉** ——
       * `resume()` 在 facade 里刚记下的三条分支命中，下一轮循环写 RUN_META 时
       * 就没了。阶段 2 的研究问题（有多少次 resume 落进最坏那条分支）
       * 因此在盘上根本无法回答，而 RUN_META 里明明「有这个字段」。
       *
       * 这与批 1 那个 `lastSequence` 是同一个形状的错误：**累计量落在一条会被
       * 整体覆盖的记录里，就必须每次都完整重写，漏一个字段等于删一个字段。**
       * 由二次评审的 P1-2 顺藤摸出来（当时以为只是「Eval 没有出口」）。
       */
      ...(deps.resumeFrom?.resumeBranchCounts
        ? { resumeBranchCounts: deps.resumeFrom.resumeBranchCounts }
        : {}),
    };
    await ports.transcript.append(makeRunFactsEntry(runId, facts, now()));
  };

  // 首次启动才写入任务消息；resume() 时它已经在 transcript 里。
  if (!deps.initialMessages) {
    yield await emit("RunStarted", {
      task: spec.input.task,
      endpointId: String(spec.agentSpec.model.endpointId),
      modelId: spec.agentSpec.model.modelId,
    });
    state = {
      ...state,
      messages: await appendAndPush(state.messages, {
        role: "user",
        turn: 0,
        content: [{ type: "text", text: spec.input.task }],
      }),
    };
  }

  /**
   * 【定】所有出口都经过这里 —— 事实落盘与 outcome 结算是同一个动作的两半。
   *
   * 它是 generator 而不是普通 async 函数，唯一原因是要 yield `LoopTerminated`（U-4）。
   * 调用点因此是 `return yield* finish(...)`，不是普通的 await 调用。
   *
   * ── 为什么非得发这条事件 ─────────────────────────────────────
   *
   * §19.2 说「Trace 里能直接读出走了哪条路径」。在此之前这句话对 continue 成立
   * （LoopContinued 带具名 reason），对**终止**不成立 —— 终止原因只存在于
   * generator 的返回值里，只有直接 await 这个 generator 的调用方看得到。
   * Trace sink 看不到，于是一份落盘的 trace 恰好缺最重要的那一行。
   *
   * 循环纪律第 2 条要求「每个 return 是具名 Terminal」；这条事件是那条纪律
   * 在可观测侧的落点，不是可选的装饰。
   */
  async function* finish(terminal: Terminal): AsyncGenerator<RunEvent, RunLoopResult> {
    const settleInput = { verifications, recoveryItems, artifactChecks, summary: lastAssistantText };
    const outcome =
      terminal.reason === "COMPLETED" || terminal.reason === "COMPLETED_WITH_LIMITS"
        ? settleOutcome(settleInput)
        : settleWallOutcome(wallKind(terminal), settleInput);

    // 【定】emit 在 persistFacts 之前 —— 见 persistFacts 的顺序说明（D-2）。
    yield await emit("LoopTerminated", { terminal, outcome });
    await persistFacts();
    return { terminal, outcome };
  }

  // ════════════════════════════════════════════════════════ while(true)

  while (true) {
    // ── ⓪ 排空 Interject 队列
    const pending = interrupts.interjections.drain();
    if (pending.length > 0) {
      for (const item of pending) {
        // 【定】插话不得创建 Grant、改变 Policy、批准 Action。
        // 它只是一条 USER_PROVIDED 的消息。
        state = {
          ...state,
          messages: await appendAndPush(state.messages, {
            role: "user",
            turn: state.turnCount,
            content: [{ type: "text", text: `[执行中插话] ${item.content}` }],
          }),
        };
        yield await emit("InterjectionAccepted", { content: item.content });
      }
    }

    if (interrupts.aborted) return yield* finish({ reason: "ABORTED_TOOLS" });

    /**
     * ── 预算判定。【定】不得由模型决定忽略（不变量 11）。
     *
     * R-1：判定收进 `checkBudgets()` 纯函数，八条轴一次全查。在此之前
     * 这里只比三个数，另外五条轴有声明、无读取点 —— 模型绕不过 turns，
     * 却可以在一轮里发起任意多次工具调用、烧任意多 token。
     *
     * R-2：`activeWallClockMs` 现在是**累计值**（见下面的 `activeNow()`），
     * 不再是 `now() - startedAt`。后者会把等审批的时间、以及跨进程 resume
     * 之间关机的那一整夜都算进来 —— 隔夜 resume 会在第一次迭代就撞墙。
     */
    const budgetState = { ...state.budgetUsage, activeWallClockMs: activeNow() };
    const verdict = checkBudgets({
      usage: budgetState,
      consecutiveFailures: state.consecutiveFailures,
      budgets: spec.budgets,
      now: now(),
    });

    if (verdict.kind === "HARD") {
      yield await emit("BudgetHardLimitReached", {
        axis: verdict.axis,
        used: verdict.used,
        limit: verdict.limit,
      });
      state = { ...state, budgetUsage: budgetState };
      return yield* finish(
        hardLimitIsTurns(verdict)
          ? { reason: "MAX_TURNS", turnCount: state.turnCount }
          : { reason: "BUDGET_EXHAUSTED" },
      );
    }
    if (verdict.kind === "SOFT" && !softLimitAnnounced.has(verdict.axis)) {
      /**
       * U-5：每条轴只报一次。
       *
       * 不去重的话，越过 0.8 之后**每一轮**都会重发同一条事件 ——
       * 一个本该提示「快到头了，收一收」的信号会退化成刷屏，
       * 而刷屏的信号等于没有信号。
       */
      softLimitAnnounced.add(verdict.axis);
      yield await emit("BudgetSoftLimitReached", {
        axis: verdict.axis,
        used: verdict.used,
        limit: verdict.limit,
        ratio: verdict.ratio,
      });
    }

    yield await emit("TurnStarted", { turn: state.turnCount + 1 });

    // ── ① 上下文治理
    const compiled = await compileFrame(state.messages, {
      protocol: ports.protocol,
      ids: ports.ids,
      policy: spec.agentSpec.contextPolicy,
      systemPrompt: spec.agentSpec.systemPrompt,
      timezone: spec.agentSpec.timezone,
      fixedOverheadTokens: registry.fixedOverheadTokens(),
      // 输出预算恢复的落点：抬高的上限必须真的进到这一次请求里，
      // 否则「抬高上限重试」就是拿同样的 max_tokens 再撞一次同一堵墙。
      reservedOutputTokensOverride: state.maxOutputTokensOverride,
      runId,
      now: now(),
      /**
       * 决 3：模型看到的「当前时间」冻结在本执行段的起始时刻。
       *
       * 跨进程 resume 时 segmentStartedAt 会重新取，所以隔夜恢复看到的是
       * 恢复当天 —— 冻到 Run 级会让产物写上启动那天的日期。
       */
      timeFactAt: segmentStartedAt,
    });

    if (compiled.compactionApplied.length > 0) {
      for (const rec of compiled.compactionApplied) {
        yield await emit("ContextCompacted", { freedTokens: rec.freedTokens, reason: rec.reason });
      }

      /**
       * R-6 的落地点：把压缩结果真的写进 transcript 与 state.messages。
       *
       * 修复前这两件事都没做 —— ContextCompacted 事件照发，但 state.messages
       * 原封不动，下一轮又从完整历史开始。事件流上看压缩生效了，实际没有。
       *
       * ── 顺序：先落 boundary ＋ kept，再改内存 ────────────────────
       *
       * 与循环纪律第 3 条同构。崩在中间时，transcript 只可能与内存一致或领先，
       * 反过来则会丢掉一段只存在于内存里的压缩结果。
       *
       * ── 为什么 kept 要重新 append 一遍 ──────────────────────────
       *
       * rebuildFromEntries 的语义是「boundary.compactSummary ＋ boundary 之后的
       * MESSAGE 条目」。kept 里的消息原本都在 boundary **之前**，不重新 append
       * 就会在重建时全部消失 —— resume 出来的上下文比压缩后的还要短。
       *
       * 重复写入是 append-only 日志的诚实代价，换来的是「重建结果 == 刚才真的
       * 发出去的东西」这条等式成立。Compact 只在超过 soft limit 时触发，
       * 压完就回到线下，不是每轮都付这个代价。
       */
      if (compiled.compactedMessages) {
        /**
         * 【定】只有**真的丢了消息**（compactSummary 存在）才写 boundary。
         *
         * boundary 的语义是「它之前的内容已被摘要取代」。没丢任何消息时
         * 没有东西被取代，写它是错的，而且要连带把 kept 重新 append 一遍 ——
         * 六轮的 Run 会滚出 58 条 transcript，全是重复。
         *
         * 那「只剥了推理块」这种情况怎么办？答案是**什么都不用做**：
         * transcript 保留完整原文（§18.5「boundary 之前的原文保留供 Trace 与
         * Replay 使用」本来就是这个意思），而剥离是一个纯粹的预算决定，
         * resume 之后 compileFrame 会按当时的阈值重新算一遍。
         * 把它记进 transcript 反而是把一次临时决定固化成了历史事实。
         */
        if (compiled.compactSummary && compiled.compactKept) {
          lastSequence = await ports.transcript.append({
            runId,
            schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
            kind: "COMPACT_BOUNDARY",
            compactSummary: compiled.compactSummary,
            createdAt: now(),
          });
          for (const m of compiled.compactKept) {
            lastSequence = await ports.transcript.append({
              runId,
              schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
              kind: "MESSAGE",
              message: m,
              createdAt: now(),
            });
          }
        }
        state = { ...state, messages: compiled.compactedMessages };
      }
    }

    if (compiled.status === "COMPACTION_INSUFFICIENT") {
      /**
       * D-05：超硬限一律不发（R-3）。
       *
       * 修复前这个分支只在「irreducible 也超限」时才走到，其余情况**照常发出** ——
       * 一个超长用户输入压不掉、帧仍然超硬限，却被当成正常帧发给 Provider。
       * 现在超硬限就是超硬限，`irreducibleExceedsHardLimit` 只决定
       * 「还能不能靠压缩救」，不决定发不发。
       *
       * `used` 直接用 irreducibleTokens：**不再叠加 fixedOverheadTokens**。
       * 那是 R-3 的第二层错误 —— computeIrreducible 内部已经按计数路径
       * 决定过要不要含工具开销了，外面再加一次就是同一笔算两遍。
       */
      yield await emit("BudgetHardLimitReached", {
        axis: "contextTokens",
        used: compiled.irreducibleTokens,
        limit: spec.agentSpec.contextPolicy.hardInputLimitTokens,
      });
      return yield* finish({ reason: "CONTEXT_EXHAUSTED" });
    }

    if (compiled.status === "PROTOCOL_INVALID" || !compiled.frame) {
      // 【定】协议校验失败不得发起模型调用（V05 §11.5 不变量 7）。
      const err = makeError({
        code: "CONTEXT_PROTOCOL_INVALID",
        source: "CONTEXT",
        category: "PROTOCOL",
        retryability: "NEVER",
        sideEffectState: "NO_EFFECT",
        safeMessage: `ContextFrame 未通过协议校验：${compiled.protocolError ?? "未知"}`,
      });
      yield await emit("RuntimeErrorOccurred", { error: err });
      return yield* finish({ reason: "MODEL_ERROR", error: err });
    }

    const frame = compiled.frame;
    yield await emit("ContextFrameCompiled", {
      items: frame.items.length,
      totalTokens: compiled.totalTokens,
      fixedOverheadTokens: compiled.fixedOverheadTokens,
      compacted: compiled.compactionApplied.length > 0,
      // 【定】不可信内容流入是**审计事实**，必须落在 Trace 上（见事件类型的注释）。
      // 这里只是把 compile 已经算好的摘要转述出去 —— 循环不做任何 trust 判定。
      trust: {
        hasExternalUntrusted: frame.trustSummary.hasExternalUntrusted,
        untrustedItems: frame.trustSummary.counts.EXTERNAL_UNTRUSTED,
      },
    });

    // ── ② 调模型
    const request = ports.protocol.buildRequest(frame);
    const startedAt = now();
    let invocation;
    try {
      const stream = ports.model.invoke(request, interrupts.signal);
      let r = await stream.next();
      while (!r.done) {
        const sev = r.value;
        // 循环纪律第 4 条：delta 直接 yield，不进 LoopState。
        if (sev.type === "text_delta") yield await emit("ModelStreamDelta", { text: sev.text });
        r = await stream.next();
      }
      invocation = r.value;
    } catch (err) {
      const e = ports.protocol.classifyError(err);
      yield await emit("RuntimeErrorOccurred", { error: e });

      if (e.category === "QUOTA") return yield* finish({ reason: "QUOTA_EXHAUSTED" });
      if (e.category === "CAPACITY") return yield* finish({ reason: "CONTEXT_EXHAUSTED" });

      if (
        e.retryability === "SAME_INPUT_BACKOFF" &&
        state.modelErrorRetries < spec.agentSpec.loopPolicy.maxModelErrorRetries
      ) {
        const attempt = state.modelErrorRetries + 1;
        await ports.clock.sleep(500 * attempt, interrupts.signal);
        state = nextState(
          state,
          { modelErrorRetries: attempt, consecutiveFailures: state.consecutiveFailures + 1 },
          { reason: "MODEL_ERROR_RETRY", attempt },
        );
        yield await emit("LoopContinued", { transition: state.transition as Continue });
        continue;
      }
      return yield* finish({ reason: "MODEL_ERROR", error: e });
    }

    const usage = invocation.usage;
    yield await emit("ModelInvocationCompleted", {
      toolCallCount: invocation.toolCalls.length,
      usage,
      stopReason: invocation.stopReason,
      durationMs: now() - startedAt,
    });

    /**
     * U-1 的两个观测点。
     *
     * 规则 3（token 口径）用的是「编译帧时声明的 totalTokens」与
     * 「端点实际计费的 inputTokens」之差 —— 这正是 2026-08-24 那两次实跑
     * 手工比对出 D-3 的方式。现在它是自动的：同样的偏差再次出现时，
     * 不需要有人恰好去翻日志。
     */
    for (const o of [
      drift.observeToolCallCount(invocation.toolCalls.length, true),
      drift.observeTokenAccuracy(frame.totalTokens, usage.inputTokens),
    ]) {
      if (!o) continue;
      if (o.disposition === "RECORD" && driftAnnounced.has(o.field)) continue;
      driftAnnounced.add(o.field);
      yield await emit("EndpointBehaviorDrift", {
        field: o.field,
        declared: o.declared,
        observed: o.observed,
        disposition: o.disposition,
      });
      if (o.disposition === "FAIL_FAST") {
        /**
         * 【定】不得静默继续（§8.6 不变量 4）。
         *
         * FAIL_FAST 的两条规则都有同一个性质：**继续跑会让后续失败
         * 离成因很远**。配对校验开始生效时，每一次疏漏都变成硬失败；
         * token 口径失准时，D-05 的激进 Compact 失去可靠触发点。
         */
        const err = makeError({
          code: "ENDPOINT_BEHAVIOR_DRIFT",
          source: "MODEL_PROVIDER",
          category: "PROTOCOL",
          retryability: "NEVER",
          sideEffectState: "NO_EFFECT",
          safeMessage: new EndpointDriftError(o).message,
        });
        yield await emit("RuntimeErrorOccurred", { error: err });
        return yield* finish({ reason: "MODEL_ERROR", error: err });
      }
    }

    const budget = {
      ...state.budgetUsage,
      modelCalls: state.budgetUsage.modelCalls + 1,
      inputTokens: state.budgetUsage.inputTokens + usage.inputTokens,
      outputTokens: state.budgetUsage.outputTokens + usage.outputTokens,
      // 【定】计费输入含缓存两项。只读 inputTokens 在命中时低估达 85%。
      billedInputTokens: state.budgetUsage.billedInputTokens + usage.billedInputTokens,
      // R-2：累计值，不是 now() - startedAt。等审批的时间与跨段关机的时间
      // 都不算 active（V05 §16.1【定】）。
      activeWallClockMs: activeNow(),
    };

    // 流式中断：半截内容不进入后续 Context，未闭合的 call 已被适配器丢弃。
    if (invocation.interrupted) {
      // 已发出但无 result 的 tool_use 在此合成 —— 三条中断路径之一。
      if (invocation.toolCalls.length > 0) {
        const synthesized = invocation.toolCalls.map(
          (c): ModelContent => ({
            type: "tool_result",
            toolCallId: c.toolCallId,
            content: JSON.stringify({
              status: "INTERRUPTED",
              reason: "模型响应流被中断，该工具未执行",
              sideEffectState: "NOT_STARTED",
            }),
            isError: true,
          }),
        );
        lastAssistantText = textOf(invocation.content) ?? lastAssistantText;
        let msgs = await appendAndPush(state.messages, {
          role: "assistant",
          turn: state.turnCount + 1,
          content: invocation.content,
        });
        msgs = await appendAndPush(msgs, {
          role: "user",
          turn: state.turnCount + 1,
          content: synthesized,
        });
        state = { ...state, messages: msgs, budgetUsage: budget };
      } else {
        // 这次模型调用已经发生并计费了，中断不改变这个事实。
        state = { ...state, budgetUsage: budget };
      }
      return yield* finish({ reason: "ABORTED_STREAMING" });
    }

    // 推理吃光输出预算：接口成功、无错误码、内容为空。
    // 【定】识别为明确错误条件，而不是正常完成 —— 否则会把空回复
    // 当成模型的正常回答继续推进，产生一次静默的错误决策。
    const emptyOutput =
      invocation.stopReason === "max_tokens" &&
      invocation.toolCalls.length === 0 &&
      invocation.content.every((c) => c.type !== "text" || c.text.trim() === "");

    if (emptyOutput) {
      if (state.outputLimitRecoveries < spec.agentSpec.loopPolicy.maxOutputLimitRecoveries) {
        const attempt = state.outputLimitRecoveries + 1;
        yield await emit("RuntimeErrorOccurred", {
          error: makeError({
            code: "MODEL_OUTPUT_EATEN_BY_REASONING",
            source: "MODEL_PROVIDER",
            category: "CAPACITY",
            retryability: "AFTER_ENVIRONMENT_CHANGE",
            sideEffectState: "NO_EFFECT",
            safeMessage: `输出预算被推理吃光（stop_reason=max_tokens 且正文为空），第 ${attempt} 次抬高上限重试`,
          }),
        });
        state = nextState(
          state,
          {
            budgetUsage: budget,
            outputLimitRecoveries: attempt,
            maxOutputTokensOverride: (state.maxOutputTokensOverride ?? frame.reservedOutputTokens) * 4,
          },
          { reason: "OUTPUT_LIMIT_RECOVERY", attempt },
        );
        yield await emit("LoopContinued", { transition: state.transition as Continue });
        continue;
      }
      return yield* finish({ reason: "CONTEXT_EXHAUSTED" });
    }

    // 助手消息落盘
    // 空文本不覆盖上一轮 —— 纯 tool_call 的回合没有正文，但那一轮之前说过的话
    // 仍然是目前对「发生了什么」最好的描述。
    lastAssistantText = textOf(invocation.content) ?? lastAssistantText;
    let messages = await appendAndPush(state.messages, {
      role: "assistant",
      turn: state.turnCount + 1,
      content: invocation.content,
    });

    // ── ③ 模型不再请求工具 → 结算 outcome，退出
    if (invocation.toolCalls.length === 0) {
      state = {
        ...state,
        messages,
        budgetUsage: { ...budget, turns: state.turnCount + 1 },
        turnCount: state.turnCount + 1,
      };
      const r = settleOutcome({ verifications, recoveryItems, artifactChecks });
      // 走 finish() 而不是直接构造返回值 —— 否则这条最常见的出口
      // 会绕过事实落盘，resume 读到的预算永远停在上一轮。
      return yield* finish(
        r.kind === "SUCCESS"
          ? { reason: "COMPLETED" }
          : { reason: "COMPLETED_WITH_LIMITS", incompleteItems: r.incompleteItems },
      );
    }

    // ── ④ 执行 ActionBatch
    let batchOutcome: BatchOutcome;
    const batchGen = executeBatch(
      invocation.toolCalls.map((c) => ({ toolCallId: c.toolCallId, name: c.name, input: c.input })),
      {
        runId,
        invocationId: frame.invocationId,
        registry,
        tools: ports.tools,
        effects: ports.effects,
        redaction: ports.redaction,
        verification: ports.verification,
        approvalDecider: deps.approvalDecider,
        approvalPolicy: spec.agentSpec.approvalPolicy,
        timezone: spec.agentSpec.timezone,
        // 决 6：逐 Action 的执行前指纹落 transcript。它是 §18.2 分支二的真正判据。
        recordActionFact: async (fact) => {
          lastSequence = await ports.transcript.append(makeActionFactEntry(runId, fact));
        },
        ids: ports.ids,
        now,
        signal: interrupts.signal,
        workspaceRoot: deps.workspaceRoot,
        hasUntrustedContext: frame.trustSummary.hasExternalUntrusted,
        // §11.4：大结果外置。阈值来自**上下文预算**，不是端点协议上限 ——
        // 循环只是把它透传下去，不读端点声明（纪律第 5 条不变）。
        blobs: ports.blobs,
        inlineResultLimitTokens: spec.agentSpec.contextPolicy.inlineToolResultLimitTokens,
        // §17 / §10.4：Artifact 登记与第二层 Verification。
        artifacts: ports.artifacts,
        artifactChecks: ports.artifactChecks,
      },
    );

    {
      let r = await batchGen.next();
      while (!r.done) {
        const bev = r.value;
        /**
         * R-2：等审批的那段时间在这里被夹出来。
         *
         * 为什么在主循环测而不是在 settle-batch 里：`ApprovalRequested` 与
         * `ApprovalDecided` 本来就都流经这里，主循环拿得到完整的事件对，
         * 而 settle-batch 不认识「预算」这个概念。让它去报时会把预算语义
         * 泄进批执行逻辑里。
         */
        if (bev.type === "ApprovalRequested") waitingSince = now();
        else if (bev.type === "ApprovalDecided" && waitingSince !== undefined) {
          waitedMs += now() - waitingSince;
          waitingSince = undefined;
        }
        /**
         * ── S10 ③：人工接管的等待同样不计入 active ─────────────────────
         *
         * 【定】`waitingSince` 此前**只在 Approval 那一对上设置**。
         * 于是接管的等待会全额计入 active：用户去外部系统操作 10 分钟回来，
         * 下一轮可能直接 BUDGET_EXHAUSTED —— 而那 10 分钟里 Agent 什么都没干。
         * 这是评审 pi 维度 6 指出的**后果**（它的成因判断有误，但后果成立）。
         *
         * 形态与 Approval 完全一致，不是巧合：两者都是「循环阻塞在一个
         * 等人的 await 上」，而 §16.1【定】说的就是 WAITING_* 不累计。
         */
        else if (bev.type === "InteractionRequested") waitingSince = now();
        else if (bev.type === "InteractionCompleted" && waitingSince !== undefined) {
          waitedMs += now() - waitingSince;
          waitingSince = undefined;
        }
        /**
         * `ToolProgress` 在这里**没有消费者**，这是刻意的（阶段 3 收口批）。
         *
         * 它照常取号、进 Trace、yield 给上层 —— 那是给人看的可观测信号。
         * 但 Guard 不再消费它：进展事件是工具**执行完之后**才被排空的
         * （见 settle-batch 的注释），时间戳是批结算时刻而不是进展发生的
         * 时刻，拿它做「还活着吗」的判定会得到一个自信的错误答案。
         * 见 progress-guard.ts 的文件头。
         */
        // executeBatch 产出的事件带的是占位号 0 —— 它没有 store 也不该有。
        // 取号在这里统一做，与 emit() 走同一个分配器（D-2）。
        lastSequence = await ports.transcript.nextSequence(runId, lastSequence);
        const withSeq = { ...bev, sequence: lastSequence } as RunEvent;
        ports.trace.emit(withSeq);
        yield withSeq;
        r = await batchGen.next();
      }
      batchOutcome = r.value;
    }

    verifications.push(...batchOutcome.verifications);
    recoveryItems.push(...batchOutcome.recoveryItems);
    artifactChecks.push(...batchOutcome.artifactChecks);

    /**
     * U-3 的第二个问题：**在原地打转吗**。
     *
     * 指纹取自已 PREPARED 的 Action —— `inputDigest` 是规范化之后的，
     * `resolvedEffect.digest` 是解析之后的。用模型给的原始文本去比会漏：
     * 同一个调用换个键序、换个等价路径写法就「看起来不一样了」。
     */
    const noProgress = progress.observeBatch(
      batchOutcome.batch.actions.map((a) => ({
        toolName: a.toolName,
        inputDigest: a.inputDigest,
        effectDigest: a.resolvedEffect.digest,
      })),
    );

    // 【定】不变量 8 的落盘点：results 恰好 calls.length 条。
    messages = await appendAndPush(messages, {
      role: "user",
      turn: state.turnCount + 1,
      content: batchOutcome.results,
    });

    if (batchOutcome.aborted) {
      state = { ...state, messages, budgetUsage: budget };
      return yield* finish({ reason: "ABORTED_TOOLS" });
    }

    /**
     * 【定】无进展是**具名终止**，不是静默继续（循环纪律第 2 条）。
     *
     * 排在 aborted 之后、构造下一轮之前：这一轮的 result 已经落盘（配对完整），
     * 该记的事实也都记了 —— 停在这里不会留下一个失真的世界。
     *
     * 为什么必须停：模型第三次发起**完全相同**的调用，说明它没有在读工具
     * 返回的诊断。让它接着转下去，每一轮都在烧 token 且不会好转，
     * 而预算轴要到很晚才撞得到。
     */
    if (noProgress) {
      yield await emit("NoProgressDetected", {
        toolName: noProgress.toolName,
        repeats: noProgress.repeats,
        inputDigest: noProgress.inputDigest,
      });
      state = {
        ...state,
        messages,
        budgetUsage: { ...budget, turns: state.turnCount + 1 },
        turnCount: state.turnCount + 1,
      };
      return yield* finish({ reason: "NO_PROGRESS", toolName: noProgress.toolName, repeats: noProgress.repeats });
    }

    const anyFailed = batchOutcome.attempts.some((a) => a.status === "FAILED");
    const anyVerified = batchOutcome.verifications.some((v) => v.status === "PASSED");

    // ── ⑤ 构造下一轮完整状态，显式写明原因（循环纪律第 1、2 条）
    state = nextState(
      state,
      {
        messages,
        turnCount: state.turnCount + 1,
        budgetUsage: {
          ...budget,
          turns: state.turnCount + 1,
          toolCalls: budget.toolCalls + invocation.toolCalls.length,
        },
        // consecutiveFailures 归零条件：任一 Action 成功且其 required Verification 通过
        consecutiveFailures: anyVerified
          ? 0
          : anyFailed
            ? state.consecutiveFailures + 1
            : state.consecutiveFailures,
        modelErrorRetries: 0,
        outputLimitRecoveries: 0,
        maxOutputTokensOverride: undefined,
      },
      { reason: "NEXT_TURN" },
    );
    // 【定】轮边界也要落一次事实。进程死在下一轮的模型调用里时，
    // resume 读回的是这一轮结束时的预算，而不是整个 Run 的起点。
    // 【定】emit 在前、persistFacts 在后 —— 见 persistFacts 的顺序说明（D-2）。
    yield await emit("LoopContinued", { transition: state.transition as Continue });
    await persistFacts();
  }
}

/**
 * 助手回合里的可见正文。
 *
 * 【定】只取 text 块，不取 reasoning。推理块是模型的草稿，不是它对用户的交代 ——
 * 把草稿当成 summary 呈现，既泄露了不该呈现的中间态，也往往答非所问。
 *
 * 返回 undefined 表示这一回合没有正文（纯 tool_call），调用方据此保留上一轮的值。
 */
function textOf(content: ModelContent[]): string | undefined {
  const text = content
    .filter((c): c is Extract<ModelContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function wallKind(
  t: Terminal,
): "BUDGET_EXHAUSTED" | "CONTEXT_EXHAUSTED" | "QUOTA_EXHAUSTED" | "CANCELLED" | "FAILED" {
  switch (t.reason) {
    case "BUDGET_EXHAUSTED":
    case "MAX_TURNS":
      return "BUDGET_EXHAUSTED";
    case "CONTEXT_EXHAUSTED":
      return "CONTEXT_EXHAUSTED";
    case "QUOTA_EXHAUSTED":
      return "QUOTA_EXHAUSTED";
    case "ABORTED_STREAMING":
    case "ABORTED_TOOLS":
      return "CANCELLED";
    /**
     * 【定】无进展归 BUDGET_EXHAUSTED，不归 FAILED。
     *
     * 「模型在原地打转，我们把它停了」是一次**主动的资源保护**，
     * 与「工具挂了 / 端点报错」不是同一类事。判成 FAILED 会让
     * 用户以为出了故障去排查，而实际上该做的是换个说法重来。
     */
    case "NO_PROGRESS":
      return "BUDGET_EXHAUSTED";
    default:
      return "FAILED";
  }
}
