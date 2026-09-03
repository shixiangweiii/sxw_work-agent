/**
 * SQLite 连接与 Schema（V05 §26.3）。
 *
 * ── 本包是全仓唯一允许 import `node:sqlite` 的地方 ─────────────────────────
 *
 * 判据是边界 grep 第 5 条：
 *
 *   grep -rn "node:sqlite" packages apps cases adapters   # 只允许本包命中
 *
 * 理由不是洁癖：`node:sqlite` 是 Node 22.5 才引入的年轻 API（v24 上
 * ExperimentalWarning 已消失，但仍在演进）。调用面收在一个包里，
 * 将来 API 变了只改一处，Runtime 与 CLI 一个字都不用动。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】**没有 migration 机制。** 只有一份当前 Schema ＋ 一道形状断言。
 *
 * 单人本地产品，schema 变了就删库重建 —— 维护一套演化机制的成本永远
 * 高于 `rm runs.db`。此前那套 runner（记账表 ＋ 版本号 ＋ 逐条事务 ＋ 回滚）
 * 三条 migration 的 DDL **全是 `CREATE TABLE IF NOT EXISTS`**，
 * 也就是说它从来没有真的迁移过任何东西，只是把「按顺序建表」包了三层。
 *
 * 【定】断言而不是 `IF NOT EXISTS` 静默跳过（本批决 1）。
 *
 * 只建不验的话，一个 schema 已经漂移的旧库看起来完全正常，直到某个
 * SELECT 报 `no such column` —— 那时错误信息指向的是查询，不是成因。
 * 本仓反复记的那条：**一条放行了却没验过的闸门，与验过并通过事后不可区分。**
 * ══════════════════════════════════════════════════════════════════════
 */

import { DatabaseSync } from "node:sqlite";

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
 * 当前 Schema。
 *
 * 【定】`ddl` 与 `columns` 是**两份手写清单**，这是刻意的：
 * 空库建完之后 `assertSchemaShape()` 会立刻比对两者，写错一个列名
 * 在第一次启动就会响亮地失败。二者不会静默分叉。
 */
interface TableSpec {
  name: string;
  ddl: string;
  /** 期望的列名集合，顺序无关。 */
  columns: string[];
  /**
   * 索引 DDL。
   *
   * 【定】与建表**分两步跑**，中间夹着形状断言。
   *
   * 合在一起的后果实测过：拿一个只有 `runs(run_id)` 的旧库来开，
   * `CREATE INDEX ... ON runs (updated_at)` 先炸，抛的是
   * `no such column: updated_at` —— 一条指向索引语句、说不出「该删库」的报错。
   * 断言必须排在索引之前，才能由它来解释这件事。
   */
  indexes?: string[];
  /**
   * 索引名清单。与 `indexes` 一样是**第二份手写清单** ——
   * 空库建完之后由 `assertSchemaShape()` 立刻比对，写漏一个当场炸。
   */
  indexNames?: string[];
}

