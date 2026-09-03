/**
 * Resource 是工具产出的、可恢复的原始证据。
 *
 * 它与 Artifact 的边界是刻意的：Resource 只表达「工具确实产出了这些字节」，
 * Artifact 才表达「这些字节被写进 workspace，并作为本次 Run 的产物登记」。
 * Runtime 不会把前者自动晋升为后者。
 */

export type ResourceKind = "text" | "binary";

export type ResourceRedactionDisposition =
  | "TEXT_REDACTED"
  | "OPAQUE_BINARY_NOT_TEXT_SCANNED";

/** 工具边界返回的资源；此时还没有经过 Runtime 持久化。 */
export interface ProducedResource {
  kind: ResourceKind;
  /** 给模型和审计者辨认资源的短名称，不是文件路径。 */
  label: string;
  mediaType: string;
  suggestedFilename?: string;
  /** 文本按 UTF-8；二进制必须用 Uint8Array，禁止 base64 穿过模型通道。 */
  content: string | Uint8Array;
}

/** 已持久化的不可变 Resource 句柄。它可以安全进入 Transcript 与模型请求。 */
export interface ResourceReference {
  ref: string;
  contentHash: string;
  sizeBytes: number;
  kind: ResourceKind;
  mediaType: string;
  label: string;
  suggestedFilename?: string;
  redactionDisposition: ResourceRedactionDisposition;
}

export interface ResourcePutInput {
  kind: ResourceKind;
  mediaType: string;
  label: string;
  suggestedFilename?: string;
  content: string | Uint8Array;
  redactionDisposition: ResourceRedactionDisposition;
}

/** 文本 Resource 的分页结果；二进制永远不会产生这个结构。 */
export interface ResourceTextPage extends ResourceReference {
  totalLines: number;
  startLine: number;
  endLine: number;
  lineOffset: number;
  truncated: boolean;
  nextStartLine?: number;
  nextLineOffset?: number;
  content: string;
}

/** 只供本地机制工具物化使用；不得写入 Transcript、Trace 或模型审计。 */
export interface MaterializableResource {
  reference: ResourceReference;
  content: Uint8Array;
}

/** 单个 Resource 的统一硬上限。Store 仍会独立复核，不能只信工具。 */
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;

/**
 * ResourceRefs 在模型协议、token 估算与 Context hash 中的唯一文本表示。
 * 固定键顺序，避免对象构造顺序让相同引用生成不同帧 hash。
 */
export function renderResourceReferences(refs: ResourceReference[] | undefined): string {
  if (!refs || refs.length === 0) return "";
  return JSON.stringify({
    resourceRefs: refs.map((r) => ({
      ref: r.ref,
      contentHash: r.contentHash,
      sizeBytes: r.sizeBytes,
      kind: r.kind,
      mediaType: r.mediaType,
      label: r.label,
      ...(r.suggestedFilename === undefined
        ? {}
        : { suggestedFilename: r.suggestedFilename }),
      redactionDisposition: r.redactionDisposition,
    })),
  });
}

/** 模型实际收到的 tool_result 文本；Context hash 与 Adapter 必须共同调用它。 */
export function renderToolResultForModel(
  content: string,
  refs: ResourceReference[] | undefined,
): string {
  if (!refs || refs.length === 0) return content;
  const rendered = JSON.parse(renderResourceReferences(refs)) as {
    resourceRefs: unknown[];
  };
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      !("__atlasResourceRefs" in parsed)
    ) {
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        __atlasResourceRefs: rendered.resourceRefs,
      });
    }
  } catch {
    // 非 JSON 结果使用明确的文本附录。
  }
  return `${content}\n\n[Runtime ResourceRefs]\n${JSON.stringify(rendered)}`;
}
