/**
 * 主循环（V05 §8.2）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 循环纪律五条，读这个文件时请对照：
 *
 * 1. 每个 continue 站点必须构造完整的 LoopState —— 由 nextState() 强制；
 * 2. 每个 continue 必须带具名 transition.reason；每个 return 必须是具名 Terminal；
 * 3. 消息先落盘再进 messages 数组 —— 由 appendAndPush() 强制；
 * 4. 流式 delta、进度、心跳不进 LoopState，直接 yield；
 * 5. 循环不读取端点能力声明。
 *
 * 第 5 条是原则十四在执行层的落点。本文件不得出现 profile.protocol.*、
 * profile.context.* 这类读取 —— 端点差异必须在形状适配器与 Context 层消化完毕。
 * 判据：grep -n "profile\." 本文件应无结果。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { RunEvent } from "../types/event.js";
import type { Continue, LoopState, Terminal } from "../types/loop.js";
import { nextState } from "../types/loop.js";
import type { RunSpec } from "../types/run.js";
import type { ContextMessage, TranscriptEntry } from "../types/transcript.js";
import { TRANSCRIPT_SCHEMA_VERSION } from "../types/transcript.js";
import type { ModelContent } from "../types/context.js";
import type { RunId } from "../types/ids.js";
import type { RuntimePorts } from "../ports/index.js";
import { compileFrame } from "../context/compile.js";
import { executeBatch, type BatchOutcome } from "../action/settle-batch.js";
import { settleOutcome, settleWallOutcome } from "../verification/settle-outcome.js";
import { ToolRegistry } from "../tool-runtime/index.js";
import type { ApprovalDecider, VerificationResult } from "../types/tool.js";
import type { RecoveryItem, ResumableRunFacts } from "../types/run.js";
import { makeRunFactsEntry } from "../transcript/index.js";
import { RunInterrupts } from "./interrupt/index.js";
import { makeError } from "../types/error.js";

export interface RunLoopDeps {
  runId: RunId;
  spec: RunSpec;
  ports: RuntimePorts;
  interrupts: RunInterrupts;
  approvalDecider: ApprovalDecider;
  workspaceRoot: string;
  /** resume() 时传入已重建的 messages；start() 时为空。 */
  initialMessages?: ContextMessage[];
  /**
   * resume() 时传入上次跑到哪了（V05 §18.4【定】保留预算使用）。
   * 【定】不传就是从零开始 —— 那正是「反复 crash + resume 绕过预算」的成因，
   * 所以 resume 路径必须传，由 facade 从 transcript 的 RUN_META 读回。
   */
  resumeFrom?: ResumableRunFacts | undefined;
}

export interface RunLoopResult {
  terminal: Terminal;
  outcome: ReturnType<typeof settleOutcome>;
}

