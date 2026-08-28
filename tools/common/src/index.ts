/**
 * `@workagent/tools-common` —— Case 无关的通用能力面（阶段 3 决 1 / 决 2）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】工具分两类，各有各的声明义务（决 2 修订 1）：
 *
 * | 类       | 判据                        | 声明义务                             |
 * |----------|-----------------------------|--------------------------------------|
 * | 场景工具 | 办公 / 代码 / 聊天三场景常用 | 文件头写出三场景各自用例             |
 * | 机制工具 | 服务某一条 Harness 机制      | 文件头指出是哪一条机制、不做会怎样   |
 *
 * 第二类的形态照抄 §2.5 规格纪律第 4 条（「每新增一个 Port 必须同时指出
 * 强制它存在的不变量」）。`verify:tools` B 段机械扫描这两条声明。
 *
 * ── 反过拟合的机械判据 ────────────────────────────────────────────────
 *
 * 边界 6b：`grep -rn "cases/" tools/` 必须无结果。
 * 「通用工具一旦依赖某个 Case，它就不通用了」，而这件事从代码上看不出来。
 *
 * 还有一道**免费的经济闸**：§16.1【定·实测】每工具约 180 token 固定开销。
 * 「一个 Case 一套工具」会直接反映在每次请求的起步价上 —— 这是随时可读的
 * 过拟合警报，见 `verify:tools` G 段打印的基线。
 * ══════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { editFileSnapshot, executeEditFile, verifyEditFile } from "./fs/edit-file.js";
import { executeListDir, listDirSnapshot } from "./fs/list-dir.js";
import { executeReadFile, readFileSnapshot } from "./fs/read-file.js";
import { executeSearch, searchSnapshot } from "./fs/search.js";
import { executeStat, statSnapshot } from "./fs/stat.js";
import { executeWriteFile, verifyWriteFile, writeFileSnapshot } from "./fs/write-file.js";
import { executeNow, nowSnapshot } from "./time/now.js";
import { executeFetchUrl, fetchUrlSnapshot } from "./net/fetch-url.js";
import { executeReadBlob, readBlobSnapshot } from "./mech/read-blob.js";
import {
  executeRequestHandoff,
  requestHandoffSnapshot,
  type HandoffChannel,
} from "./mech/request-handoff.js";
import { resolveToolPath } from "./fs/fs-common.js";
import type { BlobStorePort } from "@workagent/harness-runtime";

export * from "./fs/fs-common.js";
export * from "./fs/read-guard.js";
export * from "./net/url-guard.js";
export * from "./artifact-checks/index.js";
export { fetchUrlDefinition, fetchUrlSnapshot } from "./net/fetch-url.js";
export { readBlobDefinition, readBlobSnapshot } from "./mech/read-blob.js";
export {
  requestHandoffDefinition,
  requestHandoffSnapshot,
  type HandoffChannel,
} from "./mech/request-handoff.js";
export { listDirDefinition, listDirSnapshot } from "./fs/list-dir.js";
export { readFileDefinition, readFileSnapshot } from "./fs/read-file.js";
export { statDefinition, statSnapshot } from "./fs/stat.js";
export { writeFileDefinition, writeFileSnapshot } from "./fs/write-file.js";
export { editFileDefinition, editFileSnapshot } from "./fs/edit-file.js";
export { searchDefinition, searchSnapshot } from "./fs/search.js";
export { nowDefinition, nowSnapshot } from "./time/now.js";

/**
 * 场景工具（8 个，批 2 补齐 `fetch_url`）。
 *
 * 【定】新增任何一个都要过决 2 的两类标准之一，并重读
 * `fixedOverheadTokens` 基线 —— 工具数是随时可读的过拟合警报。
 */
export const commonSceneTools: ToolSnapshot[] = [
  listDirSnapshot,
  statSnapshot,
  readFileSnapshot,
  searchSnapshot,
  writeFileSnapshot,
  editFileSnapshot,
  fetchUrlSnapshot,
  nowSnapshot,
];

