/** Runtime 对模型审计 Port 的 fail-open 包装。 */

import type { ModelInvocationAuditStorePort } from "../ports/index.js";
import type { ModelImage } from "../types/resource.js";
import type {
  ModelInvocationAuditEnd,
  ModelInvocationAuditFailure,
  ModelInvocationAuditStart,
  ModelInvocationAuditWriteStage,
  ModelInvocationAuditWriter,
  ModelInvocationObserver,
} from "../types/model-audit.js";

export class FailOpenModelInvocationAudit {
  readonly observer: ModelInvocationObserver;
  private writer: ModelInvocationAuditWriter | undefined;
  private failure: ModelInvocationAuditFailure | undefined;
  private failureTaken = false;

  constructor(
    store: ModelInvocationAuditStorePort,
    start: ModelInvocationAuditStart,
    private readonly now: () => number,
    enabled: boolean,
  ) {
    if (enabled) {
      try {
        this.writer = store.open(start);
      } catch (error) {
        this.fail("OPEN", error);
      }
    }

    this.observer = {
      responseMetadata: (metadata) => {
        this.write("RESPONSE_METADATA", (writer) => writer.responseMetadata(metadata, this.now()));
      },
      providerEvent: (event) => {
        this.write("PROVIDER_EVENT", (writer) => writer.providerEvent(event, this.now()));
      },
      providerFailure: (failure) => {
        this.write("PROVIDER_ERROR", (writer) => writer.providerFailure(failure, this.now()));
      },
    };
  }

  finish(end: ModelInvocationAuditEnd): void {
    const writer = this.writer;
    if (!writer) return;
    try {
      writer.finish(end);
      this.writer = undefined;
    } catch (error) {
      this.fail("END", error);
    }
  }

  /** 同一个调用最多向主 Trace 报一次审计失败。 */
  takeFailure(): ModelInvocationAuditFailure | undefined {
    if (!this.failure || this.failureTaken) return undefined;
    this.failureTaken = true;
    return this.failure;
  }

  private write(
    stage: ModelInvocationAuditWriteStage,
    operation: (writer: ModelInvocationAuditWriter) => void,
  ): void {
    const writer = this.writer;
    if (!writer) return;
    try {
      operation(writer);
    } catch (error) {
      this.fail(stage, error);
    }
  }

  private fail(stage: ModelInvocationAuditWriteStage, error: unknown): void {
    if (!this.failure) {
      this.failure = {
        stage,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const writer = this.writer;
    this.writer = undefined;
    if (!writer) return;
    try {
      writer.closeIncomplete();
    } catch {
      // 第一处失败已经保留；close 的次生错误不能遮蔽它，更不能冒泡到模型调用。
    }
  }
}

/**
 * 审计里写的请求 body：与实际发出的那一份**只差图像字节**（ADR-0013 CU-8）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】按**值**替换，不按结构替换。
 *
 * 帧里装了哪几张图、每张的 base64 是什么，Runtime 一清二楚（`frame.liveImages`）；
 * 于是 body 里**恰好等于**其中某一份 base64 的字符串就是那张图，换成一句指回
 * ResourceStore 的占位（ref ＋ hash ＋ 尺寸）。这样 Runtime 不需要认识任何
 * Provider 的图像块长什么样（`source.data` 还是 `image_url`）—— 换一个形状
 * 适配器，这条照样成立。按结构替换的写法会在第二个形状上漏掉，而漏掉的
 * 后果是每次调用往盘上多写几兆屏幕内容，没有任何东西会报错。
 *
 * 为什么非删不可：活跃窗口里最多 3 张图、每轮请求都重发，一个 60 轮的 GUI
 * 任务会往审计目录写入几百兆**同样几张截图的副本**；而那些字节在 ResourceStore
 * 里已经有逐字节相同的一份（按 contentHash 可取回），审计多存一份不多一条事实。
 * 多出来的只有屏幕内容在磁盘上的副本数。
 *
 * 没有活跃图像时原样返回**同一个对象** —— 现有审计判据测的那条路径一字不变。
 * ══════════════════════════════════════════════════════════════════════
 */
export function omitLiveImageBytes(body: unknown, liveImages: Record<string, ModelImage>): unknown {
  const byData = new Map<string, ModelImage>();
  for (const img of Object.values(liveImages)) byData.set(img.data, img);
  if (byData.size === 0) return body;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const img = byData.get(v);
      return img
        ? `[图像字节未写入审计：ref=${img.ref} hash=${img.contentHash} ` +
            `${img.mediaType} ${img.width}x${img.height} base64Chars=${img.data.length}]`
        : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(body);
}
