/** Anthropic SDK 错误的结构化事实。客户端审计与协议归一化必须共用同一判据。 */

export interface AnthropicErrorFacts {
  name: string;
  constructorName: string;
  message: string;
  status?: number;
  requestId?: string;
  errorBody?: unknown;
  providerErrorType?: string;
  /** 收到了 Provider 的响应事实；不能再把它归为本地 transport / SDK 拒绝。 */
  providerResponded: boolean;
}

/**
 * Anthropic SDK 对流内 `event:error` 抛出的 `APIError` 没有 HTTP error status，
 * 但仍带 response headers、requestID 与原始 error body。只看 status 会把一次
 * 已经建立成功的 HTTP 200 响应误报成「请求没有到达 Provider」。
 *
 * 这里刻意不 import SDK：构造器名与公开字段已经是形状事实，同时让 client 与
 * protocol 不会各自复制一份迟早分叉的判据。
 */
export function readAnthropicErrorFacts(error: unknown): AnthropicErrorFacts {
  const value = isRecord(error) ? error : {};
  const status = typeof value["status"] === "number" ? value["status"] : undefined;
  const requestId = typeof value["requestID"] === "string" ? value["requestID"] : undefined;
  const errorBody = value["error"];
  const constructorName = constructorNameOf(value["constructor"]);
  const errorType = providerErrorType(errorBody);
  const message =
    typeof value["message"] === "string"
      ? value["message"]
      : error instanceof Error
        ? error.message
        : String(error);

  return {
    name: typeof value["name"] === "string" ? value["name"] : "Error",
    constructorName,
    message,
    ...(status === undefined ? {} : { status }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(errorBody === undefined ? {} : { errorBody }),
    ...(errorType === undefined ? {} : { providerErrorType: errorType }),
    providerResponded:
      status !== undefined || requestId !== undefined || errorBody !== undefined,
  };
}

function constructorNameOf(value: unknown): string {
  if (typeof value === "function" && typeof value.name === "string") return value.name;
  return isRecord(value) && typeof value["name"] === "string" ? value["name"] : "";
}

function providerErrorType(errorBody: unknown): string | undefined {
  if (!isRecord(errorBody)) return undefined;
  const nested = errorBody["error"];
  if (isRecord(nested) && typeof nested["type"] === "string") return nested["type"];
  const direct = errorBody["type"];
  return typeof direct === "string" && direct !== "error" ? direct : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
