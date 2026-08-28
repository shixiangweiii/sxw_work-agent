/**
 * 工具包组合器（阶段 3 §2.4）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它住在 Composition Root，**不进 Runtime**。
 *
 * 路由逻辑必须认识具体工具名，而 Runtime 不许认识任何工具 ——
 * 这是边界 4（`grep -rnE "micro-cases|tools-common" packages/harness-runtime/src`
 * 必须无结果）的直接推论。把组合器放进 Runtime 会让那条 grep 立刻翻红。
 *
 * ── 【定】`CompositeVerifier` 必须路由 `verify` / `observePre` / `observePost`
 *          **全部三个**方法（不得绕过清单 #10）────────────────────────
 *
 * 只路由 `verify`、让 `observePre` 返回 `undefined`，后果不是「少一个观察」：
 *
 *     前置指纹拍不到 → 崩溃后一律判「观察不了」→ §18.2 分支二的工具
 *     **全部静默退化成分支三**。
 *
 * 没有任何报错，盘上也看不出来 —— 而这恰好打击阶段 2 决 6 要防的那件事
 * （分流的旋钮长在哪一侧）。`verify:tools` E 段对这条做判别力实测：
 * 把 observePre 的路由改坏，`edit_file` 的恢复分支必须从二退化到三**并翻红**。
 * ══════════════════════════════════════════════════════════════════════
 */

import type {
  ObservationResult,
  PreparedAction,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolHandlerPort,
  VerificationPort,
  VerificationResult,
} from "@workagent/harness-runtime";
import { makeError } from "@workagent/harness-runtime";

/** 两个包的 Handler / Verifier 都实现它，组合器据此路由。 */
export interface ToolNameRouted {
  handles(toolName: string): boolean;
}

/**
 * 阶段 3 改过名的工具，**只用于错误信息**（方案 §2.5）。
 *
 * 【定】它不是别名表 —— 不做路由、不做回退执行。
 * 别名表是永久负担，而库里只有开发期 Run；这里要的只是让那条失败
 * 说得出「为什么」，而不是让老 Run 跑起来。
 */
const MIGRATED_TOOL_NAMES: Record<string, string> = {
  write_note: "write_file",
};

export class CompositeToolHandler implements ToolHandlerPort {
  constructor(private readonly members: Array<ToolHandlerPort & ToolNameRouted>) {}

  async execute(action: PreparedAction, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const target = this.members.find((m) => m.handles(action.toolName));
    if (!target) {
      /**
       * 【定】路由不到必须如实报，且必须**先于**任何 member 被调用。
       *
       * 早期写法是「都试一遍，谁不报 TOOL_NOT_FOUND 就用谁」——
       * 那会让「两个包都声明了同名工具」这种真正的装配错误静默地
       * 落到先注册的那个身上，而没有任何东西告诉你。
       */
      /**
       * 文案里带上迁移提示（方案 §2.5 要求的「一条明确的错误信息」）。
       *
       * 阶段 3 把 `write_note` 改名成 `write_file` 并搬进了 `tools/common`，
       * 代价是**迁移前的 Run 不能 resume**（不做别名表，见 write-file.ts 文件头）。
       * 崩在未配对调用上的那条路径有明确信息（facade 的 `UNKNOWN_TOOL` 分支
       * 会说「工具已不在 AgentSpec 中」），但另一条没有：老 Run 正常 resume 之后
       * 模型照着 transcript 再调一次旧名，收到的只是「没人认领」——
       * 排查方向会指向装配，而真正的原因是这个 Run 比工具改名更早。
       */
      const migrated = MIGRATED_TOOL_NAMES[action.toolName];
      return {
        ok: false,
        output: "",
        sideEffectState: "NOT_STARTED",
        error: makeError({
          code: "TOOL_NOT_FOUND",
          source: "TOOL_INPUT",
          category: "NOT_FOUND",
          retryability: "AFTER_MODEL_CORRECTION",
          sideEffectState: "NOT_STARTED",
          safeMessage:
            `没有任何已注册的工具包认领 "${action.toolName}"` +
            (migrated
              ? `。它在阶段 3 改名为 "${migrated}" —— 如果这是阶段 3 之前创建的 Run，` +
                `本版本不支持 resume 它（工具名对不上冻结在 RunSpec 里的快照，且不做别名表）。`
              : ""),
        }),
      };
    }
    return target.execute(action, ctx);
  }
}

export class CompositeVerifier implements VerificationPort {
  constructor(private readonly members: Array<VerificationPort & ToolNameRouted>) {}

  private routeFor(toolName: string): (VerificationPort & ToolNameRouted) | undefined {
    return this.members.find((m) => m.handles(toolName));
  }

  async verify(
    action: PreparedAction,
    outcome: ToolExecutionOutcome,
    ctx: ToolExecutionContext,
  ): Promise<VerificationResult> {
    const target = this.routeFor(action.toolName);
    if (!target) {
      // 无人认领的工具没有验证 —— 如实记 SKIPPED，不假装通过。
      return {
        id: `ver_${action.id}`,
        actionId: action.id,
        at: Date.now(),
        mode: "NONE",
        required: false,
        status: "SKIPPED",
        detail: `没有任何 Verifier 认领 "${action.toolName}"`,
      };
    }
    return target.verify(action, outcome, ctx);
  }

  /**
   * 【定】这个方法**必须**存在且真的路由。
   *
   * `settle-batch.ts` 的执行前指纹段判的是 `deps.verification.observePre`
   * 存不存在。类上有它、但内部永远返回 undefined，与「类上没有它」在
   * transcript 上完全不可区分 —— 两种情况下都是「没有 ACTION_FACT」。
   */
  async observePre(
    action: PreparedAction,
    ctx: ToolExecutionContext,
  ): Promise<ObservationResult | undefined> {
    const target = this.routeFor(action.toolName);
    return target?.observePre?.(action, ctx);
  }

  /** 同上。漏了它，分支二在 facade 的 `canObserve` 判定里直接不成立。 */
  async observePost(
    action: PreparedAction,
    ctx: ToolExecutionContext,
    preFingerprint: never,
  ): Promise<{ applied: boolean; detail: string } | undefined> {
    const target = this.routeFor(action.toolName);
    return target?.observePost?.(action, ctx, preFingerprint);
  }
}
