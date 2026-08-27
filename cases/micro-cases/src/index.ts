/**
 * Micro Case 的 Tool Handler 与 Verifier 注册。
 *
 * 【定】Runtime Core 不 import Case Package，由 Composition Root 注册（V05 §27.3）。
 * 所以这里导出的是「可被注册的东西」，不是「会自动生效的东西」。
 *
 * D-23：阶段 1 不固定具体业务任务，只固定工具的形态约束
 * —— 一个只读快工具 ＋ 一个可控慢的可验证写工具。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ObservationResult,
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
import { executeNow, nowSnapshot } from "./tools/now.js";
import { executeWriteNote, verifyWriteNote, writeNoteSnapshot } from "./tools/write-note.js";

export { appendLogDefinition, appendLogSnapshot } from "./tools/append-log.js";
export { listDirDefinition, listDirSnapshot } from "./tools/list-dir.js";
export { nowDefinition, nowSnapshot } from "./tools/now.js";
// E-3 的有限 auto-grant 与工具内部用的是**同一道**边界判定 —— 两处若各写一份，
// 会出现「授权时判在里面、执行时判在外面」这种最难查的不一致。
export { isInsideWorkspace } from "./tools/fs-common.js";
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
  // 阶段 2 新增。只读 ＋ 幂等 → §18.2 分支一，不扰动分支分布统计。
  // 【定】它是注入时间事实的**补充**，不是替代 —— 见 tools/now.ts 的文件头。
  nowSnapshot,
];

export class MicroCaseToolHandler implements ToolHandlerPort {
  async execute(
    action: PreparedAction,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionOutcome> {
    const input = action.normalizedInput as Record<string, unknown>;
    switch (action.toolName) {
      case "list_dir":
        return executeListDir(
          {
            path: String(input["path"] ?? "."),
            ...(input["cursor"] === undefined ? {} : { cursor: Number(input["cursor"]) }),
          },
          ctx,
        );
      case "write_note":
        return executeWriteNote(
          {
            path: String(input["path"] ?? ""),
            content: String(input["content"] ?? ""),
            delay_ms: input["delay_ms"] === undefined ? undefined : Number(input["delay_ms"]),
          },
          ctx,
        );
      case "now":
        return executeNow({}, ctx);
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
export interface MicroCaseVerifierOptions {
  /**
   * 允不允许拍执行前指纹（决 6 的旋钮）。
   *
   * 【定】这个开关在 **Runtime 侧**，不在工具身上 —— 这正是决 6 的要点。
   * 阶段 2 的研究问题是「有多少次 resume 落进第三条分支」，
   * 分流依据若长在被测对象身上，测的就是它自己。
   *
   * 故障注入把它关掉，同一个 `append_log` 就从分支二掉到分支三，
   * 而工具声明一个字没改。
   */
  recoveryObservationEnabled?: boolean;
}

export class MicroCaseVerifier implements VerificationPort {
  constructor(private readonly opts: MicroCaseVerifierOptions = {}) {}

  /**
   * 执行前拍指纹（决 6）。
   *
   * 拍什么由工具的 `recoveryObservation.kind` 决定：
   *   TARGET_APPEND_TAIL —— 追加是相对操作，要记住起始时的字节数与尾部 hash；
   *   TARGET_CONTENT_HASH —— 覆盖写是绝对操作，其实不需要前置状态，
   *                          但记一份也无妨（能顺带回答「本来就有没有」）。
   *
   * 返回 undefined = 这次观察不了 → 该 Action 崩溃后落第三条分支。
   */
  async observePre(
    action: PreparedAction,
    ctx: ToolExecutionContext,
  ): Promise<ObservationResult | undefined> {
    if (this.opts.recoveryObservationEnabled === false) return undefined;
    const path = String((action.normalizedInput as Record<string, unknown>)["path"] ?? "");
    if (!path) return undefined;
    const target = resolve(ctx.workspaceRoot, path);
    try {
      const buf = await readFile(target);
      return {
        fingerprint: { exists: true, bytes: buf.byteLength, sha256: sha256(buf) },
        at: Date.now(),
      };
    } catch (err) {
      // 文件还不存在也是一个有效的起始状态 —— 「本来没有」同样能用来比对。
      if (isNotFound(err)) {
        return { fingerprint: { exists: false, bytes: 0, sha256: "" }, at: Date.now() };
      }
      /**
       * 【定】读失败 ≠ 不存在。
       *
       * 裸 `catch` 把 EACCES / EISDIR / ELOOP 一并折叠成「本来没有」，
       * 而那是一句**假的确信**。整条决 6 机制存在的意义就是把窗口 A/B 的
       * 「不知道」变成「知道」——在读不了外部世界的时候硬给一个结论，
       * 恰恰是在最需要判别力的地方失去判别力。
       *
       * 返回 undefined = 这次观察不了 → 老老实实降级到第三条分支，交人决定。
       */
      return undefined;
    }
  }