const TABLES: TableSpec[] = [
  /**
   * AgentSpecSnapshot：内容寻址，跨 Run 复用。
   *
   * 【定】resume 的三条分支判定完全读它的 toolSnapshots。必须是**冻结的那一份**，
   * 不是 resume 当天 compose 出来的 —— 否则改一次工具声明就会让同一条
   * transcript 走进不同分支，而盘上看不出来。
   *
   * 【定】主键就是内容身份，不再另存 `agent_spec_id` / `version` ——
   * 那两列写了四个阶段、读取点为零，而它们的值全都在 `snapshot_json` 里。
   */
  {
    name: "agent_spec_snapshots",
    columns: ["content_hash", "snapshot_json"],
    ddl: `
      CREATE TABLE IF NOT EXISTS agent_spec_snapshots (
        content_hash  TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL
      );`,
  },
  /**
   * RunSpec：Run 启动时冻结。
   *
   * spec_json **不含 agentSpec**，它在上面那张表里。一份数据一个权威，
   * 存两份就会有分叉的那天（读回时由 run-repository 重新拼装）。
   */
  {
    name: "run_specs",
    columns: ["run_spec_id", "agent_spec_content_hash", "spec_json"],
    ddl: `
      CREATE TABLE IF NOT EXISTS run_specs (
        run_spec_id             TEXT PRIMARY KEY,
        agent_spec_content_hash TEXT NOT NULL,
        spec_json               TEXT NOT NULL,
        FOREIGN KEY (agent_spec_content_hash)
          REFERENCES agent_spec_snapshots (content_hash)
      );`,
  },
  /**
   * Run：状态是 RECOVERY_REQUIRED 闸门的载体。
   *
   * 【定】**不存序号高水位**。那是分配器状态，住在 `sequence_counters`。
   */
  {
    name: "runs",
    columns: ["run_id", "run_spec_id", "task", "status", "created_at", "updated_at"],
    ddl: `
      CREATE TABLE IF NOT EXISTS runs (
        run_id      TEXT PRIMARY KEY,
        run_spec_id TEXT    NOT NULL,
        task        TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        FOREIGN KEY (run_spec_id) REFERENCES run_specs (run_spec_id)
      );`,
    indexes: ["CREATE INDEX IF NOT EXISTS idx_runs_updated ON runs (updated_at DESC)"],
    indexNames: ["idx_runs_updated"],
  },
  /**
   * transcript：恢复的唯一来源（§18.5）。
   *
   * 主键 (run_id, sequence)：同一 Run 内 sequence 唯一，这条由数据库强制，
   * 不靠调用方自觉。D-2 的唯一取号点是 nextSequence()，撞主键就说明取号
   * 出了第二条路径 —— 让它当场炸，不要静默覆盖。
   *
   * payload_json 按 kind 装 message、compactSummary + compactKept snapshot 或 meta。
   *
   * 【定】**没有 schema_version 列。** 逐行版本＋跳过未来版本那套前向兼容
   * 挡的是一种不可能存在的数据（全仓只有一个生产者、只写常量 1），
   * 而它的代价是：读侧三处 `continue` 会在版本号错配时**静默丢弃**预算、
   * 恢复分支计数与执行前指纹 —— 一个降低故障可见性的兼容层。
   */
  {
    name: "transcript_entries",
    columns: ["run_id", "sequence", "kind", "payload_json", "created_at"],
    ddl: `
      CREATE TABLE IF NOT EXISTS transcript_entries (
        run_id       TEXT    NOT NULL,
        sequence     INTEGER NOT NULL,
        kind         TEXT    NOT NULL,
        payload_json TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );`,
  },
  /**
   * 序号分配器的高水位。
   *
   * ── 这张表是被真崩溃逼出来的，不是设计时想到的 ─────────────────────────
   *
   * 号是按**事件**粒度消耗的（每 emit 一次取一个），而 `RUN_META` 只在
   * **轮边界**写一次。崩溃落在两者之间时，那一批事件用掉的号在盘上没有
   * 任何痕迹 —— resume 于是从一个偏小的下界继续，把已经发出去的号又发一遍。
   *
   * 它**不是** `RUN_META.lastSequence` 的第二份权威：
   *   · `sequence_counters` 是**分配器状态**（下一个发什么号）；
   *   · `RUN_META.lastSequence` 是**事实**（那一刻已经发到哪了）。
   */
  {
    name: "sequence_counters",
    columns: ["run_id", "high_water"],
    ddl: `
      CREATE TABLE IF NOT EXISTS sequence_counters (
        run_id     TEXT PRIMARY KEY,
        high_water INTEGER NOT NULL
      );`,
  },
  /**
   * Resource 字节：文本与二进制共用内容寻址存储。
   *
   * 【定】主键是内容 hash，不是 ref。同一份内容被两个工具产出两次时
   * 只存一份，而两次的 ref 都指得到它。
   *
   * 【定】blob 与 Artifact 是**两回事**（§17：Runtime Blob 不自动升级为
   * Artifact）。blob 是「一次工具调用的结果太大，先放一边」；
   * Artifact 是「这是本次 Run 的交付物」。
   */
  {
    name: "resource_blobs",
    columns: ["content_hash", "size_bytes", "content"],
    ddl: `
      CREATE TABLE IF NOT EXISTS resource_blobs (
        content_hash TEXT PRIMARY KEY,
        size_bytes   INTEGER NOT NULL,
        content      BLOB    NOT NULL
      );`,
  },
  /**
   * ref → hash 与资源元数据。相同字节可有多个独立 ref。
   */
  {
    name: "resource_refs",
    columns: [
      "ref",
      "content_hash",
      "kind",
      "media_type",
      "label",
      "suggested_filename",
      "redaction_disposition",
      "created_at",
    ],
    ddl: `
      CREATE TABLE IF NOT EXISTS resource_refs (
        ref                   TEXT PRIMARY KEY,
        content_hash          TEXT    NOT NULL,
        kind                  TEXT    NOT NULL,
        media_type            TEXT    NOT NULL,
        label                 TEXT    NOT NULL,
        suggested_filename    TEXT,
        redaction_disposition TEXT    NOT NULL,
        created_at            INTEGER NOT NULL,
        FOREIGN KEY (content_hash) REFERENCES resource_blobs (content_hash)
      );`,
  },
  /**
   * Artifact：交付物登记（§17）。
   *
   * 版本用 (logical_id, version) 表达而不是原地更新：内容变化形成**新版本**，
   * 旧版本仍然可读 —— 「上一版交付物长什么样」是事后复盘最常问的问题之一。
   *
   * 【定】关联来源 Run。没有它，事后无法回答「这份东西是哪次跑出来的」，
   * 而内容去重必须同时同 Run、同 role（见 artifact-store 的说明）。
   */
  {
    name: "artifacts",
    columns: [
      "artifact_id",
      "logical_id",
      "version",
      "run_id",
      "role",
      "kind",
      "path",
      "content_hash",
      "size_bytes",
      "source_resource_ref",
      "verified",
      "verify_detail",
      "created_at",
    ],
    ddl: `
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id   TEXT PRIMARY KEY,
        logical_id    TEXT    NOT NULL,
        version       INTEGER NOT NULL,
        run_id        TEXT    NOT NULL,
        role          TEXT    NOT NULL,
        kind          TEXT    NOT NULL,
        path          TEXT,
        content_hash  TEXT    NOT NULL,
        size_bytes    INTEGER NOT NULL,
        source_resource_ref TEXT,
        verified      INTEGER,
        verify_detail TEXT,
        created_at    INTEGER NOT NULL,
        UNIQUE (logical_id, version),
        FOREIGN KEY (source_resource_ref) REFERENCES resource_refs (ref)
      );`,
    indexes: ["CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_id)"],
    indexNames: ["idx_artifacts_run"],
  },
];

