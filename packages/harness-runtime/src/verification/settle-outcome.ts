/**
 * Run 完成判定（V05 §10.4）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *              模型不再请求工具即完成。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这是标准 Harness 循环的做法。没有独立于模型判断的声明式验收机制，理由三条：
 *
 * 1. 它要求在发出第一个 token 之前就知道「什么算做完」，而这个信息不存在。
 *    用户说「把这三篇文章归档」，minCount: 3 里的 3 只存在于自然语言里。
 * 2. 它要解决的问题已被其他机制覆盖：副作用未知由 RECOVERY_REQUIRED 处理，
 *    Eval 的成败判定由 eval/graders/ 独立实现。
 * 3. 单人使用场景下，人在回路里。
 *
 * ── 但保留一条底线 ──────────────────────────────────────────────
 *
 * 结算时必须查一次 required Verification 的结果。
 *
 * 这条与「信不信模型」无关：Verification 已经跑过、扣了 token、结果已经在表里。
 * 结算时忽略它，等于花钱测出一个事实然后扔掉。
 *
 * 注意它不改变循环何时终止，只改变终止后打什么标签。
 */

import type { IncompleteItem, RecoveryItem, RunOutcome } from "../types/run.js";
import type { VerificationResult } from "../types/tool.js";

export interface SettleInput {
  verifications: VerificationResult[];
  recoveryItems: RecoveryItem[];
  summary?: string;
}

export function settleOutcome(input: SettleInput): RunOutcome {
  const base = {
    summary: input.summary,
    deliveredArtifactIds: [] as string[],
    recoveryItems: input.recoveryItems,
  };

  // 副作用状态未知先于完成判定生效 —— 它是一个独立的非终态分支，
  // 不需要一条 criterion 去表达。
  if (input.recoveryItems.length > 0) {
    return {
      ...base,
      kind: "COMPLETED_WITH_LIMITS",
      incompleteItems: input.recoveryItems.map(
        (r): IncompleteItem => ({
          what: r.what,
          why: `副作用状态 ${r.sideEffectState}，需要人工确认`,
          actionId: r.actionId,
        }),
      ),
    };
  }

  const unmet = unmetRequired(input.verifications);

  if (unmet.length === 0) {
    return { ...base, kind: "SUCCESS", incompleteItems: [] };
  }

  return { ...base, kind: "COMPLETED_WITH_LIMITS", incompleteItems: unmet };
}

/**
 * 必需验证里「没有拿到通过」的那些。
 *
 * ── 为什么不是只筛 FAILED ──────────────────────────────────────
 *
 * V05 §10.4 的示例代码只写了 `status === "FAILED"`。照抄它会漏掉一整类事实：
 * 一个 requiredForSuccess 的操作**根本没跑到验证**（工具失败、被 Policy 拒、
 * 被用户拒、被批内策略跳过、被 cancel），此时表里要么是一条 SKIPPED，
 * 要么什么都没有 —— 两种情况下 failed.length 都是 0，Run 结算成 SUCCESS。
 *
 * 【定】跳过不等于通过。SKIPPED 的语义是「这条必需验证没有得出通过的结论」，
 * 它与 FAILED 一样，都不能支撑 SUCCESS。
 *
 * 「压根没有记录」那一类由 settle-batch 负责补事实：任何声明了
 * requiredForSuccess 却没走到 Verification 的 Action，都会合成一条 FAILED。
 * 两处配合，才让 outcome.kind 与实际执行事实一致（不变量 12）。
 */
function unmetRequired(verifications: VerificationResult[]): IncompleteItem[] {
  return verifications
    .filter((v) => v.required && v.status !== "PASSED")
    .map((v) => ({
      what:
        v.status === "FAILED"
          ? `Action ${v.actionId} 的必需验证未通过`
          : `Action ${v.actionId} 的必需验证未能得出结论`,
      why: v.detail,
      actionId: v.actionId,
    }));
}

/**
 * 撞墙路径的 outcome。
 *
 * 这些场景下模型没有机会说完成 —— 它们不走上面的循环终止路径，
 * outcome 由墙决定，DETERMINISTIC handoff 负责把「做到哪了」讲清楚。
 */
export function settleWallOutcome(
  kind: Extract<
    RunOutcome["kind"],
    "BUDGET_EXHAUSTED" | "CONTEXT_EXHAUSTED" | "QUOTA_EXHAUSTED" | "CANCELLED" | "FAILED"
  >,
  input: SettleInput & { handoff?: string },
): RunOutcome {
  return {
    kind,
    summary: input.handoff ?? input.summary,
    deliveredArtifactIds: [],
    recoveryItems: input.recoveryItems,
    incompleteItems: [
      ...unmetRequired(input.verifications),
      ...input.recoveryItems.map((r) => ({
        what: r.what,
        why: `副作用状态 ${r.sideEffectState}`,
        actionId: r.actionId,
      })),
    ],
  };
}
