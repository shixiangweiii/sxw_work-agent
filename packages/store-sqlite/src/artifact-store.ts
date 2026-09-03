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
 * ③ **复用必须同时同 Run、同 role**，不能只比 `content_hash`。
 *    只比内容的话，旧记录会连同它的 `run_id` 与 `role` 一起被当成本次登记的
 *    结果返回 —— 最容易撞上的是同 Run 内的 role 晋升（先 INTERMEDIATE
 *    后 DELIVERABLE），它会让「DELIVERABLE 检查失败判 FAILED」这条强制力
 *    **静默降档**。详见 `register()` 里那段【定】。
 *    （这一条此前只写在函数体里，文件头说「三条」却只列了两条。）
 *
 * 【定】没有 Tombstone、没有 lineage —— 两者都**没有任何生产者**：
 * 全仓没有删除产物的路径，也没有工具填过 `derivedFrom`。
 * 一个永远为空的 lineage 字段与一个不存在的字段分不出来，而它会让
 * 读代码的人以为派生关系是被记录的（本仓「未接线比不写更糟」的形态）。
 * 真出现「产物 A 由 B 派生」的用例时再加，那时它会有第一个生产者。
 */

import { createHash } from "node:crypto";
import type {
  ArtifactRecord,
  ArtifactRegistration,
  ArtifactStorePort,
  RunId,
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
  source_resource_ref: string | null;
  verified: number | null;
  verify_detail: string | null;
  created_at: number;
}

export class SqliteArtifactStore implements ArtifactStorePort {
  constructor(private readonly db: Db) {}

  async register(input: ArtifactRegistration): Promise<ArtifactRecord> {
    /**
     * 【定】hash 与 size 都按**真实字节**算（ADR-0010）。
     *
     * 原来是 `sha256(content, "utf8")` ＋ `Buffer.byteLength(content, "utf8")`，
     * 那对字符串是对的，对二进制是错的 —— 而错的方向很隐蔽：
     * 登记下来的 hash 会与磁盘上那份字节不等，于是 `artifact-checks` 的第 ①
     * 项（磁盘复核）必红，`DELIVERABLE` 按 §1.2 第 3 条结算 `FAILED`。
     * **一个把交付物做对了的 Run 会因为登记侧的编码口径被判成失败。**
     */
    const bytes = toBytes(input.content);
    const hash = sha256Bytes(bytes);
    const size = bytes.byteLength;
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
       *
       * ══════════════════════════════════════════════════════════════════
       * 【定】去重必须**同时**同 Run、同 role（二次评审 codex P1-4）。
       *
       * 原判定只比 `content_hash`，而查询本身也没有按 runId 过滤
       * （`WHERE logical_id = ?` 取最新一版）。于是旧记录会**连同它的
       * `run_id` 与 `role` 一起**被当成本次登记的结果返回。两个后果：
       *
       *   跨 Run：Run B 产出逐字节相同的 `images.zip` → 拿到 Run A 的
       *           artifactId → `listByRun(B)` 查不到它、界面拒绝预览，
       *           而 `deliveredArtifactIds` 里躺着一个不属于本 Run 的 id；
       *   同 Run role 晋升（**更容易撞上**）：先按 INTERMEDIATE 登记、
       *           后按 DELIVERABLE 登记同一份内容 → 永远停在 INTERMEDIATE
       *           → §1.2 第 3 条「DELIVERABLE 检查失败判 FAILED」那条
       *           **强制力被静默降档**，而盘上看不出来。
       *
       * 「内容相同」是 Resource 内容层的事，「这是谁的、什么角色的产物」是 Artifact
       * 层的 provenance —— 两件事不能用一个 hash 合并掉。
       * 判据在 `verify:artifact` I 段，两条各做过注入实测。
       * ══════════════════════════════════════════════════════════════════
       */
      if (
        latest &&
        latest.content_hash === hash &&
        latest.run_id === String(input.runId) &&
        latest.role === input.role
      ) {
        // sourceResourceRef 是这个内容版本**创建时**的来源，不追溯性改写。
        // 当前这次登记的来源由 ArtifactRegistered 事件记录；改旧行会让历史事件
        // 与数据库分叉，并把 write_file 创建的版本伪装成 Resource 产物。
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
              content_hash, size_bytes, source_resource_ref, created_at)
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
          input.sourceResourceRef ?? null,
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
    ...(r.source_resource_ref === null
      ? {}
      : { sourceResourceRef: r.source_resource_ref }),
    // 【定】NULL → undefined，不要变成 false。
    // 「还没验过」与「验过没通过」在结算时的含义完全不同。
    ...(r.verified === null ? {} : { verified: r.verified === 1 }),
    ...(r.verify_detail === null ? {} : { verifyDetail: r.verify_detail }),
    createdAt: r.created_at,
  };
}

/**
 * 内容 → 字节。字符串按 UTF-8，字节原样。
 *
 * 【定】字符串那一档必须**保持** UTF-8 —— 换成别的编码会让所有已登记的
 * text / json 产物 hash 全变，等于把版本链（语义 ②「内容一样不开新版本」）
 * 在一次升级里整个作废，而盘上看不出来。
 */
function toBytes(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function sha256Bytes(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
