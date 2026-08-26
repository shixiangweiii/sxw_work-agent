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
    /**
     * ── D-3 之后，「EXACT」不再描述 Runtime 实际算出来的那个数 ────────────
     *
     * 这条是 U-1 接线**当场**暴露的矛盾，值得记清楚：
     *
     *   · profile 说 `countTokensAccuracy: "EXACT"` —— 那描述的是**端点的**
     *     count_tokens 在**不含推理块**的帧上的精度（Spike p4：5/5 项 0.00%）；
     *   · 而 D-3 证实端点对推理块**一个 token 都不算**，于是
     *     `protocol.countTokens()` 会本地补一个估算顶上去（系数 1.9，见 D-4）。
     *
     * 两条都对，但合起来意味着**复合结果不是精确的**，而且**故意不精确**
     * （宁可高估，让阈值判定偏安全那侧）。拿它去判「端点漂移了」是错的靶子 ——
     * 偏差来自我们自己的补估，不来自端点。
     *
     * 所以有本地补估时只 RECORD，不 FAIL_FAST。真正的端点漂移会表现为
     * **不含推理块**的帧上也出现偏差，那时补估为 0，这条规则照常生效。
     */
    if (this.profile.tokens.countTokensExcludesReasoning) {
      if (predicted === actual) return null;
      const dev = actual === 0 ? 1 : Math.abs(predicted - actual) / actual;
      // 本地补估的量级由 D-4 的系数决定，20% 以内属预期。
      if (dev <= 0.2) return null;
      return this.record({
        field: "tokens.countTokensAccuracy",
        declared: "EXACT（含本地推理块补估）",
        observed: `预估 ${predicted} vs 实际 ${actual}，偏差 ${(dev * 100).toFixed(2)}%`,
        disposition: "RECORD",
        note:
          "偏差超出本地补估的预期量级。可能是 D-4 的系数在这个语种/长度上不成立，" +
          "也可能是端点改了推理块的计费方式 —— 需要重跑 probe:reasoning-tokens 才分得清。",
      });
    }
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
