/**
 * CLI 入口（V05 §5）。
 *
 * 阶段 1 没有图形界面 —— 那是阶段 4。
 * 但「不是不能交互」：Approval / Interject / Cancel 都在阶段 1 范围内，
 * 所以终端必须能停下来问、能中途插话、能 Ctrl+C。
 *
 *   npm run dev -- --task "统计 ./notes 下有几个文件，写一份 summary.txt"
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ApprovalDecider, PreparedAction, RunEvent } from "@workagent/harness-runtime";
import { NullTraceSink } from "@workagent/harness-runtime";
import { compose, REPO_ROOT } from "./compose.js";
import { finishRendering, renderEvent } from "./render.js";

interface Args {
  task: string;
  workspace: string;
  yes: boolean;
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
  };
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

  console.log(`workspace: ${args.workspace}\n`);

  const composed = compose({
    workspaceRoot: args.workspace,
    approvalDecider: interactiveApproval(args.yes),
    trace: new NullTraceSink(),
  });

  for (const n of composed.notices) console.log(`⚠️  ${n}\n`);

  const spec = composed.makeRunSpec(args.task);
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

  process.exit(0);
}

main().catch((err) => {
  console.error(`\n启动失败：${(err as Error).message}`);
  process.exit(1);
});
