/**
 * 验收项 3：verify:resume
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：消息级恢复够不够用？
 *
 * 做法：跑到批执行中途丢弃 LoopState，从 transcript 重建后继续，
 * 与不中断跑完的结果对比。
 *
 * ── 为什么这条最关键 ──
 *
 * 消息级恢复是本架构删掉纯 Kernel 的**主要理由**（V05 §18.1）：
 * 既然 mid-turn 恢复不要了，可序列化 KernelState 的唯一硬收益就消失了。
 *
 * 不测它，这个取舍到阶段 1 结束时仍然零证据 ——
 * 那就等于用一个没验证过的理由删掉了一整套机制。
 *
 * ── 它同时暴露代价 ──
 *
 * 崩溃时正在执行的工具，那次执行丢失。transcript 上看不出
 * 「工具跑没跑」（§18.2 的窗口 A 与 B 不可区分），只能靠
 * idempotency 声明与 Observation 逼近。
 *
 * B2 段把三条分支各走一遍，并断言它们的**实际行为**而不只是分支名：
 *   分支一 IDEMPOTENT_RETRY  → 工具真的被重新执行了（有 AttemptCompleted 事件）
 *   分支二 OBSERVE_FIRST     → 真的读了外部世界（result 里是观察结论，不是 UNKNOWN）
 *   分支三 RECOVERY_REQUIRED → 真的停住了（Terminal 就是 RECOVERY_REQUIRED，
 *                              且此后没有任何模型调用）
 * ══════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CollectingTraceSink,
  findUnpairedToolUses,
  makeActionFactEntry,
  readRunFacts,
  type ContextMessage,
  type ResumableRunFacts,
  type RunId,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import { compose } from "../compose.js";
import { ScriptedModelPort, banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

/**
 * 三轮脚本。第 2 轮那次「重写」不是冗余 —— 它模拟的是真 Agent 的行为。
 *
 * ── 为什么必须有它（阶段 2 收紧 C 段判据后暴露的）──────────────────────
 *
 * 中断路径上 `tc_2` 会被合成一个 SKIPPED result（cancel 的正常处置）。
 * 配对是完好的，所以 resume 不会走三条恢复分支中的任何一条 ——
 * 它直接进主循环问模型「接下来做什么」。**真 Agent 会看到那个 SKIPPED
 * 然后把写补上**，而两轮脚本在这里直接说「两件事都做完了」就收工，
 * 于是恢复路径的 note.txt 根本不存在。
 *
 * 阶段 1 的 C 段判据只查「都到终态 / 无未配对 / transcript 只增」，
 * 三条全绿 —— 一个**产物完全缺失**的恢复就这样被判成了「与基线一致」。
 * 这就是「判据太松」的实际后果。
 *
 * 基线跑这一轮时是一次同内容覆盖写，幂等无害；恢复跑到它时才是真正的补做。
 * 两条路径因此产出逐字相同的 note.txt，「结果一致」这句话才有了对应物。
 */
const SCRIPT = () =>
  new ScriptedModelPort([
    {
      reasoning: "先看目录再写文件",
      toolCalls: [
        { toolCallId: "tc_1", name: "list_dir", input: { path: "." } },
        { toolCallId: "tc_2", name: "write_file", input: { path: "note.txt", content: "hello" } },
      ],
    },
    {
      text: "确认一下 note.txt 写好了没有，没有就补上。",
      toolCalls: [
        { toolCallId: "tc_3", name: "write_file", input: { path: "note.txt", content: "hello" } },
      ],
    },
    { text: "两件事都做完了。", toolCalls: [] },
  ]);

