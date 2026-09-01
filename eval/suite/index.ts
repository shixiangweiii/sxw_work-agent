/**
 * Eval Suite Runner —— 多次运行与分布导出（E-6）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 复评报告 §9 P2：**「本轮只有 1 次由评测器重置夹具后执行的正式 trial，
 * 不能给出 pass^k」**。一次成功与「稳定地成功」是两件事，
 * 而阶段 2 的退出门槛写的是「可**重复**验证」。
 *
 * 用法：
 *   npm run eval:suite                 # 脚本化模型，不花钱，验管路
 *   npm run eval:suite -- --live 5     # 真实端点跑 5 次，出 pass^5
 * ══════════════════════════════════════════════════════════════════════
 *
 * 【定】它不读 `RunOutcome` 判成败（§24.1）。成败由 grader 从**外部世界**判定，
 * Runtime 的自报只作为一列并排显示的参考 —— 两者不一致本身就是有价值的信号。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { compose, parseEndpointArg, REPO_ROOT, type EndpointChoice } from "../../apps/cli/src/compose.js";
import { FileTraceSink } from "../../apps/cli/src/trace/file-sink.js";
import { ScriptedModelPort } from "../../apps/cli/src/verify/harness.js";
import {
  archiveInventoryGrader,
  diffManifests,
  runGrader,
  snapshotWorkspace,
  type GraderResult,
  type WorkspaceManifest,
} from "../graders/index.js";
import { ARCHIVE_TASK, materialize } from "../fixtures/archive-inventory.js";

/**
 * Trial artifact 的可复现信息（E-5）。
 *
 * 复评报告的具体教训：开发自测 trace 的 header 记着 commit `012717d`，
 * 而实际工作树含未提交的修复 —— **没有 dirty 标志，
 * 「旧 commit ＋ 未提交改动」在 artifact 里看起来就是「旧 commit」**。
 */
export interface TrialProvenance {
  commit: string;
  gitDirty: boolean | "unknown";
  /** 工作树 diff 的 hash。dirty 时它才是真正区分两次运行的东西。 */
  diffHash: string;
  nodeVersion: string;
  npmVersion: string;
  fixtureHash: string;
  graderVersion: string;
  startedAt: string;
}

export interface TrialResult {
  index: number;
  runId: string;
  /** grader 的判定 —— 这才是成败。 */
  grader: GraderResult;
  /** Runtime 自报，只作参考列。 */
  runtimeOutcome: string;
  runtimeTerminal: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  billedInputTokens: number;
  outputTokens: number;
  /**
   * §18.2 三条恢复分支各命中几次（P1-2）。
   *
   * 经 `runtime.inspect()` 拿，不去翻 transcript —— §24.1【定】Eval 只经 Facade。
   * 脚本化模式下它恒为空（没有崩溃就没有恢复），这**不是缺陷**：
   * 阶段 2 只负责让装置可用，真实分布要等阶段 3 有真工具真任务。
   */
  resumeBranchCounts: Record<string, number>;
  /** 未达成的必需项按成因聚合（USER_REJECTED / TOOL_FAILED / …）。 */
  unmetCauseCounts: Record<string, number>;
  error?: string;
}

