/**
 * stat —— 单个对象的元信息。【场景工具】
 *
 * 三场景：
 *   办公：确认某份文档在不在、多大、什么时候改的
 *   代码：确认某个源文件存不存在，再决定要不要读
 *   聊天：确认导出的记录文件是否为空
 *
 * 形态：只读、幂等 → §18.2 分支一。
 *
 * ── 它的直接依据是一次实测失败 ────────────────────────────────────────
 *
 * 回归评测 P2-2：37 次工具调用只失败 1 次，那一次是**模型把文件路径传给了
 * `list_dir`**。根因不是模型笨 —— 工具集里没有任何「查看单个对象」的能力，
 * 于是它只能拿列目录的工具去探测文件。
 *
 * 【定】所以这个工具解决的不是「少一个便利函数」，是**能力面上的一个洞**：
 * 模型必须有办法用一次廉价调用回答「这东西在不在、有多大」，
 * 否则它只能靠 `read_file` 去撞 —— 而那会把整个文件拖进上下文。
 */

import { lstat, stat as fsStat } from "node:fs/promises";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId } from "@workagent/harness-runtime";
import { classifyFsError, resolveToolPath } from "./fs-common.js";

export const statDefinition: ToolDefinition = {
  id: asId("tool_stat"),
  version: "1.0.0",
  name: "stat",
  description:
    "查看单个文件或目录的元信息。只读，不返回文件内容，因此很便宜。" +
    "在决定是否 read_file 之前先用它确认目标存在、类型与大小。" +
    '返回 JSON：{"path","exists","kind","sizeBytes","modifiedAt","isSymlink"}。' +
    "目标不存在时返回 exists:false 而**不是**报错 —— 「不存在」本身就是一个有效答案。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "相对 workspace 根的路径，也接受绝对路径" },
    },
    required: ["path"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/path",
      effectType: "READ",
      scopeKind: "FILE",
      reversibility: "REVERSIBLE",
      operation: "stat",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 5_000 },
  progressReporting: { mode: "NONE" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
};

export async function executeStat(
  input: { path: string },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  // 决 3：读放开，不判 workspace 边界。
  // 也不接读黑名单 —— 它只回元数据，不回内容（见 read-guard.ts 文件头）。
  const target = resolveToolPath(ctx.workspaceRoot, input.path);

  try {
    /**
     * 【定】先 lstat 再 stat。
     *
     * 只用 stat 的话，一个指向不存在目标的符号链接会报 ENOENT，
     * 而事实是「链接在，目标不在」—— 两者对模型的下一步完全不同：
     * 前者要去修链接，后者要去换路径。
     */
    const l = await lstat(target);
    const isSymlink = l.isSymbolicLink();
    const s = isSymlink ? await fsStat(target).catch(() => undefined) : l;

    if (!s) {
      return {
        ok: true,
        output: JSON.stringify({
          path: input.path,
          exists: false,
          isSymlink: true,
          note: "这是一个符号链接，但它指向的目标不存在（断链）",
        }),
        sideEffectState: "NO_EFFECT",
      };
    }

    return {
      ok: true,
      output: JSON.stringify({
        path: input.path,
        exists: true,
        kind: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
        // 目录不给 sizeBytes，理由同 list_dir：那是 inode 大小，不是内容大小。
        ...(s.isFile() ? { sizeBytes: s.size } : {}),
        modifiedAt: new Date(s.mtimeMs).toISOString(),
        isSymlink,
      }),
      sideEffectState: "NO_EFFECT",
    };
  } catch (err) {
    /**
     * 【定】ENOENT 不是错误，是一个答案。
     *
     * 把「不存在」报成 ok:false，模型会把它当成一次失败并去重试或改参数；
     * 而它真正需要的信息是「这个文件确实不在」。这正是 stat 存在的意义 ——
     * 一次廉价的存在性问询，不该有失败这个出口。
     */
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        output: JSON.stringify({ path: input.path, exists: false }),
        sideEffectState: "NO_EFFECT",
      };
    }
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: classifyFsError(err, `查看 "${input.path}" 的元信息`),
    };
  }
}

export const statSnapshot: ToolSnapshot = {
  toolId: statDefinition.id,
  version: statDefinition.version,
  definition: statDefinition,
};
