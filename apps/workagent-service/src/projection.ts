/**
 * Layer 2 投影器（V05 §23）。**纯函数，无 IO，无状态。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】投影只做**合并与转述**，不做推算（阶段 4 不得绕过 #6）。
 *
 * 界面上的每一个数字都必须能指回一个 RunEvent 或一条 transcript 条目。
 * 理由是 `main.ts` 的 `readLastBudget` 早就写过的那一条：
 * 「凑出来的数和权威副本万一对不上，事后没人分得清哪个是对的」。
 * 白盒界面把这条从建议升成硬约束 —— 一个会自己算的白盒不是白盒，
 * 它是第二个事实来源。
 *
 * ── 决 5：两条轨道都不够，必须合并 ─────────────────────────────────────
 *
 *   只看事件流：有循环迁移、预算、审批、验证、产物；
 *               **没有工具入参**（`ActionProposed` 只有 toolName / effect），
 *               **没有工具结果原文**（`AttemptCompleted` 只有 status / 时长）。
 *   只看 transcript：有入参、结果、模型正文；
 *               **没有循环迁移**，没有 stopReason / usage / 帧构成。
 *
 * 能把两条对齐的**只有 D-2 那条统一序列**。阶段 2 把 D-2 列为「不做会污染后续、
 * 事后收不回来」的开工前置，理由写的是「§23.2 的 Layer 2 投影游标没法收拾」——
 * 这个文件就是那个投影，那条前置在这里第一次有了消费者。
 *
 * 合并因此只是一次 `sort by sequence`。**如果当初两条轨道各有一个计数器，
 * 这个文件写不出来** —— 那不是「难写一点」，是根本无法定序。
 * ══════════════════════════════════════════════════════════════════════
 */