/**
 * 机制工具（决 2 修订 1 的第二类）。
 *
 * 【定】它们过不了「办公 / 代码 / 聊天常用」这一关，而这**不是**问题 ——
 * 它们服务的是 Harness 机制，不是业务动作。硬塞进场景工具那一类会破坏
 * 那条标准的纯度；放进 `cases/` 更错（它们与任何 Case 都无关）。
 *
 * 声明义务因此不同：文件头必须指出**是哪一条机制**、**不做它会怎样**。
 */
export const commonMechanismTools: ToolSnapshot[] = [readBlobSnapshot, requestHandoffSnapshot];

export const commonTools: ToolSnapshot[] = [...commonSceneTools, ...commonMechanismTools];

// ══════════════════════════════════════════════════════════ Handler

export interface CommonToolHandlerDeps {
  /**
   * `read_blob` 要用它取回外置结果（S6.5）。
   *
   * 【定】工具包依赖的是 `BlobStorePort` 这个**接口**，实现由 Composition Root
   * 注入。边界 6（`packages/` 与 `adapters/` 不得依赖工具包）因此仍然成立 ——
   * 方向是工具包 → Runtime 的类型，不是反过来。
   *
   * 不注入时 `read_blob` 会返回一条明确的装配错误，而不是静默失败：
   * 「外置与取回必须一起在场，不能只有一半」（不得绕过 #9）。
   */
  blobs?: BlobStorePort;
  /**
   * `request_handoff` 要用它把请求交给人（S10）。
   *
   * 【定】不注入时 `request_handoff` 返回明确的装配错误，而不是静默挂起。
   * 「能发起接管却无人接收」等于把 Run 挂死，而挂死是最难排查的那种失败。
   */
  handoff?: HandoffChannel;
}

export class CommonToolHandler implements ToolHandlerPort {
  constructor(private readonly deps: CommonToolHandlerDeps = {}) {}

  async execute(action: PreparedAction, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const input = action.normalizedInput as Record<string, unknown>;
    switch (action.toolName) {
      case "list_dir":
        return executeListDir(
          {
            /**
             * 【定】没有 `?? "."` 这个默认值。
             *
             * `path` 在 schema 里是 `required`，而 `validateAndNormalize()`
             * 在 handler 之前就会挡下缺失字段 —— 那个默认值是**死分支**。
             * 更要紧的是它与声明矛盾：schema 说必填，代码说「不传就列根目录」，
             * 两种读法会给出不同的答案，而永远只有一种会发生。
             * 其余工具的 `?? ""` 不同：它们退化成工具自己的显式报错，
             * 不是悄悄换一个行为。
             */
            path: String(input["path"]),
            ...(input["cursor"] === undefined ? {} : { cursor: Number(input["cursor"]) }),
          },
          ctx,
        );
      case "stat":
        return executeStat({ path: String(input["path"] ?? "") }, ctx);
      case "read_file":
        return executeReadFile(
          {
            path: String(input["path"] ?? ""),
            ...(input["start_line"] === undefined ? {} : { start_line: Number(input["start_line"]) }),
            ...(input["limit"] === undefined ? {} : { limit: Number(input["limit"]) }),
          },
          ctx,
        );
      case "search":
        return executeSearch(
          {
            pattern: String(input["pattern"] ?? ""),
            ...(input["path"] === undefined ? {} : { path: String(input["path"]) }),
            ...(input["kind"] === undefined ? {} : { kind: String(input["kind"]) }),
            ...(input["cursor"] === undefined ? {} : { cursor: Number(input["cursor"]) }),
          },
          ctx,
        );
      case "write_file":
        return executeWriteFile(
          {
            path: String(input["path"] ?? ""),
            content: String(input["content"] ?? ""),
            ...(input["artifact_role"] === undefined
              ? {}
              : { artifact_role: String(input["artifact_role"]) }),
          },
          ctx,
        );
      case "fetch_url":
        return executeFetchUrl({ url: String(input["url"] ?? "") }, ctx);
      case "request_handoff":
        return executeRequestHandoff(
          {
            instructions: String(input["instructions"] ?? ""),
            expected_completion: String(input["expected_completion"] ?? ""),
          },
          ctx,
          this.deps.handoff,
        );
      case "read_blob":
        return executeReadBlob(
          {
            ref: String(input["ref"] ?? ""),
            ...(input["start_line"] === undefined ? {} : { start_line: Number(input["start_line"]) }),
            ...(input["limit"] === undefined ? {} : { limit: Number(input["limit"]) }),
          },
          ctx,
          this.deps.blobs,
        );
      case "edit_file":
        return executeEditFile(
          {
            path: String(input["path"] ?? ""),
            old_string: String(input["old_string"] ?? ""),
            new_string: String(input["new_string"] ?? ""),
          },
          ctx,
        );
      case "now":
        return executeNow({}, ctx);
      default:
        /**
         * 【定】不认识的工具名必须如实报，不能默默成功。
         *
         * 组合器（`CompositeToolHandler`）按工具名路由，理论上不会把
         * 别的包的工具送到这里；但一旦路由表和工具清单不同步，
         * 这条分支就是唯一会喊出来的地方。
         */
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
            safeMessage: `@workagent/tools-common 里没有名为 "${action.toolName}" 的工具`,
          }),
        };
    }
  }

  /** 组合器按它决定要不要把这次调用交给本 Handler。 */
  handles(toolName: string): boolean {
    return commonTools.some((t) => t.definition.name === toolName);
  }
}

