/**
 * transcript 语义（V05 §18.5）。
 *
 * 恢复的唯一来源。没有状态 Snapshot，没有事件重放重建，没有 generation 校验。
 * resume(runId) = 读 transcript → 重建 messages → 从下一轮迭代继续。
 *
 * 本文件只放「重建」与「配对扫描」两件与存储实现无关的语义，
 * 具体的 append/read 由 TranscriptStorePort 实现（阶段 1 是 in-memory，阶段 2 换 SQLite）。
 */

import type { ContextMessage, TranscriptEntry } from "../types/transcript.js";
import { TRANSCRIPT_SCHEMA_VERSION } from "../types/transcript.js";
import type { ResumableRunFacts } from "../types/run.js";
import type { RunId } from "../types/ids.js";

/**
 * 从条目序列重建 messages。
 *
 * 【定】从最后一个 COMPACT_BOUNDARY 之后开始取，boundary 之前的原文保留
 * 供 Trace 与 Replay 使用 —— 这就是「只追加，不改写」的兑现方式。
 */
export function rebuildFromEntries(entries: TranscriptEntry[]): ContextMessage[] {
  const sorted = [...entries].sort((a, b) => a.sequence - b.sequence);

  let startIdx = 0;
  let summary: ContextMessage | undefined;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]!;
    if (e.kind === "COMPACT_BOUNDARY") {
      startIdx = i + 1;
      summary = e.compactSummary;
      break;
    }
  }

  const messages: ContextMessage[] = [];
  if (summary) messages.push(summary);

  for (let i = startIdx; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.kind !== "MESSAGE" || !e.message) continue;
    // schemaVersion 不兼容时跳过单条而不是整个 transcript 失效 ——
    // 这是日志方案相对 Snapshot 方案最实在的收益：Snapshot 是全有或全无。
    if (e.schemaVersion > CURRENT_SUPPORTED_SCHEMA) continue;
    messages.push(e.message);
  }

  return messages;
}

export const CURRENT_SUPPORTED_SCHEMA = 1;

// ══════════════════════════════════════════════ 累计事实的落盘与读回

/**
 * RUN_META 条目里标识「这条装的是可恢复事实」的判别键。
 *
 * 为什么走 transcript 而不是内存：V05 §18.4【定】要求 resume 保留预算使用。
 * 只留在内存里的话，一次进程重启就把预算清零 —— 反复 crash + resume
 * 可以无限绕过 maxTurns 与墙钟硬墙，这与不变量 11「预算不得被绕过」直接冲突。
 *
 * 【定】只追加，不改写。每轮写一条，读回时取最后一条 —— 与 COMPACT_BOUNDARY 同构。
 */
export const RUN_FACTS_META_KIND = "RUN_FACTS";

export function makeRunFactsEntry(
  runId: RunId,
  facts: ResumableRunFacts,
  createdAt: number,
): Omit<TranscriptEntry, "sequence"> {
  return {
    runId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    kind: "RUN_META",
    meta: { metaKind: RUN_FACTS_META_KIND, facts },
    createdAt,
  };
}

/** 读回最后一条累计事实。没有（首次运行、或旧 schema）时返回 undefined。 */
export function readRunFacts(entries: TranscriptEntry[]): ResumableRunFacts | undefined {
  const sorted = [...entries].sort((a, b) => a.sequence - b.sequence);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]!;
    if (e.kind !== "RUN_META") continue;
    if (e.schemaVersion > CURRENT_SUPPORTED_SCHEMA) continue;
    if (e.meta?.["metaKind"] !== RUN_FACTS_META_KIND) continue;
    return e.meta["facts"] as ResumableRunFacts;
  }
  return undefined;
}

// ═══════════════════════════════════════════════ 逐 Action 事实（决 6）

/** ACTION_FACT 条目里标识「这条装的是执行前指纹」的判别键。 */
export const ACTION_PRE_FINGERPRINT_KIND = "ACTION_PRE_FINGERPRINT";

export interface ActionPreFingerprint {
  toolCallId: string;
  toolName: string;
  /** Verifier 定义的内容，Runtime 不解释（见 ObservationResult.fingerprint）。 */
  fingerprint: unknown;
  at: number;
}

export function makeActionFactEntry(
  runId: RunId,
  fact: ActionPreFingerprint,
): Omit<TranscriptEntry, "sequence"> {
  return {
    runId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    kind: "ACTION_FACT",
    meta: { metaKind: ACTION_PRE_FINGERPRINT_KIND, fact },
    createdAt: fact.at,
  };
}

/**
 * 按 toolCallId 索引所有执行前指纹。
 *
 * 【定】这是 §18.2 分支二的**真正判据** —— 不是工具的静态声明。
 * 同一个工具这次拍了指纹就能观察（分支二），没拍就观察不了（分支三），
 * 而「拍不拍」由 Runtime 侧的 Verifier 决定。决 6 要的就是把这个旋钮
 * 从被测对象身上挪到测量装置这边。
 */
export function readActionPreFingerprints(
  entries: TranscriptEntry[],
): Map<string, ActionPreFingerprint> {
  const out = new Map<string, ActionPreFingerprint>();
  for (const e of entries) {
    if (e.kind !== "ACTION_FACT") continue;
    if (e.schemaVersion > CURRENT_SUPPORTED_SCHEMA) continue;
    if (e.meta?.["metaKind"] !== ACTION_PRE_FINGERPRINT_KIND) continue;
    const f = e.meta["fact"] as ActionPreFingerprint;
    out.set(f.toolCallId, f);
  }
  return out;
}

// ══════════════════════════════════════════════════ 未配对扫描

export interface UnpairedToolUse {
  toolCallId: string;
  toolName: string;
  /**
   * 原始入参。§18.2 分支一要「重新执行」、分支二要「先观察」，
   * 两者都必须拿到当初那次调用的参数 —— 只有 id 和名字是不够的。
   */
  input: unknown;
}

/**
 * 扫描 messages 里有没有「有 tool_call 但没有 result」的情况。
 *
 * 两个用途，性质完全不同：
 *
 * 1. `resume()` 时判断上次崩在哪 —— transcript 末尾的未配对项要按 §18.2 三条分支处置；
 * 2. `verify:pairing` 的断言对象 —— 三条中断路径注入后，这里必须返回空。
 *
 * 【定】选定端点对配对零外部兜底（缺 result 一律 200 放行），
 * 所以这个函数是唯一会发现违反的东西。
 */
export function findUnpairedToolUses(messages: ContextMessage[]): UnpairedToolUse[] {
  const calls = new Map<string, { name: string; input: unknown }>();
  const results = new Set<string>();

  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "tool_call") calls.set(c.toolCallId, { name: c.name, input: c.input });
      if (c.type === "tool_result") results.add(c.toolCallId);
    }
  }

  const unpaired: UnpairedToolUse[] = [];
  for (const [id, call] of calls) {
    if (!results.has(id)) {
      unpaired.push({ toolCallId: id, toolName: call.name, input: call.input });
    }
  }
  return unpaired;
}

/** 反向：有 result 却没有 call。锚点错配，同样是不变量 8 的违反。 */
export function findOrphanResults(messages: ContextMessage[]): string[] {
  const calls = new Set<string>();
  const results: string[] = [];
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "tool_call") calls.add(c.toolCallId);
      if (c.type === "tool_result") results.push(c.toolCallId);
    }
  }
  return results.filter((id) => !calls.has(id));
}
