/**
 * 脚本化审批决策（V05 §14.3）。
 *
 * 验收脚本必须能无人值守跑完，所以不能用交互式 decider。
 *
 * 顺带一个好处：它能稳定复现「批内第二个 Action 被拒绝，仍合成合法 result，
 * 且第三个继续执行」这个场景 —— 手动敲 y/n 反而不好稳定复现。
 */

import type { ApprovalDecider, ApprovalDecision, PreparedAction } from "@workagent/harness-runtime";

export function alwaysApprove(): ApprovalDecider {
  return async () => ({ approved: true });
}

export function alwaysReject(reason = "脚本化拒绝"): ApprovalDecider {
  return async () => ({ approved: false, reason });
}

/** 按调用序号给出决策。用于「第 N 个被拒绝」这类场景。 */
export function approveExcept(rejectIndices: number[], reason = "脚本化拒绝"): ApprovalDecider {
  let i = -1;
  return async (_action: PreparedAction): Promise<ApprovalDecision> => {
    i += 1;
    return rejectIndices.includes(i) ? { approved: false, reason } : { approved: true };
  };
}
