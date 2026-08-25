/**
 * CLI 入口（V05 §5）。
 *
 * 阶段 1 没有图形界面 —— 那是阶段 4。
 * 但「不是不能交互」：Approval / Interject / Cancel 都在阶段 1 范围内，
 * 所以终端必须能停下来问、能中途插话、能 Ctrl+C。
 *
 *   npm run dev -- --task "统计 ./notes 下有几个文件，写一份 summary.txt"
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type {
  ApprovalDecider,
  PreparedAction,
  RunEvent,
  TraceSinkPort,
  TranscriptEntry,
} from "@workagent/harness-runtime";
import { NullTraceSink, readRunFacts } from "@workagent/harness-runtime";
import { compose, REPO_ROOT } from "./compose.js";
import { FileTraceSink } from "./trace/file-sink.js";
import { finishRendering, renderEvent } from "./render.js";

interface Args {
  task: string;
  workspace: string;
  yes: boolean;
  trace: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    task: get("task") ?? "看看 workspace 根目录里有什么，然后写一份 summary.txt 说明你看到了什么。",
    workspace: resolve(get("workspace") ?? resolve(REPO_ROOT, ".workagent-workspace")),
    yes: argv.includes("--yes"),
    /**
     * 【定】默认开着。
     *
     * 评测报告的原话是「若外部评测器没有像本次这样主动捕获 stdout，轨迹会丢失」——
     * 默认关闭等于把「记不记录」这个决定推给每一个使用者，而忘记开的那次
     * 恰恰是最想回看的那次。要关就显式 --no-trace。
     */
    trace: argv.includes("--no-trace")
      ? undefined
      : (get("trace") ??
        resolve(REPO_ROOT, ".workagent-runs", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)),
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
 * 交互式审批。
 *
 * 与验收脚本注入的 scripted decider 是同一个接口 —— 这正是把它做成
 * 注入点而不是 Runtime 内建的理由（V05 §14.3）：
 * 验收脚本必须能无人值守跑完。
 */
function interactiveApproval(autoYes: boolean): ApprovalDecider {
  if (autoYes) {
    return async (a: PreparedAction) => {
      console.log(`  (--yes) 自动批准 ${a.toolName}`);
      return { approved: true };
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return async (a: PreparedAction) => {
    const e = a.resolvedEffect;
    finishRendering();
    const ans = (
      await rl.question(
        `\n  是否允许 ${a.toolName} 执行 ${e.effectType} → ${e.scope.value} ？[y/N] `,
      )
    )
      .trim()
      .toLowerCase();
    return ans === "y" || ans === "yes"
      ? { approved: true }
      : { approved: false, reason: "用户在终端拒绝" };
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.workspace, { recursive: true });

  console.log(`workspace: ${args.workspace}`);

  // thunk 只在第一个事件到达时被读，那时下面这两个变量都已赋值。
  let profileRef = "unknown";
  let modelId = "unknown";
  const fileSink = args.trace
    ? new FileTraceSink(args.trace, () => ({
        commit: gitCommit(),
        endpointProfile: profileRef,
        modelId,
        task: args.task,
        workspaceRoot: args.workspace,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        startedAt: new Date().toISOString(),
      }))
    : undefined;
  const trace: TraceSinkPort = fileSink ?? new NullTraceSink();

  const composed = compose({
    workspaceRoot: args.workspace,
    approvalDecider: interactiveApproval(args.yes),
    trace,
  });
  profileRef = `${composed.profile.id}@${composed.profile.observedAt}`;
  modelId = composed.profile.modelId;

  for (const n of composed.notices) console.log(`⚠️  ${n}\n`);

  const spec = composed.makeRunSpec(args.task);

  if (args.trace) console.log(`trace    : ${args.trace}`);
  console.log();
  const gen = composed.runtime.start(spec);

  // Ctrl+C → cancel。单个 AbortController 传播到所有 Port（V05 §9.1）。
  let runId = "";
  process.on("SIGINT", () => {
    console.log("\n\n收到 Ctrl+C，正在协作式取消……（未启动的工具会合成 SKIPPED result）");
    if (runId) composed.runtime.cancel(runId as never, "SIGINT");
  });

  let r = await gen.next();
  while (!r.done) {
    const e: RunEvent = r.value;
    if (!runId) runId = String(e.runId);
    renderEvent(e);
    r = await gen.next();
  }
  finishRendering();

  const { terminal, outcome } = r.value;
  console.log(`\n${"─".repeat(60)}`);
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
    for (const i of terminal.recoveryItems) console.log(`  - ${i.what}（${i.sideEffectState}）`);
  }
  if (outcome && outcome.incompleteItems.length > 0) {
    console.log("未完成项：");
    for (const i of outcome.incompleteItems) console.log(`  - ${i.what}：${i.why}`);
  }
  if (outcome && outcome.recoveryItems.length > 0) {
    console.log("状态未知项（需人工确认）：");
    for (const i of outcome.recoveryItems) console.log(`  - ${i.what}（${i.sideEffectState}）`);
  }

  const entries = await composed.ports.transcript.readAll(runId as never);
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
