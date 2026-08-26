/**
 * Context 类型（V05 §11）。
 *
 * 核心约束：Context Runtime 的裁剪、外置、Compact 与重排，不得破坏协议要求的
 * 结构完整性。而「哪些结构属于哪一档」的来源必须是「形状适配器 ＋ 端点能力声明」
 * 的组合，不由 Context 模块猜测（原则十一）。
 */

import type {
  BlobRef,
  ContextFrameId,
  ContextItemId,
  ModelInvocationId,
  RunId,
  Timestamp,
} from "./ids.js";
// 纯类型循环引用（transcript.ts 反过来引本文件的 ModelContent）。
// import type 会被完全擦除，不产生运行期依赖环。
import type { ContextMessage } from "./transcript.js";

export type ContextItemKind =
  | "SYSTEM_INSTRUCTION"
  | "SKILL_DESCRIPTOR"
  | "SKILL_INSTRUCTION"
  | "USER_MESSAGE"
  | "USER_INTERJECTION"
  | "ASSISTANT_MESSAGE"
  | "MODEL_REASONING"
  | "MODEL_TOOL_CALL"
  | "TOOL_RESULT"
  | "OBSERVATION"
  | "VERIFICATION"
  | "ARTIFACT_REFERENCE"
  | "SUMMARY"
  | "RESOURCE_EXCERPT"
  | "SYSTEM_NOTICE";

export type ContextTrust =
  | "SYSTEM_TRUSTED"
  | "USER_PROVIDED"
  | "MODEL_GENERATED"
  | "EXTERNAL_UNTRUSTED";

/**
 * 协议角色三档（V05 §11.2）。
 *
 * PLACEHOLDER_REQUIRED 是实测逼出来的中间档：内容可替换、可摘要、可清空，
 * 但块本身不能消失。二分表达不了它。
 *
 * 档位由端点能力声明的 context.reasoningBlockRule 给出，不由 Context 模块推断。
 */
export type ContextProtocolRole =
  | "ORDINARY"
  | "PROTOCOL_GROUP_MEMBER"
  | "PLACEHOLDER_REQUIRED"
  | "REQUIRED_VERBATIM"
  | "CACHE_BREAKPOINT";

export interface ContextSource {
  kind: "SESSION" | "RUN" | "TOOL" | "SYSTEM" | "USER";
  ref?: string;
}

/** 规范化的模型内容块。形状适配器负责在此与各家协议之间翻译。 */
export type ModelContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; signature?: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean };

export interface ContextItem {
  id: ContextItemId;
  kind: ContextItemKind;
  source: ContextSource;
  trust: ContextTrust;
  protocolRole: ContextProtocolRole;
  /** 同组的项构成不可拆分单元。一个 tool_call 与其 result 属于同一组。 */
  protocolGroupId?: string;
  content?: ModelContent;
  verbatimPayloadRef?: BlobRef;
  blobRef?: BlobRef;
  preview?: string;
  contentHash: string;
  estimatedTokens: number;
  actualTokens?: number;
  /** 未脱敏内容不得写入任何持久化存储（不变量 13）。 */
  redactionApplied: boolean;
  createdAt: Timestamp;
}

/**
 * 一次 ModelInvocation 的完整上下文。
 *
 * fixedOverheadTokens 单列的理由是实测：2 个只有一个字符串参数的工具就要 360 token，
 * 折合每工具约 180。20 个工具就是约 3600 token 的起步价，与任务内容无关。
 * 阈值判断必须先扣除它，否则「还剩多少上下文可用」算错。
 */
export interface ContextFrame {
  id: ContextFrameId;
  runId: RunId;
  invocationId: ModelInvocationId;
  compilerVersion: string;
  policyVersion: string;
  /** 这个帧是按哪套端点规则编译的。端点声明变更后，旧帧的合法性判断不能照搬。 */
  endpointProfileVersion: string;
  items: ContextItem[];
  totalTokens: number;
  irreducibleTokens: number;
  fixedOverheadTokens: number;
  /** 必须同时覆盖推理与正文 —— 实测推理可以吃光整个输出预算且接口返回成功。 */
  reservedOutputTokens: number;
  trustSummary: TrustSummary;
  contentHash: string;
  createdAt: Timestamp;
}

export interface TrustSummary {
  hasExternalUntrusted: boolean;
  counts: Record<ContextTrust, number>;
}

export interface ContextBudgetPolicy {
  modelWindowTokens: number;
  reservedOutputTokens: number;
  softInputLimitTokens: number;
  hardInputLimitTokens: number;
  compactTargetTokens: number;
  inlineToolResultLimitTokens: number;
  retrievalPageLimitTokens: number;
}

export interface CompactionRecord {
  reason: string;
  removedItemIds: ContextItemId[];
  freedTokens: number;
  at: Timestamp;
}

export interface CompactTrackingState {
  compacted: boolean;
  turnsSinceCompact: number;
  consecutiveFailures: number;
}

export interface ContextFrameOutcome {
  status: "READY" | "COMPACTED_READY" | "COMPACTION_INSUFFICIENT" | "PROTOCOL_INVALID";
  frame?: ContextFrame;
  totalTokens: number;
  irreducibleTokens: number;
  fixedOverheadTokens: number;
  compactionApplied: CompactionRecord[];
  protocolError?: string;
  /**
   * 压缩后的 messages（R-6）。仅在真的压缩了时出现。
   *
   * 【定】调用方必须把它写回 `state.messages`，否则下一轮又从原始历史追加，
   * 压缩只作用于这一帧的局部变量 —— 那正是 R-6 修复前的行为：
   * 「压了，但下一轮又胖回去」，而 ContextCompacted 事件照常发出，
   * 从事件流上看压缩是生效的。
   */
  compactedMessages?: ContextMessage[];
  /** COMPACT_BOUNDARY 条目要带的摘要；随 compactedMessages 一起出现。 */
  compactSummary?: ContextMessage;
  /** boundary 之后需要重新 append 的消息（不含摘要）。 */
  compactKept?: ContextMessage[];
  /**
   * COMPACTION_INSUFFICIENT 时：连**不可压缩集**都已经超硬限（R-3）。
   *
   * 两种处置在 D-05 里是分开的：
   *   false → 还有可压空间，主循环可以更激进地压一轮再试；
   *   true  → 压到底也没用，只能 DETERMINISTIC handoff。
   *
   * 修复前这两种情况根本区分不出来 —— 超硬限但「还能压」的帧会被**照常发出**，
   * 而不是回来再压一次。
   */
  irreducibleExceedsHardLimit?: boolean;
}
