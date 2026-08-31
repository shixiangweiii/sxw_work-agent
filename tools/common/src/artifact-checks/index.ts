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
  ArtifactContent,
  ArtifactRecord,
} from "@workagent/harness-runtime";

/**
 * 扩展名 → 产物 kind。**唯一一份**（ADR-0010）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它住在检查器旁边，因为 kind 的**全部意义**就是决定跑哪些检查器。
 *
 * `write_file` 原本有一个私有的 `kindOf`，`run_shell` 需要同一件事。
 * 抄第二份的后果很具体：两个工具对同一个扩展名给出不同 kind → 跑不同检查器
 * → 而两边都是绿的。读黑名单已经栽过一次「唯一事实源在两个实现里各说各话」
 * （沙箱那侧实现的正是 read-guard 明确否决过的语义）。
 *
 * 【定】未知扩展名默认 `text`。二进制落进 text 会在编码检查上**翻红** ——
 * 失败方向是看得见的，比默认 `binary`（什么都不检查、静默通过）好。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 二进制扩展名 → 文件头魔数（**任一命中即算通过**，`at` 是字节偏移）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】`binary` 这个 kind 由**这张表的键**推出，不再单独维护一张扩展名表。
 *
 * 这条约束是二次评审（zcode F1）抓出来的一次**回归**逼出来的，形态值得记：
 * ADR-0010 那一批新增了一张 `BINARY_EXTENSIONS`，把 jpg/png/pdf 路由到
 * `kind:"binary"` —— 而检查器对 binary **一项结构检查都没有**，只跑磁盘 hash。
 * 于是同一个坏文件的处境**比改之前更差**：
 *
 *     改之前：`.jpg` 落 text → 编码检查 → **翻红**（看得见）
 *     改之后：`.jpg` 落 binary → 只有 hash → **静默通过** ＋ 进 deliveredArtifactIds
 *
 * 而当时那段注释亲手写着「默认 binary（什么都不检查、静默通过）更糟」——
 * **那句话恰好论证了它自己为已知扩展名移除掉的性质。**
 * 原任务（`curl` 无 `--fail` 把 404 页存成 `image_NN.jpg`）正好落在这个洞里。
 *
 * 【定】所以两者必须绑死：**没有魔数的扩展名不算 binary**，它落回 text 并在
 * 编码检查上翻红。加一个扩展名却给不出魔数时，你得到的是一个看得见的失败，
 * 而不是一个什么都不查的 kind。
 *
 * 【定】魔数只证明「文件头像这个类型」，**不证明它能解码**。
 * 判据文案与工具 description 都必须照这个强度写 —— 同一批里
 * 「zip 能不能解开」那句过度承诺就是这么来的（二次评审 codex P1-5）。
 * ══════════════════════════════════════════════════════════════════════
 */
interface MagicRule {
  /** 期望的字节序列。字符串按 latin1 取字节。 */
  bytes: string | number[];
  /** 偏移，默认 0。 */
  at?: number;
}