export async function* runLoop(
  deps: RunLoopDeps,
): AsyncGenerator<RunEvent, RunLoopResult> {
  const { ports, spec, runId, interrupts } = deps;
  const registry = new ToolRegistry(spec.agentSpec.toolSnapshots);
  const now = (): number => ports.clock.now();

  let seq = 0;
  const emit = <T extends RunEvent["type"]>(
    type: T,
    payload: Extract<RunEvent, { type: T }>["payload"],
  ): RunEvent => {
    seq += 1;
    const e = { runId, sequence: seq, occurredAt: now(), type, payload } as RunEvent;
    ports.trace.emit(e);
    return e;
  };

  /**
   * 循环纪律第 3 条的强制点。
   * 先 await 落盘，再更新内存数组 —— 崩溃后 transcript 只可能与内存一致或领先。
   */
  const appendAndPush = async (
    messages: ContextMessage[],
    message: ContextMessage,
  ): Promise<ContextMessage[]> => {
    const entry: Omit<TranscriptEntry, "sequence"> = {
      runId,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      kind: "MESSAGE",
      message,
      createdAt: now(),
    };
    await ports.transcript.append(entry);
    return [...messages, message];
  };

  // ── 累积的事实。它们不进 LoopState（D-20：大对象外置），
  //    但 outcome 结算要用，所以随循环持有。
  // 【定】resume 时必须从上次的事实接着累计，不能从空数组重新开始 ——
  //    否则上一段跑出来的 Verification 与未销账的 RecoveryItem 全部蒸发。
  const verifications: VerificationResult[] = [...(deps.resumeFrom?.verifications ?? [])];
  const recoveryItems: RecoveryItem[] = [...(deps.resumeFrom?.recoveryItems ?? [])];

  let state: LoopState = {
    messages: deps.initialMessages ?? [],
    turnCount: deps.resumeFrom?.turnCount ?? 0,
    consecutiveFailures: deps.resumeFrom?.consecutiveFailures ?? 0,
    compactTracking: undefined,
    // 【定】V05 §18.4：resume 保留预算使用。startedAt 也必须继承 ——
    // 重置它等于把墙钟清零，一次 crash + resume 就能白拿一整个预算周期。
    budgetUsage: deps.resumeFrom?.budgetUsage ?? {
      turns: 0,
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      billedInputTokens: 0,
      activeWallClockMs: 0,
      startedAt: now(),
    },
    maxOutputTokensOverride: undefined,
    modelErrorRetries: 0,
    outputLimitRecoveries: 0,
    transition: undefined,
  };

  /**
   * 把「无法从消息序列反推的累计量」落到 transcript 上。
   *
   * 【定】每个出口与每轮边界都要写一次。只留在内存里的话，进程一死就归零，
   * 反复 crash + resume 就能无限绕过 maxTurns 与墙钟（不变量 11 被架空）。
   */
  const persistFacts = async (): Promise<void> => {
    const facts: ResumableRunFacts = {
      turnCount: state.turnCount,
      consecutiveFailures: state.consecutiveFailures,
      budgetUsage: state.budgetUsage,
      verifications,
      recoveryItems,
    };
    await ports.transcript.append(makeRunFactsEntry(runId, facts, now()));
  };

  // 首次启动才写入任务消息；resume() 时它已经在 transcript 里。
  if (!deps.initialMessages) {
    yield emit("RunStarted", {
      task: spec.input.task,
      endpointId: String(spec.agentSpec.model.endpointId),
      modelId: spec.agentSpec.model.modelId,
    });
    state = {
      ...state,
      messages: await appendAndPush(state.messages, {
        role: "user",
        turn: 0,
        content: [{ type: "text", text: spec.input.task }],
      }),
    };
  }

  /** 【定】所有出口都经过这里 —— 事实落盘与 outcome 结算是同一个动作的两半。 */
  const finish = async (terminal: Terminal): Promise<RunLoopResult> => {
    await persistFacts();
    const outcome =
      terminal.reason === "COMPLETED" || terminal.reason === "COMPLETED_WITH_LIMITS"
        ? settleOutcome({ verifications, recoveryItems })
        : settleWallOutcome(wallKind(terminal), { verifications, recoveryItems });
    return { terminal, outcome };
  };

  // ════════════════════════════════════════════════════════ while(true)

  while (true) {
    // ── ⓪ 排空 Interject 队列
    const pending = interrupts.interjections.drain();
    if (pending.length > 0) {
      for (const item of pending) {
        // 【定】插话不得创建 Grant、改变 Policy、批准 Action。
        // 它只是一条 USER_PROVIDED 的消息。
        state = {
          ...state,
          messages: await appendAndPush(state.messages, {
            role: "user",
            turn: state.turnCount,
            content: [{ type: "text", text: `[执行中插话] ${item.content}` }],
          }),
        };
        yield emit("InterjectionAccepted", { content: item.content });
      }
    }

    if (interrupts.aborted) return await finish({ reason: "ABORTED_TOOLS" });

    // ── 预算硬墙。【定】不得由模型决定忽略（不变量 11）。
    if (state.turnCount >= spec.budgets.maxTurns) {
      yield emit("BudgetHardLimitReached", {
        axis: "turns",
        used: state.turnCount,
        limit: spec.budgets.maxTurns,
      });
      return await finish({ reason: "MAX_TURNS", turnCount: state.turnCount });
    }
    const elapsed = now() - state.budgetUsage.startedAt;
    if (elapsed > spec.budgets.maxActiveWallClockMs) {
      yield emit("BudgetHardLimitReached", {
        axis: "activeWallClockMs",
        used: elapsed,
        limit: spec.budgets.maxActiveWallClockMs,
      });
      return await finish({ reason: "BUDGET_EXHAUSTED" });
    }
    if (state.consecutiveFailures >= spec.budgets.maxConsecutiveFailures) {
      return await finish({ reason: "BUDGET_EXHAUSTED" });
    }

    yield emit("TurnStarted", { turn: state.turnCount + 1 });

    // ── ① 上下文治理
    const compiled = await compileFrame(state.messages, {
      protocol: ports.protocol,
      ids: ports.ids,
      policy: spec.agentSpec.contextPolicy,
      systemPrompt: spec.agentSpec.systemPrompt,
      fixedOverheadTokens: registry.fixedOverheadTokens(),
      // 输出预算恢复的落点：抬高的上限必须真的进到这一次请求里，
      // 否则「抬高上限重试」就是拿同样的 max_tokens 再撞一次同一堵墙。
      reservedOutputTokensOverride: state.maxOutputTokensOverride,
      runId,
      now: now(),
    });

    if (compiled.compactionApplied.length > 0) {
      for (const rec of compiled.compactionApplied) {
        yield emit("ContextCompacted", { freedTokens: rec.freedTokens, reason: rec.reason });
      }
    }

    if (compiled.status === "COMPACTION_INSUFFICIENT") {
      // D-05：更激进的 Compact 已在 compileFrame 内尝试过，
      // 到这里说明 irreducible 本身超窗 → DETERMINISTIC handoff，不再调用模型。
      yield emit("BudgetHardLimitReached", {
        axis: "contextTokens",
        used: compiled.irreducibleTokens + compiled.fixedOverheadTokens,
        limit: spec.agentSpec.contextPolicy.hardInputLimitTokens,
      });
      return await finish({ reason: "CONTEXT_EXHAUSTED" });
    }

    if (compiled.status === "PROTOCOL_INVALID" || !compiled.frame) {
      // 【定】协议校验失败不得发起模型调用（V05 §11.5 不变量 7）。
      const err = makeError({
        code: "CONTEXT_PROTOCOL_INVALID",
        source: "CONTEXT",
        category: "PROTOCOL",
        retryability: "NEVER",
        sideEffectState: "NO_EFFECT",
        safeMessage: `ContextFrame 未通过协议校验：${compiled.protocolError ?? "未知"}`,
      });
      yield emit("RuntimeErrorOccurred", { error: err });
      return await finish({ reason: "MODEL_ERROR", error: err });
    }

    const frame = compiled.frame;
    yield emit("ContextFrameCompiled", {
      items: frame.items.length,
      totalTokens: compiled.totalTokens,
      fixedOverheadTokens: compiled.fixedOverheadTokens,
      compacted: compiled.compactionApplied.length > 0,
    });

    // ── ② 调模型
    const request = ports.protocol.buildRequest(frame);
    const startedAt = now();
    let invocation;
    try {
      const stream = ports.model.invoke(request, interrupts.signal);
      let r = await stream.next();
      while (!r.done) {
        const sev = r.value;
        // 循环纪律第 4 条：delta 直接 yield，不进 LoopState。
        if (sev.type === "text_delta") yield emit("ModelStreamDelta", { text: sev.text });
        r = await stream.next();
      }
      invocation = r.value;
    } catch (err) {
      const e = ports.protocol.classifyError(err);
      yield emit("RuntimeErrorOccurred", { error: e });

      if (e.category === "QUOTA") return await finish({ reason: "QUOTA_EXHAUSTED" });
      if (e.category === "CAPACITY") return await finish({ reason: "CONTEXT_EXHAUSTED" });

      if (
        e.retryability === "SAME_INPUT_BACKOFF" &&
        state.modelErrorRetries < spec.agentSpec.loopPolicy.maxModelErrorRetries
      ) {
        const attempt = state.modelErrorRetries + 1;
        await ports.clock.sleep(500 * attempt, interrupts.signal);
        state = nextState(
          state,
          { modelErrorRetries: attempt, consecutiveFailures: state.consecutiveFailures + 1 },
          { reason: "MODEL_ERROR_RETRY", attempt },
        );
        yield emit("LoopContinued", { transition: state.transition as Continue });
        continue;
      }
      return await finish({ reason: "MODEL_ERROR", error: e });
    }

    const usage = invocation.usage;
    yield emit("ModelInvocationCompleted", {
      toolCallCount: invocation.toolCalls.length,
      usage,
      stopReason: invocation.stopReason,
      durationMs: now() - startedAt,
    });

    const budget = {
      ...state.budgetUsage,
      modelCalls: state.budgetUsage.modelCalls + 1,
      inputTokens: state.budgetUsage.inputTokens + usage.inputTokens,
      outputTokens: state.budgetUsage.outputTokens + usage.outputTokens,
      // 【定】计费输入含缓存两项。只读 inputTokens 在命中时低估达 85%。
      billedInputTokens: state.budgetUsage.billedInputTokens + usage.billedInputTokens,
      activeWallClockMs: now() - state.budgetUsage.startedAt,
    };

    // 流式中断：半截内容不进入后续 Context，未闭合的 call 已被适配器丢弃。
    if (invocation.interrupted) {
      // 已发出但无 result 的 tool_use 在此合成 —— 三条中断路径之一。
      if (invocation.toolCalls.length > 0) {
        const synthesized = invocation.toolCalls.map(
          (c): ModelContent => ({
            type: "tool_result",
            toolCallId: c.toolCallId,
            content: JSON.stringify({
              status: "INTERRUPTED",
              reason: "模型响应流被中断，该工具未执行",
              sideEffectState: "NOT_STARTED",
            }),
            isError: true,
          }),
        );
        let msgs = await appendAndPush(state.messages, {
          role: "assistant",
          turn: state.turnCount + 1,
          content: invocation.content,
        });
        msgs = await appendAndPush(msgs, {
          role: "user",
          turn: state.turnCount + 1,
          content: synthesized,
        });
        state = { ...state, messages: msgs, budgetUsage: budget };
      } else {
        // 这次模型调用已经发生并计费了，中断不改变这个事实。
        state = { ...state, budgetUsage: budget };
      }
      return await finish({ reason: "ABORTED_STREAMING" });
    }

    // 推理吃光输出预算：接口成功、无错误码、内容为空。
    // 【定】识别为明确错误条件，而不是正常完成 —— 否则会把空回复
    // 当成模型的正常回答继续推进，产生一次静默的错误决策。
    const emptyOutput =
      invocation.stopReason === "max_tokens" &&
      invocation.toolCalls.length === 0 &&
      invocation.content.every((c) => c.type !== "text" || c.text.trim() === "");

    if (emptyOutput) {
      if (state.outputLimitRecoveries < spec.agentSpec.loopPolicy.maxOutputLimitRecoveries) {
        const attempt = state.outputLimitRecoveries + 1;
        yield emit("RuntimeErrorOccurred", {
          error: makeError({
            code: "MODEL_OUTPUT_EATEN_BY_REASONING",
            source: "MODEL_PROVIDER",
            category: "CAPACITY",
            retryability: "AFTER_ENVIRONMENT_CHANGE",
            sideEffectState: "NO_EFFECT",
            safeMessage: `输出预算被推理吃光（stop_reason=max_tokens 且正文为空），第 ${attempt} 次抬高上限重试`,
          }),
        });
        state = nextState(
          state,
          {
            budgetUsage: budget,
            outputLimitRecoveries: attempt,
            maxOutputTokensOverride: (state.maxOutputTokensOverride ?? frame.reservedOutputTokens) * 4,
          },
          { reason: "OUTPUT_LIMIT_RECOVERY", attempt },
        );
        yield emit("LoopContinued", { transition: state.transition as Continue });
        continue;
      }
      return await finish({ reason: "CONTEXT_EXHAUSTED" });
    }

    // 助手消息落盘
    let messages = await appendAndPush(state.messages, {
      role: "assistant",
      turn: state.turnCount + 1,
      content: invocation.content,
    });

    // ── ③ 模型不再请求工具 → 结算 outcome，退出
    if (invocation.toolCalls.length === 0) {
      state = {
        ...state,
        messages,
        budgetUsage: { ...budget, turns: state.turnCount + 1 },
        turnCount: state.turnCount + 1,
      };
      const r = settleOutcome({ verifications, recoveryItems });
      // 走 finish() 而不是直接构造返回值 —— 否则这条最常见的出口
      // 会绕过事实落盘，resume 读到的预算永远停在上一轮。
      return await finish(
        r.kind === "SUCCESS"
          ? { reason: "COMPLETED" }
          : { reason: "COMPLETED_WITH_LIMITS", incompleteItems: r.incompleteItems },
      );
    }

    // ── ④ 执行 ActionBatch
    let batchOutcome: BatchOutcome;
    const batchGen = executeBatch(
      invocation.toolCalls.map((c) => ({ toolCallId: c.toolCallId, name: c.name, input: c.input })),
      {
        runId,
        invocationId: frame.invocationId,
        registry,
        tools: ports.tools,
        effects: ports.effects,
        redaction: ports.redaction,
        verification: ports.verification,
        approvalDecider: deps.approvalDecider,
        approvalPolicy: spec.agentSpec.approvalPolicy,
        ids: ports.ids,
        now,
        signal: interrupts.signal,
        workspaceRoot: deps.workspaceRoot,
        hasUntrustedContext: frame.trustSummary.hasExternalUntrusted,
      },
    );

    {
      let r = await batchGen.next();
      while (!r.done) {
        const bev = r.value;
        seq += 1;
        const withSeq = { ...bev, sequence: seq } as RunEvent;
        ports.trace.emit(withSeq);
        yield withSeq;
        r = await batchGen.next();
      }
      batchOutcome = r.value;
    }

    verifications.push(...batchOutcome.verifications);
    recoveryItems.push(...batchOutcome.recoveryItems);

    // 【定】不变量 8 的落盘点：results 恰好 calls.length 条。
    messages = await appendAndPush(messages, {
      role: "user",
      turn: state.turnCount + 1,
      content: batchOutcome.results,
    });

    if (batchOutcome.aborted) {
      state = { ...state, messages, budgetUsage: budget };
      return await finish({ reason: "ABORTED_TOOLS" });
    }

    const anyFailed = batchOutcome.attempts.some((a) => a.status === "FAILED");
    const anyVerified = batchOutcome.verifications.some((v) => v.status === "PASSED");

    // ── ⑤ 构造下一轮完整状态，显式写明原因（循环纪律第 1、2 条）
    state = nextState(
      state,
      {
        messages,
        turnCount: state.turnCount + 1,
        budgetUsage: {
          ...budget,
          turns: state.turnCount + 1,
          toolCalls: budget.toolCalls + invocation.toolCalls.length,
        },
        // consecutiveFailures 归零条件：任一 Action 成功且其 required Verification 通过
        consecutiveFailures: anyVerified
          ? 0
          : anyFailed
            ? state.consecutiveFailures + 1
            : state.consecutiveFailures,
        modelErrorRetries: 0,
        outputLimitRecoveries: 0,
        maxOutputTokensOverride: undefined,
      },
      { reason: "NEXT_TURN" },
    );
    // 【定】轮边界也要落一次事实。进程死在下一轮的模型调用里时，
    // resume 读回的是这一轮结束时的预算，而不是整个 Run 的起点。
    await persistFacts();
    yield emit("LoopContinued", { transition: state.transition as Continue });
  }
}

function wallKind(
  t: Terminal,
): "BUDGET_EXHAUSTED" | "CONTEXT_EXHAUSTED" | "QUOTA_EXHAUSTED" | "CANCELLED" | "FAILED" {
  switch (t.reason) {
    case "BUDGET_EXHAUSTED":
    case "MAX_TURNS":
      return "BUDGET_EXHAUSTED";
    case "CONTEXT_EXHAUSTED":
      return "CONTEXT_EXHAUSTED";
    case "QUOTA_EXHAUSTED":
      return "QUOTA_EXHAUSTED";
    case "ABORTED_STREAMING":
    case "ABORTED_TOOLS":
      return "CANCELLED";
    default:
      return "FAILED";
  }
}