// ═════════════════════════════════════════════════════════ Verifier

/**
 * 通用工具的 Verifier。
 *
 * 【定】它必须实现 `verify` / `observePre` / `observePost` **三个**方法，
 * 而组合器必须把三个都路由到位（§2.4）。
 *
 * 漏掉 `observePre` 的后果不是「少一个观察」，是 **§18.2 分支二的工具
 * 全部静默退化成分支三** —— 前置指纹拍不到 → 崩溃后一律判「观察不了」
 * → 全部落进 RECOVERY_REQUIRED。没有任何报错，盘上也看不出来。
 * `edit_file` 是本批唯一天然落在分支二的场景工具，所以这条第一次真正生效。
 */
export interface CommonVerifierOptions {
  /**
   * 允不允许拍执行前指纹（阶段 2 决 6 的旋钮）。
   *
   * 【定】这个开关在 **Runtime 侧**，不在工具身上。故障注入把它关掉，
   * 同一个 `edit_file` 就从分支二掉到分支三，而工具声明一个字没改。
   */
  recoveryObservationEnabled?: boolean;
}

/** 需要观察的工具 → 它的目标路径在入参的哪个字段上。 */
const OBSERVED_TOOLS = new Set(["write_file", "edit_file"]);

export class CommonVerifier implements VerificationPort {
  constructor(private readonly opts: CommonVerifierOptions = {}) {}

  async observePre(
    action: PreparedAction,
    ctx: ToolExecutionContext,
  ): Promise<ObservationResult | undefined> {
    if (this.opts.recoveryObservationEnabled === false) return undefined;
    if (!OBSERVED_TOOLS.has(action.toolName)) return undefined;
    const path = String((action.normalizedInput as Record<string, unknown>)["path"] ?? "");
    if (!path) return undefined;
    return snapshotFile(resolveToolPath(ctx.workspaceRoot, path));
  }

