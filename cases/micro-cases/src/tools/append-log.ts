/**
 * append_log —— 非幂等**且不可观察**的写工具。
 *
 * ── 它为什么必须存在 ──────────────────────────────────────────
 *
 * V05 §18.2【定】的第三条分支是「非幂等、无法观察 → RECOVERY_REQUIRED，交用户决定」，
 * 它是「未知副作用状态不得自动重试」（不变量 10）在消息级恢复下的落点。
 *
 * 但 resume() 的判定顺序是：幂等/只读 → 有 Observation → 其余。
 * list_dir 落分支一，write_note 声明了 REOBSERVE 必然落分支二 ——
 * **在只有这两个工具的工具集里，第三条分支永远不可达。**
 * 一条永远走不到的分支等于没有实现，它的正确性无法被任何验收脚本回答。
 *
 * ── 为什么是「追加」──────────────────────────────────────────
 *
 * 这两个属性不是为了凑测试硬贴的标签，是追加语义本身的性质：
 *
 *   · 非幂等：同样的输入执行两次，文件里就有两行。覆盖写没有这个问题。
 *   · 执行后验不了：验证器不知道「该有几行」。看到那一行也无法断定
 *     「是上次那次调用写的」—— 同样的内容可能来自更早的调用。
 *     所以 `verification.mode = "NONE"` 是诚实的，不是偷懒。
 *
 * ── 阶段 2 修正了一处措辞（决 6）──────────────────────────────
 *
 * 原文写「不可观察」，那是**错的**，或者说是把两件事混成了一件：
 *
 *   · 「执行后能不能验」   —— 不能。这是追加语义决定的。
 *   · 「崩溃后能不能观察」 —— **取决于执行前有没有拍下文件尾部的指纹**。
 *
 * 追加是**相对**操作：目标状态取决于起始状态。知道起始时文件尾部长什么样，
 * 就能判断那一行到底追加了没有；不知道就判不出来。所以它声明
 * `recoveryObservation: { requiresPreFingerprint: true }` ——
 * **原则上可观察，但这一次观察不观察得了是 Action 级事实**，
 * 由 Runtime 侧的 Verifier 决定，记在 transcript 的 ACTION_FACT 里。
 *
 * 这个区分是阶段 2 研究问题成立的前提：在此之前，「有多少次 resume 落进
 * 第三条分支」的分流依据就是这个工具身上的一个静态字段 ——
 * 测量仪器和被测对象是同一个旋钮。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";
// 边界判定只有一份实现，住在 tools/common（见那个文件的头注释）。
// 方向是 cases → tools，不违反边界 6b（那条禁的是 tools → cases）。
import { isInsideWorkspace, outsideWorkspaceError } from "@workagent/tools-common";

export const appendLogDefinition: ToolDefinition = {
  id: asId("tool_append_log"),
  version: "1.0.0",
  name: "append_log",
  description:
    "往 workspace 内的日志文件末尾追加一行。不会覆盖已有内容。" +
    "path 相对于 workspace 根目录。注意：重复调用会追加多行。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对 workspace 根的日志文件路径" },
      line: { type: "string", description: "要追加的一行文本" },
    },
    required: ["path", "line"],
  },
  // 【定】本字段当前零消费，授权层推到 bugfix 阶段（阶段 3 方案 S12）。
  requiredCapabilities: ["fs.write"],
  effectResolution: {
    kind: "DECLARATIVE",
    version: "1.0.0",
    rules: [
      {
        pointer: "/path",
        effectType: "WRITE",
        scopeKind: "FILE",
        // 追加写没法靠再写一次撤销，也没法把旧内容找回来。
        reversibility: "IRREVERSIBLE",
        operation: "append",
      },
    ],
  },
  redaction: { profile: "STANDARD" },
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  /** 【定】追加两次就是两行。这是语义决定的，不是实现凑的。 */
  idempotency: { isIdempotent: false, isReadOnly: false },
  timeoutPolicy: { timeoutMs: 10_000 },
  cancellation: { cooperative: true },
  progressReporting: { mode: "NONE" },
  /**
   * 【定】执行后无法验证 —— 验证器不知道「该有几行」。
   * 声明一个给不出结论的 REOBSERVE 比声明 NONE 更糟：它会让读代码的人
   * 以为这一步是被验过的。
   *
   * 注意它**不再**是「落第三条分支」的判据（决 6）。那个判据现在是
   * `recoveryObservation` ＋ 这次执行有没有真的拍到前置指纹。
   */
  verification: {
    mode: "NONE",
    requiredForSuccess: false,
    observationCost: "LOW",
  },
  /**
   * 崩溃后**原则上**可观察，但必须有执行前的尾部指纹（决 6）。
   *
   * `requiresPreFingerprint: true` 是这里的关键 —— 它把 append 与
   * write_note 区分开：后者比「内容 == 计划内容」就够了，不需要起始状态。
   */
  recoveryObservation: {
    kind: "TARGET_APPEND_TAIL",
    requiresPreFingerprint: true,
  },
};

export async function executeAppendLog(
  input: { path: string; line: string },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const target = resolve(ctx.workspaceRoot, input.path);

  if (!isInsideWorkspace(ctx.workspaceRoot, target)) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: outsideWorkspaceError(input.path, "追加"),
    };
  }

  if (ctx.signal.aborted) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NOT_STARTED",
      error: makeError({
        code: "TOOL_CANCELLED",
        source: "RUNTIME",
        category: "CANCELLED",
        retryability: "SAME_INPUT_IMMEDIATE",
        sideEffectState: "NOT_STARTED",
        safeMessage: "append_log 在写入前被取消",
      }),
    };
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${input.line}\n`, "utf8");
    return {
      ok: true,
      output: `已向 ${input.path} 追加 1 行`,
      sideEffectState: "APPLIED",
    };
  } catch (err) {
    return {
      ok: false,
      output: "",
      // 【定】追加到一半失败，盘上是什么状态无法确认，且**无法通过重读判定**。
      sideEffectState: "UNKNOWN",
      error: makeError({
        code: "TOOL_FS_APPEND",
        source: "TOOL_HANDLER",
        category: "INTERNAL",
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "UNKNOWN",
        safeMessage: `追加失败，磁盘状态未知：${String((err as Error).message).slice(0, 160)}`,
      }),
    };
  }
}

export const appendLogSnapshot: ToolSnapshot = {
  toolId: appendLogDefinition.id,
  version: appendLogDefinition.version,
  contentHash: "append_log@1.0.0",
  definition: appendLogDefinition,
};
