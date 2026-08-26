/**
 * verify:persistence —— 阶段 2 批 1 的验收。
 *
 * 验证：**跨进程 resume 是不是真的成立？**
 *
 * 阶段 1 的 `verify:resume` 在**同一个进程内**丢弃 LoopState 后重建，那验的是
 * 「消息级恢复的语义对不对」。这条脚本换了一个问题：进程真的没了之后，
 * 盘上剩下的东西够不够把 Run 接上。
 *
 * 挂了意味着：Roadmap 那句「关掉终端明天再开能接上」不成立 ——
 * 而那是阶段 2 的招牌能力。
 *
 * ── F 段是【已知红】────────────────────────────────────────────────────
 *
 * 批 1 结束时 F 段必然失败，批 2（R-2 墙钟拆分）做完才转绿。这是刻意的：
 * 缺口应当在它被引入的那一批就可见。两个进程挨着跑撞不到 10 分钟墙，
 * 只有把时间推回去才暴露得出来 —— 不专门测，它会一直藏到用户第一次
 * 真的隔夜 resume。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asId,
  findOrphanResults,
  findUnpairedToolUses,
  freezeProfile,
  readRunFacts,
  type ContextMessage,
  type RunId,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import { SqliteRunStore, SqliteTranscriptStore, openDb } from "@workagent/store-sqlite";
import { runSegment } from "@workagent/testkit";
import { banner, fact, section, verdict } from "./harness.js";

const WORKER = resolve(fileURLToPath(new URL(".", import.meta.url)), "workers/run-segment.ts");

/**
 * 五轮脚本，模拟一次完整的崩溃—恢复叙事：
 *
 *   轮 0  list_dir
 *   轮 1  写 a.txt        ← 段 1 在这里被 SIGKILL（写还没发生）
 *   ── 恢复：观察到 a.txt 不存在，把这个事实回灌给模型 ──
 *   轮 2  重写 a.txt      ← 真 Agent 看到「没写成」就会补写，脚本照做
 *   轮 3  写 b.txt
 *   轮 4  收尾
 *
 * 恢复段从轮 2 接着跑（scriptOffset）。**不能从轮 0 重放** ——
 * 那会把已经配过对的 c1 再发一次，模型看到的就是一份失真的世界。
 */
const SCRIPT = [
  { toolCalls: [{ toolCallId: "c1", name: "list_dir", input: { path: "." } }], text: "先看看目录" },
  {
    toolCalls: [{ toolCallId: "c2", name: "write_note", input: { path: "a.txt", content: "第一份" } }],
    text: "写第一份",
  },
  {
    toolCalls: [{ toolCallId: "c3", name: "write_note", input: { path: "a.txt", content: "第一份" } }],
    text: "观察说上次没写成，补写一次",
  },
  {
    toolCalls: [{ toolCallId: "c4", name: "write_note", input: { path: "b.txt", content: "第二份" } }],
    text: "写第二份",
  },
  { toolCalls: [], text: "两份都写好了，任务完成。" },
];

const WALL_LIMIT_MS = 10 * 60_000;

