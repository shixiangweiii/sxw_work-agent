/**
 * slow_write —— 可控慢的**写**。【测量工具，只在 Micro Case 包里】
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它为什么必须存在，以及为什么必须是「慢的写」而不是「慢的空转」
 *
 * `verify:pairing` 的第二条中断路径判据（§9.2「工具执行中被 cancel」）
 * 原本挂在 `write_note` 的 `delay_ms` 上。阶段 3 把 `write_note` 迁进
 * `tools/common` 并改名 `write_file`，同时**去掉了 `delay_ms`** ——
 * 一个通用工具的入参里不该有「请慢一点」这种只服务于测量的旋钮，
 * 那正是「能力面被测量需求反向定义」的现场。
 *
 * 于是那条判据失去载体。补法有两种，选了后者：
 *
 *   · 一个纯延迟的 noop 工具 —— 测的是「延迟被取消」；
 *   · 一个**可控慢的写**     —— 测的是「写文件执行到一半被取消」。
 *
 * 两者不是同一个不变量场景：前者永远 `NO_EFFECT`，
 * `sideEffectState` 的诚实上报**测不到**。而不变量 8 在取消路径上真正
 * 要守的，恰恰是「半截副作用有没有被如实说出来」。
 *
 * 【定】它留在 `cases/micro-cases`，不进 `tools/common`。
 * 按决 2 的两类标准：它既不是三场景常用（没有人需要「慢慢地写」），
 * 也不服务某条 Harness 机制 —— 它服务的是**对机制的测量**。
 * 硬塞进通用工具包会破坏那两条标准的纯度。
 * ══════════════════════════════════════════════════════════════════════
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId } from "@workagent/harness-runtime";
import {
  cancelledError,
  classifyFsError,
  writeBoundaryRefusal,
  resolveToolPath,
} from "@workagent/tools-common";

export const slowWriteDefinition: ToolDefinition = {
  id: asId("tool_slow_write"),
  version: "1.0.0",
  name: "slow_write",
  description:
    "把一段文本写入 workspace 内的文件，写之前先人为等待 delay_ms 毫秒。" +
    "这是**测量用**工具，正常任务不要调用它 —— 需要写文件请用 write_file。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "相对 workspace 根的文件路径" },
      content: { type: "string", description: "要写入的文本" },
      delay_ms: { type: "number", description: "写入前人为延迟的毫秒数，默认 0" },
    },
    required: ["path", "content"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/path",
      effectType: "WRITE",
      scopeKind: "FILE",
      reversibility: "PARTIALLY_REVERSIBLE",
      operation: "write",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: false, isReadOnly: false },
  timeoutPolicy: { timeoutMs: 60_000 },
  /**
   * 慢工具必须回报进展（V05 §16.2）。
   *
   * 【定】实现每 200ms 报一次（`slices` 按 `delay/200` 切，每段一次），
   * 而 `verify:progress` A 段的「600ms 至少报 3 次」正是按这个节奏写的。
   *
   * 【定】节奏**不在声明里** —— `ProgressReportingDescriptor` 只有 `mode`。
   * 这段注释此前写着「intervalMs 是 200，与实现一致」，而那个字段在
   * 2026-08-31 那批已被删除：一句「声明与实现一致」指着一个不存在的声明。
   * 要改节奏就改下面那个除数，同时改 `verify:progress` 的期望值 ——
   * 两者的一致性只有那条判据在管。
   */
  progressReporting: { mode: "HEARTBEAT" },
  verification: {
    mode: "REOBSERVE",
    requiredForSuccess: true,
  },
  recoveryObservation: { requiresPreFingerprint: false },
};

export async function executeSlowWrite(
  input: { path: string; content: string; delay_ms?: number },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const target = resolveToolPath(ctx.workspaceRoot, input.path);

  // 【定】与 tools/common 的三个写工具共用**同一份**边界判定
  // （`writeBoundaryRefusal`）。ADR-0012 加了 executionPrivilege 这一维，
  // 四处里漏改任何一处就会出现「同一个越界写，这个工具放行那个工具拒绝」。
  const refusal = writeBoundaryRefusal(ctx, target, "写入", input.path);
  if (refusal) {
    return { ok: false, output: "", sideEffectState: "NO_EFFECT", error: refusal };
  }

  const delay = Math.max(0, Number(input.delay_ms ?? 0));

  /**
   * 分段延迟并在每段之间检查 abort —— 这就是「可控慢」的实现方式。
   *
   * 【定】中断点落在写入**之前**，所以副作用状态是明确的 NOT_STARTED，
   * 不是 UNKNOWN。两者的差别很实在：UNKNOWN 会造出一个 RecoveryItem
   * 并在 resume 时把 Run 停在 RECOVERY_REQUIRED，而这里我们真的知道
   * 什么都没发生。谎报的方向恰好是最贵的那边。
   */
  const slices = delay > 0 ? Math.max(1, Math.ceil(delay / 200)) : 0;
  for (let i = 0; i < slices; i++) {
    // 【定】走 `cancelledError`（唯一一份）。逐次不同的那句「等了多久」
    // 由它的 `detail` 参数承载 —— 那个参数正是为了让第四处也能共用而加的，
    // 否则这里会以「我要多说一句」为由再抄一遍。
    if (ctx.signal.aborted) {
      return {
        ok: false,
        output: "",
        sideEffectState: "NOT_STARTED",
        error: cancelledError("slow_write", `已等待 ${i * 200}ms / 共 ${delay}ms`),
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
      // 写到一半失败，无法确认磁盘上是什么状态。UNKNOWN 不得自动重试（不变量 10）。
      sideEffectState: "UNKNOWN",
      error: { ...classifyFsError(err, `写入 "${input.path}"`), sideEffectState: "UNKNOWN" },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

export const slowWriteSnapshot: ToolSnapshot = {
  toolId: slowWriteDefinition.id,
  version: slowWriteDefinition.version,
  definition: slowWriteDefinition,
};
