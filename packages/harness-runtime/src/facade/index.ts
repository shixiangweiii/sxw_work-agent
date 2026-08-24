/**
 * Runtime Facade（V05 §8.1）。
 *
 * 事件通过 generator 直接 yield，没有独立的 subscribe 通道。
 * 调用方 for await 消费，UI 投影与 Trace 落盘都在这一条流上。
 */

import { createHash } from "node:crypto";
import type { RunEvent } from "../types/event.js";
import type { Terminal } from "../types/loop.js";
import type {
  RecoveryItem,
  ResumableRunFacts,
  RunOutcome,
  RunSnapshot,
  RunSpec,
  RunStatus,
} from "../types/run.js";
import type { ActionBatchId, ActionId, ModelInvocationId, RunId } from "../types/ids.js";
import { asId } from "../types/ids.js";
import type { RuntimePorts, ToolExecutionContext } from "../ports/index.js";
import type {
  ApprovalDecider,
  PreparedAction,
  ToolSnapshot,
  VerificationResult,
} from "../types/tool.js";
import type { ContextMessage } from "../types/transcript.js";
import type { ModelContent } from "../types/context.js";
import { runLoop } from "../loop/run-loop.js";
import { settleWallOutcome } from "../verification/settle-outcome.js";
import { RunInterrupts } from "../loop/interrupt/index.js";
import {
  findUnpairedToolUses,
  makeRunFactsEntry,
  readRunFacts,
  type UnpairedToolUse,
} from "../transcript/index.js";
import { executeBatch } from "../action/settle-batch.js";
import { ToolRegistry, validateAndNormalize } from "../tool-runtime/index.js";

export interface HarnessRuntimeDeps {
  ports: RuntimePorts;
  approvalDecider: ApprovalDecider;
  workspaceRoot: string;
}

export interface StartResult {
  terminal: Terminal;
  /**
   * 【定】RECOVERY_REQUIRED 是 V05 §10.4 明确的**非终态** —— Run 没有结束，
   * 因此没有 outcome 可结算。这里用 undefined 表达「还没到结算的时候」，
   * 而不是硬塞一个 FAILED 或 COMPLETED_WITH_LIMITS 去糊弄类型。
   */
  outcome?: RunOutcome;
}

/** §18.2 三条分支 ＋ 一条「工具已不在 AgentSpec 里」的兜底。 */
type ResumeBranch = "IDEMPOTENT_RETRY" | "OBSERVE_FIRST" | "RECOVERY_REQUIRED" | "UNKNOWN_TOOL";

export interface ResumeOptions {
  /**
   * 对 RECOVERY_REQUIRED 的显式决策。
   *
   * 【定】Run 停在 RECOVERY_REQUIRED 时，**必须**带着它再调 resume()。
   * 不带就抛错 —— 否则「交用户决定」会退化成「停一次，下次自动放行」，
   * 那和不停是一回事。
   *
   *   CONTINUE：我已经人工确认过那些副作用的实际状态，销账并继续；
   *   ABORT   ：不继续了，把 Run 收在 CANCELLED，未销账项写进 outcome。
   */
  recoveryDecision?: "CONTINUE" | "ABORT";
  /** 决策理由。会进事件流与 Trace，供事后复盘。 */
  recoveryNote?: string;
}

export class HarnessRuntime {
  private readonly runs = new Map<string, RunInterrupts>();
  private readonly specs = new Map<string, RunSpec>();
  private readonly status = new Map<string, RunStatus>();
  /** 【定】一个 Run 同时只允许有一个循环在跑。 */
  private readonly running = new Set<string>();

  constructor(private readonly deps: HarnessRuntimeDeps) {}

  async *start(spec: RunSpec): AsyncGenerator<RunEvent, StartResult> {
    const runId = asId<RunId>(this.deps.ports.ids.next("run"));
    const interrupts = new RunInterrupts();
    this.runs.set(String(runId), interrupts);
    this.specs.set(String(runId), spec);
    this.status.set(String(runId), "RUNNING");
    this.running.add(String(runId));

    try {
      const gen = runLoop({
        runId,
        spec,
        ports: this.deps.ports,
        interrupts,
        approvalDecider: this.deps.approvalDecider,
        workspaceRoot: this.deps.workspaceRoot,
      });

      let r = await gen.next();
      while (!r.done) {
        yield r.value;
        r = await gen.next();
      }
      this.status.set(String(runId), terminalToStatus(r.value.terminal));
      return r.value;
    } finally {
      this.running.delete(String(runId));
    }
  }

