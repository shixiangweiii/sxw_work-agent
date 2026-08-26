/**
 * CLI 入口（V05 §5）。
 *
 * 阶段 1 没有图形界面 —— 那是阶段 4。
 * 但「不是不能交互」：Approval / Interject / Cancel 都在阶段 1 范围内，
 * 所以终端必须能停下来问、能中途插话、能 Ctrl+C。
 *
 * 阶段 2 补上了跨进程的那一半 —— 三条恢复分支（§18.2）在此之前
 * **在真实使用里一条都走不到**，因为没有任何入口能触发 resume：
 *
 *   npm run dev -- --task "统计 ./notes 下有几个文件，写一份 summary.txt"
 *   npm run dev -- --list-runs
 *   npm run dev -- --resume run_xxx
 *   npm run dev -- --resume run_xxx --recovery-decision CONTINUE --recovery-note "已人工确认"
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type {
  ApprovalDecider,
  PreparedAction,
  RunEvent,
  RunId,
  TraceSinkPort,
  TranscriptEntry,
} from "@workagent/harness-runtime";
import { NullTraceSink, asId, readRunFacts } from "@workagent/harness-runtime";
import { SqliteRunStore, openDb } from "@workagent/store-sqlite";
import { isInsideWorkspace } from "@workagent/micro-cases";
import { compose, REPO_ROOT, resolveDbPath } from "./compose.js";
import { FileTraceSink } from "./trace/file-sink.js";
import { finishRendering, renderEvent } from "./render.js";

type Mode = "start" | "resume" | "list";

interface Args {
  mode: Mode;
  task: string;
  workspace: string;
  yes: boolean;
  /** 显式的「批准一切」。见 interactiveApproval 里 E-3 那段说明。 */
  yesAll: boolean;
  /** undefined = --no-trace；string = 显式 --trace 路径；"auto" = 按 runId 定名 */
  trace: string | undefined;
  dbPath: string;
  runId: string;
  recoveryDecision: "CONTINUE" | "ABORT" | undefined;
  recoveryNote: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const resumeId = get("resume");
  const mode: Mode = argv.includes("--list-runs") ? "list" : resumeId ? "resume" : "start";

  const decision = get("recovery-decision");
  if (decision !== undefined && decision !== "CONTINUE" && decision !== "ABORT") {
    throw new Error(`--recovery-decision 只能是 CONTINUE 或 ABORT，收到：${decision}`);
  }

  return {
    mode,
    task: get("task") ?? "看看 workspace 根目录里有什么，然后写一份 summary.txt 说明你看到了什么。",
    workspace: resolve(get("workspace") ?? resolve(REPO_ROOT, ".workagent-workspace")),
    yes: argv.includes("--yes") || argv.includes("--yes-all"),
    yesAll: argv.includes("--yes-all"),
    /**
     * 【定】默认开着。
     *
     * 评测报告的原话是「若外部评测器没有像本次这样主动捕获 stdout，轨迹会丢失」——
     * 默认关闭等于把「记不记录」这个决定推给每一个使用者，而忘记开的那次
     * 恰恰是最想回看的那次。要关就显式 --no-trace。
     */
    trace: argv.includes("--no-trace") ? undefined : (get("trace") ?? "auto"),
    dbPath: resolveDbPath(get("db")),
    runId: resumeId ?? "",
    recoveryDecision: decision as Args["recoveryDecision"],
    recoveryNote: get("recovery-note"),
  };
}

/** 当前 commit。取不到就如实写 unknown，不要猜 —— artifact 的价值全在可复核。 */
function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * 工作树是否有未提交改动（E-5）。
 *
 * 复评报告的具体教训：一份开发自测 trace 的 header 记着 commit `012717d`，
 * 而实际运行时工作树包含尚未提交的修复 —— **没有这个标志位，
 * 「旧 commit ＋ 未提交改动」在 artifact 里看起来就是「旧 commit」**。
 */
function gitDirty(): boolean | "unknown" {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).trim().length > 0;
  } catch {
    return "unknown";
  }
}

/**
 * 交互式审批。
 *
 * 与验收脚本注入的 scripted decider 是同一个接口 —— 这正是把它做成
 * 注入点而不是 Runtime 内建的理由（V05 §14.3）：
 * 验收脚本必须能无人值守跑完。
 */
