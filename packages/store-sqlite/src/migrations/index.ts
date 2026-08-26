/**
 * Migration 清单（V05 §26.3【定】：单一 runner、固定顺序）。
 *
 * 【定】只追加，不改写。改一条已经跑过的 migration，等于让「盘上的库」
 * 与「代码说的库」在没人察觉的情况下分叉 —— 要改就加下一条。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * 001：阶段 2 的四张表（方案 §2.3）。
 *
 * V05 §26.2 列了 Layer 3 的 13 张表，这里只建四张。**其余九张不建的理由是
 * 它们的消费者还不存在** —— `model_invocations` / `context_frames` /
 * `action_batches` / `actions` / `execution_attempts` / `observations` /
 * `verifications` / `runtime_blob_refs` / `capability_leases` 的读者会是
 * Layer 2 投影与 Eval Inspector，二者都在阶段 4。与 D-14 同源：
 * 没有用例检验就是盲写。
 *
 * 【定】**Layer 3 没有 event 表**（§26.2）。事件只进 JSONL Trace。
 * 这保住了 D-2 空洞的语义：transcript.sequence 里的空洞恰好表达
 * 「这两条消息之间发生过 N 个事件」，两条轨道因此可以全序比较。
 */
const M001: Migration = {
  version: 1,
  name: "stage2_core_tables",
  sql: `
    -- ── AgentSpecSnapshot：内容寻址，跨 Run 复用 ────────────────────────
    -- 【定】resume 的三条分支判定完全读它的 toolSnapshots（idempotency /
    -- verification / recoveryObservation）。必须是**冻结的那一份**，
    -- 不是 resume 当天 compose 出来的 —— 否则改一次工具声明就会让同一条
    -- transcript 走进不同分支，而盘上看不出来。
    CREATE TABLE IF NOT EXISTS agent_spec_snapshots (
      content_hash  TEXT PRIMARY KEY,
      agent_spec_id TEXT    NOT NULL,
      version       TEXT    NOT NULL,
      snapshot_json TEXT    NOT NULL,
      created_at    INTEGER NOT NULL
    );

    -- ── RunSpec：Run 启动时冻结 ────────────────────────────────────────
    -- spec_json **不含 agentSpec**，它在上面那张表里。一份数据一个权威，
    -- 存两份就会有分叉的那天（读回时由 run-repository 重新拼装）。
    CREATE TABLE IF NOT EXISTS run_specs (
      run_spec_id            TEXT PRIMARY KEY,
      agent_spec_content_hash TEXT NOT NULL,
      spec_json              TEXT    NOT NULL,
      spec_hash              TEXT    NOT NULL,
      created_at             INTEGER NOT NULL,
      FOREIGN KEY (agent_spec_content_hash)
        REFERENCES agent_spec_snapshots (content_hash)
    );

    -- ── Run：状态是 RECOVERY_REQUIRED 闸门的载体 ────────────────────────
    -- 【定】**不存序号高水位**。lastSequence 的权威副本在 transcript 的
    -- RUN_META 里（types/run.ts 的 ResumableRunFacts）。在这里存第二份，
    -- 就踩了本迁移开头「不建九张事实表」所依据的同一条线。
    CREATE TABLE IF NOT EXISTS runs (
      run_id      TEXT PRIMARY KEY,
      run_spec_id TEXT    NOT NULL,
      task        TEXT    NOT NULL,
      status      TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      FOREIGN KEY (run_spec_id) REFERENCES run_specs (run_spec_id)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_updated ON runs (updated_at DESC);

    -- ── transcript：恢复的唯一来源（§18.5）────────────────────────────
    -- 主键 (run_id, sequence)：同一 Run 内 sequence 唯一，这条由数据库强制，
    -- 不靠调用方自觉。D-2 的唯一取号点是 nextSequence()，撞主键就说明取号
    -- 出了第二条路径 —— 让它当场炸，不要静默覆盖。
    --
    -- payload_json 装 message / compactSummary / meta 三者之一，按 kind 解释。
    -- schema_version 单独成列而不是埋进 JSON：§18.5【定】要求不兼容时能
    -- **逐条跳过或 upcast**，那就得在不解析 payload 的前提下先读到版本号。
    CREATE TABLE IF NOT EXISTS transcript_entries (
      run_id         TEXT    NOT NULL,
      sequence       INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      kind           TEXT    NOT NULL,
      payload_json   TEXT    NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (run_id, sequence)
    );
  `,
};

/**
 * 002：序号分配器自己持久化高水位。
 *
 * ── 这条是被真崩溃逼出来的，不是设计时想到的 ─────────────────────────────
 *
 * M001 的注释说「lastSequence 的权威副本在 RUN_META 里，这里不存第二份」。
 * 那句话对**事实**成立，对**分配器**不成立 —— 第一次跑 verify:persistence
 * 就打出了「重号 5」：
 *
 *   · 号是按**事件**粒度消耗的（每 emit 一次取一个）；
 *   · 而 `RUN_META` 只在**轮边界**由 persistFacts() 写一次。
 *
 * 崩溃落在两者之间时，那一批事件用掉的号在盘上没有任何痕迹 ——
 * transcript 的 MAX 看不到（事件不落 transcript），RUN_META 也还没更新。
 * resume 于是从一个偏小的下界继续，把已经发出去的号又发了一遍。
 *
 * D-2 说 `nextSequence()` 是**唯一取号点**。既然如此，耐久性就该由它自己
 * 承担，而不是借 RUN_META 的。这不是「第二份权威」：
 *
 *   · `sequence_counters` 是**分配器状态**（下一个发什么号）；
 *   · `RUN_META.lastSequence` 是**事实**（那一刻已经发到哪了）。
 *
 * 两者回答的不是同一个问题，只是恰好数值相近。
 */
const M002: Migration = {
  version: 2,
  name: "sequence_counters",
  sql: `
    CREATE TABLE IF NOT EXISTS sequence_counters (
      run_id     TEXT PRIMARY KEY,
      high_water INTEGER NOT NULL
    );
  `,
};

export const MIGRATIONS: Migration[] = [M001, M002];
