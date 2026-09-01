/**
 * Compact（V05 §11.6、§11.8）。
 *
 * 压缩顺序不是随便定的，它来自实测的缓存规则：
 *
 *   Compact 重写中部的代价 ∝ 改写点有多靠前。改写点之后的缓存全丢，之前的保留。
 *
 * 四个端点里三个确认是严格前缀匹配（改前缀第一处 → 命中归零）。
 * 因此本实现只从**尾部**动刀，绝不重写靠前的内容 —— 这不是偷懒，是可估价的成本选择。
 *
 * ══════════════════════════════════════════════════════════════════════
 * R-6 修复前，这个模块有三个叠在一起的缺陷。roadmap 当时只承认了
 * 「Compact 写了但没被真跑过」（覆盖率问题），而实际情况更糟：**跑到了也不对**。
 *
 *   1. 压缩结果只作用于 compileFrame 内的局部变量，runLoop 后续仍从原始
 *      state.messages 追加 → 下一轮又看到未压缩的历史，等于没压；
 *   2. 从不写 COMPACT_BOUNDARY → transcript 的「从最后一个 boundary 之后重建」
 *      语义永远不触发，resume 也重建不出刚才用过的压缩上下文；
 *   3. targetTokens 收了但一次也没读 —— 一压就把所有能丢的全丢光，
 *      为了省 100 token 丢掉整段历史。
 *
 * 三条都在这一轮修掉。第 2 条的落点在 run-loop（写 boundary ＋ 回写 messages），
 * 本文件负责第 1 条要用的返回值和第 3 条的收敛逻辑。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { CompactionRecord, ModelContent } from "../types/context.js";
import type { ContextMessage } from "../types/transcript.js";
import type { ModelProtocolPort } from "../ports/index.js";

export interface CompactDeps {
  protocol: ModelProtocolPort;
  /**
   * 收敛目标，**只针对 messages**。
   *
   * 【定】调用方必须先把 Compact 够不到的部分（工具定义开销、system prompt、
   * 时间事实）从帧级预算里扣掉再传进来。混用两个单位的结果是目标永远已达成，
   * 一条都不丢 —— 见 compile.ts 里那段说明。
   */
  targetTokens: number;
  now: number;
}

export interface CompactResult {
  /** 压缩后的完整 messages（含摘要）。【定】调用方必须把它写回 state.messages。 */
  messages: ContextMessage[];
  /**
   * 摘要消息本身，单独给出来。
   *
   * run-loop 要把它放进 COMPACT_BOUNDARY 条目的 compactSummary 字段 ——
   * transcript 重建时会自动把它 prepend 到 boundary 之后的消息前面
   * （见 rebuildFromEntries）。放进 messages 里再 append 一遍就会重复。
   */
  summary?: ContextMessage;
  /** 保留下来、需要在 boundary 之后重新 append 的消息（不含摘要）。 */
  kept: ContextMessage[];
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
  const before = estimateAll(messages);

  // ══ ① 块级：先剥推理块，再考虑丢整条消息 ═══════════════════════
  //
  // 顺序是刻意的：剥推理块比丢消息便宜得多 —— 正文与 tool_call 都还在，
  // 模型丢掉的只是自己的草稿。丢消息则是真的丢事实。
  //
  // 为什么非剥不可（D-3 实测，2026-08-25）：端点声明 reasoningBlockRule = DROPPABLE，
  // protocolRoleOf 也如实把推理块判成 ORDINARY（＝可丢），但**唯一的丢弃者是
  // Compact，而 Compact 是消息级的** —— 推理块和 tool_call 同处一条 assistant 消息，
  // 下面的 hasProtocolBlock() 会把整条保护住，于是推理块一个都丢不掉。
  //
  // 后果是每轮把全部历史推理块原样回传并付费：探针实测一段 229 字符的推理
  // 值 123 token，而 count_tokens 对它返回 0。声明允许丢、实现却在付钱。
  const droppableReasoning = deps.protocol.profile.context.reasoningBlockRule === "DROPPABLE";
  let working = droppableReasoning ? stripReasoning(messages) : messages;
  const reasoningFreed = before - estimateAll(working);