  /**
   * resume()（V05 §18.4、D-24）。
   *
   * = 读 transcript → 重建 messages ＋ 读回累计事实 → 按 §18.2 处置末尾的未配对
   *   tool_use → 从下一轮迭代继续（或停在 RECOVERY_REQUIRED）。
   *
   * 【定】这里**没有**「不重复已证明完成的副作用」这一步。
   * 消息级恢复下，「工具跑没跑」在 transcript 上不可区分 ——
   * 只能靠 idempotency 声明与 Observation 逼近。这是选择消息级恢复的直接代价。
   */
  async *resume(runId: RunId, opts: ResumeOptions = {}): AsyncGenerator<RunEvent, StartResult> {
    const key = String(runId);
    const spec = this.specs.get(key);
    if (!spec) throw new Error(`未知 Run：${runId}。阶段 1 的 RunSpec 只在内存里。`);

    /**
     * 【定】生命周期闸门。
     *
     * COMPLETED / FAILED 是终态，重跑它们会把已经结算过的副作用再做一遍 ——
     * 带真实写操作时就是重复副作用。CANCELLED 与 RECOVERY_REQUIRED 不在此列：
     * V05 §10 明确「没有 PAUSED，cancel() 后稍后 resume()」就是支持的路径。
     */
    const current = this.status.get(key) ?? "CREATED";
    if (current === "COMPLETED" || current === "FAILED") {
      throw new Error(
        `Run ${runId} 已处于终态 ${current}，拒绝 resume。` +
          `重跑终态 Run 会重复已经结算过的副作用。`,
      );
    }
    if (this.running.has(key)) {
      throw new Error(`Run ${runId} 已有一个循环在执行，拒绝并发 resume（一个 Run 只有一个循环）。`);
    }
    /**
     * 【定】RECOVERY_REQUIRED 必须拿到一个显式决策才能离开。
     *
     * 少了这道闸门，「停下来交用户决定」就只是停一次 —— 再调一次 resume()
     * 就会因为配对已补齐而径直进主循环，副作用状态仍然没人确认过。
     */
    if (current === "RECOVERY_REQUIRED" && !opts.recoveryDecision) {
      throw new Error(
        `Run ${runId} 停在 RECOVERY_REQUIRED：上次崩溃时有工具的副作用状态无法判定，` +
          `且它既不幂等也无法观察。\n` +
          `请人工确认外部状态后，带着决策重新调用：\n` +
          `  resume(runId, { recoveryDecision: "CONTINUE" })  // 已确认，销账并继续\n` +
          `  resume(runId, { recoveryDecision: "ABORT" })     // 不继续，收在 CANCELLED`,
      );
    }

    const ports = this.deps.ports;
    const interrupts = new RunInterrupts();
    this.runs.set(key, interrupts);
    this.running.add(key);

    try {
      const entries = await ports.transcript.readAll(runId);
      const messages = await ports.transcript.rebuildMessages(runId);
      const lastSeq = await ports.transcript.lastSequence(runId);

      // 【定】§18.4：保留已完成副作用**和预算使用**。事实从 transcript 读回，
      // 不从零重建 —— 否则反复 crash + resume 就能绕开所有预算硬墙。
      const priorFacts = readRunFacts(entries);
      const verifications: VerificationResult[] = [...(priorFacts?.verifications ?? [])];
      const recoveryItems: RecoveryItem[] = [...(priorFacts?.recoveryItems ?? [])];

      // 事件序号从 transcript 末尾续起，逐条递增 —— 不再多条共用同一个号。
      let seq = lastSeq;
      const emit = <T extends RunEvent["type"]>(
        type: T,
        payload: Extract<RunEvent, { type: T }>["payload"],
      ): RunEvent => {
        seq += 1;
        const e = { runId, sequence: seq, occurredAt: ports.clock.now(), type, payload } as RunEvent;
        ports.trace.emit(e);
        return e;
      };

      /** 循环纪律第 3 条：先落盘，再更新内存数组。resume 路径同样适用。 */
      const appendAndPush = async (content: ModelContent[], turn: number): Promise<void> => {
        const message: ContextMessage = { role: "user", turn, content };
        await ports.transcript.append({
          runId,
          schemaVersion: 1,
          kind: "MESSAGE",
          message,
          createdAt: ports.clock.now(),
        });
        messages.push(message);
      };

      yield emit("ResumeStarted", {
        fromSequence: lastSeq,
        rebuiltMessages: messages.length,
      });

      // ── 处理上一次停在 RECOVERY_REQUIRED 时用户给出的决策
      if (current === "RECOVERY_REQUIRED" && opts.recoveryDecision) {
        yield emit("RecoveryResolved", {
          decision: opts.recoveryDecision,
          items: recoveryItems.length,
          note: opts.recoveryNote,
        });

        if (opts.recoveryDecision === "ABORT") {
          await ports.transcript.append(
            makeRunFactsEntry(
              runId,
              {
                turnCount: priorFacts?.turnCount ?? 0,
                consecutiveFailures: priorFacts?.consecutiveFailures ?? 0,
                budgetUsage: priorFacts?.budgetUsage ?? emptyBudget(ports.clock.now()),
                verifications,
                recoveryItems,
              },
              ports.clock.now(),
            ),
          );
          this.status.set(key, "CANCELLED");
          return {
            terminal: { reason: "ABORTED_TOOLS" },
            outcome: settleWallOutcome("CANCELLED", { verifications, recoveryItems }),
          };
        }

        // CONTINUE：用户说他已经人工确认过外部状态了，这些项就此销账。
        // 【定】只有显式决策能销账 —— Runtime 自己不得判定「大概没事」。
        recoveryItems.length = 0;
      }

      // ── §18.2 的三条分支
      const unpaired = findUnpairedToolUses(messages);
      const registry = new Map<string, ToolSnapshot>(
        spec.agentSpec.toolSnapshots.map((t) => [t.definition.name, t]),
      );
      const turn = messages[messages.length - 1]?.turn ?? 0;
      const hasUntrusted = messages.some((m) => m.content.some((c) => c.type === "tool_result"));

      let blocked = false;

      for (const u of unpaired) {
        const def = registry.get(u.toolName)?.definition;
        const branch: ResumeBranch = !def
          ? "UNKNOWN_TOOL"
          : def.idempotency.isReadOnly || def.idempotency.isIdempotent
            ? "IDEMPOTENT_RETRY"
            : def.verification.mode !== "NONE"
              ? "OBSERVE_FIRST"
              : "RECOVERY_REQUIRED";

        yield emit("ResumeUnpairedToolUse", {
          toolCallId: u.toolCallId,
          toolName: u.toolName,
          branch,
        });

        // ── 分支一：幂等或只读 → 真的重新执行一遍
        if (branch === "IDEMPOTENT_RETRY") {
          const batchGen = executeBatch([{ toolCallId: u.toolCallId, name: u.toolName, input: u.input }], {
            runId,
            invocationId: asId<ModelInvocationId>(ports.ids.next("inv")),
            registry: new ToolRegistry(spec.agentSpec.toolSnapshots),
            tools: ports.tools,
            effects: ports.effects,
            redaction: ports.redaction,
            verification: ports.verification,
            approvalDecider: this.deps.approvalDecider,
            approvalPolicy: spec.agentSpec.approvalPolicy,
            ids: ports.ids,
            now: () => ports.clock.now(),
            signal: interrupts.signal,
            workspaceRoot: this.deps.workspaceRoot,
            hasUntrustedContext: hasUntrusted,
          });
          let br = await batchGen.next();
          while (!br.done) {
            seq += 1;
            const withSeq = { ...br.value, sequence: seq } as RunEvent;
            ports.trace.emit(withSeq);
            yield withSeq;
            br = await batchGen.next();
          }
          verifications.push(...br.value.verifications);
          recoveryItems.push(...br.value.recoveryItems);
          // executeBatch 保证 results 恰好一条，且 toolCallId 与请求一致（不变量 8）。
          await appendAndPush(br.value.results, turn);
          continue;
        }

        // ── 分支二：有 Observation → 先观察外部世界，据结果决定
        if (branch === "OBSERVE_FIRST" && def) {
          const observed = await this.observe(runId, def, u, interrupts.signal);
          if (observed) {
            verifications.push(observed.verification);
            if (observed.verification.status === "SKIPPED") {
              // 观察给不出结论 —— 这与「观察后确认没做」是两回事，
              // 不得当成未执行继续推进，降级到第三条分支。
              blocked = true;
              recoveryItems.push({
                what: `${u.toolName} → 观察未能得出结论`,
                sideEffectState: "UNKNOWN",
                toolCallId: u.toolCallId,
              });
              await appendAndPush([recoveryResult(u, branch)], turn);
              continue;
            }
            const applied = observed.verification.status === "PASSED";
            await appendAndPush(
              [
                {
                  type: "tool_result",
                  toolCallId: u.toolCallId,
                  content: JSON.stringify({
                    status: applied ? "RESUMED_OBSERVED_APPLIED" : "RESUMED_OBSERVED_NOT_APPLIED",
                    reason: observed.verification.detail,
                    // 观察是可信的：确认达成就是 APPLIED，确认未达成就是 NOT_STARTED。
                    // 这正是分支二相对分支三的全部价值 —— 把 UNKNOWN 变成已知。
                    sideEffectState: applied ? "APPLIED" : "NOT_STARTED",
                  }),
                  isError: !applied,
                },
              ],
              turn,
            );
            continue;
          }
          // 观察本身失败（抛异常 / 入参已不合 schema）→ 落第三条分支
          blocked = true;
          recoveryItems.push({
            what: `${u.toolName} → 无法观察`,
            sideEffectState: "UNKNOWN",
            toolCallId: u.toolCallId,
          });
          await appendAndPush([recoveryResult(u, "RECOVERY_REQUIRED")], turn);
          continue;
        }

        // ── 分支三：非幂等且不可观察 → 交用户决定
        blocked = true;
        recoveryItems.push({
          what: `${u.toolName} → ${branch === "UNKNOWN_TOOL" ? "工具已不在 AgentSpec 中" : "非幂等且不可观察"}`,
          sideEffectState: "UNKNOWN",
          toolCallId: u.toolCallId,
        });
        // 配对仍然要补齐：transcript 里留一个无 result 的 tool_use，
        // 下次再 resume 就是一个失真的世界（不变量 8 不因阻塞而豁免）。
        await appendAndPush([recoveryResult(u, branch)], turn);
      }

      const facts: ResumableRunFacts = {
        turnCount: priorFacts?.turnCount ?? turn,
        consecutiveFailures: priorFacts?.consecutiveFailures ?? 0,
        budgetUsage: priorFacts?.budgetUsage ?? emptyBudget(ports.clock.now()),
        verifications,
        recoveryItems,
      };

      if (blocked) {
        /**
         * 【定】RECOVERY_REQUIRED 必须真的停住。
         *
         * 副作用状态未知时继续调模型 = 让模型在一个它以为已知、实际未知的世界里
         * 做下一步决策，而后续操作可能依赖那个未确认的外部状态。
         * 不变量 10（未知副作用不得自动重试）在消息级恢复下的落点就是这里。
         */
        await ports.transcript.append(makeRunFactsEntry(runId, facts, ports.clock.now()));
        this.status.set(key, "RECOVERY_REQUIRED");
        yield emit("RecoveryRequired", { items: recoveryItems.length });
        return { terminal: { reason: "RECOVERY_REQUIRED", recoveryItems } };
      }

      this.status.set(key, "RUNNING");

      const gen = runLoop({
        runId,
        spec,
        ports,
        interrupts,
        approvalDecider: this.deps.approvalDecider,
        workspaceRoot: this.deps.workspaceRoot,
        initialMessages: messages,
        resumeFrom: facts,
      });

      let r = await gen.next();
      while (!r.done) {
        yield r.value;
        r = await gen.next();
      }
      this.status.set(key, terminalToStatus(r.value.terminal));
      return r.value;
    } finally {
      this.running.delete(key);
    }
  }

