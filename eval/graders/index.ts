/**
 * Grader 层（E-1，V05 §24.1【定】）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】Eval 的成败判定**不复用生产 Run 的 outcome 结算路径**。
 *
 * 这不是洁癖，是 §10.4 敢采用「模型不再请求工具即完成」的前提之一：
 * 若 Eval 也读 `RunOutcome.kind`，就是让被测对象给自己打分。
 *
 * 所以 grader 只准读两样东西：
 *   1. **外部世界**（运行前后的 workspace manifest 与文件内容）；
 *   2. **Trace artifact**（可选，用于轨迹类判据，比如「有没有失败的工具调用」）。
 *
 * 它**不读** RunOutcome，也不该有办法读到。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 复评报告说得很直白：`write_file` 的 Verification「只能证明磁盘内容等于
 * 模型计划内容，不能证明文件名、大小、合计和日期正确」。那些是任务级语义，
 * 只有任务自己的 grader 知道 —— 这一层就是为它存在的。
 */

import type { ManifestDiff, WorkspaceManifest } from "./workspace-manifest.js";

export interface GraderContext {
  workspaceRoot: string;
  before: WorkspaceManifest;
  after: WorkspaceManifest;
  diff: ManifestDiff;
  /** 任务原文。grader 可据此定位「用户显式要求了什么」。 */
  task: string;
  /**
   * Trace 的事件行（可选）。
   *
   * 【定】只允许用于**轨迹类**判据（有没有失败的工具调用、走了几轮）。
   * 不得从里面读 `LoopTerminated.outcome` 当成败判据 —— 那就是在读
   * 生产结算路径，本文件开头那条【定】禁止的正是这件事。
   */
  traceEvents?: Array<Record<string, unknown>>;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** 硬门槛：任务显式要求的东西。false 即整个 trial 失败。 */
  hard: boolean;
}

export interface GraderResult {
  graderId: string;
  graderVersion: string;
  checks: Check[];
  passed: number;
  total: number;
  hardPassed: boolean;
}

export interface Grader {
  id: string;
  version: string;
  run(ctx: GraderContext): Check[];
}

export function runGrader(grader: Grader, ctx: GraderContext): GraderResult {
  const checks = grader.run(ctx);
  return {
    graderId: grader.id,
    graderVersion: grader.version,
    checks,
    passed: checks.filter((c) => c.ok).length,
    total: checks.length,
    hardPassed: checks.filter((c) => c.hard).every((c) => c.ok),
  };
}

/** 小工具：给检查项写断言时少写点样板。 */
export function check(name: string, ok: boolean, detail: string, hard = true): Check {
  return { name, ok, detail, hard };
}

export * from "./workspace-manifest.js";
export * from "./archive-inventory.js";
