/** 独立 Resource 归档 grader：只读外部文件、冻结真值、Trace 元数据与 Artifact 来源。 */

import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { check, type Check, type Grader, type GraderContext } from "./index.js";
import {
  RESOURCE_ARCHIVE_BINARY,
  RESOURCE_ARCHIVE_TEXT,
} from "../fixtures/resource-archive.js";

export const resourceArchiveGrader: Grader = {
  id: "synthetic-resource-archive",
  version: "1.0.0",

  run(ctx: GraderContext): Check[] {
    const checks: Check[] = [];
    const expected = new Set([
      ...Object.keys(RESOURCE_ARCHIVE_TEXT).map((name) => `archive/${name}`),
      ...Object.keys(RESOURCE_ARCHIVE_BINARY).map((name) => `archive/assets/${name}`),
    ]);
    const actual = ctx.after.files.map((file) => file.path);

    checks.push(
      check(
        "文件集合精确",
        actual.length === expected.size && actual.every((path) => expected.has(path)),
        `期望 ${expected.size}，实际 ${actual.length}：${actual.join(", ")}`,
      ),
    );

    for (const [name, truth] of Object.entries(RESOURCE_ARCHIVE_TEXT)) {
      const path = `archive/${name}`;
      let actualText = "";
      try {
        actualText = readFileSync(join(ctx.workspaceRoot, path), "utf8");
      } catch {
        // 缺失由逐字判据给出。
      }
      checks.push(
        check(
          `${name} 正文逐字一致`,
          actualText === truth,
          `期望 ${Buffer.byteLength(truth)}B，实际 ${Buffer.byteLength(actualText)}B`,
        ),
      );
      for (const match of actualText.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = normalize(join(dirname(path), match[1]!)).replaceAll("\\", "/");
        checks.push(
          check(`${name} 链接 ${match[1]} 可解析`, expected.has(target), `解析为 ${target}`),
        );
      }
    }

    for (const [name, truth] of Object.entries(RESOURCE_ARCHIVE_BINARY)) {
      const path = `archive/assets/${name}`;
      let bytes = Buffer.alloc(0);
      try {
        bytes = readFileSync(join(ctx.workspaceRoot, path));
      } catch {
        // 缺失由逐字节判据给出。
      }
      checks.push(
        check(
          `${name} 二进制逐字节一致`,
          bytes.equals(Buffer.from(truth)),
          `期望 ${truth.byteLength}B，实际 ${bytes.byteLength}B`,
        ),
      );
    }

    const materialized = (ctx.artifactRecords ?? []).filter(
      (record) => expected.has(record.path ?? "") && record.sourceResourceRef,
    );
    checks.push(
      check(
        "全部交付文件可追溯到 ResourceRef",
        materialized.length === expected.size,
        `${materialized.length}/${expected.size} 带 sourceResourceRef`,
      ),
    );

    const compact = (ctx.traceEvents ?? []).filter(
      (event) => event["type"] === "ContextCompacted",
    );
    checks.push(
      check(
        "执行轨迹包含强制 Compact 与恢复索引",
        compact.some(
          (event) =>
            typeof (event["payload"] as { recoveryIndexRef?: unknown })?.recoveryIndexRef ===
            "string",
        ),
        `ContextCompacted ${compact.length} 次`,
      ),
    );
    return checks;
  },
};
