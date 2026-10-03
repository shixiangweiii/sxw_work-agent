/**
 * GUI 驱动的接口（ADR-0013）。实现有两个：Swift 助手（`helper-driver.ts`）与
 * 验收脚本里的假驱动（`apps/cli/src/verify/fixtures/fake-gui-driver.ts`）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】驱动只提供**原语**（截图、查某点是什么窗口、比对区域、投递事件），
 * 「该不该做」的**判定**全部在 TS 这一侧（`handler.ts`）。
 *
 * 理由是可测性，而且是本仓反复栽过的那种：判定若写在 Swift 里，验收脚本
 * 只能拿假驱动去**模仿**那段判定 —— 判据测的就成了假驱动，不是真逻辑
 * （「判据测的不是它声称在测的东西」）。判定留在 TS，假驱动只需要供数据，
 * 被测的就是生产代码本身。
 *
 * Swift 助手在投递事件前**另外**再判一次硬拒绝名单 —— 那是第二道，
 * 只负责「无论 TS 说什么都不许碰」，不替代第一道。
 *
 * 【定】坐标一律是**逻辑点**（pt），全局坐标、主显示器左上角为原点 ——
 * 与 CGEvent、CGWindowList、AX 用的是同一个坐标系。像素只出现在截图尺寸里。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface AppRef {
  bundleId: string;
  name: string;
  pid: number;
}

export interface WindowInfo {
  windowId: number;
  pid: number;
  bundleId: string;
  appName: string;
  /** 窗口标题。需要录屏授权才读得到别的应用的标题，读不到时缺省。 */
  title?: string;
  /** 逻辑点，全局坐标。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 窗口层级。0 是普通窗口；菜单、弹出框更高。 */
  layer: number;
}

export interface DisplayInfo {
  /** 主显示器的逻辑尺寸（pt）。 */
  widthPt: number;
  heightPt: number;
  /** 缩放因子（Retina 为 2）。 */
  scale: number;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureRequest {
  /** 只截这些应用的窗口。其余应用、桌面、通知都不会出现在图里。 */
  allowBundleIds: string[];
  /** 截图长边像素（来自端点声明 `vision.preferredScreenshotLongEdgePx`）。 */
  maxLongEdgePx: number;
}

export interface CaptureResult {
  /** 驱动侧的截图身份。之后的「这一处变没变」都相对这张图比对。 */
  screenshotId: string;
  png: Uint8Array;
  /** 截图像素尺寸（= 模型看到的图）。 */
  width: number;
  height: number;
  display: DisplayInfo;
  /**
   * 这张图**实际覆盖**的屏幕区域（逻辑点，全局坐标）。归一化坐标 → 点的换算一律经它。
   *
   * 【定】驱动必须报它，handler 不得假设它等于整块显示器（ADR-0014 附带修复）：第一次真桌面运行里
   * 截图其实只覆盖白名单窗口的外接矩形（×1.26 加平移），按「图 = 整块显示器」换算的每一下都点偏、
   * 并且不报错。报出来之后，「图覆盖哪里」是一条事实，而不是一个默认。
   */
  contentRect: ScreenRect;
  /** 截图那一刻屏幕上的窗口，前到后排序（逻辑点）。 */
  windows: WindowInfo[];
  frontmost: AppRef | null;
  /** 实际被截进图里的白名单应用（有窗口在屏幕上的那些）。 */
  capturedApps: AppRef[];
}

export interface ProbeRequest {
  /** 不给坐标时只查前台应用与安全输入状态（键盘动作用）。 */
  x?: number;
  y?: number;
  /** 给了截图身份与坐标时，返回该处一小块区域相对那张截图的差异。 */
  screenshotId?: string;
  /** 比对区域的半径（pt）。 */
  radiusPt?: number;
}

export interface ProbeResult {
  /** 此刻该点最上层的窗口。 */
  windowAtPoint: WindowInfo | null;
  frontmost: AppRef | null;
  /** 系统级「安全输入」是否开启（密码框获得焦点时为真）。 */
  secureInput: boolean;
  /**
   * 该点周围区域此刻与指定截图的平均灰度差（0–255）。
   * null = 那张截图已不在驱动里（驱动重启过、或被更新的截图挤掉）。
   */
  regionDiff: number | null;
}

export interface ElementInfo {
  role?: string;
  title?: string;
  description?: string;
  value?: string;
}

export type DriverAction =
  | { kind: "click"; button: "left" | "right"; count: 1 | 2; x: number; y: number }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "type"; text: string; pid: number }
  | { kind: "key"; key: string; modifiers: KeyModifier[]; pid: number }
  | { kind: "activate"; bundleId: string };

export type KeyModifier = "cmd" | "shift" | "option" | "control" | "fn";

export type DriverActionResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface DriverPermissions {
  screenRecording: boolean;
  accessibility: boolean;
}

export interface ResolvedApp {
  /** 用户写的原文。 */
  query: string;
  bundleId?: string;
  name?: string;
  running: boolean;
}

export interface ComputerDriver {
  permissions(): Promise<DriverPermissions>;
  /** 把白名单里的名字 / bundle id 解析成具体应用（运行中或已安装）。 */
  resolveApps(queries: string[]): Promise<ResolvedApp[]>;
  capture(req: CaptureRequest): Promise<CaptureResult>;
  probe(req: ProbeRequest): Promise<ProbeResult>;
  /** 审批面用：某点是什么窗口、什么控件（AX）。 */
  describe(x: number, y: number): Promise<{ window: WindowInfo | null; element: ElementInfo | null }>;
  /**
   * 投递一个动作。`allowBundleIds` 交给驱动做第二道检查（目标不在其中就不投递）。
   * 【定】驱动返回失败时**保证什么都没有投递**；投递到一半出错只能抛异常
   * （handler 据此把副作用记成 UNKNOWN，而不是 NOT_STARTED）。
   */
  perform(action: DriverAction, guard: { allowBundleIds: string[]; allowBrowsers?: boolean }): Promise<DriverActionResult>;
  close(): Promise<void>;
}
