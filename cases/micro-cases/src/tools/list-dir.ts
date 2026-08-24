/**
 * list_dir —— 只读、快。
 *
 * 用途：触发一次响应多个 tool call。
 * 实测四个端点全部默认在一次响应里返回 4 个 call，这是默认行为不是边缘情况，
 * 所以阶段 1 必须有一个「问一句就要调好几次」的工具。
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";

export const listDirDefinition: ToolDefinition = {
  id: asId("tool_list_dir"),
  version: "1.0.0",
  name: "list_dir",
  description:
    "列出某个目录下的条目。只读，不修改任何内容。path 相对于 workspace 根目录，用 \".\" 表示根目录本身。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: '相对 workspace 根的路径，根目录用 "."' },
    },
    required: ["path"],
  },
  requiredCapabilities: ["fs.read"],
  effectResolution: {
    kind: "DECLARATIVE",
    version: "1.0.0",
    rules: [
      {
        pointer: "/path",
        effectType: "READ",
        scopeKind: "DIRECTORY",
        reversibility: "REVERSIBLE",
        operation: "list",
      },
    ],
  },
  redaction: { profile: "STANDARD" },
  retryPolicy: { maxAttempts: 2, backoffMs: 200 },
  // 只读且幂等 —— resume() 遇到它的未配对 tool_use 可以直接重跑（V05 §18.2 分支一）
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 10_000 },
  cancellation: { cooperative: true },
  progressReporting: { mode: "NONE" },
  verification: {
    mode: "NONE",
    requiredForSuccess: false,
    observationCost: "LOW",
  },
};

export async function executeListDir(
  input: { path: string },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const target = resolve(ctx.workspaceRoot, input.path);

  // 【定】Adapter 执行时再验证实际目标（V05 §22.1）。
  // EffectResolver 已经算过一次，这里是执行边界的第二道 —— 两者都不能省。
  if (!isInside(ctx.workspaceRoot, target)) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_PATH_ESCAPE",
        source: "TOOL_INPUT",
        category: "AUTHORIZATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `路径 "${input.path}" 落在 workspace 之外，拒绝执行`,
      }),
    };
  }

  try {
    const names = await readdir(target);
    const rows: string[] = [];
    for (const name of names.slice(0, 200)) {
      if (ctx.signal.aborted) break;
      const s = await stat(join(target, name));
      rows.push(`${s.isDirectory() ? "d" : "-"} ${String(s.size).padStart(8)} ${name}`);
    }
    return {
      ok: true,
      output:
        rows.length === 0
          ? `目录 ${input.path} 为空`
          : `目录 ${input.path} 共 ${names.length} 项：\n${rows.join("\n")}`,
      sideEffectState: "NO_EFFECT",
    };
  } catch (err) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_FS_READ",
        source: "TOOL_HANDLER",
        category: "NOT_FOUND",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `读取目录失败：${String((err as Error).message).slice(0, 160)}`,
      }),
    };
  }
}

function isInside(root: string, target: string): boolean {
  const r = resolve(root);
  return target === r || target.startsWith(r + "/");
}

export const listDirSnapshot: ToolSnapshot = {
  toolId: listDirDefinition.id,
  version: listDirDefinition.version,
  contentHash: "list_dir@1.0.0",
  definition: listDirDefinition,
};
