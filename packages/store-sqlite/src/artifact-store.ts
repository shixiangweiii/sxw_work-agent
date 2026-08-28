/**
 * `ArtifactStorePort` 的 SQLite 实现（阶段 3 S8，§17）。
 *
 * 三条登记语义，每条都有「不这么做会怎样」：
 *
 * ① **内容变化形成新版本**，不原地覆盖。
 *    覆盖之后「上一版交付物长什么样」就永远回答不了了 ——
 *    而那是事后复盘最常问的问题之一。
 *
 * ② **内容没变就复用当前版本**，不无脑加版本号。
 *    同一次 Run 里模型可能重复登记同一份产物（比如验证后再登记一次）。
 *    每次都 +1 会让版本号变成「登记次数」，失去「改了几次」的含义。
 *
 * ③ **删除写 Tombstone**，不物理删除。
 *    一次误删之后，「它曾经存在过」比「它现在没了」更重要。
 */

import { createHash } from "node:crypto";
import type {
  ArtifactRecord,
  ArtifactRegistration,
  ArtifactStorePort,
  RunId,
  Timestamp,
} from "@workagent/harness-runtime";
import type { Db } from "./db.js";
import { inTransaction } from "./db.js";

interface Row {
  artifact_id: string;
  logical_id: string;
  version: number;
  run_id: string;
  role: string;
  kind: string;
  path: string | null;
  content_hash: string;
  size_bytes: number;
  derived_from: string;
  tombstoned_at: number | null;
  verified: number | null;
  verify_detail: string | null;
  created_at: number;
}

export class SqliteArtifactStore implements ArtifactStorePort {
  constructor(private readonly db: Db) {}

  async register(input: ArtifactRegistration): Promise<ArtifactRecord> {
    const hash = sha256(input.content);
    const size = Buffer.byteLength(input.content, "utf8");
    const now = Date.now();

    return inTransaction(this.db, () => {
      const latest = this.db
        .prepare(
          `SELECT * FROM artifacts WHERE logical_id = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(input.logicalId) as unknown as Row | undefined;

      /**
       * 语义 ②：内容一模一样就不开新版本，直接把当前这一版返回去。
       *
       * 【定】但**验证结果不重置** —— 内容没变，上次验过的结论仍然成立。
       * 重置会让「登记一次就得重验一次」，而验证是要花时间的（ZIP 解压、
       * JSON 解析），在一个循环里反复登记就会反复付费。
       */
      if (latest && latest.content_hash === hash && latest.tombstoned_at === null) {
        return toRecord(latest);
      }

      const version = (latest?.version ?? 0) + 1;
      /**
       * 【定】清洗要用 Unicode 属性类，不能用 `\W`。
       *
       * `\W` 是 ASCII 语义：中文、日文、任何非拉丁文字都算「非字母」。
       * 于是 `客户汇总.md` 会被清成 `_md`，artifact id 变成
       * `art__md_v1_6a7dd0a1` —— 唯一性没问题（版本号 ＋ hash 兜着），
       * 但**identity 全丢了**：Trace 与报告里一排 `art__md_*`，
       * 谁都认不出是哪份产物。而中文文件名恰恰是本项目的主场景。
       */
      const slug = input.logicalId.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
      const artifactId = `art_${slug.slice(0, 40) || "unnamed"}_v${version}_${hash.slice(0, 8)}`;

      this.db
        .prepare(
          `INSERT INTO artifacts
             (artifact_id, logical_id, version, run_id, role, kind, path,
              content_hash, size_bytes, derived_from, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          input.logicalId,
          version,
          String(input.runId),
          input.role,
          input.kind,
          input.path ?? null,
          hash,
          size,
          JSON.stringify(input.derivedFrom ?? []),
          now,
        );

      const row = this.db
        .prepare("SELECT * FROM artifacts WHERE artifact_id = ?")
        .get(artifactId) as unknown as Row;
      return toRecord(row);
    });
  }

  async markVerified(artifactId: string, ok: boolean, detail: string): Promise<void> {
    this.db
      .prepare("UPDATE artifacts SET verified = ?, verify_detail = ? WHERE artifact_id = ?")
      .run(ok ? 1 : 0, detail, artifactId);
  }

  async get(artifactId: string): Promise<ArtifactRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE artifact_id = ?")
      .get(artifactId) as unknown as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  async listByRun(runId: RunId): Promise<ArtifactRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC")
      .all(String(runId)) as unknown as Row[];
    return rows.map(toRecord);
  }

  async tombstone(artifactId: string, at: Timestamp): Promise<void> {
    this.db
      .prepare("UPDATE artifacts SET tombstoned_at = ? WHERE artifact_id = ?")
      .run(at, artifactId);
  }
}

function toRecord(r: Row): ArtifactRecord {
  return {
    artifactId: r.artifact_id,
    logicalId: r.logical_id,
    version: r.version,
    runId: r.run_id as RunId,
    role: r.role as ArtifactRecord["role"],
    kind: r.kind,
    ...(r.path === null ? {} : { path: r.path }),
    contentHash: r.content_hash,
    sizeBytes: r.size_bytes,
    derivedFrom: JSON.parse(r.derived_from) as string[],
    ...(r.tombstoned_at === null ? {} : { tombstonedAt: r.tombstoned_at }),
    // 【定】NULL → undefined，不要变成 false。
    // 「还没验过」与「验过没通过」在结算时的含义完全不同。
    ...(r.verified === null ? {} : { verified: r.verified === 1 }),
    ...(r.verify_detail === null ? {} : { verifyDetail: r.verify_detail }),
    createdAt: r.created_at,
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