async function main(): Promise<void> {
  banner(
    "verify:persistence —— 跨进程恢复（阶段 2 批 1）",
    "进程真的没了之后，只凭 SQLite 能不能把同一个 Run 接上并跑到终态？",
  );

  const tmp = mkdtempSync(join(tmpdir(), "workagent-persist-"));
  const dbPath = join(tmp, "runs.db");
  const workspace = join(tmp, "ws");
  const tracePath = join(tmp, "run.jsonl");
  const results: Array<{ seg: string; ok: boolean }> = [];

  try {
    // ─────────────────────────────────────────────────────────── A
    section("A. 两个进程接力跑完同一个 Run");
    console.log(
      "   段 1：子进程跑到第 2 个工具执行时给自己发 SIGKILL —— 不可捕获，\n" +
        "         没有 finally、没有 flush，settle-batch 的 finalize() 一行都跑不到。\n" +
        "   段 2：另一个子进程只拿 runId 和库路径，把它接着跑完。\n",
    );

    const seg1 = runSegment({
      workerPath: WORKER,
      dbPath,
      workspace,
      tracePath,
      mode: "start",
      script: SCRIPT,
      killAt: "AttemptStarted#2",
    });

    fact("段 1 被 SIGKILL", seg1.killed ? "是" : `否（exit=${seg1.exitCode}）`);
    if (!seg1.killed) {
      // kill 没触发就等于这条脚本什么都没验 —— 段 1 跑完了，段 2 只会撞终态闸门。
      // 让它当场炸，不要让「事件名写错」表现成「恢复失败」。
      verdict(false, "段 1 没有被 kill —— --kill-at 的事件类型没匹配上，本次验收无效");
      process.exit(1);
    }
    fact("段 1 死在", seg1.killedAt ? `${seg1.killedAt.at} @seq ${seg1.killedAt.sequence}` : "—");
    fact("段 1 runId", seg1.runId || `（拿不到）${seg1.error ?? ""}`);
    if (!seg1.runId) {
      verdict(false, `段 1 没跑起来：${seg1.error ?? "未知"}`);
      process.exit(1);
    }
    const runId = asId<RunId>(seg1.runId);

    const afterCrash = await readEntries(dbPath, runId);
    const unpairedAfterCrash = findUnpairedToolUses(messagesOf(afterCrash));
    fact("崩溃后 transcript 条目", afterCrash.length);
    fact("崩溃后未配对 tool_use", unpairedAfterCrash.length);
    console.log(
      "   ↑ 这个未配对项正是 §18.2 的窗口 A/B：盘上分不出「工具跑没跑」，\n" +
        "     所以下一段必须走三条分支之一，而不是想当然地重试。\n",
    );

    const seg2 = runSegment({
      workerPath: WORKER,
      dbPath,
      workspace,
      tracePath,
      mode: "resume",
      runId: String(runId),
      script: SCRIPT,
      // 段 1 消费了第 0、1 轮，恢复处置完未配对项之后从第 2 轮接着来。
      // 不传的话新进程会从第 0 轮重放，把 c1 这个已经配过对的 id 再发一次。
      scriptOffset: 2,
    });

    fact("段 2 terminal", seg2.terminal ?? `（无）${seg2.error ?? ""}`);
    fact("段 2 outcome", seg2.outcome ?? "（无）");

    // 终态标签之外还要看**外部世界**：崩溃前那次写没发生，恢复后补上了没有。
    const aTxt = join(workspace, "a.txt");
    const bTxt = join(workspace, "b.txt");
    fact("a.txt（崩溃点那次写）", existsSync(aTxt) ? `存在：${readFileSync(aTxt, "utf8")}` : "缺失");
    fact("b.txt（恢复后那次写）", existsSync(bTxt) ? `存在：${readFileSync(bTxt, "utf8")}` : "缺失");

    const aOk =
      seg1.killed &&
      unpairedAfterCrash.length > 0 &&
      (seg2.terminal === "COMPLETED" || seg2.terminal === "COMPLETED_WITH_LIMITS") &&
      existsSync(aTxt) &&
      existsSync(bTxt);
    verdict(
      aOk,
      aOk
        ? "两个进程接力把 Run 跑到终态，且两份产物都在磁盘上 —— 崩溃点那次写由恢复观察发现「没发生」并被补上"
        : `跨进程恢复没走通（killed=${seg1.killed} unpaired=${unpairedAfterCrash.length} terminal=${seg2.terminal} a=${existsSync(aTxt)} b=${existsSync(bTxt)}）`,
    );
    results.push({ seg: "A", ok: aOk });

    if (seg2.outcome === "COMPLETED_WITH_LIMITS") {
      console.log(
        "\n   \x1b[33m记一笔（本批不修，属决 6 的范围）\x1b[0m：两份产物都正确落盘了，\n" +
          "   outcome 却是 COMPLETED_WITH_LIMITS。原因是恢复时那次「观察到 a.txt 不存在」\n" +
          "   被当成一条**失败的 required Verification** 记进了事实表，而结算只查事实表\n" +
          "   （§10.4【定】），于是模型随后补写成功也翻不了案。\n" +
          "   这正是决 6 要拆的那个混用：「执行后验证失败」与「崩溃后观察到没发生」\n" +
          "   是两件事，现在共用一条记录。修在批 3 的 S11。",
      );
    }

    // ─────────────────────────────────────────────────────────── B
    section("B. D-2：两条序列跨进程仍然是一条");
    const entries = await readEntries(dbPath, runId);
    const seqs = entries.map((e) => e.sequence);
    const traceSeqs = readTraceEventSeqs(tracePath);
    const union = [...seqs, ...traceSeqs].sort((a, b) => a - b);
    const dup = union.filter((v, i) => i > 0 && v === union[i - 1]);
    const contiguous = union.every((v, i) => i === 0 || v === union[i - 1]! + 1);

    fact("transcript 条目号", `${seqs.length} 个：${summarize(seqs)}`);
    fact("事件号（两段合计）", `${traceSeqs.length} 个：${summarize(traceSeqs)}`);
    fact("并集范围", union.length ? `1..${union[union.length - 1]}` : "—");
    fact("重号", dup.length);
    fact("并集连续", contiguous ? "是" : "否");
    const bOk = dup.length === 0 && contiguous && traceSeqs.length > 0 && union[0] === 1;
    verdict(
      bOk,
      bOk
        ? "跨进程之后两条轨道仍是同一条单调序列：零重号、并集连续 —— 崩溃没有让计数器回退去重发已用掉的号"
        : "序列在跨进程处断了（重号或不连续）",
    );
    results.push({ seg: "B", ok: bOk });

    // ─────────────────────────────────────────────────────────── C
    section("C. 不变量 8：没有无 result 的 tool_use");
    const msgs = messagesOf(entries);
    const unpaired = findUnpairedToolUses(msgs);
    const orphans = findOrphanResults(msgs);
    fact("最终未配对 tool_use", unpaired.length);
    fact("最终 orphan result", orphans.length);
    const cOk = unpaired.length === 0 && orphans.length === 0;
    verdict(
      cOk,
      cOk
        ? "恢复过程补齐了崩溃点留下的未配对 tool_use，最终 transcript 配对完好"
        : `配对被破坏（未配对 ${unpaired.length} / orphan ${orphans.length}）`,
    );
    results.push({ seg: "C", ok: cOk });

    // ─────────────────────────────────────────────────────────── D
    section("D. §18.5：schemaVersion 不兼容时逐条降级，不是整份失效");
    const db = openDb({ path: dbPath });
    const store = new SqliteTranscriptStore(db);
    const before = (await store.rebuildMessages(runId)).length;
    await store.append({
      runId,
      schemaVersion: 999,
      kind: "MESSAGE",
      message: { role: "user", turn: 99, content: [{ type: "text", text: "来自未来的格式" }] },
      createdAt: Date.now(),
    });
    const after = (await store.rebuildMessages(runId)).length;
    const stillThere = (await store.readAll(runId)).some((e) => e.schemaVersion === 999);
    db.close();

    fact("插入 schemaVersion=999 前", `${before} 条消息`);
    fact("插入后重建", `${after} 条消息`);
    fact("该条目仍在 readAll 里", stillThere ? "是" : "否");
    const dOk = after === before && stillThere;
    verdict(
      dOk,
      dOk
        ? "未来格式的条目被重建器跳过，而不是让整份 transcript 失效；同时它仍留在 readAll 里供 Trace 与 Replay 看见 —— 这正是日志方案相对 Snapshot 的收益"
        : "schemaVersion 逐条降级语义不成立",
    );
    results.push({ seg: "D", ok: dOk });

    // ─────────────────────────────────────────────────────────── E
    section("E. M-4：RunSpec 能原样读回 ＋ 深冻结逐层生效");
    const db2 = openDb({ path: dbPath });
    const runs = new SqliteRunStore(db2);
    const spec = await runs.getRunSpec(runId);
    const listed = await runs.list();
    db2.close();

    const layers = probeFrozenLayers();
    fact("RunSpec 读回", spec ? "成功" : "失败");
    fact("toolSnapshots 数", spec?.agentSpec.toolSnapshots.length ?? 0);
    fact("agentSpec.timezone", spec?.agentSpec.timezone ?? "—");
    fact("--list-runs 可见", `${listed.length} 个 Run，状态 ${listed[0]?.status ?? "—"}`);
    fact("深冻结逐层写入被拒", `${layers.frozen}/${layers.total}`);
    console.log(
      "   ↑ 浅冻结（阶段 1 的写法）在第 2 层就会静默放过写入。\n" +
        "     RunSpec 落库之后这条不能再含糊：盘上那份是快照，内存那份若还能改，\n" +
        "     §18.3 的「声明是否仍与冻结版一致」就变成了自己跟自己比。\n",
    );
    const eOk =
      !!spec &&
      (spec.agentSpec.toolSnapshots.length ?? 0) > 0 &&
      layers.frozen === layers.total &&
      listed.length === 1;
    verdict(
      eOk,
      eOk
        ? "冻结的 RunSpec 原样读回（含 toolSnapshots —— 三条恢复分支的判定依据），深冻结每一层都拒写"
        : `M-4 未达成：spec=${!!spec} 冻结 ${layers.frozen}/${layers.total} runs=${listed.length}`,
    );
    results.push({ seg: "E", ok: eOk });

    // ─────────────────────────────────────────────────────────── F
    section("F. 【已知红·批 2 转绿】跨天 resume 不得因关机时间撞预算墙");
    const facts = readRunFacts(entries);
    const startedAt = facts?.budgetUsage.startedAt ?? 0;
    const active = facts?.budgetUsage.activeWallClockMs ?? 0;
    /**
     * 主循环判的是 `now() - state.budgetUsage.startedAt`（run-loop.ts:261），
     * 而 `startedAt` 由 RUN_META 原样继承。所以「12 小时后 resume」时
     * elapsed 会是 12 小时，远超 10 分钟的 maxActiveWallClockMs。
     */
    const elapsedIfResumedTomorrow = Date.now() + 12 * 3600_000 - startedAt;
    fact("RUN_META.startedAt", new Date(startedAt).toISOString());
    fact("累计 activeWallClockMs", `${active} ms`);
    fact("若 12 小时后 resume，elapsed", `${Math.round(elapsedIfResumedTomorrow / 1000)} s`);
    fact("maxActiveWallClockMs", `${WALL_LIMIT_MS} ms`);
    const fOk = active <= WALL_LIMIT_MS && elapsedIfResumedTomorrow > WALL_LIMIT_MS ? isActiveBased() : false;
    verdict(
      fOk,
      fOk
        ? "预算判定基于累计 active 而非墙上时间差 —— 跨天 resume 不会因为关机的那 12 小时撞墙"
        : "【已知红】判定仍是 now() - startedAt，关机时间被算进 active，" +
            "隔夜 resume 会在第一次迭代就 BUDGET_EXHAUSTED —— 这正是 R-2，由批 2 的 S7 修",
    );
    results.push({ seg: "F", ok: fOk });

    // ─────────────────────────────────────────────────────────── G
    section("G. N-1：跨进程的 Trace 是一个文件，段号连续");
    const segs = readTraceSegments(tracePath);
    fact("trace 文件", existsSync(tracePath) ? "1 个" : "缺失");
    fact("header 段号", segs.headers.join(", ") || "（无）");
    fact("footer 段号", segs.footers.join(", ") || "（无）");
    console.log(
      "   ↑ 修之前文件按**进程启动时间**命名，一个 Run 跨三个进程就是三份互不\n" +
        "     相干的 JSONL。而「Trace 是可审计的唯一 artifact」这个说法，\n" +
        "     在文件分裂之后自己就不成立了 —— 那正是本批用它否掉九张事实表的理由。\n",
    );
    const gOk = segs.headers.length === 2 && segs.headers[0] === 0 && segs.headers[1] === 1;
    verdict(
      gOk,
      gOk
        ? "两个进程的事件写进了同一个文件，段号 0、1 连续 —— 一个 Run 一份可审计轨迹"
        : `Trace 没有正确续写（headers=${JSON.stringify(segs.headers)}）`,
    );
    results.push({ seg: "G", ok: gOk });

    // ─────────────────────────────────────────────────────── 总判定
    section("总判定");
    const hard = results.filter((r) => r.seg !== "F");
    const hardOk = hard.every((r) => r.ok);
    const fSeg = results.find((r) => r.seg === "F")?.ok ?? false;
    verdict(
      hardOk,
      hardOk
        ? "跨进程恢复成立：真 SIGKILL 之后另一个进程只凭 SQLite 接上并跑到终态，" +
            "序列、配对、schema 降级、深冻结、Trace 续写全部守住"
        : `批 1 硬判据有失败：${hard.filter((r) => !r.ok).map((r) => r.seg).join(" ")}`,
    );
    console.log(
      `\n   F 段（跨天 resume）：${
        fSeg ? "\x1b[32m已转绿\x1b[0m" : "\x1b[33m已知红 —— 待批 2 的 S7（R-2 墙钟拆分）\x1b[0m"
      }`,
    );

    process.exit(hardOk ? 0 : 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════ 读取工具

async function readEntries(dbPath: string, runId: RunId): Promise<TranscriptEntry[]> {
  const db = openDb({ path: dbPath });
  const out = await new SqliteTranscriptStore(db).readAll(runId);
  db.close();
  return out;
}

function messagesOf(entries: TranscriptEntry[]): ContextMessage[] {
  return entries.filter((e) => e.kind === "MESSAGE" && e.message).map((e) => e.message!);
}

function summarize(ns: number[]): string {
  if (ns.length === 0) return "—";
  if (ns.length <= 12) return ns.join(",");
  return `${ns.slice(0, 6).join(",")} … ${ns.slice(-3).join(",")}`;
}

function readTraceLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* 坏行忽略：JSONL 对 kill 安全的代价就是可能有半行 */
    }
  }
  return out;
}

