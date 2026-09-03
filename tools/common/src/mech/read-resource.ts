/**
 * read_resource —— 恢复被外置文本或查看二进制元数据。【机制工具】
 *
 * 服务的机制：ResourceRef 的模型可恢复读取。
 * 不做它会怎样：大结果与 Compact 索引虽然持久化成功，模型却无法恢复；
 * 二进制则刻意只暴露元数据，绝不返回 base64。
 */

import type {
  ResourceStorePort,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";

export const readResourceDefinition: ToolDefinition = {
  id: asId("tool_read_resource"),
  version: "1.0.0",
  name: "read_resource",
  description:
    "读取 ResourceRef。文本按行和字符偏移分页；二进制只返回元数据，绝不返回 base64 或原始字节。" +
    "二进制要原样写入 workspace 时用 materialize_resource。" +
    '文本返回 JSON：{"ref","startLine","lineOffset","endLine","totalLines","truncated","content"}；' +
    "有后续时把 nextStartLine 和 nextLineOffset 原样传回来。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ref: { type: "string", description: 'Runtime 返回的引用，形如 "res_xxx"' },
      start_line: { type: "number", description: "从第几行开始，1 起。默认 1" },
      limit: { type: "number", description: "最多返回多少行。默认 2000" },
      line_offset: { type: "number", description: "起始行内字符偏移，0 起" },
    },
    required: ["ref"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/ref",
      effectType: "READ",
      scopeKind: "NONE",
      reversibility: "REVERSIBLE",
      operation: "read_resource",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 10_000 },
  progressReporting: { mode: "NONE" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
};

export async function executeReadResource(
  input: { ref: string; start_line?: number; limit?: number; line_offset?: number },
  _ctx: ToolExecutionContext,
  resources: ResourceStorePort | undefined,
): Promise<ToolExecutionOutcome> {
  if (!resources) return storeAbsent();
  let metadata;
  try {
    metadata = await resources.getMetadata(input.ref);
  } catch (err) {
    return storeReadFailure(input.ref, err);
  }
  if (!metadata) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_RESOURCE_NOT_FOUND",
        source: "TOOL_INPUT",
        category: "NOT_FOUND",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `没有 ref 为 "${input.ref}" 的 Resource。请从工具结果的 resourceRefs 原样复制。`,
      }),
    };
  }

  if (metadata.kind === "binary") {
    return {
      ok: true,
      output: JSON.stringify({
        ...metadata,
        content: null,
        note: "二进制 Resource 不进入模型。要原样写入 workspace，请调用 materialize_resource。",
      }),
      sideEffectState: "NO_EFFECT",
    };
  }

  let page;
  try {
    page = await resources.getTextPage(input.ref, {
      ...(input.start_line === undefined ? {} : { startLine: input.start_line }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.line_offset === undefined ? {} : { lineOffset: input.line_offset }),
    });
  } catch (err) {
    return storeReadFailure(input.ref, err);
  }
  if (!page) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_RESOURCE_UNREADABLE",
        source: "RUNTIME",
        category: "INTERNAL",
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `Resource ${input.ref} 的元数据存在，但文本内容无法读取。`,
      }),
    };
  }
  return {
    ok: true,
    output: JSON.stringify({
      ...page,
      ...(page.truncated
        ? { nextStartLine: page.nextStartLine, nextLineOffset: page.nextLineOffset }
        : {}),
    }),
    sideEffectState: "NO_EFFECT",
  };
}

function storeReadFailure(ref: string, err: unknown): ToolExecutionOutcome {
  return {
    ok: false,
    output: "",
    sideEffectState: "NO_EFFECT",
    error: makeError({
      code: "TOOL_RESOURCE_STORE_READ_FAILED",
      source: "RUNTIME",
      category: "INTERNAL",
      retryability: "AFTER_USER_ACTION",
      sideEffectState: "NO_EFFECT",
      safeMessage:
        `读取 Resource ${ref} 的存储失败，未产生文件副作用：` +
        String((err as Error)?.message ?? err).slice(0, 180),
    }),
  };
}

function storeAbsent(): ToolExecutionOutcome {
  return {
    ok: false,
    output: "",
    sideEffectState: "NO_EFFECT",
    error: makeError({
      code: "TOOL_RESOURCE_STORE_ABSENT",
      source: "RUNTIME",
      category: "INTERNAL",
      retryability: "AFTER_USER_ACTION",
      sideEffectState: "NO_EFFECT",
      safeMessage: "本次装配没有注入 ResourceStorePort，资源恢复工具无法工作。",
    }),
  };
}

export const readResourceSnapshot: ToolSnapshot = {
  toolId: readResourceDefinition.id,
  version: readResourceDefinition.version,
  definition: readResourceDefinition,
};