function interactiveApproval(
  autoYes: boolean,
  yesAll: boolean,
  workspaceRoot: string,
  signal: AbortSignal,
): ApprovalDecider {
  /**
   * ── E-3：`--yes` 不再是「批准一切」──────────────────────────────────
   *
   * 原实现对模型后续提出的**任何** PreparedAction 一律放行。复评报告的
   * 措辞是「应增加基于 effect、路径和 operation 的有限 auto-grant，
   * 并在执行前用 realpath/lstat 重新校验」。
   *
   * 现在 `--yes` 的语义是「**workspace 内的可逆写，我事先同意**」——
   * 三条都要满足才自动放行：
   *   ① 作用域落在 workspace 内（realpath 之后，与 R-5 同一道判定）；
   *   ② 可逆（覆盖写可逆；追加、删除不可逆）；
   *   ③ 不是 EXECUTE。
   *
   * 不满足的仍然停下来问。真要恢复旧的「批准一切」，得显式写 `--yes-all` ——
   * 让那个决定有名字，而不是藏在一个看起来很无害的 `--yes` 后面。
   */
  if (yesAll) {
    return async (a: PreparedAction) => {
      console.log(`  \x1b[33m(--yes-all) 无条件批准\x1b[0m ${a.toolName} → ${a.resolvedEffect.effectType}`);
      return { approved: true };
    };
  }

  const autoGrant = (a: PreparedAction): { ok: true } | { ok: false; why: string } => {
    const e = a.resolvedEffect;
    if (e.effectType === "EXECUTE") return { ok: false, why: "EXECUTE 类操作不在 --yes 的授权范围内" };
    if (e.reversibility !== "REVERSIBLE") {
      return { ok: false, why: `${e.reversibility}（不可逆操作需要逐次确认）` };
    }
    // 【定】执行前用 realpath 重新校验一次，与工具内部那道是同一个判定。
    // 授权是在「决定的那一刻」给的，而路径可能在那之后被换掉。
    if (e.scope.kind === "FILE" || e.scope.kind === "DIRECTORY") {
      const target = resolve(workspaceRoot, e.scope.value);
      if (!isInsideWorkspace(workspaceRoot, target)) {
        return { ok: false, why: `作用域 ${e.scope.value} 不在 workspace 内（realpath 后判定）` };
      }
    }
    return { ok: true };
  };

  if (autoYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return async (a: PreparedAction) => {
      const grant = autoGrant(a);
      const e = a.resolvedEffect;
      if (grant.ok) {
        console.log(`  (--yes) 自动批准 ${a.toolName} → ${e.effectType} ${e.scope.value}`);
        return { approved: true };
      }
      finishRendering();
      console.log(`  \x1b[33m--yes 不覆盖这一步\x1b[0m：${grant.why}`);
      const ans = (
        await rl.question(`  是否允许 ${a.toolName} 执行 ${e.effectType} → ${e.scope.value} ？[y/N] `, {
          signal,
        })
      )
        .trim()
        .toLowerCase();
      return ans === "y" || ans === "yes"
        ? { approved: true }
        : { approved: false, reason: "用户在终端拒绝" };
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return async (a: PreparedAction) => {
    const e = a.resolvedEffect;
    finishRendering();
    /**
     * U-2 / R-2 的一半：`rl.question` 接上 signal。
     *
     * 在此之前 Ctrl+C 打不断审批等待 —— 用户得再敲一次回车才轮得到取消生效。
     * 这条和「等审批的时间被计入 active 墙钟」是同一条路径上的两个缺口。
     */
    const ans = (
      await rl.question(
        `\n  是否允许 ${a.toolName} 执行 ${e.effectType} → ${e.scope.value} ？[y/N] `,
        { signal },
      )
    )
      .trim()
      .toLowerCase();
    return ans === "y" || ans === "yes"
      ? { approved: true }
      : { approved: false, reason: "用户在终端拒绝" };
  };
}

/** `--list-runs`：只读一张表，不需要模型也不需要凭证。 */
function listRuns(dbPath: string): void {
  // 库还不存在时先把目录建出来 —— 第一次跑就 --list-runs 是个很自然的动作，
  // 而 SQLite 对着一个不存在的目录只会甩一句 "unable to open database file"。
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb({ path: dbPath });
  const store = new SqliteRunStore(db);
  void store.list(50).then((rows) => {
    if (rows.length === 0) {
      console.log(`（库里还没有 Run）\n库：${dbPath}`);
      return;
    }
    console.log(`库：${dbPath}\n`);
    console.log(
      ["RunId".padEnd(22), "状态".padEnd(20), "更新时间".padEnd(20), "任务"].join(" "),
    );
    console.log("─".repeat(100));
    for (const r of rows) {
      console.log(
        [
          String(r.runId).padEnd(22),
          r.status.padEnd(20),
          new Date(r.updatedAt).toLocaleString().padEnd(20),
          r.task.length > 40 ? `${r.task.slice(0, 40)}…` : r.task,
        ].join(" "),
      );
    }
    console.log(
      `\n可恢复的状态：CANCELLED / RECOVERY_REQUIRED / RUNNING（上次崩了）。` +
        `\n  npm run dev -- --resume <RunId>`,
    );
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "list") {
    listRuns(args.dbPath);
    return;
  }

  mkdirSync(args.workspace, { recursive: true });
  console.log(`workspace: ${args.workspace}`);
  console.log(`db       : ${args.dbPath}`);

  // Ctrl+C 的传播源。审批等待也挂在它上面（U-2）。
  const sigint = new AbortController();

  // thunk 只在第一个事件到达时被读，那时下面这两个变量都已赋值。
  let profileRef = "unknown";
  let modelId = "unknown";
  const fileSink = args.trace
    ? new FileTraceSink(
        // N-1：文件名按 runId 定，resume 往同一个文件续写下一段。
        // 显式 --trace 时听用户的，那是「我要这一段单独存一份」的意思。
        (runId) =>
          args.trace === "auto"
            ? resolve(REPO_ROOT, ".workagent-runs", `${runId}.jsonl`)
            : resolve(args.trace!),
        () => ({
          commit: gitCommit(),
          gitDirty: gitDirty(),
          nodeVersion: process.version,
          endpointProfile: profileRef,
          modelId,
          task: args.task,
          workspaceRoot: args.workspace,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          startedAt: new Date().toISOString(),
        }),
      )
    : undefined;
  const trace: TraceSinkPort = fileSink ?? new NullTraceSink();

  const composed = compose({
    workspaceRoot: args.workspace,
    approvalDecider: interactiveApproval(args.yes, args.yesAll, args.workspace, sigint.signal),
    trace,
    dbPath: args.dbPath,
  });
  profileRef = `${composed.profile.id}@${composed.profile.observedAt}`;
  modelId = composed.profile.modelId;

  for (const n of composed.notices) console.log(`⚠️  ${n}\n`);

  let runId = args.runId;
  let gen: AsyncGenerator<RunEvent, { terminal: unknown; outcome?: unknown }>;

  if (args.mode === "resume") {
    const snapshot = await composed.runtime.inspect(asId<RunId>(runId));
    if (!snapshot) {
      console.error(`\n找不到 Run ${runId}。用 --list-runs 看看库里有什么。`);
      process.exit(1);
    }
    console.log(`resume   : ${runId}（上次状态 ${snapshot.status}，已跑 ${snapshot.turnCount} 轮）\n`);
    gen = composed.runtime.resume(asId<RunId>(runId), {
      ...(args.recoveryDecision ? { recoveryDecision: args.recoveryDecision } : {}),
      ...(args.recoveryNote ? { recoveryNote: args.recoveryNote } : {}),
    }) as typeof gen;
  } else {
    console.log();
    gen = composed.runtime.start(composed.makeRunSpec(args.task)) as typeof gen;
  }

  // Ctrl+C → cancel。单个 AbortController 传播到所有 Port（V05 §9.1）。
  process.on("SIGINT", () => {
    console.log("\n\n收到 Ctrl+C，正在协作式取消……（未启动的工具会合成 SKIPPED result）");
    sigint.abort();
    if (runId) composed.runtime.cancel(asId<RunId>(runId), "SIGINT");
  });

  let r = await gen.next();
  while (!r.done) {
    const e: RunEvent = r.value;
    if (!runId) runId = String(e.runId);
    renderEvent(e);
    r = await gen.next();
  }
  finishRendering();

  const { terminal, outcome } = r.value as {
    terminal: { reason: string; recoveryItems?: Array<{ what: string; sideEffectState: string }> };
    outcome?: {
      kind: string;
      summary?: string;
      incompleteItems: Array<{ what: string; why: string }>;
      recoveryItems: Array<{ what: string; sideEffectState: string }>;
    };
  };

  console.log(`\n${"─".repeat(60)}`);
  console.log(`RunId   : ${runId}`);
  console.log(`Terminal: ${terminal.reason}`);
  // outcome 缺席只有一种情况：停在 RECOVERY_REQUIRED 这个非终态上 ——
  // Run 没结束，自然没有结果可结算。
  console.log(`Outcome : ${outcome?.kind ?? "（未结算：Run 停在非终态）"}`);
  // R-7：kind 只说了「算不算成功」，summary 才说了「究竟发生了什么」。
  // 少了这一行，模型明确拒绝任务的那种 Run，用户看到的只有一个 SUCCESS。
  if (outcome?.summary) {
    console.log(`Summary : ${outcome.summary}`);
  }
  if (terminal.reason === "RECOVERY_REQUIRED") {
    console.log("需要人工确认后才能继续：");
    for (const i of terminal.recoveryItems ?? []) console.log(`  - ${i.what}（${i.sideEffectState}）`);
    console.log(
      `\n人工确认外部状态后，带决策继续：\n` +
        `  npm run dev -- --resume ${runId} --recovery-decision CONTINUE --recovery-note "..."\n` +
        `  npm run dev -- --resume ${runId} --recovery-decision ABORT`,
    );
  }
  if (outcome && outcome.incompleteItems.length > 0) {
    console.log("未完成项：");
    for (const i of outcome.incompleteItems) console.log(`  - ${i.what}：${i.why}`);
  }
  if (outcome && outcome.recoveryItems.length > 0) {
    console.log("状态未知项（需人工确认）：");
    for (const i of outcome.recoveryItems) console.log(`  - ${i.what}（${i.sideEffectState}）`);
  }

  const entries = await composed.ports.transcript.readAll(asId<RunId>(runId));
  console.log(`transcript: ${entries.length} 条`);

  /**
   * footer 把「跑完之后的事实」补进 artifact：终止原因、outcome、以及从
   * transcript 的 RUN_META 读回的预算使用。
   *
   * 为什么预算要从 transcript 读而不是从事件流里凑：事件流里的 usage 是逐次的，
   * 累计量的权威副本在 RUN_META 里（A-7 之后就是这样）。凑出来的数和权威副本
   * 万一对不上，事后没人分得清哪个是对的。
   */
  if (fileSink) {
    fileSink.finish({
      terminal,
      outcome: outcome ?? null,
      transcriptEntries: entries.length,
      /**
       * transcript 条目占用的序号（D-2 的可核对形态）。
       *
       * 事件不落 transcript，所以事件流里会有空洞；把 transcript 这一侧的号
       * 也写进 artifact，两条轨道就能只凭这一个文件对齐 ——
       * 空洞应当恰好被这个列表填满，既不重号也不缺号。
       */
      transcriptSequences: entries.map((e) => e.sequence),
      budgetUsage: readLastBudget(entries),
      finishedAt: new Date().toISOString(),
    });
    console.log(`trace     : ${fileSink.filePath}`);
  }

  process.exit(0);
}

/**
 * 从 transcript 的最后一条 RUN_META 读回累计预算。
 *
 * 用 readRunFacts() 而不是在这里重新解析 —— 判别键（RUN_FACTS_META_KIND）
 * 是 Runtime 的知识，CLI 复制一份就会在 schema 变化时悄悄读到旧格式。
 */
function readLastBudget(entries: TranscriptEntry[]): unknown {
  return readRunFacts(entries)?.budgetUsage ?? null;
}

main().catch((err) => {
  console.error(`\n启动失败：${(err as Error).message}`);
  process.exit(1);
});
