/**
 * fake-endpoint-profile（V05 §24.2）。
 *
 * 让验收脚本可以构造**任意端点行为组合** —— 包括现实中不存在但 Contract 必须能处理的组合。
 *
 * 这是端点能力声明可测试性的直接产物：如果端点行为是编译进代码的 if/else，
 * 你只能测到你手上真有的那几个端点；做成数据之后，你可以测「校验配对 + 推理块需占位 +
 * 无预估端点」这种四个真实端点里一个都不是的组合。
 *
 * verify:endpoint-profile 的判据就靠它：换 profile，Runtime 行为必须改变，
 * 而主循环代码一个字不动。
 */

import type { EndpointCapabilityProfile } from "@workagent/harness-runtime";
import { asId } from "@workagent/harness-runtime";

export interface FakeProfileOverrides {
  protocol?: Partial<EndpointCapabilityProfile["protocol"]>;
  context?: Partial<EndpointCapabilityProfile["context"]>;
  tokens?: Partial<EndpointCapabilityProfile["tokens"]>;
  modelId?: string;
}

/** 基线：一个什么都不校验、推理块可丢弃、有精确计数的端点。 */
export function fakeProfile(overrides: FakeProfileOverrides = {}): EndpointCapabilityProfile {
  return {
    id: asId("epcp_fake"),
    endpointId: asId("ep_fake"),
    shape: "ANTHROPIC_MESSAGES",
    modelId: overrides.modelId ?? "fake-model",
    protocol: {
      validatesToolResultPairing: false,
      validatesToolCallId: false,
      validatesToolResultOrder: false,
      validatesToolDefinitionSchema: false,
      validatesToolInputSchema: false,
      honorsDisableParallelToolCalls: false,
      ...overrides.protocol,
    },
    context: {
      reasoningBlockRule: "DROPPABLE",
      reasoningIsServerSideStateful: false,
      hasExplicitBlockCloseEvent: true,
      cacheMatching: "STRICT_PREFIX",
      supportsExplicitCacheBreakpoints: true,
      ...overrides.context,
    },
    tokens: {
      hasCountTokensEndpoint: true,
      countTokensAccuracy: "EXACT",
      perRequestBaseTokens: 5,
      billedInputFormula: "INPUT_PLUS_CACHE",
      usageFieldMap: {},
      ...overrides.tokens,
    },
    errors: { discriminators: ["HTTP_STATUS", "MESSAGE_MATCH"] },
    limits: { quotaBeforeContextLimit: false },
    observedAt: 0,
    probeSuiteVersion: "fake",
    sourceEvidenceRefs: [],
    // 【定】如实标注。ASSUMED 的字段在被依赖时应产生 SYSTEM_NOTICE。
    confidence: "ASSUMED",
  };
}

/**
 * verify:endpoint-profile 用的那个虚拟端点：
 * 「校验配对 + 推理块需占位」—— 四个真实端点里一个都不是这个组合。
 *
 * 期望的行为变化：
 *   1. protocolRoleOf(推理块) 从 ORDINARY 变成 PLACEHOLDER_REQUIRED；
 *   2. validateFrame 开始拒绝「含 tool_call 但无推理块」的 assistant 回合。
 *
 * 而主循环代码不变 —— 这是 §8.6 是否真正落地的判据。
 */
export function strictFakeProfile(): EndpointCapabilityProfile {
  return fakeProfile({
    modelId: "fake-strict-model",
    protocol: {
      validatesToolResultPairing: true,
      validatesToolCallId: true,
      validatesToolDefinitionSchema: true,
    },
    context: {
      reasoningBlockRule: "PLACEHOLDER_REQUIRED",
      reasoningIsServerSideStateful: true,
    },
  });
}

/** 无 token 预估端点。用于验证 D-05 的触发点退化路径。 */
export function noCountTokensProfile(): EndpointCapabilityProfile {
  return fakeProfile({
    modelId: "fake-no-count",
    tokens: { hasCountTokensEndpoint: false, countTokensAccuracy: undefined, perRequestBaseTokens: 84 },
  });
}
