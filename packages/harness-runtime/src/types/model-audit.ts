/**
 * 模型调用审计的跨层契约。
 *
 * 【定】这些记录只描述已经发生的 Provider I/O，不参与 Context、预算、
 * resume 或结算。完整内容刻意不进入 RunEvent：主 Trace 会被界面整文件读取，
 * 把大请求与原始流混进去会让诊断轨道反过来拖慢 Run。
 */

import type { ModelContent } from "./context.js";
import type { RuntimeErrorRecord } from "./error.js";
import type { ContextFrameId, ModelInvocationId, RunId, Timestamp } from "./ids.js";
import type { ModelUsage } from "./run.js";

export interface ModelInvocationAuditStart {
  runId: RunId;
  invocationId: ModelInvocationId;
  frameId: ContextFrameId;
  turn: number;
  endpointProfileVersion: string;
  modelId: string;
  startedAt: Timestamp;
  /** 实际交给 Provider SDK 的 body；不含认证头。 */
  requestBody: unknown;
}

export interface ProviderResponseMetadata {
  status: number;
  requestId?: string;
}

export interface ProviderFailureObservation {
  kind: "PROVIDER" | "TRANSPORT";
  name: string;
  message: string;
  status?: number;
  requestId?: string;
  /** Provider 返回的原始错误 body。网络错误没有这一项。 */
  errorBody?: unknown;
}

/**
 * 由 Runtime 提供、由形状适配器调用的观察器。
 *
 * 【定】适配器先把原始事实交给观察器，再做自己的归一化。观察器实现必须
 * fail-open、不向适配器抛错，否则一次本地审计故障会伪装成模型故障。
 */
export interface ModelInvocationObserver {
  responseMetadata(metadata: ProviderResponseMetadata): void;
  providerEvent(event: unknown): void;
  providerFailure(failure: ProviderFailureObservation): void;
}

/** 只给不属于 Run 的独立探针使用；生产 Run 一律由 Runtime 注入真实观察器。 */
export const NULL_MODEL_INVOCATION_OBSERVER: ModelInvocationObserver = {
  responseMetadata: () => {},
  providerEvent: () => {},
  providerFailure: () => {},
};

export interface AuditedModelInvocationResult {
  content: ModelContent[];
  toolCalls: Array<{ toolCallId: string; name: string; input: unknown }>;
  stopReason: string;
  usage: ModelUsage;
  interrupted: boolean;
}

export type ModelInvocationAuditEnd =
  | {
      outcome: "COMPLETED" | "INTERRUPTED";
      finishedAt: Timestamp;
      durationMs: number;
      /** 某些 ModelPort 在 deadline 时会抛 AbortError，此时没有可用的归一化结果。 */
      result?: AuditedModelInvocationResult;
      interruptionReason?: "USER_ABORT" | "DEADLINE" | "PROVIDER_ABORT";
    }
  | {
      outcome: "FAILED";
      finishedAt: Timestamp;
      durationMs: number;
      error: RuntimeErrorRecord;
    };

/** 五类持久化记录。大字段保持 unknown，reader 严格校验当前容器契约。 */
export type ModelInvocationAuditRequestRecord =
  Omit<ModelInvocationAuditStart, "requestBody"> & {
    kind: "request";
    request: { body: unknown };
  };

export interface ModelInvocationAuditResponseMetadataRecord extends ProviderResponseMetadata {
  kind: "response_metadata";
  observedAt: Timestamp;
}

export interface ModelInvocationAuditProviderEventRecord {
  kind: "provider_event";
  index: number;
  observedAt: Timestamp;
  /** SDK 解码后的 Provider 语义事件；ping 不在 SDK 迭代结果中。 */
  event: unknown;
}

export interface ModelInvocationAuditProviderErrorRecord {
  kind: "provider_error";
  observedAt: Timestamp;
  failure: ProviderFailureObservation;
}

export type ModelInvocationAuditEndRecord = ModelInvocationAuditEnd & {
  kind: "invocation_end";
};

export type ModelInvocationAuditRecord =
  | ModelInvocationAuditRequestRecord
  | ModelInvocationAuditResponseMetadataRecord
  | ModelInvocationAuditProviderEventRecord
  | ModelInvocationAuditProviderErrorRecord
  | ModelInvocationAuditEndRecord;

export type ModelInvocationAuditWriteStage =
  | "OPEN"
  | "RESPONSE_METADATA"
  | "PROVIDER_EVENT"
  | "PROVIDER_ERROR"
  | "END";

export interface ModelInvocationAuditFailure {
  stage: ModelInvocationAuditWriteStage;
  message: string;
}

export interface ModelInvocationAuditWriter {
  responseMetadata(metadata: ProviderResponseMetadata, observedAt: Timestamp): void;
  providerEvent(event: unknown, observedAt: Timestamp): void;
  providerFailure(failure: ProviderFailureObservation, observedAt: Timestamp): void;
  finish(end: ModelInvocationAuditEnd): void;
  /** 写失败或调用方放弃后只关闭文件，不伪造 invocation_end。 */
  closeIncomplete(): void;
}

export type ModelInvocationAuditReadState = "COMPLETE" | "INCOMPLETE" | "CORRUPT" | "NOT_CAPTURED";

export interface ModelInvocationAuditReadResult {
  state: ModelInvocationAuditReadState;
  /** 只包含首个坏行之前、已经通过 v1 形状与顺序校验的完整前缀。 */
  records: ModelInvocationAuditRecord[];
  errors: Array<{ line: number; message: string }>;
}
