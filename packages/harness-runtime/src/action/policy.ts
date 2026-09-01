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
import type { ApprovalPolicySnapshot, ExecutionPrivilege } from "../types/run.js";
import { makeError, type RuntimeErrorRecord } from "../types/error.js";

export type PolicyVerdict =
  | { decision: "ALLOW" }
  | { decision: "REQUIRE_APPROVAL"; reason: string }
  | { decision: "DENY"; error: RuntimeErrorRecord };

export interface PolicyInput {
  action: PreparedAction;
  approvalPolicy: ApprovalPolicySnapshot;
  /**
   * 随 RunSpec 冻结的执行特权档位（ADR-0012）。
   *
   * 【定】它是**冻结值**，不是「当前设置」。判定必须对同一条 transcript
   * 恒定：一次 resume 若用今天的档位去判昨天的 Action，同一个操作会得到
   * 相反的裁决，而盘上看不出来（§18.3 那两维闸门是同一条理由）。
   */
  executionPrivilege: ExecutionPrivilege;
}

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const { action, approvalPolicy, executionPrivilege } = input;
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
  const outsideWorkspace = mutates && effect.riskFacts.includes("OUTSIDE_WORKSPACE");

  /**
   * ── ADR-0012：`UNRESTRICTED` 档把这条 DENY 换成 REQUIRE_APPROVAL ──────
   *
   * 上面那句「不能通过单次审批放行」在 `SANDBOXED` 档下**一个字没改**。
   * ADR-0012 推翻的不是它的理由，而是它的**适用前提**：那句话说的是
   * 「授权边界不该退化成每次问一下」，而 `UNRESTRICTED` 恰恰是一次
   * **显式的、有名字的、写在启动参数里的**范围授权 —— 它不是单次审批。
   *
   * 【定】换成 `REQUIRE_APPROVAL` 而不是 `ALLOW`。理由是失败方向：
   * 越界写在任何档位下都必须**至少经过审批这一跳**，这样它才会出现在
   * `ApprovalRequested` / `ApprovalDecided` 事件对上、进 Trace、进界面。
   * 直接 ALLOW 的话，一次写到 `$HOME` 的操作在事件流上与一次写到
   * workspace 内的操作长得一模一样 —— 而这两件事的可挽回程度差着数量级。
   *
   * （AUTO 审批档下这一跳当然会被自动放行，但它**留下了记录**，
   * 且 `decidedBy` 会如实写 `AUTO`。见 `ApprovalDecidedBy`。）
   *
   * 【定】`requiresApprovalFor` 恰好覆盖 WRITE/DELETE/EXECUTE，与 `mutates`
   * 的定义重合，所以下面那条 `if` 本来就会接住它。这里**仍然显式写一支**，
   * 而不是靠「反正会落到下面」—— 靠重合的两处定义维持正确性，
   * 是本仓反复清理的形态（改了其中一个，另一个不会有任何征兆）。
   */
  if (outsideWorkspace) {
    if (executionPrivilege === "SANDBOXED") {
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
    return {
      decision: "REQUIRE_APPROVAL",
      // 【定】理由里必须点名「在 workspace 之外」。它会原样进审批面 ——
      // 而这正是人在那一刻最需要知道、且从 `scope.value` 一行里看不出来的事。
      reason:
        `${effect.operation} → ${effect.scope.value}` +
        `（**在 workspace 之外**；本次运行为 UNRESTRICTED 档，越界写不再被直接拒绝）` +
        (effect.reversibility === "IRREVERSIBLE" ? "（不可逆）" : ""),
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
