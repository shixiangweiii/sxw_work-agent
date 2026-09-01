/**
 * 脚本化审批决策（V05 §14.3）。
 *
 * 验收脚本必须能无人值守跑完，所以不能用交互式 decider。
 *
 * 顺带一个好处：它能稳定复现「批内第二个 Action 被拒绝，仍合成合法 result，
 * 且第三个继续执行」这个场景 —— 手动敲 y/n 反而不好稳定复现。
 */

import type { ApprovalDecider, ApprovalDecision, PreparedAction } from "@workagent/harness-runtime";

/**
 * 按调用序号给出决策。用于「第 N 个被拒绝」这类场景。
 *
 * ── 【定】它模拟的是**一个人在做决定**，所以必须声明 `decidedBy: "HUMAN"` ──
 *
 * ADR-0012 二次评审 P1-6 之后，`USER_REJECTED` 这个成因只认
 * `decidedBy === "HUMAN"` 的否决 —— 不声明来源的否决会落
 * `NO_APPROVAL`（无人应答），结算成 `COMPLETED_WITH_LIMITS`。
 *
 * 这个夹具的**全部意图**就是复现「用户按了否」，所以它必须把这句话说出来。
 * 不说的话，`verify:pairing` 的「审批拒绝」场景测到的其实是
 * 「没有人应答」—— **判据测的不是它声称在测的东西**，而且是夹具这一侧的。
 *
 * 反过来也成立：想复现「无人值守下没人应答」的脚本，就**不要**填这个字段，
 * 那时 `UNDECLARED` 正是它的真实情况。
 */
export function approveExcept(rejectIndices: number[], reason = "脚本化拒绝"): ApprovalDecider {
  let i = -1;
  return async (_action: PreparedAction): Promise<ApprovalDecision> => {
    i += 1;
    return rejectIndices.includes(i)
      ? { approved: false, reason, decidedBy: "HUMAN" }
      : { approved: true, decidedBy: "HUMAN" };
  };
}
