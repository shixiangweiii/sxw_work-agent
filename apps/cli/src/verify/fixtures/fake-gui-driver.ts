/**
 * `verify:computer` 的假 GUI 驱动（ADR-0013）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它只**供数据**，不做任何判定。
 *
 * 白名单、窗口身份、画面复核、安全输入、按键拒绝表 —— 全部判定都在
 * `tools/computer/src/handler.ts`（见 `driver.ts` 的文件头）。假驱动若也去判，
 * 判据测到的就成了假驱动自己（「判据测的不是它声称在测的东西」）。
 * 所以这里只有：屏幕上有哪些窗口、显示器多大、谁在前台、安全输入开没开、
 * 某处与某张截图差多少 —— 以及一本**投递记录**，判据靠它回答
 * 「被拒绝的动作是不是真的什么都没投递」。
 *
 * 【定】截图是**真的 PNG**（带 IHDR、能被 `imageDimensions` 读出尺寸），
 * 而且每一张内容不同。尺寸按 `maxLongEdgePx` 与显示器宽高比推出 ——
 * 与真助手同一个口径，于是「截图长边跟着端点声明走」这件事也测得到。
 *
 * 夹具刻意让三个坐标系**两两不等**：显示器 1536×960 pt（缩放 2×）、
 * 截图 1792×1120 px、模型坐标 0–1000。任何一处把它们混用，换算都会偏，
 * 而偏的方向不报错（`toPoints` 的注释）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { crc32, deflateSync } from "node:zlib";
import type {
  AppRef,
  CaptureRequest,
  CaptureResult,
  ComputerDriver,
  DisplayInfo,
  DriverAction,
  DriverActionResult,
  DriverPermissions,
  ElementInfo,
  ProbeRequest,
  ProbeResult,
  ResolvedApp,
  WindowInfo,
} from "@workagent/tools-computer";

export interface FakeApp {
  bundleId: string;
  name: string;
  pid: number;
  running: boolean;
}

export const TEXTEDIT: FakeApp = { bundleId: "com.apple.TextEdit", name: "TextEdit", pid: 501, running: true };
export const CALCULATOR: FakeApp = { bundleId: "com.apple.calculator", name: "Calculator", pid: 502, running: true };
export const FINDER: FakeApp = { bundleId: "com.apple.finder", name: "Finder", pid: 503, running: true };
export const TERMINAL: FakeApp = { bundleId: "com.apple.Terminal", name: "Terminal", pid: 504, running: true };
export const CHROME: FakeApp = { bundleId: "com.google.Chrome", name: "Google Chrome", pid: 505, running: true };

export function windowOf(app: FakeApp, windowId: number, rect: [number, number, number, number], title?: string): WindowInfo {
  return {
    windowId,
    pid: app.pid,
    bundleId: app.bundleId,
    appName: app.name,
    ...(title !== undefined ? { title } : {}),
    x: rect[0],
    y: rect[1],
    width: rect[2],
    height: rect[3],
    layer: 0,
  };
}

export function refOf(app: FakeApp): AppRef {
  return { bundleId: app.bundleId, name: app.name, pid: app.pid };
}

export class FakeGuiDriver implements ComputerDriver {
  permissionsState: DriverPermissions = { screenRecording: true, accessibility: true };
  display: DisplayInfo = { widthPt: 1536, heightPt: 960, scale: 2 };
  /** 本机「装了」哪些应用（resolveApps 查这张表）。 */
  installed: FakeApp[] = [TEXTEDIT, CALCULATOR, FINDER, TERMINAL, CHROME];
  /** 此刻屏幕上的窗口，前到后。 */
  windows: WindowInfo[] = [windowOf(TEXTEDIT, 11, [0, 0, 1536, 960], "未命名.txt")];
  frontmost: AppRef | null = refOf(TEXTEDIT);
  secureInput = false;
  /** 某处与（仍在驱动里的）截图的灰度差。截图不在了时 probe 一律返回 null。 */
  regionDiff = 0;
  element: ElementInfo | null = { role: "AXButton", title: "保存" };
  /**
   * 截图实际覆盖的区域。不设 = 整块显示器（真助手修复后的行为）；
   * 设一个偏移的矩形，就能测「换算经 contentRect，而不是假设整块显示器」。
   */
  contentRect: { x: number; y: number; width: number; height: number } | undefined = undefined;
  /** 下一次 perform 的结果；"throw" = 投递到一半抛异常。 */
  performResult: DriverActionResult | "throw" = { ok: true };
  /**
   * 按位置给的画面差（不设 = 处处都是 `regionDiff`）。拖拽的起点与终点要能各自不同 ——
   * 只有一个全局值的话，「终点有没有比对画面」在夹具里不可观察（CU-R05）。
   */
  regionDiffAt: ((x: number, y: number) => number) | undefined = undefined;
  /**
   * 世界对一次**成功投递**的反应（例如激活之后前台换了）。不设 = 世界不动。
   * 【定】这是在模拟屏幕，不是在判定 —— 判定照旧全在 handler 里。
   */
  onPerform: ((action: DriverAction) => void) | undefined = undefined;
  /** 每次 probe 开始时调用。判据用它把「取消」插进复核的等待里（CU-R02）。 */
  onProbe: ((req: ProbeRequest) => void) | undefined = undefined;

  /** 投递记录 —— 「被拒绝的动作什么都没投递」靠它判。 */
  readonly performed: DriverAction[] = [];
  readonly captures: CaptureRequest[] = [];
  /** 每次 perform 收到的第二道检查参数 —— 判据靠它确认「放开浏览器」这件事传到了助手那一层。 */
  readonly guards: Array<{ allowBundleIds: string[]; allowBrowsers?: boolean }> = [];
  closeCount = 0;
  /** 每张截图的像素（之后若有人想按内容比对，可以从这里取）。 */
  private readonly shots = new Map<string, Uint8Array>();
  private shotSeq = 0;

  async permissions(): Promise<DriverPermissions> {
    return { ...this.permissionsState };
  }

  async resolveApps(queries: string[]): Promise<ResolvedApp[]> {
    return queries.map((q) => {
      const hit = this.installed.find(
        (a) => a.bundleId === q || a.name.toLowerCase() === q.trim().toLowerCase(),
      );
      return hit
        ? { query: q, bundleId: hit.bundleId, name: hit.name, running: hit.running }
        : { query: q, running: false };
    });
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    this.captures.push(req);
    const landscape = this.display.widthPt >= this.display.heightPt;
    const width = landscape
      ? req.maxLongEdgePx
      : Math.round((req.maxLongEdgePx * this.display.widthPt) / this.display.heightPt);
    const height = landscape
      ? Math.round((req.maxLongEdgePx * this.display.heightPt) / this.display.widthPt)
      : req.maxLongEdgePx;
    this.shotSeq += 1;
    const screenshotId = `shot_${this.shotSeq}`;
    const png = solidPng(width, height, this.shotSeq);
    this.shots.set(screenshotId, png);
    const visible = this.windows.filter((w) => req.allowBundleIds.includes(w.bundleId));
    const captured: AppRef[] = [];
    for (const w of visible) {
      if (!captured.some((a) => a.bundleId === w.bundleId)) {
        captured.push({ bundleId: w.bundleId, name: w.appName, pid: w.pid });
      }
    }
    return {
      screenshotId,
      png,
      width,
      height,
      display: { ...this.display },
      contentRect: this.contentRect ?? { x: 0, y: 0, width: this.display.widthPt, height: this.display.heightPt },
      // 【定】窗口表是**全屏**的事实（与真助手一致）：白名单只决定截进图里的像素，
      // 不决定 handler 能不能知道「那个点上是谁」—— 后者正是白名单检查要用的。
      windows: this.windows.map((w) => ({ ...w })),
      frontmost: this.frontmost ? { ...this.frontmost } : null,
      capturedApps: captured,
    };
  }

  async probe(req: ProbeRequest): Promise<ProbeResult> {
    this.onProbe?.(req);
    const at =
      req.x !== undefined && req.y !== undefined ? this.windowAtPoint(req.x, req.y) : null;
    const diff =
      this.regionDiffAt && req.x !== undefined && req.y !== undefined ? this.regionDiffAt(req.x, req.y) : this.regionDiff;
    return {
      windowAtPoint: at ? { ...at } : null,
      frontmost: this.frontmost ? { ...this.frontmost } : null,
      secureInput: this.secureInput,
      regionDiff: req.screenshotId === undefined ? null : this.shots.has(req.screenshotId) ? diff : null,
    };
  }

  async describe(x: number, y: number): Promise<{ window: WindowInfo | null; element: ElementInfo | null }> {
    const w = this.windowAtPoint(x, y);
    return { window: w ? { ...w } : null, element: w ? this.element : null };
  }

  async perform(action: DriverAction, guard: { allowBundleIds: string[]; allowBrowsers?: boolean }): Promise<DriverActionResult> {
    this.guards.push(guard);
    if (this.performResult === "throw") {
      this.performed.push(action);
      throw new Error("模拟：事件投递到一半助手崩了");
    }
    if (this.performResult.ok) {
      this.performed.push(action);
      this.onPerform?.(action);
    }
    return this.performResult;
  }

  /** 关掉 = 助手进程没了：它手里的截图一起没了（真助手重启后同样如此）。 */
  async close(): Promise<void> {
    this.closeCount += 1;
    this.shots.clear();
  }

  private windowAtPoint(x: number, y: number): WindowInfo | null {
    return this.windows.find((w) => x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height) ?? null;
  }
}

/**
 * 一张纯色、真实可解码的 PNG（RGB，8 位）。`seed` 让每张截图的字节不同 ——
 * 活跃图像窗口的判据要靠「哪几张还在请求里」区分它们。
 */
export function solidPng(width: number, height: number, seed: number): Uint8Array {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height, seed & 0xff);
  for (let y = 0; y < height; y++) raw[y * stride] = 0; // 每行的 filter 字节：None
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