  /**
   * 崩溃后：拿执行前的指纹和现在比，判断那次执行发生没发生。
   *
   * 这是把 §18.2 窗口 A/B 的「不可区分」变成「可区分」的那一步 ——
   * 也是消息级恢复这个取舍成不成立的关键。
   */
  async observePost(
    action: PreparedAction,
    ctx: ToolExecutionContext,
    pre: unknown,
  ): Promise<{ applied: boolean; detail: string } | undefined> {
    const p = pre as { exists: boolean; bytes: number; sha256: string } | undefined;
    const path = String((action.normalizedInput as Record<string, unknown>)["path"] ?? "");
    if (!path) return undefined;
    const target = resolve(ctx.workspaceRoot, path);

    let now: { exists: boolean; bytes: number; sha256: string };
    try {
      const buf = await readFile(target);
      now = { exists: true, bytes: buf.byteLength, sha256: sha256(buf) };
    } catch (err) {
      // 同 observePre：只有 ENOENT 才是「不存在」。其余读错误说明**看不了**，
      // 而「看不了」的正确答案是 undefined（观察不了），不是「没发生」。
      // 把它判成「没发生」会让模型去补做一次已经做过的非幂等操作 ——
      // 追加日志因此会多出一行，而这正是分支二本来要防的事。
      if (!isNotFound(err)) return undefined;
      now = { exists: false, bytes: 0, sha256: "" };
    }

    /**
     * 没有前置指纹时的**绝对**判据。
     *
     * 只对覆盖写这类「目标状态与起始状态无关」的操作成立 ——
     * 文件内容等于计划内容，就说明那次写发生过。
     * 追加操作走不到这里：它声明了 requiresPreFingerprint: true，
     * 没有指纹时 Runtime 根本不会把它归进分支二。
     */
    if (!p) {
      const planned = String((action.normalizedInput as Record<string, unknown>)["content"] ?? "");
      if (!now.exists) {
        return { applied: false, detail: "目标不存在 —— 那次写入没有发生" };
      }
      const same = now.sha256 === sha256(Buffer.from(planned, "utf8"));
      return same
        ? { applied: true, detail: "目标内容与计划内容一致 —— 那次写入确实发生了" }
        : { applied: false, detail: "目标内容与计划内容不一致 —— 那次写入没有完成" };
    }

    if (!p.exists && !now.exists) {
      return { applied: false, detail: "执行前后目标都不存在 —— 那次写入没有发生" };
    }
    if (p.exists && now.exists && p.sha256 === now.sha256) {
      return {
        applied: false,
        detail: `目标内容与执行前完全一致（${now.bytes} bytes）—— 那次写入没有发生`,
      };
    }
    return {
      applied: true,
      detail: `目标已变化（${p.bytes} → ${now.bytes} bytes）—— 那次写入确实发生了`,
    };
  }

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

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 只有 ENOENT 才是「目标不存在」。
 *
 * 其余读错误（EACCES 无权限、EISDIR 路径是目录、ELOOP 符号链接成环、
 * 底层 I/O 失败）说的都是「我看不了」，不是「它没有」。
 * 两者在恢复判定里的结论完全相反，混在一起会得到一个自信的错误答案。
 */
function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
