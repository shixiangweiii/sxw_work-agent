/**
 * 边界 grep 的**唯一**一张表。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它住在单独的文件里，因为从阶段 4 起有两个消费者：
 *
 *   · `verify:tools` A 段 —— 机械跑完整张表；
 *   · `verify:ui`   A 段 —— 对阶段 4 新增的几条各做一次**判别力实测**
 *                            （往被守的目录里注入一行违规，必须当场翻红）。
 *
 * 抄成两份的后果是「加了一条规则、只有一个脚本认识它」，而两个脚本都是绿的。
 * 这与 `parseEndpointArg` 搬进 compose 的理由是同一条。
 *
 * 【定】打印的条数一律由 `BOUNDARIES.length` 推出，**不写死**。
 * 这个表在阶段 3.5 之前就已经是「7 个条目被称作六条」——
 * 写死的数字不会随表增长，而一条「说自己有 6 条、实际扫了 7 条」的输出，
 * 会让人以为新加的那条没生效。
 * ══════════════════════════════════════════════════════════════════════
 */

import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../compose.js";

export interface Boundary {
  id: string;
  desc: string;
  pattern: string;
  paths: string[];
  /** 允许命中的路径前缀。空 = 一条都不许命中。 */
  allowed: string[];
  /**
   * 允许命中的**具体行内容**（精确子串）。
   *
   * 【定】它比 `allowed` 窄一档，是刻意的：`allowed` 会豁免**整个文件**，
   * 而有些文件只有一行是合法命中（比如包自己的 `name` 声明）。
   * 用路径豁免会顺带放过同一个文件里真正的违规 ——
   * 那正是「一个给自己发豁免的检查器」的雏形。
   */
  exceptLines?: string[];
}

/**
 * 把模式拼出来，**不让它以字面量形式出现在本文件里**。
 *
 * 边界 1 与边界 5 的扫描范围包含 `apps/`，也就是包含本文件 —— 直接写字面量
 * 的话，检查器会把自己的模式表报成违规（第一次跑就是这样：3 处「违规」
 * 全在 BOUNDARIES 里）。
 *
 * 【定】处置是拆字符串，**不是**把本文件加进 allowed。
 * 加白名单会在这个文件上开一个永久的洞：以后真有人在这里 import 了 Provider SDK
 * 或 `node:sqlite`，整张表一条都不会响 —— 而这个文件正是那张表的家。
 * 一个给自己发豁免的检查器，和一个永远返回空的检查器是同一类东西。
 */
export const lit = (...parts: string[]): string => parts.join("");

/**
 * 边界表：**编号到 11，条目 12 条** —— 6b 按惯例算作第 6 条的同族。
 *
 * 阶段 3 把第 4 条推广、新增第 6 / 6b 条；阶段 3.5 新增第 7 条；
 * 阶段 4 新增第 8 / 9 / 10 条（Layer 1 与 Layer 2 的边界）；
 * 阶段 4 收口批新增第 11 条（内联 style 被自己的 CSP 丢弃）。
 *
 * 【定】条数一律由 `BOUNDARIES.length` 与最后一个 id 推出，别在散文里写死 ——
 * 这段说明本身就被改错过一次。
 */
