/**
 * HTML → Markdown 的**结构转换**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】只做结构转换，**不做语义挑选**。这条线是 ADR-0007 的全部内容。
 *
 *   结构转换 = 把 `<h1>` 变成 `#`、`<a href>` 变成 `[]()`、丢掉 `<script>`。
 *              规则只看标签，不看这一块「是不是正文」。Case 无关。
 *   语义挑选 = 判断哪一块是正文、哪一块是导航/页脚/广告（readability 那一类）。
 *              **那是网页归档 Case 的业务语义**，决 1 明确不做。
 *
 * 为什么这条线不是文字游戏：判据是**换一个 Case 结论会不会变**。
 * `<h1>` 该变成 `#` —— 在办公归档、代码读文档、聊天看链接三个场景里都一样。
 * 而「导航栏要不要留」在归档场景是「不要」、在「帮我看这站有哪些板块」
 * 场景里恰恰是「只要那个」。前者是转换，后者是业务判断。
 *
 * 【定】所以本文件里不得出现任何按 `nav` / `footer` / `aside` / class 名
 * 丢弃内容的规则。`verify:tools` 有一条判据钉住这件事：转换后
 * 导航文本必须**仍然在**输出里。它红了说明有人越过了这条线。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 为什么引入 turndown 这个运行期依赖（ADR-0007）────────────────────────
 *
 * 本仓工程基线原本是「运行期依赖只有 `@anthropic-ai/sdk` 和 `dotenv`」。
 * 破这条基线的理由是一次实测：Run `run_9610d44d3a62` 里 40311 字节 HTML
 * 被外置成 blob（approxTokens 16114），模型连调 **3 次 `read_blob`
 * 把它整个搬回上下文**（4363 → 20621 token）—— 外置在这条链路上净收益为零。
 *
 * 自己手写的替代方案要在没有 DOM 的 Node 里解析任意 HTML，
 * 而「差不多能解析」的 HTML 处理正是最容易出静默错误的一类代码。
 * 代价如实记：`turndown` 208K ＋ `@mixmark-io/domino` 8.6M（磁盘）。
 */

import TurndownService from "turndown";

/**
 * 懒构造。
 *
 * 【定】不在模块顶层 `new` —— `tools/common` 被每个验收脚本 import，
 * 而它们里绝大多数一次 HTML 都不转。domino 是 8.6M，
 * 把它的加载挂在 import 时机上等于让每条脚本都白付这笔启动开销。
 */
let service: TurndownService | undefined;

function getService(): TurndownService {
  if (service) return service;
  service = new TurndownService({
    // `# 标题` 而不是 setext 的 `标题\n===` —— 后者在只看片段时认不出层级。
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
  });
  /**
   * 【定】只丢**非内容**元素。
   *
   * 这四个标签里装的是脚本、样式和不可见输入 —— 它们的文本进了上下文
   * 就是纯噪音（一个 `<script>` 里的压缩 JS 能有几万 token，
   * 而模型没有任何办法看出那不是正文）。
   *
   * 注意这里**没有** nav / footer / aside / header —— 那些装的是内容，
   * 只是可能不是**你要的**内容。判断「要不要」是 Case 的事，见文件头。
   */
  service.remove(["script", "style", "noscript", "template"]);
  return service;
}

export interface HtmlToMarkdownResult {
  markdown: string;
  /** 转换前后的字符数，用来在 Trace 上说明这次转换省了多少。 */
  beforeChars: number;
  afterChars: number;
}

/**
 * 转换。**失败时返回 undefined，不抛也不返回半成品。**
 *
 * 【定】转不动就如实说「转不动」，由调用方回退到原文并告诉模型发生了什么。
 * 返回一个转了一半的结果是最坏的选项：模型拿到的是一份**看起来完整、
 * 实际缺了一块**的文档，而它没有任何办法发现。
 */
export function htmlToMarkdown(html: string): HtmlToMarkdownResult | undefined {
  try {
    // 连续三个以上换行压成两个 —— HTML 里的空白节点会转出大量空行，
    // 而空行也是 token。
    const markdown = getService().turndown(html).replace(/\n{3,}/g, "\n\n").trim();
    return {
      markdown,
      beforeChars: html.length,
      /**
       * 【定】取**压缩之后**的长度（2026-08-30 评审）。
       *
       * 原来取的是压缩前的 `markdown.length`，而返回给模型的是压缩后的串 ——
       * `renderText` 把这组数拼进 note 说「转换省了多少」，于是那句话
       * 系统性低估，且与模型手上内容的实际长度对不上。
       * 一个报出来的数字必须描述真正交出去的那个东西。
       */
      afterChars: markdown.length,
    };
  } catch {
    return undefined;
  }
}
