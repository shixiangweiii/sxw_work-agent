/**
 * 多维错误模型（V05 §13）。
 *
 * D-22：四个维度全部保留（结构经三轮实测验证），
 * 阶段 1 值域裁剪到 Micro Case 能真正触发的 —— 未触发的枚举值留在类型里但不产生，
 * 避免写出没有任何用例检验过的分类逻辑。
 */

import type { BlobRef, EndpointId, Timestamp } from "./ids.js";

export type ErrorSource =
  | "MODEL_PROVIDER"
  /**
   * 错误来自 SDK 而非 Provider。实测依据：max_tokens: 99999999 被 Anthropic SDK
   * 自己拦截（提示需要流式），根本没发出请求。
   * 没有这个来源，这类错误会被误归类为 MODEL_PROVIDER，进而影响 retryability
   * —— SDK 层的参数校验错误重试多少次都没用。
   */
  | "MODEL_SDK"
  | "TOOL_INPUT"
  | "TOOL_HANDLER"
  | "POLICY"
  | "CAPABILITY"
  | "RESOURCE"
  | "VERIFICATION"
  | "CONTEXT"
  | "STORAGE"
  | "RUNTIME"
  | "USER"
  | "UNKNOWN";

export type ErrorCategory =
  | "VALIDATION"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMIT"
  /**
   * 与 RATE_LIMIT 分开。处置完全不同：配额可能需要等很久或换端点，
   * 限流退避重试即可。实测：百炼 OpenAI 形状对 60 万 token 返回 429 insufficient_quota，
   * 同平台 Anthropic 形状接受同一 payload —— 配额是先于上下文窗口撞上的那堵墙。
   */
  | "QUOTA"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "CANCELLED"
  | "PROTOCOL"
  | "REDACTION"
  /** 推理吃光输出预算落这里：接口成功、无错误码、内容为空。 */
  | "CAPACITY"
  | "INTERNAL"
  | "UNKNOWN";

export type Retryability =
  | "NEVER"
  | "SAME_INPUT_IMMEDIATE"
  | "SAME_INPUT_BACKOFF"
  | "AFTER_MODEL_CORRECTION"
  | "AFTER_USER_ACTION"
  | "AFTER_ENVIRONMENT_CHANGE";

/**
 * 与 category 是两个独立维度，不得合并 ——「请求超时」不告诉你副作用发没发生。
 * UNKNOWN 时不得自动重试（不变量 10）。
 */
export type SideEffectState =
  | "NOT_STARTED"
  | "NO_EFFECT"
  | "APPLIED"
  | "PARTIALLY_APPLIED"
  | "UNKNOWN";

export interface RuntimeErrorRecord {
  code: string;
  schemaVersion: number;
  source: ErrorSource;
  category: ErrorCategory;
  retryability: Retryability;
  sideEffectState: SideEffectState;
  /** 已脱敏，可以展示给用户。 */
  safeMessage: string;
  diagnosticRef?: BlobRef;
  providerCode?: string;
  endpointId?: EndpointId;
  occurredAt: Timestamp;
}

export type ErrorDisposition =
  | "RETRY_AUTOMATICALLY"
  | "RETURN_TO_MODEL"
  | "SKIP_REMAINING_BATCH"
  | "REQUEST_APPROVAL"
  | "REQUEST_USER_INPUT"
  | "ENTER_RECOVERY"
  | "FAIL_RUN";

/**
 * 阶段 1 实际会产生的 source 值域（D-22）。
 * 其余枚举值留在类型里，等对应路径被 Micro Case 覆盖后再产生。
 */
export const STAGE1_ACTIVE_SOURCES = [
  "MODEL_PROVIDER",
  "MODEL_SDK",
  "TOOL_INPUT",
  "TOOL_HANDLER",
  "POLICY",
  "CONTEXT",
  "RUNTIME",
] as const satisfies readonly ErrorSource[];

/** 阶段 1 实际会产生的 category 值域（D-22）。 */
export const STAGE1_ACTIVE_CATEGORIES = [
  "VALIDATION",
  "AUTHENTICATION",
  "TIMEOUT",
  "CANCELLED",
  "PROTOCOL",
  "CAPACITY",
  "INTERNAL",
  "UNKNOWN",
] as const satisfies readonly ErrorCategory[];

export function makeError(
  init: Omit<RuntimeErrorRecord, "schemaVersion" | "occurredAt"> &
    Partial<Pick<RuntimeErrorRecord, "occurredAt">>,
): RuntimeErrorRecord {
  return {
    schemaVersion: 1,
    occurredAt: init.occurredAt ?? Date.now(),
    ...init,
  };
}

/** 不变量 10 的判据函数。副作用状态未知时不得自动重试。 */
export function mayRetryAutomatically(e: RuntimeErrorRecord): boolean {
  if (e.sideEffectState === "UNKNOWN" || e.sideEffectState === "PARTIALLY_APPLIED") {
    return false;
  }
  return e.retryability === "SAME_INPUT_IMMEDIATE" || e.retryability === "SAME_INPUT_BACKOFF";
}