export const BOUNDARIES: Boundary[] = [
  {
    id: "1",
    desc: "Provider SDK 只在形状适配器里",
    pattern: lit("@anthropic", "-ai/", "sdk"),
    paths: ["packages", "apps", "cases", "tools"],
    allowed: [],
  },
  {
    id: "2",
    desc: "端点名不进 Runtime 代码",
    pattern: "dashscope",
    paths: ["packages/harness-runtime/src"],
    allowed: [],
  },
  {
    id: "3",
    desc: "主循环不读端点声明",
    pattern: "profile\\.",
    paths: ["packages/harness-runtime/src/loop/run-loop.ts"],
    allowed: [],
  },
  {
    id: "4",
    desc: "Runtime Core 不 import 任何工具实现",
    pattern: "micro-cases|tools-common",
    paths: ["packages/harness-runtime/src"],
    allowed: [],
  },
  {
    id: "5",
    desc: lit("node", ":sqlite") + " 只在 packages/store-sqlite/",
    pattern: lit("node", ":sqlite"),
    paths: ["packages", "apps", "cases", "adapters", "tools"],
    allowed: ["packages/store-sqlite/"],
  },
  {
    id: "6",
    desc: "阶段 3：Runtime 与适配器不得依赖工具包",
    pattern: "@workagent/tools-|tools/common",
    paths: ["packages", "adapters"],
    allowed: [],
  },
  {
    id: "6b",
    desc: "阶段 3：通用工具不得依赖任何 Case 包",
    pattern: "@workagent/micro-cases|cases/",
    paths: ["tools"],
    allowed: [],
  },
  {
    /**
     * 阶段 3.5。它守的是「沙箱是工具域知识，不是 Runtime 知识」。
     *
     * 这条与第 4 / 6 条同源，但 grep 形态不同：`run_shell` 的诱惑不是
     * import 工具包，而是**把命令解析和沙箱 profile 生成搬进
     * `packages/harness-runtime/src/action/`** —— 那里本来就叫
     * effect-resolver，看起来天经地义。搬进去之后 Runtime 就认识 shell 了，
     * 而第 4 / 6 条一条都抓不到（它没有 import 任何工具包）。
     */
    id: "7",
    desc: "阶段 3.5：沙箱与命令解析不得进 Runtime / 适配器",
    pattern: "sandbox-exec|analyzeCommand|sbpl",
    paths: ["packages", "adapters"],
    allowed: [],
  },
  {
    /**
     * ★阶段 4。**UI 不得依赖任何后端模块。**
     *
     * §5.5 保留的那条约束是「UI 通过 RunEvent 流驱动，不直接读 Runtime
     * 内部状态」—— 它现在是**物理成立**的：`public/` 里是浏览器直接跑的
     * 静态资源，import 不到任何 TS 模块。
     *
     * 【定】那这条 grep 是不是恒真式？**不是。** 它成立靠的是「UI 没有构建
     * 步骤」这个事实，而这个事实随时会被一次「给界面加个打包器」的改动破坏 ——
     * 那一刻这条 grep 是唯一会说话的东西。恒真式的判据是「无论代码怎么改都为真」，
     * 这条不是：改成有构建步骤、再 import 一个 Runtime 类型，它立刻红。
     *
     * ── 扫描范围：**整个 `apps/workagent-ui/`**，不只是 `public/` ──────────
     *
     * 评审（codex 5.2）指出的：只扫 `public/` 的话，ADR-0009 那句
     * 「加了构建步骤再 import 一个 Runtime 类型，它立刻红」**不成立** ——
     * 引入打包器之后源码会在 `src/`（不扫），产物落进 `public/` 时包名
     * 早被打包器消解掉了。也就是说那条 grep 证明的是「往 public 放文件会红」，
     * 而不是 ADR 声称的那件事。这是我自己的过度声明。
     *
     * 放宽到整个 app 目录之后它才对得上：`src/` 里的 import、以及
     * `package.json` 里新增的前端依赖，都会被扫到。
     * 唯一要放行的是本包自己的 `name: "@workagent/ui"` 那一行。
     */
    id: "8",
    desc: "★阶段 4：UI 不得依赖任何后端模块",
    pattern: "@workagent/",
    paths: ["apps/workagent-ui"],
    allowed: [],
    // 【定】只放行本包自己的包名声明**那一行**，不是整个 package.json ——
    // 往同一个文件里加一个依赖仍然要翻红（用 allowed 就做不到这件事）。
    exceptLines: ['"name": "@workagent/ui"'],
  },
  {
    /**
     * ★阶段 4。**Layer 2 不得推进执行语义**（§6.1【定】、§5.2【定】）。
     *
     * 要防的具体形态：界面上看到一个 Run 状态是 RUNNING 而进程里没有循环在跑
     * （上次崩了），最自然的「修复」是在服务里补一句
     * `ports.runs.setStatus(runId, "FAILED")`。那一行会让 Layer 2 成为
     * **第二个状态推进者**，而 §23.1 的裁决规则（执行语义以 Runtime 事件为准）
     * 从此不成立 —— 且盘上看不出来，因为界面看起来更「对」了。
     *
     * 模式里的每一个都是一次具体的越界：自己写状态、自己起循环、自己执行批、
     * 自己结算 outcome、自己编帧、自己判未配对 tool_use（§5.2 点名的那一条）。
     */
    id: "9",
    desc: "★阶段 4：Layer 2 不得推进执行语义",
    pattern:
      "\\.setStatus\\(|runLoop\\(|executeBatch\\(|settleOutcome\\(|settleWallOutcome\\(|compileFrame\\(|findUnpairedToolUses\\(",
    paths: ["apps/workagent-service/src"],
    allowed: [],
  },
  {
    /**
     * ★阶段 4。**模型产出不得走 innerHTML。**
     *
     * 界面上几乎所有文本都来自模型：工具入参、命令原文、总结、接管说明。
     * 审批面板是 EXECUTE 唯一的人工边界，而一条命令完全可以在自己的
     * description 里塞一段 HTML 把上面几行盖掉 —— 用户看到的是 `ls -la`，
     * 真正批准的是别的东西。**一个可以被展示内容伪造的边界不再是边界。**
     * CLI 那边同一件事的形态是剥 ANSI 与零宽字符（`main.ts` 的 `forTerminal`）。
     *
     * 【定】模式带前导点（`\.innerHTML`），因为**散文里也会提到这个词** ——
     * 本仓注释密度很高，这几个文件的文件头就在讲这条规则。带点之后只抓
     * 属性赋值这种真实用法，顺带把 `outerHTML` 与 `insertAdjacentHTML`
     * 一起抓上（它们是同一个洞的另外两个入口）。
     */
    id: "10",
    desc: "★阶段 4：模型产出不得走 innerHTML / outerHTML / insertAdjacentHTML",
    pattern: "\\.(inner|outer)HTML|insertAdjacent" + "HTML",
    paths: ["apps/workagent-ui/public"],
    allowed: [],
  },
  {
    /**
     * ★阶段 4 收口批。**界面不得用内联 `style` 属性。**
     *
     * 不是风格洁癖，是我们自己的 CSP 会把它吃掉：`style-src 'self'` 同时管着
     * 内联 style 属性，于是 `el("i", { style: "width:95%" })` 的属性字符串
     * 进了 DOM、声明却是空的 —— 八条预算轴**全部渲染成满格**，一个说假话的白盒。
     * 实测确诊：`getAttribute("style") === "width:95%"` 而 `el.style.length === 0`，
     * 同一元素上 CSSOM 赋值则 length 变 1。
     *
     * 【定】样式一律走 CSSOM（`el()` 的 `css:` 参数）。这条 grep 是那件事的
     * 机械判据 —— 它挡的是一类**看起来能跑、实际被自己的安全头静默丢弃**的写法，
     * 而这种失败在截图里看不出来（我第一轮就是看着截图判它「渲染正常」的）。
     */
    id: "11",
    desc: "★阶段 4：界面不得用内联 style 属性（被自己的 CSP 丢弃）",
    pattern: "style: \"|style=\\\"",
    paths: ["apps/workagent-ui/public"],
    allowed: [],
  },
  {
    /**
     * ★ ADR-0011：**MCP 客户端不得进 Runtime 与适配器。**
     *
     * 它与边界 7（沙箱与命令解析）同源，但形态更隐蔽。边界 4 / 6 抓的是
     * 「Runtime import 了工具包」，而 MCP 的诱惑**不需要 import 任何工具包**：
     * 它是把 `StdioClientTransport` 直接搬进
     * `packages/harness-runtime/src/ports/` —— 那里本来就叫 Port，
     * 一个"MCP Port"看着天经地义。搬进去之后 Runtime 就认识了 JSON-RPC
     * 与子进程管理，而 4 / 6 / 7 **一条都不会响**。
     *
     * 【定】Runtime 侧允许存在的只有 `TrustedEffectResolver` 这个类型
     * （`McpEffectResolver` 实现它，住在 `tools/mcp/`）——
     * 与 `ShellEffectResolver` 的处置完全一致。
     *
     * ── ⚠️ 【定】如实写明它的**射程盲区**（二次评审 zcode P2-4）─────────────
     *
     * 这条 grep 抓的是「**把 SDK 搬进 Runtime**」。它抓不到的是：
     * 有人在 `packages/` 里用 `node:child_process` ＋ `JSON.parse`
     * **手写**一个 JSON-RPC 客户端 —— 那同样让 Runtime 认识了 MCP，
     * 而模式串一个字都不会命中。
     *
     * 不去扩模式（`child_process` 在 `packages/` 里有正当用途，
     * 扩了会变成一条噪音规则），而是**把盲区写在这里**。
     * 一条声称射程比实际更大的规则，比一条老实交代边界的规则更危险：
     * 它会让人以为这个方向已经有人守着了。
     */
    id: "12",
    desc: "★ADR-0011：MCP 客户端不得进 Runtime / 适配器",
    pattern: "modelcontext" + "protocol|Stdio" + "ClientTransport",
    paths: ["packages", "adapters"],
    allowed: [],
  },
];

