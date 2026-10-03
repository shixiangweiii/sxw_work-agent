/**
 * `screenshot` 与 `computer` 两个工具的定义（ADR-0013）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】两个工具，不是一个。Anthropic 的 computer 工具把截图与动作放在同一个
 * 工具里（action=screenshot），而 Atlas 的声明是**逐工具**的：幂等、只读、
 * 审批、恢复分支都按工具声明判。合成一个的话，「截一张图」得跟着「点一下」
 * 一起声明成非幂等、非只读、要审批 —— 每次看一眼屏幕都要人点一次确认，
 * 崩溃后的截图也会被当成「状态未知的副作用」停在 RECOVERY_REQUIRED。
 *
 * 【定】属性只用扁平标量（`verify:tools` B4 钉着自家工具这条纪律），
 * 所以坐标是 `x` / `y` 两个数，而不是 Anthropic 那种 `[x, y]` 数组；
 * 动作名写进 description，不写 `enum`。
 *
 * 【定】description 是这两个工具对模型的**全部承诺**，每一句都必须与
 * `handler.ts` 的实际行为一致 —— 尤其是坐标约定那一句（M1 那条教训：
 * 模型是按文档办事的，错的是文档）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { asId, digest, type ToolDefinition, type ToolId, type ToolSnapshot, type VisionCapability } from "@workagent/harness-runtime";
import { describeAllowlist, type ComputerUseConfig } from "./config.js";

export const SCREENSHOT_TOOL = "screenshot";
export const COMPUTER_TOOL = "computer";

/** 受信任 Resolver 的身份（版本随定义升，见 `computerToolSnapshots`）。 */
export const SCREENSHOT_RESOLVER_ID = "computer_screenshot_effect";
export const COMPUTER_RESOLVER_ID = "computer_action_effect";

/** 工具实现的版本。入参或执行语义变化就升。 */
const IMPL_VERSION = "1.0.0";

/** computer 工具认得的动作。description、resolver、handler 共用这一份。 */
export const COMPUTER_ACTIONS = [
  "left_click",
  "right_click",
  "double_click",
  "drag",
  "scroll",
  "type",
  "key",
  "activate_app",
  "wait",
] as const;
export type ComputerActionName = (typeof COMPUTER_ACTIONS)[number];

export function isComputerAction(v: unknown): v is ComputerActionName {
  return typeof v === "string" && (COMPUTER_ACTIONS as readonly string[]).includes(v);
}

const COORDINATE_RULE =
  "坐标一律用 0–1000 的归一化坐标：(0,0) 是截图左上角、(1000,1000) 是截图右下角，" +
  "与截图的实际像素尺寸无关；取目标的中心点。";

export interface ComputerToolSet {
  snapshots: ToolSnapshot[];
  /** `id@version`，供注入 `DeclarativeEffectResolver` 的受信任 Resolver 表。 */
  screenshotResolverKey: string;
  computerResolverKey?: string;
}

/**
 * 按启用档位与端点视觉声明产出工具快照。
 *
 * 【定】版本里带配置摘要（档位、白名单、坐标约定、截图尺寸）。工具定义随
 * RunSpec 冻结；resume 时若这些变了，`ResumeExternalToolsUnverifiable.drifted`
 * 会点名它 —— 白名单从 TextEdit 换成了 Numbers，旧 Run 接着点下去的就不是
 * 当初授权的那个应用了，这件事必须说出来。
 */
