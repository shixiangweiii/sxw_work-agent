/**
 * computer use 的受信任 Resolver（ADR-0013）。
 *
 * 【定】它住在 `tools/computer`，不在 Runtime 的 `action/` —— 与 `ShellEffectResolver`
 * 同一条边界（边界 7 / 15）：Runtime 只认 `TrustedEffectResolver` 这个类型，
 * 不认识「屏幕」「点击」这些概念。
 *
 * 【定】`resolve()` 是同步的、拿不到屏幕 —— 它只能描述**模型请求了什么**
 * （动作、归一化坐标），说不出「那里是哪个应用的哪个控件」。后者在审批时由
 * `describeForApproval()` 异步查出来，执行前由 handler 再核对一次。
 */

import { digest, type JsonValue, type ResolvedEffect, type TrustedEffectResolver } from "@workagent/harness-runtime";
import { describeAllowlist, type ComputerUseConfig } from "./config.js";
import { COMPUTER_ACTIONS, isComputerAction } from "./definitions.js";

export class ScreenshotEffectResolver implements TrustedEffectResolver {
  constructor(private readonly config: ComputerUseConfig) {}

  resolve(normalizedInput: JsonValue): ResolvedEffect {
    const allow = describeAllowlist(this.config);
    return {
      effectType: "READ",
      operation: "GUI screenshot",
      scope: { kind: "GUI", value: `截图（只含白名单应用：${allow}）` },
      reversibility: "REVERSIBLE",
      /**
       * 【定】截图是 READ，但不是「没有风险」：屏幕内容会原样发往模型端点，
       * 图像也脱敏不了。这条 riskFact ＋ dataMovement 让每一次外发都在 Trace 上可审计
       * —— 与 `fetch_url` 那条护栏 ③ 同一个形态。
       */
      riskFacts: ["SCREEN_CONTENT_SENT_TO_MODEL_ENDPOINT"],
      dataMovement: { destination: "模型端点", scope: `屏幕截图（仅白名单应用的窗口：${allow}）` },
      digest: digest(JSON.stringify(normalizedInput ?? {})),
    };
  }
}

export class ComputerEffectResolver implements TrustedEffectResolver {
  resolve(normalizedInput: JsonValue): ResolvedEffect {
    const input = (normalizedInput ?? {}) as Record<string, unknown>;
    const action = input["action"];
    if (!isComputerAction(action)) {
      // 抛 → settle-batch 记 REJECTED_SCHEMA 并把这句话交给模型（它改得过来）。
      throw new Error(`computer 的 action 不认识：「${String(action)}」。可用：${COMPUTER_ACTIONS.join(" / ")}`);
    }
    const d = digest(JSON.stringify(input));
    const at = (): string => `(${fmt(input["x"])}, ${fmt(input["y"])})/1000`;

    if (action === "wait") {
      return {
        effectType: "NONE",
        operation: "GUI wait",
        scope: { kind: "GUI", value: `等待 ${fmt(input["seconds"])} 秒` },
        reversibility: "REVERSIBLE",
        riskFacts: [],
        digest: d,
      };
    }

    /**
     * 【定】GUI 动作一律 EXECUTE ＋ IRREVERSIBLE。
     *
     * 一次点击能做的事没有上限（发送、删除、确认支付），而 Atlas 在执行前
     * 无法知道它会触发什么。IRREVERSIBLE 让 DEFAULT 档的有限自动放行永远不覆盖它
     * （`autoGrantVerdict` 的 ② 条）；EXECUTE 让 Policy 在 CONFIRM / DEFAULT 档
     * 都停下来问。
     *
     * 【定】riskFacts 里的 `GUI_INPUT_NOT_SANDBOXED` 是对 ADR-0012 那条轴的**更正**：
     * 无论 `--sandbox` 是哪一档，GUI 动作都在别的应用进程里生效，沙箱对它不成立。
     */
    const riskFacts = ["GUI_INPUT_NOT_SANDBOXED"];
    let operation: string;
    let value: string;
    switch (action) {
      case "left_click":
      case "right_click":
      case "double_click":
        operation = `GUI ${action}`;
        value = `${action} @ ${at()}`;
        break;
      case "drag":
        operation = "GUI drag";
        value = `drag ${at()} → (${fmt(input["to_x"])}, ${fmt(input["to_y"])})/1000`;
        break;
      case "scroll":
        operation = "GUI scroll";
        value = `scroll ${String(input["direction"] ?? "down")} ×${fmt(input["amount"] ?? 3)} @ ${at()}`;
        break;
      case "type": {
        const text = typeof input["text"] === "string" ? input["text"] : "";
        riskFacts.push("KEYBOARD_TEXT_INPUT");
        operation = "GUI type";
        value = `输入 ${[...text].length} 个字符（发给前台的白名单应用）`;
        break;
      }
      case "key":
        operation = "GUI key";
        value = `按键 ${String(input["text"] ?? "")}（发给前台的白名单应用）`;
        break;
      case "activate_app":
        operation = "GUI activate_app";
        value = `切换到应用 ${String(input["app"] ?? "")}`;
        break;
    }
    return {
      effectType: "EXECUTE",
      operation,
      scope: { kind: "GUI", value },
      // 切换应用找得回来；其余动作的后果 Atlas 无从判断，按最坏处置。
      reversibility: action === "activate_app" ? "REVERSIBLE" : "IRREVERSIBLE",
      riskFacts,
      digest: d,
    };
  }
}

function fmt(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 10) / 10) : "?";
}
