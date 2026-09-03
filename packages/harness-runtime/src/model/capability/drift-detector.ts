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
import type { RuntimeErrorRecord } from "../../types/error.js";

export interface DriftObservation {
  field: string;
  declared: string;
  observed: string;
  disposition: "RECORD" | "FAIL_FAST";
  note: string;
}

/**
 * ── 这里**故意没有** `observations()` ────────────────────────────────────
 *
 * 曾经有：一个 `private seen: DriftObservation[]`，每次 `record()` 往里 push，
 * 外加一个 `observations()` 读它。**两者全仓零消费者** —— 所有调用点
 * （`run-loop` 与 `verify:drift`）读的都是 `observeXxx()` 的返回值。
 *
 * 也就是说它是一个只写不读的累加器，与 `ProgressGuard` 里那个被删掉的
 * `lastProgressAt` 是同一形态：一个只写不读的字段会让下一个人以为
 * 「漂移历史是被留存的」，而事实上漂移的唯一去处是 `EndpointBehaviorDrift`
 * 事件（进 Trace，那条有读者）。
 *
 * 【定】真要「这个 Run 一共漂了几次」，去数 trace 里那个事件，
 * 不要在这里再攒一份内存副本 —— 第二份副本就是第二个可以与另一个矛盾的事实。
 */
export class DriftDetector {
  constructor(private readonly profile: EndpointCapabilityProfile) {}

  /**
   * 规则 1：声明「强制单条开关**有效**」却收到多条 → 记录，不失败。
   *
   * ── 【定】方向必须是这一侧，反过来不可证伪 ────────────────────────────
   *
   * 这条规则原先问的是反方向：声明「开关无效」却收到 `count <= 1`，
   * 就断言「开关看起来生效了」。**收到一个调用不能证明开关生效** ——
   * 它同样可以只是模型那一轮只有一件事要做，而后者才是常态。
   *
   * 2026-08-28 办公任务实跑把这件事演了一遍：trial1 在 turn 1（1 个 call）
   * 记下「开关看起来生效了」，turn 3 就收到 **8 个并行 call**。
   * 同一个 Run 里当场自我推翻，而调用侧按 field 去重后既不重发也不撤回 ——
   * trace 上永久留着一条已经被推翻的结论。14/14 个 run 全中。
   *
   * 现在只报能证伪的那一侧：**我们真的发了开关（声明有效才发，见形状适配器
   * 的 buildRequest），却仍然收到多条**。这条观察是硬的：它只有一种解释。
   *
   * ── 【定】没有 `disabledParallelRequested` 参数 ────────────────────────
   *
   * 它曾经有：调用方要传「这次发没发那个开关」。而**全部四个调用点传的都是
   * `true`** —— 因为「发没发」压根不是调用方的自由度：
   * `buildRequest` 只在 `honorsDisableParallelToolCalls` 为真时才发它，
   * 也就是下面那一行判的同一个声明。一个恒为 true 的参数，读起来像是
   * 这里有两个独立条件，实际只有一个。
   */
  observeToolCallCount(count: number): DriftObservation | null {
    // 【定】声明无效时形状适配器根本不发这个参数（见 `buildRequest`），
    // 没发出去的开关谈不上生效没生效 —— 这一条同时代替了原来那个入参。
    if (!this.profile.protocol.honorsDisableParallelToolCalls) return null;
    if (count <= 1) return null;
    return this.record({
      field: "protocol.honorsDisableParallelToolCalls",
      declared: "true",
      observed: `发了 disable_parallel_tool_use，仍收到 ${count} 个 tool call`,
      disposition: "RECORD",
      note: "声明可能过期。串行仍由 Runtime 自持保证（D-01），此处不改变行为。",
    });
  }

  /**
   * 规则 2：声明「不校验配对」却收到配对相关的协议错误 → fail fast。
   *
   * 这条必须 fail fast：如果端点开始校验了，而 Runtime 仍按「反正不会报错」运行，
   * 后续每一次配对疏漏都会变成硬失败，且失败点离成因很远。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】判别式用 **Runtime 自己的词汇**（source ＋ category），不收 HTTP status。
   *
   * 它此前的签名是 `(httpStatus, message)`，而主循环拿不到裸 status ——
   * 它只有 `classifyError()` 归一化之后的 `RuntimeErrorRecord`，
   * 去解 SDK 的错误形状是形状适配器的职责，不是循环的。
   * 结果就是这条规则**生产路径零调用**，只有 `verify:drift` 调得到它：
   * 三条漂移规则里唯一 FAIL_FAST 的那条，在真实运行中不可能触发。
   *
   * `source === "MODEL_PROVIDER" && category === "PROTOCOL"` 恰好就是
   * 「端点说我们的请求结构不对」—— 形状适配器对 400（非上下文超长）的映射。
   * ══════════════════════════════════════════════════════════════════════
   */
  observePairingError(error: RuntimeErrorRecord): DriftObservation | null {
    if (this.profile.protocol.validatesToolResultPairing) return null;
    if (error.source !== "MODEL_PROVIDER" || error.category !== "PROTOCOL") return null;
    if (!/tool_?result|tool_?use|tool_?call_?id|unpaired|pair/i.test(error.safeMessage)) return null;
    return this.record({
      field: "protocol.validatesToolResultPairing",
      declared: "false",
      observed: error.safeMessage.slice(0, 160),
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

  /**
   * 观察结果的统一出口。
   *
   * 它现在只是把参数原样返回 —— 保留这一跳而不是让三条规则各自 `return {...}`，
   * 是因为它是**加字段时唯一要改的地方**（比如将来给每条观察打时间戳）。
   * 曾经它还往一个 `seen[]` 里 push，见类头那段说明。
   */
  private record(o: DriftObservation): DriftObservation {
    return o;
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
