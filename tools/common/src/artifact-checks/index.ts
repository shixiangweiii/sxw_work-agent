/**
 * Artifact 级检查器（阶段 3 S8，§10.4 第二层）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】两层 Verification 不得互相替代（V05 §10.4）。
 *
 * | 层            | 问题                       | 触发点               |
 * |---------------|----------------------------|----------------------|
 * | Action 级     | 这一步的副作用是否达成      | Attempt 完成后        |
 * | **Artifact 级** | **这个产物本身是否完整合法** | **ArtifactRegistered** |
 *
 * Action 级验证的参照物是**模型自己的意图**（`write_file` 验的是
 * 「磁盘内容 == 计划内容」），所以它对「模型的意图本身不全」在结构上是盲的
 * —— 不是恰好没查到。写一个坏掉的 JSON，Action 级验证会**通过**：
 * 磁盘内容确实等于计划内容，只是那份计划本身就是坏的。
 *
 * ── 【定】检查器必须有判别力 ──────────────────────────────────────────
 *
 * 首批只做四项：JSON 可解析、ZIP 可解开、文本编码合法、hash 与登记一致。
 *
 * **「Markdown 可解析」不做。** 任何文本都是合法 Markdown ——
 * 它是一个永远绿灯的闸门，正是本项目反复警告的那种形态。要做就得给出
 * 可失败的结构断言（标题层级存在、正文非空），首批不值得。
 *
 * ── hash 这一项曾经是第二个「永远绿灯的闸门」（阶段 3 收口批修）──────────
 *
 * 原版拿 `check(record, content)` 收到的 `content` 重算 sha256 去比
 * `record.contentHash` —— 而那个 hash 正是 `register()` 用**同一份内存
 * 字符串**算出来的（`artifact-store.ts` 与这里都是 `sha256(s, "utf8")`）。
 * 两边同源，**必然相等**：失败分支不可达，而失败文案却写着
 * 「产物在登记之后被改过」，那件事在代码里根本没有对应的读取动作。
 *
 * 【定】所以它现在比的是**磁盘上的那一份**：`record.path` 存在时读回文件
 * 算 hash，与登记值对照。这样它才真的在回答那句文案 ——
 * 「工具声明的内容，是不是它真正写下去的那份」。
 *
 * 【定】`record.path` 缺席时**这一项不进 `checksRun`**。
 * `ArtifactCheckOutcome.checksRun` 的注释已经定了「空数组 ≠ 全部通过」——
 * 把一项没跑的检查列进去，detail 会报「N 项检查通过」，
 * 而那正是这条闸门此前唯一的产出。
 *
 * ── 【定】不得写任何任务级规则（不得绕过 #8）──────────────────────────
 *
 * 产物**类型**的静态结构约束属通用，进这里；**任务业务规则属 Case**。
 * 本阶段没有 Case 包可写，因此一条都不写。
 *
 * 反面教材是现成的：回归评测的 grader 硬查一个 `20223` 的字节合计，
 * 而任务原文里从来没要求过全局合计 —— 那次「模型遗漏」实际是 grader 误判。
 * 把逐 Run 变化的用户要求写死成硬门槛，就是这么发生的。
 * ══════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ArtifactCheckOutcome,
  ArtifactCheckerPort,
  ArtifactRecord,
} from "@workagent/harness-runtime";

export interface CommonArtifactCheckerOptions {
  /**
   * 产物落在哪个 workspace 下。
   *
   * hash 项要拿 `record.path` 去读**磁盘上的那一份**，而 `ArtifactRecord`
   * 里的 path 是相对 workspace 根的。由 Composition Root 注入 ——
   * 检查器不该自己去猜「工作目录在哪」。
   */
  workspaceRoot: string;
}

export class CommonArtifactChecker implements ArtifactCheckerPort {
  constructor(private readonly opts: CommonArtifactCheckerOptions) {}

