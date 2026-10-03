/**
 * Resource 是工具产出的、可恢复的原始证据。
 *
 * 它与 Artifact 的边界是刻意的：Resource 只表达「工具确实产出了这些字节」，
 * Artifact 才表达「这些字节被写进 workspace，并作为本次 Run 的产物登记」。
 * Runtime 不会把前者自动晋升为后者。
 */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 【定】三类，第三类是 ADR-0013 加的：`image` = **模型可见**的图像。
 *
 * 它与 `binary` 的区别不在字节，在**去向**：
 *
 *   binary —— 不透明字节，**永远不进模型**（只能 materialize 落盘）；
 *   image  —— 截图这类**本来就是给模型看的**像素，编译上下文时会被
 *             原样装进请求（`ContextFrame.liveImages`），发往模型端点。
 *
 * 为什么不能复用 `binary`：那一类的全部意义是「不进模型轨道」，
 * `verify:resource` D 段就钉着这一条。把截图塞进 binary 再在某处网开一面，
 * 等于让同一个 kind 同时承诺两件相反的事 —— 读到 `binary` 的人无法判断
 * 这份字节有没有离开过本机。**去向不同就是两个类型。**
 *
 * 【定】只有工具**显式**声明的图像才是 `image`。MCP 返回的 image 块
 * 仍按 ADR-0011 落 `binary`（外部服务器的任意字节，不自动外发），
 * 要放开它需要另一个决定。
 * ══════════════════════════════════════════════════════════════════════
 */
export type ResourceKind = "text" | "binary" | "image";

export type ResourceRedactionDisposition =
  | "TEXT_REDACTED"
  | "OPAQUE_BINARY_NOT_TEXT_SCANNED"
  /**
   * 【定】图像**无法做文本脱敏**，这个标记就是如实说出这一点：
   * 屏幕上出现过的凭证、通知、聊天内容，会原样随截图发往模型端点。
   * 缓解措施在采集侧（只截白名单应用的窗口），不在这里假装脱敏过。
   */
  | "IMAGE_NOT_REDACTED_SENT_TO_MODEL";

/**
 * 模型可见图像允许的媒体类型。
 *
 * 【定】只放两个端点都实测收得下的格式（Spike 1：PNG）。JPEG 是两家文档都
 * 列出的格式，一并允许；其余（GIF / WebP）没有生产者，不预留。
 */
export const MODEL_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg"] as const;
export type ModelImageMediaType = (typeof MODEL_IMAGE_MEDIA_TYPES)[number];

export function isModelImageMediaType(m: string): m is ModelImageMediaType {
  return (MODEL_IMAGE_MEDIA_TYPES as readonly string[]).includes(m);
}

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

/**
 * 编译上下文时装进请求的一张图（ADR-0013）。
 *
 * 【定】它只活在 `ContextFrame` 上，**不进 transcript**。transcript 里只有
 * `ResourceReference`（ref ＋ hash），字节在每次编译时从 ResourceStore 取。
 * 理由：截图是上下文里最大、过期最快的东西 —— 把 base64 写进 transcript，
 * 每次 resume 重建都要整份搬一遍，而它们大多早已不在活跃窗口里。
 */
export interface ModelImage {
  ref: string;
  contentHash: string;
  mediaType: ModelImageMediaType;
  /** base64，供形状适配器原样装进请求。 */
  data: string;
  width: number;
  height: number;
  /** 按端点声明的公式估出的 token 数（`vision.imageTokens`）。 */
  estimatedTokens: number;
}

/**
 * 从 PNG / JPEG 字节读出像素尺寸。读不出返回 undefined。
 *
 * 【定】尺寸从**字节本身**读，不信工具自报：token 估算与坐标反算都依赖它，
 * 一个自报的尺寸与真实图像不符时，两者会一起错，而且不会报错。
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  // PNG：8 字节签名 + IHDR（宽高各 4 字节，大端，偏移 16 / 20）
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // JPEG：扫描 SOF0..SOF15（除 DHT/JPG/DAC）段，取高、宽
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1]!;
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
          width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
        };
      }
      i += 2 + len;
    }
  }
  return undefined;
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
