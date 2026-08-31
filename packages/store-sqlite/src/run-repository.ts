/**
 * RunStorePort 的 SQLite 实现（阶段 2）。
 *
 * 它承载的是那条最容易被忽略的不变量：**resume 必须读到冻结的那一份
 * RunSpec**（§18.4【定】）。阶段 1 靠「进程没死」自动成立，跨进程之后
 * 要靠这张表。
 */

import { createHash } from "node:crypto";
import {
  asId,
  freezeRunSpec,
  type AgentSpecSnapshot,
  type RunId,
  type RunListItem,
  type RunSpec,
  type RunSpecId,
  type RunStatus,
  type RunStorePort,
  type Timestamp,
} from "@workagent/harness-runtime";
import { inTransaction, type Db } from "./db.js";

export class SqliteRunStore implements RunStorePort {
  constructor(private readonly db: Db) {}

  /**
   * 【定】RunSpec、AgentSpecSnapshot 与 Run 行必须在**同一个事务**里落盘。
   *
   * 分开写的话，崩在中间会留下「有 Run 行、没有 spec」——那个 Run 既
   * resume 不了（读不到 spec），又会出现在 `--list-runs` 里，是一个
   * 看得见摸不着的僵尸。
   */
  async createRun(input: {
    runId: RunId;
    spec: RunSpec;
    status: RunStatus;
    now: Timestamp;
  }): Promise<void> {
    const { runId, spec, status, now } = input;
    const agentJson = JSON.stringify(spec.agentSpec);
    const agentHash = sha256(agentJson);

    // agentSpec 从 spec_json 里摘掉 —— 它有自己的表。
    // 存两份同样的字节，就是给「哪份是对的」留一个将来会被问到的问题。
    const { agentSpec: _omit, ...rest } = spec;
    const specJson = JSON.stringify(rest);

    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_spec_snapshots (content_hash, snapshot_json)
           VALUES (?, ?)`,
        )
        .run(agentHash, agentJson);

      this.db
        .prepare(
          `INSERT OR REPLACE INTO run_specs (run_spec_id, agent_spec_content_hash, spec_json)
           VALUES (?, ?, ?)`,
        )
        .run(String(spec.id), agentHash, specJson);

      this.db
        .prepare(
          `INSERT OR REPLACE INTO runs
             (run_id, run_spec_id, task, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(String(runId), String(spec.id), spec.input.task, status, now, now);
    });
  }

  /**
   * 读回冻结的 RunSpec，由两张表拼装。
   *
   * 【定】拼不出来就返回 undefined，**不要回退到当前配置**。
   * 「读不到就用现在的」是这一整条不变量最容易被写出来的破法。
   */
  async getRunSpec(runId: RunId): Promise<RunSpec | undefined> {
    const row = this.db
      .prepare(
        `SELECT rs.spec_json AS spec_json, a.snapshot_json AS agent_json
           FROM runs r
           JOIN run_specs rs ON rs.run_spec_id = r.run_spec_id
           JOIN agent_spec_snapshots a ON a.content_hash = rs.agent_spec_content_hash
          WHERE r.run_id = ?`,
      )
      .get(String(runId)) as { spec_json: string; agent_json: string } | undefined;
    if (!row) return undefined;

    const rest = JSON.parse(row.spec_json) as Omit<RunSpec, "agentSpec">;
    const agentSpec = JSON.parse(row.agent_json) as AgentSpecSnapshot;

    /**
     * 【定】读回来的 spec 必须**重新深冻结**（M-4）。
     *
     * `start()` 里的 `freezeRunSpec()` 冻的是内存里那一份，而 `JSON.parse`
     * 产出的是一棵全新的可变树 —— 深冻结在「落库 → 读回」这一趟往返里丢了。
     * 于是 resume 路径（也就是**唯一真正需要这条不变量的路径**）拿到的
     * 恰恰是没被冻住的那份：谁在恢复过程中改了 `toolSnapshots` 或某条 policy，
     * 不会有任何报错，而 §18.2 的三条分支判定读的正是 `toolSnapshots`。
     *
     * 二次评审（2026-08-27，P3-2）发现。阶段 2 的实施记录曾把 M-4 记为已落地，
     * 那个结论只对 `start()` 成立。
     */
    return freezeRunSpec({ ...rest, agentSpec });
  }

  async getStatus(runId: RunId): Promise<RunStatus | undefined> {
    const row = this.db
      .prepare("SELECT status FROM runs WHERE run_id = ?")
      .get(String(runId)) as { status: string } | undefined;
    return row ? (row.status as RunStatus) : undefined;
  }

  async setStatus(runId: RunId, status: RunStatus, now: Timestamp): Promise<void> {
    this.db
      .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?")
      .run(status, now, String(runId));
  }

  async list(limit = 50): Promise<RunListItem[]> {
    const rows = this.db
      .prepare(
        `SELECT run_id, run_spec_id, task, status, created_at, updated_at
           FROM runs ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      run_id: string;
      run_spec_id: string;
      task: string;
      status: string;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      runId: asId<RunId>(r.run_id),
      runSpecId: asId<RunSpecId>(r.run_spec_id),
      status: r.status as RunStatus,
      task: r.task,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