  /**
   * §18.2 分支二的实际动作：**真的去读外部世界**。
   *
   * 之前这条分支只是合成一条 UNKNOWN 结果继续跑 —— 那恰好是它要防的双写：
   * 模型看到 UNKNOWN，多半会认为写入失败而再写一次。
   *
   * 传给 Verifier 的 outcome 是 `sideEffectState: "UNKNOWN"`，这是事实：
   * 崩溃点在 transcript 上就是不可区分的窗口 A/B。Verifier 据此决定去观察，
   * 而不是按「工具已明确失败」跳过。
   */
  private async observe(
    runId: RunId,
    def: ToolSnapshot["definition"],
    u: UnpairedToolUse,
    signal: AbortSignal,
  ): Promise<{ verification: VerificationResult } | undefined> {
    try {
      const validation = validateAndNormalize(u.input, def.inputSchema, def.name);
      if (!validation.ok || validation.normalized === undefined) return undefined;

      const resolvedEffect = this.deps.ports.effects.resolve(
        def.effectResolution,
        validation.normalized,
        this.deps.workspaceRoot,
      );
      const now = this.deps.ports.clock.now();
      const actionId = asId<ActionId>(this.deps.ports.ids.next("act"));
      const action: PreparedAction = {
        id: actionId,
        runId,
        batchId: asId<ActionBatchId>(this.deps.ports.ids.next("batch")),
        batchIndex: 0,
        toolCallId: u.toolCallId,
        toolName: u.toolName,
        rawInput: u.input,
        stage: "PREPARED",
        normalizedInput: validation.normalized,
        inputDigest: digest(JSON.stringify(validation.normalized)),
        resolvedEffect,
        actionDigest: digest([def.name, def.version, resolvedEffect.digest].join("|")),
        createdAt: now,
        preparedAt: now,
      };
      const ctx: ToolExecutionContext = {
        signal,
        workspaceRoot: this.deps.workspaceRoot,
        onProgress: () => {},
      };
      const verification = await this.deps.ports.verification.verify(
        action,
        { ok: false, output: "", sideEffectState: "UNKNOWN" },
        ctx,
      );
      return { verification };
    } catch {
      // 观察本身失败时不得假装观察过。调用方会把它降级到第三条分支。
      return undefined;
    }
  }

