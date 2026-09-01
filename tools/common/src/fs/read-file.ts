/**
 * read_file —— 读取文件内容。【场景工具】
 *
 * 三场景：
 *   办公：读 Word/Excel 导出的文本、读会议纪要
 *   代码：读源文件、读配置
 *   聊天：读消息导出、读附件正文
 *
 * 形态：只读、幂等 → §18.2 分支一；**本阶段第一个可能产大结果的工具**
 *       → 触发 §11.4 的 Blob 外置（批 2 S6）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条契约，每条都有具体的失败形态在后面顶着：
 *
 * ① **按行分页，不按字节。**
 *    字节分页会在 UTF-8 多字节字符边界劈断，产生乱码 —— 而中文正文里
 *    每个字符都是 3 字节，劈断不是边缘情况，是必然事件。
 *
 * ② **【定】工具内部不得为了「结果太大」而自行截断内容。**
 *    超限交给 §11.4 的 Materialization。工具只如实上报大小。
 *    分页 ≠ 截断：分页是**模型可控**的（它知道还有多少、可以再取），
 *    截断是**模型不可见**的。阶段 1 的血泪：`list_dir` 曾 `slice(0,200)`
 *    静默截断而 output 写「共 350 项」—— 模型会以为自己盘点完了。
 *
 * ③ **防御超长单行。**
 *    单行 JSON、压缩后的 JS 可以有几 MB 在一行里。按行分页对它无效，
 *    整行灌进 Context 会直接撞上下文墙，甚至爆内存。
 *    所以单行有安全长度上限，超出时**显式标记**该行被截断 ——
 *    这是唯一允许截断的地方，而且它必须在返回值里说出来。
 * ══════════════════════════════════════════════════════════════════════
 */

import { open, stat } from "node:fs/promises";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";
import { classifyFsError, resolveToolPath } from "./fs-common.js";
import { checkReadAllowed } from "./read-guard.js";

/** 单次返回的行数上限。超出走分页，不截断。 */
const DEFAULT_LIMIT = 2_000;
const MAX_LIMIT = 20_000;

/**
 * 单行安全长度。超出的部分被截掉并显式标记。
 *
 * 取 4000 字符：足够容纳任何人写的一行，又拦得住 minified 文件与单行 JSON。
 */
const MAX_LINE_CHARS = 4_000;

/**
 * 整个文件的读取上限（字节）。
 *
 * 【定】它**不是**「结果太大就截断」—— 那是契约 ② 禁止的。它是
 * 「大到不该整个读进内存」的硬保护：超过它就报错并告诉模型用分页，
 * 而不是悄悄给一份不完整的内容。
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export const readFileDefinition: ToolDefinition = {
  id: asId("tool_read_file"),
  version: "1.0.0",
  name: "read_file",
  description:
    "读取一个文本文件的内容。只读，不修改任何内容。" +
    "按**行**分页：start_line 从 1 起（默认 1），limit 是最多返回多少行（默认 2000）。" +
    '返回 JSON：{"path","startLine","endLine","totalLines","truncated","bytes","content"}，' +
    '还有后续内容时带 "nextStartLine"。' +
    "content 里每一行前面**不加**行号，需要行号时用 startLine 加偏移自己算；" +
    "某一行过长被截断时，返回里会出现 truncatedLines 列出那些行号。" +
    "读之前建议先用 stat 确认大小；要在很多文件里找东西用 search，不要逐个读。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "相对 workspace 根的文件路径，也接受绝对路径" },
      start_line: { type: "number", description: "从第几行开始读，1 起。默认 1" },
      limit: { type: "number", description: `最多返回多少行。默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}` },
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
      operation: "read",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 30_000 },
  /**
   * 【定】NONE，不是 HEARTBEAT。
   *
   * 阶段 3 这里声明的是 `HEARTBEAT 30s`，而本文件**一次 `ctx.onProgress`
   * 都没有** —— 方案 S9 写的「大文件读取周期性回报」没有实现，
   * 声明先行。而读取本身是一次 `handle.readFile()`：整份读进内存，
   * 中间没有任何可回报的节点，硬凑一个「开始/结束」不构成心跳。
   *
   * 要真做，得先把读改成流式分块。那时再改这个字段，**连同实现一起**。
   */
  progressReporting: { mode: "NONE" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
};