async function main(): Promise<void> {
  banner(
    "验收项 3：消息级恢复",
    "中途丢弃 LoopState，从 transcript 重建后继续，结果与不中断一致？",
  );

  // ═══════════════════════════════════════════════ A. 基线：不中断跑完
  section("A. 基线：不中断跑完");
  const baseline = await runOnce({ interruptAfterMessages: 0 });
  fact("Terminal", baseline.terminal);
  fact("Outcome", baseline.outcome);
  fact("transcript 条目数", baseline.entries.length);
  fact("最终 messages 数", baseline.messages.length);
  fact("note.txt 内容", baseline.noteContent ?? "（不存在）");

  // ═══════════════════════════════════════════ B. 中断 + resume
  section("B. 批执行中途丢弃 LoopState，然后 resume");
  console.log(
    "   模拟方式：在第 4 条消息落盘后 cancel。此时 transcript 里已有\n" +
      "   assistant 回合（含两个 tool_call），但批可能没结算完。",
  );

  const interrupted = await runOnce({ interruptAfterMessages: 3, thenResume: true });

  fact("中断时 Terminal", interrupted.firstTerminal ?? "-");
  fact("中断时 transcript 条目", interrupted.entriesAtInterrupt ?? 0);
  fact("中断时未配对 tool_use", (interrupted.unpairedAtInterrupt ?? []).join(", ") || "0");
  console.log();
  fact("resume 重建消息数", interrupted.rebuiltMessages ?? 0);
  for (const b of interrupted.resumeBranches) {
    fact(`  ${b.toolCallId}（${b.toolName}）`, `分支 ${b.branch}`);
  }
  fact("resume 后 Terminal", interrupted.terminal);
  fact("resume 后 Outcome", interrupted.outcome);
  fact("最终 transcript 条目数", interrupted.entries.length);
  fact("note.txt 内容", interrupted.noteContent ?? "（不存在）");

  // ── B1. 预算继承：V05 §18.4【定】resume 保留预算使用
  console.log(
    "\n   §18.4【定】resume 保留 RunId、RunSpec、已完成副作用**和预算使用**。\n" +
      "   不继承的话，反复 crash + resume 就能把 turnCount 与墙钟清零 ——\n" +
      "   maxTurns 与 maxActiveWallClockMs 这两堵硬墙形同虚设。",
  );
  const bIn = interrupted.factsAtInterrupt;
  const bOut = interrupted.factsAfterResume;
  fact("中断时 turn / modelCalls", bIn ? `${bIn.turnCount} / ${bIn.budgetUsage.modelCalls}` : "（无记录）");
  fact("resume 后 turn / modelCalls", bOut ? `${bOut.turnCount} / ${bOut.budgetUsage.modelCalls}` : "（无记录）");
  fact("墙钟起点是否同一个", bIn && bOut ? bIn.budgetUsage.startedAt === bOut.budgetUsage.startedAt : false);

  const budgetInherited =
    !!bIn &&
    !!bOut &&
    bOut.budgetUsage.startedAt === bIn.budgetUsage.startedAt &&
    bOut.budgetUsage.modelCalls >= bIn.budgetUsage.modelCalls &&
    bOut.turnCount >= bIn.turnCount;
  verdict(
    budgetInherited,
    budgetInherited
      ? "预算与轮次从 transcript 的 RUN_META 读回并继续累计，没有归零"
      : "预算未被继承 —— 反复 crash + resume 可以绕过预算硬墙",
  );

  // ═══════════════════════ B2. 模拟进程硬崩：三条分支的真正触发条件
  section("B2. 模拟进程硬崩（三条分支的真正触发条件）");
  console.log(
    "   B 段暴露了一件事：**优雅 cancel 不会留下未配对的 tool_use** ——\n" +
      "   finalize() 已经把 result 补齐了。真正会留下未配对的是进程硬崩：\n" +
      "   assistant 回合已落盘，批还没结算，进程就没了。\n\n" +
      "   阶段 1 是 in-memory transcript，跨进程崩溃测不了，\n" +
      "   所以这里直接往 transcript 里注入那个状态。",
  );

  const crash = await simulateHardCrash();
  fact("注入的未配对 tool_use", crash.injected.join(", "));
  fact("resume 识别到", crash.branches.length + " 条");
  for (const b of crash.branches) {
    fact(`  ${b.toolCallId}（${b.toolName}）`, `分支 ${b.branch}`);
  }
  fact("resume 后 Terminal", crash.terminal);
  fact("resume 后未配对", crash.remainingUnpaired.length === 0 ? "0（已补齐）" : crash.remainingUnpaired.join(", "));

  console.log("\n   三条分支的实际行为（不是分支名）：");
  fact("  分支一 重新执行了工具", crash.retriedTools.join(", ") || "否");
  fact("  分支二 目标已存在 → 观察结论", crash.observedAppliedStatus ?? "（未观察）");
  fact("  分支二 目标不存在 → 观察结论", crash.observedStatus ?? "（未观察）");
  fact("  分支三 停住了", crash.terminal === "RECOVERY_REQUIRED");
  fact("  停住后的模型调用次数", crash.modelCallsAfterResume);
  console.log("\n   「交用户决定」是不是真的要一个决定：");
  fact("  不带决策再 resume", crash.bareResumeRejected ? "被拒绝（正确）" : "放行了（错误）");
  fact("  带 CONTINUE 决策后", `${crash.afterDecisionTerminal}，模型调用 ${crash.afterDecisionModelCalls} 次`);

  const branchesHit = new Set(crash.branches.map((b) => b.branch));
  const allThree =
    branchesHit.has("IDEMPOTENT_RETRY") &&
    branchesHit.has("OBSERVE_FIRST") &&
    branchesHit.has("RECOVERY_REQUIRED");
  // 【定】判据不是「识别到的条数等于注入条数」—— 那只证明分类跑过。
  // 必须是三条分支各自的行为都成立。
  const b2Ok =
    allThree &&
    crash.remainingUnpaired.length === 0 &&
    crash.retriedTools.length > 0 &&
    // 同一个工具、两个不同的外部状态 → 两个不同的结论。这才叫观察。
    crash.observedAppliedStatus === "RESUMED_OBSERVED_APPLIED" &&
    crash.observedStatus === "RESUMED_OBSERVED_NOT_APPLIED" &&
    crash.terminal === "RECOVERY_REQUIRED" &&
    crash.modelCallsAfterResume === 0 &&
    // 停住必须是「等一个决定」，不能是「停一次下次自动放行」
    crash.bareResumeRejected &&
    crash.afterDecisionModelCalls > 0;

  verdict(
    b2Ok,
    b2Ok
      ? `三条分支各走一遍且行为成立：幂等工具被重跑、可观察工具按外部世界的实际状态` +
        `给出了两个不同结论、不可观察工具让 Run 停在 RECOVERY_REQUIRED（此后零次模型调用，` +
        `且必须带显式决策才能继续）`
      : `三条分支未全部走到或行为不成立（命中：${[...branchesHit].join("、") || "无"}）`,
  );

  // ═══════════════════════════════ B3. 恢复决策给 ABORT 时的收尾
  section("B3. ABORT 决策：Run 就地收在 CANCELLED");
  console.log(
    "   B2 走的是 CONTINUE。ABORT 是另一条**完全不经过主循环**的终止路径 ——\n" +
      "   facade 在 resume 里直接收尾返回。它因此需要自己发 `LoopTerminated`：\n" +
      "   U-4 修的是 runLoop 的 finish()，管不到这里。\n",
  );

  const aborted = await simulateHardCrash("ABORT");
  fact("Terminal", aborted.afterDecisionTerminal ?? "（未返回）");
  fact("Outcome", aborted.afterDecisionOutcome ?? "（未结算）");
  fact("决策后的模型调用次数", aborted.afterDecisionModelCalls);
  fact("发出了 LoopTerminated", aborted.afterDecisionLoopTerminated);
  fact("outcome.summary", aborted.afterDecisionSummary?.slice(0, 46) ?? "（空）");

  const abortOk =
    aborted.afterDecisionTerminal === "ABORTED_TOOLS" &&
    aborted.afterDecisionOutcome === "CANCELLED" &&
    // ABORT 是「不继续了」，所以决策之后一次模型都不该调。
    aborted.afterDecisionModelCalls === 0 &&
    aborted.afterDecisionLoopTerminated &&
    // R-7：outcome 得能读出「为什么收在这里」，不能只有一个 CANCELLED。
    (aborted.afterDecisionSummary?.length ?? 0) > 0;

  verdict(
    abortOk,
    abortOk
      ? "ABORT 决策就地收在 CANCELLED：零次模型调用、发出了具名 LoopTerminated、" +
        "且 outcome.summary 写明了收尾原因"
      : `ABORT 路径不成立（terminal=${aborted.afterDecisionTerminal}、` +
        `outcome=${aborted.afterDecisionOutcome}、模型调用 ${aborted.afterDecisionModelCalls} 次、` +
        `LoopTerminated=${aborted.afterDecisionLoopTerminated}）`,
  );

  // ═══════════════════════════════════════════════════ C. 对比
  section("C. 与基线对比");

  /**
   * ── 阶段 2 收紧了这一段的判据 ───────────────────────────────────────
   *
   * 原判据只有三条：两条路径都到终态、无未配对、transcript 只增。
   * 它**接受**基线 COMPLETED 对恢复 COMPLETED_WITH_LIMITS，也不比较
   * 最终 outcome、不比较 note.txt 内容、不比较最终消息序列 ——
   * 于是脚本抬头那句「与不中断跑完的结果一致」在判据里没有对应物。
   *
   * 「都到了终态」和「结果一致」差得很远：一个把文件写坏了的恢复
   * 同样能到终态。产物是外部世界的事实，它才是「一致」的真正含义。
   */
  const bothCompleted =
    baseline.terminal === "COMPLETED" &&
    (interrupted.terminal === "COMPLETED" || interrupted.terminal === "COMPLETED_WITH_LIMITS");
  const noUnpaired = findUnpairedToolUses(interrupted.messages).length === 0;
  const transcriptGrew = interrupted.entries.length >= (interrupted.entriesAtInterrupt ?? 0);
  // 新增三条：产物一致、outcome 一致、最终消息里的工具调用集合一致。
  const sameArtifact = baseline.noteContent !== undefined && baseline.noteContent === interrupted.noteContent;
  const sameOutcome = baseline.outcome === interrupted.outcome;
  const baselineCalls = toolCallIdsOf(baseline.messages);
  const interruptedCalls = toolCallIdsOf(interrupted.messages);
  const sameCallSet =
    baselineCalls.length > 0 && baselineCalls.every((id) => interruptedCalls.includes(id));

  fact("两条路径都到达终态", bothCompleted);
  fact("resume 后无未配对 tool_use", noUnpaired);
  fact("transcript 只增不改", transcriptGrew);
  fact("产物 note.txt 一致", `${sameArtifact}（基线 ${JSON.stringify(baseline.noteContent)} / 恢复 ${JSON.stringify(interrupted.noteContent)}）`);
  fact("outcome 一致", `${sameOutcome}（${baseline.outcome} vs ${interrupted.outcome}）`);
  fact("工具调用集合覆盖基线", `${sameCallSet}（基线 ${baselineCalls.length} 个）`);

  const cOk = bothCompleted && noUnpaired && transcriptGrew && sameArtifact && sameCallSet;
  verdict(
    cOk,
    cOk
      ? "消息级恢复成立：丢弃内存状态后仅凭 transcript 重建并继续到终态，**且产物与基线逐字一致、基线做过的工具调用一个不少**"
      : "恢复到了终态，但结果与基线不一致 —— 「到终态」不等于「做对了」",
  );
  if (!sameOutcome) {
    console.log(
      "\n   \x1b[33m注意\x1b[0m：outcome 与基线不同。这不一定是错的 —— 恢复路径上多出的\n" +
        "   那次观察本身就是事实。但它必须是**被解释过**的差异，而不是被判据放过的差异。",
    );
  }

  // ═══════════════════════════════════ C2. 事件与 transcript 的定序（D-2）
  section("C2. 跨 resume 的序号是不是一条线（D-2）");
  console.log(
    "   修复前这里是两条独立计数器：runLoop 的 seq 从 0 起、store 的 sequence 从 1 起，\n" +
      "   而且 **resume 之后 runLoop 的 seq 还会从 0 重新计** —— 第二段的事件 1..n\n" +
      "   与第一段的 1..m 在 Trace 里根本没法定序。§23.2 的 Layer 2 投影游标依赖这条序列，\n" +
      "   带着两条计数器进 SQLite 之后就没法收拾了，所以它必须早于持久化做掉。\n",
  );

  const evSeq = interrupted.eventSequences;
  const trSeq = interrupted.entries.map((e) => e.sequence);
  const union = [...evSeq, ...trSeq].sort((a, b) => a - b);
  const dupes = union.filter((n, i) => i > 0 && n === union[i - 1]);
  const evMonotonic = evSeq.every((n, i) => i === 0 || n > evSeq[i - 1]!);

  fact("事件条数 / transcript 条数", `${evSeq.length} / ${trSeq.length}`);
  fact("事件号是否严格递增（含 resume 段）", evMonotonic);
  fact("事件号与条目号有无重号", dupes.length === 0 ? "无" : dupes.join(", "));
  fact("并集是否连续无空洞", union.length > 0 && union[union.length - 1] === union.length);

  // 【定】判据是「无重号」＋「事件号跨 resume 仍严格递增」。
  // 并集连续只是附带的好性质，不作为硬判据 —— resume 路径上 facade 与 runLoop
  // 交接时用 Math.max 抬过下限，理论上允许留一个空号。
  const seqOk = dupes.length === 0 && evMonotonic;
  verdict(
    seqOk,
    seqOk
      ? `事件与 transcript 共用一条单调序列：${evSeq.length} 个事件号跨 resume 仍严格递增，` +
        `与 ${trSeq.length} 个条目号之间零重号`
      : `序号有问题：${dupes.length > 0 ? `重号 ${dupes.join(", ")}` : "事件号在 resume 后回退了"}`,
  );

  // ═══════════════════════════════════════════ D. 代价的正面陈述
  section("D. 这个取舍的代价（不是缺陷，是选择）");
  console.log(
    "   §18.2 的窗口 A（工具未执行）与窗口 B（工具已执行但 result 未落盘）\n" +
      "   在 transcript 上**无法区分** —— 你不知道那个工具到底跑没跑。\n\n" +
      "   因此 resume() 只能按 idempotency 声明分三条分支：\n" +
      "     · 幂等或只读        → 重新执行一遍（走完整的 Policy/Approval/Verification 链）\n" +
      "     · 有 Observation    → 先观察外部世界，把 UNKNOWN 变成已知，再据结果决定\n" +
      "     · 非幂等且不可观察   → 停在 RECOVERY_REQUIRED，交用户决定，期间不得再调模型\n\n" +
      "   本次实际走到的分支与它们的行为证据见 B2 段。这就是把「Tool 是否幂等」\n" +
      "   从可选属性抬成恢复正确性前提的原因（原则十五）。",
  );

  section("阶段 2 要用真实数据回答的问题");
  console.log(
    "   跑够多真实任务，统计有多少次 resume() 落进了「非幂等且不可观察」那条分支。\n" +
      "   比例低到可忽略 → 本架构的恢复粒度选择是对的；\n" +
      "   比例不低       → 该把粒度往细里推 —— 但那时会有真实数据，而不是推演。\n",
  );

  /**
   * 【N-2】这里曾经手写过一个退出表达式，而 **C 段的 `cOk` 漏在外面** ——
   * 「恢复产物与基线逐字一致、基线做过的工具调用一个不少」算出来了、打印了、
   * 被当时的复盘列为最有价值的发现之一，却不进退出码。
   * 恢复写坏产物、丢掉基线调用，`verify:all` 的 `&&` 链照样返回 0。
   *
   * 现在退出码由 harness 的判据登记表统一推出（`runVerify`），
   * 每一条 `verdict()` 自动计入 —— 漏一项这件事在形状上不再可能发生。
   */
}

