/**
 * Policy（V05 §14）。
 *
 * 阶段 1 只实现 TRUSTED_PERSONAL preset：单人本地使用，默认信任，
 * 但写操作要审批、越界一律拒绝。
 *
 * 【定】Context trust 只是风险信号，不能取代独立的 Capability/Effect 校验。
 * 也就是说：不能因为「这次任务的上下文里没有不可信内容」就跳过 Effect 判定。
 */

import type { PreparedAction } from "../types/tool.js";
import type { ApprovalPolicySnapshot } from "../types/run.js";
import { makeError, type RuntimeErrorRecord } from "../types/error.js";

export type PolicyVerdict =
  | { decision: "ALLOW" }
  | { decision: "REQUIRE_APPROVAL"; reason: string }
  | { decision: "DENY"; error: RuntimeErrorRecord };

export interface PolicyInput {
  action: PreparedAction;
  approvalPolicy: ApprovalPolicySnapshot;
  /** 来自 ContextFrame.trustSummary。只作风险信号，不作判定依据。 */
  hasUntrustedContext: boolean;
}

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const { action, approvalPolicy } = input;
  const effect = action.resolvedEffect;

  // 【定】越界一律拒绝，不给审批机会。
  // Workspace 外写入必须由新的明确授权覆盖，而不是由一次性审批放行 ——
  // 否则「授权边界」就变成了「每次问一下」。
  if (effect.riskFacts.includes("OUTSIDE_WORKSPACE")) {
    return {
      decision: "DENY",
      error: makeError({
        code: "POLICY_OUTSIDE_WORKSPACE",
        source: "POLICY",
        category: "AUTHORIZATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NOT_STARTED",
        safeMessage:
          `目标 "${effect.scope.value}" 落在 workspace 授权范围之外，拒绝执行。` +
          `扩大范围需要新的明确授权，不能通过单次审批放行。`,
      }),
    };
  }

  if (approvalPolicy.requiresApprovalFor.includes(effect.effectType)) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason:
        `${effect.operation} → ${effect.scope.value}` +
        (effect.reversibility === "IRREVERSIBLE" ? "（不可逆）" : ""),
    };
  }

  return { decision: "ALLOW" };
}

/** TRUSTED_PERSONAL preset：写与删要审批，读与无副作用直接放行。 */
export const TRUSTED_PERSONAL: ApprovalPolicySnapshot = {
  requiresApprovalFor: ["WRITE", "DELETE", "EXECUTE"],
};
