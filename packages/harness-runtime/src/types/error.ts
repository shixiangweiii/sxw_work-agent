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
 * 实际会产生的 source 值域（D-22）。
 *
 * ── M-7：阶段 2 补齐并**接上校验** ─────────────────────────────────────
 *
 * 这两个常量在阶段 1 与实际产生的值不符（缺 USER、NOT_FOUND、AUTHORIZATION、
 * REDACTION、QUOTA、RATE_LIMIT、UNAVAILABLE），**而且全仓无人消费** ——
 * 也就是说 D-22 的「值域裁剪」声明当时是不可验证的。
 *
 * 二选一里选「补齐并接校验」而不是「删掉」：D-22 的裁剪声明本身有价值
 * （它记录了「哪些路径已经被用例覆盖过」），删掉等于丢掉那个信息。
 * 但一个不可验证的声明等于没有声明，所以给它接上 `assertActiveErrorDomain()`，
 * 让 `makeError` 在开发期就把越界的值喊出来。
 */
export const ACTIVE_ERROR_SOURCES = [
  "MODEL_PROVIDER",
  "MODEL_SDK",
  "TOOL_INPUT",
  "TOOL_HANDLER",
  "POLICY",
  "CONTEXT",
  "RUNTIME",
  // 这两个是阶段 1 实际产生过却漏记的（M-7）：
  //   USER         —— 审批拒绝走的就是它；
  //   VERIFICATION —— R-4 的 guard 在 VerificationPort 抛异常时产生。
  // 后者是接上校验的**当场**被抓出来的：verify:pairing 的 R-4 注入 D 立刻翻红。
  "USER",
  "VERIFICATION",
] as const satisfies readonly ErrorSource[];

/** @deprecated 改名为 ACTIVE_ERROR_SOURCES —— 它不再只描述阶段 1。 */
export const STAGE1_ACTIVE_SOURCES = ACTIVE_ERROR_SOURCES;

/** 实际会产生的 category 值域（D-22）。补齐说明见上方 ACTIVE_ERROR_SOURCES。 */
export const ACTIVE_ERROR_CATEGORIES = [
  "VALIDATION",
  "AUTHENTICATION",
  "TIMEOUT",
  "CANCELLED",
  "PROTOCOL",
  "CAPACITY",
  "INTERNAL",
  "UNKNOWN",
  // 以下四个是阶段 1 实际产生过、却漏记的（M-7）。
  "AUTHORIZATION",
  "NOT_FOUND",
  "REDACTION",
  "UNAVAILABLE",
  // QUOTA / RATE_LIMIT **刻意不登记**：当前没有任何代码路径产生它们。
  // 登记一个没有用例覆盖的值，恰好破坏 D-22 裁剪声明的全部价值 ——
  // 那份记录的意义就在于「登记的都被用例覆盖过」。等 R-1 的配额路径
  // 真的接进来再加。
] as const satisfies readonly ErrorCategory[];

/** @deprecated 改名为 ACTIVE_ERROR_CATEGORIES。 */
export const STAGE1_ACTIVE_CATEGORIES = ACTIVE_ERROR_CATEGORIES;

/**
 * 越界即抛（M-7）。
 *
 * 【定】只在**开发期**抛（`NODE_ENV !== "production"`）。
 * D-22 的裁剪声明是一份「哪些路径已被用例覆盖过」的记录，产生一个
 * 未登记的值不代表运行出错，只代表这份记录该更新了 ——
 * 为此把用户的 Run 打断是不成比例的。
 *
 * 但开发期必须响亮：一个不可验证的值域声明等于没有声明，
 * 而这两个常量在阶段 1 就是那样存在了整整一个阶段。
 */
function assertActiveErrorDomain(source: ErrorSource, category: ErrorCategory): void {
  if (process.env["NODE_ENV"] === "production") return;
  const sOk = (ACTIVE_ERROR_SOURCES as readonly string[]).includes(source);
  const cOk = (ACTIVE_ERROR_CATEGORIES as readonly string[]).includes(category);
  if (sOk && cOk) return;
  throw new Error(
    `错误值域越界（D-22 / M-7）：${!sOk ? `source=${source} ` : ""}${!cOk ? `category=${category} ` : ""}` +
      `不在已登记的活跃值域里。\n` +
      `这不是运行错误，是**记录过期**：types/error.ts 的 ACTIVE_ERROR_* 该补上这个值了。\n` +
      `补之前先想清楚它对应哪条路径 —— D-22 的裁剪声明的价值就在于「登记的都被用例覆盖过」。`,
  );
}

export function makeError(
  init: Omit<RuntimeErrorRecord, "schemaVersion" | "occurredAt"> &
    Partial<Pick<RuntimeErrorRecord, "occurredAt">>,
): RuntimeErrorRecord {
  // M-7：值域声明在这里才第一次有了消费点。
  assertActiveErrorDomain(init.source, init.category);
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
