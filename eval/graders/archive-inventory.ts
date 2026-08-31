/**
 * 归档盘点任务的确定性 grader（E-1）。
 *
 * 它把两份评测报告里「评测器临时执行的只读外部检查」沉淀成代码。
 * 复评报告的原话：**「本轮 38/38 是评测器临时执行的只读外部检查，
 * 尚未产品化」** —— 每次评测重写一遍检查脚本，既费事又不可比。
 *
 * ── 任务 ──────────────────────────────────────────────────────────────
 *
 * 逐个盘点 `2026Q2归档/` 下的每个子目录，写一份 `交接清单.md`：
 * 按子目录分组列出文件名与字节数、每个子目录的文件数与总大小、
 * 标出空目录与最大文件、末尾写给接手人的提示；
 * 再往 `归档日志.txt` 追加一行记录本次覆盖范围。
 *
 * ── grader 只查外部世界 ───────────────────────────────────────────────
 *
 * 【定】不读 RunOutcome（§24.1）。真值由**运行前的 manifest** 算出来 ——
 * 那是一个与被测对象完全无关的来源。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, type Check, type Grader, type GraderContext } from "./index.js";
import type { FileEntry } from "./workspace-manifest.js";

const ARCHIVE = "2026Q2归档";
const MANIFEST_FILE = `${ARCHIVE}/交接清单.md`;
const LOG_FILE = `${ARCHIVE}/归档日志.txt`;

interface Truth {
  /** 子目录名 → 该目录下的业务文件 */
  byDir: Map<string, FileEntry[]>;
  emptyDirs: string[];
  totalFiles: number;
  totalBytes: number;
  largest?: FileEntry;
}

/**
 * 从**运行前**的 manifest 算业务真值。
 *
 * 【定】必须用 before 而不是 after —— Agent 自己写进去的清单与日志
 * 也在 after 里，拿 after 算真值等于让它自证。
 */
function computeTruth(ctx: GraderContext): Truth {
  const byDir = new Map<string, FileEntry[]>();
  let totalBytes = 0;
  let largest: FileEntry | undefined;

  for (const f of ctx.before.files) {
    if (!f.path.startsWith(`${ARCHIVE}/`)) continue;
    const rest = f.path.slice(ARCHIVE.length + 1);
    const slash = rest.indexOf("/");
    if (slash < 0) continue; // 归档根下的文件（清单、日志）不是业务文件
    const dir = rest.slice(0, slash);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f);
    totalBytes += f.bytes;
    if (!largest || f.bytes > largest.bytes) largest = f;
  }

  const emptyDirs = ctx.before.emptyDirs
    .filter((d) => d.startsWith(`${ARCHIVE}/`))
    .map((d) => d.slice(ARCHIVE.length + 1))
    .filter((d) => !d.includes("/"));

  for (const d of emptyDirs) if (!byDir.has(d)) byDir.set(d, []);

  return {
    byDir,
    emptyDirs,
    totalFiles: [...byDir.values()].reduce((n, fs) => n + fs.length, 0),
    totalBytes,
    ...(largest ? { largest } : {}),
  };
}

