/**
 * ActionBatch 执行与结算（V05 §8.5）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这是阶段 1 最需要被反复审视的文件。
 *
 * 不变量 8：批内每个 Tool Call 在返回模型前必须拥有恰好一个协议合法的 result。
 *
 * 它的理据不是「否则 Provider 会 400」—— 选定端点上缺 result、错 tool_call_id
 * 一律 200 放行。理据是：
 *
 *     否则模型看到的是一个失真的世界 —— 它会以为某个工具没被调用过，
 *     或者把 A 的结果当成 B 的。
 *
 * 而且没有任何外部兜底会替你发现违反。删掉纯 Kernel 之后，这条不变量
 * 也失去了在纯函数里被穷举测试的可能，退化为手写纪律。
 *
 * 因此本文件的结构是刻意的：**所有出口都经过 finalize()**。
 * 无论正常结束、抛异常、还是被 abort，finalize() 都会把缺失的 result 补齐。
 * ══════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import type {
  ActionBatch,
  ApprovalDecider,
  BatchSettlementPolicy,
  ExecutionAttempt,
  PreparedAction,
  ProposedAction,
  VerificationResult,
} from "../types/tool.js";
import { DEFAULT_SETTLEMENT } from "../types/tool.js";
import type { ModelContent } from "../types/context.js";
import type { RecoveryItem } from "../types/run.js";
import type { RunEvent } from "../types/event.js";
import { makeError, type RuntimeErrorRecord } from "../types/error.js";
import { asId, type ActionBatchId, type ActionId, type AttemptId, type RunId } from "../types/ids.js";
import type {
  EffectResolverPort,
  IdGeneratorPort,
  RedactionPort,
  ToolExecutionContext,
  ToolHandlerPort,
  VerificationPort,
} from "../ports/index.js";
import { ToolRegistry, validateAndNormalize, effectiveRedaction } from "../tool-runtime/index.js";
import { evaluatePolicy } from "./policy.js";
import type { ApprovalPolicySnapshot } from "../types/run.js";

export interface BatchDeps {
  runId: RunId;
  invocationId: string;
  registry: ToolRegistry;
  tools: ToolHandlerPort;
  effects: EffectResolverPort;
  redaction: RedactionPort;
  verification: VerificationPort;
  approvalDecider: ApprovalDecider;
  approvalPolicy: ApprovalPolicySnapshot;
  ids: IdGeneratorPort;
  now: () => number;
  signal: AbortSignal;
  workspaceRoot: string;
  hasUntrustedContext: boolean;
  settlement?: BatchSettlementPolicy;
}

export interface ToolCallRequest {
  toolCallId: string;
  name: string;
  input: unknown;
}

export interface BatchOutcome {
  batch: ActionBatch;
  /** 恰好 calls.length 条，顺序与 calls 一致。 */
  results: ModelContent[];
  verifications: VerificationResult[];
  attempts: ExecutionAttempt[];
  recoveryItems: RecoveryItem[];
  /** 批被中断（cancel）。已结算的事实保留，未启动的合成 SKIPPED result。 */
  aborted: boolean;
}

