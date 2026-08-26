/**
 * TranscriptStorePort 的 SQLite 实现（阶段 2）。
 *
 * 接口一个字没改 —— `TranscriptStorePort` 在阶段 1 就是按最终形态定的，
 * 这次换实现是对那个判断的检验，结果是通过了。
 *
 * 这也是 R-4（Port 异常收敛，2026-08-25 提前做掉）的兑现场合：
 * in-memory → SQLite 就是「换 Port 实现」，异常口径先收敛过，
 * 出问题时分得清是存储还是 Runtime。
 */

import {
  rebuildFromEntries,
  TRANSCRIPT_SCHEMA_VERSION,
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
  schema_version: number;
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
      meta: entry.meta,
    });

    this.db
      .prepare(
        `INSERT INTO transcript_entries
           (run_id, sequence, schema_version, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(entry.runId),
        sequence,
        entry.schemaVersion || TRANSCRIPT_SCHEMA_VERSION,
        entry.kind,
        payload,
        entry.createdAt,
      );

    return sequence;
  }

  async rebuildMessages(runId: RunId): Promise<ContextMessage[]> {
    return rebuildFromEntries(await this.readAll(runId));
  }

  async readAll(runId: RunId): Promise<TranscriptEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT run_id, sequence, schema_version, kind, payload_json, created_at
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
 * 【定】§18.5：`schemaVersion` 不兼容时，重建器必须能**跳过或 upcast 单条**，
 * 而不是整个 transcript 失效。这里的职责只是如实读出版本号 ——
 * 判定与跳过在 `rebuildFromEntries` / `readRunFacts` 里，
 * 不要在这一层提前过滤掉，否则 Trace 与 Replay 就看不到那些条目存在过。
 *
 * payload 解析失败也不抛：一条坏行不该让整个 Run 无法恢复。它会退化成
 * 一条没有 message 的条目，在重建时被自然跳过（`kind !== "MESSAGE" || !message`）。
 */
function toEntry(r: Row): TranscriptEntry {
  let payload: {
    message?: ContextMessage;
    compactSummary?: ContextMessage;
    meta?: Record<string, unknown>;
  } = {};
  try {
    payload = JSON.parse(r.payload_json) as typeof payload;
  } catch {
    payload = {};
  }

  const entry: TranscriptEntry = {
    runId: r.run_id as RunId,
    sequence: Number(r.sequence),
    schemaVersion: Number(r.schema_version),
    kind: r.kind as TranscriptEntryKind,
    createdAt: Number(r.created_at),
  };
  if (payload.message) entry.message = payload.message;
  if (payload.compactSummary) entry.compactSummary = payload.compactSummary;
  if (payload.meta) entry.meta = payload.meta;
  return entry;
}
