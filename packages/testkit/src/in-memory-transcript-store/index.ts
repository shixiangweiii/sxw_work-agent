/**
 * In-memory transcript store（阶段 1）。
 *
 * ⚠️ **阶段 2 起已无使用者，优先用 `openDb({ path: ":memory:" })` ＋
 * `SqliteTranscriptStore`。** 后者是**同一条 SQLite 代码路径**，只是不落盘 ——
 * 既同样密封，又不牺牲覆盖（跑的是真 SQL，不是内存桩）。
 * 全部验收脚本都已改用它。
 *
 * 保留本文件的理由只有一条：它是「接口按最终形态定」这个判断的**历史证物** ——
 * 阶段 2 换实现时 `TranscriptStorePort` 一个字没改。要新写 store 实现时，
 * 对照它和 SQLite 版看接口哪些地方是被两种实现共同兑现的。
 *
 * 阶段 2 换 SQLite 实现，接口不变 —— TranscriptStorePort 已按最终形态定。
 *
 * 「进程关了就忘」是阶段 1 的已知限制，不是缺陷：
 * 消息级恢复的语义在进程内完全可测（丢弃 LoopState → 从 transcript 重建 → 继续），
 * 跨进程持久化是阶段 2 的事。
 */

import {
  rebuildFromEntries,
  TRANSCRIPT_SCHEMA_VERSION,
  type ContextMessage,
  type RunId,
  type TranscriptEntry,
  type TranscriptStorePort,
} from "@workagent/harness-runtime";

export class InMemoryTranscriptStore implements TranscriptStorePort {
  private readonly byRun = new Map<string, TranscriptEntry[]>();
  /**
   * D-2：事件与 transcript 条目共用的那一条序列的计数器。
   *
   * 它和 byRun 里最后一条的 sequence **不是同一个数** —— 事件取了号但不落盘，
   * 所以计数器一般跑在前面。要续号一律走 nextSequence()，
   * 不要再用「最后一条 ＋ 1」那种推算。
   */
  private readonly counters = new Map<string, number>();

  async nextSequence(runId: RunId, atLeast = 0): Promise<number> {
    const key = String(runId);
    const next = Math.max(this.counters.get(key) ?? 0, atLeast) + 1;
    this.counters.set(key, next);
    return next;
  }

  /**
   * 【定】不变量 5：消息先落盘再进内存 messages。
   *
   * 这里是同步写内存所以「落盘」是瞬时的，但接口保持 async ——
   * 调用方必须 await 它完成才允许更新自己的 messages 数组。
   * 阶段 2 换成真 IO 时，调用方代码一个字不用改。
   */
  async append(entry: Omit<TranscriptEntry, "sequence">): Promise<number> {
    const key = String(entry.runId);
    const list = this.byRun.get(key) ?? [];
    const sequence = await this.nextSequence(entry.runId);
    list.push({ ...entry, sequence, schemaVersion: entry.schemaVersion || TRANSCRIPT_SCHEMA_VERSION });
    this.byRun.set(key, list);
    return sequence;
  }

  async rebuildMessages(runId: RunId): Promise<ContextMessage[]> {
    return rebuildFromEntries(this.byRun.get(String(runId)) ?? []);
  }

  async readAll(runId: RunId): Promise<TranscriptEntry[]> {
    return [...(this.byRun.get(String(runId)) ?? [])];
  }

  async lastSequence(runId: RunId): Promise<number> {
    const list = this.byRun.get(String(runId)) ?? [];
    return list.length === 0 ? 0 : list[list.length - 1]!.sequence;
  }

  /** 仅供验收脚本使用：观察 transcript 的完整内容。 */
  dump(runId: RunId): TranscriptEntry[] {
    return [...(this.byRun.get(String(runId)) ?? [])];
  }
}
