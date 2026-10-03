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
  /**
   * 形状默认字段名的可选覆盖。键是归一化 `ModelUsage` 字段，值是 Provider 字段。
   * 未列出的键使用形状适配器默认值；未知键必须在加载声明时拒绝。
   */
  usageFieldMap: Partial<Record<UsageFieldKey, string>>;
}

export type UsageFieldKey =
  | "inputTokens"
  | "outputTokens"
  | "cacheCreationInputTokens"
  | "cacheReadInputTokens";

/** Provider 错误分类所依赖的端点声明（D-17）。 */
export interface ErrorTaxonomyProfile {
  discriminators: Array<"HTTP_STATUS" | "TYPE" | "CODE" | "MESSAGE_MATCH">;
}

/**
 * 视觉能力（ADR-0013）。**整组可选：不声明 = 这个端点 × 模型看不见图。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * 每个字段都来自 Spike 1（`spikes/s1-computer-use-vision/`）的实测，
 * 而且每一条都是「换一个端点结论就可能变」的那种 —— 所以是数据，不是代码：
 *
 *   · 截图放在哪：两端点都收得下 tool_result 里的图；而 tool_result **之后**的
 *     图片块，DeepSeek 收、**百炼返回 200 却静默丢弃**（4/4，图贡献 0 token）。
 *   · 图像怎么计费：百炼约每 32×32 像素一个 token、封顶 2562；
 *     DeepSeek 约每 40×40 一个、封顶 962、下限 200。
 *   · count_tokens 算不算图：DeepSeek 算且与计费一致；**百炼完全不算**。
 *   · 坐标约定：两模型都以 0–1000 归一化最准；qwen3.8-flash 在工具描述写明
 *     像素坐标时**照样输出归一化坐标**（1/10、0/10 命中）。
 * ══════════════════════════════════════════════════════════════════════
 */
export interface VisionCapability {
  /**
   * 截图装进请求的位置。
   *
   * 【定】单值类型，与 `ActionBatch.executionMode` 同一条理由：只有这一档有生产者。
   * 「tool_result 之后再跟 image 块」在百炼上是**静默丢图**，不是一个可选项 ——
   * 写成联合类型会让人以为它能用。
   */
  imageCarrier: "IN_TOOL_RESULT";
  /**
   * 本地估算图像 token 的参数：
   *   tokens = clamp(ceil(w / patchPx) × ceil(h / patchPx) + perImageOverhead, min, max)
   *
   * 【定】这是**保守估算**（实测在个别尺寸上高估 ≤7%），用于上下文预算 ——
   * 宁可估多，不能让阈值判定系统性偏向「还够用」那一侧（与 D-3 推理块同一条纪律）。
   */
  imageTokens: {
    patchPx: number;
    perImageOverhead: number;
    minTokens: number;
    maxTokens: number;
  };
  /**
   * 端点的 count_tokens 是否计入图像。
   *
   * 【定】false 时，形状适配器在 count_tokens 的返回值上**补上本地估算**，
   * 并把精度降级为 ESTIMATED。不补的话，带图的帧会被少算每张约 1000 token
   * （Spike 1 P-3：百炼带一张 1280×800 的图，count_tokens 只多了 3）。
   */
  countTokensIncludesImages: boolean;
  /**
   * 模型输出点击坐标时用的坐标系。
   *
   * 【定】单值。两端点实测都以 0–1000 归一化最准，而且它**不受服务端缩放影响**
   * —— DeepSeek 对大图会在服务端缩小，不说明单位时给的是缩小后那张图上的像素
   * 坐标（3584 宽的图斜率 0.537），客户端根本不知道那个尺寸。
   * 归一化坐标把「模型看到的图有多大」这个未知量整体消掉了。
   */
  groundingCoordinateSpace: "NORMALIZED_1000";
  /**
   * 截图建议的长边像素。超过服务端缩放的封顶后不再增加细节，只增加字节。
   * 实测 1792（= 本机逻辑点宽度）时两模型定位与小字可读性都在最好的一档。
   */
  preferredScreenshotLongEdgePx: number;
}

/** 组合时收紧上下文策略、生成可观测提示的端点限制。 */
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

  /** 协议、上下文与 token 是每个端点声明的基础能力。 */
  protocol: ProtocolEnforcement;
  context: ContextCapability;
  tokens: TokenAccountingCapability;

  /** 只有具备相应证据的端点才声明错误分类与容量限制。 */
  errors?: ErrorTaxonomyProfile;
  limits?: EndpointLimits;
  /** 视觉能力（ADR-0013）。不声明 = 看不见图；computer use 在这样的端点上拒绝启用。 */
  vision?: VisionCapability;

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