interface RunResult {
  terminal: string;
  outcome: string;
  entries: TranscriptEntry[];
  messages: ContextMessage[];
  noteContent?: string;
  firstTerminal?: string;
  entriesAtInterrupt?: number;
  unpairedAtInterrupt?: string[];
  rebuiltMessages?: number;
  resumeBranches: Array<{ toolCallId: string; toolName: string; branch: string }>;
  factsAtInterrupt?: ResumableRunFacts;
  factsAfterResume?: ResumableRunFacts;
  /** 跨「中断 ＋ resume」两段的全部事件号，用于 D-2 的定序判据。 */
  eventSequences: number[];
}

async function runOnce(opts: {
  interruptAfterMessages: number;
  thenResume?: boolean;
}): Promise<RunResult> {
  const ws = tempWorkspace();
  const trace = new CollectingTraceSink();
  const resumeBranches: RunResult["resumeBranches"] = [];

  try {
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      modelPortOverride: SCRIPT(),
    });

    const spec = composed.makeRunSpec("看目录并写文件");
    const gen = composed.runtime.start(spec);

    let runId = "" as string;
    let appended = 0;
    let firstTerminal: string | undefined;
    let entriesAtInterrupt: number | undefined;
    let unpairedAtInterrupt: string[] | undefined;

    let r = await gen.next();
    while (!r.done) {
      const e = r.value;
      if (!runId) runId = String(e.runId);

      // 数「已落盘的消息」。这是丢弃 LoopState 的时机判据 ——
      // 它模拟的是进程在某个消息边界之后死掉。
      if (
        e.type === "AttemptCompleted" ||
        e.type === "ModelInvocationCompleted" ||
        e.type === "ActionBatchPlanned"
      ) {
        appended += 1;
      }

      if (opts.interruptAfterMessages > 0 && appended >= opts.interruptAfterMessages) {
        composed.runtime.cancel(runId as RunId, "verify:resume 注入的中断");
      }

      r = await gen.next();
    }

    let factsAtInterrupt: ResumableRunFacts | undefined;
    if (opts.thenResume) {
      firstTerminal = r.value.terminal.reason;
      const at = await composed.ports.transcript.readAll(runId as RunId);
      entriesAtInterrupt = at.length;
      factsAtInterrupt = readRunFacts(at);
      const msgsAt = await composed.ports.transcript.rebuildMessages(runId as RunId);
      unpairedAtInterrupt = findUnpairedToolUses(msgsAt).map((u) => u.toolCallId);

      // ── 关键动作：这里**不保留任何内存状态**。
      // resume() 拿到的只有 runId，一切从 transcript 重建。
      const gen2 = composed.runtime.resume(runId as RunId);
      let r2 = await gen2.next();
      while (!r2.done) {
        const e2 = r2.value;
        if (e2.type === "ResumeUnpairedToolUse") {
          resumeBranches.push({
            toolCallId: e2.payload.toolCallId,
            toolName: e2.payload.toolName,
            branch: e2.payload.branch,
          });
        }
        r2 = await gen2.next();
      }
      r = r2 as typeof r;
    }

    const entries = await composed.ports.transcript.readAll(runId as RunId);
    const messages = await composed.ports.transcript.rebuildMessages(runId as RunId);
    const rebuilt = trace.byType("ResumeStarted")[0]?.payload.rebuiltMessages;

    let noteContent: string | undefined;
    try {
      noteContent = readFileSync(resolve(ws.root, "note.txt"), "utf8");
    } catch {
      noteContent = undefined;
    }

    return {
      // 同一个 trace sink 贯穿中断前后两段，所以这串号能直接回答
      // 「resume 之后事件号有没有回退或撞号」（D-2）。
      eventSequences: trace.events.map((e) => e.sequence),
      terminal: r.value.terminal.reason,
      outcome: r.value.outcome?.kind ?? "未结算（非终态）",
      entries,
      messages,
      noteContent,
      firstTerminal,
      entriesAtInterrupt,
      unpairedAtInterrupt,
      rebuiltMessages: rebuilt,
      resumeBranches,
      factsAtInterrupt,
      factsAfterResume: readRunFacts(entries),
    };
  } finally {
    ws.cleanup();
  }
}

