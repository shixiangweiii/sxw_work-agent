/**
 * computer use 的执行与**全部判定**（ADR-0013）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 判定都在这个文件里，驱动只供原语（见 `driver.ts` 的文件头）。
 * 每个指针动作执行前过四道检查，任何一道不过都**什么都不投递**、具名拒绝：
 *
 *   ① 有观察：本进程里这个 Run 截过图，**而且模型已经看到了它**（更早的批截的，
 *      见 `RunObservations`）。崩溃或重启之后必须先重新截图 ——
 *      屏幕状态是 transcript 之外的隐藏状态，旧的那张图描述的不一定是现在。
 *   ② 白名单：目标处最上层的窗口属于白名单应用，且不在硬拒绝名单上。
 *   ③ 同一个窗口：目标处的窗口与截图那一刻是同一个（窗口身份没变）。
 *   ④ 同一个画面：目标处一小块区域与截图那一刻的灰度差没有超过阈值。
 *
 * ③④ 是 TOCTOU 防护（arXiv 2604.18860：截图到执行平均隔 6.51 秒，期间切换
 * 窗口焦点能 100% 把动作重定向到别处）。人批准的是「在那张截图上点这里」，
 * 执行时那里已经不是那个东西了，就不许点 —— 这是 M5 那条「审批看到的与真正
 * 执行的必须是同一件事」在 GUI 上的版本。键盘动作同理：人批准的是「发给审批卡上
 * 那个应用」，执行时只发给它（`noteApprovedTarget`，CU-R01）。
 * ══════════════════════════════════════════════════════════════════════
 */

import {
  makeError,
  type PreparedAction,
  type RuntimeErrorRecord,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolHandlerPort,
  type VisionCapability,
} from "@workagent/harness-runtime";
import { hardDeniedReason, ruleMatches, type ComputerUseConfig } from "./config.js";
import { COMPUTER_TOOL, SCREENSHOT_TOOL, isComputerAction } from "./definitions.js";
import type {
  AppRef,
  ComputerDriver,
  DisplayInfo,
  DriverAction,
  KeyModifier,
  ScreenRect,
  ResolvedApp,
  WindowInfo,
} from "./driver.js";
import { parseKeyCombo } from "./keys.js";

export interface ComputerHandlerOptions {
  config: ComputerUseConfig;
  vision: VisionCapability;
  driver: ComputerDriver;
  /**
   * 执行前复核的灰度差阈值（0–255）。超过即判「画面变了」。
   * 默认 12：光标闪烁、抗锯齿抖动远低于它，一个按钮换了文字或被对话框盖住远高于它。
   */
  maxRegionDiff?: number;
  /** 复核区域半径（pt）。默认 24 —— 覆盖一个标准按钮。 */
  regionRadiusPt?: number;
  /** 动作投递后等界面跟上的时间（ms）。默认 300。验收脚本设 0。 */
  settleMs?: number;
}

/** 一个 Run 在本进程里最近的一次截图。 */
export interface Observation {
  screenshotId: string;
  width: number;
  height: number;
  display: DisplayInfo;
  /** 这张图实际覆盖的屏幕区域（驱动报回的事实）。坐标换算经它。 */
  contentRect: ScreenRect;
  windows: WindowInfo[];
  /** 截这张图时生效的白名单（已解析成 bundle id）。动作的白名单检查用它。 */
  allowBundleIds: string[];
  at: number;
}

/**
 * 一个 Run 的观察，分两槽（2026-10-03 代码评审 CU-R03）。
 *
 * 【定】动作的复核依据是**模型生成这一批调用时已经收到的**那张截图，不是「最近一张」。
 * 同一批 [screenshot, left_click] 里，点击的坐标是模型照着**上一批**的图定的 ——
 * 新截的这张它还没看到。此前截图一完成就覆盖依据，于是点击拿新图去和此刻的屏幕比，
 * 等于自己和自己比：屏幕换成了别的窗口，复核照样放行（评审的配对复现：单独 [click] 被拒，
 * [screenshot, click] 通过并点在了 Calculator 上）。执行前复核在这一种写法下整个失效，
 * 审批描述也跟着基于那张模型没看过的图。
 *
 * 判据用批次号推出，不用时间：一批调用对应模型的一次回复，模型生成第 N 批时，
 * 第 N 批之前所有批的结果都已经在它的上下文里 —— 所以「不是本批截的」就等于「看过的」。
 */
interface RunObservations {
  /** 模型已经看过的最近一张（更早的批截的）。动作复核与审批描述只认它。 */
  seen?: Observation;
  /** 本批刚截、模型还没看到的那张。下一批的第一个调用到来时才升成 seen。 */
  fresh?: { batchId: string; obs: Observation };
}

/**
 * 人在审批那一刻看到的目标（2026-10-03 代码评审 CU-R01）。由 `describeForApproval` 记下 ——
 * 只有它知道人看到的是什么；`execute` 取用一次。AUTO 档与有限自动放行下没有人看过审批描述，
 * 也就没有可绑定的东西，执行时照旧按当时的屏幕判。
 */
