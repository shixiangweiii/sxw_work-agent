/**
 * ID 与标量类型。
 *
 * 全部用 branded string：编译期区分 RunId 与 ActionId，运行期零开销。
 * 阶段 1 的 ID 由 IdGeneratorPort 产生，测试注入确定性实现（V05 §24.2）。
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type Timestamp = number;

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type RunSpecId = Brand<string, "RunSpecId">;
export type AgentSpecId = Brand<string, "AgentSpecId">;
export type EndpointId = Brand<string, "EndpointId">;
export type EndpointCapabilityProfileId = Brand<string, "EndpointCapabilityProfileId">;
export type ModelInvocationId = Brand<string, "ModelInvocationId">;
export type ContextItemId = Brand<string, "ContextItemId">;
export type ContextFrameId = Brand<string, "ContextFrameId">;
export type ActionBatchId = Brand<string, "ActionBatchId">;
export type ActionId = Brand<string, "ActionId">;
export type AttemptId = Brand<string, "AttemptId">;
export type ToolId = Brand<string, "ToolId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type VerificationId = Brand<string, "VerificationId">;
export type BlobRef = Brand<string, "BlobRef">;

/** 把裸 string 标记为某种 ID。只应在 IdGeneratorPort 与反序列化边界使用。 */
export const asId = <T extends string>(raw: string): T => raw as T;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface VersionedRef<_T> {
  id: string;
  version: string;
}