export async function* executeBatch(
  calls: ToolCallRequest[],
  deps: BatchDeps,
): AsyncGenerator<RunEvent, BatchOutcome> {
  const settlement = deps.settlement ?? DEFAULT_SETTLEMENT;
  const batchId = asId<ActionBatchId>(deps.ids.next("batch"));

  const prepared: PreparedAction[] = [];
  const verifications: VerificationResult[] = [];
  const attempts: ExecutionAttempt[] = [];
  const recoveryItems: RecoveryItem[] = [];

  /**
   * 结算台账。key 是 toolCallId，一个 call 只允许写一次。
   * finalize() 会检查它是否覆盖了全部 call。
   */
  const ledger = new Map<string, ModelContent>();
  const settle = (toolCallId: string, content: string, isError: boolean): void => {
    if (ledger.has(toolCallId)) {
      // 重复结算是编码错误，不是运行时状况。直接抛，不静默覆盖 ——
      // 静默覆盖会让「恰好一个」变成「最后一个」，而模型看不出区别。
      throw new Error(`tool_call ${toolCallId} 被结算了两次，违反不变量 8`);
    }
    ledger.set(toolCallId, { type: "tool_result", toolCallId, content, isError });
  };

  /**
   * 哪些 call 真的走到了 Verification。
   *
   * 【定】没走到的那些必须在收尾时补一条事实（见 finally 里的 recordUnmetRequired）。
   * 否则「声明了 requiredForSuccess 的操作被拒 / 被跳过 / 被取消」在 verifications
   * 表里连一行都不留，Run 结算时查不到任何失败项，直接判 SUCCESS ——
   * 这正是不变量 12「结算依据必须来自事实表」要防的：表本身是残缺的。
   */
  const verifiedCallIds = new Set<string>();
  const actionIdByCall = new Map<string, ActionId>();

  let aborted = false;
  let skipRemaining = false;

  const batch: ActionBatch = {
    id: batchId,
    runId: deps.runId,
    invocationId: deps.invocationId,
    actions: prepared,
    // 【定·D-01】v0.1 恒为串行，且必须由 Runtime 自己保证。
    // 实测四个端点全部静默接受强制单条开关，三个不生效，没有一个报错。
    executionMode: "SEQUENTIAL",
    approvalMode: "PER_ACTION",
    batchDigest: digest(calls.map((c) => `${c.name}:${JSON.stringify(c.input)}`).join("|")),
    settlement,
    status: "PLANNED",
  };

  yield ev(deps, "ActionBatchPlanned", {
    batchId,
    callCount: calls.length,
    mode: batch.executionMode,
  });

  batch.status = "IN_PROGRESS";

  try {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;

      // Cancel 落在批中间：未启动 Action 标记 SKIPPED 并合成 result（不变量 7）
      if (deps.signal.aborted) {
        aborted = true;
        break;
      }
      if (skipRemaining) break;

      const actionId = asId<ActionId>(deps.ids.next("act"));
      actionIdByCall.set(call.toolCallId, actionId);
      const proposed: ProposedAction = {
        id: actionId,
        runId: deps.runId,
        batchId,
        batchIndex: i,
        toolCallId: call.toolCallId,
        toolName: call.name,
        rawInput: call.input,
        stage: "PROPOSED",
        createdAt: deps.now(),
      };

      // ── ① schema 校验。四端点全部放行不合 schema 的入参，这里是唯一一道。
      const snapshot = deps.registry.get(call.name);
      if (!snapshot) {
        proposed.stage = "REJECTED_SCHEMA";
        const e = makeError({
          code: "TOOL_NOT_FOUND",
          source: "TOOL_INPUT",
          category: "NOT_FOUND",
          retryability: "AFTER_MODEL_CORRECTION",
          sideEffectState: "NOT_STARTED",
          safeMessage: `没有名为 "${call.name}" 的工具。可用：${deps.registry.all().map((t) => t.definition.name).join(", ")}`,
        });
        settle(call.toolCallId, renderError(e), true);
        yield ev(deps, "ActionRejected", { actionId, stage: "REJECTED_SCHEMA", reason: e.safeMessage });
        continue;
      }

      const def = snapshot.definition;
      const validation = validateAndNormalize(call.input, def.inputSchema, def.name);
      if (!validation.ok || validation.normalized === undefined) {
        proposed.stage = "REJECTED_SCHEMA";
        const e = validation.error!;
        settle(call.toolCallId, renderError(e), true);
        yield ev(deps, "ActionRejected", { actionId, stage: "REJECTED_SCHEMA", reason: e.safeMessage });
        continue;
      }

      // ── ② Effect 解析。【定】不得绕过（V05 §28.2）。
      const resolvedEffect = deps.effects.resolve(
        def.effectResolution,
        validation.normalized,
        deps.workspaceRoot,
      );

      const action: PreparedAction = {
        ...proposed,
        stage: "PREPARED",
        normalizedInput: validation.normalized,
        inputDigest: digest(JSON.stringify(validation.normalized)),
        resolvedEffect,
        actionDigest: digest(
          [def.name, def.version, JSON.stringify(validation.normalized), resolvedEffect.digest].join("|"),
        ),
        preparedAt: deps.now(),
      };
      prepared.push(action);

      yield ev(deps, "ActionProposed", {
        actionId,
        toolCallId: call.toolCallId,
        toolName: call.name,
        effect: `${resolvedEffect.effectType} ${resolvedEffect.scope.value}`,
      });

      // ── ③ Policy
      const verdict = evaluatePolicy({
        action,
        approvalPolicy: deps.approvalPolicy,
        hasUntrustedContext: deps.hasUntrustedContext,
      });

      if (verdict.decision === "DENY") {
        action.stage = "REJECTED_POLICY";
        settle(call.toolCallId, renderError(verdict.error), true);
        yield ev(deps, "ActionRejected", {
          actionId,
          stage: "REJECTED_POLICY",
          reason: verdict.error.safeMessage,
        });
        if (settlement.onActionFailure === "SKIP_REMAINING") skipRemaining = true;
        continue;
      }

      // ── ④ Approval
      if (verdict.decision === "REQUIRE_APPROVAL") {
        yield ev(deps, "ApprovalRequested", {
          actionId,
          effect: `${resolvedEffect.effectType} ${resolvedEffect.scope.value}`,
          reason: verdict.reason,
        });
        const decision = await deps.approvalDecider(action);
        yield ev(deps, "ApprovalDecided", {
          actionId,
          approved: decision.approved,
          reason: decision.reason,
        });

        if (!decision.approved) {
          action.stage = "REJECTED_APPROVAL";
          const e = makeError({
            code: "APPROVAL_REJECTED",
            source: "USER",
            category: "AUTHORIZATION",
            retryability: "AFTER_USER_ACTION",
            sideEffectState: "NOT_STARTED",
            safeMessage: `用户拒绝了这个操作${decision.reason ? `：${decision.reason}` : ""}`,
          });
          settle(call.toolCallId, renderError(e), true);
          // 【D-21】默认 CONTINUE_REMAINING —— 与 query.ts 的 runTools() 一致：
          // 遍历全部 tool block，不 break、不短路。
          if (settlement.onApprovalRejected === "SKIP_REMAINING") skipRemaining = true;
          continue;
        }
      }

      // ── ⑤ 执行
      const attemptId = asId<AttemptId>(deps.ids.next("att"));
      const startedAt = deps.now();
      action.stage = "EXECUTING";
      yield ev(deps, "AttemptStarted", { actionId, toolName: call.name });

      const progressNotes: string[] = [];
      const ctx: ToolExecutionContext = {
        signal: deps.signal,
        workspaceRoot: deps.workspaceRoot,
        onProgress: (n) => progressNotes.push(n),
      };

      let outcome;
      try {
        outcome = await deps.tools.execute(action, ctx);
      } catch (err) {
        outcome = {
          ok: false,
          output: "",
          // 抛异常意味着我们不知道副作用发生没有。
          // 【定】UNKNOWN 不得自动重试（不变量 10）。
          sideEffectState: "UNKNOWN" as const,
          error: makeError({
            code: "TOOL_THREW",
            source: "TOOL_HANDLER",
            category: "INTERNAL",
            retryability: "AFTER_USER_ACTION",
            sideEffectState: "UNKNOWN",
            safeMessage: `工具抛出异常，副作用状态未知：${String((err as Error)?.message ?? err).slice(0, 160)}`,
          }),
        };
      }

      const attempt: ExecutionAttempt = {
        id: attemptId,
        actionId,
        startedAt,
        finishedAt: deps.now(),
        status: outcome.ok ? "SUCCEEDED" : "FAILED",
        sideEffectState: outcome.sideEffectState,
        output: outcome.output,
        error: outcome.error,
      };
      attempts.push(attempt);

      yield ev(deps, "AttemptCompleted", {
        actionId,
        status: attempt.status,
        sideEffectState: attempt.sideEffectState,
        durationMs: (attempt.finishedAt ?? startedAt) - startedAt,
      });

      if (outcome.sideEffectState === "UNKNOWN" || outcome.sideEffectState === "PARTIALLY_APPLIED") {
        recoveryItems.push({
          what: `${call.name} → ${resolvedEffect.scope.value}`,
          sideEffectState: outcome.sideEffectState,
          actionId,
          toolCallId: call.toolCallId,
        });
      }

      // ── ⑥ 边界脱敏。【定】不得绕过；脱敏失败 = Tool 失败，不得原样保存。
      const red = deps.redaction.redact(outcome.output, effectiveRedaction(def));
      if (!red.ok) {
        const e =
          red.error ??
          makeError({
            code: "REDACTION_FAILED",
            source: "TOOL_HANDLER",
            category: "REDACTION",
            retryability: "NEVER",
            sideEffectState: outcome.sideEffectState,
            safeMessage: "脱敏失败，拒绝把原始输出写入任何持久化位置",
          });
        settle(call.toolCallId, renderError(e), true);
        action.stage = "SETTLED";
        continue;
      }

      // ── ⑦ Verification。Tool Handler 的 "success" 不能替代它。
      const vr = await deps.verification.verify(action, outcome, ctx);
      verifiedCallIds.add(call.toolCallId);
      verifications.push(vr);
      yield ev(deps, "VerificationCompleted", {
        actionId,
        status: vr.status,
        required: vr.required,
        detail: vr.detail,
      });

      // ── ⑧ 结算
      action.stage = "SETTLED";
      if (outcome.ok) {
        const note =
          vr.status === "FAILED" ? `\n\n[验证未通过] ${vr.detail}` : "";
        settle(call.toolCallId, red.text + note, vr.status === "FAILED");
      } else {
        settle(call.toolCallId, renderError(outcome.error!), true);
        if (settlement.onActionFailure === "SKIP_REMAINING") skipRemaining = true;
        if (settlement.onActionFailure === "ABORT_BATCH") break;
      }
    }
  } finally {
    // 【定】所有出口都经过这里。缺失的 result 在此补齐。
    finalize(calls, ledger, deps.signal.aborted || aborted, skipRemaining);
    // 【定】result 补齐了，事实也必须补齐 —— 两者是同一条不变量的两面。
    recordUnmetRequired(calls, deps, ledger, verifiedCallIds, actionIdByCall, verifications);
    batch.status = "SETTLED";
    batch.settledAt = deps.now();
  }

  const results = calls.map((c) => ledger.get(c.toolCallId)!);

  yield ev(deps, "ActionBatchSettled", {
    batchId,
    resultCount: results.length,
    callCount: calls.length,
  });

  return {
    batch,
    results,
    verifications,
    attempts,
    recoveryItems,
    aborted: deps.signal.aborted || aborted,
  };
}

