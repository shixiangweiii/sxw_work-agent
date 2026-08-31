/**
 * search —— 按文件名或文件内容查找。【场景工具】
 *
 * 三场景：
 *   办公：在一堆文档里找提到某个客户/项目的那几份
 *   代码：在仓库里找某个符号、某类形状出现在哪
 *   聊天：在导出的会话里找某个关键词出现的位置
 *
 * 形态：只读、幂等 → §18.2 分支一。有 cursor 分页，超出**分页**不截断。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条契约，都来自「不这么做会怎样」：
 *
 * ① **通用 ignore 过滤。**
 *    不过滤会扫进 `node_modules/`、`.git/` 与二进制 —— 结果是搜索超时，
 *    或者扫出海量无意义字符塞进上下文。这**不是** Case 语义：
 *    「编译产物与版本库内部目录不是搜索目标」在三个场景里都成立。
 *
 * ② **content 匹配返回前后各若干行上下文 ＋ 明确行号。**
 *    只返回孤立的一行，模型必须再发多次 `read_file` 才能理解它 ——
 *    白烧 token 与轮次。行号让它能直接接 `read_file(start_line=…)`
 *    或 `edit_file`，三个工具因此串得起来。
 *
 * ③ **【定】读黑名单必须在这里生效。**
 *    `search(kind:"content")` 一次扫遍整棵目录树，比 `read_file` 更高效地
 *    构成决 3 修订 2 里那条外泄链路。只挡 read_file 等于没挡。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";
import { classifyFsError, resolveToolPath } from "./fs-common.js";
import { isReadDeniedPath } from "./read-guard.js";

/** 单页匹配数上限。超出给 nextCursor。 */
const PAGE = 50;
/** 上下文行数（前后各若干行）。 */
const CONTEXT_LINES = 2;
/** 单个文件超过这个字节数就不做内容匹配 —— 它多半是数据文件，不是正文。 */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
/** 遍历目录数上限。防止一次调用把整块盘走完。 */
const MAX_DIRS = 5_000;
/** 每扫这么多目录回报一次进展。见 walk() 里那段说明。 */
const PROGRESS_EVERY_DIRS = 200;

/**
 * 契约 ① 的常量表。
 *
 * 【定】它是**通用**判据，不是某个任务的偏好：这些目录里的内容不是
 * 用户写的东西，而是工具生成的。放进 tools/common 是对的；
 * 一旦这里出现「归档目录叫什么」这类东西，就是 Case 语义漏进来了。
 */
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".cache",
  ".workagent-state",
  ".workagent-runs",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff",
  ".mp3", ".wav", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".mkv",
  ".zip", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".so", ".dylib", ".dll", ".exe", ".o", ".a", ".class", ".jar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".db", ".pyc",
]);

export const searchDefinition: ToolDefinition = {
  id: asId("tool_search"),
  version: "1.0.0",
  name: "search",
  description:
    "在一棵目录下按文件名或文件内容查找。只读。" +
    'kind="name" 匹配文件名（子串，忽略大小写）；kind="content" 匹配文件内容（子串，忽略大小写）。' +
    'path 默认 "."（workspace 根）。' +
    '返回 JSON：{"pattern","kind","path","total","returned","truncated","matches":[…]}，' +
    '还有下一页时带 "nextCursor"。' +
    'content 匹配的每一项是 {"path","line","before":[…],"match","after":[…]}，line 从 1 起，' +
    "可以直接拿去接 read_file 的 start_line 或 edit_file。" +
    "自动跳过 .git/、node_modules/、编译产物与二进制文件。" +
    "要在很多文件里定位内容时用本工具，不要逐个 read_file。",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "要找的子串。忽略大小写，不是正则" },
      path: { type: "string", description: '起始目录，相对 workspace 根。默认 "."' },
      kind: { type: "string", description: '"name" 找文件名，"content" 找文件内容。默认 "content"' },
      cursor: { type: "number", description: "从第几条匹配开始返回（0 起）。配合 nextCursor 翻页" },
    },
    required: ["pattern"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/path",
      effectType: "READ",
      scopeKind: "DIRECTORY",
      reversibility: "REVERSIBLE",
      operation: "search",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 60_000 },
  /**
   * 【定】MONOTONIC_PROGRESS —— 它是本批唯一**真的能回报**的场景工具。
   *
   * 阶段 3 这里声明的是 `HEARTBEAT 30s`，而本文件一次 `ctx.onProgress`
   * 都没有。改成单调进度并真的接线（每 200 个目录一次）：遍历目录数是
   * 单调的、与工作量成正比，而「30 秒一次」这个节奏这里根本产生不出来。
   */
  progressReporting: { mode: "MONOTONIC_PROGRESS" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
};

export interface SearchMatch {
  path: string;
  line?: number;
  before?: string[];
  match: string;
  after?: string[];
}

