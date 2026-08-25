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

  /**
   * D-2：事件号一律向 transcript store 要，不再维护本地计数器。
   *
   * 本地计数器的问题不是「会不会重号」，是 resume 之后它从 0 重计 ——
   * 于是第二段的事件 1..n 与第一段的事件 1..m 在 Trace 里无法定序。
   * 取号点收敛到 store 之后，两段自然接得上（见 ports 里 nextSequence 的说明）。
   *
   * 【定】lastSequence 要跟着更新 —— persistFacts() 靠它落高水位。
   */
  let lastSequence = deps.resumeFrom?.lastSequence ?? 0;
  const emit = async <T extends RunEvent["type"]>(
    type: T,
    payload: Extract<RunEvent, { type: T }>["payload"],
  ): Promise<RunEvent> => {
    lastSequence = await ports.transcript.nextSequence(runId, lastSequence);
    const e = { runId, sequence: lastSequence, occurredAt: now(), type, payload } as RunEvent;
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
    // append 内部也从同一个分配器取号（D-2），把它记回来，
    // lastSequence 才不只是「最后一个事件号」。
    //
    // 注意它是**下界而非精确高水位**：persistFacts() 自己那次 append 就没有回写
    // （回写也没用，facts 的内容在 append 之前就得定下来，构不成自指）。
    // 这不影响正确性 —— resume 侧取 `max(transcript 末尾号, facts.lastSequence)`，
    // 前者恰好覆盖了这里漏掉的那一个。
    lastSequence = await ports.transcript.append(entry);
    return [...messages, message];
  };

  // ── 累积的事实。它们不进 LoopState（D-20：大对象外置），
  //    但 outcome 结算要用，所以随循环持有。
  // 【定】resume 时必须从上次的事实接着累计，不能从空数组重新开始 ——
  //    否则上一段跑出来的 Verification 与未销账的 RecoveryItem 全部蒸发。
  const verifications: VerificationResult[] = [...(deps.resumeFrom?.verifications ?? [])];
  const recoveryItems: RecoveryItem[] = [...(deps.resumeFrom?.recoveryItems ?? [])];

  /**
   * 模型最后说的那段话，用来填 `RunOutcome.summary`（存量清单 R-7）。
   *
   * 在此之前 `SettleInput.summary` 字段在、三个调用点一个都没传，于是模型那段
   * 「我做了什么」或「我做不了，原因如下」既不进 outcome，CLI 也就打不出来 ——
   * 用户看到的只有一个孤零零的 `SUCCESS`。2026-08-24 的实跑里模型正确地
   * 拒绝了一个无工具可用的任务，终端照样打 `COMPLETED / SUCCESS`。
   *
   * 【定】这里只补 summary，**不动 `outcome.kind` 的值域**。
   * 「模型明确声明做不了」该不该有独立的 kind，是 R-7 与 U-8 的合并设计题
   * （`outcome.kind` 要不要区分「是谁没做成」），拍板前不得在代码里固化任一候选。
   * 但即便 kind 判不准，人也应该能从 outcome 里读到究竟发生了什么 —— 这就是这一行的价值。
   */
  let lastAssistantText: string | undefined;

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
   *
   * 【定】调用顺序：**先把这一步的事件 emit 完，再调它**（D-2）。
   * 反过来的话，RUN_META 拿到号 N、随后的事件拿到 N＋1，而落盘的
   * facts.lastSequence 停在 N−1；下次 resume 从 max(N, N−1)＝N 续起，
   * 再发一个事件又是 N＋1 —— 与崩溃前那个撞号。事件不落 transcript，
   * 没有任何东西会替你发现这次重号。
   */
  const persistFacts = async (): Promise<void> => {
    const facts: ResumableRunFacts = {
      turnCount: state.turnCount,
      consecutiveFailures: state.consecutiveFailures,
      budgetUsage: state.budgetUsage,
      verifications,
      recoveryItems,
      // D-2：事件不落 transcript，高水位只能显式存。见 ResumableRunFacts 的说明。
      lastSequence,
    };
    await ports.transcript.append(makeRunFactsEntry(runId, facts, now()));
  };

  // 首次启动才写入任务消息；resume() 时它已经在 transcript 里。
  if (!deps.initialMessages) {
    yield await emit("RunStarted", {
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

  /**
   * 【定】所有出口都经过这里 —— 事实落盘与 outcome 结算是同一个动作的两半。
   *
   * 它是 generator 而不是普通 async 函数，唯一原因是要 yield `LoopTerminated`（U-4）。
   * 调用点因此是 `return yield* finish(...)`，不是普通的 await 调用。
   *
   * ── 为什么非得发这条事件 ─────────────────────────────────────
   *
   * §19.2 说「Trace 里能直接读出走了哪条路径」。在此之前这句话对 continue 成立
   * （LoopContinued 带具名 reason），对**终止**不成立 —— 终止原因只存在于
   * generator 的返回值里，只有直接 await 这个 generator 的调用方看得到。
   * Trace sink 看不到，于是一份落盘的 trace 恰好缺最重要的那一行。
   *
   * 循环纪律第 2 条要求「每个 return 是具名 Terminal」；这条事件是那条纪律
   * 在可观测侧的落点，不是可选的装饰。
   */
  async function* finish(terminal: Terminal): AsyncGenerator<RunEvent, RunLoopResult> {
    const settleInput = { verifications, recoveryItems, summary: lastAssistantText };
    const outcome =
      terminal.reason === "COMPLETED" || terminal.reason === "COMPLETED_WITH_LIMITS"
        ? settleOutcome(settleInput)
        : settleWallOutcome(wallKind(terminal), settleInput);

    // 【定】emit 在 persistFacts 之前 —— 见 persistFacts 的顺序说明（D-2）。
    yield await emit("LoopTerminated", { terminal, outcome });
    await persistFacts();
    return { terminal, outcome };
  }

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
        yield await emit("InterjectionAccepted", { content: item.content });
      }
    }

    if (interrupts.aborted) return yield* finish({ reason: "ABORTED_TOOLS" });

    // ── 预算硬墙。【定】不得由模型决定忽略（不变量 11）。
    if (state.turnCount >= spec.budgets.maxTurns) {
      yield await emit("BudgetHardLimitReached", {
        axis: "turns",
        used: state.turnCount,
        limit: spec.budgets.maxTurns,
      });
      return yield* finish({ reason: "MAX_TURNS", turnCount: state.turnCount });
    }
    const elapsed = now() - state.budgetUsage.startedAt;
    if (elapsed > spec.budgets.maxActiveWallClockMs) {
      yield await emit("BudgetHardLimitReached", {
        axis: "activeWallClockMs",
        used: elapsed,
        limit: spec.budgets.maxActiveWallClockMs,
      });
      return yield* finish({ reason: "BUDGET_EXHAUSTED" });
    }
    if (state.consecutiveFailures >= spec.budgets.maxConsecutiveFailures) {
      return yield* finish({ reason: "BUDGET_EXHAUSTED" });
    }

    yield await emit("TurnStarted", { turn: state.turnCount + 1 });

    // ── ① 上下文治理
    const compiled = await compileFrame(state.messages, {
      protocol: ports.protocol,
      ids: ports.ids,
      policy: spec.agentSpec.contextPolicy,
      systemPrompt: spec.agentSpec.systemPrompt,
      timezone: spec.agentSpec.timezone,
      fixedOverheadTokens: registry.fixedOverheadTokens(),
      // 输出预算恢复的落点：抬高的上限必须真的进到这一次请求里，
      // 否则「抬高上限重试」就是拿同样的 max_tokens 再撞一次同一堵墙。
      reservedOutputTokensOverride: state.maxOutputTokensOverride,
      runId,
      now: now(),
    });

    if (compiled.compactionApplied.length > 0) {
      for (const rec of compiled.compactionApplied) {
        yield await emit("ContextCompacted", { freedTokens: rec.freedTokens, reason: rec.reason });
      }

      /**
       * R-6 的落地点：把压缩结果真的写进 transcript 与 state.messages。
       *
       * 修复前这两件事都没做 —— ContextCompacted 事件照发，但 state.messages
       * 原封不动，下一轮又从完整历史开始。事件流上看压缩生效了，实际没有。
       *
       * ── 顺序：先落 boundary ＋ kept，再改内存 ────────────────────
       *
       * 与循环纪律第 3 条同构。崩在中间时，transcript 只可能与内存一致或领先，
       * 反过来则会丢掉一段只存在于内存里的压缩结果。
       *
       * ── 为什么 kept 要重新 append 一遍 ──────────────────────────
       *
       * rebuildFromEntries 的语义是「boundary.compactSummary ＋ boundary 之后的
       * MESSAGE 条目」。kept 里的消息原本都在 boundary **之前**，不重新 append
       * 就会在重建时全部消失 —— resume 出来的上下文比压缩后的还要短。
       *
       * 重复写入是 append-only 日志的诚实代价，换来的是「重建结果 == 刚才真的
       * 发出去的东西」这条等式成立。Compact 只在超过 soft limit 时触发，
       * 压完就回到线下，不是每轮都付这个代价。
       */
      if (compiled.compactedMessages) {
        /**
         * 【定】只有**真的丢了消息**（compactSummary 存在）才写 boundary。
         *
         * boundary 的语义是「它之前的内容已被摘要取代」。没丢任何消息时
         * 没有东西被取代，写它是错的，而且要连带把 kept 重新 append 一遍 ——
         * 六轮的 Run 会滚出 58 条 transcript，全是重复。
         *
         * 那「只剥了推理块」这种情况怎么办？答案是**什么都不用做**：
         * transcript 保留完整原文（§18.5「boundary 之前的原文保留供 Trace 与
         * Replay 使用」本来就是这个意思），而剥离是一个纯粹的预算决定，
         * resume 之后 compileFrame 会按当时的阈值重新算一遍。
         * 把它记进 transcript 反而是把一次临时决定固化成了历史事实。
         */
        if (compiled.compactSummary && compiled.compactKept) {
          lastSequence = await ports.transcript.append({
            runId,
            schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
            kind: "COMPACT_BOUNDARY",
            compactSummary: compiled.compactSummary,
            createdAt: now(),
          });
          for (const m of compiled.compactKept) {
            lastSequence = await ports.transcript.append({
              runId,
              schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
              kind: "MESSAGE",
              message: m,
              createdAt: now(),
            });
          }
        }
        state = { ...state, messages: compiled.compactedMessages };
      }
    }

    if (compiled.status === "COMPACTION_INSUFFICIENT") {
      // D-05：更激进的 Compact 已在 compileFrame 内尝试过，
      // 到这里说明 irreducible 本身超窗 → DETERMINISTIC handoff，不再调用模型。
      yield await emit("BudgetHardLimitReached", {
        axis: "contextTokens",
        used: compiled.irreducibleTokens + compiled.fixedOverheadTokens,
        limit: spec.agentSpec.contextPolicy.hardInputLimitTokens,
      });
      return yield* finish({ reason: "CONTEXT_EXHAUSTED" });
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
      yield await emit("RuntimeErrorOccurred", { error: err });
      return yield* finish({ reason: "MODEL_ERROR", error: err });
    }

    const frame = compiled.frame;
    yield await emit("ContextFrameCompiled", {
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
        if (sev.type === "text_delta") yield await emit("ModelStreamDelta", { text: sev.text });
        r = await stream.next();
      }
      invocation = r.value;
    } catch (err) {
      const e = ports.protocol.classifyError(err);
      yield await emit("RuntimeErrorOccurred", { error: e });

      if (e.category === "QUOTA") return yield* finish({ reason: "QUOTA_EXHAUSTED" });
      if (e.category === "CAPACITY") return yield* finish({ reason: "CONTEXT_EXHAUSTED" });

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
        yield await emit("LoopContinued", { transition: state.transition as Continue });
        continue;
      }
      return yield* finish({ reason: "MODEL_ERROR", error: e });
    }

    const usage = invocation.usage;
    yield await emit("ModelInvocationCompleted", {
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
        lastAssistantText = textOf(invocation.content) ?? lastAssistantText;
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
      return yield* finish({ reason: "ABORTED_STREAMING" });
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
        yield await emit("RuntimeErrorOccurred", {
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
        yield await emit("LoopContinued", { transition: state.transition as Continue });
        continue;
      }
      return yield* finish({ reason: "CONTEXT_EXHAUSTED" });
    }

    // 助手消息落盘
    // 空文本不覆盖上一轮 —— 纯 tool_call 的回合没有正文，但那一轮之前说过的话
    // 仍然是目前对「发生了什么」最好的描述。
    lastAssistantText = textOf(invocation.content) ?? lastAssistantText;
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
      return yield* finish(
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
        // executeBatch 产出的事件带的是占位号 0 —— 它没有 store 也不该有。
        // 取号在这里统一做，与 emit() 走同一个分配器（D-2）。
        lastSequence = await ports.transcript.nextSequence(runId, lastSequence);
        const withSeq = { ...bev, sequence: lastSequence } as RunEvent;
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
      return yield* finish({ reason: "ABORTED_TOOLS" });
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
    // 【定】emit 在前、persistFacts 在后 —— 见 persistFacts 的顺序说明（D-2）。
    yield await emit("LoopContinued", { transition: state.transition as Continue });
    await persistFacts();
  }
}

/**
 * 助手回合里的可见正文。
 *
 * 【定】只取 text 块，不取 reasoning。推理块是模型的草稿，不是它对用户的交代 ——
 * 把草稿当成 summary 呈现，既泄露了不该呈现的中间态，也往往答非所问。
 *
 * 返回 undefined 表示这一回合没有正文（纯 tool_call），调用方据此保留上一轮的值。
 */
function textOf(content: ModelContent[]): string | undefined {
  const text = content
    .filter((c): c is Extract<ModelContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
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
