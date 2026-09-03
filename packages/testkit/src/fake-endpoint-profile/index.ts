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
  limits?: Partial<NonNullable<EndpointCapabilityProfile["limits"]>>;
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
      /**
       * 【定】虚拟端点**不得**声称 EXACT。
       *
       * 这是 U-1 接线时暴露的一个夹具错误：原本这里写的是 "EXACT"，
       * 而虚拟端点根本没有被测量过 —— 它的 token 数由 ScriptedModelPort
       * 的两个互不相关的常量决定（countTokens 与 usage）。
       * 漂移检测一接上，规则 3 立刻 FAIL_FAST，而且**它是对的**：
       * 声明说精确，实际对不上。
       *
       * 声明是「关于某个端点的实测事实」（原则十四）。
       * 一个虚拟端点没有实测，就不该声称精确 —— 那正是 confidence 字段
       * 存在的理由。改成 APPROXIMATE 不是为了让脚本变绿，是因为它是真的。
       */
      countTokensAccuracy: "APPROXIMATE",
      perRequestBaseTokens: 5,
      billedInputFormula: "INPUT_PLUS_CACHE",
      usageFieldMap: {},
      ...overrides.tokens,
    },
    errors: { discriminators: ["HTTP_STATUS", "MESSAGE_MATCH"] },
    limits: { quotaBeforeContextLimit: false, ...overrides.limits },
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

/**
 * ── 这里**故意没有** `noCountTokensProfile()` ──────────────────────────
 *
 * 它曾经在，注释写着「无 token 预估端点。用于验证 D-05 的触发点退化路径」——
 * 而**零调用点**：那条退化路径（端点没有 count_tokens → 本地估算 →
 * accuracy 降成 ESTIMATED → `computeIrreducible` 走加 `fixedOverheadTokens`
 * 的那一支）从来没有被任何判据覆盖过。
 *
 * 删掉的是那个**没人调的夹具**，不是那条缺口 —— 缺口照旧在，只是现在
 * 没有一个函数在替它作证。与 `FakeClock` / `DeterministicIdGenerator`
 * 同一条：「一个没有使用者的测试夹具与一条没有判据的断言是同一类东西」。
 *
 * 真要补那条判据的那天，第一步是写断言，第二步才是把这个 profile 加回来
 * （`{ hasCountTokensEndpoint: false, countTokensAccuracy: undefined }` 就是它）。
 */
