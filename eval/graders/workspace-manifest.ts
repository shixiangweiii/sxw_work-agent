/**
 * Workspace manifest —— grader 的 golden truth 来源（E-5）。
 *
 * ── 为什么 Eval 需要它 ─────────────────────────────────────────────────
 *
 * 【定】§24.1：Eval 的成败判定由 `eval/graders/` **独立实现**，
 * 不复用生产 Run 的 outcome 结算路径。这是 §10.4 敢采用
 * 「模型不再请求工具即完成」的前提之一 —— 否则就变成让被测对象给自己打分。
 *
 * 所以 grader 不能读 `RunOutcome`，它只能读**外部世界**：运行前拍一张
 * manifest，运行后再拍一张，两张之间的差就是这次 Run 真正做了什么。
 *
 * 复评报告的原话是「本轮 38/38 是评测器临时执行的只读外部检查，尚未产品化」。
 * 这个文件就是把那件事产品化。
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

export interface FileEntry {
  /** 相对 workspace 根的路径，一律用 "/" 分隔（跨平台可比）。 */
  path: string;
  bytes: number;
  sha256: string;
}

export interface WorkspaceManifest {
  root: string;
  at: string;
  files: FileEntry[];
  /** 空目录也要记 —— 「标出空目录」本身就是归档盘点任务的一条要求。 */
  emptyDirs: string[];
  /**
   * 既不是普通文件也不是目录的条目（符号链接、断链、socket、fifo…）。
   *
   * 单列一栏而不是丢掉：它们是 workspace 的真实内容，Agent 建过一个符号链接
   * 这件事应当出现在快照里。但**不进 `files`**，因为把链接目标的内容算成
   * workspace 的内容，会让 workspace 外的文件混进哈希。
   */
  otherEntries: string[];
}

/**
 * 拍一张 workspace 快照。
 *
 * 【定】按路径排序。manifest 要能逐字节比较，遍历顺序不能泄漏进结果 ——
 * 否则同一个 workspace 在两台机器上会得到两张「不同」的 manifest。
 */
export function snapshotWorkspace(root: string): WorkspaceManifest {
  const files: FileEntry[] = [];
  const emptyDirs: string[] = [];
  const otherEntries: string[] = [];

  const walk = (dir: string): void => {
    const names = readdirSync(dir).sort();
    if (names.length === 0 && dir !== root) {
      emptyDirs.push(rel(root, dir));
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      /**
       * 【定】用 `lstat` 不用 `stat`，即**不跟随符号链接**。
       *
       * 两个后果，冻结夹具都碰不到、真 Agent 一定碰得到（P3-13）：
       *   · `stat` 会走进链接指向的目录 —— workspace **外**的文件被算进哈希，
       *     一张号称「workspace 快照」的表里混进了不属于它的内容；
       *   · 断链的符号链接会让 `stat` 直接抛 ENOENT，**整张快照当场炸掉**，
       *     而半途下载中断留下一个断链是再普通不过的事。
       *
       * 阶段 3 是网页归档：下载、临时文件、符号链接都会真的出现。
       */
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const buf = readFileSync(p);
        files.push({
          path: rel(root, p),
          bytes: buf.byteLength,
          sha256: createHash("sha256").update(buf).digest("hex"),
        });
      } else {
        // 如实记下「这里有个东西，但它不是文件也不是目录」。
        otherEntries.push(`${rel(root, p)}（${describeEntry(st)}）`);
      }
    }
  };

  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  emptyDirs.sort();
  otherEntries.sort();
  return { root, at: new Date().toISOString(), files, emptyDirs, otherEntries };
}

function describeEntry(st: Stats): string {
  if (st.isSymbolicLink()) return "符号链接";
  if (st.isFIFO()) return "FIFO";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice() || st.isCharacterDevice()) return "设备文件";
  return "未知类型";
}

export interface ManifestDiff {
  added: FileEntry[];
  removed: FileEntry[];
  changed: Array<{ path: string; before: FileEntry; after: FileEntry }>;
  unchanged: FileEntry[];
}

/**
 * 两张 manifest 的差。
 *
 * `unchanged` 也要返回 —— 「没有附带破坏」这条判据靠的正是它：
 * 业务源文件必须逐个 sha256 未变，而不是「看起来没动」。
 */
export function diffManifests(before: WorkspaceManifest, after: WorkspaceManifest): ManifestDiff {
  const b = new Map(before.files.map((f) => [f.path, f]));
  const a = new Map(after.files.map((f) => [f.path, f]));

  const added = after.files.filter((f) => !b.has(f.path));
  const removed = before.files.filter((f) => !a.has(f.path));
  const changed: ManifestDiff["changed"] = [];
  const unchanged: FileEntry[] = [];

  for (const [path, beforeEntry] of b) {
    const afterEntry = a.get(path);
    if (!afterEntry) continue;
    if (afterEntry.sha256 === beforeEntry.sha256) unchanged.push(afterEntry);
    else changed.push({ path, before: beforeEntry, after: afterEntry });
  }

  return { added, removed, changed, unchanged };
}

function rel(root: string, p: string): string {
  return relative(root, p).split(sep).join("/");
}
