/**
 * Micro Case 的 Tool Handler 与 Verifier 注册。
 *
 * 【定】Runtime Core 不 import Case Package，由 Composition Root 注册（V05 §27.3）。
 * 所以这里导出的是「可被注册的东西」，不是「会自动生效的东西」。
 *
 * D-23：阶段 1 不固定具体业务任务，只固定工具的形态约束
 * —— 一个只读快工具 ＋ 一个可控慢的可验证写工具。
 */

import type {
  PreparedAction,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolHandlerPort,
  ToolSnapshot,
  VerificationPort,
  VerificationResult,
} from "@workagent/harness-runtime";
import { makeError } from "@workagent/harness-runtime";
import { appendLogSnapshot, executeAppendLog } from "./tools/append-log.js";
import { executeListDir, listDirSnapshot } from "./tools/list-dir.js";
import { executeWriteNote, verifyWriteNote, writeNoteSnapshot } from "./tools/write-note.js";

export { appendLogDefinition, appendLogSnapshot } from "./tools/append-log.js";
export { listDirDefinition, listDirSnapshot } from "./tools/list-dir.js";
export { writeNoteDefinition, writeNoteSnapshot } from "./tools/write-note.js";

/**
 * D-23 的形态约束（阶段 1 修订后）：
 *   list_dir    只读、快、幂等          → §18.2 分支一
 *   write_note  可控慢、可验证、非幂等   → §18.2 分支二
 *   append_log  非幂等且不可观察         → §18.2 分支三
 *
 * 第三个不是「多一个工具」，是让第三条分支从不可达变成可达 ——
 * 没有它，RECOVERY_REQUIRED 的正确性在阶段 1 拿不到任何证据。
 */
export const microCaseTools: ToolSnapshot[] = [
  listDirSnapshot,
  writeNoteSnapshot,
  appendLogSnapshot,
];

export class MicroCaseToolHandler implements ToolHandlerPort {
  async execute(
    action: PreparedAction,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionOutcome> {
    const input = action.normalizedInput as Record<string, unknown>;
    switch (action.toolName) {
      case "list_dir":
        return executeListDir({ path: String(input["path"] ?? ".") }, ctx);
      case "write_note":
        return executeWriteNote(
          {
            path: String(input["path"] ?? ""),
            content: String(input["content"] ?? ""),
            delay_ms: input["delay_ms"] === undefined ? undefined : Number(input["delay_ms"]),
          },
          ctx,
        );
      case "append_log":
        return executeAppendLog(
          { path: String(input["path"] ?? ""), line: String(input["line"] ?? "") },
          ctx,
        );
      default:
        return {
          ok: false,
          output: "",
          sideEffectState: "NOT_STARTED",
          error: makeError({
            code: "TOOL_NOT_FOUND",
            source: "TOOL_INPUT",
            category: "NOT_FOUND",
            retryability: "AFTER_MODEL_CORRECTION",
            sideEffectState: "NOT_STARTED",
            safeMessage: `没有名为 "${action.toolName}" 的工具`,
          }),
        };
    }
  }
}

/**
 * Verifier 注册。
 *
 * 【定】Tool Handler 的 "success" 不能替代独立 Verification（V05 §15.1）。
 * write_note 报告成功之后，这里会真的把文件读回来比对。
 */
export class MicroCaseVerifier implements VerificationPort {
  async verify(
    action: PreparedAction,
    outcome: ToolExecutionOutcome,
    ctx: ToolExecutionContext,
  ): Promise<VerificationResult> {
    const base = {
      id: `ver_${action.id}`,
      actionId: action.id,
      at: Date.now(),
    };

    if (action.toolName !== "write_note") {
      return { ...base, mode: "NONE", required: false, status: "SKIPPED", detail: "该工具无需验证" };
    }

    /**
     * 工具报告失败时分两种情况，**不能都按「跳过」处理**。
     *
     * 【定】副作用状态明确没发生（NOT_STARTED / NO_EFFECT）时，
     * 「目标状态未达成」是一个不需要观察就成立的事实 —— 结论是 FAILED，不是 SKIPPED。
     * 记成 SKIPPED 会让 Run 结算时查不到失败项，把一次明确的失败判成 SUCCESS。
     *
     * 副作用状态未知（UNKNOWN / PARTIALLY_APPLIED）才是 REOBSERVE 存在的理由：
     * 恰恰在这里必须真的去读外部世界，而不是跳过。§18.2 分支二复用的也是这条路径。
     */
    if (!outcome.ok && (outcome.sideEffectState === "NOT_STARTED" || outcome.sideEffectState === "NO_EFFECT")) {
      return {
        ...base,
        mode: "REOBSERVE",
        required: true,
        status: "FAILED",
        detail: `工具执行失败且副作用明确未发生（${outcome.sideEffectState}），目标状态未达成`,
      };
    }

    const input = action.normalizedInput as Record<string, unknown>;
    const r = await verifyWriteNote(
      { path: String(input["path"] ?? ""), content: String(input["content"] ?? "") },
      ctx,
    );

    return {
      ...base,
      mode: "REOBSERVE",
      required: true,
      status: r.ok ? "PASSED" : "FAILED",
      detail: r.detail,
    };
  }
}