export type ApprovedTarget =
  /** `app: null` = 审批时没有前台应用 —— 人没有批准发给任何一个应用。 */
  | { kind: "keyboard"; app: AppRef | null }
  | { kind: "pointer"; window: WindowInfo };

const MAX_TYPE_CHARS = 2_000;

export class ComputerToolHandler implements ToolHandlerPort {
  private readonly observations = new Map<string, RunObservations>();
  /** 每个 Run 至多一条：审批是逐个动作串行的（settle-batch ④ 审批之后紧接着执行）。 */
  private readonly approvedTargets = new Map<string, { actionId: string; target: ApprovedTarget }>();

  constructor(private readonly opts: ComputerHandlerOptions) {}

  handles(toolName: string): boolean {
    return (
      toolName === SCREENSHOT_TOOL ||
      (toolName === COMPUTER_TOOL && this.opts.config.level === "control")
    );
  }

  /**
   * 硬拒绝名单的开关：只有「浏览器」一类可以被 `--computer-allow-browsers` 解除（ADR-0015）。
   * 读的是**冻结在工具定义里的那份配置**（版本摘要含它），不是运行时的全局状态。
   */
  private denyOpts(): { allowBrowsers: boolean } {
    return { allowBrowsers: this.opts.config.allowBrowsers };
  }

  /**
   * 这个动作依据的截图：模型生成它所在那一批时**已经收到**的最近一张（见 `RunObservations`）。
   * 动作复核与审批描述共用它 —— 两处各取一张的话，人批准的与执行时核对的就不是同一张图。
   */
  baselineFor(action: PreparedAction): Observation | undefined {
    const slot = this.observations.get(String(action.runId));
    if (!slot) return undefined;
    if (slot.fresh && slot.fresh.batchId !== String(action.batchId)) {
      slot.seen = slot.fresh.obs;
      slot.fresh = undefined;
    }
    return slot.seen;
  }

  /**
   * 审批描述生成时记下人看到的目标（CU-R01）。下一次 `execute` 只在动作 id 吻合时取用，
   * 被拒绝的动作留下的那条会被同一 Run 的下一次执行清掉。
   */
  noteApprovedTarget(action: PreparedAction, target: ApprovedTarget): void {
    this.approvedTargets.set(String(action.runId), { actionId: String(action.id), target });
  }

  private takeApprovedTarget(action: PreparedAction): ApprovedTarget | undefined {
    const runId = String(action.runId);
    const slot = this.approvedTargets.get(runId);
    this.approvedTargets.delete(runId);
    return slot && slot.actionId === String(action.id) ? slot.target : undefined;
  }

  async execute(action: PreparedAction, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    if (action.toolName === SCREENSHOT_TOOL) return this.screenshot(action);
    return this.act(action, ctx);
  }

  // ─────────────────────────────────────────────────────────── 截图

  private async screenshot(action: PreparedAction): Promise<ToolExecutionOutcome> {
    const perm = await this.permissionsOrError("截图");
    if (perm) return perm;

    let allow: { bundleIds: string[]; unresolved: string[]; denied: string[] };
    let shot;
    try {
      allow = await this.resolveAllow();
      shot = await this.opts.driver.capture({
        allowBundleIds: allow.bundleIds,
        maxLongEdgePx: this.opts.vision.preferredScreenshotLongEdgePx,
      });
    } catch (err) {
      return fail("TOOL_GUI_CAPTURE_FAILED", "UNAVAILABLE", "AFTER_ENVIRONMENT_CHANGE", "NO_EFFECT",
        `截图失败：${String((err as Error)?.message ?? err).slice(0, 200)}。` +
          "如果白名单应用在另一个桌面（Space）上、或者另一个应用正全屏占着当前桌面，" +
          "先用 computer 的 activate_app 把白名单应用切到前台，再截图。");
    }

    const obs: Observation = {
      screenshotId: shot.screenshotId,
      width: shot.width,
      height: shot.height,
      display: shot.display,
      contentRect: shot.contentRect,
      windows: shot.windows,
      allowBundleIds: allow.bundleIds,
      at: Date.now(),
    };
    // 先让上一批截的那张升成 seen，再把这张放进 fresh —— 它要等下一批才算模型看过（CU-R03）。
    this.baselineFor(action);
    const slot = this.observations.get(String(action.runId)) ?? {};
    slot.fresh = { batchId: String(action.batchId), obs };
    this.observations.set(String(action.runId), slot);

    const captured = shot.capturedApps.map((a) => a.name);
    const notes: string[] = [];
    if (captured.length === 0) {
      notes.push("白名单应用都没有窗口在屏幕上，所以截图是空白的；可以用 computer 的 activate_app 把应用切到前台。");
    }
    if (allow.unresolved.length > 0) {
      notes.push(`白名单里这些应用当前没有运行、或在本机找不到：${allow.unresolved.join("、")}。`);
    }
    if (allow.denied.length > 0) {
      notes.push(`白名单里这些应用解析后命中了硬拒绝名单，已排除：${allow.denied.join("；")}。`);
    }
    return {
      ok: true,
      sideEffectState: "NO_EFFECT",
      output: JSON.stringify({
        status: "OK",
        screenshot: { width: shot.width, height: shot.height },
        frontmostApp: shot.frontmost?.name ?? null,
        visibleApps: captured,
        note:
          "截图附在本结果里（只含白名单应用的窗口）。坐标用 0–1000 归一化：" +
          "(0,0) 左上、(1000,1000) 右下。只有最近几张截图会以图像形式留在上下文里。",
        ...(notes.length > 0 ? { warnings: notes } : {}),
      }),
      resources: [
        {
          kind: "image",
          label: `屏幕截图 ${shot.width}×${shot.height}`,
          mediaType: "image/png",
          content: shot.png,
        },
      ],
    };
  }

