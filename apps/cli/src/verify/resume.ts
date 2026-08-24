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

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CollectingTraceSink,
  findUnpairedToolUses,
  readRunFacts,
  type ContextMessage,
  type ResumableRunFacts,
  type RunId,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import { compose } from "../compose.js";
import { ScriptedModelPort, banner, fact, section, tempWorkspace, verdict } from "./harness.js";

const SCRIPT = () =>
  new ScriptedModelPort([
    {
      reasoning: "先看目录再写文件",
      toolCalls: [
        { toolCallId: "tc_1", name: "list_dir", input: { path: "." } },
        { toolCallId: "tc_2", name: "write_note", input: { path: "note.txt", content: "hello" } },
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

  // ═══════════════════════════════════════════════════ C. 对比
  section("C. 与基线对比");

  const bothCompleted =
    baseline.terminal === "COMPLETED" &&
    (interrupted.terminal === "COMPLETED" || interrupted.terminal === "COMPLETED_WITH_LIMITS");
  const noUnpaired = findUnpairedToolUses(interrupted.messages).length === 0;
  const transcriptGrew = interrupted.entries.length >= (interrupted.entriesAtInterrupt ?? 0);

  fact("两条路径都到达终态", bothCompleted);
  fact("resume 后无未配对 tool_use", noUnpaired);
  fact("transcript 只增不改", transcriptGrew);

  verdict(
    bothCompleted && noUnpaired && transcriptGrew,
    bothCompleted && noUnpaired
      ? "消息级恢复成立：丢弃内存状态后，仅凭 transcript 就能重建并继续到终态"
      : "消息级恢复未能重建出可继续的状态",
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

  process.exit(bothCompleted && noUnpaired && b2Ok && budgetInherited ? 0 : 1);
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
 *   write_note  非幂等 + REOBSERVE     → OBSERVE_FIRST
 *   append_log  非幂等 + 无 Observation → RECOVERY_REQUIRED
 *
 * 第三个是补上来的：只有前两个时，第三条分支在这套工具集下永远不可达 ——
 * 一条走不到的分支，它的正确性没有任何证据。
 */
async function simulateHardCrash(): Promise<{
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
  /** 带 CONTINUE 决策 resume，是否真的继续跑起来了。 */
  afterDecisionTerminal?: string;
  afterDecisionModelCalls: number;
}> {
  const ws = tempWorkspace();
  const trace = new CollectingTraceSink();
  try {
    const composed = compose({
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
     * 分支二要证明的是「真的去读了外部世界」，不是「返回了一个常量」。
     * 所以注入**两个** write_note：一个的目标文件已经存在且内容一致
     * （= 崩溃前那次写其实已经落盘），一个不存在。
     * 观察必须给出两个不同的结论，才谈得上「观察」。
     */
    writeFileSync(resolve(ws.root, "done.txt"), "已经写好了", "utf8");

    // ── 注入：assistant 回合含四个 tool_call，没有任何 result
    const injected = ["tc_crash_read", "tc_crash_write_done", "tc_crash_write", "tc_crash_append"];
    await composed.ports.transcript.append({
      runId: runId as RunId,
      schemaVersion: 1,
      kind: "MESSAGE",
      message: {
        role: "assistant",
        turn: 9,
        content: [
          { type: "reasoning", text: "开始处理", signature: "" },
          { type: "tool_call", toolCallId: "tc_crash_read", name: "list_dir", input: { path: "." } },
          {
            type: "tool_call",
            toolCallId: "tc_crash_write_done",
            name: "write_note",
            input: { path: "done.txt", content: "已经写好了" },
          },
          {
            type: "tool_call",
            toolCallId: "tc_crash_write",
            name: "write_note",
            input: { path: "crash.txt", content: "x" },
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

    // ── 带 CONTINUE 决策再 resume：应当销账并真的继续跑
    let afterDecisionModelCalls = 0;
    const gen3 = composed.runtime.resume(runId as RunId, {
      recoveryDecision: "CONTINUE",
      recoveryNote: "verify:resume 模拟人工确认",
    });
    let r3 = await gen3.next();
    while (!r3.done) {
      if (r3.value.type === "ModelInvocationCompleted") afterDecisionModelCalls += 1;
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
      // 分支二的行为证据：两个 write_note 必须得到**不同**的观察结论。
      observedStatus: resultStatusOf(after, "tc_crash_write"),
      observedAppliedStatus: resultStatusOf(after, "tc_crash_write_done"),
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