/**
 * 打开库，建表，并断言盘上的形状就是当前 Schema。
 *
 * 【定】表结构在这里定义一次，不要在别处再写第二处建表语句 ——
 * 「表结构在哪定义」有两个答案的那天，就是它们开始分叉的那天。
 */
export function openDb(opts: OpenDbOptions): Db {
  const db = new DatabaseSync(opts.path);

  try {
    /**
     * WAL 让读不阻塞写。`:memory:` 库不支持 WAL，SQLite 会静默保持 memory 模式 ——
     * 所以这里不断言返回值，只对文件库有意义。
     */
    if (opts.path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    /** 外键约束默认关闭，显式打开 —— run_specs → agent_spec_snapshots 靠它兜底。 */
    db.exec("PRAGMA foreign_keys = ON");

    /**
     * ══════════════════════════════════════════════════════════════════
     * 【定】**空库才建；非空库在动任何 DDL 之前先完整校验。**
     *
     * 第一版是「无条件 `CREATE TABLE IF NOT EXISTS` 全表 → 再断言」，
     * 那仍然是一种隐式修补：一个缺表的旧库会被**先补上表**再检查，
     * 而检查只看现存表的列 —— 补出来的那张当然是对的。
     * 也就是说断言的强度低于它自己那句「盘上的形状就是当前 Schema」，
     * 又一次「声明强于实现」（codex 二次评审 P1-2）。
     *
     * 分开之后两条性质都成立：
     *   · 空库 —— 建完立刻自校验，`ddl`/`columns`/`indexNames` 三份手写清单
     *     互为判据，写错一个名字在第一次启动就炸；
     *   · 非空库 —— 一个字节都不改就先验，不符则关连接后抛。
     * ══════════════════════════════════════════════════════════════════
     */
    if (isEmptyDb(db)) {
      for (const t of TABLES) db.exec(t.ddl);
      for (const t of TABLES) for (const idx of t.indexes ?? []) db.exec(idx);
    }
    assertSchemaShape(db, opts.path);
  } catch (err) {
    // 【定】抛之前关连接。不关的话文件句柄与 WAL 会挂到进程结束，
    // 而调用方拿到的是一个异常，手里没有可关的东西。
    db.close();
    throw err;
  }

  return db;
}

/** 一张用户表都没有 = 全新的库。`sqlite_%` 是 SQLite 自己的内部对象。 */
function isEmptyDb(db: Db): boolean {
  const row = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0) === 0;
}

