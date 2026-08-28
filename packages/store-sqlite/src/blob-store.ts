/**
 * `BlobStorePort` 的 SQLite 实现（阶段 3 S6，§11.4）。
 *
 * 【定】内容寻址：同一份内容只存一份（主键是 hash），但每次 `put` 都发一个
 * 新的 ref。两者分开的理由是它们回答不同的问题 —— hash 是「这是什么内容」，
 * ref 是「这是哪一次调用的结果」。大结果动辄几百 KB，按调用存内容会让库
 * 在一个长 Run 里胀几十倍。
 *
 * 【定】`get` 按**行**分页，与 `read_file` 语义一致。
 * 只给 `get(ref): string` 的话，取回一个 500KB 的 blob 会把它整个灌回上下文
 * —— 那就把刚刚外置掉的东西又搬了回来。
 */

import { createHash } from "node:crypto";
import type { BlobPage, BlobStorePort, RunId } from "@workagent/harness-runtime";
import type { Db } from "./db.js";
import { inTransaction } from "./db.js";

export class SqliteBlobStore implements BlobStorePort {
  constructor(private readonly db: Db) {}

  async put(input: {
    content: string;
    runId?: RunId;
    toolName?: string;
  }): Promise<{ ref: string; hash: string; size: number }> {
    const hash = sha256(input.content);
    const size = Buffer.byteLength(input.content, "utf8");
    // ref 里带 hash 前缀是刻意的：模型在帧里看到 `blob_a1b2c3…`，
    // 两次相同的结果一眼看得出是同一份东西，不必去比对内容。
    const ref = `blob_${hash.slice(0, 12)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    inTransaction(this.db, () => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO blobs (content_hash, size_bytes, content, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(hash, size, input.content, now);
      this.db
        .prepare(
          "INSERT INTO blob_refs (ref, content_hash, run_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(ref, hash, input.runId ? String(input.runId) : null, input.toolName ?? null, now);
    });

    return { ref, hash, size };
  }

  /**
   * 单页字符预算。
   *
   * 【定】必须**明显小于** `inlineToolResultLimitTokens`（默认 8000 tokens
   * ≈ 20000 字符）。否则 `read_blob` 自己的返回值会再次超阈值、被再外置一次，
   * 模型于是拿到一个新 ref 去取 —— 一个稳定的、每次都多花一轮的循环。
   *
   * 12000 字符 ≈ 4800 tokens，留足了 JSON 包装与其余字段的余量。
   */
  private static readonly MAX_PAGE_CHARS = 12_000;

  async get(
    ref: string,
    opts?: { startLine?: number; limit?: number; lineOffset?: number; maxChars?: number },
  ): Promise<BlobPage | undefined> {
    const row = this.db
      .prepare(
        `SELECT b.content_hash AS hash, b.size_bytes AS size, b.content AS content
           FROM blob_refs r JOIN blobs b ON b.content_hash = r.content_hash
          WHERE r.ref = ?`,
      )
      .get(ref) as { hash: string; size: number; content: string } | undefined;

    // 【定】取不到返回 undefined，**不抛**。模型给错 ref 是它自己纠正得了的，
    // 抛异常会走进 settle-batch 的 TOOL_THREW 分支，把副作用状态误记成 UNKNOWN。
    if (!row) return undefined;

    const lines = row.content.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const totalLines = lines.length;

    const from = Math.max(0, Math.trunc((opts?.startLine ?? 1) - 1));
    const limit = Math.max(1, Math.trunc(opts?.limit ?? 2_000));
    const offset = Math.max(0, Math.trunc(opts?.lineOffset ?? 0));
    const maxChars = Math.max(200, Math.trunc(opts?.maxChars ?? SqliteBlobStore.MAX_PAGE_CHARS));

    const base = {
      ref,
      hash: row.hash,
      sizeBytes: row.size,
      totalLines,
      startLine: from + 1,
      lineOffset: offset,
    };

    if (from >= totalLines) {
      // 越界请求：如实回一个空页，不报错。模型翻过头了，告诉它到头了就行。
      return { ...base, endLine: totalLines, truncated: false, content: "" };
    }

    /**
     * ── 先按字符预算装，再谈行数上限 ────────────────────────────────────
     *
     * 两层预算的顺序是刻意的：行数上限保护的是「行很多」，
     * 字符预算保护的是「行很长」。工具结果几乎都是一行 JSON ——
     * 只有第二层能挡住它，而那恰恰是被外置的主要形态。
     */
    const out: string[] = [];
    let used = 0;
    let cursor = from;
    let cursorOffset = offset;

    while (cursor < totalLines && out.length < limit) {
      const line = lines[cursor]!;
      const piece = cursor === from ? line.slice(cursorOffset) : line;
      // 加上换行符的开销，避免 out.join("\n") 之后超出预算。
      const cost = piece.length + (out.length > 0 ? 1 : 0);

      if (used + cost <= maxChars) {
        out.push(piece);
        used += cost;
        cursor += 1;
        cursorOffset = 0;
        continue;
      }

      /**
       * 装不下这一行。分两种情况，**都必须是分页而不是截断**：
       *
       *   · 已经装了别的行 → 这一行整条留给下一页（nextLineOffset = 0）；
       *   · 一行都还没装（说明这一行本身就超预算）→ 切一片，
       *     并用 nextLineOffset 告诉模型从这一行的第几个字符接着取。
       */
      if (out.length > 0) break;
      const room = maxChars - used;
      out.push(piece.slice(0, room));
      return {
        ...base,
        endLine: cursor + 1,
        truncated: true,
        nextStartLine: cursor + 1,
        nextLineOffset: cursorOffset + room,
        content: out.join("\n"),
      };
    }

    const endLine = cursor;
    const truncated = cursor < totalLines;
    return {
      ...base,
      endLine,
      truncated,
      ...(truncated ? { nextStartLine: cursor + 1, nextLineOffset: 0 } : {}),
      content: out.join("\n"),
    };
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