  // ══ ② 消息级：还超标就从最旧的可丢**单元**开始逐个丢 ═══════════
  //
  // ── 为什么单位是「单元」而不是「消息」──────────────────────
  //
  // 原实现的保护规则是「任何一条消息只要含 tool_call 或 tool_result 就整条保护」。
  // 理由正当（拆开配对会违反不变量 8，而选定端点 200 放行、无人报错），
  // 但在一个**工具调用循环**里，这条规则会保护住几乎所有东西：
  //
  //     user      任务           ← role=user，保护
  //     assistant 推理＋tool_call ← 含 tool_call，保护
  //     user      tool_result    ← 既 role=user 又含 tool_result，保护
  //     assistant 推理＋tool_call ← 保护
  //     ...
  //
  // 于是**消息级压缩在这个架构下永远丢不掉任何东西**，targetTokens 和
  // COMPACT_BOUNDARY 两条路径都成了走不到的死代码。这不是「保守」，
  // 是「不可达」—— 而不可达的保护代码会让人以为问题已经解决了（D-22）。
  //
  // 真正的约束是**配对**粒度，不是消息粒度：一个 tool_call 和它的 result
  // 可以一起丢，只要一起。所以这里把互相牵连的消息聚成「协议单元」，
  // 整个单元原子地丢或不丢。
  const units = protocolUnits(working);

  // 第一条 user 消息 = 当前目标，永不丢弃
  const firstUser = working.findIndex((m) => isUserInput(m));

  /**
   * 最近两轮完整保留 —— 未完成 Action 与错误恢复状态都在这里（§11.6）。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】**先去重再取前两个**。`map` 出来的是「每条消息一项」，含重复轮号。
   *
   * 不去重的写法（`working.map(m => m.turn).sort(desc).slice(0, 2)`）取的是
   * **数组的前两项**，而一个典型回合至少有两条消息（assistant 的 tool_call
   * ＋ user 的 tool_result 各一条）—— 于是 `[3,3,2,2,1,1,0]` 切出来是
   * `[3,3]`，`Set` 收成 `{3}`：**「最近两轮」实际只保护了最近一轮**。
   *
   * 它不违反不变量 8（配对组由 `protocolUnits` 单独保护），所以既不会报错、
   * 也没有任何判据会响 —— 只是保护窗口比注释承诺的小一半，而丢掉的那一轮
   * 恰好装着「上一步为什么失败」的诊断。
   * ══════════════════════════════════════════════════════════════════════
   */
  const recentTurns = new Set(
    [...new Set(working.map((m) => m.turn))].sort((a, b) => b - a).slice(0, 2),
  );

  // 端点要求推理块占位时，推理块也不能丢
  const reasoningProtected = !droppableReasoning;

  /**
   * 单条消息是否因自身原因必须保留。
   *
   * 【定】`role === "user"` 不能直接当「用户输入」用。
   * Anthropic 形状要求 tool_result 放在 user 消息里 —— 那是协议载体，不是用户说的话。
   * 原实现用 role 判定，等于把每一条工具结果都当成「用户约束与插话」永久保护。
   */
  const selfProtected = (m: ContextMessage, idx: number): boolean =>
    idx === firstUser ||
    recentTurns.has(m.turn) ||
    isUserInput(m) ||
    (reasoningProtected && m.content.some((c) => c.type === "reasoning"));

  /**
   * 【定】targetTokens 是收敛目标，不是摆设。
   *
   * 从最旧的可丢单元开始逐个丢，每丢一个重算，够了就停 ——
   * 而不是「能丢的一次全丢」。后者会为了省 100 token 把整段历史抹掉，
   * 而缓存规则决定了越靠前的改动越贵：丢得越多，重新计费的前缀越长。
   *
   * 用本地估算收敛就够了。精确值由调用方在 compileFrame 里用 countTokens 复核一次，
   * 这里多调几次网络反而更慢更贵。
   */
  let total = estimateAll(working);
  const dropIdx = new Set<number>();
  for (const unit of units) {
    if (total <= deps.targetTokens) break;
    // 【定】单元里只要有一条自身受保护，整个单元都不能动 ——
    // 否则就是从中间拆开一个配对组。
    if (unit.some((i) => selfProtected(working[i]!, i))) continue;
    for (const i of unit) {
      dropIdx.add(i);
      total -= estimate(working[i]!);
    }
  }

  const kept = working.filter((_, i) => !dropIdx.has(i));
  const droppedCount = dropIdx.size;
  const freedTokens = before - estimateAll(kept);

  // 什么都没省下来 —— 如实返回，调用方据此不写 boundary、不动 state.messages。
  if (freedTokens <= 0) {
    return {
      messages,
      kept: messages,
      freedTokens: 0,
      record: {
        reason: "无可压缩项：全部消息受协议、目标或近轮保护，且无可剥离的推理块",
        freedTokens: 0,
        at: deps.now,
      },
    };
  }

