/**
 * Policy（V05 §14）。
 *
 * 阶段 1 只实现 TRUSTED_PERSONAL preset：单人本地使用，默认信任，
 * 但写操作要审批、越界一律拒绝。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】判定**只读 ResolvedEffect 与审批档位**，不读上下文 trust。
 *
 * 这里此前收一个 `hasUntrustedContext` 入参，注释写着「只作风险信号」——
 * 而函数体从来没有解构过它。三跳（compile → run-loop → executeBatch → 这里）
 * 全程传递、终点落地，读代码的人会以为 trust 参与了 Allow/Deny 或审批理由。
 *
 * 删掉而不是「让它真的参与判定」：那需要一条「不可信上下文在场时提高档位」
 * 的产品决定，而那个决定不存在。凭空加等于新造一条没有证据支撑的闸门。
 * trust 作为**审计事实**由 `ContextFrameCompiled.trust` 承载，那条有读者。
 * ══════════════════════════════════════════════════════════════════════
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
}

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const { action, approvalPolicy } = input;
  const effect = action.resolvedEffect;

  /**
   * ── 决 3（阶段 3）：workspace 边界对「写」保留，对「读」放开 ──────────
   *
   * 【定】越界**写**一律拒绝，不给审批机会。
   * Workspace 外写入必须由新的明确授权覆盖，而不是由一次性审批放行 ——
   * 否则「授权边界」就变成了「每次问一下」。
   *
   * 【定】越界**读**放行。阶段 1–2 一律拒绝，代价是 Agent 的射程被锁死在
   * 一个空目录里 —— 办公场景要读的文档、代码场景要读的仓库，
   * 天然不在 `.workagent-workspace/` 下面。
   *
   * ── 但「读错文件是信息问题」这条论证在 `fetch_url` 之后失效 ──────────
   *
   *     读是信息问题 ⇒ 信息可以被外发 ⇒ 读 ＋ 外发 ＝ 损失。
   *
   * 所以放开换来的是三条护栏（决 3 修订 2），它们**不在这里**：
   *   ① 读黑名单（`tools/common/src/fs/read-guard.ts`，覆盖 read_file ＋ search）；
   *   ② `fetch_url` 拒绝私网与 localhost；
   *   ③ URL scope 产出 riskFact ＋ dataMovement，让外发在 Trace 上可审计。
   *
   * 【定】改这一段之前先确认那三条还在。少了任何一条，这里就该改回一律拒绝。
   */
  const mutates =
    effect.effectType === "WRITE" ||
    effect.effectType === "DELETE" ||
    effect.effectType === "EXECUTE";
  if (mutates && effect.riskFacts.includes("OUTSIDE_WORKSPACE")) {
    return {
      decision: "DENY",
      error: makeError({
        code: "POLICY_OUTSIDE_WORKSPACE",
        source: "POLICY",
        category: "AUTHORIZATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NOT_STARTED",
        safeMessage:
          `写入目标 "${effect.scope.value}" 落在 workspace 授权范围之外，拒绝执行。` +
          `读操作可以越界，写不行 —— 读错文件是信息问题，写错文件是不可逆损失。` +
          `扩大写入范围需要新的明确授权，不能通过单次审批放行。`,
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
