/**
 * read_blob —— 按 ref 取回被外置的大结果。【机制工具】
 *
 * 服务的机制：**§11.4 ToolResult Materialization**。
 *
 * 不做它会怎样：大结果外置退化成**比静默截断更糟的信息完全阻断** ——
 *   模型在帧里看得到 `{"status":"EXTERNALIZED","ref":"blob_…","sizeBytes":512000}`，
 *   却没有任何手段拿到内容。静默截断至少给了错误的完整感；
 *   阻断是明知有东西而拿不到，模型唯一能做的是重新执行那个工具，
 *   于是又产出一个同样取不回来的 ref —— 一个稳定的死循环。
 *
 * 【定】这就是为什么 `settle-batch.ts` 的 `materialize()` 在
 * `deps.blobs` 缺席时**宁可 inline 也不外置**：没有取回通路就不要外置。
 * 两处是同一条不变量的两半（不得绕过清单 #9）。
 *
 * ── 它为什么过不了「三场景」标准，以及为什么这不算问题 ──────────────────
 *
 * 办公 / 代码 / 聊天里没有人会说「我要按 ref 取一个 blob」。它服务的是
 * Harness 机制，不是业务动作 —— 这正是决 2 修订 1 补出「机制工具」这一类的
 * 原因。硬套三场景标准会逼出一段编造的用例，而编造的用例会污染那条标准
 * 对**场景工具**的约束力。
 *
 * ── 形态 ──────────────────────────────────────────────────────────────
 *
 * 只读、幂等 → §18.2 分支一。分页语义与 `read_file` **逐字一致**（按行、
 * 显式 truncated、nextStartLine）—— 模型在两个工具之间不需要换脑子。
 */

import type {
  BlobStorePort,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";

export const readBlobDefinition: ToolDefinition = {
  id: asId("tool_read_blob"),
  version: "1.0.0",
  name: "read_blob",
  description:
    "取回被外置的大结果。当某次工具调用返回 {\"status\":\"EXTERNALIZED\",\"ref\":\"blob_…\"} 时，" +
    "用它给出的 ref 调本工具拿内容。只读。" +
    "按**行**分页：start_line 从 1 起（默认 1），limit 是最多返回多少行（默认 2000）。" +
    '返回 JSON：{"ref","startLine","lineOffset","endLine","totalLines","truncated","sizeBytes","content"}，' +
    '还有后续内容时带 "nextStartLine" 与 "nextLineOffset" —— 把这两个原样传回来就能接着取。' +
    "单页还有字符上限，所以一行很长时（工具结果常常是一整行 JSON）会切片返回，" +
    "这时 nextLineOffset 是非 0 的行内偏移。" +
    "不要为了拿内容而重新执行原来那个工具 —— 那只会产生一个新的 ref。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
    properties: {
      ref: { type: "string", description: '外置结果里给出的 ref，形如 "blob_xxx"' },
      start_line: { type: "number", description: "从第几行开始取，1 起。默认 1" },
      limit: { type: "number", description: "最多返回多少行。默认 2000" },
      line_offset: {
        type: "number",
        description: "起始行内的字符偏移，0 起。续取超长单行时把上一页的 nextLineOffset 传进来",
      },
    },
    required: ["ref"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/ref",
      effectType: "READ",
      // 【定】不是 FILE —— blob 不在文件系统里，它在 Runtime 自己的库里。
      // 标成 FILE 会让 EffectResolver 去 resolve 一个不存在的路径，
      // 然后 Policy 拿着一个假的 workspace 判定去做决定。
      scopeKind: "NONE",
      reversibility: "REVERSIBLE",
      operation: "read_blob",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 10_000 },
  progressReporting: { mode: "NONE" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
};

/**
 * 【定】它需要 `BlobStorePort`，而 Handler 拿不到 Port。
 *
 * 所以 Composition Root 在构造 `CommonToolHandler` 时把 store 注入进来。
 * 这不是「工具认识 Runtime」——`BlobStorePort` 是一个接口，工具包依赖的是
 * 类型，不是实现；实现由 `apps/cli` 决定（边界 6 因此仍然成立：
 * `packages/` 与 `adapters/` 一个字都没有依赖工具包）。
 */
export async function executeReadBlob(
  input: { ref: string; start_line?: number; limit?: number; line_offset?: number },
  _ctx: ToolExecutionContext,
  blobs: BlobStorePort | undefined,
): Promise<ToolExecutionOutcome> {
  if (!blobs) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_BLOB_STORE_ABSENT",
        source: "RUNTIME",
        category: "INTERNAL",
        // 装配问题，模型改参数没用。
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "NO_EFFECT",
        safeMessage:
          "本次装配没有注入 BlobStorePort，read_blob 无法工作。" +
          "这是装配错误：外置与取回必须一起在场，不能只有一半。",
      }),
    };
  }

  const page = await blobs.get(input.ref, {
    ...(input.start_line === undefined ? {} : { startLine: input.start_line }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.line_offset === undefined ? {} : { lineOffset: input.line_offset }),
  });

  if (!page) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_BLOB_NOT_FOUND",
        source: "TOOL_INPUT",
        category: "NOT_FOUND",
        // ref 写错了模型自己能改 —— 把正确的 ref 从上文里再抄一次。
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage:
          `没有 ref 为 "${input.ref}" 的外置结果。` +
          `ref 要从工具返回里的 "ref" 字段原样复制，不要自己拼。`,
      }),
    };
  }

  return {
    ok: true,
    output: JSON.stringify({
      ref: page.ref,
      startLine: page.startLine,
      lineOffset: page.lineOffset,
      endLine: page.endLine,
      totalLines: page.totalLines,
      sizeBytes: page.sizeBytes,
      truncated: page.truncated,
      // 【定】next* 原样透传 store 给的值，**不要自己算**。
      // 自己算 `endLine + 1` 在超长单行切片时是错的：那一页停在行内，
      // 下一页要从**同一行**的某个偏移接着取，而不是下一行。
      ...(page.truncated
        ? { nextStartLine: page.nextStartLine, nextLineOffset: page.nextLineOffset }
        : {}),
      content: page.content,
    }),
    sideEffectState: "NO_EFFECT",
  };
}

export const readBlobSnapshot: ToolSnapshot = {
  toolId: readBlobDefinition.id,
  version: readBlobDefinition.version,
  definition: readBlobDefinition,
};
