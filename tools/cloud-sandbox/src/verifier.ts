/**
 * `cloud_shell` 的观察器（ADR-0016）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它存在的全部意义是回答一个**按调用**变化的问题：
 *
 *     崩在这次 cloud_shell 中途，事后能不能判断它发生没发生？
 *
 * 【定】答案取决于这次调用有没有开网，所以这是**Action 级事实**，
 * 不是工具的静态声明（决 6：「分支判据是 Action 级事实」）。
 *
 *   network="none"  →  归还即销毁，durable effect 恰好是取回来的 outputs，
 *                      而那是 workspace 里的已知路径 → **可观察，分支二**
 *   开了网          →  命令可能调过外部 API，那部分无从观察 → **分支三**
 *
 * 这比 `run_shell` 好一档：本机 shell 的副作用范围本身就说不清，所以它
 * `canObserve` 恒假。这里能说清，是因为「用完即销毁」把范围收窄了。
 *
 * 【定】`verify()` 一律 SKIPPED。再跑一条命令去「核实」上一条，那是模型的
 * 观察、不是独立证据 —— 与 `ComputerVerifier` 同一条理由。
 * ══════════════════════════════════════════════════════════════════════
 */

import { stat } from "node:fs/promises";
import type {
  JsonValue,
  ObservationResult,
  PreparedAction,
  ToolExecutionContext,
  ToolExecutionOutcome,
  VerificationPort,
  VerificationResult,
} from "@workagent/harness-runtime";
import { resolveToolPath } from "@workagent/tools-common";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./definitions.js";
import { parseInput } from "./input.js";

/** 一个 outputs 文件的执行前指纹。与 run_shell 同口径：问的是「命令碰没碰它」。 */
interface OutputFingerprint {
  path: string;
  exists: boolean;
  mtimeMs?: number;
  size?: number;
}

async function snapshot(abs: string, rel: string): Promise<OutputFingerprint> {
  try {
    const st = await stat(abs);
    return { path: rel, exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { path: rel, exists: false };
  }
}

export class CloudSandboxVerifier implements VerificationPort {
  handles(name: string): boolean {
    return name === "cloud_shell";
  }

  async verify(
    action: PreparedAction,
    _outcome: ToolExecutionOutcome,
    _ctx: ToolExecutionContext,
  ): Promise<VerificationResult> {
    return {
      id: `ver_${action.id}`,
      actionId: action.id,
      at: Date.now(),
      mode: "NONE",
      required: false,
      status: "SKIPPED",
      detail:
        `cloud_shell 没有独立的事后核实：沙箱已经销毁，能再看的只有取回来的那几个文件，` +
        `而它们的结构检查已经由产物链做过。再跑一条命令去「确认」上一条，` +
        `那是模型的观察、不是独立证据。（${action.toolName}）`,
    };
  }

  async observePre(
    action: PreparedAction,
    ctx: ToolExecutionContext,
  ): Promise<ObservationResult | undefined> {
    if (!this.handles(action.toolName)) return undefined;
    const input = parseInput((action.normalizedInput ?? {}) as Record<string, unknown>, {
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: MAX_TIMEOUT_MS,
    });
    /**
     * 【定】开了网就**拍不了**指纹 —— 返回 undefined 让它落分支三。
     *
     * 不是「懒得拍」：拍了也只能答「本地那几个文件变没变」，而开了网的命令
     * 可能已经往外面发过东西了。给出一个只覆盖一半的观察，比不给更糟 ——
     * 它会让这次 Action 落进分支二，而分支二的含义是「观察过、能判断」。
     */
    if (input.network.kind !== "none") return undefined;
    /**
     * 没声明 outputs 也观察不了 —— 这次执行对本地没有任何 durable effect，
     * 但「什么都没发生」与「跑了但什么都没带回来」在事后同样不可区分，
     * 而 Runtime 要的是后者那种确定性。如实说观察不了。
     */
    if (input.outputs.length === 0) return undefined;

    const fingerprints: OutputFingerprint[] = [];
    for (const rel of input.outputs) {
      fingerprints.push(await snapshot(resolveToolPath(ctx.workspaceRoot, rel), rel));
    }
    // 【定】ObservationResult 只有 fingerprint 与 at —— 它刻意不带「说明」：
    // Runtime 不理解指纹的内容，一段解释文字在那里没有消费者（见它的注释）。
    return { fingerprint: fingerprints as unknown as JsonValue, at: Date.now() };
  }

  async observePost(
    action: PreparedAction,
    ctx: ToolExecutionContext,
    pre: unknown,
  ): Promise<{ applied: boolean; detail: string } | undefined> {
    if (!this.handles(action.toolName)) return undefined;
    if (!Array.isArray(pre)) return undefined;
    const before = pre as OutputFingerprint[];
    const changed: string[] = [];
    for (const b of before) {
      const now = await snapshot(resolveToolPath(ctx.workspaceRoot, b.path), b.path);
      // 【定】读不了 ≠ 没变。任何一个判不出来就整体给不出结论 → 降级到分支三。
      if (b.exists !== now.exists || b.mtimeMs !== now.mtimeMs || b.size !== now.size) {
        changed.push(b.path);
      }
    }
    return {
      applied: changed.length > 0,
      detail:
        changed.length > 0
          ? `这些 outputs 在崩溃前已经落回 workspace：${changed.join("、")}`
          : `所有声明的 outputs 都没有变化 —— 那次执行没有把任何文件带回来`,
    };
  }
}
