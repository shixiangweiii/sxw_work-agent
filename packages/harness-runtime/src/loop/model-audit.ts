/** Runtime 对模型审计 Port 的 fail-open 包装。 */

import type { ModelInvocationAuditStorePort } from "../ports/index.js";
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