export async function executeReadFile(
  input: { path: string; start_line?: number; limit?: number },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const target = resolveToolPath(ctx.workspaceRoot, input.path);

  /**
   * 护栏 1：读黑名单（决 3 修订 2）。
   *
   * 【定】它必须在打开文件**之前**判。放到读完再判，内容已经在内存里了，
   * 而这条护栏防的正是「内容进入上下文」。
   */
  const denied = checkReadAllowed(target);
  if (denied) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_READ_DENIED",
        source: "POLICY",
        category: "AUTHORIZATION",
        // 【定】不是 AFTER_MODEL_CORRECTION —— 换个写法读同一个文件不该成功。
        retryability: "NEVER",
        sideEffectState: "NO_EFFECT",
        safeMessage:
          `拒绝读取 "${input.path}"：${denied.rule}。` +
          `这类文件含凭证或 Runtime 内部状态，读到之后可能被外发（决 3 护栏 1）。`,
      }),
    };
  }

  const startLine = Math.max(1, Math.trunc(input.start_line ?? 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT)));

  let handle;
  try {
    const s = await stat(target);
    if (s.isDirectory()) {
      return {
        ok: false,
        output: "",
        sideEffectState: "NO_EFFECT",
        error: classifyFsError(
          Object.assign(new Error("目标是目录"), { code: "EISDIR" }),
          `读取 "${input.path}"`,
        ),
      };
    }
    if (s.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        output: "",
        sideEffectState: "NO_EFFECT",
        error: makeError({
          code: "TOOL_FILE_TOO_LARGE",
          source: "TOOL_HANDLER",
          category: "CAPACITY",
          retryability: "AFTER_MODEL_CORRECTION",
          sideEffectState: "NO_EFFECT",
          safeMessage:
            `文件 ${input.path} 有 ${s.size} 字节，超过单次读取上限 ${MAX_FILE_BYTES}。` +
            `这不是「结果太大被截断」，是拒绝整个读进内存 —— 请用 search 定位，或缩小 limit 分页读。`,
        }),
      };
    }

    handle = await open(target, "r");
    const buf = await handle.readFile();
    /**
     * 【定】「按文本读到的东西可能不是文本」这件事必须如实上报。
     *
     * `toString("utf8")` 永远成功 —— 二进制不会抛错，只会变成一串乱码。
     * 模型看到乱码时无从知道那是文件本来的样子还是解码坏了，于是会把它
     * 当成内容去总结。NUL 字节是最可靠的判别信号：合法 UTF-8 文本里
     * 不会有它，而几乎所有二进制格式里都有。
     */
    const text = buf.toString("utf8");
    const looksBinary = text.includes("\u0000");

    const lines = text.split("\n");
    // 末尾换行会切出一个空串，那不是一行内容。
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const totalLines = lines.length;

    const from = Math.min(startLine - 1, totalLines);
    const page = lines.slice(from, from + limit);

    // 契约 ③：超长单行截断，并把行号如实列出来。
    const truncatedLines: number[] = [];
    const rendered = page.map((line, i) => {
      if (line.length <= MAX_LINE_CHARS) return line;
      truncatedLines.push(from + i + 1);
      return `${line.slice(0, MAX_LINE_CHARS)}…[本行超过 ${MAX_LINE_CHARS} 字符，已截断]`;
    });

    const endLine = from + page.length;
    return {
      ok: true,
      output: JSON.stringify({
        path: input.path,
        startLine: from + 1,
        endLine,
        totalLines,
        bytes: buf.byteLength,
        // 契约 ②：这里说的是「还有没有后续页」，不是「内容被砍了」。
        truncated: endLine < totalLines,
        ...(endLine < totalLines ? { nextStartLine: endLine + 1 } : {}),
        ...(truncatedLines.length > 0 ? { truncatedLines } : {}),
        ...(looksBinary
          ? { warning: "内容里含 NUL 字节，这多半是二进制文件，按文本读到的结果不可信" }
          : {}),
        content: rendered.join("\n"),
      }),
      sideEffectState: "NO_EFFECT",
    };
  } catch (err) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: classifyFsError(err, `读取 "${input.path}"`),
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export const readFileSnapshot: ToolSnapshot = {
  toolId: readFileDefinition.id,
  version: readFileDefinition.version,
  definition: readFileDefinition,
};
