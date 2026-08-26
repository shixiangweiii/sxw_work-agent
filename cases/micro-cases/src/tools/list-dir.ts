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
import { isInsideWorkspace } from "./fs-common.js";

/** 单次返回的条目上限。超出时如实标 truncated，不静默截断。 */
const MAX_ENTRIES = 200;

export const listDirDefinition: ToolDefinition = {
  id: asId("tool_list_dir"),
  version: "1.2.0",
  name: "list_dir",
  description:
    "列出某个目录下的条目。只读，不修改任何内容。path 相对于 workspace 根目录，用 \".\" 表示根目录本身。" +
    '返回 JSON：{"path","total","cursor","returned","truncated","entries":[{"name","kind","sizeBytes"}]}，' +
    '还有下一页时带 "nextCursor"，被取消时带 "cancelled" 与 "incompleteReason"。' +
    "kind 是 \"file\" 或 \"directory\"；sizeBytes 只有文件才有，目录不返回该字段。" +
    "条目按名称升序稳定排列，所以翻页不会漏项或重项。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: '相对 workspace 根的路径，根目录用 "."' },
      cursor: {
        type: "number",
        description: `从第几项开始列举（0 起）。返回里有 nextCursor 就说明还有下一页，带着它再调一次。单页上限 ${MAX_ENTRIES} 项。`,
      },
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
  input: { path: string; cursor?: number },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const target = resolve(ctx.workspaceRoot, input.path);

  if (!isInsideWorkspace(ctx.workspaceRoot, target)) {
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
    /**
     * 【定】E-4：稳定排序。
     *
     * 没有它，「第二页」是一个没有意义的概念 —— `readdir` 的顺序由文件系统
     * 决定，两次调用之间可以不同，游标翻页会漏项或重项。
     * 「逐个盘点」这类任务恰恰最依赖不漏不重。
     */
    const names = (await readdir(target)).sort();
    const start = Math.max(0, Math.trunc(input.cursor ?? 0));
    const page = names.slice(start, start + MAX_ENTRIES);
    const entries: Array<{ name: string; kind: "file" | "directory"; sizeBytes?: number }> = [];

    /**
     * E-4 的另一半：**取消导致的不完整**与**容量截断**必须分得开。
     *
     * 修复前两者都表现为 `truncated: true`，而它们对模型的含义完全相反：
     *   容量截断 → 还有下一页，带 cursor 再来一次就行；
     *   被取消   → 这次观察本身不完整，**不能**当成事实用。
     * 混在一起的话，模型会拿一份被取消的半截清单去写汇总。
     */
    let cancelled = false;
    for (const name of page) {
      if (ctx.signal.aborted) {
        cancelled = true;
        break;
      }
      const s = await stat(join(target, name));
      entries.push(
        s.isDirectory()
          ? // 【定】目录不返回 sizeBytes。
            //
            // 之前这里返回 stat.size —— 那是目录 inode 的大小（macOS 上典型值 64），
            // **不是目录内容的大小**。返回一个没有意义的数字有两重代价：
            // 人会以为空目录占 64 字节；模型会把它当成可以汇总的数据。
            //
            // 需要目录体积就得递归 —— 那是另一个工具的事，不能用一个碰巧存在的
            // 字段假装回答了这个问题。
            { name, kind: "directory" as const }
          : { name, kind: "file" as const, sizeBytes: s.size },
      );
    }

    /**
     * 【定】结构化返回，不是给人看的定宽文本。
     *
     * 此前的形态是 `d       64 临时` —— 类型、size、名称拼在一行靠空格对齐。
     * 2026-08-24 的评测实跑里，模型把它读成了目录名 `64 临时`，调用失败，
     * 又多花两轮重新观察才自愈（7 轮里的 2 轮）。
     *
     * 根因不是模型笨：定宽对齐是**给人的视觉通道**，模型按 token 序列读，
     * `64` 与 `临时` 之间只有一个空格，和 `临时` 内部的字符没有区别。
     * 而中文是双宽字符，padStart(8) 在终端里本身也是错位的 —— 两边都没伺候好。
     *
     * truncated / total / returned 三个字段是同一次修复的一部分：
     * 原实现 slice(0, 200) 静默截断，输出里却写「共 ${names.length} 项」。
     * 目录超 200 项时模型会看到「共 350 项」却只拿到 200 条，且无任何提示 ——
     * 它会以为自己盘点完了。
     */
    const nextCursor = start + entries.length;
    return {
      ok: true,
      output: JSON.stringify({
        path: input.path,
        total: names.length,
        cursor: start,
        returned: entries.length,
        // 还有下一页时给出 nextCursor —— 模型不必自己算偏移。
        ...(!cancelled && nextCursor < names.length ? { nextCursor } : {}),
        truncated: !cancelled && nextCursor < names.length,
        ...(cancelled
          ? {
              cancelled: true,
              incompleteReason: "执行期间被取消，本次列举不完整，不要据此汇总",
            }
          : {}),
        entries,
      }),
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

export const listDirSnapshot: ToolSnapshot = {
  toolId: listDirDefinition.id,
  version: listDirDefinition.version,
  contentHash: "list_dir@1.1.0",
  definition: listDirDefinition,
};
