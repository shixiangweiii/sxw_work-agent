/**
 * 端点能力声明（V05 §8.6）。
 *
 * 这是 D-07 的落地形态，也是原则十四「端点行为是数据，不是代码」的载体。
 *
 * 判据很简单：如果换一个端点这条结论可能变，它就是数据 —— 放进这里，
 * 而不是写进形状适配器或主循环。
 *
 * 由来：Spike 0 第三轮把第二轮的十条结论重测了一遍，六条只在原端点成立，
 * 而第二轮的变量隔离已经做得很干净（同平台、同模型、同 Key，只换 API 形状）。
 */

import type { EndpointCapabilityProfileId, EndpointId, Timestamp } from "./ids.js";

export type ApiShape = "ANTHROPIC_MESSAGES" | "OPENAI_CHAT" | "OPENAI_RESPONSES";

/**
 * 端点对协议不变量的校验强度。决定错误来源归类与失败时机。
 *
 * 选定端点（百炼 Anthropic）全部为 false —— 缺 tool_result、错 tool_call_id、
 * 非法 tool schema 一律 200 放行。这不降低不变量的重要性，反而提高了：
 * 没有任何外部兜底会替你发现违反。
 */
export interface ProtocolEnforcement {
  validatesToolResultPairing: boolean;
  validatesToolCallId: boolean;
  validatesToolResultOrder: boolean;
  validatesToolDefinitionSchema: boolean;
  validatesToolInputSchema: boolean;
  honorsDisableParallelToolCalls: boolean;
}

/**
 * 上下文治理的硬约束。
 *
 * reasoningBlockRule 三档的来源是实测：DeepSeek 的 Anthropic 形状要求
 * assistant 回合必须带 thinking 块，但内容可以是任意合成文本、signature 可以是空串。
 * 根因是 DeepSeek 服务端按 id 持有推理内容 —— 「推理块可丢弃」在别处成立，
 * 是因为那些端点无状态，不是因为协议宽松。
 */
export interface ContextCapability {
  reasoningBlockRule: "DROPPABLE" | "PLACEHOLDER_REQUIRED" | "VERBATIM_REQUIRED";
  reasoningIsServerSideStateful: boolean;
  hasExplicitBlockCloseEvent: boolean;
  cacheMatching: "STRICT_PREFIX" | "CHUNKED" | "UNPREDICTABLE" | "UNKNOWN";
  supportsExplicitCacheBreakpoints: boolean;
}

export interface TokenAccountingCapability {
  hasCountTokensEndpoint: boolean;
  /**
   * 【端点】精度只在 `countTokensExcludesReasoning` 划出的范围内成立。
   * 两个字段必须一起读 —— 单看 EXACT 会把适用范围理解错，D-3 就是这么发生的。
   */
  countTokensAccuracy?: "EXACT" | "APPROXIMATE";
  /**
   * count_tokens 是否把 assistant 回合里的推理块排除在外。
   *
   * 【端点】百炼 Anthropic 实测为 true：同一个 body 加不加 thinking 块，
   * count_tokens 返回值**一模一样**（765 / 765，差 0），而真实 inference 的
   * usage.input_tokens 是 888 —— 端点确实按 123 tokens 计了费。
   *
   * 为什么单独立一个字段而不是把 countTokensAccuracy 直接降级成 APPROXIMATE：
   * 降级会丢掉信息。这个端点在**无推理块**的帧上是真的 0.00% 误差（Spike p4 实测），
   * 只在含推理块时系统性低估。写成「EXACT ＋ 排除推理块」才是可用的事实 ——
   * 阈值判定可以据此自己补上推理块的估算，而 APPROXIMATE 只会让人放弃精确路径。
   *
   * 【定】true 时，凡是含推理块的帧，count_tokens 的返回值都是**下界**，不是实际值。
   */
  countTokensExcludesReasoning?: boolean;
  /** 每请求固定底数。百炼 5，DeepSeek 84 —— 差 17 倍，是端点属性不是模型属性。 */
  perRequestBaseTokens: number;
  /**
   * 计费输入公式。只读 input_tokens 会在缓存命中时低估达 85%，
   * 因为命中时 input_tokens 只剩非缓存部分。
   */
  billedInputFormula: "INPUT_ONLY" | "INPUT_PLUS_CACHE";
  usageFieldMap: Record<string, string>;
}

/** 阶段 2 实现（D-17）。阶段 1 只留类型。 */
export interface ErrorTaxonomyProfile {
  discriminators: Array<"HTTP_STATUS" | "TYPE" | "CODE" | "MESSAGE_MATCH">;
}

/** 阶段 2 实现（D-17）。阶段 1 只留类型。 */
export interface EndpointLimits {
  maxContextTokens?: number;
  observedMaxSingleRequestTokens?: number;
  /** 实测：百炼 OpenAI 形状对 60 万 token 返回 429，同平台 Anthropic 形状接受。 */
  quotaBeforeContextLimit: boolean;
}

export interface EndpointCapabilityProfile {
  id: EndpointCapabilityProfileId;
  endpointId: EndpointId;
  shape: ApiShape;
  modelId: string;
  /**
   * 该声明所属端点的 baseUrl 主机名（U-6）。
   *
   * 【定】它是**端点身份的一部分**，所以属于数据、不属于代码 ——
   * 与原则十四同源。compose 用它断言「配置的 baseUrl」与「加载的声明」
   * 指向同一个端点。
   *
   * 为什么要有：§8.6 不变量 5 说声明的粒度是端点 × 模型。而在此之前
   * 把 baseUrl 换成 DeepSeek 却保留百炼声明，compose **一声不吭** ——
   * Runtime 会拿一份「不校验配对、推理块可丢」的声明去驱动一个
   * 恰恰相反的端点。§24.6 的对照测试第一天就会踩到它。
   */
  expectedBaseUrlHost?: string;

  // 阶段 1 实现的三组（D-17）
  protocol: ProtocolEnforcement;
  context: ContextCapability;
  tokens: TokenAccountingCapability;

  // 阶段 2（D-17）
  errors?: ErrorTaxonomyProfile;
  limits?: EndpointLimits;

  observedAt: Timestamp;
  probeSuiteVersion: string;
  sourceEvidenceRefs: string[];
  /** ASSUMED 的字段在被依赖时应产生 SYSTEM_NOTICE。 */
  confidence: "PROBED" | "DECLARED" | "ASSUMED";
}

/** Run 启动时冻结进 RunSpec 的快照。Replay 使用冻结版本，不使用当前配置。 */
export type EndpointCapabilityProfileSnapshot = Readonly<EndpointCapabilityProfile>;

/**
 * 端点定义。凭证只存引用，且只能发往它自己的 baseUrl（V05 §22.3）。
 * 这条在 Spike 0 期间被实际违反过一次 —— 环境变量优先级导致第三方 Key 发往官方端点。
 */
export interface Endpoint {
  id: EndpointId;
  name: string;
  shape: ApiShape;
  baseUrl: string;
  /** 只存引用。明文仅在 Adapter 执行阶段短暂解析。 */
  credentialRef: string;
  dataBoundary: EndpointDataBoundary;
  status: "ACTIVE" | "DEGRADED" | "DISABLED";
}

/**
 * 每一次 ModelInvocation 本身就是一次数据外发（V05 §22.7）。
 * 模型调用不是纯计算 —— 网页正文、本地文件内容不是凭证，不会被脱敏，会完整发给第三方。
 */
export interface EndpointDataBoundary {
  region?: string;
  usedForTraining: "NO" | "YES" | "UNKNOWN";
  retentionPolicy?: string;
}
