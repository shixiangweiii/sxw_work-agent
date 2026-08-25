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
 *   · 不可观察：崩溃后重新读文件，看到那一行也无法断定「是上次那次调用写的」
 *     —— 同样的内容可能来自更早的调用。REOBSERVE 在这里给不出结论，
 *     所以它诚实地声明 verification.mode = "NONE"，而不是假装能验证。
 *
 * 这正是「消息级恢复的代价」最锋利的那个形状：transcript 上区分不了窗口 A 与 B，
 * 而工具自己也帮不上忙。除了停下来问人，没有安全的做法。
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
import { isInsideWorkspace } from "./fs-common.js";

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
   * 【定】声明「无法观察」，而不是声明一个给不出结论的 REOBSERVE。
   * 重新读文件看到那一行，也不能断定它来自上次那个 toolCallId。
   * 这个诚实的 NONE 就是 resume() 落进第三条分支的判据。
   */
  verification: {
    mode: "NONE",
    requiredForSuccess: false,
    observationCost: "LOW",
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
      error: makeError({
        code: "TOOL_PATH_ESCAPE",
        source: "TOOL_INPUT",
        category: "AUTHORIZATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `路径 "${input.path}" 落在 workspace 之外，拒绝追加`,
      }),
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
