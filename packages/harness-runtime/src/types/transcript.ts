/**
 * transcript：恢复的唯一来源（V05 §18.5）。
 *
 * append-only。只追加，不改写 —— Compact 通过写入 COMPACT_BOUNDARY 表达，
 * 重建时从最后一个 boundary 之后开始取，boundary 之前的原文保留供 Trace 使用。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】**条目不带版本号。** schema 变了就删库重建（见 store-sqlite/db.ts）。
 *
 * 此前每条都带 `schemaVersion`，读侧三处 `if (v > CURRENT) continue`。
 * 那套前向兼容挡的是一种**不可能存在的数据**（全仓只有一个生产者、
 * 只写常量 1），而代价是真实的：两个同义常量分居两个文件、写侧用一个
 * 读侧比另一个 —— 谁只 bump 了其中一个，所有新条目会在重建时被
 * **静默跳过**，预算、恢复分支计数与执行前指纹一起蒸发，且没有任何报错。
 * ══════════════════════════════════════════════════════════════════════
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
  /**
   * 逐 Action 的事实（决 6）。
   *
   * 为什么它不能塞进 `RUN_META`：那是滚动聚合，每轮覆写；
   * 而前置指纹是**逐条**事实，§18.2 分支二的判据读的正是它。
   */
  | "ACTION_FACT";

export interface TranscriptEntry {
  runId: RunId;
  /** 单调递增，同一 Run 内唯一。也是 Layer 2 投影的游标。 */
  sequence: number;
  kind: TranscriptEntryKind;
  message?: ContextMessage;
  /** COMPACT_BOUNDARY 用：这条边界之前的内容已被摘要取代。 */
  compactSummary?: ContextMessage;
  meta?: Record<string, unknown>;
  createdAt: Timestamp;
}
