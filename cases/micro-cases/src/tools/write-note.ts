/**
 * write_note —— 写、可控慢、有独立 Verification。
 *
 * D-23 的形态约束：必须有一个可控慢的工具，否则 verify:pairing 的
 * 三条中断路径注入不进去 —— 快工具没有「执行到一半」这个状态。
 *
 * 慢是参数化的（delayMs），默认 0。验收脚本传大值，人工使用不受影响。
 *
 * 它同时是三件事的载体：
 *   1. 需要审批的写操作（TRUSTED_PERSONAL preset 下 WRITE 需要审批）；
 *   2. requiredForSuccess 的 Verification —— 唯一能把 SUCCESS 降级为
 *      COMPLETED_WITH_LIMITS 的信号（V05 §10.4）；
 *   3. 非幂等 ＋ 可观察 —— resume() 遇到它的未配对 tool_use 落进 §18.2 **第二条**分支
 *      （先观察外部世界，据结果决定）。第三条分支由 append_log 承载：
 *      判定顺序是「幂等 → 有 Observation → 其余」，声明了 REOBSERVE 就到不了第三条。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";

export const writeNoteDefinition: ToolDefinition = {
  id: asId("tool_write_note"),
  version: "1.0.0",
  name: "write_note",
  description:
    "把一段文本写入 workspace 内的文件。会覆盖已有内容。path 相对于 workspace 根目录。" +
    "delay_ms 用于人为放慢写入，正常使用时不要传。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对 workspace 根的文件路径" },
      content: { type: "string", description: "要写入的文本" },
      delay_ms: { type: "number", description: "人为延迟毫秒数，默认 0" },
    },
    required: ["path", "content"],
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
        // 覆盖写。不是 IRREVERSIBLE（文件还在），但也不是完全可逆（旧内容没了）。
        reversibility: "PARTIALLY_REVERSIBLE",
        operation: "write",
      },
    ],
  },
  redaction: { profile: "STANDARD" },
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  /**
   * 【定】非幂等。消息级恢复下这个声明是恢复正确性的前提（原则十五）：
   * resume() 无法区分「这个工具跑没跑」，只能靠这里的声明决定走哪条分支。
   *
   * 覆盖写严格说是幂等的（同样输入写两次结果一样），这里标成非幂等，
   * 是为了让「非幂等但可观察」这条路径有工具可测 —— 它配合下面的
   * verification.mode = "REOBSERVE"，恰好落在 §18.2 第二条分支上。
   */
  idempotency: { isIdempotent: false, isReadOnly: false },
  timeoutPolicy: { timeoutMs: 60_000 },
  cancellation: { cooperative: true },
  // 慢工具必须回报进展，否则 Progress Guard 会误判无进展（V05 §16.2）
  progressReporting: { mode: "HEARTBEAT", intervalMs: 1000 },
  verification: {
    mode: "REOBSERVE",
    // 唯一能把 SUCCESS 降级为 COMPLETED_WITH_LIMITS 的开关
    requiredForSuccess: true,
    observationCost: "LOW",
    timeoutMs: 5_000,
  },
};

export async function executeWriteNote(
  input: { path: string; content: string; delay_ms?: number },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const target = resolve(ctx.workspaceRoot, input.path);

  if (!isInside(ctx.workspaceRoot, target)) {
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
        safeMessage: `路径 "${input.path}" 落在 workspace 之外，拒绝写入`,
      }),
    };
  }

  const delay = Math.max(0, Number(input.delay_ms ?? 0));

  // 分段延迟并在每段之间检查 abort —— 这就是「可控慢」的实现方式。
  // 中断点落在写入之前，副作用状态是明确的 NOT_STARTED。
  const slices = delay > 0 ? Math.max(1, Math.ceil(delay / 200)) : 0;
  for (let i = 0; i < slices; i++) {
    if (ctx.signal.aborted) {
      return {
        ok: false,
        output: "",
        // 【定】中断在写入之前，副作用明确没有发生。
        // 这与 UNKNOWN 是两回事 —— UNKNOWN 不得自动重试，NOT_STARTED 可以。
        sideEffectState: "NOT_STARTED",
        error: makeError({
          code: "TOOL_CANCELLED",
          source: "RUNTIME",
          category: "CANCELLED",
          retryability: "SAME_INPUT_IMMEDIATE",
          sideEffectState: "NOT_STARTED",
          safeMessage: `write_note 在写入前被取消（已等待 ${i * 200}ms / 共 ${delay}ms）`,
        }),
      };
    }
    ctx.onProgress(`准备写入 ${input.path}（${i + 1}/${slices}）`);
    await sleep(Math.min(200, delay - i * 200));
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content, "utf8");
    return {
      ok: true,
      output: `已写入 ${input.path}（${Buffer.byteLength(input.content, "utf8")} 字节）`,
      sideEffectState: "APPLIED",
    };
  } catch (err) {
    return {
      ok: false,
      output: "",
      // 写到一半失败，无法确认磁盘上是什么状态。
      // 【定】UNKNOWN 不得自动重试（不变量 10）。
      sideEffectState: "UNKNOWN",
      error: makeError({
        code: "TOOL_FS_WRITE",
        source: "TOOL_HANDLER",
        category: "INTERNAL",
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "UNKNOWN",
        safeMessage: `写入失败，磁盘状态未知：${String((err as Error).message).slice(0, 160)}`,
      }),
    };
  }
}

/**
 * 独立 Verification（V05 §15.1）：Tool Handler 的 "success" 不能替代它。
 *
 * 这里真去读文件，而不是相信上面的返回值 —— 这正是「REOBSERVE」的含义。
 */
export async function verifyWriteNote(
  input: { path: string; content: string },
  ctx: ToolExecutionContext,
): Promise<{ ok: boolean; detail: string }> {
  const target = resolve(ctx.workspaceRoot, input.path);
  try {
    const actual = await readFile(target, "utf8");
    if (actual === input.content) {
      return { ok: true, detail: `重新读取 ${input.path}，内容与预期一致（${actual.length} 字符）` };
    }
    return {
      ok: false,
      detail: `重新读取 ${input.path}，内容与预期不一致：期望 ${input.content.length} 字符，实际 ${actual.length} 字符`,
    };
  } catch (err) {
    return { ok: false, detail: `重新读取 ${input.path} 失败：${String((err as Error).message).slice(0, 120)}` };
  }
}

function isInside(root: string, target: string): boolean {
  const r = resolve(root);
  return target === r || target.startsWith(r + "/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

export const writeNoteSnapshot: ToolSnapshot = {
  toolId: writeNoteDefinition.id,
  version: writeNoteDefinition.version,
  contentHash: "write_note@1.0.0",
  definition: writeNoteDefinition,
};