import {
  RUN_FACTS_META_KIND,
  type ModelContent,
  type ResumableRunFacts,
  type RunEvent,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import type {
  UiApproval,
  UiSource,
  UiArtifact,
  UiAssistantMessage,
  UiBudgetUsage,
  UiInteraction,
  UiModelCall,
  UiModelFrame,
  UiSystemNotice,
  UiToolActivity,
  UiTranscriptEntry,
  UiTurn,
  UiUserMessage,
} from "./api-types.js";

export interface ProjectionInput {
  entries: TranscriptEntry[];
  events: RunEvent[];
}

// ═══════════════════════════════════════════════════════════ 时间线

/**
 * 把两条轨道投影成一条全序时间线。
 *
 * 【定】**幂等**：同一份输入投影两次逐字一致；分两段投影再按 `id` 合并，
 * 与一次全量投影一致。判据在 `verify:ui` B 段。
 * 这条不是洁癖 —— §23.2 第 2 条要求投影「幂等、至少一次」，
 * 而客户端增量拉取时正是按 `id` 覆盖合并的。id 不稳，同一条会被插两遍。
 */
export function projectTimeline(input: ProjectionInput): UiTranscriptEntry[] {
  const out = new Map<string, UiTranscriptEntry>();
  /** actionId → toolCallId。只有 `ActionProposed` 同时带这两个。 */
  const actionToCall = new Map<string, string>();
  /**
   * 插话的权威信号是**事件**，不是消息文本里的前缀。
   *
   * transcript 上「用户插话」与「系统提示」都是 `role:user` 的 text 块，
   * 天然分不开。靠 `startsWith("[执行中插话]")` 认是把 Runtime 的一句
   * 措辞变成 Layer 2 的解析契约 —— 改一个字，界面就静默错分类。
   * 用事件的 `content` 反查（消息文本以它结尾）则是**数据对数据**。
   *
   * 【定】没有事件流（`--no-trace` 跑的 Run）时这条认不出来，
   * 界面会把插话显示成系统提示。**如实降级，不猜** —— 缺口登记在 §0.12（S4-3）。
   */
  const interjections = input.events
    .filter((e) => e.type === "InterjectionAccepted")
    .map((e) => (e.payload as { content: string }).content);

  const touch = (
    toolCallId: string,
    seq: number,
    at: number,
    /**
     * 【定】建条目的人要说清楚**自己是哪条轨道**。
     *
     * 这里原本写死 `"EVENT"`，只有 assistant 的 tool_call 分支会改写成
     * TRANSCRIPT。于是一条由 **tool_result 先创建**的活动（前段 transcript 缺失、
     * 或 compact 之后只剩结果时的现实形态）会带着 `track: "EVENT"` 与一个
     * **transcript 的序号** —— 而 `api-types.ts` 专门声明了两条轨道的证据等级
     * 不同。标错的字段比没有这个字段更糟。
     */
    track: UiSource["track"],
  ): UiToolActivity => {
    const id = `tool:${toolCallId}`;
    const existing = out.get(id) as UiToolActivity | undefined;
    if (existing) return existing;
    const created: UiToolActivity = {
      id,
      kind: "TOOL_ACTIVITY",
      // 【定】锚点是**发起**那一刻的序号，不是完成时刻 —— 时间线要按
      // 「什么时候开始的」排，否则一个跑了 5 分钟的工具会跳到后面几轮里。
      source: { track, sequence: seq },
      at,
      toolCallId,
      toolName: "(未知)",
      progress: [],
    };
    out.set(id, created);
    return created;
  };

  // ── 轨道一：transcript（入参、结果原文、模型正文）
  let firstUserTextSeen = false;
  for (const e of sorted(input.entries)) {
    if (e.kind !== "MESSAGE" || !e.message) continue;
    const m = e.message;
    const seq = e.sequence;

    if (m.role === "assistant") {
      const text = joinText(m.content);
      const reasoningChars = m.content
        .filter((c): c is Extract<ModelContent, { type: "reasoning" }> => c.type === "reasoning")
        .reduce((n, c) => n + c.text.length, 0);
      if (text.length > 0 || reasoningChars > 0) {
        const entry: UiAssistantMessage = {
          id: `msg:${seq}`,
          kind: "ASSISTANT_MESSAGE",
          source: { track: "TRANSCRIPT", sequence: seq },
          at: e.createdAt,
          turn: m.turn,
          text,
          reasoningChars,
        };
        out.set(entry.id, entry);
      }
      for (const c of m.content) {
        if (c.type !== "tool_call") continue;
        const a = touch(c.toolCallId, seq, e.createdAt, "TRANSCRIPT");
        a.toolName = c.name;
        a.input = c.input;
        a.turn = m.turn;
        // 入参来自 transcript —— 证据等级比事件流高一档，如实标注。
        a.source = { track: "TRANSCRIPT", sequence: seq };
      }
      continue;
    }

    if (m.role !== "user") continue;

    const results = m.content.filter(
      (c): c is Extract<ModelContent, { type: "tool_result" }> => c.type === "tool_result",
    );
    for (const r of results) {
      const a = touch(r.toolCallId, seq, e.createdAt, "TRANSCRIPT");
      a.result = r.content;
      a.resultIsError = r.isError;
    }

    const text = joinText(m.content);
    if (text.length === 0) continue;
    const origin: UiUserMessage["origin"] = !firstUserTextSeen
      ? "TASK"
      : interjections.some((c) => text.endsWith(c))
        ? "INTERJECTION"
        : "SYSTEM";
    firstUserTextSeen = true;
    const entry: UiUserMessage = {
      id: `msg:${seq}`,
      kind: "USER_MESSAGE",
      source: { track: "TRANSCRIPT", sequence: seq },
      at: e.createdAt,
      turn: m.turn,
      text,
      origin,
    };
    out.set(entry.id, entry);
  }

  // ── 轨道二：事件流（effect、审批、验证、外置、产物、系统事实）
  for (const ev of sortedEvents(input.events)) {
    const seq = ev.sequence;
    const at = ev.occurredAt;
    switch (ev.type) {
      case "ActionProposed": {
        actionToCall.set(String(ev.payload.actionId), ev.payload.toolCallId);
        const a = touch(ev.payload.toolCallId, seq, at, "EVENT");
        a.toolName = ev.payload.toolName;
        a.effect = ev.payload.effect;
        // 护栏 3 的投影出口。转述，不推算（决 5）。
        if (ev.payload.riskFacts.length > 0) a.riskFacts = [...ev.payload.riskFacts];
        if (ev.payload.dataMovement) a.dataMovement = { ...ev.payload.dataMovement };
        break;
      }
      case "ActionRejected": {
        const a = byAction(out, actionToCall, ev.payload.actionId);
        if (a) {
          a.rejected = { stage: ev.payload.stage, reason: ev.payload.reason };
          break;
        }
        /**
         * 【定】映射不到就**单独成条**，不许静默丢弃。
         *
         * `ActionRejected` 可以在 `ActionProposed` **之前**发出
         * （`settle-batch.ts` 里 REJECTED_SCHEMA / Effect 解析失败那三处），
         * 而 actionId → toolCallId 的映射只有 `ActionProposed` 才建立。
         * 原实现 `if (a)` 一挡，这类拒绝在时间线上彻底消失 ——
         * 偏偏「为什么被拒绝」正是白盒最该解释的东西之一。
         */
        const orphan: UiSystemNotice = {
          id: `ev:${seq}`,
          kind: "SYSTEM_NOTICE",
          source: { track: "EVENT", sequence: seq },
          at,
          eventType: "ActionRejected",
          text:
            `Action 在提案前被拒绝（${ev.payload.stage}）：${ev.payload.reason}\n` +
            `（这一条早于 ActionProposed，没有可关联的工具调用）`,
          severity: "ERROR",
        };
        out.set(orphan.id, orphan);
        break;
      }
      case "AttemptStarted": {
        const a = byAction(out, actionToCall, ev.payload.actionId);
        if (a && a.toolName === "(未知)") a.toolName = ev.payload.toolName;
        break;
      }
      case "AttemptCompleted": {
        const a = byAction(out, actionToCall, ev.payload.actionId);
        if (a) {
          a.status = ev.payload.status;
          a.sideEffectState = ev.payload.sideEffectState;
          a.durationMs = ev.payload.durationMs;
        }
        break;
      }
      case "ToolProgress": {
        const a = byAction(out, actionToCall, ev.payload.actionId);
        if (a) a.progress.push(ev.payload.note);
        break;
      }
      case "ToolResultExternalized": {
        const a = byAction(out, actionToCall, ev.payload.actionId);
        if (a) {
          a.externalized = {
            ref: ev.payload.ref,
            sizeBytes: ev.payload.sizeBytes,
            approxTokens: ev.payload.approxTokens,
          };
        }
        break;
      }
      case "VerificationCompleted": {
        const a = byAction(out, actionToCall, ev.payload.actionId);
        if (a) {
          a.verification = {
            status: ev.payload.status,
            required: ev.payload.required,
            detail: ev.payload.detail,
          };
        }
        break;
      }
      case "ResumeUnpairedToolUse": {
        const a = touch(ev.payload.toolCallId, seq, at, "EVENT");
        if (a.toolName === "(未知)") a.toolName = ev.payload.toolName;
        a.resumeBranch = {
          branch: ev.payload.branch,
          hasPreFingerprint: ev.payload.hasPreFingerprint,
        };
        break;
      }
      case "ApprovalRequested": {
        const a = byAction(out, actionToCall, ev.payload.actionId);
        if (a) a.approval = { requested: true };
        const entry: UiApproval = {
          id: `approval:${ev.payload.actionId}`,
          kind: "APPROVAL",
          source: { track: "EVENT", sequence: seq },
          at,
          actionId: String(ev.payload.actionId),
          effect: ev.payload.effect,
          reason: ev.payload.reason,
        };
        out.set(entry.id, entry);
        break;
      }
      case "ApprovalDecided": {
        const a = byAction(out, actionToCall, ev.payload.actionId);
        if (a) {
          a.approval = {
            requested: a.approval?.requested ?? false,
            approved: ev.payload.approved,
            ...(ev.payload.reason ? { reason: ev.payload.reason } : {}),
            // 【定】原样转述，不推算（决 5）。事件里是什么就是什么 ——
            // 包括 `UNDECLARED`：把它在界面上美化成「已批准」会重新造出
            // ADR-0012 要消灭的那个不可区分。
            decidedBy: ev.payload.decidedBy,
          };
        }
        const prior = out.get(`approval:${ev.payload.actionId}`) as UiApproval | undefined;
        if (prior) {
          prior.approved = ev.payload.approved;
          if (ev.payload.reason) prior.decisionReason = ev.payload.reason;
          prior.decidedBy = ev.payload.decidedBy;
        }
        break;
      }
      case "InteractionRequested": {
        const entry: UiInteraction = {
          id: `interaction:${ev.payload.actionId}`,
          kind: "INTERACTION",
          source: { track: "EVENT", sequence: seq },
          at,
          actionId: String(ev.payload.actionId),
          toolName: ev.payload.toolName,
          detail: ev.payload.detail,
        };
        out.set(entry.id, entry);
        break;
      }
      case "InteractionCompleted": {
        const prior = out.get(`interaction:${ev.payload.actionId}`) as UiInteraction | undefined;
        // 【定】`answered` 说的是「人应答了没有」，不是「任务成功了没有」（§20.3）。
        // 界面上的措辞跟着这条走，不得写成「已完成」。
        if (prior) prior.answered = ev.payload.answered;
        break;
      }
      case "ArtifactRegistered": {
        const entry: UiArtifact = {
          id: `artifact:${ev.payload.artifactId}`,
          kind: "ARTIFACT",
          source: { track: "EVENT", sequence: seq },
          at,
          artifactId: ev.payload.artifactId,
          logicalId: ev.payload.logicalId,
          version: ev.payload.version,
          role: ev.payload.role,
          artifactKind: ev.payload.kind,
        };
        out.set(entry.id, entry);
        break;
      }
      case "ArtifactVerified": {
        const prior = out.get(`artifact:${ev.payload.artifactId}`) as UiArtifact | undefined;
        if (prior) {
          prior.verified = {
            ok: ev.payload.ok,
            checksRun: ev.payload.checksRun,
            detail: ev.payload.detail,
          };
        }
        break;
      }
      default: {
        const notice = asNotice(ev);
        if (notice) out.set(notice.id, notice);
      }
    }
  }

  return [...out.values()].sort(
    (a, b) => a.source.sequence - b.source.sequence || a.id.localeCompare(b.id),
  );
}

/**
 * 哪些事件进时间线的「系统事实」一档。
 *
 * 【定】**不归类、不改写措辞** —— `eventType` 原样带上，界面按它分色。
 * 归类会丢信息：`NoProgressDetected` 与 `BudgetHardLimitReached` 都会终止 Run，
 * 但一个说「模型在原地打转」，另一个说「额度用完了」，处置完全不同
 * （前者换个说法重来，后者加预算）。
 */
function asNotice(ev: RunEvent): UiSystemNotice | undefined {
  const mk = (
    text: string,
    severity: UiSystemNotice["severity"] = "INFO",
  ): UiSystemNotice => ({
    id: `ev:${ev.sequence}`,
    kind: "SYSTEM_NOTICE",
    source: { track: "EVENT", sequence: ev.sequence },
    at: ev.occurredAt,
    eventType: ev.type,
    text,
    severity,
  });

  switch (ev.type) {
    case "RunStarted":
      return mk(`Run 开始：${ev.payload.modelId} @ ${ev.payload.endpointId}`);
    case "LoopTerminated":
      return mk(
        `循环终止：${ev.payload.terminal.reason} → outcome ${ev.payload.outcome.kind}` +
          (ev.payload.outcome.summary ? `\n${ev.payload.outcome.summary}` : ""),
        ev.payload.outcome.kind === "SUCCESS" ? "INFO" : "WARN",
      );
    case "ContextCompacted":
      return mk(`上下文压缩：释放 ${ev.payload.freedTokens} token（${ev.payload.reason}）`);
    case "InterjectionAccepted":
      return mk(`插话已排队：${ev.payload.content}`);
    case "BudgetSoftLimitReached":
      return mk(
        `预算软限 ${ev.payload.axis}：${ev.payload.used} / ${ev.payload.limit}` +
          `（${Math.round(ev.payload.ratio * 100)}%）`,
        "WARN",
      );
    case "BudgetHardLimitReached":
      return mk(`预算硬墙 ${ev.payload.axis}：${ev.payload.used} / ${ev.payload.limit}`, "ERROR");
    case "NoProgressDetected":
      return mk(
        `无进展：${ev.payload.toolName} 连续 ${ev.payload.repeats} 次同样的调用（digest ${ev.payload.inputDigest}）`,
        "ERROR",
      );
    case "RecoveryRequired":
      return mk(`需要人工确认的未知副作用：${ev.payload.items} 项`, "ERROR");
    case "RecoveryResolved":
      return mk(
        `恢复决策 ${ev.payload.decision}（${ev.payload.items} 项）` +
          (ev.payload.note ? `：${ev.payload.note}` : ""),
        "WARN",
      );
    case "RuntimeErrorOccurred":
      return mk(
        `${ev.payload.error.code}｜${ev.payload.error.category}｜副作用 ${ev.payload.error.sideEffectState}\n` +
          ev.payload.error.safeMessage,
        "ERROR",
      );
    case "ModelInvocationAuditFailed":
      return mk(
        `模型调用审计失败 ${ev.payload.invocationId}｜${ev.payload.stage}\n${ev.payload.message}`,
        "ERROR",
      );
    case "EndpointBehaviorDrift":
      return mk(
        `端点漂移 ${ev.payload.field}：声明 ${ev.payload.declared}，实测 ${ev.payload.observed}` +
          `（处置 ${ev.payload.disposition}）`,
        ev.payload.disposition === "FAIL_FAST" ? "ERROR" : "WARN",
      );
    case "ResumeStarted":
      return mk(
        `恢复开始：从序号 ${ev.payload.fromSequence} 重建 ${ev.payload.rebuiltMessages} 条消息`,
        "WARN",
      );
    case "InteractionResumed":
      return mk(
        `上次崩在「等人」那一刻，本次重新发起：${ev.payload.pendingToolUses.join(", ") || "（无）"}`,
        "WARN",
      );
    default:
      // TurnStarted / LoopContinued / ContextFrameCompiled / ModelInvocationCompleted /
      // ActionBatchPlanned / ActionBatchSettled / ModelStreamDelta 都不进时间线 ——
      // 它们要么进「逐轮解剖」，要么是流式增量（正文已由 transcript 给出）。
      return undefined;
  }
}

function byAction(
  out: Map<string, UiTranscriptEntry>,
  actionToCall: Map<string, string>,
  actionId: unknown,
): UiToolActivity | undefined {
  const callId = actionToCall.get(String(actionId));
  if (!callId) return undefined;
  const e = out.get(`tool:${callId}`);
  return e?.kind === "TOOL_ACTIVITY" ? e : undefined;
}

// ══════════════════════════════════════════════════════════ 逐轮解剖

/**
 * 每轮一行。**每个字段都直接抄自某个事件的 payload 或某条 RUN_META。**
 *
 * `budgetAfter` 特别说明：它取的是**轮边界那条 RUN_META**，不是把
 * `ModelInvocationCompleted` 的 usage 逐轮累加。两条路看起来会得到同样的数，
 * 但只有前者是权威副本（`run-loop.ts` 的 `persistFacts()` 写的那一份，
 * 也是 resume 读回来的那一份）。自己累加的那一版在
 * 「一轮里发生了两次模型调用」（输出预算恢复重试）时就会与权威副本分叉。
 */
export function projectTurns(input: ProjectionInput): UiTurn[] {
  const turns: UiTurn[] = [];
  const callsByInvocation = new Map<string, UiModelCall>();
  let current: UiTurn | undefined;

  const ensure = (turn: number, seq: number): UiTurn => {
    if (current && current.turn === turn) return current;
    current = { turn, startedAtSequence: seq, compaction: [], toolNames: [], modelCalls: [] };
    turns.push(current);
    return current;
  };

  const appendCall = (
    turn: UiTurn,
    sequence: number,
    invocationId?: string,
  ): UiModelCall => {
    const call: UiModelCall = {
      id: invocationId ? `model:${invocationId}` : `model-event:${sequence}`,
      ordinal: turn.modelCalls.length + 1,
      startedAtSequence: sequence,
      ...(invocationId ? { invocationId } : {}),
      traceStatus: "STARTED",
      runtimeErrors: [],
    };
    turn.modelCalls.push(call);
    if (invocationId) callsByInvocation.set(invocationId, call);
    return call;
  };

  const callFor = (turn: UiTurn, sequence: number, invocationId?: string): UiModelCall =>
    invocationId
      ? (callsByInvocation.get(invocationId) ?? appendCall(turn, sequence, invocationId))
      : appendCall(turn, sequence);

  // 两条轨道按同一条序列合并（决 5）。这里只需要 RUN_META 那一种条目。
  const facts = sorted(input.entries)
    .filter((e) => e.kind === "RUN_META" && e.meta?.["metaKind"] === RUN_FACTS_META_KIND)
    .map((e) => ({
      sequence: e.sequence,
      facts: e.meta!["facts"] as ResumableRunFacts,
    }));
  let factIdx = 0;

  for (const ev of sortedEvents(input.events)) {
    // 把序号在这个事件之前的 RUN_META 归给当时开着的那一轮。
    while (factIdx < facts.length && facts[factIdx]!.sequence <= ev.sequence) {
      const f = facts[factIdx]!;
      if (current) current.budgetAfter = f.facts.budgetUsage as UiBudgetUsage;
      factIdx += 1;
    }

    switch (ev.type) {
      case "TurnStarted":
        ensure(ev.payload.turn, ev.sequence);
        break;
      case "ContextFrameCompiled": {
        const t = ensure(current?.turn ?? 0, ev.sequence);
        const frame: UiModelFrame = {
          items: ev.payload.items,
          totalTokens: ev.payload.totalTokens,
          fixedOverheadTokens: ev.payload.fixedOverheadTokens,
          compacted: ev.payload.compacted,
          hasExternalUntrusted: ev.payload.trust.hasExternalUntrusted,
          untrustedItems: ev.payload.trust.untrustedItems,
        };
        t.frame = frame;
        // 旧 Trace 没有这两个字段：保留轮级 frame，等 completed 事件创建兼容调用。
        const invocationId = typeof ev.payload.invocationId === "string"
          ? String(ev.payload.invocationId)
          : undefined;
        if (invocationId) {
          const call = callFor(t, ev.sequence, invocationId);
          call.frame = frame;
          if (typeof ev.payload.frameId === "string") call.frameId = String(ev.payload.frameId);
        }
        break;
      }
      case "ContextCompacted":
        ensure(current?.turn ?? 0, ev.sequence).compaction.push({
          freedTokens: ev.payload.freedTokens,
          reason: ev.payload.reason,
        });
        break;
      case "ModelInvocationCompleted": {
        const t = ensure(current?.turn ?? 0, ev.sequence);
        const u = ev.payload.usage;
        /**
         * 【定】按 invocation 补全，不能按 turn 覆盖或重复追加。
         *
         * 一个 turn 里可以有**多次**模型调用：输出预算恢复
         * （`OUTPUT_LIMIT_RECOVERY`）与模型错误重试（`MODEL_ERROR_RETRY`）
         * 都是 `continue` 且**不递增 turnCount**，于是同一个轮号会再发一次
         * `TurnStarted` 与 `ModelInvocationCompleted`。
         *
         * 原实现 `t.model = {...}` 直接覆盖，后果是逐轮解剖只显示最后一次调用的
         * token，而 `budgetAfter`（轮边界那条 RUN_META）**包含全部调用** ——
         * 于是这一行自己对不上自己，而「这一轮为什么花了这么多」恰恰是
         * 白盒要回答的问题。
         */
        const invocationId = typeof ev.payload.invocationId === "string"
          ? String(ev.payload.invocationId)
          : undefined;
        const call = callFor(t, ev.sequence, invocationId);
        call.traceStatus = "RETURNED";
        call.inputTokens = u.inputTokens;
        call.outputTokens = u.outputTokens;
        call.billedInputTokens = u.billedInputTokens;
        if (u.cacheReadInputTokens !== undefined) call.cacheReadInputTokens = u.cacheReadInputTokens;
        call.stopReason = ev.payload.stopReason;
        call.durationMs = ev.payload.durationMs;
        call.toolCallCount = ev.payload.toolCallCount;
        break;
      }
      case "RuntimeErrorOccurred": {
        if (typeof ev.payload.invocationId !== "string") break;
        const t = ensure(current?.turn ?? 0, ev.sequence);
        const call = callFor(t, ev.sequence, String(ev.payload.invocationId));
        call.traceStatus = "FAILED";
        call.runtimeErrors.push({
          code: ev.payload.error.code,
          category: ev.payload.error.category,
          retryability: ev.payload.error.retryability,
          safeMessage: ev.payload.error.safeMessage,
        });
        break;
      }
      case "ModelInvocationAuditFailed": {
        // 事件由本地 JSONL 读回后只做了类型断言；损坏或未来旧形状不能被
        // String(undefined) 投影成一个可点击的 `model:undefined` 假调用。
        if (typeof ev.payload.invocationId !== "string") break;
        const t = ensure(current?.turn ?? 0, ev.sequence);
        const invocationId = String(ev.payload.invocationId);
        const call = callFor(t, ev.sequence, invocationId);
        call.auditFailure = {
          stage: ev.payload.stage,
          message: ev.payload.message,
        };
        break;
      }
      case "ActionProposed":
        ensure(current?.turn ?? 0, ev.sequence).toolNames.push(ev.payload.toolName);
        break;
      case "LoopContinued":
        ensure(current?.turn ?? 0, ev.sequence).transition = ev.payload.transition.reason;
        break;
      case "LoopTerminated":
        // 【定】终止也是一次具名迁移，写进同一个字段 —— 循环纪律第 2 条
        // 说的是「每个 return 是具名 Terminal」，界面上不该只有 continue 看得见。
        ensure(current?.turn ?? 0, ev.sequence).transition = `TERMINAL:${ev.payload.terminal.reason}`;
        break;
      default:
        break;
    }
  }

  // 末尾还没归属的 RUN_META（最后一轮结束后写的那条）。
  while (factIdx < facts.length) {
    const f = facts[factIdx]!;
    if (current) current.budgetAfter = f.facts.budgetUsage as UiBudgetUsage;
    factIdx += 1;
  }

  return turns;
}

// ══════════════════════════════════════════════════════════════ 工具

function sorted(entries: TranscriptEntry[]): TranscriptEntry[] {
  return [...entries].sort((a, b) => a.sequence - b.sequence);
}

function sortedEvents(events: RunEvent[]): RunEvent[] {
  return [...events].sort((a, b) => a.sequence - b.sequence);
}

function joinText(content: ModelContent[]): string {
  return content
    .filter((c): c is Extract<ModelContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/**
 * ── 这里**故意没有** `mergeTimeline(prior, next)` ─────────────────────────
 *
 * 客户端的更新策略是「收到事件 → 去抖 → 全量重取」，不做增量合并。
 * 于是一个「把两段投影按 id 合并」的函数**在生产里没有消费者** ——
 * 而「类型、事件、类都在但运行时从不执行」是本仓明令要避免的形态
 * （存量清单 §2 列了 8 项）。写了它，第二个人会以为增量通路是通的。
 *
 * 增量合并真要做，难点不在合并本身，在 `TOOL_ACTIVITY` **跨窗口**：
 * 调用在窗口 1、结果在窗口 2，窗口 2 单独投影出来的那条只有 `result`
 * 没有 `input` —— 按 id 覆盖会把入参**擦掉**。要做就得做字段级合并，
 * 那是一个有真实 bug 空间的设计，值得等到「全量重取真的慢了」再做。
 *
 * 【定】但 `id` 的稳定性不是白要求的，它有真实消费者：
 * 界面用 id 记住「哪几张工具卡片是展开的」，全量重取后据此复原。
 * id 不稳 = 每次刷新所有卡片都collapse回去。判据在 `verify:ui` B 段
 * （两次投影、不同长度前缀，共有条目的 id 逐字一致）。
 */
