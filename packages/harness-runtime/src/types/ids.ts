/**
 * ID 与标量类型。
 *
 * 全部用 branded string：编译期区分 RunId 与 ActionId，运行期零开销。
 * ID 由 IdGeneratorPort 产生。
 *
 * 【定】这里只放**有生产者**的 ID 类型。凭空预留一个 branded type
 * 不会有任何东西提醒你它从来没被用过。
 */

import { createHash } from "node:crypto";

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type Timestamp = number;

export type WorkspaceId = Brand<string, "WorkspaceId">;
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

/** 把裸 string 标记为某种 ID。只应在 IdGeneratorPort 与反序列化边界使用。 */
export const asId = <T extends string>(raw: string): T => raw as T;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 短摘要。**全仓唯一一份** —— `inputDigest`、`ResolvedEffect.digest`、
 * ContextItem/Frame 的 contentHash 都走它。
 *
 * 【定】不要在各文件里各写一个 `sha256(s).slice(0, 32)`：Progress Guard 的
 * 打转检测比的正是这几个 digest，两处口径一旦分叉，比对会静默失准。
 */
export function digest(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

export interface VersionedRef {
  id: string;
  version: string;
}
