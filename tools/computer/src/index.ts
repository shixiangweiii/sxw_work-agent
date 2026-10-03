/**
 * `@workagent/tools-computer` —— 本机 macOS 的 computer use（ADR-0013）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 研究问题：**在一个所有动作的副作用都无从事先判断、观察只有像素的工具域里，
 * Atlas 的声明纪律与事实表还能不能说真话？**
 *
 * 阶段 0 探针（`spikes/s1-computer-use-vision/`）先回答了「模型行不行」：
 * 两个目标模型在 0–1000 归一化坐标下定位都够用（qwen3.8-flash 10/10、
 * deepseek-flash 8/10，工具调用形态），所以这里没有额外的定位模型。
 *
 * ── 三层，各管一件事 ─────────────────────────────────────────────────
 *
 *   Runtime        —— 图像作为模型可见资源进上下文（不认识「屏幕」）；
 *   本包（TS）     —— 工具定义、坐标换算、**全部判定**（白名单、窗口身份、
 *                     画面复核、安全输入、按键拒绝表）；
 *   Swift 助手     —— 只提供原语（截图、查窗口、比对区域、投递事件），
 *                     并在投递前再判一次硬拒绝名单。
 *
 * 边界 15 守着前两层之间那条线：屏幕与输入的实现细节不得进 Runtime / 适配器。
 *
 * ── 代价，逐条写在 ADR-0013 里，一条都不许假装没有 ───────────────────────
 *
 *   ① 本机没有隔离层：一次误点就是真实后果；
 *   ② 截图里的文字可能是指令（提示注入），两个端点都没宣称对截图做注入检测；
 *   ③ 截图会发往模型端点，图像脱敏不了（只截白名单应用是第一道减法）；
 *   ④ 凭证读禁、私网拒绝这些护栏，在 GUI 面前不成立；
 *   ⑤ 前台模式下用户不能同时使用电脑。
 * ══════════════════════════════════════════════════════════════════════
 */

import type {
  PreparedAction,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolHandlerPort,
  ToolSnapshot,
  TrustedEffectResolver,
  VerificationPort,
  VerificationResult,
  VisionCapability,
} from "@workagent/harness-runtime";
import { describeForApproval, type ComputerApprovalView } from "./approval.js";
import { describeAllowlist, type ComputerUseConfig } from "./config.js";
import { COMPUTER_TOOL, SCREENSHOT_TOOL, computerToolSnapshots } from "./definitions.js";
import type { ComputerDriver } from "./driver.js";
import { ComputerToolHandler, type ComputerHandlerOptions } from "./handler.js";
import { ComputerEffectResolver, ScreenshotEffectResolver } from "./resolver.js";

export * from "./config.js";
export * from "./driver.js";
export { COMPUTER_TOOL, SCREENSHOT_TOOL, COMPUTER_ACTIONS } from "./definitions.js";
export { ComputerToolHandler, toPoints } from "./handler.js";
export { parseKeyCombo } from "./keys.js";
export type { ComputerApprovalView } from "./approval.js";
export { HelperDriver, type HelperDriverOptions } from "./helper-driver.js";
export { ensureHelperBuilt, helperAppPath, type HelperBuildResult } from "./helper-build.js";

/** 结构与 `McpNotice` / compose 的 `Notice` 相同（见那两处的说明）。 */
export interface ComputerNotice {
  text: string;
  detail?: string;
}

export interface ComputerRuntime {
  snapshots: ToolSnapshot[];
  handler: ToolHandlerPort & { handles(name: string): boolean };
  verifier: VerificationPort & { handles(name: string): boolean };
  /** 注入 `DeclarativeEffectResolver` 的受信任 Resolver 表。 */
  resolvers: Map<string, TrustedEffectResolver>;
  notices: ComputerNotice[];
  /** 审批面用。非 GUI 工具返回 undefined。 */
  describeForApproval(action: PreparedAction): Promise<ComputerApprovalView | undefined>;
  /*
   * 【定】这里**没有** `close()`。驱动（也就是那个持有系统授权的助手进程）的生命周期
   * 归入口：CLI 是一次命令，service 是整个会话 —— 切 workspace 会重新 compose，
   * 而助手不该跟着重启（与 MCP 连接同一条理由）。让 runtime 也能关它，
   * 就有两个东西能关同一个进程，而切一次目录会把另一个 RunHost 手里的驱动关掉。
   */
}

export interface CreateComputerUseOptions {
  config: ComputerUseConfig;
  vision: VisionCapability;
  driver: ComputerDriver;
  /** 验收脚本调阈值与等待时间用。 */
  handler?: Omit<ComputerHandlerOptions, "config" | "vision" | "driver">;
}

