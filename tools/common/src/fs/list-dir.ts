/**
 * list_dir —— 列出目录条目。【场景工具】
 *
 * 三场景：
 *   办公：看一个归档目录里有哪些文档、每份多大
 *   代码：看一个模块目录下有哪些源文件
 *   聊天：看导出的聊天记录目录里有哪些会话文件
 *
 * 形态：只读、幂等 → §18.2 分支一。单页有上限，超出**分页**而不截断。
 *
 * ── 它同时是「一次响应多个 tool call」的触发器 ──────────────────────
 * 实测四个端点全部默认在一次响应里返回 4 个 call，这是默认行为不是边缘情况。
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId } from "@workagent/harness-runtime";
import { classifyFsError, resolveToolPath } from "./fs-common.js";

/** 单次返回的条目上限。超出时如实标 truncated ＋ 给 nextCursor，不静默截断。 */
const MAX_ENTRIES = 200;

export const listDirDefinition: ToolDefinition = {
  id: asId("tool_list_dir"),
  version: "2.0.0",
  name: "list_dir",
  description:
    "列出某个目录下的条目。只读，不修改任何内容。" +
    "path 相对于 workspace 根目录，用 \".\" 表示根目录本身；也接受绝对路径。" +
    '返回 JSON：{"path","total","cursor","returned","truncated","entries":[{"name","kind","sizeBytes"}]}，' +
    '还有下一页时带 "nextCursor"，被取消时带 "cancelled" 与 "incompleteReason"。' +
    'kind 是 "file" / "directory" / "unreadable"（后者带 reason，说明是权限问题还是断链）；' +
    "sizeBytes 只有文件才有，目录不返回该字段。" +
    "条目按名称升序稳定排列，所以翻页不会漏项或重项。" +
    "只想知道单个文件的大小或存在性时用 stat，不要用本工具去探测文件。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: '相对 workspace 根的目录路径，根目录用 "."' },
      cursor: {
        type: "number",
        description: `从第几项开始列举（0 起）。返回里有 nextCursor 就说明还有下一页，带着它再调一次。单页上限 ${MAX_ENTRIES} 项。`,
      },
    },
    required: ["path"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/path",
      effectType: "READ",
      scopeKind: "DIRECTORY",
      reversibility: "REVERSIBLE",
      operation: "list",
    },
  },
  redaction: { profile: "STANDARD" },
  // 只读且幂等 —— resume() 遇到它的未配对 tool_use 可以直接重跑（V05 §18.2 分支一）
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 10_000 },
  progressReporting: { mode: "NONE" },
  verification: {
    mode: "NONE",
    requiredForSuccess: false,
  },
  /**
   * 只读 → 崩溃后重跑即可，观察本身没有意义。
   * 【定】阶段 3 起这个字段不再是可选的（§2.2）—— 声明 TARGET_EXISTS
   * 只是说「原则上可以这么观察」，实际走哪条分支由 idempotency 先判掉。
   */
  recoveryObservation: { requiresPreFingerprint: false },
};

export async function executeListDir(
  input: { path: string; cursor?: number },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  /**
   * 【定】不再判 workspace 边界（决 3：读放开）。
   *
   * 也不接读黑名单：本工具只返回**条目名与大小**，不返回内容。
   * 黑名单的判据是「会不会把内容带进上下文」（见 read-guard.ts 文件头），
   * 按名字挡一个只回元数据的工具，换不来保密性，只会让合法问题失败。
   */
  const target = resolveToolPath(ctx.workspaceRoot, input.path);

  try {
    /**
     * 【定】E-4：稳定排序。
     *
     * 没有它，「第二页」是一个没有意义的概念 —— `readdir` 的顺序由文件系统
     * 决定，两次调用之间可以不同，游标翻页会漏项或重项。
     */
    const names = (await readdir(target)).sort();
    const start = Math.max(0, Math.trunc(input.cursor ?? 0));
    const page = names.slice(start, start + MAX_ENTRIES);
    interface Entry {
      name: string;
      kind: "file" | "directory" | "unreadable";
      sizeBytes?: number;
      /** kind === "unreadable" 时给出 errno，模型据此判断是权限问题还是断链。 */
      reason?: string;
    }
    const entries: Entry[] = [];

    /**
     * E-4 的另一半：**取消导致的不完整**与**容量截断**必须分得开。
     * 容量截断 → 还有下一页，带 cursor 再来一次；
     * 被取消   → 这次观察本身不完整，**不能**当成事实用。
     */
    let cancelled = false;
    for (const name of page) {
      if (ctx.signal.aborted) {
        cancelled = true;
        break;
      }
      /**
       * N-8：单个条目 stat 失败**不再让整页失败**。
       *
       * 一个断链的符号链接（ENOENT）或一个没权限的子项（EACCES）此前会把
       * 整次 list_dir 变成一条 NOT_FOUND —— 目录里其余 200 项一起消失。
       * 现在如实标一个 `unreadable`，其余条目照常返回。
       */
      try {
        const s = await stat(join(target, name));
        entries.push(
          s.isDirectory()
            ? // 【定】目录不返回 sizeBytes。
              //
              // 那是目录 inode 的大小（macOS 上典型值 64），**不是目录内容的大小**。
              // 返回一个没有意义的数字有两重代价：人会以为空目录占 64 字节；
              // 模型会把它当成可以汇总的数据。
              { name, kind: "directory" as const }
            : { name, kind: "file" as const, sizeBytes: s.size },
        );
      } catch (err) {
        entries.push({
          name,
          kind: "unreadable",
          reason: (err as NodeJS.ErrnoException).code ?? "UNKNOWN",
        });
      }
    }

    /**
     * 【定】结构化返回，不是给人看的定宽文本。
     *
     * 此前的形态是 `d       64 临时` —— 2026-08-24 的评测实跑里模型把它读成了
     * 目录名 `64 临时`，调用失败，又多花两轮重新观察才自愈。
     * 定宽对齐是给人的视觉通道；模型按 token 序列读，两边都没伺候好。
     */
    const nextCursor = start + entries.length;
    return {
      ok: true,
      output: JSON.stringify({
        path: input.path,
        total: names.length,
        cursor: start,
        returned: entries.length,
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
    // N-8：分类交给 classifyFsError —— EACCES 不再被报成「目录不存在」。
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: classifyFsError(err, `列举目录 "${input.path}"`),
    };
  }
}

export const listDirSnapshot: ToolSnapshot = {
  toolId: listDirDefinition.id,
  version: listDirDefinition.version,
  definition: listDirDefinition,
};
