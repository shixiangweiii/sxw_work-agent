/**
 * TranscriptStorePort 的 SQLite 实现（阶段 2）。
 *
 * Compact boundary 的 payload 同时保存 summary 与 kept snapshot，使 Context
 * 替换在一条 SQLite INSERT 中原子提交；其余消息仍沿用逐条 append。
 *
 * 这也是 R-4（Port 异常收敛，2026-08-25 提前做掉）的兑现场合：
 * in-memory → SQLite 就是「换 Port 实现」，异常口径先收敛过，
 * 出问题时分得清是存储还是 Runtime。
 */

import {
  rebuildFromEntries,
  type ContextMessage,
  type RunId,
  type TranscriptEntry,
  type TranscriptEntryKind,
  type TranscriptStorePort,
} from "@workagent/harness-runtime";
import { inTransaction, type Db } from "./db.js";

interface Row {
  run_id: string;
  sequence: number;
  kind: string;
  payload_json: string;
  created_at: number;
}

export class SqliteTranscriptStore implements TranscriptStorePort {
  constructor(private readonly db: Db) {}

  /**
   * 【定】D-2：事件与 transcript 条目共用一条单调序列，这里是唯一取号点。
   *
   * ── 为什么高水位必须落库（阶段 2 的实测结论）─────────────────────────
   *
   * 阶段 1 的 in-memory 实现把计数器放在进程内，resume 时由调用方从
   * `RUN_META.lastSequence` 传 `atLeast` 抬回来。**那在真崩溃下不成立**：
   * 号按事件粒度消耗，而 RUN_META 只在轮边界写一次；崩溃落在两者之间时，
   * 那批事件用掉的号在盘上没有任何痕迹（事件不落 transcript），
   * resume 就会把它们再发一遍。
   *
   * `verify:persistence` 第一次跑就打出了「重号 5」—— 这是阶段 1 测不出来的，
   * 因为阶段 1 的「崩溃」是往 transcript 注入形态，注入的时候顺手把
   * RUN_META 也写对了。
   *
   * 所以分配器自己持久化高水位。三个下界仍然都要：
   *   - `sequence_counters`：跨进程的权威下界；
   *   - `MAX(transcript_entries.sequence)`：库被外部改过时的兜底；
   *   - `atLeast`：调用方（resume）拿到的更高的已知下界。
   */
  async nextSequence(runId: RunId, atLeast = 0): Promise<number> {
    const key = String(runId);

    return inTransaction(this.db, () => {
      const cur = this.db
        .prepare("SELECT high_water FROM sequence_counters WHERE run_id = ?")
        .get(key) as { high_water: number } | undefined;
      const onDisk = this.db
        .prepare("SELECT MAX(sequence) AS m FROM transcript_entries WHERE run_id = ?")
        .get(key) as { m: number | null } | undefined;

      const next =
        Math.max(Number(cur?.high_water ?? 0), Number(onDisk?.m ?? 0), atLeast) + 1;

      this.db
        .prepare(
          `INSERT INTO sequence_counters (run_id, high_water) VALUES (?, ?)
             ON CONFLICT(run_id) DO UPDATE SET high_water = excluded.high_water`,
        )
        .run(key, next);

      return next;
    });
  }

  /**
   * 【定】不变量 5：消息先落盘再进内存 messages。
   *
   * 这里的「落盘」必须是真的 —— `append()` 返回时已经 COMMIT（node:sqlite
   * 的单条 INSERT 是自动提交的）。调用方 await 它完成才允许更新自己的
   * messages 数组，接口形态本身强制这条。
   *
   * 取号与写入**不**包在同一个事务里，两个理由：
   *   · `nextSequence()` 自己已经是一个事务，嵌套 BEGIN 在 SQLite 里直接报错；
   *   · 取到号却没写成，留下的只是一个空洞 —— 而空洞本来就是这条序列的
   *     正常形态（事件取号但不落 transcript）。把它当异常处理反而不对。
   */
  async append(entry: Omit<TranscriptEntry, "sequence">): Promise<number> {
    const sequence = await this.nextSequence(entry.runId);
    const payload = JSON.stringify({
      message: entry.message,
      compactSummary: entry.compactSummary,
      compactKept: entry.compactKept,
      meta: entry.meta,
    });

    this.db
      .prepare(
        `INSERT INTO transcript_entries
           (run_id, sequence, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(String(entry.runId), sequence, entry.kind, payload, entry.createdAt);

    return sequence;
  }

  async rebuildMessages(runId: RunId): Promise<ContextMessage[]> {
    return rebuildFromEntries(await this.readAll(runId));
  }

  async readAll(runId: RunId): Promise<TranscriptEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT run_id, sequence, kind, payload_json, created_at
           FROM transcript_entries WHERE run_id = ? ORDER BY sequence ASC`,
      )
      .all(String(runId)) as unknown as Row[];
    return rows.map((r) => toEntry(r));
  }

  async lastSequence(runId: RunId): Promise<number> {
    const row = this.db
      .prepare("SELECT MAX(sequence) AS m FROM transcript_entries WHERE run_id = ?")
      .get(String(runId)) as { m: number | null } | undefined;
    return Number(row?.m ?? 0);
  }
}

/**
 * 行 → TranscriptEntry。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】payload 解析失败**必须抛**，并点名是哪一条。
 *
 * 它此前退化成一条空 payload 的条目，注释写着「一条坏行不该让整个 Run
 * 无法恢复」。那句话把代价说反了 —— 被静默丢掉的可能是：
 *
 *   MESSAGE          恢复出来的上下文少一段，而模型不会发现；
 *   RUN_META         预算、验证事实、恢复项、序号下界一起归零；
 *   ACTION_FACT      执行前指纹消失 → §18.2 的分支判定换一条路走；
 *   COMPACT_BOUNDARY 重建从错误的位置开始。
 *
 * 也就是说：**一条坏数据不会失败，会被解释成「这些事实从未存在」**。
 * 这和本批删掉逐行 `schemaVersion` 跳过的理由是同一条 —— 那次删了，
 * 而同一个文件里这一处留着，口径不一致（codex 二次评审 P1-3）。
 * ══════════════════════════════════════════════════════════════════════
 */
function toEntry(r: Row): TranscriptEntry {
  let payload: {
    message?: ContextMessage;
    compactSummary?: ContextMessage;
    compactKept?: ContextMessage[];
    meta?: Record<string, unknown>;
  };
  try {
    payload = JSON.parse(r.payload_json) as typeof payload;
  } catch (err) {
    throw new Error(
      `transcript 条目损坏，无法解析 payload：run=${r.run_id} sequence=${r.sequence} ` +
        `kind=${r.kind}（${(err as Error).message}）。\n` +
        `恢复的唯一来源就是它 —— 跳过这一条会把「读不出来」变成「从未发生过」。`,
    );
  }

  const entry: TranscriptEntry = {
    runId: r.run_id as RunId,
    sequence: Number(r.sequence),
    kind: r.kind as TranscriptEntryKind,
    createdAt: Number(r.created_at),
  };
  if (payload.message) entry.message = payload.message;
  if (payload.compactSummary) entry.compactSummary = payload.compactSummary;
  if (payload.compactKept) entry.compactKept = payload.compactKept;
  if (payload.meta) entry.meta = payload.meta;
  return entry;
}