const BINARY_MAGIC: Record<string, MagicRule[]> = {
  png: [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  jpg: [{ bytes: [0xff, 0xd8, 0xff] }],
  jpeg: [{ bytes: [0xff, 0xd8, 0xff] }],
  gif: [{ bytes: "GIF87a" }, { bytes: "GIF89a" }],
  // RIFF 容器：头 4 字节相同，靠偏移 8 的 form type 区分
  webp: [{ bytes: "WEBP", at: 8 }],
  wav: [{ bytes: "WAVE", at: 8 }],
  avi: [{ bytes: "AVI ", at: 8 }],
  bmp: [{ bytes: "BM" }],
  ico: [{ bytes: [0x00, 0x00, 0x01, 0x00] }],
  tiff: [{ bytes: [0x49, 0x49, 0x2a, 0x00] }, { bytes: [0x4d, 0x4d, 0x00, 0x2a] }],
  pdf: [{ bytes: "%PDF-" }],
  gz: [{ bytes: [0x1f, 0x8b] }],
  tgz: [{ bytes: [0x1f, 0x8b] }],
  bz2: [{ bytes: "BZh" }],
  xz: [{ bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }],
  "7z": [{ bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }],
  rar: [{ bytes: "Rar!" }],
  // POSIX tar 的 magic 在偏移 257，前面是文件名 —— 这是表里唯一的深偏移项
  tar: [{ bytes: "ustar", at: 257 }],
  mp4: [{ bytes: "ftyp", at: 4 }],
  mov: [{ bytes: "ftyp", at: 4 }, { bytes: "moov", at: 4 }, { bytes: "mdat", at: 4 }],
  webm: [{ bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
  mp3: [
    { bytes: "ID3" },
    // 无 ID3 标签时是 MPEG frame sync：11 个 1 bit，第二字节高位有多种合法组合
    { bytes: [0xff, 0xfb] }, { bytes: [0xff, 0xf3] }, { bytes: [0xff, 0xf2] }, { bytes: [0xff, 0xfa] },
  ],
  woff: [{ bytes: "wOFF" }],
  woff2: [{ bytes: "wOF2" }],
  ttf: [{ bytes: [0x00, 0x01, 0x00, 0x00] }, { bytes: "true" }],
  otf: [{ bytes: "OTTO" }],
  wasm: [{ bytes: [0x00, 0x61, 0x73, 0x6d] }],
  sqlite: [{ bytes: "SQLite format 3 " }],
  db: [{ bytes: "SQLite format 3 " }],
  // 可执行 / 动态库：三个平台各自的头
  so: [{ bytes: [0x7f, 0x45, 0x4c, 0x46] }],
  exe: [{ bytes: "MZ" }],
  dll: [{ bytes: "MZ" }],
  dylib: [
    { bytes: [0xfe, 0xed, 0xfa, 0xce] }, { bytes: [0xce, 0xfa, 0xed, 0xfe] },
    { bytes: [0xfe, 0xed, 0xfa, 0xcf] }, { bytes: [0xcf, 0xfa, 0xed, 0xfe] },
    { bytes: [0xca, 0xfe, 0xba, 0xbe] },
  ],
};

export function artifactKindOf(path: string): string {
  const lower = path.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (ext === "json") return "json";
  if (ext === "zip") return "zip";
  // 【定】有魔数才算 binary。见上面那段 —— 这两件事绑死是这次回归的处置本身。
  if (Object.prototype.hasOwnProperty.call(BINARY_MAGIC, ext)) return "binary";
  return "text";
}

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

  async check(record: ArtifactRecord, content: ArtifactContent): Promise<ArtifactCheckOutcome> {
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
      /**
       * 【定】字节要用**非 fatal** 的解码器转成字符串再判。
       *
       * 一个声明成 text 的产物如果实际是二进制，非 fatal 解码会产出 U+FFFD，
       * 正好被 `invalidTextReason` 抓住 —— 这是我们要的结果。
       * 换成 `fatal: true` 会在这里抛异常，那条路径上产物既没通过也没失败，
       * 而「没验过」在结算时会表现成「没问题」。
       */
      const bad = invalidTextReason(asText(content));
      if (bad) failures.push(bad);
    }

    // ── ③ JSON 可解析
    if (record.kind === "json") {
      checksRun.push("json-parses");
      try {
        JSON.parse(asText(content));
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

    /**
     * ── ⑤ 二进制文件头与扩展名相符（二次评审 zcode F1）────────────────────
     *
     * 【定】没有这一项时 `kind:"binary"` **一项结构检查都不跑**，
     * 只剩磁盘 hash —— 而 hash 只证明「登记的字节 == 磁盘字节」，
     * 对「它是不是一张图」一无所知。原任务里那条
     * `curl -s -L`（无 `--fail`）把 404 页存成 `image_NN.jpg` 的失败形态，
     * 正好从这里静默通过并进 `deliveredArtifactIds`。
     */
    if (record.kind === "binary") {
      checksRun.push("binary-magic");
      const bad = magicReason(record.path ?? record.logicalId, content);
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
/**
 * 内容 → 可读的文本。
 *
 * 【定】非 fatal 解码：无效字节变 U+FFFD，正好被 `invalidTextReason` 抓住。
 * 见 check() 里 ② 那段 —— fatal 会抛，而抛出去的产物「既没通过也没失败」。
 */
function asText(content: ArtifactContent): string {
  return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}

/**
 * 文件头是不是这个扩展名该有的样子。
 *
 * 【定】它回答的是「像不像」，**不是「能不能解码」**。
 * 判据文案要照这个强度写 —— 同一批里「zip 能不能解开」那句过度承诺
 * （检查器只判 `PK` ＋ EOCD）就是把「像」说成「能」造出来的。
 *
 * 【定】表里没有的扩展名走不到这里：`artifactKindOf` 只把**有魔数的**
 * 扩展名判成 binary，其余落 text 并在编码检查上翻红。
 */
function magicReason(path: string, content: ArtifactContent): string | undefined {
  const lower = path.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const rules = BINARY_MAGIC[ext];
  // 理论上到不了（kind 就是由这张表推的），留着是为了这条判定自洽而不是靠调用顺序。
  if (!rules) return undefined;

  const buf = typeof content === "string" ? Buffer.from(content, "binary") : Buffer.from(content);
  for (const rule of rules) {
    const at = rule.at ?? 0;
    const want = typeof rule.bytes === "string" ? Buffer.from(rule.bytes, "latin1") : Buffer.from(rule.bytes);
    if (buf.byteLength < at + want.byteLength) continue;
    if (buf.subarray(at, at + want.byteLength).equals(want)) return undefined;
  }

  /**
   * 【定】诊断里要给出**实际看到的头**。
   *
   * 「魔数不对」这句话本身修不了任何东西；而「开头是 `<!DOCTYPE html`」
   * 会立刻告诉人这是一个错误页被存成了图片 —— 那正是本条要抓的形态。
   */
  const head = buf.subarray(0, 16);
  const printable = head.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
  return (
    `文件头与扩展名 .${ext} 不符：开头 16 字节是 ${head.toString("hex")}（"${printable}"）。` +
    `常见成因是下载失败时把错误页 / 空响应存成了目标文件（curl 少了 --fail）`
  );
}

function zipStructureReason(content: ArtifactContent): string | undefined {
  /**
   * 【定】字节这一档必须原样用，不能再经字符串（ADR-0010）。
   *
   * 字符串那一档保留 `"binary"`（latin1）是为了兼容既有调用：
   * 它是唯一能让一个字符串按字节往返的编码。而真正的二进制现在走
   * `Uint8Array`，一个字节都不会变。
   */
  const buf = typeof content === "string" ? Buffer.from(content, "binary") : Buffer.from(content);
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
