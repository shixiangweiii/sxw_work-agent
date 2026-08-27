/**
 * verify:crash —— 阶段 2 批 3 的验收，也是**退出门槛的主要证据**。
 *
 * 验证：**三个 crash 窗口与三条恢复分支，在真 `kill -9` 下都可重复。**
 *
 * ── 它与阶段 1 的 verify:resume 是两件事 ────────────────────────────────
 *
 * 阶段 1 的 B2 段是「往 transcript 注入崩溃形态」。那验的是**处置逻辑**：
 * 给定一个末尾未配对的 tool_use，三条分支各自做得对不对。
 *
 * 但注入的崩溃只会出现在你想得到的位置上，而且注入的时候顺手把
 * `RUN_META` 也写对了 —— 批 1 第一次跑真 kill 就打出了「重号 5」，
 * 那是阶段 1 三条脚本全绿的情况下藏了很久的一个缺陷。
 *
 * SIGKILL 不可捕获：没有 finally、没有 flush、`settle-batch` 的
 * `finalize()` 一行都跑不到。剩下什么，全看已经 COMMIT 的部分。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asId,
  findUnpairedToolUses,
  readActionPreFingerprints,
  readRunFacts,
  type ContextMessage,
  type RunId,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import { SqliteTranscriptStore, openDb } from "@workagent/store-sqlite";
import { runSegment, type SegmentResult } from "@workagent/testkit";
import { compose } from "../compose.js";
import { banner, fact, runVerify, section, verdict } from "./harness.js";

const WORKER = resolve(fileURLToPath(new URL(".", import.meta.url)), "workers/run-segment.ts");

interface Case {
  name: string;
  /** 崩溃点：事件类型#第几次。 */
  killAt: string;
  /** 期望走到的 §18.2 分支。 */
  expectBranch: string;
  script: unknown[];
  /** 恢复段从脚本第几轮接着跑。 */
  resumeOffset: number;
  /** 关掉执行前指纹（决 6 的旋钮），把同一个工具压进第三条分支。 */
  disableObservation?: boolean;
  /** 停在 RECOVERY_REQUIRED 时带的决策。 */
  decision?: "CONTINUE" | "ABORT";
  /** 崩溃点之前 workspace 里要预置的文件。 */
  seed?: Array<[string, string]>;
}

const W = (id: string, path: string, content: string) => ({
  text: `写 ${path}`,
  toolCalls: [{ toolCallId: id, name: "write_note", input: { path, content } }],
});
const A = (id: string, path: string, line: string) => ({
  text: `追加到 ${path}`,
  toolCalls: [{ toolCallId: id, name: "append_log", input: { path, line } }],
});
const L = (id: string) => ({
  text: "看看目录",
  toolCalls: [{ toolCallId: id, name: "list_dir", input: { path: "." } }],
});
const END = { text: "做完了。", toolCalls: [] };

const CASES: Case[] = [
  {
    name: "窗口 A ＋ 分支一：只读工具执行前崩溃 → 直接重跑",
    killAt: "AttemptStarted#1",
    expectBranch: "IDEMPOTENT_RETRY",
    script: [L("c1"), END],
    resumeOffset: 1,
  },
  {
    name: "窗口 A ＋ 分支二：覆盖写执行前崩溃 → 观察到「没发生」",
    killAt: "AttemptStarted#1",
    expectBranch: "OBSERVE_FIRST",
    script: [W("c1", "a.txt", "内容"), W("c2", "a.txt", "内容"), END],
    resumeOffset: 1,
  },
  {
    name: "窗口 B ＋ 分支二：覆盖写**执行后**崩溃 → 观察到「已发生」",
    killAt: "AttemptCompleted#1",
    expectBranch: "OBSERVE_FIRST",
    script: [W("c1", "b.txt", "已经写进去了"), END],
    resumeOffset: 1,
  },
  {
    name: "窗口 A ＋ 分支三：追加且拍不到前置指纹 → 停在 RECOVERY_REQUIRED",
    killAt: "AttemptStarted#1",
    expectBranch: "RECOVERY_REQUIRED",
    script: [A("c1", "log.txt", "一行"), END],
    resumeOffset: 1,
    disableObservation: true,
    decision: "CONTINUE",
    seed: [["log.txt", "原有内容\n"]],
  },
  {
    name: "同一个 append_log，拍到了指纹 → 落分支二（决 6 的判别力）",
    killAt: "AttemptStarted#1",
    expectBranch: "OBSERVE_FIRST",
    script: [A("c1", "log.txt", "一行"), END],
    resumeOffset: 1,
    seed: [["log.txt", "原有内容\n"]],
  },
];