/**
 * 直接往 transcript 注入「assistant 回合已落盘、批未结算」的状态。
 *
 * 这是进程硬崩在 transcript 上留下的形态，也是 §18.2 三条分支的唯一触发条件。
 * 注入三个不同性质的工具，三条分支才都被走到：
 *   list_dir    只读幂等              → IDEMPOTENT_RETRY
 *   write_file  非幂等 + REOBSERVE     → OBSERVE_FIRST
 *   append_log  非幂等 + 无 Observation → RECOVERY_REQUIRED
 *
 * 第三个是补上来的：只有前两个时，第三条分支在这套工具集下永远不可达 ——
 * 一条走不到的分支，它的正确性没有任何证据。
 */
async function simulateHardCrash(decision: "CONTINUE" | "ABORT" = "CONTINUE"): Promise<{
  injected: string[];
  branches: RunResult["resumeBranches"];
  terminal: string;
  remainingUnpaired: string[];
  retriedTools: string[];
  observedStatus?: string;
  observedAppliedStatus?: string;
  modelCallsAfterResume: number;
  /** 停住之后不带决策再 resume 一次，是否被拒绝。 */
  bareResumeRejected: boolean;
  /** 带决策 resume 之后跑到了哪。 */
  afterDecisionTerminal?: string;
  afterDecisionModelCalls: number;
  afterDecisionOutcome?: string;
  /** 决策后的那段有没有发 `LoopTerminated`（U-4 对 facade 早退出口是否成立）。 */
  afterDecisionLoopTerminated: boolean;
  /** outcome.summary 有没有讲清「为什么收在这里」（R-7）。 */
  afterDecisionSummary?: string;
}> {
  const ws = tempWorkspace();
  const trace = new CollectingTraceSink();
  try {
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      // 恢复之后模型直接收尾。它**不应该被调用到** —— 第三条分支必须先把 Run 停住。
      modelPortOverride: new ScriptedModelPort([{ text: "我看到上次没做完，已了解情况。", toolCalls: [] }]),
    });

    // 先起一个 Run 把 runId 与 RunSpec 注册进 runtime，然后立刻 cancel。
    // 【定】不能让它跑到 COMPLETED —— 终态 Run 现在会被 resume 拒绝，
    // 而这正是要的行为：重跑终态 Run 会重复已经结算过的副作用。
    // cancel 后的 CANCELLED 是可 resume 的（V05 §10：没有 PAUSED，cancel 后 resume）。
    const spec = composed.makeRunSpec("被中断的任务");
    const gen = composed.runtime.start(spec);
    let runId = "";
    let r = await gen.next();
    while (!r.done) {
      if (!runId) {
        runId = String(r.value.runId);
        composed.runtime.cancel(runId as RunId, "模拟进程硬崩");
      }
      r = await gen.next();
    }

    /**
     * ── 分支二的载体：阶段 3 收口批从 `write_file` 换成 `edit_file` ──────────
     *
     * 覆盖写**本来就是幂等的**，它当年被标成非幂等只是为了给分支二凑一个
     * 通用工具（见 write-file.ts 的注释）—— 那等于拿被测对象身上的一个
     * 假声明去测分支分布。现在 `write_file` 诚实地落分支一，
     * 分支二交给天然非幂等的 `edit_file`（替换是**相对**操作）。
     *
     * 【定】换载体的同时必须注入 **ACTION_FACT 前置指纹**。
     * `edit_file` 声明了 `requiresPreFingerprint: true`，而 `canObserve`
     * 的最后一个合取项就是「这次拍到指纹没有」—— 光注入 tool_call 的话
     * 它会落**分支三**，分支二在这条脚本里就静默地不可达了，
     * 而分支二恰恰是这一段存在的理由。
     *
     * 分支二要证明的是「真的去读了外部世界」，不是「返回了一个常量」：
     *   · done.txt   盘上是**改过之后**的样子，指纹记的是改之前 → 观察到「已发生」
     *   · crash.txt  盘上与指纹**一模一样**                    → 观察到「没发生」
     * 同一个工具、两个不同的外部状态，必须给出两个不同的结论。
     */
    const BEFORE = "第一行\n待替换\n第三行\n";
    const AFTER = "第一行\n已替换\n第三行\n";
    writeFileSync(resolve(ws.root, "done.txt"), AFTER, "utf8");
    writeFileSync(resolve(ws.root, "crash.txt"), BEFORE, "utf8");

    /** 与 `CommonVerifier.snapshotFile()` 同构：exists / bytes / sha256(原始字节)。 */
    const fingerprintOf = (content: string): { exists: boolean; bytes: number; sha256: string } => {
      const buf = Buffer.from(content, "utf8");
      return {
        exists: true,
        bytes: buf.byteLength,
        sha256: createHash("sha256").update(buf).digest("hex"),
      };
    };

    // ── 注入：assistant 回合含四个 tool_call，没有任何 result
    const injected = ["tc_crash_read", "tc_crash_edit_done", "tc_crash_edit", "tc_crash_append"];
    await composed.ports.transcript.append({
      runId: runId as RunId,
      kind: "MESSAGE",
      message: {
        role: "assistant",
        turn: 9,
        content: [
          { type: "reasoning", text: "开始处理", signature: "" },
          { type: "tool_call", toolCallId: "tc_crash_read", name: "list_dir", input: { path: "." } },
          {
            type: "tool_call",
            toolCallId: "tc_crash_edit_done",
            name: "edit_file",
            input: { path: "done.txt", old_string: "待替换", new_string: "已替换" },
          },
          {
            type: "tool_call",
            toolCallId: "tc_crash_edit",
            name: "edit_file",
            input: { path: "crash.txt", old_string: "待替换", new_string: "已替换" },
          },
          {
            type: "tool_call",
            toolCallId: "tc_crash_append",
            name: "append_log",
            input: { path: "crash.log", line: "一条追加" },
          },
        ],
      },
      createdAt: Date.now(),
    });

    // 两条执行前指纹 —— 崩溃前 Runtime 侧的 Verifier 拍下的那两张。
    for (const [toolCallId, content] of [
      ["tc_crash_edit_done", BEFORE],
      ["tc_crash_edit", BEFORE],
    ] as const) {
      await composed.ports.transcript.append(
        makeActionFactEntry(runId as RunId, {
          toolCallId,
          toolName: "edit_file",
          fingerprint: fingerprintOf(content),
          at: Date.now(),
        }),
      );
    }

    const before = await composed.ports.transcript.rebuildMessages(runId as RunId);
    const unpairedBefore = findUnpairedToolUses(before).map((u) => u.toolCallId);
    if (unpairedBefore.length !== injected.length) {
      throw new Error(`注入失败：期望 ${injected.length} 个未配对，实际 ${unpairedBefore.length}`);
    }

    // ── resume：只给 runId，一切从 transcript 重建
    const branches: RunResult["resumeBranches"] = [];
    const retriedTools: string[] = [];
    let modelCallsAfterResume = 0;
    const gen2 = composed.runtime.resume(runId as RunId);
    let r2 = await gen2.next();
    while (!r2.done) {
      const e = r2.value;
      if (e.type === "ResumeUnpairedToolUse") {
        branches.push({
          toolCallId: e.payload.toolCallId,
          toolName: e.payload.toolName,
          branch: e.payload.branch,
        });
      }
      // 分支一的行为证据：工具真的被重新执行了。
      if (e.type === "AttemptStarted") retriedTools.push(e.payload.toolName);
      // 分支三的行为证据：停住之后不得再调模型。
      if (e.type === "ModelInvocationCompleted") modelCallsAfterResume += 1;
      r2 = await gen2.next();
    }

    const after = await composed.ports.transcript.rebuildMessages(runId as RunId);

    // ── 「交用户决定」必须真的要一个决定：不带决策再 resume 一次应当被拒绝
    let bareResumeRejected = false;
    try {
      const bare = composed.runtime.resume(runId as RunId);
      let rb = await bare.next();
      while (!rb.done) rb = await bare.next();
    } catch {
      bareResumeRejected = true;
    }

    // ── 带决策再 resume：CONTINUE 应当销账并真的继续跑；ABORT 应当就地收在 CANCELLED
    let afterDecisionModelCalls = 0;
    let afterDecisionLoopTerminated = false;
    const gen3 = composed.runtime.resume(runId as RunId, {
      recoveryDecision: decision,
      recoveryNote: `verify:resume 模拟人工${decision === "ABORT" ? "中止" : "确认"}`,
    });
    let r3 = await gen3.next();
    while (!r3.done) {
      if (r3.value.type === "ModelInvocationCompleted") afterDecisionModelCalls += 1;
      // U-4 的判据：ABORT 是在 facade 里就地收尾的，绕过整个主循环 ——
      // 它必须自己发这条事件，否则 Trace 上读不出「恢复被中止」这条路径。
      if (r3.value.type === "LoopTerminated") afterDecisionLoopTerminated = true;
      r3 = await gen3.next();
    }

    return {
      injected,
      branches,
      terminal: r2.value.terminal.reason,
      remainingUnpaired: findUnpairedToolUses(after).map((u) => u.toolCallId),
      retriedTools,
      bareResumeRejected,
      afterDecisionTerminal: r3.value.terminal.reason,
      afterDecisionModelCalls,
      afterDecisionOutcome: r3.value.outcome?.kind,
      afterDecisionLoopTerminated,
      afterDecisionSummary: r3.value.outcome?.summary,
      // 分支二的行为证据：两个 write_file 必须得到**不同**的观察结论。
      observedStatus: resultStatusOf(after, "tc_crash_edit"),
      observedAppliedStatus: resultStatusOf(after, "tc_crash_edit_done"),
      modelCallsAfterResume,
    };
  } finally {
    ws.cleanup();
  }
}

/** 从重建出的消息里取某个 tool_call 对应 result 的 status 字段。 */
function resultStatusOf(messages: ContextMessage[], toolCallId: string): string | undefined {
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type !== "tool_result" || c.toolCallId !== toolCallId) continue;
      try {
        return String((JSON.parse(c.content) as { status?: unknown }).status ?? "");
      } catch {
        return c.content.slice(0, 40);
      }
    }
  }
  return undefined;
}

void runVerify(main);

/** 消息里出现过的所有 toolCallId（按出现顺序，去重）。 */
function toolCallIdsOf(messages: ContextMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "tool_call" && !out.includes(c.toolCallId)) out.push(c.toolCallId);
    }
  }
  return out;
}
