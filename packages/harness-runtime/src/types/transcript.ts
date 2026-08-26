/**
 * transcript：恢复的唯一来源（V05 §18.5）。
 *
 * append-only。只追加，不改写 —— Compact 通过写入 COMPACT_BOUNDARY 表达，
 * 重建时从最后一个 boundary 之后开始取，boundary 之前的原文保留供 Trace 与 Replay 使用。
 *
 * schemaVersion 不兼容时，重建器必须能跳过或 upcast 单条，而不是整个 transcript 失效。
 * 这是日志方案相对 Snapshot 方案最实在的收益：Snapshot 是全有或全无，日志可以逐条降级。
 */

import type { RunId, Timestamp } from "./ids.js";
import type { ModelContent } from "./context.js";

export type MessageRole = "user" | "assistant" | "system";

/** 进入模型上下文的一条消息。已脱敏（不变量 13）。 */
export interface ContextMessage {
  role: MessageRole;
  content: ModelContent[];
  /** 该消息是哪一轮产生的。用于 Trace 与 resume 时的定位。 */
  turn: number;
}

export type TranscriptEntryKind =
  | "RUN_META"
  | "MESSAGE"
  | "COMPACT_BOUNDARY"
  | "BLOB_REF"
  /**
   * 逐 Action 的事实（阶段 2 新增，决 6）。
   *
   * ── 这是对 §18.5【定】的 Contract 扩展，不是顺手加一个枚举值 ──────────
   *
   * 为什么非扩不可：§18.2 分支二的判据要从「工具的静态声明」改成
   * 「**这次执行**有没有留下前置指纹」，而前置指纹是逐 Action 的事实。
   * 原来的四个 kind 里放不下它 —— 塞进 `RUN_META` 语义是错的
   * （那是滚动聚合，每轮覆写，不是逐条事实）。
   *
   * 为什么现在扩是安全的：§28.6 本就把 TranscriptEntry 的冻结放在阶段 2，
   * 扩它正好在窗口内。但**冻结范围要收窄** —— 只冻 resume 真实用到的部分，
   * Replay 相关的语义（起始位置定位、exact recorded 的字节级要求）
   * 保持【验】不冻：Replay 推到阶段 3 了，现在冻它的人还不知道它会怎么用。
   */
  | "ACTION_FACT";

export interface TranscriptEntry {
  runId: RunId;
  /** 单调递增，同一 Run 内唯一。也是 Layer 2 投影的游标。 */
  sequence: number;
  schemaVersion: number;
  kind: TranscriptEntryKind;
  message?: ContextMessage;
  /** COMPACT_BOUNDARY 用：这条边界之前的内容已被摘要取代。 */
  compactSummary?: ContextMessage;
  meta?: Record<string, unknown>;
  createdAt: Timestamp;
}

export const TRANSCRIPT_SCHEMA_VERSION = 1;