  // 只剥了推理块、一条消息都没丢：不需要摘要 —— 没有任何事实被移除，
  // 一句「我省略了什么」会凭空给模型一个不存在的信息缺口。
  if (droppedCount === 0) {
    return {
      messages: kept,
      kept,
      freedTokens,
      record: {
        reason: `剥离 ${countReasoning(messages)} 个推理块（端点声明 DROPPABLE），未丢弃任何消息`,
        freedTokens,
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
          `[已压缩] 省略了 ${droppedCount} 条较早的助手消息（约 ${freedTokens} tokens）。` +
          `受协议约束的配对组、用户输入与最近两轮均已完整保留。`,
      },
    ],
  };

  return {
    messages: [summary, ...kept],
    summary,
    kept,
    freedTokens,
    record: {
      reason:
        `尾部压缩：丢弃 ${droppedCount} 条非协议约束的助手消息` +
        (reasoningFreed > 0 ? `，并剥离推理块（约 ${reasoningFreed} tokens）` : "") +
        `；收敛目标 ${deps.targetTokens} tokens`,
      freedTokens,
      at: deps.now,
    },
  };
}

/**
 * 把消息聚成「协议单元」，按最旧优先返回。
 *
 * 一个单元 = 一组必须同生共死的消息索引。规则只有一条：
 * **共享同一个 toolCallId 的消息必须在同一个单元里**，否则丢弃会拆开配对组。
 *
 * 传递性是必须的，因为一次响应可以有多个 call：
 *
 *     assistant [tool_call A, tool_call B]
 *     user      [tool_result A]
 *     user      [tool_result B]
 *
 * A 和 B 通过那条 assistant 消息互相牵连，三条必须一起丢。
 * 只按单个 toolCallId 分组会漏掉这层传递关系，丢 A 就会留下一个孤儿 B。
 *
 * 没有任何 tool 块的消息各自成一个单元。
 */
function protocolUnits(messages: ContextMessage[]): number[][] {
  // 并查集：把互相牵连的消息索引合并到一起。
  const parent = messages.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const firstSeen = new Map<string, number>();
  messages.forEach((m, idx) => {
    for (const c of m.content) {
      if (c.type !== "tool_call" && c.type !== "tool_result") continue;
      const prev = firstSeen.get(c.toolCallId);
      if (prev === undefined) firstSeen.set(c.toolCallId, idx);
      else union(prev, idx);
    }
  });

  const byRoot = new Map<number, number[]>();
  messages.forEach((_, idx) => {
    const r = find(idx);
    const list = byRoot.get(r) ?? [];
    list.push(idx);
    byRoot.set(r, list);
  });

  // 最旧优先 —— 尾部动刀，靠前的内容留着，缓存前缀才保得住。
  return [...byRoot.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/**
 * 真正的用户输入（任务、约束、插话），不含仅作为 tool_result 载体的 user 消息。
 *
 * Anthropic 形状要求 tool_result 放在 user 消息里，所以 role 本身
 * 区分不出「用户说的话」和「协议载体」—— 判据是有没有 text 块。
 */
function isUserInput(m: ContextMessage): boolean {
  return m.role === "user" && m.content.some((c) => c.type === "text");
}

/**
 * 剥掉全部推理块。
 *
 * 【定】剥完变成空壳的消息要整条去掉 —— 一条 content 为空的消息是协议非法的，
 * 而选定端点会 200 放行，于是又是一个「模型看到失真世界」而无人报错的场景。
 * 这种消息只可能是「只有推理块的 assistant 回合」，本来也没有事实内容。
 */
function stripReasoning(messages: ContextMessage[]): ContextMessage[] {
  const out: ContextMessage[] = [];
  for (const m of messages) {
    if (!m.content.some((c) => c.type === "reasoning")) {
      out.push(m);
      continue;
    }
    const content = m.content.filter((c: ModelContent) => c.type !== "reasoning");
    if (content.length > 0) out.push({ ...m, content });
  }
  return out;
}

function countReasoning(messages: ContextMessage[]): number {
  let n = 0;
  for (const m of messages) for (const c of m.content) if (c.type === "reasoning") n += 1;
  return n;
}

function estimateAll(messages: ContextMessage[]): number {
  return messages.reduce((n, m) => n + estimate(m), 0);
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