/**
 * 跑一条边界 grep，返回**真实依赖**的命中行。
 *
 * 【定】判据必须区分注释、类型定义与真实依赖（CLAUDE.md 的原话）。
 * 这些文件里到处引用边界规则本身 —— 把注释算成违规，这些 grep 会永远红，
 * 然后被人加白名单加到失去意义。
 *
 * 判据是「这一行去掉缩进后以 `*` / `//` / `/*` 开头」——
 * 本仓的注释密度很高但格式统一，这个判据足够，且不会漏掉真实的 import
 * （import 语句不可能以这三者开头）。
 */
export function grepBoundary(b: Boundary): string[] {
  let raw: string;
  try {
    raw = execFileSync(
      "grep",
      ["-rnE", "--exclude-dir=node_modules", b.pattern, ...b.paths],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } catch (err) {
    // grep 无匹配时退出码 1，execFileSync 会抛。那是「干净」，不是错误。
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return [];
    raw = e.stdout ?? "";
  }
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => {
      const body = l.split(":").slice(2).join(":").trim();
      return !(body.startsWith("*") || body.startsWith("//") || body.startsWith("/*"));
    })
    .filter((l) => !b.allowed.some((a) => l.startsWith(a)))
    .filter((l) => !(b.exceptLines ?? []).some((x) => l.includes(x)));
}