  // ─────────────────────────────────────────────────────────── 动作

  private async act(action: PreparedAction, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const input = (action.normalizedInput ?? {}) as Record<string, unknown>;
    const name = input["action"];
    // 无论走哪条分支都先取走：留着的话，它会被同一 Run 里下一个 id 相同的动作误用（不会发生，但不留）。
    const approved = this.takeApprovedTarget(action);
    if (!isComputerAction(name)) {
      return refuseInput(`computer 的 action 不认识：「${String(name)}」`);
    }

    if (name === "wait") {
      const seconds = num(input["seconds"]);
      if (seconds === undefined || seconds <= 0 || seconds > 10) {
        return refuseInput("wait 需要 seconds，取值 (0, 10]");
      }
      await sleep(seconds * 1000, ctx.signal);
      return { ok: true, sideEffectState: "NO_EFFECT", output: JSON.stringify({ status: "OK", action: name, waitedSeconds: seconds }) };
    }

    const perm = await this.permissionsOrError("操作屏幕");
    if (perm) return perm;

    if (name === "activate_app") return this.activate(input, ctx);

    const obs = this.baselineFor(action);
    if (!obs) {
      const sameBatch = this.observations.get(String(action.runId))?.fresh !== undefined;
      return stale("TOOL_GUI_NO_OBSERVATION",
        sameBatch
          ? "同一批里刚截的图你还没有看到 —— 这个动作的坐标不是照着它定的。先看截图结果，下一步再操作。"
          : "本次执行里还没有截过图，不知道屏幕现在是什么样子。先调用 screenshot 再操作。" +
            "（崩溃或重启之后，旧截图描述的不一定是现在的屏幕，必须重新截图。）");
    }

    if (name === "type" || name === "key") {
      return this.keyboard(name, input, obs, ctx, approved?.kind === "keyboard" ? approved : undefined);
    }
    return this.pointer(name, input, obs, ctx, approved?.kind === "pointer" ? approved.window : undefined);
  }