export function computerToolSnapshots(
  config: ComputerUseConfig,
  vision: VisionCapability,
): ComputerToolSet {
  const allow = describeAllowlist(config);
  const identity = digest(
    // allowBrowsers 进摘要：它改变的是「哪些应用能被操作」，resume 时必须能看出来（ADR-0015）。
    JSON.stringify([config.level, config.apps.map((a) => a.raw), config.allowBrowsers, vision.groundingCoordinateSpace, vision.preferredScreenshotLongEdgePx]),
  ).slice(0, 12);
  const version = `${IMPL_VERSION}+${identity}`;

  const screenshotDef: ToolDefinition = {
    id: asId<ToolId>("tool_screenshot"),
    version,
    name: SCREENSHOT_TOOL,
    description:
      `截取本机屏幕。截图**只包含白名单应用的窗口**（${allow}）；其他应用、桌面与通知是空白的，` +
      `你看不到也操作不了它们。返回一张截图图像，以及截图里有哪些应用、哪个在前台。` +
      COORDINATE_RULE +
      "只有最近几张截图会以图像形式留在上下文里，更早的只剩这条文字记录；" +
      "要看屏幕当前的样子就重新截图，不要依赖记忆里的旧画面。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    effectResolution: {
      kind: "RESOLVER",
      resolverRef: { id: SCREENSHOT_RESOLVER_ID, version },
    },
    // 文本输出（应用名、窗口标题）照常过脱敏；图像本身脱敏不了，处置标记会如实写明。
    redaction: { profile: "STANDARD" },
    // 看一眼屏幕不改变任何东西：崩溃后重新截一次就是正确的恢复（§18.2 分支一）。
    idempotency: { isIdempotent: true, isReadOnly: true },
    timeoutPolicy: { timeoutMs: 30_000 },
    progressReporting: { mode: "NONE" },
    verification: { mode: "NONE", requiredForSuccess: false },
    recoveryObservation: { requiresPreFingerprint: false },
    stateOutsideTranscript: true,
  };

  const snapshots: ToolSnapshot[] = [
    { toolId: screenshotDef.id, version, definition: screenshotDef },
  ];
  const set: ComputerToolSet = {
    snapshots,
    screenshotResolverKey: `${SCREENSHOT_RESOLVER_ID}@${version}`,
  };

  if (config.level === "control") {
    const computerDef: ToolDefinition = {
      id: asId<ToolId>("tool_computer"),
      version,
      name: COMPUTER_TOOL,
      description:
        `操作本机屏幕上的白名单应用（${allow}）。action 取值：` +
        "left_click / right_click / double_click（x, y）、" +
        "drag（x, y 起点；to_x, to_y 终点）、" +
        "scroll（x, y；direction = up/down/left/right；amount 行数，默认 3）、" +
        "type（text：要输入的文字，发给前台应用）、" +
        "key（text：按键组合，如 cmd+s、return、ctrl+a）、" +
        "activate_app（app：白名单里的应用名，把它切到前台，没开就打开它）、" +
        "wait（seconds：等待秒数，最多 10）。" +
        COORDINATE_RULE +
        "规则：" +
        // 【定】「已经看到的」那张，不是「最近截的」那张（2026-10-03 代码评审 CU-R03）：
        // 同一批里排在前面的 screenshot，模型生成这批调用时还没看到结果，handler 不拿它当复核依据。
        // 这句话与 handler 的行为必须一起改 —— 模型照着旧说法排 [screenshot, click]，会被拒一次。
        "① 每个点击、拖拽、滚动都基于你**已经看到结果的**最近一次截图（同一批里排在前面的 screenshot " +
        "你还没看到，不算 —— 先截图、看完结果，下一批再操作）；如果目标处的窗口或画面在那之后变了，" +
        "动作会被拒绝（TOOL_GUI_STATE_CHANGED），重新截图再来；" +
        "② 只能作用在白名单应用上：目标处是别的应用或桌面会被拒绝；键盘输入只发给前台的白名单应用；" +
        // 【定】这句话随配置变（M1：模型是按文档办事的）——放开浏览器之后还说「浏览器永远不能操作」，
        // 模型会绕开它要用的那个应用。
        (config.allowBrowsers
          ? "③ 终端、IDE、密码管理器、系统设置永远不能操作（浏览器本次已由用户显式放开，但只能操作白名单里的那几个）；"
          : "③ 终端、IDE、浏览器、密码管理器、系统设置永远不能操作；") +
        "密码框获得焦点时拒绝键盘输入，" +
        "需要输入密码就用 request_handoff 请人来做；" +
        "④ 同一批里的动作按顺序执行，任何一个失败或被拒，后面的动作都会被跳过；" +
        "⑤ 每个动作都可能需要用户确认。" +
        "建议：一批里做几个确定的动作，最后加一次 screenshot 看结果；" +
        "能用 run_shell 或文件工具完成的事情，不要绕道 GUI。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", description: `动作名：${COMPUTER_ACTIONS.join(" / ")}` },
          x: { type: "number", description: "目标 x（0–1000 归一化）" },
          y: { type: "number", description: "目标 y（0–1000 归一化）" },
          to_x: { type: "number", description: "drag 的终点 x（0–1000 归一化）" },
          to_y: { type: "number", description: "drag 的终点 y（0–1000 归一化）" },
          direction: { type: "string", description: "scroll 的方向：up / down / left / right" },
          amount: { type: "number", description: "scroll 的行数，默认 3，最多 20" },
          text: { type: "string", description: "type 要输入的文字，或 key 的按键组合" },
          app: { type: "string", description: "activate_app 的应用名（必须在白名单里）" },
          seconds: { type: "number", description: "wait 的秒数，最多 10" },
        },
        required: ["action"],
      },
      effectResolution: {
        kind: "RESOLVER",
        resolverRef: { id: COMPUTER_RESOLVER_ID, version },
      },
      redaction: { profile: "STANDARD" },
      /**
       * 【定】说实话：既不幂等也不只读（与 `run_shell` 同一条理由）。
       * 点两次「切换」和点一次是两个结果。
       */
      idempotency: { isIdempotent: false, isReadOnly: false },
      timeoutPolicy: { timeoutMs: 30_000 },
      progressReporting: { mode: "NONE" },
      verification: { mode: "NONE", requiredForSuccess: false },
      /**
       * 【定】要求前置指纹，而 Verifier 给不出 —— `canObserve` 恒假，崩溃后落
       * §18.2 **分支三 RECOVERY_REQUIRED**。崩在一次点击中途，「点了没点」
       * 在屏幕上可能毫无痕迹，也可能改变了一切；没有任何办法事后判断。
       */
      recoveryObservation: { requiresPreFingerprint: true },
      haltsBatchOnFailure: true,
      stateOutsideTranscript: true,
    };
    snapshots.push({ toolId: computerDef.id, version, definition: computerDef });
    set.computerResolverKey = `${COMPUTER_RESOLVER_ID}@${version}`;
  }
  return set;
}