  async check(record: ArtifactRecord, content: string): Promise<ArtifactCheckOutcome> {
    const checksRun: string[] = [];
    const failures: string[] = [];

    // ── ① 登记的 hash 与**磁盘上那一份**一致（见文件头）
    if (record.path !== undefined) {
      checksRun.push("hash-matches-registration");
      const bad = await diskHashReason(
        resolve(this.opts.workspaceRoot, record.path),
        record.contentHash,
      );
      if (bad) failures.push(bad);
    }

    // ── ② 文本编码合法（对所有会被当文本读的 kind 都跑）
    if (record.kind !== "zip" && record.kind !== "binary") {
      checksRun.push("text-encoding-valid");
      const bad = invalidTextReason(content);
      if (bad) failures.push(bad);
    }

    // ── ③ JSON 可解析
    if (record.kind === "json") {
      checksRun.push("json-parses");
      try {
        JSON.parse(content);
      } catch (err) {
        failures.push(`JSON 解析失败：${String((err as Error).message).slice(0, 160)}`);
      }
    }

    // ── ④ ZIP 可解开
    if (record.kind === "zip") {
      checksRun.push("zip-opens");
      const bad = zipStructureReason(content);
      if (bad) failures.push(bad);
    }

    return {
      ok: failures.length === 0,
      checksRun,
      detail:
        failures.length === 0
          ? `${checksRun.length} 项检查通过：${checksRun.join(", ")}`
          : failures.join("；"),
    };
  }
}

/**
 * 磁盘上那份产物的 hash 与登记值是否一致。
 *
 * 【定】读不到与读不了要分开说。
 *   · ENOENT —— 登记了一份**并不存在**的东西（工具报了成功但什么都没写）；
 *   · 其余 errno —— 我们无法确认，不能默认它是好的。
 * 两种都算检查失败，但文案不同：给出的诊断决定了下一步该查哪里。
 */
async function diskHashReason(target: string, registered: string): Promise<string | undefined> {
  let buf: Buffer;
  try {
    buf = await readFile(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "未知错误";
    return code === "ENOENT"
      ? `登记的产物在盘上不存在（${target}）—— 登记了一份并不存在的东西`
      : `登记的产物读不了（${code}）—— 无法确认盘上那份就是登记的那份`;
  }
  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual === registered) return undefined;
  return (
    `磁盘内容的 hash 与登记不一致（登记 ${registered.slice(0, 12)}…，` +
    `磁盘 ${actual.slice(0, 12)}…）—— 产物在登记之后被改过，` +
    `或工具声明的内容不是它真正写下去的那份`
  );
}

/**
 * 文本编码是否合法。
 *
 * 判据是 U+FFFD（替换符）与 NUL：`Buffer.toString("utf8")` 对非法字节
 * 不会抛，只会静默产出替换符 —— 于是一份编码坏掉的产物在磁盘上看起来
 * 「有内容」，读出来是一堆「�」，而没有任何一层会喊出来。
 */
function invalidTextReason(content: string): string | undefined {
  const REPLACEMENT = String.fromCharCode(0xfffd);
  const NUL = String.fromCharCode(0);
  if (content.includes(NUL)) {
    return "文本里含 NUL 字节 —— 这不是合法的文本产物（多半是二进制被当成文本写了）";
  }
  const n = content.split(REPLACEMENT).length - 1;
  if (n > 0) {
    return `文本里有 ${n} 个 U+FFFD 替换符 —— 说明写入时的编码就是坏的，读出来是乱码`;
  }
  return undefined;
}

/**
 * ZIP 结构是否可解开。
 *
 * 【定】只做**结构**判定，不真的解压。
 * 判 local file header 魔数 `PK\x03\x04` 与 End of Central Directory
 * `PK\x05\x06` —— 一个被截断的 ZIP（下载中断、写到一半崩了）恰好会缺
 * 后者，而那是最常见的坏 ZIP 形态。
 *
 * 不引入解压库是刻意的：运行期依赖只有两个（§工程基线），
 * 为一条首批检查加一个依赖不划算，而魔数判定已经能抓住主要失败形态。
 */
function zipStructureReason(content: string): string | undefined {
  const buf = Buffer.from(content, "binary");
  if (buf.byteLength < 22) return "ZIP 太短（不足 22 字节），不可能是一个完整归档";
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    return "ZIP 缺少 PK 魔数 —— 这不是一个 ZIP 文件";
  }
  // End of Central Directory 在文件尾部（可能后面跟着注释，所以往回找）。
  const tail = buf.subarray(Math.max(0, buf.byteLength - 66_000));
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) {
    return "ZIP 缺少 End of Central Directory —— 归档被截断了（下载中断或写到一半失败）";
  }
  return undefined;
}