  interject(runId: RunId, content: string): void {
    this.runs
      .get(String(runId))
      ?.interjections.push(
        { content, intent: "ADD_CONTEXT", urgency: "NEXT_SAFE_POINT" },
        this.deps.ports.clock.now(),
      );
  }

  cancel(runId: RunId, reason?: string): void {
    this.runs.get(String(runId))?.cancel(reason);
  }

  inspect(runId: RunId): RunSnapshot | undefined {
    const spec = this.specs.get(String(runId));
    if (!spec) return undefined;
    return {
      runId,
      runSpecId: spec.id,
      status: this.status.get(String(runId)) ?? "CREATED",
      turnCount: 0,
      consecutiveFailures: 0,
      budgetUsage: {
        turns: 0,
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        billedInputTokens: 0,
        activeWallClockMs: 0,
        startedAt: spec.createdAt,
      },
      messageCount: 0,
      updatedAt: this.deps.ports.clock.now(),
    };
  }
}

/** 停在 RECOVERY_REQUIRED 时补的配对 result。副作用状态如实写 UNKNOWN。 */
function recoveryResult(u: UnpairedToolUse, branch: ResumeBranch): ModelContent {
  return {
    type: "tool_result",
    toolCallId: u.toolCallId,
    content: JSON.stringify({
      status: "RECOVERY_REQUIRED",
      reason:
        `上次运行在此工具执行期间结束，副作用状态无法从 transcript 判定（分支 ${branch}）。` +
        `已暂停，等待人工确认后再继续。`,
      sideEffectState: "UNKNOWN",
    }),
    isError: true,
  };
}

function emptyBudget(startedAt: number): ResumableRunFacts["budgetUsage"] {
  return {
    turns: 0,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    billedInputTokens: 0,
    activeWallClockMs: 0,
    startedAt,
  };
}

function digest(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function terminalToStatus(t: Terminal): RunStatus {
  switch (t.reason) {
    case "COMPLETED":
    case "COMPLETED_WITH_LIMITS":
      return "COMPLETED";
    case "ABORTED_STREAMING":
    case "ABORTED_TOOLS":
      return "CANCELLED";
    // 【定】非终态。Run 还活着，等用户的恢复决策。
    case "RECOVERY_REQUIRED":
      return "RECOVERY_REQUIRED";
    default:
      return "FAILED";
  }
}
