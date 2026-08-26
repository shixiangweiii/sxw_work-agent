/**
 * 归档盘点任务的**冻结夹具**。
 *
 * ── 为什么用代码构造而不是签入一堆文件 ────────────────────────────────
 *
 * 复评报告 §2.2 记了一个具体的教训：唯一不能声称字节级相同的，
 * 是运行前已存在的 `交接清单.md` —— 上一轮基线 2,306 bytes、本轮 2,298，
 * 因为中间夹了一次开发自测。**「同一个夹具」这句话当时其实不完全成立。**
 *
 * 用代码构造就没有这个问题：每次 `materialize()` 出来的 workspace 逐字节相同，
 * 而且这件事本身可被 manifest 验证（见 suite 的 fixtureHash）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ARCHIVE_TASK =
  "我要把 2026Q2归档 这个目录交接给同事。请逐个盘点它下面的每个子目录，" +
  "然后写一份 2026Q2归档/交接清单.md：按子目录分组列出文件名和字节数，" +
  "给出每个子目录的文件数与总大小，明确标出空目录和体积最大的文件，" +
  "并在末尾写一段给接手人的提示。" +
  "最后往 2026Q2归档/归档日志.txt 追加一行，记录本次盘点覆盖了哪些目录、共多少个文件。";

/**
 * 夹具内容。字节数是刻意设计的：
 *   · `设计稿` 里那个 20,000 字节的文件占总量约 99.2%，
 *     让「体积最大的文件」有一个不容含糊的答案；
 *   · `临时` 是空目录，考「明确标出空目录」这条要求。
 */
const FILES: Array<[string, string]> = [
  ["2026Q2归档/会议纪要/0408周会.md", "# 0408 周会\n讨论了 Q2 排期与人力缺口。\n"],
  ["2026Q2归档/会议纪要/0520评审会.md", "# 0520 评审会\n方案二通过，下周启动。\n"],
  ["2026Q2归档/合同/A公司框架协议_已盖章.pdf.txt", "A公司框架协议（已盖章）\n"],
  ["2026Q2归档/合同/B公司采购合同_待签.txt", "B公司采购合同（待签）\n"],
  ["2026Q2归档/合同/C公司补充协议_草稿.txt", "C公司补充协议（草稿，条款三待确认）\n"],
  ["2026Q2归档/设计稿/首页改版_v3.sketch.txt", "SKETCH-BINARY-PLACEHOLDER\n"],
  ["2026Q2归档/归档日志.txt", "[2026-04-01 09:00] 归档目录创建，初始为空。\n"],
];

const EMPTY_DIRS = ["2026Q2归档/临时"];

/** 把夹具铺进一个空目录。同样的输入必然得到逐字节相同的 workspace。 */
export function materialize(root: string): void {
  for (const [path, content] of FILES) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    // 设计稿那个文件补齐到 20,000 字节 —— 让「最大文件」的答案不容含糊。
    const body =
      path.endsWith("首页改版_v3.sketch.txt")
        ? content + "0".repeat(20_000 - Buffer.byteLength(content, "utf8"))
        : content;
    writeFileSync(full, body, "utf8");
  }
  for (const d of EMPTY_DIRS) mkdirSync(join(root, d), { recursive: true });
}
