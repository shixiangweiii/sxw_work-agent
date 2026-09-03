/**
 * materialize_resource —— 将不可变 Resource 原样写入 workspace。【机制工具】
 *
 * 服务的机制：把已持久化证据提升为可验证 Artifact。
 * 不做它会怎样：二进制只能保存却无法交付，文本也会被迫经过模型重写而失去
 * 逐字节保真。写入仍走 WRITE/FILE 审批与 workspace 边界，并在返回前独立读回校验 hash。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ArtifactRole,
  ResourceStorePort,
  RuntimeErrorRecord,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";
import { artifactKindOf } from "../artifact-checks/index.js";
import {
  cancelledError,
  classifyFsError,
  isInsideWorkspace,
  resolveToolPath,
} from "../fs/fs-common.js";

export const materializeResourceDefinition: ToolDefinition = {
  id: asId("tool_materialize_resource"),
  version: "1.0.0",
  name: "materialize_resource",
  description:
    "把 ResourceRef 的不可变字节原样、原子地写入 workspace，并自动登记 Artifact。" +
    "适合保留外部原文或图片、压缩包等二进制；不要先让模型重写内容。" +
    "path 必须位于 workspace 内；artifact_role 必填，只能是 INTERMEDIATE 或 DELIVERABLE。" +
    "写后系统会重新读取文件并校验 SHA-256 与 Resource 一致。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ref: { type: "string", description: 'Runtime 返回的引用，形如 "res_xxx"' },
      path: { type: "string", description: "workspace 内的目标文件路径" },
      artifact_role: {
        type: "string",
        description: '必须为 "INTERMEDIATE" 或 "DELIVERABLE"',
      },
    },
    required: ["ref", "path", "artifact_role"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/path",
      effectType: "WRITE",
      scopeKind: "FILE",
      reversibility: "PARTIALLY_REVERSIBLE",
      operation: "materialize_resource",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: false },
  timeoutPolicy: { timeoutMs: 60_000 },
  progressReporting: { mode: "NONE" },
  verification: { mode: "REOBSERVE", requiredForSuccess: true },
  recoveryObservation: { requiresPreFingerprint: false },
};

export async function executeMaterializeResource(
  input: { ref: string; path: string; artifact_role: string },
  ctx: ToolExecutionContext,
  resources: ResourceStorePort | undefined,
): Promise<ToolExecutionOutcome> {
  if (!resources) {
    return failure(
      "TOOL_RESOURCE_STORE_ABSENT",
      "本次装配没有注入 ResourceStorePort。",
      "RUNTIME",
      "INTERNAL",
      "AFTER_USER_ACTION",
    );
  }
  if (input.artifact_role !== "INTERMEDIATE" && input.artifact_role !== "DELIVERABLE") {
    return failure(
      "TOOL_ARTIFACT_ROLE_INVALID",
      'artifact_role 只接受 "INTERMEDIATE" 或 "DELIVERABLE"。',
      "TOOL_INPUT",
      "VALIDATION",
      "AFTER_MODEL_CORRECTION",
    );
  }
  const role = input.artifact_role as ArtifactRole;
  const target = resolveToolPath(ctx.workspaceRoot, input.path);
  // Resource 物化的契约比 UNRESTRICTED 更窄：它只写 workspace。
  if (!isInsideWorkspace(ctx.workspaceRoot, target)) {
    return failure(
      "TOOL_PATH_ESCAPE",
      `路径 "${input.path}" 不在 workspace 内，拒绝物化 Resource。`,
      "TOOL_INPUT",
      "AUTHORIZATION",
      "AFTER_MODEL_CORRECTION",
    );
  }
  if (ctx.signal.aborted) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NOT_STARTED",
      error: cancelledError("materialize_resource"),
    };
  }

  let resource;
  try {
    resource = await resources.readForMaterialization(input.ref);
  } catch (err) {
    const detail = String((err as Error)?.message ?? err).slice(0, 180);
    if (detail.includes("RESOURCE_INTEGRITY_MISMATCH")) {
      return failure(
        "TOOL_RESOURCE_HASH_MISMATCH",
        `Resource ${input.ref} 的存储字节与引用 hash/size 不一致，拒绝写入。`,
        "RUNTIME",
        "INTERNAL",
        "AFTER_USER_ACTION",
      );
    }
    return failure(
      "TOOL_RESOURCE_STORE_READ_FAILED",
      `读取 Resource ${input.ref} 的存储失败，目标文件尚未写入：` +
        detail,
      "RUNTIME",
      "INTERNAL",
      "AFTER_USER_ACTION",
    );
  }
  if (!resource) {
    return failure(
      "TOOL_RESOURCE_NOT_FOUND",
      `没有 ref 为 "${input.ref}" 的 Resource。`,
      "TOOL_INPUT",
      "NOT_FOUND",
      "AFTER_MODEL_CORRECTION",
    );
  }
  const sourceHash = sha256(resource.content);
  if (sourceHash !== resource.reference.contentHash) {
    return failure(
      "TOOL_RESOURCE_HASH_MISMATCH",
      `Resource ${input.ref} 的存储字节 hash 与引用不一致，拒绝写入。`,
      "RUNTIME",
      "INTERNAL",
      "AFTER_USER_ACTION",
    );
  }

  let replacedBytes: number | undefined;
  try {
    replacedBytes = (await stat(target)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return fsFailure(err, `检查目标 ${input.path}`);
    }
  }

  const temp = `${target}.workagent-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  let committed = false;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, resource.content, { flag: "wx" });
    await rename(temp, target);
    committed = true;
    const written = await readFile(target);
    const writtenHash = sha256(written);
    if (writtenHash !== resource.reference.contentHash) {
      return failure(
        "TOOL_MATERIALIZED_HASH_MISMATCH",
        `写后校验失败：目标 hash ${writtenHash} 与 Resource hash ${resource.reference.contentHash} 不一致。`,
        "TOOL_HANDLER",
        "INTERNAL",
        "AFTER_USER_ACTION",
        "APPLIED",
      );
    }
    return {
      ok: true,
      output: JSON.stringify({
        status: "MATERIALIZED",
        ref: input.ref,
        path: input.path,
        sizeBytes: written.byteLength,
        sha256: writtenHash,
        artifactRole: role,
      }),
      sideEffectState: "APPLIED",
      artifact: {
        logicalId: input.path,
        path: input.path,
        role,
        kind: artifactKindOf(input.path),
        content: new Uint8Array(written),
        sourceResourceRef: input.ref,
        ...(replacedBytes === undefined ? {} : { replacedBytes }),
      },
    };
  } catch (err) {
    try {
      await unlink(temp);
    } catch {
      // 临时文件可能尚未创建或已 rename；清理失败不覆盖原始诊断。
    }
    if (committed) {
      return failure(
        "TOOL_MATERIALIZE_POST_WRITE_FAILED",
        `目标已经原子替换，但写后复核失败：${String((err as Error)?.message ?? err).slice(0, 160)}`,
        "TOOL_HANDLER",
        "INTERNAL",
        "AFTER_USER_ACTION",
        "APPLIED",
      );
    }
    return fsFailure(err, `物化 Resource 到 ${input.path}`);
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function fsFailure(err: unknown, what: string): ToolExecutionOutcome {
  const error = classifyFsError(err, what);
  return { ok: false, output: "", sideEffectState: error.sideEffectState, error };
}

function failure(
  code: string,
  safeMessage: string,
  source: "RUNTIME" | "TOOL_INPUT" | "TOOL_HANDLER",
  category: RuntimeErrorRecord["category"],
  retryability: RuntimeErrorRecord["retryability"],
  sideEffectState: "NO_EFFECT" | "APPLIED" = "NO_EFFECT",
): ToolExecutionOutcome {
  return {
    ok: false,
    output: "",
    sideEffectState,
    error: makeError({
      code,
      source,
      category,
      retryability,
      sideEffectState,
      safeMessage,
    }),
  };
}

export const materializeResourceSnapshot: ToolSnapshot = {
  toolId: materializeResourceDefinition.id,
  version: materializeResourceDefinition.version,
  definition: materializeResourceDefinition,
};
