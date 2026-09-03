/**
 * `ResourceStorePort` 的 SQLite 实现。
 *
 * 字节以 SHA-256 内容寻址去重；引用表达一次独立产生，因此相同内容每次 put
 * 仍得到新的 `res_*`。文本分页是模型可见通道，完整字节读取只供本地物化。
 */

import { createHash } from "node:crypto";
import type {
  MaterializableResource,
  ResourcePutInput,
  ResourceReference,
  ResourceStorePort,
  ResourceTextPage,
} from "@workagent/harness-runtime";
import { MAX_RESOURCE_BYTES } from "@workagent/harness-runtime";
import type { Db } from "./db.js";
import { inTransaction } from "./db.js";

interface ResourceRow {
  ref: string;
  content_hash: string;
  size_bytes: number;
  kind: "text" | "binary";
  media_type: string;
  label: string;
  suggested_filename: string | null;
  redaction_disposition: ResourceReference["redactionDisposition"];
  content?: Uint8Array;
}

export class SqliteResourceStore implements ResourceStorePort {
  private static readonly MAX_PAGE_CHARS = 12_000;

  constructor(private readonly db: Db) {}

  async put(input: ResourcePutInput): Promise<ResourceReference> {
    if (input.kind === "text" && typeof input.content !== "string") {
      throw new Error("RESOURCE_KIND_CONTENT_MISMATCH: text Resource 必须提供 string 内容");
    }
    if (input.kind === "binary" && typeof input.content === "string") {
      throw new Error("RESOURCE_KIND_CONTENT_MISMATCH: binary Resource 必须提供 Uint8Array 内容");
    }
    if (
      (input.kind === "text" && input.redactionDisposition !== "TEXT_REDACTED") ||
      (input.kind === "binary" &&
        input.redactionDisposition !== "OPAQUE_BINARY_NOT_TEXT_SCANNED")
    ) {
      throw new Error("RESOURCE_REDACTION_DISPOSITION_MISMATCH: 处置标记与 Resource kind 不一致");
    }
    const bytes =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);
    if (bytes.byteLength > MAX_RESOURCE_BYTES) {
      throw new Error(
        `RESOURCE_TOO_LARGE: ${bytes.byteLength} 字节超过单个 Resource 的 ${MAX_RESOURCE_BYTES} 字节上限`,
      );
    }

    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const ref = `res_${contentHash.slice(0, 12)}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();

    inTransaction(this.db, () => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO resource_blobs (content_hash, size_bytes, content) VALUES (?, ?, ?)",
        )
        .run(contentHash, bytes.byteLength, bytes);
      this.db
        .prepare(
          `INSERT INTO resource_refs
             (ref, content_hash, kind, media_type, label, suggested_filename,
              redaction_disposition, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ref,
          contentHash,
          input.kind,
          input.mediaType,
          input.label,
          input.suggestedFilename ?? null,
          input.redactionDisposition,
          createdAt,
        );
    });

    return {
      ref,
      contentHash,
      sizeBytes: bytes.byteLength,
      kind: input.kind,
      mediaType: input.mediaType,
      label: input.label,
      ...(input.suggestedFilename === undefined
        ? {}
        : { suggestedFilename: input.suggestedFilename }),
      redactionDisposition: input.redactionDisposition,
    };
  }

  async getMetadata(ref: string): Promise<ResourceReference | undefined> {
    const row = this.select(ref, false);
    return row ? toReference(row) : undefined;
  }

  async getTextPage(
    ref: string,
    opts?: { startLine?: number; limit?: number; lineOffset?: number; maxChars?: number },
  ): Promise<ResourceTextPage | undefined> {
    const row = this.select(ref, true);
    if (!row) return undefined;
    if (row.kind !== "text") return undefined;

    const content = Buffer.from(row.content!).toString("utf8");
    const lines = content.split("\n");
    const totalLines = lines.length;
    const from = Math.max(0, Math.trunc((opts?.startLine ?? 1) - 1));
    const limit = Math.max(1, Math.trunc(opts?.limit ?? 2_000));
    const offset = Math.max(0, Math.trunc(opts?.lineOffset ?? 0));
    const maxChars = Math.max(
      200,
      Math.trunc(opts?.maxChars ?? SqliteResourceStore.MAX_PAGE_CHARS),
    );
    const base = {
      ...toReference(row),
      totalLines,
      startLine: from + 1,
      lineOffset: offset,
    };

    if (from >= totalLines) {
      return { ...base, endLine: totalLines, truncated: false, content: "" };
    }

    const out: string[] = [];
    let used = 0;
    let cursor = from;
    let cursorOffset = offset;
    while (cursor < totalLines && out.length < limit) {
      const line = lines[cursor]!;
      const piece = cursor === from ? line.slice(cursorOffset) : line;
      const cost = piece.length + (out.length > 0 ? 1 : 0);
      if (used + cost <= maxChars) {
        out.push(piece);
        used += cost;
        cursor += 1;
        cursorOffset = 0;
        continue;
      }
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

  async readForMaterialization(ref: string): Promise<MaterializableResource | undefined> {
    const row = this.select(ref, true);
    if (!row) return undefined;
    return {
      reference: toReference(row),
      content: new Uint8Array(row.content!),
    };
  }

  async discardUncommitted(refs: string[]): Promise<void> {
    const unique = [...new Set(refs)];
    if (unique.length === 0) return;
    inTransaction(this.db, () => {
      const hashes = unique.flatMap((ref) => {
        const row = this.db
          .prepare("SELECT content_hash FROM resource_refs WHERE ref = ?")
          .get(ref) as { content_hash: string } | undefined;
        return row ? [row.content_hash] : [];
      });
      const deleteRef = this.db.prepare("DELETE FROM resource_refs WHERE ref = ?");
      for (const ref of unique) deleteRef.run(ref);
      const stillUsed = this.db.prepare(
        "SELECT 1 AS present FROM resource_refs WHERE content_hash = ? LIMIT 1",
      );
      const deleteBlob = this.db.prepare("DELETE FROM resource_blobs WHERE content_hash = ?");
      for (const hash of new Set(hashes)) {
        if (!stillUsed.get(hash)) deleteBlob.run(hash);
      }
    });
  }

  private select(ref: string, withContent: boolean): ResourceRow | undefined {
    const contentColumn = withContent ? ", b.content AS content" : "";
    const row = this.db
      .prepare(
        `SELECT r.ref, r.content_hash, b.size_bytes, r.kind, r.media_type, r.label,
                r.suggested_filename, r.redaction_disposition${contentColumn}
           FROM resource_refs r
           JOIN resource_blobs b ON b.content_hash = r.content_hash
          WHERE r.ref = ?`,
      )
      .get(ref) as unknown as ResourceRow | undefined;
    if (row && withContent) {
      if (row.content === undefined) {
        throw new Error(`RESOURCE_CONTENT_MISSING: ${ref} 有元数据但没有内容字节`);
      }
      const bytes = Buffer.from(row.content);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== row.size_bytes || actualHash !== row.content_hash) {
        throw new Error(
          `RESOURCE_INTEGRITY_MISMATCH: ${ref} 的内容与 size/hash 元数据不一致`,
        );
      }
    }
    return row;
  }
}

function toReference(row: ResourceRow): ResourceReference {
  return {
    ref: row.ref,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    mediaType: row.media_type,
    label: row.label,
    ...(row.suggested_filename === null
      ? {}
      : { suggestedFilename: row.suggested_filename }),
    redactionDisposition: row.redaction_disposition,
  };
}