/**
 * 配对不变量的最后一道。
 *
 * 【定】任何没有走到结算的 call 在这里被补上 result。
 * 这个函数的存在本身就是「没有外部兜底」的应对 —— 如果它漏了一个，
 * transcript 里就会留下无 result 的 tool_use，下次 resume() 发给模型
 * 就是一个失真的世界，而端点会 200 放行。
 */
function finalize(
  calls: ToolCallRequest[],
  ledger: Map<string, ModelContent>,
  aborted: boolean,
  skipped: boolean,
): void {
  for (const c of calls) {
    if (ledger.has(c.toolCallId)) continue;
    const reason = aborted
      ? "执行被取消，该工具未启动"
      : skipped
        ? "同批中较早的操作失败，按结算策略跳过"
        : "未执行（批提前结束）";
    ledger.set(c.toolCallId, {
      type: "tool_result",
      toolCallId: c.toolCallId,
      content: JSON.stringify({ status: "SKIPPED", reason, sideEffectState: "NOT_STARTED" }),
      isError: true,
    });
  }
}

/**
 * 事实补齐：为「声明了 requiredForSuccess 却没走到 Verification」的 call
 * 合成一条 FAILED 的 VerificationResult。
 *
 * 触发它的全部路径（都在上面的循环里 continue / break 掉了）：
 *   · schema 校验不过        —— 目标状态确定没达成
 *   · Policy DENY            —— 同上
 *   · 用户拒绝审批            —— 同上
 *   · 脱敏失败               —— 工具跑了但结果不可用，目标状态不可确认
 *   · 批内策略跳过 / cancel   —— 压根没启动
 *
 * 【定】这些都是「必需操作没有完成」这一事实的不同成因，不是「无事发生」。
 * detail 直接引用已合成的 result 正文 —— 模型看到什么，事实表里就记什么，
 * 两边不会讲两套故事。
 */
