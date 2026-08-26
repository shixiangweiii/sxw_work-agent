/**
 * 子进程 worker：在**独立进程**里跑一段 Run。
 *
 * ── 为什么必须是真子进程 ─────────────────────────────────────────────────
 *
 * 阶段 1 的 `verify:resume` B2 段是「往 transcript 注入崩溃形态」—— 那是
 * 构造出来的崩溃，不是崩溃。它能验分支处置的逻辑，验不了两件事：
 *
 *   1. 进程真的没了之后，盘上剩下的是不是够恢复的；
 *   2. 「工具跑到一半被 SIGKILL」与「工具还没开始」在盘上是否真的不可区分
 *      （§18.2 的窗口 A / B —— 消息级恢复的本质限制就在这里）。
 *
 * SIGKILL 不可捕获，没有 finally、没有 flush、没有优雅收尾。这正是要的：
 * `finalize()` 那套补齐逻辑一行都跑不到，剩下什么全看已经 COMMIT 的部分。
 *
 * 用法（由 verify 脚本 spawn，不手工调）：
 *   tsx run-segment.ts --db <path> --workspace <path> --mode start|resume
 *                      [--run-id <id>] --script <base64-json>
 *                      [--kill-at <EventType>[#n]] [--recovery-decision CONTINUE|ABORT]
 *
 * 正常结束时往 stdout 打一行 `@@RESULT@@{...}`，供父进程解析。
 */

import { mkdirSync } from "node:fs";
import type { RunEvent, RunId } from "@workagent/harness-runtime";
import { NullTraceSink, asId } from "@workagent/harness-runtime";
import { compose } from "../../compose.js";
import { ScriptedModelPort, estimateFromBody, type ScriptedTurn } from "../harness.js";
import { FileTraceSink } from "../../trace/file-sink.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dbPath = arg("db")!;
  const workspace = arg("workspace")!;
  const mode = arg("mode") ?? "start";
  const tracePath = arg("trace");
  const script = JSON.parse(
    Buffer.from(arg("script") ?? "", "base64").toString("utf8"),
  ) as ScriptedTurn[];

  /** `--kill-at ToolAttemptStarted#2` = 第 2 个该类型事件到达时自杀。 */
  const killAt = arg("kill-at");
  const [killType, killNthRaw] = (killAt ?? "").split("#");
  const killNth = Number(killNthRaw ?? 1);
  let killSeen = 0;

  mkdirSync(workspace, { recursive: true });

  const model = new ScriptedModelPort(script, estimateFromBody, Number(arg("script-offset") ?? 0));
  const sink = tracePath
    ? new FileTraceSink(
        () => tracePath,
        () => ({
          commit: "verify",
          endpointProfile: "verify",
          modelId: "scripted",
          task: "verify:persistence",
          workspaceRoot: workspace,
          timezone: "Asia/Shanghai",
          startedAt: new Date().toISOString(),
        }),
      )
    : undefined;

  const composed = compose({
    workspaceRoot: workspace,
    approvalDecider: async () => ({ approved: true }),
    trace: sink ?? new NullTraceSink(),
    modelPortOverride: model,
    dbPath,
    timezone: "Asia/Shanghai",
    // 决 6 的旋钮：关掉执行前指纹，同一个工具就从分支二掉到分支三。
    disableRecoveryObservation: process.argv.includes("--disable-observation"),
  });

  let runId = arg("run-id") ?? "";
  const decision = arg("recovery-decision") as "CONTINUE" | "ABORT" | undefined;

  const gen =
    mode === "resume"
      ? composed.runtime.resume(asId<RunId>(runId), decision ? { recoveryDecision: decision } : {})
      : composed.runtime.start(composed.makeRunSpec("跨进程持久化验收任务"));

  let r = await gen.next();
  while (!r.done) {
    const e = r.value as RunEvent;
    if (!runId) runId = String(e.runId);

    // 把恢复分支打给父进程 —— 它是 verify:crash 的主判据。
    if (e.type === "ResumeUnpairedToolUse") {
      const p = e.payload as { branch: string; hasPreFingerprint: boolean };
      process.stdout.write(`@@BRANCH@@${p.branch} fp=${p.hasPreFingerprint}\n`);
    }

    if (killType && e.type === killType) {
      killSeen += 1;
      if (killSeen >= killNth) {
        // 先把 runId 告诉父进程，再自杀 —— 否则父进程不知道该 resume 谁。
        process.stdout.write(`@@KILLED@@${JSON.stringify({ runId, at: e.type, sequence: e.sequence })}\n`);
        // 【定】SIGKILL 而不是 process.exit()：后者会跑 finally 与 exit 钩子，
        // 那就又变成了「优雅退出」，测不到真正的崩溃窗口。
        process.kill(process.pid, "SIGKILL");
      }
    }
    r = await gen.next();
  }

  const res = r.value as { terminal: { reason: string }; outcome?: { kind: string } };
  // 段正常结束时补 footer。段 1 被 SIGKILL 时写不出来 —— 那正是 JSONL
  // 相对「一个大 JSON 数组」的价值：缺 footer 仍然可读，只是知道它没跑完。
  sink?.finish({ terminal: res.terminal, outcome: res.outcome ?? null });
  process.stdout.write(
    `@@RESULT@@${JSON.stringify({
      runId,
      terminal: res.terminal.reason,
      outcome: res.outcome?.kind ?? null,
      turnsConsumed: model.turnsConsumed,
    })}\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  process.stdout.write(`@@ERROR@@${JSON.stringify({ message: (err as Error).message })}\n`);
  process.exit(1);
});