/**
 * 盘上的列集合必须与 `TABLES` 逐字相符。
 *
 * 【定】不符就抛，并明确告诉用户**删库重建**。
 *
 * 这道断言有两个服务对象，缺一不可：
 *   · 旧库 —— 在动它一个字节之前就判定，缺表/多表/缺列/多列/索引不符都报；
 *   · 本文件自己 —— `ddl` / `columns` / `indexNames` 是三份手写清单，
 *     写错一个名字会在**第一次跑空库**时就炸出来，不会静默分叉。
 */
function assertSchemaShape(db: Db, path: string): void {
  const problems: string[] = [];
  const diff = (label: string, expected: string[], actual: string[]): string | undefined => {
    const missing = expected.filter((c) => !actual.includes(c));
    const extra = actual.filter((c) => !expected.includes(c));
    if (missing.length === 0 && extra.length === 0) return undefined;
    return (
      `  ${label}：` +
      (missing.length > 0 ? `缺 ${missing.join(", ")}` : "") +
      (missing.length > 0 && extra.length > 0 ? "；" : "") +
      (extra.length > 0 ? `多出 ${extra.join(", ")}` : "")
    );
  };

  /**
   * ── 表集合本身也要比 ────────────────────────────────────────────────
   *
   * 【定】只遍历**期望的表**是不够的：那样一张多余的旧表（最典型的就是
   * 上一版留下的 `schema_migrations`）永远不会被看见，而它恰恰是
   * 「这个库来自另一个版本」最直接的证据。
   */
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ type: string; name: string }>;
  const actualTables = objects.filter((o) => o.type === "table").map((o) => o.name);
  const actualIndexes = objects.filter((o) => o.type === "index").map((o) => o.name);

  const tableDiff = diff("表集合", TABLES.map((t) => t.name), actualTables);
  if (tableDiff) problems.push(tableDiff);

  const expectedIndexes = TABLES.flatMap((t) => t.indexNames ?? []);
  const indexDiff = diff("索引", expectedIndexes, actualIndexes);
  if (indexDiff) problems.push(indexDiff);

  for (const t of TABLES) {
    if (!actualTables.includes(t.name)) continue; // 缺表已经在上面报过
    const rows = db.prepare(`PRAGMA table_info(${t.name})`).all() as unknown as Array<{
      name: string;
    }>;
    const d = diff(t.name, t.columns, rows.map((r) => r.name));
    if (d) problems.push(d);
  }

  if (problems.length === 0) return;

  throw new Error(
    `库 ${path} 的表结构与当前 Schema 不符：\n${problems.join("\n")}\n\n` +
      `本项目**没有 migration 机制**（单人本地库，删了重建比维护一套演化机制便宜）。\n` +
      `处置：删掉这个文件再跑一次。\n` +
      `  rm ${path}\n` +
      `Trace（.workagent/runs/*.jsonl）是独立轨道，不会受影响。`,
  );
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
