/**
 * 漂移检测（V05 §8.6 不变量 4）。
 *
 * 实际行为与声明不符时，产生 EndpointBehaviorDrift 事件，并按配置 fail fast 或降级
 * —— 不得静默继续。
 *
 * 存在的理由是一组具体数字：第三轮把第二轮的十条结论重测了一遍，六条只在原端点成立。
 * 声明是快照，会过期；过期而无人察觉，比一开始就写错更危险。
 *
 * 阶段 1 只实现三条最小规则，完整策略见 D-18（阶段 2）。
 */

import type { EndpointCapabilityProfile } from "../../types/endpoint.js";

export interface DriftObservation {
  field: string;
  declared: string;
  observed: string;
  disposition: "RECORD" | "FAIL_FAST";
  note: string;
}

export class DriftDetector {
  private readonly seen: DriftObservation[] = [];

  constructor(private readonly profile: EndpointCapabilityProfile) {}

  /**
   * 规则 1：声明「强制单条开关无效」却收到单条 → 记录，不失败。
   * 收到单条本身无害，只说明声明可能过时。
   */
  observeToolCallCount(count: number, disabledParallelRequested: boolean): DriftObservation | null {
    if (!disabledParallelRequested) return null;
    if (this.profile.protocol.honorsDisableParallelToolCalls) return null;
    if (count > 1) return null;
    return this.record({
      field: "protocol.honorsDisableParallelToolCalls",
      declared: "false",
      observed: `收到 ${count} 个 tool call，开关看起来生效了`,
      disposition: "RECORD",
      note: "声明可能过期。串行仍由 Runtime 自持保证，此处不改变行为。",
    });
  }

  /**
   * 规则 2：声明「不校验配对」却收到配对相关 400 → fail fast。
   *
   * 这条必须 fail fast：如果端点开始校验了，而 Runtime 仍按「反正不会报错」运行，
   * 后续每一次配对疏漏都会变成硬失败，且失败点离成因很远。
   */
  observePairingError(httpStatus: number, message: string): DriftObservation | null {
    if (this.profile.protocol.validatesToolResultPairing) return null;
    if (httpStatus !== 400) return null;
    if (!/tool_?result|tool_?use|tool_?call_?id|unpaired|pair/i.test(message)) return null;
    return this.record({
      field: "protocol.validatesToolResultPairing",
      declared: "false",
      observed: `HTTP 400：${message.slice(0, 160)}`,
      disposition: "FAIL_FAST",
      note: "端点开始校验配对了，声明已过期。继续运行会让后续配对疏漏变成难以定位的硬失败。",
    });
  }

  /**
   * 规则 3：声明 countTokens 精确却出现非零偏差 → 记录偏差，超阈值告警。
   *
   * D-05 的整个前提是「即将超限可以在发请求前精确判定」。
   * 这个前提一旦不成立，激进 Compact 就失去了可靠触发点。
   */
  observeTokenAccuracy(predicted: number, actual: number): DriftObservation | null {
    if (this.profile.tokens.countTokensAccuracy !== "EXACT") return null;
    if (predicted === actual) return null;
    const deviation = actual === 0 ? 1 : Math.abs(predicted - actual) / actual;
    return this.record({
      field: "tokens.countTokensAccuracy",
      declared: "EXACT",
      observed: `预估 ${predicted} vs 实际 ${actual}，偏差 ${(deviation * 100).toFixed(2)}%`,
      disposition: deviation > 0.02 ? "FAIL_FAST" : "RECORD",
      note:
        deviation > 0.02
          ? "偏差超过 2%，D-05 的激进 Compact 失去可靠触发点。"
          : "小幅偏差，记录分布备查。",
    });
  }

  private record(o: DriftObservation): DriftObservation {
    this.seen.push(o);
    return o;
  }

  observations(): readonly DriftObservation[] {
    return this.seen;
  }
}

/** fail fast 分支抛出的错误。调用方应终止 Run 而不是吞掉。 */
export class EndpointDriftError extends Error {
  constructor(readonly observation: DriftObservation) {
    super(
      `端点行为漂移（${observation.field}）：声明 ${observation.declared}，实际 ${observation.observed}。${observation.note}`,
    );
    this.name = "EndpointDriftError";
  }
}
