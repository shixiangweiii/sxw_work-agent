/**
 * SQLite 连接与 Migration runner（V05 §26.3【定】、§26.4【验】）。
 *
 * ── 本包是全仓唯一允许 import `node:sqlite` 的地方 ─────────────────────────
 *
 * 判据是阶段 2 新增的第 5 条边界 grep：
 *
 *   grep -rn "node:sqlite" packages apps cases adapters   # 只允许本包命中
 *
 * 理由不是洁癖：`node:sqlite` 是 Node 22.5 才引入的年轻 API（v24 上
 * ExperimentalWarning 已消失，但仍在演进）。调用面收在一个包里，
 * 将来 API 变了只改一处，Runtime 与 CLI 一个字都不用动。
 */

import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations/index.js";

export type Db = DatabaseSync;

export interface OpenDbOptions {
  /**
   * 库文件路径。`:memory:` 是**同一条 SQLite 代码路径**，只是不落盘 ——
   * 验收脚本用它，既密封又不牺牲覆盖：跑的是真 SQL，不是内存桩。
   */
  path: string;
  /** busy_timeout（毫秒）。§26.4：WAL ＋ 合理 busy_timeout 应当足够。 */
  busyTimeoutMs?: number;
}

/**
 * 打开库并把 migration 跑到最新。
 *
 * 【定】§26.3：Migration 由**单一 runner** 按固定顺序执行。
 * 这里就是那个唯一的 runner —— 不要在别处再写第二处建表语句，
 * 「表结构在哪定义」有两个答案的那天，就是它们开始分叉的那天。
 */
export function openDb(opts: OpenDbOptions): Db {
  const db = new DatabaseSync(opts.path);

  /**
   * WAL 让读不阻塞写。`:memory:` 库不支持 WAL，SQLite 会静默保持 memory 模式 ——
   * 所以这里不断言返回值，只对文件库有意义。
   */
  if (opts.path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  /** 外键约束默认关闭，显式打开 —— run_specs → agent_spec_snapshots 靠它兜底。 */
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db);
  return db;
}

/**
 * 把 migration 按 version 升序跑到最新，已跑过的跳过。
 *
 * 【定】只前进，不回退。阶段 2 没有 down migration —— 单人本地库，
 * 出问题删了重跑比维护一套反向 SQL 便宜，而反向 SQL 一旦写错是静默的。
 */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((r) => Number((r as { version: number }).version)),
  );

  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      insert.run(m.version, m.name, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `migration ${m.version}（${m.name}）失败：${(err as Error).message}\n` +
          `库已回滚到上一个版本，没有半应用的 schema。`,
      );
    }
  }
}

/**
 * 在一个事务里跑 fn。
 *
 * 不变量 5（消息先落盘再进内存）要求 `append()` 返回时数据**真的已经提交**。
 * node:sqlite 没有 better-sqlite3 那种 `.transaction()` 包装，所以这里自己写一个。
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
