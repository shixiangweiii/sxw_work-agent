/**
 * 模型调用原始 I/O 的独立 JSONL sidecar。
 *
 * 【定】这里不复用 FileTraceSink：主 Trace 是界面整文件读取的 RunEvent 轨道，
 * 本文件则可能包含数百条 SDK 解码 Provider 事件和完整上下文。混用会让观察能力拖垮展示层，
 * 也会让 Trace 的“业务事件 + 流式增量 + 边界”口径失真。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  ModelInvocationAuditEnd,
  ModelInvocationAuditRecord,
  ModelInvocationAuditReadResult,
  ModelInvocationAuditStart,
  ModelInvocationAuditStorePort,
  ModelInvocationAuditWriter,
  ProviderFailureObservation,
  ProviderResponseMetadata,
  Timestamp,
} from "@workagent/harness-runtime";

export class FileModelInvocationAuditStore implements ModelInvocationAuditStorePort {
  constructor(private readonly rootDir: string) {}

  open(start: ModelInvocationAuditStart): ModelInvocationAuditWriter {
    const runId = safeComponent(String(start.runId), "runId");
    const invocationId = safeComponent(String(start.invocationId), "invocationId");
    const runDir = resolve(this.rootDir, runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const path = resolve(runDir, `${invocationId}.jsonl`);
    const fd = openSync(path, "wx", 0o600);
    const writer = new FileModelInvocationAuditWriter(fd);
    try {
      writer.write({
        kind: "request",
        runId: start.runId,
        invocationId: start.invocationId,
        frameId: start.frameId,
        turn: start.turn,
        endpointProfileVersion: start.endpointProfileVersion,
        modelId: start.modelId,
        startedAt: start.startedAt,
        request: { body: start.requestBody },
      });
      return writer;
    } catch (error) {
      writer.closeIncomplete();
      throw error;
    }
  }
}

class FileModelInvocationAuditWriter implements ModelInvocationAuditWriter {
  private closed = false;
  private providerEventIndex = 0;

  constructor(private readonly fd: number) {}

  responseMetadata(metadata: ProviderResponseMetadata, observedAt: Timestamp): void {
    this.write({
      kind: "response_metadata",
      observedAt,
      ...metadata,
    });
  }

  providerEvent(event: unknown, observedAt: Timestamp): void {
    this.providerEventIndex += 1;
    this.write({
      kind: "provider_event",
      index: this.providerEventIndex,
      observedAt,
      event,
    });
  }

  providerFailure(failure: ProviderFailureObservation, observedAt: Timestamp): void {
    this.write({
      kind: "provider_error",
      observedAt,
      failure,
    });
  }

  finish(end: ModelInvocationAuditEnd): void {
    try {
      this.write({
        kind: "invocation_end",
        ...end,
      });
    } finally {
      this.closeIncomplete();
    }
  }

  closeIncomplete(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  write(record: ModelInvocationAuditRecord): void {
    if (this.closed) throw new Error("模型调用审计文件已经关闭");
    const json = JSON.stringify(record);
    if (json === undefined) throw new Error("模型调用审计记录不能序列化为 JSON");
    writeSync(this.fd, `${json}\n`, undefined, "utf8");
  }
}

export function readModelInvocationAudit(path: string): ModelInvocationAuditReadResult {
  if (!existsSync(path)) return { state: "NOT_CAPTURED", records: [], errors: [] };

  const raw = readFileSync(path, "utf8");
  if (raw.length === 0) return { state: "INCOMPLETE", records: [], errors: [] };

  const records: ModelInvocationAuditRecord[] = [];
  const lines = raw.split("\n");
  // writer 每条记录都以换行收尾；只忽略这一个由末尾换行产生的空元素。
  if (lines.at(-1) === "") lines.pop();
  let metadataSeen = false;
  let providerEventSeen = false;
  let providerErrorSeen = false;
  let expectedProviderEventIndex = 1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim()) return corrupt(records, i + 1, "审计文件内部存在空白行");

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return corrupt(records, i + 1, error instanceof Error ? error.message : String(error));
    }

    const shapeError = auditRecordShapeError(parsed);
    if (shapeError) return corrupt(records, i + 1, shapeError);
    const record = parsed as ModelInvocationAuditRecord;

    switch (record.kind) {
      case "request":
        if (records.length > 0) return corrupt(records, i + 1, "request 必须是唯一的首条记录");
        break;
      case "response_metadata":
        if (records[0]?.kind !== "request") return corrupt(records, i + 1, "缺少首条 request");
        if (metadataSeen) return corrupt(records, i + 1, "response_metadata 不能重复");
        if (providerEventSeen || providerErrorSeen) {
          return corrupt(records, i + 1, "response_metadata 必须早于 Provider 事件和错误");
        }
        metadataSeen = true;
        break;
      case "provider_event":
        if (records[0]?.kind !== "request") return corrupt(records, i + 1, "缺少首条 request");
        if (providerErrorSeen) return corrupt(records, i + 1, "provider_error 后不能再出现事件");
        if (record.index !== expectedProviderEventIndex) {
          return corrupt(
            records,
            i + 1,
            `provider_event.index 应为 ${expectedProviderEventIndex}，实际为 ${record.index}`,
          );
        }
        expectedProviderEventIndex += 1;
        providerEventSeen = true;
        break;
      case "provider_error":
        if (records[0]?.kind !== "request") return corrupt(records, i + 1, "缺少首条 request");
        if (providerErrorSeen) return corrupt(records, i + 1, "provider_error 不能重复");
        providerErrorSeen = true;
        break;
      case "invocation_end":
        if (records[0]?.kind !== "request") return corrupt(records, i + 1, "缺少首条 request");
        if (i !== lines.length - 1) {
          return corrupt(records, i + 1, "invocation_end 必须是最后一条记录");
        }
        break;
    }

    records.push(record);
  }

  return {
    state: records.at(-1)?.kind === "invocation_end" ? "COMPLETE" : "INCOMPLETE",
    records,
    errors: [],
  };
}

function corrupt(
  records: ModelInvocationAuditRecord[],
  line: number,
  message: string,
): ModelInvocationAuditReadResult {
  return { state: "CORRUPT", records, errors: [{ line, message }] };
}

function auditRecordShapeError(value: unknown): string | undefined {
  if (!isRecord(value)) return "记录必须是 JSON object";

  switch (value["kind"]) {
    case "request":
      if (!stringFields(value, ["runId", "invocationId", "frameId", "endpointProfileVersion", "modelId"])) {
        return "request 的调用身份字段必须是非空字符串";
      }
      if (!positiveInteger(value["turn"]) || !finiteNumber(value["startedAt"])) {
        return "request.turn 必须为正整数且 startedAt 必须为有限数字";
      }
      if (!isRecord(value["request"]) || !hasOwn(value["request"], "body")) {
        return "request 必须包含 body 字段";
      }
      return undefined;
    case "response_metadata":
      if (!httpStatus(value["status"]) || !finiteNumber(value["observedAt"])) {
        return "response_metadata.status/observedAt 无效";
      }
      return optionalStringError(value, "requestId");
    case "provider_event":
      if (!positiveInteger(value["index"]) || !finiteNumber(value["observedAt"])) {
        return "provider_event.index/observedAt 无效";
      }
      return hasOwn(value, "event") ? undefined : "provider_event 缺少 event 字段";
    case "provider_error": {
      if (!finiteNumber(value["observedAt"]) || !isRecord(value["failure"])) {
        return "provider_error.observedAt/failure 无效";
      }
      const failure = value["failure"];
      if (
        (failure["kind"] !== "PROVIDER" && failure["kind"] !== "TRANSPORT") ||
        typeof failure["name"] !== "string" ||
        typeof failure["message"] !== "string"
      ) {
        return "provider_error.failure 的 kind/name/message 无效";
      }
      if (failure["status"] !== undefined && !httpStatus(failure["status"])) {
        return "provider_error.failure.status 无效";
      }
      return optionalStringError(failure, "requestId");
    }
    case "invocation_end":
      if (
        value["outcome"] !== "COMPLETED" &&
        value["outcome"] !== "INTERRUPTED" &&
        value["outcome"] !== "FAILED"
      ) {
        return "invocation_end.outcome 无效";
      }
      if (!finiteNumber(value["finishedAt"]) || !nonNegativeNumber(value["durationMs"])) {
        return "invocation_end.finishedAt/durationMs 无效";
      }
      if (value["outcome"] === "FAILED" && !isRecord(value["error"])) {
        return "FAILED invocation_end 必须包含 error object";
      }
      if (value["result"] !== undefined && !isRecord(value["result"])) {
        return "invocation_end.result 必须是 object";
      }
      if (
        value["interruptionReason"] !== undefined &&
        value["interruptionReason"] !== "USER_ABORT" &&
        value["interruptionReason"] !== "DEADLINE" &&
        value["interruptionReason"] !== "PROVIDER_ABORT"
      ) {
        return "invocation_end.interruptionReason 无效";
      }
      return undefined;
    default:
      return `未知审计记录 kind：${String(value["kind"])}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringFields(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === "string" && value[field] !== "");
}

function optionalStringError(value: Record<string, unknown>, field: string): string | undefined {
  return value[field] === undefined || typeof value[field] === "string"
    ? undefined
    : `${field} 必须是字符串`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeNumber(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function httpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function safeComponent(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} 不是安全的文件名组成部分：${value}`);
  }
  return value;
}