  async observePost(
    action: PreparedAction,
    ctx: ToolExecutionContext,
    pre: unknown,
  ): Promise<{ applied: boolean; detail: string } | undefined> {
    const input = action.normalizedInput as Record<string, unknown>;
    const path = String(input["path"] ?? "");
    if (!path) return undefined;
    const now = await snapshotFile(resolveToolPath(ctx.workspaceRoot, path));
    // 【定】读不了 ≠ 不存在。给不出结论就返回 undefined，降级到分支三。
    if (!now) return undefined;
    const cur = now.fingerprint as unknown as FileFingerprint;
    const p = pre as FileFingerprint | undefined;

    if (action.toolName === "write_file") {
      /**
       * 覆盖写是**绝对**操作：目标内容 == 计划内容就说明它发生过，
       * 不需要起始状态。所以这里不依赖 pre。
       */
      const planned = String(input["content"] ?? "");
      if (!cur.exists) return { applied: false, detail: "目标不存在 —— 那次写入没有发生" };
      const same = cur.sha256 === sha256(Buffer.from(planned, "utf8"));
      return same
        ? { applied: true, detail: "目标内容与计划内容一致 —— 那次写入确实发生了" }
        : { applied: false, detail: "目标内容与计划内容不一致 —— 那次写入没有完成" };
    }

    if (action.toolName === "edit_file") {
      /**
       * 替换是**相对**操作：没有起始指纹就判不出来。
       *
       * 【定】这里返回 undefined 而不是猜一个答案。`edit_file` 声明了
       * `requiresPreFingerprint: true`，Runtime 本来就不会把没指纹的它
       * 归进分支二 —— 但万一走到了，「不知道」必须如实说。
       */
      if (!p) return undefined;
      if (p.exists && cur.exists && p.sha256 === cur.sha256) {
        return {
          applied: false,
          detail: `文件内容与执行前完全一致（${cur.bytes} bytes）—— 那次替换没有发生`,
        };
      }
      return {
        applied: true,
        detail: `文件已变化（${p.bytes} → ${cur.bytes} bytes）—— 那次替换确实发生了`,
      };
    }

    return undefined;
  }

  async verify(
    action: PreparedAction,
    outcome: ToolExecutionOutcome,
    ctx: ToolExecutionContext,
  ): Promise<VerificationResult> {
    const base = { id: `ver_${action.id}`, actionId: action.id, at: Date.now() };

    if (!OBSERVED_TOOLS.has(action.toolName)) {
      return { ...base, mode: "NONE", required: false, status: "SKIPPED", detail: "该工具无需验证" };
    }

    /**
     * 工具报告失败时分两种情况，**不能都按「跳过」处理**（阶段 1 的教训）。
     *
     * 【定】副作用状态明确没发生（NOT_STARTED / NO_EFFECT）时，
     * 「目标状态未达成」是一个不需要观察就成立的事实 —— 结论是 FAILED。
     * 记成 SKIPPED 会让 Run 结算时查不到失败项，把一次明确的失败判成 SUCCESS。
     */
    if (
      !outcome.ok &&
      (outcome.sideEffectState === "NOT_STARTED" || outcome.sideEffectState === "NO_EFFECT")
    ) {
      return {
        ...base,
        mode: "REOBSERVE",
        required: true,
        status: "FAILED",
        detail: `工具执行失败且副作用明确未发生（${outcome.sideEffectState}），目标状态未达成`,
      };
    }

    const input = action.normalizedInput as Record<string, unknown>;
    const r =
      action.toolName === "write_file"
        ? await verifyWriteFile(
            { path: String(input["path"] ?? ""), content: String(input["content"] ?? "") },
            ctx,
          )
        : await verifyEditFile(
            {
              path: String(input["path"] ?? ""),
              old_string: String(input["old_string"] ?? ""),
              new_string: String(input["new_string"] ?? ""),
            },
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

  /** 组合器按它决定要不要把这次观察交给本 Verifier。 */
  handles(toolName: string): boolean {
    return commonTools.some((t) => t.definition.name === toolName);
  }
}

export interface FileFingerprint {
  exists: boolean;
  bytes: number;
  sha256: string;
}

/**
 * 拍一张文件指纹。
 *
 * 【定】只有 ENOENT 才是「目标不存在」。其余读错误（EACCES、EISDIR、ELOOP）
 * 说的都是「我看不了」，不是「它没有」—— 两者在恢复判定里的结论完全相反，
 * 混在一起会得到一个自信的错误答案。看不了就返回 undefined。
 */
async function snapshotFile(target: string): Promise<ObservationResult | undefined> {
  try {
    const buf = await readFile(target);
    return {
      fingerprint: { exists: true, bytes: buf.byteLength, sha256: sha256(buf) },
      at: Date.now(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // 「本来没有」同样是一个有效的起始状态。
      return { fingerprint: { exists: false, bytes: 0, sha256: "" }, at: Date.now() };
    }
    return undefined;
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