function recordUnmetRequired(
  calls: ToolCallRequest[],
  deps: BatchDeps,
  ledger: Map<string, ModelContent>,
  verifiedCallIds: Set<string>,
  actionIdByCall: Map<string, ActionId>,
  verifications: VerificationResult[],
): void {
  for (const c of calls) {
    if (verifiedCallIds.has(c.toolCallId)) continue;
    const def = deps.registry.get(c.name)?.definition;
    // 工具不存在时无从知道它必不必需 —— 模型调了一个不存在的工具，
    // 那是 result 里的 TOOL_NOT_FOUND 要告诉它的事，不是完成判定的事。
    if (!def?.verification.requiredForSuccess) continue;

    const settled = ledger.get(c.toolCallId);
    const settledText = settled?.type === "tool_result" ? settled.content : "无结算记录";
    verifications.push({
      id: `ver_unmet_${c.toolCallId}`,
      actionId:
        actionIdByCall.get(c.toolCallId) ?? asId<ActionId>(`act_unsettled_${c.toolCallId}`),
      mode: def.verification.mode,
      required: true,
      status: "FAILED",
      detail: `必需操作 ${c.name} 未完成，未能进入验证：${settledText}`,
      at: deps.now(),
    });
  }
}

/**
 * 合成 result 的形态是端点相关的：Anthropic 形状有 is_error 带外字段，
 * OpenAI 形状只能写进 content。这里约定一个结构化 payload 作为下限，
 * 形状适配器在有带外字段时额外标记（见 protocol.ts 的 toBlock）。
 */
function renderError(e: RuntimeErrorRecord): string {
  return JSON.stringify({
    status: "ERROR",
    code: e.code,
    message: e.safeMessage,
    sideEffectState: e.sideEffectState,
    retryable: e.retryability !== "NEVER",
  });
}

function digest(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function ev<T extends RunEvent["type"]>(
  deps: BatchDeps,
  type: T,
  payload: Extract<RunEvent, { type: T }>["payload"],
): RunEvent {
  return {
    runId: deps.runId,
    sequence: 0,
    occurredAt: deps.now(),
    type,
    payload,
  } as RunEvent;
}