export function createComputerUse(opts: CreateComputerUseOptions): ComputerRuntime {
  if (opts.config.level === "off") {
    throw new Error("createComputerUse() 不该在 --computer off 时被调用（那时一个 GUI 工具都不装）");
  }
  const tools = computerToolSnapshots(opts.config, opts.vision);
  const handler = new ComputerToolHandler({
    config: opts.config,
    vision: opts.vision,
    driver: opts.driver,
    ...opts.handler,
  });
  const resolvers = new Map<string, TrustedEffectResolver>([
    [tools.screenshotResolverKey, new ScreenshotEffectResolver(opts.config)],
  ]);
  if (tools.computerResolverKey) resolvers.set(tools.computerResolverKey, new ComputerEffectResolver());

  const allow = describeAllowlist(opts.config);
  /**
   * 【定】预算那一句放在 `text`（常驻），不放 `detail`：它是**每个** GUI Run 都会撞上的
   * 事实，不是一次性配置信息（「分界线是用户什么时候需要它」）。
   *
   * ADR-0014 改了两条 Runtime 规则之后，**还剩下的**后果如实说：
   *   · 观察过期的拒绝（截图后屏幕变了）不再计入连续失败；但模型自己的错误仍计入，
   *     而成功的 GUI 动作没有独立核实、不会清零它 —— 在 GUI 任务里它是累计数；
   *   · 只截图的批不再按入参判无进展；但「动作 ＋ 截图」的批照旧按入参判 ——
   *     同一处连滚三次仍会被判原地打转。
   * `verify:computer` N 段把「这里说的」与「实际发生的」钉在一起：
   * 哪天规则又改了而这段话没改，那条判据会红。
   */
  const notices: ComputerNotice[] = [
    {
      text:
        `computer use：${opts.config.level === "control" ? "可截图、可操作" : "只能截图"}，` +
        `白名单 ${allow}。截图只含这些应用的窗口，会发往模型端点（图像无法脱敏）。` +
        (opts.config.level === "control"
          ? "GUI 动作直接作用在这台机器上，**沙箱对它不成立**；每一步按审批档位处置。" +
            "截图之后屏幕变了导致的拒绝不计入「连续失败」；但模型自己的错误（点到白名单外、非法按键）照常计入，" +
            "而成功的 GUI 动作没有独立核实、**不会把它清零**（GUI 任务里它是累计数）—— " +
            "建议 --max-consecutive-failures 10 --max-turns 60。"
          : ""),
      detail:
        (opts.config.allowBrowsers
          ? "终端、IDE、密码管理器、系统设置永远不能操作（ADR-0013）；浏览器已由 --computer-allow-browsers 显式放开（ADR-0015）。"
          : "终端、IDE、浏览器、密码管理器、系统设置永远不能操作（ADR-0013）。") +
        "只截图的批次不按入参判原地打转；但「动作 ＋ 截图」完全相同地连做三批（例如同一处连滚三次）" +
        "仍会被判为原地打转（NO_PROGRESS）并结束 Run。" +
        "需要授权时运行 npm run computer:doctor -- --request。",
    },
  ];

  if (opts.config.allowBrowsers) {
    notices.push({
      text:
        "⚠️ 浏览器已显式放开给 GUI 操作（--computer-allow-browsers，ADR-0015）：截图会带上浏览器里的页面、" +
        "标签页标题与书签，发往模型端点；浏览器里的登录态（邮箱、网银……）就在模型能点到的地方；" +
        "网页上的文字可能是提示注入。如果 Atlas 的白盒界面开在同一个浏览器里，那里的审批按钮也在射程内。",
    });
  }

  return {
    snapshots: tools.snapshots,
    handler,
    verifier: new ComputerVerifier(),
    resolvers,
    notices,
    describeForApproval: (action) => describeForApproval(action, handler, opts.driver),
  };
}

/**
 * computer use 的 Verifier：**如实说「没有独立核实」**。
 *
 * 【定】不假装验过。GUI 动作的结果只有再截一次图才看得见，而那是模型的观察，
 * 不是独立证据（评测研究：15% 的失败判定本身就是错的，验证器设计比模型更重要）。
 * 所以这里一律 SKIPPED ＋ required:false —— 结算不会因为它降级，也不会因为它
 * 冒出一条「已核实」的假事实。要把 GUI 结果纳入结算，需要另一个决定（ADR-0013 CU-9）。
 *
 * 【定】没有 `observePre` —— 对 `computer` 这意味着崩溃后落分支三（见定义）。
 */
class ComputerVerifier implements VerificationPort {
  async verify(
    action: PreparedAction,
    _outcome: ToolExecutionOutcome,
    _ctx: ToolExecutionContext,
  ): Promise<VerificationResult> {
    return {
      id: `ver_${action.id}`,
      actionId: action.id,
      at: Date.now(),
      mode: "NONE",
      required: false,
      status: "SKIPPED",
      detail: "GUI 动作没有独立核实（结果只能靠重新截图观察，见 ADR-0013）",
    };
  }

  handles(toolName: string): boolean {
    return toolName === SCREENSHOT_TOOL || toolName === COMPUTER_TOOL;
  }
}