export async function executeSearch(
  input: { pattern: string; path?: string; kind?: string; cursor?: number },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const pattern = input.pattern;
  if (!pattern) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_INPUT_EMPTY_PATTERN",
        source: "TOOL_INPUT",
        category: "VALIDATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: "search 的 pattern 不能为空 —— 空串会匹配所有内容。",
      }),
    };
  }

  const kind = input.kind === "name" ? "name" : "content";
  const rootArg = input.path ?? ".";
  const root = resolveToolPath(ctx.workspaceRoot, rootArg);
  const cursor = Math.max(0, Math.trunc(input.cursor ?? 0));
  const needle = pattern.toLowerCase();

  try {
    const s = await stat(root);
    if (!s.isDirectory()) {
      return {
        ok: false,
        output: "",
        sideEffectState: "NO_EFFECT",
        error: classifyFsError(
          Object.assign(new Error("起点不是目录"), { code: "ENOTDIR" }),
          `在 "${rootArg}" 下搜索`,
        ),
      };
    }
  } catch (err) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: classifyFsError(err, `在 "${rootArg}" 下搜索`),
    };
  }

  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let skippedDenied = 0;
  let dirsVisited = 0;
  let cancelled = false;
  let dirLimitHit = false;

  const walk = async (dir: string): Promise<void> => {
    if (cancelled || dirLimitHit) return;
    if (ctx.signal.aborted) {
      cancelled = true;
      return;
    }
    if (++dirsVisited > MAX_DIRS) {
      dirLimitHit = true;
      return;
    }

    /**
     * 单调进度回报（`MONOTONIC_PROGRESS`）。
     *
     * 【定】这是全仓唯一有**真实遍历循环**的场景工具，也就是唯一能诚实
     * 回报进展的那个 —— `read_file` 一次 `readFile()` 读完，`fetch_url`
     * 卡在一个 await 上，两者都没有可回报的节点，所以它们声明 NONE。
     *
     * 频率按目录数而不是时间：这里拿不到时钟以外的东西，而目录数是
     * 单调的、与工作量成正比的。取 200 是让一次几千目录的搜索报十几次，
     * 既看得出在动、又不至于把 Trace 刷满。
     *
     * 【定】进展在批结算时才被排空（settle-batch 的注释写明了这个偏差），
     * 所以它的价值是**事后可读的工作量证据**，不是实时监控。
     */
    if (dirsVisited % PROGRESS_EVERY_DIRS === 0) {
      ctx.onProgress(`已扫描 ${dirsVisited} 个目录，命中 ${matches.length} 处`);
    }

    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      // 单个目录读不了不该让整次搜索失败（N-8 的同款教训）。
      return;
    }

    for (const name of names) {
      if (cancelled || dirLimitHit) return;
      if (ctx.signal.aborted) {
        cancelled = true;
        return;
      }
      const full = join(dir, name);

      /**
       * 契约 ③：读黑名单在**遍历时**就生效。
       *
       * 【定】不能只在读内容前判 —— `kind:"name"` 同样会把 `.env` 这个
       * 文件名报出去，而「仓库根有个 .env」本身就是给攻击者的一条线索。
       */
      if (isReadDeniedPath(full)) {
        skippedDenied += 1;
        continue;
      }

      let st;
      try {
        st = await stat(full);
      } catch {
        continue; // 断链 / 无权限的单个条目跳过，不中断整次搜索
      }

      if (st.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue; // 契约 ①
        await walk(full);
        continue;
      }
      if (!st.isFile()) continue;

      const rel = relative(ctx.workspaceRoot, full) || name;

      if (kind === "name") {
        if (name.toLowerCase().includes(needle)) matches.push({ path: rel, match: name });
        continue;
      }

      // ── content 匹配
      if (BINARY_EXTENSIONS.has(extname(name).toLowerCase())) continue; // 契约 ①
      if (st.size > MAX_CONTENT_BYTES) continue;
      scannedFiles += 1;

      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch {
        continue;
      }
      // 二进制探测的兜底：扩展名不认识但内容里有 NUL 的，跳过。
      if (text.includes("\u0000")) continue;
      if (!text.toLowerCase().includes(needle)) continue;

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.toLowerCase().includes(needle)) continue;
        // 契约 ②：带前后文与行号。
        matches.push({
          path: rel,
          line: i + 1,
          before: lines.slice(Math.max(0, i - CONTEXT_LINES), i).map(clip),
          match: clip(lines[i]!),
          after: lines.slice(i + 1, i + 1 + CONTEXT_LINES).map(clip),
        });
      }
    }
  };

  await walk(root);

  const total = matches.length;
  const page = matches.slice(cursor, cursor + PAGE);
  const nextCursor = cursor + page.length;

  return {
    ok: true,
    output: JSON.stringify({
      pattern,
      kind,
      path: rootArg,
      total,
      cursor,
      returned: page.length,
      scannedFiles,
      // 【定】被黑名单挡掉的数量必须如实报出来。悄悄跳过等于给模型一个
      // 「这里什么都没有」的假象，而事实是「有，但不给看」。
      ...(skippedDenied > 0 ? { skippedByReadGuard: skippedDenied } : {}),
      truncated: !cancelled && nextCursor < total,
      ...(!cancelled && nextCursor < total ? { nextCursor } : {}),
      ...(cancelled
        ? { cancelled: true, incompleteReason: "执行期间被取消，本次搜索不完整，不要据此下结论" }
        : {}),
      ...(dirLimitHit
        ? {
            incompleteReason: `遍历目录数超过 ${MAX_DIRS}，本次搜索没有走完整棵树 —— 请缩小 path 再搜`,
          }
        : {}),
      matches: page,
    }),
    sideEffectState: "NO_EFFECT",
  };
}

/** 单行过长时裁掉尾巴。上下文行只是给模型定位用的，不需要完整。 */
function clip(line: string): string {
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

export const searchSnapshot: ToolSnapshot = {
  toolId: searchDefinition.id,
  version: searchDefinition.version,
  definition: searchDefinition,
};