function readTraceEventSeqs(path: string): number[] {
  return readTraceLines(path)
    .filter((o) => o["kind"] === "event" && typeof o["sequence"] === "number")
    .map((o) => o["sequence"] as number);
}

function readTraceSegments(path: string): { headers: number[]; footers: number[] } {
  const lines = readTraceLines(path);
  return {
    headers: lines.filter((o) => o["kind"] === "header").map((o) => (o["segmentIndex"] as number) ?? -1),
    footers: lines.filter((o) => o["kind"] === "footer").map((o) => (o["segmentIndex"] as number) ?? -1),
  };
}

/**
 * 探测深冻结覆盖到几层。
 *
 * 不能拿读回来的 spec 试写 —— 那是反序列化产生的新对象，本来就没冻。
 * 这里现造一个同构的嵌套结构走一遍 `freezeProfile()`：浅冻结在第 2 层
 * 就会静默放过，深冻结每一层都拒。
 */
function probeFrozenLayers(): { frozen: number; total: number } {
  const sample = freezeProfile({
    id: "p",
    endpointId: "e",
    shape: "ANTHROPIC_MESSAGES",
    modelId: "m",
    protocol: { validatesToolResultPairing: false },
    context: { hardInputLimitTokens: 1 },
    tokens: { usageFieldMap: { input: "input_tokens" } },
    errors: { discriminators: [{ code: "X" }] },
    sourceEvidenceRefs: ["r1"],
  } as never) as unknown as Record<string, unknown>;

  const writes: Array<[string, () => void]> = [
    ["第 1 层标量", () => (sample["modelId"] = "changed")],
    ["第 2 层对象", () => ((sample["protocol"] as Record<string, unknown>)["validatesToolResultPairing"] = true)],
    [
      "第 3 层嵌套对象",
      () =>
        ((sample["tokens"] as Record<string, Record<string, unknown>>)["usageFieldMap"]!["input"] = "changed"),
    ],
    ["数组 push", () => ((sample["sourceEvidenceRefs"] as unknown[]).push("r2"))],
    [
      "数组内对象",
      () =>
        (((sample["errors"] as Record<string, Array<Record<string, unknown>>>)["discriminators"]![0] as Record<
          string,
          unknown
        >)["code"] = "changed"),
    ],
  ];

  let frozen = 0;
  for (const [, w] of writes) {
    try {
      w();
    } catch {
      frozen += 1; // ESM 是 strict mode，写冻结对象抛 TypeError
    }
  }
  return { frozen, total: writes.length };
}

/**
 * 预算判定是不是基于「累计 active」而不是「now − startedAt」。
 *
 * 判据落在源码上而不是行为上，是因为要在**不真的等 12 小时**的前提下
 * 回答这个问题。R-2 修完后 run-loop 里那行会从 `now() - startedAt`
 * 变成读累计值，届时这里返回 true，F 段自动转绿。
 */
function isActiveBased(): boolean {
  const src = readFileSync(
    resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../packages/harness-runtime/src/loop/run-loop.ts"),
    "utf8",
  );
  return !/const elapsed = now\(\) - state\.budgetUsage\.startedAt/.test(src);
}

void main();