export interface SuiteReport {
  provenance: TrialProvenance;
  live: boolean;
  trials: TrialResult[];
  passAt1: number;
  passPowK: boolean;
  k: number;
  /** k 次合计的分支分布与失败成因分布 —— 阶段 2 研究问题的数据出口。 */
  resumeBranchTotals: Record<string, number>;
  unmetCauseTotals: Record<string, number>;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function provenance(): TrialProvenance {
  const diff = git(["diff", "HEAD"]);
  return {
    commit: git(["rev-parse", "HEAD"]) || "unknown",
    gitDirty: git(["status", "--porcelain"]).length > 0,
    diffHash: diff ? createHash("sha256").update(diff).digest("hex").slice(0, 16) : "clean",
    nodeVersion: process.version,
    npmVersion: (() => {
      try {
        return execFileSync("npm", ["-v"], { encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })(),
    fixtureHash: "",
    graderVersion: `${archiveInventoryGrader.id}@${archiveInventoryGrader.version}`,
    startedAt: new Date().toISOString(),
  };
}

/**
 * 脚本化模型：把归档盘点任务演一遍。
 *
 * 它当然拿不到真实模型的语义能力 —— 内容是照着夹具真值写死的。
 * 用途是**验管路**：夹具、grader、manifest diff、报告导出全都跑一遍，
 * 而且不花钱、不依赖网络。真正的能力评测必须 `--live`。
 */
function scriptedTurns() {
  const listing = (p: string) => ({
    text: `看看 ${p}`,
    toolCalls: [{ toolCallId: `ls_${p.replace(/\W/g, "")}`, name: "list_dir", input: { path: p } }],
  });
  const body = [
    "# 2026Q2 归档交接清单",
    "",
    "## 会议纪要（2 个文件，合计 103 bytes）",
    "- 0408周会.md：52 bytes",
    "- 0520评审会.md：51 bytes",
    "",
    "## 合同（3 个文件，合计 120 bytes）",
    "- A公司框架协议_已盖章.pdf.txt：35 bytes",
    "- B公司采购合同_待签.txt：32 bytes",
    "- C公司补充协议_草稿.txt：53 bytes",
    "",
    "## 设计稿（1 个文件，合计 20000 bytes）",
    "- 首页改版_v3.sketch.txt：20000 bytes",
    "",
    "## 临时",
    "- 该目录为空，0 个文件。",
    "",
    "## 合计",
    "共 6 个文件，20223 bytes。体积最大的文件是 设计稿/首页改版_v3.sketch.txt（20000 bytes）。",
    "",
    "## 给接手人的提示",
    "合同目录里 B公司采购合同_待签.txt 尚未签署，C公司补充协议_草稿.txt 条款三待确认，请优先跟进。",
  ].join("\n");

  return [
    listing("2026Q2归档"),
    {
      text: "逐个看子目录",
      toolCalls: [
        { toolCallId: "ls_1", name: "list_dir", input: { path: "2026Q2归档/临时" } },
        { toolCallId: "ls_2", name: "list_dir", input: { path: "2026Q2归档/会议纪要" } },
        { toolCallId: "ls_3", name: "list_dir", input: { path: "2026Q2归档/合同" } },
        { toolCallId: "ls_4", name: "list_dir", input: { path: "2026Q2归档/设计稿" } },
      ],
    },
    {
      text: "写清单",
      toolCalls: [
        { toolCallId: "w1", name: "write_file", input: { path: "2026Q2归档/交接清单.md", content: body } },
      ],
    },
    {
      text: "追加日志",
      toolCalls: [
        {
          toolCallId: "a1",
          name: "append_log",
          input: {
            path: "2026Q2归档/归档日志.txt",
            line: "[盘点] 覆盖 临时、会议纪要、合同、设计稿 共 4 个子目录，合计 6 个文件。",
          },
        },
      ],
    },
    { text: "盘点完成，清单与日志都已写好。", toolCalls: [] },
  ];
}

async function runTrial(
  index: number,
  live: boolean,
  outDir: string,
  endpoint: EndpointChoice,
): Promise<TrialResult> {
  const root = mkdtempSync(join(tmpdir(), `workagent-eval-${index}-`));
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  materialize(ws);

  const before: WorkspaceManifest = snapshotWorkspace(ws);
  const tracePath = join(outDir, `trial-${index}.jsonl`);
  const started = Date.now();

  const sink = new FileTraceSink(
    () => tracePath,
    () => ({
      commit: git(["rev-parse", "HEAD"]) || "unknown",
      /**
       * 【定】记**真实**端点名，不是写死的 "eval"。
       *
       * 写死的话 manifest 上读不出这一次跑的是哪个端点 —— 而 §24.6 的
       * 对照端点与主力端点的三组判定几乎处处相反，「哪个端点」正是
       * 复核一份 Eval 结果时第一个要问的问题。
       */
      endpointProfile: endpoint,
      modelId: live ? "live" : "scripted",
      task: ARCHIVE_TASK,
      workspaceRoot: ws,
      // 这两个夹具都跑默认档（没有换档的入口）。
      executionPrivilege: "SANDBOXED",
      timezone: "Asia/Shanghai",
      startedAt: new Date().toISOString(),
    }),
  );

  const composed = compose({
    workspaceRoot: ws,
    approvalDecider: async () => ({ approved: true }),
    trace: sink,
    dbPath: join(root, "runs.db"),
    timezone: "Asia/Shanghai",
    endpoint,
    ...(live ? {} : { modelPortOverride: new ScriptedModelPort(scriptedTurns()) }),
  });

  let runId = "";
  let terminal = "?";
  let outcome = "?";
  let error: string | undefined;
  try {
    /**
     * 【定】入口身份传 `EVAL`。
     *
     * `RunOrigin.EVAL` 早就在类型里、**零生产者** —— 这里此前走默认值，
     * 于是 Eval 起的 Run 在 RunSpec 里自称 `CLI`。与阶段 4 修掉的
     * 「Web 起的 Run 自称 CLI」是同一个 bug 的未修副本，而决 4 说
     * 评测数据的入口归因读的正是这个字段。
     */
    const gen = composed.runtime.start(composed.makeRunSpec(ARCHIVE_TASK, "EVAL"));
    let r = await gen.next();
    while (!r.done) {
      if (!runId) runId = String(r.value.runId);
      r = await gen.next();
    }
    terminal = r.value.terminal.reason;
    outcome = r.value.outcome?.kind ?? "未结算";
  } catch (e) {
    error = (e as Error).message;
  }

  const after = snapshotWorkspace(ws);
  const traceEvents = existsSync(tracePath) ? readJsonl(tracePath) : [];
  sink.finish({ terminal, outcome });

  const grader = runGrader(archiveInventoryGrader, {
    workspaceRoot: ws,
    before,
    after,
    diff: diffManifests(before, after),
    task: ARCHIVE_TASK,
    traceEvents,
  });

  const usage = traceEvents
    .filter((e) => e["type"] === "ModelInvocationCompleted")
    .map((e) => (e["payload"] as { usage: { billedInputTokens: number; outputTokens: number } }).usage);

  // manifest 也存下来 —— 没有它，事后没人能复核 grader 当时看到的是什么。
  writeFileSync(
    join(outDir, `trial-${index}-manifests.json`),
    JSON.stringify({ before, after }, null, 2),
    "utf8",
  );
  /**
   * 【定】必须在 `db.close()` 与 `rmSync` **之前**取快照 —— 库关了就读不到了。
   * 这也是为什么它不能在 main() 里事后补：trial 的临时目录已经不在了。
   */
  const snap = runId ? await composed.runtime.inspect(runId as never) : undefined;

  composed.db.close();
  rmSync(root, { recursive: true, force: true });

  return {
    index,
    runId,
    grader,
    runtimeOutcome: outcome,
    runtimeTerminal: terminal,
    durationMs: Date.now() - started,
    modelCalls: usage.length,
    toolCalls: traceEvents.filter((e) => e["type"] === "AttemptStarted").length,
    billedInputTokens: usage.reduce((n, u) => n + (u?.billedInputTokens ?? 0), 0),
    outputTokens: usage.reduce((n, u) => n + (u?.outputTokens ?? 0), 0),
    resumeBranchCounts: snap?.resumeBranchCounts ?? {},
    unmetCauseCounts: snap?.unmetCauseCounts ?? {},
    ...(error ? { error } : {}),
  };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* 半行忽略：JSONL 对 kill 安全的代价 */
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const kArg = argv[argv.indexOf("--live") + 1];
  const k = live ? Number(kArg) || 5 : Number(argv[argv.indexOf("-n") + 1]) || 3;
  /**
   * 方案 S1 要求 CLI **与 `eval/suite`** 都加受枚举约束的 `--endpoint`。
   * 这一半此前没做：Eval 只能跑主力端点，而 manifest 里记的是写死的 "eval"。
   * 校验函数与 CLI 共用一个（见 compose.ts 的说明）。
   */
  const endpoint = parseEndpointArg(argv);

  const outDir = join(REPO_ROOT, ".workagent-eval", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });

  const prov = provenance();
  // 夹具指纹：证明 k 次跑的确实是同一个夹具（复评报告 §2.2 的教训）。
  const probe = mkdtempSync(join(tmpdir(), "workagent-fixture-"));
  materialize(probe);
  prov.fixtureHash = createHash("sha256")
    .update(JSON.stringify(snapshotWorkspace(probe).files))
    .digest("hex")
    .slice(0, 16);
  rmSync(probe, { recursive: true, force: true });

  console.log(`\n${"═".repeat(72)}`);
  console.log("  eval:suite —— 归档盘点任务，多次运行与分布导出");
  console.log(`  模式：${live ? `\x1b[33m--live（真实端点，会花钱）\x1b[0m` : "脚本化（不花钱，验管路）"}   次数：${k}`);
  console.log("═".repeat(72));
  console.log(
    `\n  commit ${prov.commit.slice(0, 8)}${prov.gitDirty ? ` \x1b[33m+dirty(${prov.diffHash})\x1b[0m` : " (clean)"}` +
      `  node ${prov.nodeVersion}  npm ${prov.npmVersion}`,
  );
  console.log(`  夹具 ${prov.fixtureHash}   grader ${prov.graderVersion}   端点 ${endpoint}\n`);

  const trials: TrialResult[] = [];
  for (let i = 1; i <= k; i++) {
    process.stdout.write(`  trial ${i}/${k} … `);
    const t = await runTrial(i, live, outDir, endpoint);
    trials.push(t);
    console.log(
      `${t.grader.hardPassed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ` +
        `(${t.grader.passed}/${t.grader.total} 检查)  runtime=${t.runtimeOutcome}  ` +
        `${t.modelCalls} 轮 / ${t.toolCalls} 工具 / ${t.billedInputTokens}+${t.outputTokens} tok / ${t.durationMs}ms`,
    );
    for (const c of t.grader.checks.filter((c) => !c.ok)) {
      console.log(`      \x1b[31m✗\x1b[0m ${c.hard ? "[硬]" : "[软]"} ${c.name} —— ${c.detail}`);
    }
  }

  const passed = trials.filter((t) => t.grader.hardPassed).length;
  const report: SuiteReport = {
    provenance: prov,
    live,
    trials,
    passAt1: passed / trials.length,
    passPowK: passed === trials.length,
    k,
    resumeBranchTotals: mergeCounts(trials.map((t) => t.resumeBranchCounts)),
    unmetCauseTotals: mergeCounts(trials.map((t) => t.unmetCauseCounts)),
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(`\n${"─".repeat(72)}`);
  console.log(`  pass@1      ${(report.passAt1 * 100).toFixed(0)}%  （${passed}/${k}）`);
  console.log(`  pass^${k}      ${report.passPowK ? "\x1b[32m成立\x1b[0m" : "\x1b[31m不成立\x1b[0m"}`);
  console.log(
    `  token 分布  ${dist(trials.map((t) => t.billedInputTokens + t.outputTokens))}`,
  );
  console.log(`  时延分布    ${dist(trials.map((t) => t.durationMs))} ms`);
  console.log(
    `  Runtime 自报与 grader 一致  ` +
      `${trials.filter((t) => (t.runtimeOutcome === "SUCCESS") === t.grader.hardPassed).length}/${k}`,
  );

  /**
   * 阶段 2 研究问题的数据出口（P1-2）。
   *
   * Roadmap §4 的问题是「有多少次 resume() 落进『非幂等且不可观察』那条分支」。
   * 这里把 k 次的分支分布与失败成因分布打出来并落进 report.json。
   *
   * 【定】**不在这里下结论。** 脚本化模式一次崩溃都没有，分支分布必然是空的；
   * 就算 --live 也只是正常执行的分布，不含故障。真实分布要等阶段 3 有真工具、
   * 真任务、真崩溃 —— 阶段 2 交付的是装置，不是答案（Roadmap §4 的 B 方案）。
   */
  console.log(`\n${"─".repeat(72)}`);
  console.log("  §18.2 恢复分支分布（阶段 2 的测量装置）");
  console.log(`    ${fmtCounts(report.resumeBranchTotals) || "（本次 k 轮没有发生任何 resume —— 分支分布为空）"}`);
  console.log("  未达成必需项的成因分布");
  console.log(`    ${fmtCounts(report.unmetCauseTotals) || "（无未达成的必需项）"}`);
  const worst = report.resumeBranchTotals["RECOVERY_REQUIRED"] ?? 0;
  const totalBranches = Object.values(report.resumeBranchTotals).reduce((a, b) => a + b, 0);
  console.log(
    `    落进最坏分支（非幂等且不可观察）：${worst}/${totalBranches}` +
      (totalBranches === 0 ? "　—— 样本为 0，这个比例现在没有意义" : ""),
  );

  console.log(`\n  artifact：${outDir}`);
  if (!live) {
    console.log(
      "\n  \x1b[33m结论边界\x1b[0m：脚本化模式验的是**管路**（夹具 → Run → manifest → grader → 报告），\n" +
        "  不是模型能力。产物内容是照真值写死的，pass 说明不了 Agent 行不行。\n" +
        "  能力评测必须：npm run eval:suite -- --live 5",
    );
  }

  process.exit(report.passPowK ? 0 : 1);
}

function mergeCounts(all: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const one of all) for (const [k, v] of Object.entries(one)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function fmtCounts(c: Record<string, number>): string {
  const keys = Object.keys(c).sort();
  return keys.map((k) => `${k}=${c[k]}`).join("  ");
}

function dist(ns: number[]): string {
  if (ns.length === 0) return "—";
  const s = [...ns].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return `min ${s[0]} / 中位 ${s[Math.floor(s.length / 2)]} / max ${s[s.length - 1]} / 均 ${Math.round(sum / s.length)}`;
}

void main();