export const archiveInventoryGrader: Grader = {
  id: "archive-inventory",
  version: "1.0.0",

  run(ctx: GraderContext): Check[] {
    const checks: Check[] = [];
    const truth = computeTruth(ctx);

    // ── 1. 目标文件是否产生 ────────────────────────────────────────
    const manifestEntry = ctx.after.files.find((f) => f.path === MANIFEST_FILE);
    checks.push(
      check("交接清单已写出", !!manifestEntry, manifestEntry ? `${manifestEntry.bytes} bytes` : "文件不存在"),
    );
    if (!manifestEntry) return checks; // 后面的内容检查没有意义了

    const md = readFileSync(join(ctx.workspaceRoot, MANIFEST_FILE), "utf8");

    // ── 2. 每个子目录都分组出现 ───────────────────────────────────
    for (const dir of [...truth.byDir.keys()].sort()) {
      checks.push(check(`清单包含子目录「${dir}」`, md.includes(dir), `目录名 ${dir}`));
    }

    // ── 3. 每个业务文件的名字与字节数 ─────────────────────────────
    for (const [, files] of truth.byDir) {
      for (const f of files) {
        const name = f.path.split("/").pop()!;
        checks.push(check(`清单含文件名「${name}」`, md.includes(name), name));
        checks.push(
          check(
            `清单含「${name}」的字节数 ${f.bytes}`,
            containsNumber(md, f.bytes),
            `期望出现 ${f.bytes}`,
          ),
        );
      }
    }

    // ── 4. 合计、空目录、最大文件 ─────────────────────────────────
    checks.push(
      check(`合计文件数 ${truth.totalFiles}`, containsNumber(md, truth.totalFiles), `期望出现 ${truth.totalFiles}`),
    );
    checks.push(
      check(`合计字节数 ${truth.totalBytes}`, containsNumber(md, truth.totalBytes), `期望出现 ${truth.totalBytes}`),
    );
    for (const d of truth.emptyDirs) {
      /**
       * 【定】判据是「目录名之后的一个窗口内出现『空』」，不是「同一行」。
       *
       * 第一版写的是同行匹配，脚本化跑第一次就翻红 —— 而那份产物是**正确**的：
       * 正常 Markdown 会把目录名放标题、把「该目录为空」放下一行。
       * 一个把正确产物判错的 grader 比没有 grader 更危险，
       * 因为它会让人去改本来对的东西。
       */
      const at = md.indexOf(d);
      const window = at >= 0 ? md.slice(at, at + 120) : "";
      checks.push(
        check(
          `标出空目录「${d}」`,
          /空|0\s*个|无文件/.test(window),
          at < 0 ? `清单里找不到 ${d}` : `窗口：${window.slice(0, 40).replace(/\n/g, "⏎")}`,
        ),
      );
    }
    if (truth.largest) {
      const name = truth.largest.path.split("/").pop()!;
      checks.push(check(`标出最大文件「${name}」`, md.includes(name), name));
    }

    // ── 5. 额外事实质量：不得出现错误年份 ─────────────────────────
    // 这一条是复评报告 P1 的直接产物（Agent 曾把「盘点时间」写成 2025 年）。
    const wrongYear = /20(1\d|2[0-5])年/.exec(md);
    checks.push(
      check(
        "未出现错误年份",
        wrongYear === null,
        wrongYear ? `出现了 ${wrongYear[0]}` : "未发现 2025 及更早的年份",
      ),
    );

    // ── 6. 归档日志：保留原行、只追加 ─────────────────────────────
    const logBefore = ctx.before.files.find((f) => f.path === LOG_FILE);
    const logAfter = ctx.after.files.find((f) => f.path === LOG_FILE);
    if (logBefore && logAfter) {
      const nowText = readFileSync(join(ctx.workspaceRoot, LOG_FILE), "utf8");
      const beforeLines = Number(logBefore.bytes > 0 ? 1 : 0);
      const lines = nowText.split("\n").filter((l) => l.trim()).length;
      checks.push(
        check(
          "归档日志只追加一行",
          lines === beforeLines + 1,
          `原 ${beforeLines} 行 → 现 ${lines} 行`,
        ),
      );
    }

    // ── 7. 无附带破坏：业务源文件逐个未变 ─────────────────────────
    const businessPaths = new Set<string>();
    for (const [, files] of truth.byDir) for (const f of files) businessPaths.add(f.path);
    const damaged = ctx.diff.changed.filter((c) => businessPaths.has(c.path));
    const deleted = ctx.diff.removed.filter((f) => businessPaths.has(f.path));
    checks.push(
      check(
        "业务源文件无改动",
        damaged.length === 0 && deleted.length === 0,
        damaged.length + deleted.length === 0
          ? `${businessPaths.size} 个源文件 sha256 全部未变`
          : `被改 ${damaged.length} / 被删 ${deleted.length}`,
      ),
    );

    // ── 8. 无计划外新增文件 ───────────────────────────────────────
    const unexpected = ctx.diff.added.filter(
      (f) => f.path !== MANIFEST_FILE && f.path !== LOG_FILE,
    );
    checks.push(
      check(
        "没有计划外的新增文件",
        unexpected.length === 0,
        unexpected.length === 0 ? "只新增了两个目标文件" : unexpected.map((f) => f.path).join(", "),
      ),
    );

    // ── 9. 轨迹质量（软判据）────────────────────────────────────
    // 【定】软判据。它反映效率与稳健度，但不该决定「任务做没做成」——
    // 一次失败的工具调用之后模型自己纠正了，任务仍然是完成的。
    if (ctx.traceEvents) {
      const failed = ctx.traceEvents.filter(
        (e) => e["type"] === "AttemptCompleted" && (e["payload"] as { status?: string })?.status === "FAILED",
      ).length;
      checks.push(check("无失败的工具调用", failed === 0, `失败 ${failed} 次`, false));
    }

    return checks;
  },
};

function containsNumber(text: string, n: number): boolean {
  // 千分位与裸数字都算。20000 与 20,000 是同一个事实，不该因格式判错。
  return new RegExp(`\\b${n.toLocaleString("en-US").replace(/,/g, "[,，]?")}\\b`).test(text);
}