  private async pointer(
    name: "left_click" | "right_click" | "double_click" | "drag" | "scroll",
    input: Record<string, unknown>,
    obs: Observation,
    ctx: ToolExecutionContext,
    approvedWindow?: WindowInfo,
  ): Promise<ToolExecutionOutcome> {
    const from = normalizedPoint(input["x"], input["y"]);
    if (!from) return refuseInput(`${name} 需要 x、y，取值 0–1000（归一化坐标）`);
    const p = toPoints(from, obs.contentRect);

    let checked = await this.checkTarget(p, obs);
    let focusRestored = false;
    /**
     * 【定】审批界面挡住了人刚批准的那个窗口时，先把它切回前台再复核一遍（CU-R01）。
     *
     * 人批准一次点击，要先把焦点给审批界面（终端里敲 y、浏览器里点「批准」）——
     * 那个窗口一旦盖住目标点，复核看到的是「窗口变了」，于是人工审批下的点击
     * 取决于审批窗口摆在哪儿。只在三条同时成立时切：有人看过审批描述；人批准的窗口
     * 就是模型截图里那一处的窗口；现在挡在那里的是 Atlas 碰不了的东西（白名单外或硬拒绝）。
     * 切回之后**整套复核重来**（窗口身份 ＋ 画面），通过了才点 —— 切换本身不替复核作保。
     */
    if ("refusal" in checked && approvedWindow && this.coveredByUnreachable(checked.at, approvedWindow, obs, p)) {
      const restored = await this.restoreFocus({ bundleId: approvedWindow.bundleId, name: approvedWindow.appName }, obs, ctx);
      if (restored) return restored;
      focusRestored = true;
      checked = await this.checkTarget(p, obs);
    }
    if ("refusal" in checked) return checked.refusal;

    let req: DriverAction;
    let to: { x: number; y: number } | undefined;
    if (name === "drag") {
      const end = normalizedPoint(input["to_x"], input["to_y"]);
      if (!end) return refuseInput("drag 需要 to_x、to_y，取值 0–1000（归一化坐标）");
      to = toPoints(end, obs.contentRect);
      /**
       * 终点同样必须落在白名单应用上 —— 拖到别的应用里就是把内容交给了未授权的一方。
       * 【定】终点走**与起点同一套**复核（窗口身份 ＋ 白名单 ＋ 画面，2026-10-03 代码评审 CU-R05）。
       * 此前终点只查窗口身份与白名单、不比画面：同一个窗口里列表重排或滚动了，
       * 释放点就换成了另一个条目，而工具描述承诺的「画面变了就不做」在这一半不成立。
       */
      const endChecked = await this.checkTarget(to, obs, "拖拽终点");
      if ("refusal" in endChecked) return endChecked.refusal;
      req = { kind: "drag", fromX: p.x, fromY: p.y, toX: to.x, toY: to.y };
    } else if (name === "scroll") {
      const dir = String(input["direction"] ?? "down").toLowerCase();
      const amount = num(input["amount"]) ?? 3;
      if (!["up", "down", "left", "right"].includes(dir)) return refuseInput("scroll 的 direction 只能是 up / down / left / right");
      if (amount <= 0 || amount > 20) return refuseInput("scroll 的 amount 取值 (0, 20]");
      const n = Math.round(amount);
      req = {
        kind: "scroll", x: p.x, y: p.y,
        dx: dir === "left" ? n : dir === "right" ? -n : 0,
        dy: dir === "up" ? n : dir === "down" ? -n : 0,
      };
    } else {
      req = {
        kind: "click",
        button: name === "right_click" ? "right" : "left",
        count: name === "double_click" ? 2 : 1,
        x: p.x,
        y: p.y,
      };
    }

    const done = await this.perform(req, obs.allowBundleIds, ctx);
    if (done) return done;
    await sleep(this.opts.settleMs ?? 300, ctx.signal);
    return {
      ok: true,
      sideEffectState: "APPLIED",
      output: JSON.stringify({
        status: "OK",
        action: name,
        target: { app: checked.window.appName, window: checked.window.title ?? null },
        at: { x: from.x, y: from.y },
        ...(to ? { to: { x: num(input["to_x"]), y: num(input["to_y"]) } } : {}),
        ...(focusRestored ? { focusRestored: true } : {}),
        note:
          (focusRestored ? `审批界面挡住了目标，已先把「${checked.window.appName}」切回前台、复核通过后再执行。` : "") +
          "动作已执行。要确认结果请重新截图。",
      }),
    };
  }

  /** ②③④ 三道检查。通过时返回目标窗口；拒绝时带上此刻该点的窗口（审批后切回焦点要用）。 */
  private async checkTarget(
    p: { x: number; y: number },
    obs: Observation,
    where = "目标处",
  ): Promise<{ window: WindowInfo } | { refusal: ToolExecutionOutcome; at: WindowInfo | null }> {
    const probe = await this.opts.driver.probe({
      x: p.x,
      y: p.y,
      screenshotId: obs.screenshotId,
      radiusPt: this.opts.regionRadiusPt ?? 24,
    });
    /**
     * ── 【定】先问「变没变」，再问「许不许」（ADR-0014）────────────────────
     *
     * 两种拒绝都什么都不投递，差别在**谁错了**：
     *   · 截图之后目标处换了一个窗口（哪怕换成的是 Terminal）—— 世界变了，模型照着
     *     当时的截图做的，没有错 → STATE_CHANGED（AFTER_REOBSERVATION，不计入连续失败）；
     *   · 截图时那里就是一个白名单外的窗口 / 桌面 —— 模型瞄错了地方 → NOT_ALLOWED /
     *     DENIED（照常计入）。
     * 反过来排的话，「截图后冒出来一个 Finder 窗口」会被记成模型的失败，
     * 屏幕一动就把 Run 往 MAX_CONSECUTIVE_FAILURES 推 —— ADR-0013 代价 ⑥ 的形状。
     */
    const at = probe.windowAtPoint;
    const changed = changedSince(obs, p, at, where);
    if (changed) return { refusal: changed, at };
    const refusal = targetRefusal(at, obs.allowBundleIds, where, this.denyOpts());
    if (refusal) return { refusal, at };
    const now = at!;

    const diff = this.regionRefusal(probe.regionDiff, where);
    if (diff) return { refusal: diff, at };
    return { window: now };
  }

  /** ④ 画面：区域灰度差。起点与拖拽终点共用同一条判定（CU-R05）。 */
  private regionRefusal(regionDiff: number | null, where: string): ToolExecutionOutcome | undefined {
    if (regionDiff === null) {
      return stale("TOOL_GUI_STATE_CHANGED",
        "你依据的那张截图已经失效（驱动重启过，或已被更新的截图替换）。重新截图再操作。");
    }
    const max = this.opts.maxRegionDiff ?? 12;
    if (regionDiff > max) {
      return stale("TOOL_GUI_STATE_CHANGED",
        `${where}的画面在你上次截图之后变了（区域灰度差 ${regionDiff.toFixed(1)} > ${max}）。` +
          "可能弹出了窗口、内容滚动了或界面还在变化。重新截图再决定。");
    }
    return undefined;
  }

