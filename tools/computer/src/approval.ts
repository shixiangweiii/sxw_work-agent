/**
 * 审批面要展示的「这一步到底要点哪」（ADR-0013）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】只打坐标的审批是盲批。
 *
 *     是否允许 computer 执行 EXECUTE → left_click @ (500, 300)/1000 ？
 *
 * —— 「点保存」与「点删除」在这一行里长得一模一样，与 `run_shell` 那条
 * 「只打程序名的审批是盲批」同一个形状。所以审批时要查出：那个点上是哪个应用、
 * 哪个窗口、哪个控件（AX），以及它依据的是哪一次截图。
 *
 * 【定】这里查到的是**审批那一刻**的事实。执行前 handler 还会再核对一次窗口
 * 身份与画面（`checkTarget`）—— 人批准之后屏幕又变了，动作会被拒绝，
 * 而不是照着一个已经过时的批准去点。
 *
 * 【定】这里同时**记下人看到的目标**（`handler.noteApprovedTarget`，2026-10-03 代码评审
 * CU-R01）：键盘发给哪个进程、点的是哪个窗口。执行时据此判断「焦点是被审批界面拿走的
 * （切回来）还是被另一个白名单应用拿走的（拒绝）」。记在这里而不是让两个入口各自回传，
 * 是因为只有这个函数知道人看到了什么 —— CLI 与 Web 各接一遍，迟早有一边漏接，
 * 而漏接的那一边看起来完全正常，只是又回到「执行时现读前台」。
 *
 * 【定】依据的截图与 handler 是**同一张**（`baselineFor`：模型生成这一批时已经看过的那张，
 * CU-R03）。各取一张的话，人批准的与执行时核对的就不是同一张图。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { PreparedAction } from "@workagent/harness-runtime";
import { COMPUTER_TOOL, SCREENSHOT_TOOL } from "./definitions.js";
import type { ComputerDriver } from "./driver.js";
import { toPoints, windowAt, type ComputerToolHandler } from "./handler.js";

export interface ComputerApprovalView {
  /** 一句话：要做什么。 */
  summary: string;
  /** 细节行：目标应用 / 窗口 / 控件、坐标换算、依据的截图、警告。 */
  details: string[];
  /** 归一化坐标（审批卡在最近一张截图上画标记用）。键盘动作没有。 */
  point?: { x: number; y: number };
  toPoint?: { x: number; y: number };
}

/** JSON 字符串形态，并把展示层会剥掉的不可见字符写成 `\uXXXX`。 */
export function visibleText(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export async function describeForApproval(
  action: PreparedAction,
  handler: ComputerToolHandler,
  driver: ComputerDriver,
): Promise<ComputerApprovalView | undefined> {
  if (action.toolName !== COMPUTER_TOOL && action.toolName !== SCREENSHOT_TOOL) return undefined;
  const input = (action.normalizedInput ?? {}) as Record<string, unknown>;
  const name = String(input["action"] ?? "");
  const obs = handler.baselineFor(action);
  const details: string[] = [];

  const ageNote = (): string =>
    obs ? `依据：${Math.max(0, Math.round((Date.now() - obs.at) / 1000))} 秒前的那张截图` : "本次执行里还没有截图 —— 执行时会被拒绝";

  try {
    if (["left_click", "right_click", "double_click", "drag", "scroll"].includes(name)) {
      const nx = Number(input["x"]);
      const ny = Number(input["y"]);
      const point = { x: nx, y: ny };
      if (!obs || !Number.isFinite(nx) || !Number.isFinite(ny)) {
        return { summary: `${name} @ (${input["x"]}, ${input["y"]})/1000`, details: [ageNote()], point };
      }
      const p = toPoints(point, obs.contentRect);
      const then = windowAt(obs.windows, p);
      const now = await driver.describe(p.x, p.y);
      const target = now.window;
      details.push(
        `目标应用：${target ? `${target.appName}${target.title ? ` · 窗口「${target.title}」` : ""}` : "（该处没有窗口）"}`,
      );
      if (now.element) {
        const e = now.element;
        const label = [e.title, e.description, e.value].filter((x) => x && x.trim()).join(" / ");
        details.push(`目标控件：${e.role ?? "未知角色"}${label ? `「${label.slice(0, 80)}」` : ""}`);
      }
      details.push(`坐标：(${nx}, ${ny})/1000 → (${Math.round(p.x)}, ${Math.round(p.y)}) pt`);
      details.push(ageNote());
      if (then && target && then.windowId !== target.windowId) {
        details.push("⚠️ 该处的窗口与截图时不同 —— 即使批准，执行前复核也会拒绝它");
      }
      if (target) {
        handler.noteApprovedTarget(action, { kind: "pointer", window: target });
        details.push(`批准之后，如果审批界面（终端 / 浏览器）挡住了这个位置，会先把「${target.appName}」切回前台、复核通过再执行`);
      }
      const view: ComputerApprovalView = { summary: `${name} → ${target?.appName ?? "（空白）"}`, details, point };
      if (name === "drag") {
        view.toPoint = { x: Number(input["to_x"]), y: Number(input["to_y"]) };
        details.push(`拖到：(${input["to_x"]}, ${input["to_y"]})/1000`);
      }
      return view;
    }

    if (name === "type" || name === "key") {
      const probe = await driver.probe({});
      const front = probe.frontmost;
      const text = typeof input["text"] === "string" ? input["text"] : "";
      handler.noteApprovedTarget(action, { kind: "keyboard", app: front });
      details.push(`发给：${front?.name ?? "（没有前台应用 —— 执行时会被拒绝）"}（审批这一刻的前台应用）`);
      if (front) {
        details.push(
          `批准之后会发给「${front.name}」这个进程：焦点若被审批界面拿走，先把它切回前台再输入；` +
            "若换成了另一个白名单应用，则不输入",
        );
      }
      /**
       * 【定】要输入的文字**全文**展示，而且是「看得见每一个字符」的形态（2026-10-03 代码评审 CU-R10）。
       * 此前只给前 200 字，而 `type` 一次最多 2000 字：人批准的是前 200 字，打出去的是全部。
       * 展示成 JSON 字符串：换行、制表、首尾空格都看得见；不可见字符（双向覆盖、零宽）
       * 转成 `\uXXXX` —— 展示层会把这些字符**剥掉**（防伪造），不先转义的话，
       * 人看到的就是一段「干净」的文字，而真正打出去的带着它们。
       */
      if (name === "type") details.push(`将输入（${[...text].length} 字，按 JSON 字符串原样展示）：${visibleText(text)}`);
      else details.push(`将按键：${visibleText(text)}`);
      if (probe.secureInput) details.push("⚠️ 安全输入已开启（密码框有焦点）—— 执行时会被拒绝");
      details.push(ageNote());
      return { summary: `${name} → ${front?.name ?? "?"}`, details };
    }

    if (name === "activate_app") {
      return { summary: `切换到应用 ${String(input["app"] ?? "")}`, details: ["把这个应用切到前台；没运行的会被打开"] };
    }
  } catch (err) {
    details.push(`（查询目标信息失败：${String((err as Error)?.message ?? err).slice(0, 120)}）`);
  }
  return { summary: name || action.toolName, details };
}