async function main(): Promise<void> {
  banner(
    "verify:crash —— 真 kill -9 下的崩溃窗口与恢复分支（阶段 2 批 3）",
    "三个窗口、三条分支，在进程被真正打死之后是不是都还成立？",
  );

  const tmp = mkdtempSync(join(tmpdir(), "workagent-crash-"));
  const results: Array<{ name: string; ok: boolean }> = [];

  try {
    section("A. 逐个注入：崩溃点 → 恢复分支");
    console.log(
      "   `AttemptStarted` 在 tools.execute() **之前** yield，`AttemptCompleted` 在之后。\n" +
        "   所以前者是窗口 A（工具没跑），后者是窗口 B（工具跑了、result 还没落盘）。\n" +
        "   §18.2【定】：这两者在 transcript 上**不可区分** —— 这正是消息级恢复的本质限制。\n",
    );

    const branchTally: Record<string, number> = {};
    /** 留着给 C 段：拿 Facade 的 inspect() 跟直读 RUN_META 的结果对一遍。 */
    const runsOnDisk: Array<{ dbPath: string; runId: RunId; workspace: string }> = [];

    for (const c of CASES) {
      const dir = join(tmp, c.name.slice(0, 8).replace(/\W/g, "_") + Math.random().toString(36).slice(2, 6));
      const ws = join(dir, "ws");
      mkdirSync(ws, { recursive: true });
      for (const [f, content] of c.seed ?? []) writeFileSync(join(ws, f), content, "utf8");

      const dbPath = join(dir, "runs.db");
      const seg1 = runSegment({
        workerPath: WORKER,
        dbPath,
        workspace: ws,
        mode: "start",
        script: c.script,
        killAt: c.killAt,
        ...(c.disableObservation ? { disableObservation: true } : {}),
      });

      if (!seg1.killed || !seg1.runId) {
        fact(c.name, `段 1 没被 kill（${seg1.error ?? seg1.exitCode}）`);
        results.push({ name: c.name, ok: false });
        continue;
      }

      const runId = asId<RunId>(seg1.runId);
      const beforeEntries = await readEntries(dbPath, runId);
      const fingerprints = readActionPreFingerprints(beforeEntries);

      const seg2 = runSegment({
        workerPath: WORKER,
        dbPath,
        workspace: ws,
        mode: "resume",
        runId: String(runId),
        script: c.script,
        scriptOffset: c.resumeOffset,
        ...(c.disableObservation ? { disableObservation: true } : {}),
      });

      runsOnDisk.push({ dbPath, runId, workspace: ws });
      const branch = pickBranch(seg2.stdout) ?? pickBranchFromFacts(await readEntries(dbPath, runId));
      const hit = branch === c.expectBranch;
      if (branch) branchTally[branch] = (branchTally[branch] ?? 0) + 1;

      console.log(`\n   · ${c.name}`);
      fact("   崩溃点", `${seg1.killedAt?.at ?? "?"}（${c.killAt}）`);
      fact("   拍到前置指纹", fingerprints.size > 0 ? `是（${fingerprints.size} 条 ACTION_FACT）` : "否");
      fact("   实际分支", `${branch ?? "（未知）"}${hit ? "" : `   ← 期望 ${c.expectBranch}`}`);
      fact("   恢复段 terminal", seg2.terminal ?? `（无）${seg2.error ?? ""}`);

      // 若停在 RECOVERY_REQUIRED，必须带决策才能继续 —— 这条闸门本身也要验。
      let finalOk = hit;
      if (c.expectBranch === "RECOVERY_REQUIRED") {
        const noDecision = seg2.terminal === undefined && /RECOVERY_REQUIRED/.test(seg2.error ?? "");
        const stopped = seg2.terminal === "RECOVERY_REQUIRED" || noDecision;
        fact("   不带决策再 resume", stopped ? "被拒绝（正确）" : "放行了（错误）");
        if (c.decision) {
          const seg3 = runSegment({
            workerPath: WORKER,
            dbPath,
            workspace: ws,
            mode: "resume",
            runId: String(runId),
            script: c.script,
            scriptOffset: c.resumeOffset,
            recoveryDecision: c.decision,
            ...(c.disableObservation ? { disableObservation: true } : {}),
          });
          fact(`   带 ${c.decision} 决策后`, seg3.terminal ?? `（无）${seg3.error ?? ""}`);
          finalOk = hit && stopped && seg3.terminal !== undefined;
        }
      }

      // 无论走哪条分支，配对不变量都不许破。
      const finalMsgs = messagesOf(await readEntries(dbPath, runId));
      const unpaired = findUnpairedToolUses(finalMsgs);
      fact("   最终未配对 tool_use", unpaired.length);
      results.push({ name: c.name, ok: finalOk && unpaired.length === 0 });
    }

    verdict(
      results.every((r) => r.ok),
      results.every((r) => r.ok)
        ? "三个窗口、三条分支各自命中，且每次恢复之后配对不变量都完好"
        : `未通过：${results.filter((r) => !r.ok).map((r) => r.name).join(" / ")}`,
    );

    // ────────────────────────────────────────────── B. 决 6 的判别力
    section("B. 决 6 的判别力：同一个工具，两条分支");
    const withFp = CASES.find((c) => c.name.includes("拍到了指纹"));
    const withoutFp = CASES.find((c) => c.name.includes("拍不到前置指纹"));
    const idxWith = CASES.indexOf(withFp!);
    const idxWithout = CASES.indexOf(withoutFp!);
    const bOk = results[idxWith]?.ok === true && results[idxWithout]?.ok === true;
    fact("append_log ＋ 指纹", "→ OBSERVE_FIRST（分支二）");
    fact("append_log ＋ 无指纹", "→ RECOVERY_REQUIRED（分支三）");
    console.log(
      "   ↑ **工具声明一个字没改**，改的是 Runtime 侧的 Verifier 能不能拍指纹。\n" +
        "     在此之前分流依据是工具身上的 `verification.mode`，也就是说\n" +
        "     阶段 2 的研究问题（多少次落进第三条分支）是拿被测对象身上的\n" +
        "     一个静态字段去测它自己。决 6 把这个旋钮挪到了测量装置这边。\n",
    );
    verdict(
      bOk,
      bOk
        ? "同一个 append_log 被送进了两条不同的分支，分流由 Action 级事实决定而非工具声明"
        : "决 6 的判别力没验出来",
    );
    results.push({ name: "决 6 判别力", ok: bOk });

    // ────────────────────────────────────────────── C. 测量装置
    section("C. 阶段 2 的测量装置：分支分布可导出");
    for (const [k, v] of Object.entries(branchTally)) fact(k, `${v} 次`);
    console.log(
      "\n   \x1b[33m结论边界（Roadmap §4 的 B 方案）\x1b[0m：这是**构造分布**，不是真实分布。\n" +
        "   故障注入只会落在你想得到的那些位置上，而且这里每条分支的次数\n" +
        "   是脚本决定的。**不得**用它下「消息级恢复的粒度选对了」这个结论 ——\n" +
        "   那要等阶段 3 有真工具、真任务。阶段 2 只负责让这个数**能被导出**。\n",
    );
    /**
     * 【P1-2】「Eval 可据此导出分布」这句话此前**只是一句话**。
     *
     * RUN_META 里确实有计数，但 Eval 层没有任何读它的路径：`eval/` 全目录
     * grep `resumeBranch` 零命中。而阶段 2 的退出门槛写的是「分支计数落
     * transcript **＋ Eval 能导出分布**」—— 后半句没做到，门槛却标了绿。
     *
     * 现在出口在 Facade 的 `inspect()` 上（§24.1：Eval 只经 Facade）。
     * 这一段就是那条出口的判据：拿 `inspect()` 的返回跟本脚本直读 RUN_META
     * 算出来的 tally 逐条比对。**两者必须一字不差** ——
     * 出口要是漏读、少算、或者读了另一个字段，这里当场翻红。
     */
    const viaFacade: Record<string, number> = {};
    for (const r of runsOnDisk) {
      const composed = compose({
        dbPath: r.dbPath,
        workspaceRoot: r.workspace,
        approvalDecider: async () => ({ approved: true }),
        trace: { emit: async () => {} },
        modelPortOverride: {
          invoke: async function* () {
            throw new Error("inspect() 不该调模型");
          },
          countTokens: async () => 0,
        },
      });
      const snap = await composed.runtime.inspect(r.runId);
      for (const [k, v] of Object.entries(snap?.resumeBranchCounts ?? {})) {
        viaFacade[k] = (viaFacade[k] ?? 0) + v;
      }
      composed.db.close();
    }
    fact("直读 RUN_META", fmtTally(branchTally));
    fact("经 Facade inspect()", fmtTally(viaFacade));

    const exportMatches = fmtTally(branchTally) === fmtTally(viaFacade);
    const cOk = Object.keys(branchTally).length >= 3 && exportMatches;
    verdict(
      cOk,
      cOk
        ? `三条分支都有计数，且 Facade 的 inspect() 导出的分布与直读 RUN_META 逐条一致` +
            `（覆盖 ${Object.keys(branchTally).length} 条分支）—— Eval 现在真的拿得到这个数`
        : !exportMatches
          ? `Facade 导出与直读 RUN_META 不一致：${fmtTally(viaFacade)} vs ${fmtTally(branchTally)}`
          : `只观测到 ${Object.keys(branchTally).length} 条分支，测量装置不完整`,
    );
    results.push({ name: "测量装置", ok: cOk });

    // ────────────────────────────────────────────── 总判定
    section("总判定");
    const ok = results.every((r) => r.ok);
    verdict(
      ok,
      ok
        ? "真 SIGKILL 下：窗口 A/B 各自可恢复，三条分支各命中，RECOVERY_REQUIRED 闸门有效，配对不变量全程守住，分支分布可导出"
        : "有失败项，见上",
    );
    console.log(
      "\n   关于窗口 C（Blob 已写入但引用消息未落盘）：**本阶段不验**。\n" +
        "   BlobStore 按决 1 推到了阶段 3，当前没有任何工具会产出 Blob ——\n" +
        "   造一个假的 Blob 来测它，测的是假货不是机制。\n",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════ 工具

/** 稳定序：两边用同一个渲染函数，比对的才是内容而不是键序。 */
function fmtTally(c: Record<string, number>): string {
  return Object.keys(c)
    .sort()
    .map((k) => `${k}=${c[k]}`)
    .join(" ");
}

async function readEntries(dbPath: string, runId: RunId): Promise<TranscriptEntry[]> {
  if (!existsSync(dbPath)) return [];
  const db = openDb({ path: dbPath });
  const out = await new SqliteTranscriptStore(db).readAll(runId);
  db.close();
  return out;
}

function messagesOf(entries: TranscriptEntry[]): ContextMessage[] {
  return entries.filter((e) => e.kind === "MESSAGE" && e.message).map((e) => e.message!);
}

/** 从子进程 stdout 里捞 ResumeUnpairedToolUse 的分支名。 */
function pickBranch(stdout: string): string | undefined {
  const m = /@@BRANCH@@(\w+)/.exec(stdout);
  return m?.[1];
}

/** 兜底：从 RUN_META 的分支计数反推本次命中的那一条。 */
function pickBranchFromFacts(entries: TranscriptEntry[]): string | undefined {
  const counts = readRunFacts(entries)?.resumeBranchCounts ?? {};
  const hit = Object.entries(counts).filter(([, v]) => v > 0);
  return hit.length === 1 ? hit[0]![0] : undefined;
}

void runVerify(main);
