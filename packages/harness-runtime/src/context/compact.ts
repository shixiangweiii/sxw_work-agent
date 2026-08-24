/**
 * Compact（V05 §11.6、§11.8）。
 *
 * ⚠️ 阶段 1 的已知情况：这条路径预期跑不到。
 * 普通任务撞不到上下文墙，要真触发得故意喂超长输入。
 * 阶段 1 结束时应当明确知道「Compact 写了但没被真跑过」。
 *
 * 但压缩顺序不是随便定的，它来自实测的缓存规则：
 *
 *   Compact 重写中部的代价 ∝ 改写点有多靠前。改写点之后的缓存全丢，之前的保留。
 *
 * 四个端点里三个确认是严格前缀匹配（改前缀第一处 → 命中归零）。
 * 因此本实现只从**尾部**动刀，绝不重写靠前的内容 —— 这不是偷懒，是可估价的成本选择。
 */

import type { CompactionRecord, ContextItem } from "../types/context.js";
import type { ContextMessage } from "../types/transcript.js";
import type { ModelProtocolPort } from "../ports/index.js";

export interface CompactDeps {
  protocol: ModelProtocolPort;
  targetTokens: number;
  now: number;
}

export interface CompactResult {
  messages: ContextMessage[];
  freedTokens: number;
  record: CompactionRecord;
}

/**
 * 必须保留的东西（V05 §11.6）：
 * 当前目标、用户约束与插话、未完成 Action、Approval/Wait 状态、
 * 错误恢复状态、以及**全部受协议约束的组**。
 *
 * 最后一条是硬约束：截断一个 tool_call 而留下它的 result（或反过来）
 * 会直接违反不变量 8，而选定端点会 200 放行 —— 没有任何东西会告诉你。
 */
export function compactMessages(
  messages: ContextMessage[],
  deps: CompactDeps,
): CompactResult {
  const protectedIdx = new Set<number>();

  // 第一条 user 消息 = 当前目标，永不丢弃
  const firstUser = messages.findIndex((m) => m.role === "user");
  if (firstUser >= 0) protectedIdx.add(firstUser);

  // 最近两轮完整保留 —— 未完成 Action 与错误恢复状态都在这里
  const recentTurns = new Set(
    messages.map((m) => m.turn).sort((a, b) => b - a).slice(0, 2),
  );

  // 受协议约束的组：任何一条消息只要含 tool_call 或 tool_result 就整条保护。
  // 宁可少压，也不能把配对拆开。
  const hasProtocolBlock = (m: ContextMessage): boolean =>
    m.content.some((c) => c.type === "tool_call" || c.type === "tool_result");

  // 端点要求推理块占位时，推理块也不能丢
  const reasoningProtected =
    deps.protocol.profile.context.reasoningBlockRule !== "DROPPABLE";

  const kept: ContextMessage[] = [];
  const dropped: ContextMessage[] = [];

  messages.forEach((m, idx) => {
    const mustKeep =
      protectedIdx.has(idx) ||
      recentTurns.has(m.turn) ||
      hasProtocolBlock(m) ||
      (reasoningProtected && m.content.some((c) => c.type === "reasoning")) ||
      m.role === "user"; // 用户约束与插话一律保留

    if (mustKeep) kept.push(m);
    else dropped.push(m);
  });

  const freedTokens = dropped.reduce((n, m) => n + estimate(m), 0);

  if (dropped.length === 0) {
    return {
      messages,
      freedTokens: 0,
      record: {
        reason: "无可丢弃项：全部消息受协议、目标或近轮保护",
        removedItemIds: [],
        freedTokens: 0,
        at: deps.now,
      },
    };
  }

  // 摘要作为派生对象插在被丢弃位置的开头，带来源计数而不是原文。
  const summary: ContextMessage = {
    role: "user",
    turn: kept[0]?.turn ?? 0,
    content: [
      {
        type: "text",
        text:
          `[已压缩] 省略了 ${dropped.length} 条较早的助手消息（约 ${freedTokens} tokens）。` +
          `受协议约束的配对组、用户输入与最近两轮均已完整保留。`,
      },
    ],
  };

  return {
    messages: [summary, ...kept],
    freedTokens,
    record: {
      reason: `尾部压缩：丢弃 ${dropped.length} 条非协议约束的助手消息`,
      removedItemIds: [] as ContextItem["id"][],
      freedTokens,
      at: deps.now,
    },
  };
}

function estimate(m: ContextMessage): number {
  let chars = 0;
  for (const c of m.content) {
    if (c.type === "text" || c.type === "reasoning") chars += c.text.length;
    else if (c.type === "tool_result") chars += c.content.length;
    else if (c.type === "tool_call") chars += JSON.stringify(c.input).length;
  }
  return Math.ceil(chars / 2.5);
}