  /**
   * 该点此刻是不是被 Atlas 碰不了的东西挡住了人批准的那个窗口（审批界面就是这一类：
   * 终端、IDE、浏览器都在硬拒绝名单上；也包括白名单外的应用）。
   * 挡在那里的若是**另一个白名单应用**，不算 —— 那是世界变了，照常按 STATE_CHANGED 拒绝。
   */
  private coveredByUnreachable(
    at: WindowInfo | null,
    approvedWindow: WindowInfo,
    obs: Observation,
    p: { x: number; y: number },
  ): boolean {
    if (windowAt(obs.windows, p)?.windowId !== approvedWindow.windowId) return false;
    if (!at || at.windowId === approvedWindow.windowId) return false;
    return !this.reachable({ bundleId: at.bundleId, name: at.appName }, obs.allowBundleIds);
  }

  /** 白名单内且不在硬拒绝名单上 —— Atlas 能对它动手的应用。 */
  private reachable(app: { bundleId: string; name: string }, allowBundleIds: string[]): boolean {
    return allowBundleIds.includes(app.bundleId) && !hardDeniedReason(app, this.denyOpts());
  }

  /**
   * 把焦点还给人刚批准的那个应用（CU-R01）。返回 undefined = 已切过去；否则是该返回的失败结果。
   *
   * 【定】切换用的是同一条 `activate` 原语、同一道驱动第二重检查（只许这一个 bundle id），
   * 而切过去的只能是**人在审批描述里看到的那个应用** —— 这不是替模型多做一步，
   * 是把审批界面自己拿走的焦点还回去，回到人批准时的那个状态。
   */
  private async restoreFocus(
    app: { bundleId: string; name: string },
    obs: Observation,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionOutcome | undefined> {
    const denied = hardDeniedReason(app, this.denyOpts());
    if (denied) return refuse("TOOL_GUI_TARGET_DENIED", `审批时的目标「${app.name}」属于不可操作的一类：${denied}。`);
    if (!obs.allowBundleIds.includes(app.bundleId)) {
      return refuse("TOOL_GUI_FOCUS_NOT_ALLOWED", `审批时的目标「${app.name}」不在白名单里，不切回前台、也不输入。`);
    }
    const done = await this.perform({ kind: "activate", bundleId: app.bundleId }, [app.bundleId], ctx);
    if (done) return done;
    await sleep(this.opts.settleMs ?? 300, ctx.signal);
    return undefined;
  }

  private async keyboard(
    name: "type" | "key",
    input: Record<string, unknown>,
    obs: Observation,
    ctx: ToolExecutionContext,
    approved?: { kind: "keyboard"; app: AppRef | null },
  ): Promise<ToolExecutionOutcome> {
    const text = typeof input["text"] === "string" ? input["text"] : "";
    // 入参先校验：不合法的输入不该先切一次焦点再被拒。
    let payload: { kind: "type"; text: string } | { kind: "key"; key: string; modifiers: KeyModifier[] };
    if (name === "type") {
      if (text.length === 0) return refuseInput("type 需要非空的 text");
      if ([...text].length > MAX_TYPE_CHARS) return refuseInput(`type 一次最多 ${MAX_TYPE_CHARS} 个字符`);
      payload = { kind: "type", text };
    } else {
      const parsed = parseKeyCombo(text);
      if ("error" in parsed) return refuseInput(parsed.error);
      payload = { kind: "key", key: parsed.key, modifiers: parsed.modifiers };
    }

    let probe = await this.opts.driver.probe({});
    let focusRestored = false;
    /**
     * ── 【定】键盘目标绑定人批准的那个应用（CU-R01）──────────────────────────
     *
     * 此前执行时现读前台、直接用它的 pid：审批卡写着「发给 TextEdit」，执行时前台若换成了
     * Calculator，字就打进了 Calculator（评审复现）。更常见的是人工审批本身：在终端敲 y、
     * 在浏览器点「批准」都会把前台交给审批界面，而终端与浏览器都在硬拒绝名单上 ——
     * DEFAULT / CONFIRM 档下**每一次打字都必然被拒**，实测全用 AUTO 档才没撞上。
     *
     * 现在有人看过审批描述时，目标就是人看到的那个应用（pid 精确到进程）：
     *   · 焦点被 Atlas 碰不了的东西拿走（审批界面、白名单外的应用）→ 切回那个应用，再核对；
     *   · 焦点被**另一个白名单应用**拿走 → 拒绝（观察过期），**绝不改发**给它。
     * 没有人看过（AUTO / 有限自动放行）时照旧发给此刻的前台 —— 那里没有一个「批准时的目标」可比。
     */
    if (approved && approved.app === null) {
      return refuse("TOOL_GUI_FOCUS_NOT_ALLOWED", "审批时没有前台应用 —— 人没有批准把这段输入发给任何一个应用。先用 activate_app 切到白名单应用。");
    }
    const approvedApp = approved?.app ?? undefined;
    if (approvedApp && probe.frontmost?.pid !== approvedApp.pid) {
      const now = probe.frontmost;
      if (now && this.reachable(now, obs.allowBundleIds)) {
        return stale("TOOL_GUI_FOCUS_CHANGED",
          `审批时前台是「${approvedApp.name}」，现在是「${now.name}」（也在白名单里）。` +
            "批准给前者的输入不会改发给后者；重新截图再决定。");
      }
      const restored = await this.restoreFocus(approvedApp, obs, ctx);
      if (restored) return restored;
      focusRestored = true;
      probe = await this.opts.driver.probe({});
      if (probe.frontmost?.pid !== approvedApp.pid) {
        return stale("TOOL_GUI_FOCUS_CHANGED",
          `已尝试把「${approvedApp.name}」切回前台，但现在前台是「${probe.frontmost?.name ?? "（无）"}」。` +
            "键盘输入没有发出；重新截图再决定。");
      }
    }
    const front = probe.frontmost;
    if (!front) return refuse("TOOL_GUI_FOCUS_NOT_ALLOWED", "现在没有前台应用，键盘输入不知道发给谁。");
    const denied = hardDeniedReason({ bundleId: front.bundleId, name: front.name }, this.denyOpts());
    if (denied) {
      return refuse("TOOL_GUI_TARGET_DENIED", `前台应用「${front.name}」属于不可操作的一类：${denied}。`);
    }
    if (!obs.allowBundleIds.includes(front.bundleId)) {
      return refuse("TOOL_GUI_FOCUS_NOT_ALLOWED",
        `前台应用是「${front.name}」，不在白名单里，键盘输入不会发给它。先用 activate_app 切到白名单应用。`);
    }
    /**
     * 【定】安全输入开启（密码框获得焦点）时拒绝，而不是想办法绕过。
     * 那是系统在说「这里在输密码」—— 合成键盘事件往里打字，等于让模型
     * 替用户输入凭证。需要密码就请人来（request_handoff）。
     */
    if (probe.secureInput) {
      return refuse("TOOL_GUI_SECURE_INPUT",
        "系统的安全输入已开启（密码框获得了焦点），拒绝合成键盘输入。需要输入密码请用 request_handoff 请人来做。");
    }
    const req: DriverAction = { ...payload, pid: front.pid };
    const done = await this.perform(req, obs.allowBundleIds, ctx);
    if (done) return done;
    return {
      ok: true,
      sideEffectState: "APPLIED",
      output: JSON.stringify({
        status: "OK",
        action: name,
        target: { app: front.name },
        ...(name === "type" ? { chars: [...text].length } : { key: text }),
        ...(focusRestored ? { focusRestored: true } : {}),
        note:
          (focusRestored ? `审批界面拿走了焦点，已先把「${front.name}」切回前台再输入。` : "") +
          "已发给前台应用。要确认结果请重新截图。",
      }),
    };
  }

  private async activate(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const query = typeof input["app"] === "string" ? input["app"].trim() : "";
    if (!query) return refuseInput("activate_app 需要 app（白名单里的应用名或 bundle id）");
    const rule = this.opts.config.apps.find(
      (r) => r.raw.toLowerCase() === query.toLowerCase(),
    );
    if (!rule) {
      return refuse("TOOL_GUI_TARGET_NOT_ALLOWED",
        `「${query}」不在白名单里。可用：${this.opts.config.apps.map((a) => a.raw).join("、")}。`);
    }
    const [resolved] = await this.opts.driver.resolveApps([rule.raw]);
    if (!resolved?.bundleId) {
      return refuse("TOOL_GUI_APP_NOT_FOUND", `在本机找不到应用「${rule.raw}」。`);
    }
    const denied = hardDeniedReason({ bundleId: resolved.bundleId, name: resolved.name ?? "" }, this.denyOpts());
    if (denied) return refuse("TOOL_GUI_TARGET_DENIED", `「${rule.raw}」解析为 ${resolved.bundleId}，属于不可操作的一类：${denied}。`);
    const done = await this.perform({ kind: "activate", bundleId: resolved.bundleId }, [resolved.bundleId], ctx);
    if (done) return done;
    return {
      ok: true,
      sideEffectState: "APPLIED",
      output: JSON.stringify({
        status: "OK",
        action: "activate_app",
        app: resolved.name ?? rule.raw,
        note: "已切到前台（没运行的会被打开）。重新截图看它现在的样子。",
      }),
    };
  }

  // ─────────────────────────────────────────────────────────── 公共

  /**
   * 投递。返回 undefined = 成功；否则是该返回的失败结果。
   *
   * 【定】驱动返回失败 → NOT_STARTED（驱动保证什么都没投递）；
   * 驱动**抛异常** → UNKNOWN：事件可能投递了一半，不得自动重试（不变量 10）。
   *
   * 【定】投递前最后看一眼取消信号（2026-10-03 代码评审 CU-R02）。复核要等驱动
   * 截图比对（真助手上 0.1–0.3 秒），取消请求落在这段等待里时，此前照样投递 ——
   * 一个本来还没发生的副作用在「取消之后」发生了，事实表如实记成 APPLIED，但它本不该发生。
   * 这里是最后一个「还什么都没做」的时刻；请求一旦交给助手就收不回来（事件可能已经投递），
   * 所以不把 signal 传进驱动请求假装能中途撤销 —— 那会把「投了没投」从确定变成不确定。
   */
  private async perform(
    req: DriverAction,
    allowBundleIds: string[],
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionOutcome | undefined> {
    if (ctx.signal.aborted) {
      return {
        ok: false,
        output: "",
        sideEffectState: "NOT_STARTED",
        error: makeError({
          code: "TOOL_CANCELLED",
          source: "RUNTIME",
          category: "CANCELLED",
          retryability: "SAME_INPUT_IMMEDIATE",
          sideEffectState: "NOT_STARTED",
          safeMessage: `computer ${req.kind} 在投递之前被取消，什么都没有发出`,
        }),
      };
    }
    let r;
    try {
      r = await this.opts.driver.perform(req, { allowBundleIds, allowBrowsers: this.opts.config.allowBrowsers });
    } catch (err) {
      return fail("TOOL_GUI_DRIVER_FAILED", "INTERNAL", "AFTER_USER_ACTION", "UNKNOWN",
        `GUI 驱动在投递动作时出错，动作可能已部分执行：${String((err as Error)?.message ?? err).slice(0, 200)}。先截图确认状态。`);
    }
    if (r.ok) return undefined;
    return refuse(`TOOL_GUI_${r.code}`, `GUI 驱动拒绝了这个动作：${r.message}`);
  }

  private async permissionsOrError(what: string): Promise<ToolExecutionOutcome | undefined> {
    let p;
    try {
      p = await this.opts.driver.permissions();
    } catch (err) {
      return fail("TOOL_GUI_DRIVER_UNAVAILABLE", "UNAVAILABLE", "AFTER_ENVIRONMENT_CHANGE", "NOT_STARTED",
        `GUI 驱动不可用：${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
    const missing = [
      ...(p.screenRecording ? [] : ["录屏与系统录音（截图用）"]),
      ...(p.accessibility ? [] : ["辅助功能（点击、输入用）"]),
    ];
    if (missing.length === 0) return undefined;
    /**
     * 【定】缺授权时关掉助手。系统授权对**已经在跑**的进程不一定生效 ——
     * 用户在系统设置里勾上之后，下一次调用会重新拉起一个助手，读到新的授权状态。
     * 不关的话，用户授权完还得重启整个 Atlas，而他不会知道要这么做。
     */
    await this.opts.driver.close().catch(() => undefined);
    return fail("TOOL_GUI_PERMISSION_REQUIRED", "AUTHORIZATION", "AFTER_USER_ACTION", "NOT_STARTED",
      `${what}需要系统授权，当前缺：${missing.join("、")}。这件事只能由用户本人在「系统设置 → 隐私与安全性」里授予` +
        "（授予对象是「Atlas GUI Helper」），可以运行 npm run computer:doctor -- --request 触发授权提示。" +
        "不要尝试绕过；请在总结里告诉用户需要授权。");
  }

  /** 把白名单解析成 bundle id。没运行的名字解析不到时如实列出。 */
  private async resolveAllow(): Promise<{ bundleIds: string[]; unresolved: string[]; denied: string[] }> {
    const resolved: ResolvedApp[] = await this.opts.driver.resolveApps(this.opts.config.apps.map((a) => a.raw));
    const bundleIds: string[] = [];
    const unresolved: string[] = [];
    const denied: string[] = [];
    for (const r of resolved) {
      if (!r.bundleId) {
        unresolved.push(r.query);
        continue;
      }
      const why = hardDeniedReason({ bundleId: r.bundleId, name: r.name ?? "" }, this.denyOpts());
      if (why) {
        denied.push(`${r.query}（${r.bundleId}：${why}）`);
        continue;
      }
      // 名字规则解析出的应用必须真的与规则吻合（防止驱动给出意外的匹配）。
      const rule = this.opts.config.apps.find((a) => a.raw === r.query);
      if (rule && rule.kind === "NAME" && r.name && !ruleMatches(rule, { bundleId: r.bundleId, name: r.name })) {
        unresolved.push(r.query);
        continue;
      }
      if (!bundleIds.includes(r.bundleId)) bundleIds.push(r.bundleId);
    }
    return { bundleIds, unresolved, denied };
  }
}

// ═════════════════════════════════════════════════════════════ 工具函数

export function toPoints(p: { x: number; y: number }, area: ScreenRect): { x: number; y: number } {
  /**
   * 【定】归一化 → 逻辑点：只依赖**截图实际覆盖的区域**（驱动报回的 `contentRect`），
   * **不依赖截图像素尺寸**，也**不假设**那个区域就是整块显示器。
   *
   * 两条各自栽过：用像素数去乘归一化坐标，在缩放比 ≠ 1 的屏幕上会得到一个不报错的系统性偏移
   * （`verify:computer` E 段用「点数 ≠ 截图像素 ≠ 1000」的夹具钉着）；把截图当成整块显示器，
   * 在 macOS 26 的「只包含白名单应用」过滤器下每一下都点偏（第一次真桌面运行，ADR-0014）。
   */
  return {
    x: area.x + Math.min(area.width - 1, Math.max(0, (p.x / 1000) * area.width)),
    y: area.y + Math.min(area.height - 1, Math.max(0, (p.y / 1000) * area.height)),
  };
}

/** 截图快照里，覆盖该点的最上层窗口（窗口表是前到后排序的）。 */
export function windowAt(windows: WindowInfo[], p: { x: number; y: number }): WindowInfo | undefined {
  return windows.find((w) => p.x >= w.x && p.x < w.x + w.width && p.y >= w.y && p.y < w.y + w.height);
}

/**
 * 目标处的窗口与截图那一刻相比变没变（窗口身份）。变了返回 STATE_CHANGED（观察已过期）。
 * 「出现 / 消失」也算变：截图时是空白、现在冒出一个窗口，或者反过来。
 */
function changedSince(
  obs: Observation,
  p: { x: number; y: number },
  now: WindowInfo | null,
  where: string,
): ToolExecutionOutcome | undefined {
  const then = windowAt(obs.windows, p);
  if ((then?.windowId ?? null) === (now?.windowId ?? null)) return undefined;
  return stale("TOOL_GUI_STATE_CHANGED",
    `${where}的窗口在你上次截图之后变了（截图时是「${then?.appName ?? "空白"}」，` +
      `现在是「${now ? `${now.appName}${now.title ? `·${now.title}` : ""}` : "空白"}」）。重新截图再决定。`);
}

function targetRefusal(
  w: WindowInfo | null,
  allowBundleIds: string[],
  where: string,
  opts: { allowBrowsers?: boolean },
): ToolExecutionOutcome | undefined {
  if (!w) return refuse("TOOL_GUI_TARGET_NOT_ALLOWED", `${where}没有任何窗口（桌面或空白区域），不点。`);
  const denied = hardDeniedReason({ bundleId: w.bundleId, name: w.appName }, opts);
  if (denied) return refuse("TOOL_GUI_TARGET_DENIED", `${where}是「${w.appName}」，属于不可操作的一类：${denied}。`);
  if (!allowBundleIds.includes(w.bundleId)) {
    return refuse("TOOL_GUI_TARGET_NOT_ALLOWED", `${where}是「${w.appName}」的窗口，不在白名单里，不点。`);
  }
  return undefined;
}

function normalizedPoint(x: unknown, y: unknown): { x: number; y: number } | undefined {
  const nx = num(x);
  const ny = num(y);
  if (nx === undefined || ny === undefined) return undefined;
  if (nx < 0 || nx > 1000 || ny < 0 || ny > 1000) return undefined;
  return { x: nx, y: ny };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function refuse(code: string, message: string): ToolExecutionOutcome {
  return fail(code, "AUTHORIZATION", "AFTER_MODEL_CORRECTION", "NOT_STARTED", message);
}

/**
 * 观察已过期的拒绝（ADR-0014）：什么都没做，重新截图再来。
 * `AFTER_REOBSERVATION` ＋ `NOT_STARTED` 让 Runtime 不把它计入连续失败。
 */
function stale(code: string, message: string): ToolExecutionOutcome {
  return fail(code, "CONFLICT", "AFTER_REOBSERVATION", "NOT_STARTED", message);
}

function refuseInput(message: string): ToolExecutionOutcome {
  return {
    ok: false,
    output: "",
    sideEffectState: "NOT_STARTED",
    error: makeError({
      code: "TOOL_GUI_INPUT_INVALID",
      source: "TOOL_INPUT",
      category: "VALIDATION",
      retryability: "AFTER_MODEL_CORRECTION",
      sideEffectState: "NOT_STARTED",
      safeMessage: message,
    }),
  };
}

function fail(
  code: string,
  category: RuntimeErrorRecord["category"],
  retryability: RuntimeErrorRecord["retryability"],
  sideEffectState: ToolExecutionOutcome["sideEffectState"],
  message: string,
): ToolExecutionOutcome {
  return {
    ok: false,
    output: "",
    sideEffectState,
    error: makeError({ code, source: "TOOL_HANDLER", category, retryability, sideEffectState, safeMessage: message }),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
