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

import type {
  UnmetCause,
  ApprovalDecision,
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
import type { ArtifactCheckFact, ExecutionPrivilege, RecoveryItem } from "../types/run.js";
import type { RunEvent } from "../types/event.js";
import { makeError, type RuntimeErrorRecord } from "../types/error.js";
import { asId, digest, type ActionBatchId, type ActionId, type AttemptId, type RunId } from "../types/ids.js";
import { isAbsolute } from "node:path";
import { isPathInsideWorkspace } from "../workspace/index.js";
import type {
  ArtifactCheckerPort,
  ArtifactStorePort,
  BlobStorePort,
  EffectResolverPort,
  IdGeneratorPort,
  RedactionPort,
  ToolExecutionContext,
  ToolExecutionOutcome,
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
  /** 随 AgentSpec 冻结的时区，透传给工具（见 ToolExecutionContext.timezone）。 */
  timezone: string;
  /**
   * 随 AgentSpec 冻结的执行特权档位（ADR-0012）。两个消费点：
   * ① 透传给工具（`ToolExecutionContext.executionPrivilege`）；
   * ② 交给 `evaluatePolicy` —— UNRESTRICTED 下越界写不再直接拒绝。
   */
  executionPrivilege: ExecutionPrivilege;
  /**
   * 落一条逐 Action 事实（决 6）。由调用方接到 transcript 上。
   *
   * 为什么是回调而不是直接给 TranscriptStorePort：批执行不该认识
   * 「事实存在哪」这件事。它只负责说「这是一条事实」，落在哪由上层决定 ——
   * facade 的恢复路径与主循环用的是同一个回调、不同的取号器。
   */
  recordActionFact?: (fact: { toolCallId: string; toolName: string; fingerprint: unknown; at: number }) => Promise<void>;
  approvalPolicy: ApprovalPolicySnapshot;
  ids: IdGeneratorPort;
  now: () => number;
  signal: AbortSignal;
  workspaceRoot: string;
  settlement?: BatchSettlementPolicy;
  /**
   * 大结果外置（阶段 3 S6，§11.4）。
   *
   * 不传就退化成「一律 inline」—— 那正是批 1 结束时的状态，
   * `verify:tools` H 段的那条已知红说的就是它。
   */
  blobs?: BlobStorePort;
  /** Artifact 登记与第二层 Verification（阶段 3 S8，§17 / §10.4）。 */
  artifacts?: ArtifactStorePort;
  artifactChecks?: ArtifactCheckerPort;
  /**
   * 超过多少 token 就外置。来自 `ContextBudgetPolicy.inlineToolResultLimitTokens`。
   *
   * 【定】它**由上下文预算决定，不存在协议硬上限**。
   * 【端点·百炼】200KB 的单个 tool_result 被接受、计 34576 token ——
   * 也就是说端点不会替你把关，超限的代价是撞上下文墙，而不是一个 400。
   */
  inlineResultLimitTokens?: number;
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
  /** 第二层 Verification 的事实（§10.4）。与 verifications 分开，见类型注释。 */
  artifactChecks: ArtifactCheckFact[];
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
  const artifactChecks: ArtifactCheckFact[] = [];

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
  /** 决 2：每个 call「为什么没完成」，在事情发生的那一刻记下。 */
  const causeByCall = new Map<string, UnmetCause>();

  let aborted = false;
  let skipRemaining = false;

  const batch: ActionBatch = {
    id: batchId,
    runId: deps.runId,
    invocationId: deps.invocationId,
    actions: prepared,
    // 【定·D-01】恒为串行，且必须由 Runtime 自己保证。
    // 实测四个端点全部静默接受强制单条开关，三个不生效，没有一个报错。
    executionMode: "SEQUENTIAL",
  };

  yield ev(deps, "ActionBatchPlanned", {
    batchId,
    callCount: calls.length,
    mode: batch.executionMode,
  });

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
      /**
       * 【定】`stage` 从这里起只在**进了 `prepared[]` 的那份**上有意义。
       *
       * 三条 REJECTED_SCHEMA 路径此前会给这个局部对象写一次 stage 再 `continue`，
       * 而它**不会进任何集合**（只有下面那个 `action` 才 push）—— 写完就被丢弃。
       * 拒绝这件事由 `ActionRejected` 事件承载，那才是有读者的那条轨道。
       */
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
        const e = validation.error!;
        settle(call.toolCallId, renderError(e), true);
        yield ev(deps, "ActionRejected", { actionId, stage: "REJECTED_SCHEMA", reason: e.safeMessage });
        continue;
      }

      // ── ② Effect 解析。【定】不得绕过（V05 §28.2）。
      const resolveGuarded = await guard(
        () => deps.effects.resolve(def.effectResolution, validation.normalized!, deps.workspaceRoot),
        {
          code: "PORT_EFFECT_RESOLVER_THREW",
          source: "RUNTIME",
          // 还没到执行，副作用明确没有发生。
          sideEffectState: "NOT_STARTED",
          what: "EffectResolverPort.resolve()",
        },
      );
      if (!resolveGuarded.ok) {
        settle(call.toolCallId, renderError(resolveGuarded.error), true);
        yield ev(deps, "ActionRejected", {
          actionId,
          stage: "REJECTED_SCHEMA",
          reason: resolveGuarded.error.safeMessage,
        });
        continue;
      }
      const resolvedEffect = resolveGuarded.value;

      const action: PreparedAction = {
        ...proposed,
        stage: "PREPARED",
        normalizedInput: validation.normalized,
        inputDigest: digest(JSON.stringify(validation.normalized)),
        resolvedEffect,
        preparedAt: deps.now(),
      };
      prepared.push(action);

      /**
       * ══════════════════════════════════════════════════════════════════
       * 【定】`riskFacts` 与 `dataMovement` 必须进事件（本批决 3）。
       *
       * `policy.ts` 把「URL scope 产出 riskFact ＋ dataMovement，**让外发在
       * Trace 上可审计**」列为「越界读放行」这个决定的三条护栏之一 ——
       * 而在此之前事件里只有一个拼接字符串 `effect`，那两样**从未离开过
       * Resolver 的返回值**。既有判据也没测到这一层：它直接调 Resolver 取值，
       * 绕过了它声称在测的那条链路（「判据测的不是它声称在测的东西」的又一例）。
       *
       * 于是那条护栏是一句**不成立的依据**，而放开越界读正是靠它撑着的。
       * ══════════════════════════════════════════════════════════════════
       */
      yield ev(deps, "ActionProposed", {
        actionId,
        toolCallId: call.toolCallId,
        toolName: call.name,
        effect: `${resolvedEffect.effectType} ${resolvedEffect.scope.value}`,
        riskFacts: [...resolvedEffect.riskFacts],
        ...(resolvedEffect.dataMovement ? { dataMovement: resolvedEffect.dataMovement } : {}),
      });

      // ── ③ Policy
      const verdict = evaluatePolicy({
        action,
        approvalPolicy: deps.approvalPolicy,
        executionPrivilege: deps.executionPrivilege,
      });

      if (verdict.decision === "DENY") {
        action.stage = "REJECTED_POLICY";
        causeByCall.set(call.toolCallId, "POLICY_DENIED");
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
        /**
         * U-2：审批也要能超时。
         *
         * 在此之前审批是一个没有上限的 await —— R-2 的记录里这是三条叠加
         * 效应之一：审批不超时 ＋ cancel 打不断 ＋ 批准后立刻撞墙。
         * 前两条现在都堵上了（这里 ＋ CLI 的 rl.question 接 signal）。
         */
        const decisionGuarded = await guard(() => withApprovalTimeout(deps, action), {
          code: "PORT_APPROVAL_DECIDER_THREW",
          source: "RUNTIME",
          // 审批环节抛异常 = 没拿到批准。没批准就没执行。
          sideEffectState: "NOT_STARTED",
          what: "ApprovalDecider",
        });
        if (!decisionGuarded.ok) {
          action.stage = "REJECTED_APPROVAL";
          settle(call.toolCallId, renderError(decisionGuarded.error), true);
          yield ev(deps, "ActionRejected", {
            actionId,
            stage: "REJECTED_APPROVAL",
            reason: decisionGuarded.error.safeMessage,
          });
          continue;
        }
        const decision = decisionGuarded.value;
        yield ev(deps, "ApprovalDecided", {
          actionId,
          approved: decision.approved,
          reason: decision.reason,
          // 【定】decider 没声明就记 UNDECLARED，**不兜底成 HUMAN**。
          // 见 `ApprovalDecidedBy`：假话在事实表里比空白贵得多。
          decidedBy: decision.decidedBy ?? "UNDECLARED",
        });

        if (!decision.approved) {
          action.stage = "REJECTED_APPROVAL";
          /**
           * ── 【定】归责按 `decidedBy` 分流（ADR-0012 二次评审 P1-6）──────────
           *
           * 决 2 说「用户明确按了否 —— 这是一个有明确事实来源的成因」，
           * 而这里此前对**任何** `approved:false` 都写 `USER_REJECTED`：
           * 非交互环境无人应答、等待被 Ctrl+C 打断、审批超时，全都算成
           * 「用户拒绝」。那正是 `UnmetCause` 自己的【定】禁止的事
           * （「必须来自事实（谁拒的），不得由结算逻辑推断」），
           * 也正是 E-3 那句「结算 USER_REJECTED，而全程没有任何人拒绝过
           * 任何东西」的形状。
           *
           * `decidedBy` 是 ADR-0012 刚加的那条事实，这里是它的第二个消费者。
           */
          const byHuman = decision.decidedBy === "HUMAN";
          causeByCall.set(call.toolCallId, byHuman ? "USER_REJECTED" : "NO_APPROVAL");
          const e = makeError({
            code: byHuman ? "APPROVAL_REJECTED" : "APPROVAL_NOT_ANSWERED",
            // 【定】`source` 也要跟着走：没有人应答时把来源记成 USER，
            // 等于在错误记录里也说一遍那句假话。
            source: byHuman ? "USER" : "RUNTIME",
            category: "AUTHORIZATION",
            retryability: "AFTER_USER_ACTION",
            sideEffectState: "NOT_STARTED",
            safeMessage: byHuman
              ? `用户拒绝了这个操作${decision.reason ? `：${decision.reason}` : ""}`
              : `这一步需要审批，但**没有拿到任何人的应答**` +
                `${decision.reason ? `（${decision.reason}）` : ""}，按拒绝处置。` +
                `这不是「用户拒绝」—— 没有人做过这个决定。`,
          });
          settle(call.toolCallId, renderError(e), true);
          // 【D-21】默认 CONTINUE_REMAINING —— 与 query.ts 的 runTools() 一致：
          // 遍历全部 tool block，不 break、不短路。
          if (settlement.onApprovalRejected === "SKIP_REMAINING") skipRemaining = true;
          continue;
        }
      }

      /**
       * ── 决 6：执行**前**拍一张外部世界的指纹 ────────────────────────
       *
       * 只对声明了 `recoveryObservation` 的工具做。拍到了就落一条
       * `ACTION_FACT`，恢复时据此判断「那次执行到底发生没发生」——
       * §18.2 窗口 A/B 的「不可区分」只有靠这个才变得可区分。
       *
       * 【定】拍不到不是错误。拍不到就意味着这个 Action 崩溃后不可观察，
       * 也就是第三条分支 —— 那是一个**如实记录的事实**，不是失败。
       * 所以这里不 guard、不合成 result、不影响执行，只是没有那条 ACTION_FACT。
       *
       * 【定】必须在 `AttemptStarted` **之前**拍。
       * 第一版放在它之后，于是 `verify:crash` 打出了一个自相矛盾的结果：
       * 崩在窗口 A（AttemptStarted 处）时**永远拍不到指纹** —— 而窗口 A
       * 恰恰是最需要它的场景（工具没跑，只有靠前置状态才判得出「没发生」）。
       * 指纹描述的是「attempt 开始之前的世界」，位置错了语义就错了。
       */
      if (snapshot.definition.recoveryObservation && deps.verification.observePre) {
        try {
          const pre = await deps.verification.observePre(action, {
            signal: deps.signal,
            workspaceRoot: deps.workspaceRoot,
            onProgress: () => {},
            timezone: deps.timezone,
            executionPrivilege: deps.executionPrivilege,
          });
          if (pre && deps.recordActionFact) {
            await deps.recordActionFact({
              toolCallId: call.toolCallId,
              toolName: call.name,
              fingerprint: pre.fingerprint,
              at: pre.at,
            });
          }
        } catch {
          // 观察失败 = 没有指纹 = 第三条分支。如实体现，不抛。
        }
      }

      // ── ⑤ 执行
      const attemptId = asId<AttemptId>(deps.ids.next("att"));
      const startedAt = deps.now();
      action.stage = "EXECUTING";
      yield ev(deps, "AttemptStarted", { actionId, toolName: call.name });

      /**
       * ── U-3：`ToolProgress` 事件的**第一个生产点** ──────────────────────
       *
       * 在此之前 `ctx.onProgress` 只是把字符串塞进一个数组，
       * 而那个数组从头到尾没有任何消费者 —— `ToolProgress` 事件类型有定义、
       * **零发出点**，Progress Guard 因此没有任何输入可消费。
       * 这是「未接线比不写更糟」的又一例：读代码的人会以为进展是被监控的。
       *
       * ⚠️ 修它的那一版**只加了 `progressQueue`，把原来那个只写不读的
       * `progressNotes` 原样留在了原地** —— 一个仓库把某种缺陷写成文件头的
       * 教训，然后在同一个函数体里留下了它的实例。2026-08-31 才删掉。
       *
       * 【定】进展直接 yield，**不进 LoopState**（循环纪律第 4 条）。
       * 它是可观测信号，不是状态。
       */
      const progressQueue: string[] = [];
      /**
       * U-2：每一步都有自己的超时，但共享 Run 级取消。
       *
       * 在此之前 `ToolDefinition.timeoutPolicy` 有声明、无执行路径，
       * `RunInterrupts.stepSignal()` 有实现、零调用点 —— 也就是说
       * **一个挂住的工具会永远挂住**：Run 级 signal 只在用户 Ctrl+C 时才动，
       * 而无人值守的场景（Eval、定时任务）根本没有那个用户。
       *
       * 用 `AbortSignal.any([runSignal, timeout])`：取消与超时哪个先到都算数，
       * 且工具侧只看见一个 signal，不需要理解两者的区别。
       */
      const stepMs = snapshot.definition.timeoutPolicy.timeoutMs;
      const stepSignal =
        stepMs > 0 ? AbortSignal.any([deps.signal, AbortSignal.timeout(stepMs)]) : deps.signal;
      const ctx: ToolExecutionContext = {
        signal: stepSignal,
        workspaceRoot: deps.workspaceRoot,
        onProgress: (n) => progressQueue.push(n),
        timezone: deps.timezone,
        executionPrivilege: deps.executionPrivilege,
      };

      /**
       * ── S10 ②：等人的那一段要被**事件对**夹出来 ────────────────────────
       *
       * 【定】形态照抄 `ApprovalRequested` / `ApprovalDecided`，理由也一样：
       * 主循环拿得到完整的事件对，而 settle-batch 不认识「预算」这个概念。
       * 让它去报时会把预算语义泄进批执行逻辑里。
       *
       * 【定】判据是**声明**（`waitsForHumanInteraction`），不是工具名 ——
       * Runtime 不许认识任何具体工具，见那个字段的注释。
       */
      const waitsForHuman = snapshot.definition.waitsForHumanInteraction === true;
      if (waitsForHuman) {
        yield ev(deps, "InteractionRequested", {
          actionId,
          toolName: call.name,
          // 入参已规范化、已过 schema —— 这里只是把它摊给 Trace 与 UI 看。
          detail: JSON.stringify(validation.normalized).slice(0, 400),
        });
      }

      let outcome;
      try {
        outcome = await deps.tools.execute(action, ctx);
        if (waitsForHuman) {
          yield ev(deps, "InteractionCompleted", {
            actionId,
            toolName: call.name,
            /**
             * 【定】`answered` 说的是「人应答了没有」，**不是**「任务成功了没有」。
             * §20.3：完成信号不等于任务成功，必须重新 Observation。
             *
             * ── 2026-08-30 评审：`outcome.ok` 单独用不够了 ──────────────────
             *
             * 阶段 3.5 的 `ask_user` 在**没有人**回答时刻意返回 `ok: true`
             * ＋ `status: "NO_ANSWER"`（决 3：问不到人不该让任务中止）。
             * 两个各自正确的决定在乘积处产生了一条错误事实：
             * Trace 上每一次无人应答都被记成「人应答了」。
             *
             * 行为上目前没坏（等待扣除只看事件对、不看这个字段），
             * 但 §20.3 的审计语义失真 —— 非交互跑批的「人工参与率」会全是假的。
             *
             * 【定】判据是**工具自报的事实**，不是 Runtime 猜的。
             * 工具在 output 里说了 NO_ANSWER，这里就照着记；
             * Runtime 不认识任何具体工具，只认这个约定好的字段名。
             */
            answered: outcome.ok && !declaresNoAnswer(outcome.output),
          });
        }
        /**
         * 【定】执行完之后**排空**进展队列。
         *
         * 理想形态是执行期间实时 yield，但 `tools.execute()` 是一个
         * `await` —— generator 在它期间是挂起的，中途 yield 不出去。
         * 真正的实时回报需要把工具执行改成 generator（波及每一个工具），
         * 代价与收益不成比例：Guard 判「还活着」看的是**有没有回报过**，
         * 而不是「回报得有多及时」。
         *
         * 所以这里如实排空，并在事件时间戳上用 `deps.now()` ——
         * 时间戳因此是「批结算时刻」而不是「进展发生时刻」。
         * 这个偏差要写下来，不要让下一个人以为它是实时的。
         */
        for (const note of progressQueue.splice(0)) {
          yield ev(deps, "ToolProgress", { actionId, note });
        }
        /**
         * 工具「正常返回」但 signal 已经因超时而 abort 的情况要单独认出来。
         *
         * 不这么做的话，一个不检查 signal 的工具会在超时之后照常返回成功，
         * 而超时这件事在事实表上一点痕迹都没有 —— 那比不做超时更糟，
         * 因为读代码的人会以为有这层保护。
         */
        if (stepSignal.aborted && !deps.signal.aborted && outcome.ok) {
          outcome = {
            /**
             * 【定】**保留 `artifact`**，不要在这里重建一个只有四个字段的对象。
             *
             * 原写法是 `{ ok, output, sideEffectState, error }` —— 四个字段
             * 逐个抄过来，于是 `artifact` 被**静默丢掉**。而下面第 ⑦.5 步的
             * 登记块对成功与失败都跑（`if (outcome.artifact && deps.artifacts)`），
             * 所以丢掉它的后果不是「失败所以不登记」，是：
             *
             *   命令跑完了、产物真的写在盘上、只是恰好越过步级超时
             *     → 产物不登记
             *     → `artifactChecks` 里**连一条失败事实都没有**
             *     → 结算时「没验过」表现成「没问题」
             *
             * 这与同一个函数里 catch 那段的【定】（「登记失败也必须留下一条
             * **失败的**检查事实」）是同一条纪律，这里此前没兑现。
             * 用展开而不是逐字段抄，将来给 outcome 加字段时也不会再漏一次。
             */
            ...outcome,
            ok: false,
            // 工具确实跑完了，副作用是发生了的 —— 如实写 APPLIED，
            // 不要因为「超时」就改成 UNKNOWN 而凭空制造一个待确认项。
            error: makeError({
              code: "TOOL_TIMEOUT",
              source: "TOOL_HANDLER",
              category: "TIMEOUT",
              retryability: "SAME_INPUT_BACKOFF",
              sideEffectState: outcome.sideEffectState,
              safeMessage: `工具超过 ${stepMs}ms 的步骤超时（结果已产生但已超时，按失败处置）`,
            }),
          };
        }
      } catch (err) {
        // 抛异常之前回报过的进展同样要发出去 —— 它恰恰是排查「卡在哪」的线索。
        for (const note of progressQueue.splice(0)) {
          yield ev(deps, "ToolProgress", { actionId, note });
        }
        /**
         * 【定】等待段必须**闭合**，哪怕它是以异常收尾的。
         *
         * 漏掉这一条，主循环的 `waitingSince` 就永远悬着 —— 从那一刻起
         * `activeNow()` 会把**剩下的所有时间**都当成等待扣掉，
         * 墙钟预算从此形同虚设，而且没有任何征兆。
         */
        if (waitsForHuman) {
          yield ev(deps, "InteractionCompleted", {
            actionId,
            toolName: call.name,
            answered: false,
          });
        }
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

      if (!outcome.ok) causeByCall.set(call.toolCallId, "TOOL_FAILED");

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
      // 抛异常与返回 ok:false 是同一件事的两种表达，收敛到同一条处置路径上。
      const redGuarded = await guard(
        () => deps.redaction.redact(outcome.output, effectiveRedaction(def)),
        {
          code: "PORT_REDACTION_THREW",
          source: "TOOL_HANDLER",
          // 工具已经跑完了，副作用状态是它给的那个 —— 不能因为脱敏挂了就改写它。
          sideEffectState: outcome.sideEffectState,
          what: "RedactionPort.redact()",
        },
      );
      const red = redGuarded.ok
        ? redGuarded.value
        : { ok: false as const, text: "", report: { fieldsRedacted: [], bytesRedacted: 0 }, error: redGuarded.error };
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
      const vrGuarded = await guard(() => deps.verification.verify(action, outcome, ctx), {
        code: "PORT_VERIFICATION_THREW",
        source: "VERIFICATION",
        // 同 ⑥：工具已经跑过，副作用状态不因验证挂掉而改变。
        sideEffectState: outcome.sideEffectState,
        what: "VerificationPort.verify()",
      });
      if (!vrGuarded.ok) {
        /**
         * 【定】这里**不** verifiedCallIds.add()。
         *
         * 于是 finally 里的 recordUnmetRequired() 会为声明了 requiredForSuccess
         * 的工具自动补一条 FAILED —— 「验证抛了异常」和「验证没得出通过结论」
         * 在结算层是同一件事，不该有第二套判据。这条链已经自洽，不用额外处理。
         */
        action.stage = "SETTLED";
        settle(call.toolCallId, renderError(vrGuarded.error), true);
        if (settlement.onActionFailure === "SKIP_REMAINING") skipRemaining = true;
        continue;
      }
      const vr = vrGuarded.value;
      verifiedCallIds.add(call.toolCallId);
      /**
       * ══════════════════════════════════════════════════════════════════
       * 【定】**已经记下的成因要附到这条验证事实上**，否则它到不了任何地方。
       *
       * 这是补给一个真洞的：上面第 605 行左右的
       * `if (!outcome.ok) causeByCall.set(call.toolCallId, "TOOL_FAILED")`
       * 看起来是接好的，实际**在正常路径上从来没有消费者** ——
       * `causeByCall` 唯一的读者是 `recordUnmetRequired()`，而它只处理
       * **不在** `verifiedCallIds` 里的 call。一个工具失败了却仍然走到
       * Verification（那是常态：`verify()` 就在下面一行），就会被加进
       * `verifiedCallIds`，于是刚记下的 `TOOL_FAILED` 当场作废。
       *
       * 后果在 `unmetCauseCounts` 上直接可见：一次工具失败导致的未达成项
       * 记成 `UNSPECIFIED`（`tallyUnmetCauses` 的缺省），而 ADR-0001 说
       * 「是谁没做成」只能从事实表里聚合 —— 那个聚合于是答不出最常见的一种。
       *
       * 形态与 `riskFacts` / `dataMovement` / `replacedBytes` 三次一模一样：
       * **一条撑着结论的依据从未离开产生它的那个函数。**
       * 这次是写判据时被 `verify:pairing` 那条新用例当场打出来的
       * （期望 `{CANCELLED:1}`，实际 `{UNSPECIFIED:1, CANCELLED:1}`）。
       *
       * 【定】只在「必需 ＋ 没通过 ＋ Verifier 自己没给成因」时附 ——
       * Verifier 若已经说了，以它的为准（它比这里更接近事实）。
       * ══════════════════════════════════════════════════════════════════
       */
      const recordedCause = causeByCall.get(call.toolCallId);
      verifications.push(
        vr.required && vr.status !== "PASSED" && vr.unmetCause === undefined && recordedCause
          ? { ...vr, unmetCause: recordedCause }
          : vr,
      );
      yield ev(deps, "VerificationCompleted", {
        actionId,
        status: vr.status,
        required: vr.required,
        detail: vr.detail,
      });

      /**
       * ── ⑦.5 Artifact 登记 ＋ 第二层 Verification（阶段 3 S8）────────────
       *
       * 【定】它排在 Action 级 Verification **之后**、结算之前。
       *
       * 顺序不是随意的：两层问的不是同一个问题，而第二层的触发点是
       * `ArtifactRegistered`（§10.4）—— 产物得先存在、先登记，才谈得上
       * 「这个产物本身完不完整合法」。
       *
       * 【定】工具**没声明** artifact 时这里一步都不做。
       * 不扫 workspace、不从 output 里猜 —— 见 ProducedArtifact 的说明。
       */
      /**
       * 【定】拒绝登记时给模型的一句话。它必须进 **tool_result**，不能只留在
       * 事实表里 —— 模型是唯一能把产物挪回 workspace 内的人，而它看不到事实表。
       * 与 `run_shell` 的 `artifactNote` 是同一条理由（那边在工具内部拼）。
       */
      let artifactNote = "";
      /**
       * ── 【定】交付物 containment 闸门（ADR-0012 二次评审 P1-1）─────────────
       *
       * 它守的是一条 Runtime 不变量：**`deliveredArtifactIds` 里不许出现
       * Atlas 无法证明其归属的东西**（§17）。
       *
       * 为什么必须在 Runtime 这一层，而不是「让每个工具自己拒」：
       * `run_shell` 一直拒着（`声明的交付物 … 不在 workspace 内，未登记`），
       * 而 ADR-0012 放开写边界之后 `write_file` **没跟着拒** —— 于是
       * 一个 `$HOME` 下的文件被登记、通过 hash 检查（检查器算的是
       * `resolve(workspaceRoot, record.path)`，而绝对路径会原样返回自己）、
       * 进 `deliveredArtifactIds`，被冒认成本 Run 的交付物。
       * 那条代价我自己写在 ADR 里（「UNRESTRICTED 下交付物登记仍限 workspace
       * 内」），而实现没有兑现它。**逐工具拒 = 下一个加产物的工具再犯一次。**
       *
       * 【定】拒绝的形态是「**不登记 ＋ 留一条失败的检查事实**」，
       * 不是把工具调用报成失败 —— 文件确实写出去了，副作用已经发生，
       * 报失败会让模型去重写一份已经存在的东西（与下面 catch 那段同一条理由）。
       * 留失败事实之后，既有的 role 分流规则接手：DELIVERABLE → FAILED、
       * INTERMEDIATE → COMPLETED_WITH_LIMITS。这里**不发明新的结算语义**。
       *
       * 【定】`logicalId` 也要看。它是版本链的身份，一个绝对路径的
       * logicalId 会把两个 Run 在 `/etc/foo` 上的写并进同一条 lineage。
       * 只在它**看起来是绝对路径**时才判 —— MCP 之类的工具可以用非路径 id。
       */
      if (outcome.artifact && deps.artifacts) {
        const a = outcome.artifact;
        const outsideClaim =
          a.path !== undefined && !isPathInsideWorkspace(deps.workspaceRoot, a.path)
            ? a.path
            : isAbsolute(a.logicalId) && !isPathInsideWorkspace(deps.workspaceRoot, a.logicalId)
              ? a.logicalId
              : undefined;
        if (outsideClaim !== undefined) {
          artifactChecks.push({
            artifactId: `art_outside_workspace_${call.toolCallId}`,
            logicalId: a.logicalId,
            role: a.role,
            ok: false,
            checksRun: [],
            detail:
              `声明的交付物 "${outsideClaim}" 落在 workspace 之外，**未登记**。` +
              `执行特权档位放开的是「命令能写到哪」，不是「什么算本次交付物」——` +
              `Atlas 只为 workspace 内的产物背书（它之外的东西无法证明是这个 Run 产出的）。` +
              `要交付就写到 workspace 内再声明一次。`,
            at: deps.now(),
          });
          artifactNote =
            `\n\n[交付物未登记] "${outsideClaim}" 在 workspace 之外。文件已经写出去了，` +
            `但它不会计入本次任务的交付物 —— 要交付请写到 workspace 内。`;
        } else
        try {
          const record = await deps.artifacts.register({
            runId: deps.runId,
            logicalId: a.logicalId,
            role: a.role,
            kind: a.kind,
            ...(a.path === undefined ? {} : { path: a.path }),
            content: a.content,
          });
          yield ev(deps, "ArtifactRegistered", {
            artifactId: record.artifactId,
            logicalId: record.logicalId,
            version: record.version,
            role: record.role,
            kind: record.kind,
            /**
             * 【定】这个产物是不是在一个已存在的文件上改出来的 —— 见
             * `ProducedArtifact.replacedBytes`。不带这个字段 = 它是新建的。
             *
             * 它只上事件、不进 outcome：覆盖一个已存在文件完全合法
             * （重新打包就是），所以它是审计事实而不是结算依据。
             */
            ...(a.replacedBytes === undefined ? {} : { replacedBytes: a.replacedBytes }),
          });

          if (deps.artifactChecks) {
            const checked = await deps.artifactChecks.check(record, a.content);
            await deps.artifacts.markVerified(record.artifactId, checked.ok, checked.detail);
            artifactChecks.push({
              artifactId: record.artifactId,
              logicalId: record.logicalId,
              role: record.role,
              ok: checked.ok,
              checksRun: checked.checksRun,
              detail: checked.detail,
              at: deps.now(),
            });
            yield ev(deps, "ArtifactVerified", {
              artifactId: record.artifactId,
              role: record.role,
              ok: checked.ok,
              checksRun: checked.checksRun,
              detail: checked.detail,
            });
          }
        } catch (err) {
          /**
           * 【定】登记失败**不改写**工具的执行结果。
           *
           * 文件已经写到盘上了，副作用已经发生。因为「登记这一步挂了」
           * 就把整次调用报成失败，会让模型去重写一份已经存在的产物。
           * 但它必须留下一条**失败的**检查事实 —— 否则「产物没被验过」
           * 会在结算时表现成「产物没问题」。
           */
          artifactChecks.push({
            artifactId: `art_unregistered_${call.toolCallId}`,
            logicalId: a.logicalId,
            role: a.role,
            ok: false,
            checksRun: [],
            detail: `Artifact 登记或检查失败：${String((err as Error)?.message ?? err).slice(0, 160)}`,
            at: deps.now(),
          });
        }
      }

      // ── ⑧ 结算
      action.stage = "SETTLED";
      if (outcome.ok) {
        const note =
          (vr.status === "FAILED" ? `\n\n[验证未通过] ${vr.detail}` : "") + artifactNote;
        // §11.4：超阈值的结果在这里外置，帧里只留结构合法的 stub。
        const materialized = await materialize(red.text, deps);
        if (materialized.externalized) {
          yield ev(deps, "ToolResultExternalized", {
            actionId,
            toolName: call.name,
            ref: materialized.ref!,
            sizeBytes: materialized.sizeBytes,
            approxTokens: materialized.approxTokens,
          });
        }
        settle(call.toolCallId, materialized.text + note, vr.status === "FAILED");
      } else {
        /**
         * ── 【定】失败分支也要带上**脱敏后的** output ────────────────────────
         *
         * 在此之前这里只发 `renderError(...)`，而 `renderError` 只读
         * `error.safeMessage` —— 于是一个工具想把「失败的细节」交给模型，
         * 唯一的通道就是 `safeMessage`。而那个字段的契约写着
         * 「**已脱敏**，可以展示给用户」（types/error.ts），脱敏管道
         * （上面第 ⑥ 步）却只处理 `outcome.output`。
         *
         * 两件事凑在一起的后果是一条**绕过不变量 13 的通用洞**：任何把外部
         * 内容放进 `safeMessage` 的工具，那段原文都会未经脱敏落进 transcript
         * 与下一轮上下文。MCP 工具是第一个真正踩上去的（服务器的 isError
         * 文本是任意外部内容），但洞不是 MCP 开的。
         *
         * 【定】所以处置在这里而不是在某个工具里：工具的正确写法是
         * 「原文放 output（走脱敏），safeMessage 只写自己生成的话」，
         * 而那个写法只有在这一行把 red.text 交出去之后才**成立**。
         *
         * 对既有工具是 no-op：它们 `ok:false` 时 `output` 本来就是空串。
         */
        const detail = red.text.trim() ? `\n${red.text}` : "";
        settle(call.toolCallId, renderError(errorOf(outcome, call.name)) + detail, true);
        if (settlement.onActionFailure === "SKIP_REMAINING") skipRemaining = true;
        if (settlement.onActionFailure === "ABORT_BATCH") break;
      }
    }
  } finally {
    /**
     * ── 【定】「没启动」也是一个**有事实来源**的成因，要记 `CANCELLED` ──────
     *
     * `UnmetCause` 的值域里一直有 `CANCELLED`（注释写着「被取消（用户 cancel
     * 或批内策略跳过）」），而它**零生产者** —— 于是一次跑到一半被 Ctrl+C 的
     * Run，那些没轮到的必需操作在 `unmetCauseCounts` 里全部记成 `UNSPECIFIED`。
     * 「说不出为什么」与「因为被取消了」在归因报告里是两件事。
     *
     * 【定】它来自**局部事实**（`aborted` / `skipRemaining` 这两个变量在事情
     * 发生的那一刻被置位），不是事后解析 result 文案 —— 与 `causeByCall`
     * 那段【定】同一条纪律。所以必须排在 `finalize()` **之前**：
     * finalize 一跑，ledger 就满了，「谁没启动」这个事实就读不出来了。
     */
    const stopped = deps.signal.aborted || aborted || skipRemaining;
    if (stopped) {
      for (const c of calls) {
        if (ledger.has(c.toolCallId)) continue;
        if (!causeByCall.has(c.toolCallId)) causeByCall.set(c.toolCallId, "CANCELLED");
      }
    }
    // 【定】所有出口都经过这里。缺失的 result 在此补齐。
    finalize(calls, ledger, deps.signal.aborted || aborted, skipRemaining);
    // 【定】result 补齐了，事实也必须补齐 —— 两者是同一条不变量的两面。
    recordUnmetRequired(calls, deps, ledger, verifiedCallIds, actionIdByCall, verifications, causeByCall);
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
    artifactChecks,
    aborted: deps.signal.aborted || aborted,
  };
}

/**
 * ToolResult Materialization（§11.4）：小结果 inline，大结果外置 ＋ stub。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】外置必须保留**协议合法的结构化 stub**（§11.5 不变量 5）。
 *
 * 不是把 result 删掉，也不是塞一句「结果太大」—— 前者违反不变量 8
 * （配对断了），后者让模型手里什么都没有。stub 必须同时说明三件事：
 *   · 这次调用**成功了**（否则模型会以为工具挂了并重试）；
 *   · 结果有多大、开头长什么样（preview 让它判断值不值得取回）；
 *   · **怎么取回**（ref ＋ 明确的工具名）。
 *
 * ── 【定】没有取回通路就不要外置 ────────────────────────────────────────
 *
 * 只做 stub 不给 `read_blob`，是**比静默截断更糟的信息阻断**：
 * 静默截断至少给了错误的完整感，阻断是明知有东西而拿不到。
 * 所以 `deps.blobs` 不存在时这里原样返回 —— 宁可撞上下文墙，
 * 也不给一个取不回来的 ref。批 1 结束时就是这个状态。
 *
 * ── 阈值为什么不是协议上限 ──────────────────────────────────────────────
 *
 * 【端点·百炼】200KB 的单个 tool_result 被接受、计 34576 token。
 * 端点不会替你把关 —— 超限的代价是撞上下文墙，不是一个 400。
 * 所以阈值来自 `ContextBudgetPolicy.inlineToolResultLimitTokens`，
 * 是**上下文预算决定**的，换端点不改这个数。
 * ══════════════════════════════════════════════════════════════════════
 */
async function materialize(
  text: string,
  deps: BatchDeps,
): Promise<{
  text: string;
  externalized: boolean;
  ref?: string;
  sizeBytes: number;
  approxTokens: number;
}> {
  const sizeBytes = Buffer.byteLength(text, "utf8");
  // 本地估算，与 Context 层的 `estimatedTokens` 同一个系数。精确值要发一次
  // count_tokens，而这里每个 tool_result 都要判一次 —— 不值得。
  const approxTokens = Math.ceil(text.length / 2.5);
  const limit = deps.inlineResultLimitTokens ?? 0;

  if (!deps.blobs || limit <= 0 || approxTokens <= limit) {
    return { text, externalized: false, sizeBytes, approxTokens };
  }

  try {
    const { ref } = await deps.blobs.put(text);
    const lines = text.split("\n");
    const stub = {
      status: "EXTERNALIZED",
      reason:
        `这次调用**成功了**，但结果有 ${approxTokens} tokens，超过单条结果的 inline 上限 ${limit}，` +
        `已外置存放，没有丢失任何内容。`,
      ref,
      sizeBytes,
      approxTokens,
      totalLines: lines.length,
      // preview 让模型判断值不值得取回，而不是盲取。
      preview: lines.slice(0, 20).join("\n").slice(0, 1_200),
      /**
       * 【定】这条提示必须说清楚**这一份**该怎么翻，不能只讲按行分页。
       *
       * 它此前固定写「按行取回，分页语义与 read_file 一致」，而同一个 stub
       * 报的是 `totalLines: 1` —— 被外置的东西几乎都是一整行 JSON，
       * 「按行翻」在它上面只有一页。照这条提示做的模型会翻一次就以为到头了，
       * 或者反复用 start_line 试探。2026-08-28 摸底考试的轨迹里两种都出现过。
       *
       * 它与 `CommonToolHandler` 的 `line_offset` 透传是同一个 bug 的两半：
       * 只修透传不修提示，模型仍然不知道该传什么；只修提示不修透传，
       * 模型传了也没用。**两处必须一起改。**
       */
      retrieval:
        lines.length === 1
          ? `这份结果是**一整行**，按行分页只有一页。用 read_blob({ ref: "${ref}", line_offset }) ` +
            `按字符续页：把返回里的 nextLineOffset 原样传回来，直到 truncated 为 false。`
          : `调用 read_blob({ ref: "${ref}", start_line, limit }) 按行取回，分页语义与 read_file 一致；` +
            `返回里带 nextStartLine / nextLineOffset 时把这两个值原样传回来接着取。`,
    };
    return { text: JSON.stringify(stub), externalized: true, ref, sizeBytes, approxTokens };
  } catch {
    /**
     * 【定】外置失败就 inline，不要把这次调用变成失败。
     *
     * 工具已经成功执行了，副作用也已经发生。因为「存不下大结果」而把它
     * 报成失败，会让模型去重做一件已经做完的事 —— 对非幂等工具就是双写。
     * 撞上下文墙是可见的、可恢复的；双写不是。
     */
    return { text, externalized: false, sizeBytes, approxTokens };
  }
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
  /**
   * 每个 call「为什么没完成」的事实记录（决 2）。
   *
   * 【定】它在**事情发生的那一刻**被写下，不是事后从 result 正文里猜的。
   * 猜的话就得解析文案，而文案会变 —— 那种判据在改一句提示语的时候
   * 会静默失效，且没有任何东西会告诉你。
   */
  causeByCall: Map<string, UnmetCause>,
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
      ...(causeByCall.has(c.toolCallId) ? { unmetCause: causeByCall.get(c.toolCallId)! } : {}),
    });
  }
}

/**
 * Port 调用的异常收敛（存量清单 R-4）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 在此之前只有 `tools.execute()` 有 try/catch。`effects.resolve()`、
 * `approvalDecider()`、`redaction.redact()`、`verification.verify()`
 * 抛出的异常会**直接穿透 generator**：
 *
 *   · finally 里的 finalize() 照样补齐了 ledger，但那份 ledger 随栈丢弃；
 *   · runLoop() 拿不到 BatchOutcome，合成 result 一条都进不了 transcript；
 *   · Facade 的 status 永久停在 RUNNING。
 *
 * 也就是说：不变量 8 的兜底代码跑了，兜底的结果却没人收 —— 最坏的一种形态，
 * 因为它看起来是有保护的。
 *
 * 定级要说清楚：这**不是当前的活跃 bug**。阶段 1 那四个实现都在内部吞掉了异常
 * （SimpleRedaction 与 MicroCaseVerifier 各有 try/catch，DeclarativeEffectResolver
 * 只在非 DECLARATIVE 时抛而阶段 1 没有这类工具）。**但阶段 2 一换实现就会变成活跃 bug**，
 * 所以必须赶在换 Port 实现之前修 —— 这也是它被列为阶段 2 前置的原因。
 * ══════════════════════════════════════════════════════════════════════
 */
type Guarded<T> = { ok: true; value: T } | { ok: false; error: RuntimeErrorRecord };

async function guard<T>(
  fn: () => T | Promise<T>,
  template: {
    code: string;
    source: RuntimeErrorRecord["source"];
    /**
     * 【定】按调用点分情况，不得一律写 UNKNOWN。
     *
     * UNKNOWN 的语义是「副作用发没发生我们不知道」，它会触发 RecoveryItem、
     * 阻断自动重试、在 resume 时把 Run 停在 RECOVERY_REQUIRED。
     * 对「工具压根还没执行」的那两个调用点（effects / approval）写 UNKNOWN，
     * 等于凭空造出一个需要人工确认的未知状态 —— 谎报的方向恰好是最贵的那边。
     */
    sideEffectState: RuntimeErrorRecord["sideEffectState"];
    what: string;
  },
): Promise<Guarded<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return {
      ok: false,
      error: makeError({
        code: template.code,
        source: template.source,
        category: "INTERNAL",
        // Port 实现自己抛异常属于配置或代码问题，重试同样的输入不会变好。
        retryability: "AFTER_USER_ACTION",
        sideEffectState: template.sideEffectState,
        safeMessage:
          `${template.what}抛出异常：${String((err as Error)?.message ?? err).slice(0, 160)}`,
      }),
    };
  }
}

/**
 * 工具有没有在结果里自报「没人应答」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】Runtime **不认识任何具体工具**，所以这里不能写
 * `if (toolName === "ask_user")` —— 那与 `waitsForHumanInteraction`
 * 做成声明而不是工具名判定是同一条边界（见 `types/tool.ts` 那段）。
 *
 * 认的是一个**约定好的字段名**：任何「等人」的工具想表达「问了但没人答」，
 * 就在结果 JSON 里写 `"status": "NO_ANSWER"`。将来第二个这类工具
 * 不用改 Runtime 一行。
 *
 * 解析失败 → 返回 false（即按「应答了」记）。方向的理由：
 * 这个字段只用于审计，不参与任何控制流；把一个解析不了的结果记成
 * 「没应答」会凭空造出一堆假的无人应答事件，比漏记更误导。
 * ══════════════════════════════════════════════════════════════════════
 */
function declaresNoAnswer(output: string): boolean {
  if (!output.includes("NO_ANSWER")) return false;
  try {
    return (JSON.parse(output) as { status?: unknown }).status === "NO_ANSWER";
  } catch {
    return false;
  }
}

/**
 * 取工具报的错；工具违约（`ok: false` 却没带 `error`）时**合成一条**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这里原本是 `outcome.error!` —— 一个非空断言掩着一个真洞。
 *
 * `ToolExecutionOutcome.error` 在类型上是**可选**的，所以任何一个工具
 * 返回 `ok: false` 而忘了带 error，这一行就抛 `TypeError: Cannot read
 * properties of undefined (reading 'code')`，**整个 Run 当场崩掉**。
 *
 * 而 `tools/` 这一层的全部意义就是让工具包能被独立地写、独立地接进来 ——
 * 一个第三方工具包的疏忽不该让 Harness 崩溃，它该得到一条说得清楚的
 * tool_result。2026-08-30 阶段 3.5 期间用故障注入撞出来的（改 `ask_user`
 * 的 NO_ANSWER 分支返回 ok:false 时，堆栈直接停在这一行）。
 *
 * 【定】合成而不是抛，理由是**不变量 8**：抛异常会让这一批在 `settle()`
 * 之前中断，配对补齐只能靠 `finally` 里的 `finalize()` 兜 —— 那是最后一道网，
 * 不该被一个可预见的契约违反常态性地触发。
 *
 * 合成的错误里点名「工具违约」，不伪装成一次普通的工具失败：
 * 排查的人要能一眼看出问题在工具的返回值上，而不是在它做的那件事上。
 * ══════════════════════════════════════════════════════════════════════
 */
function errorOf(outcome: ToolExecutionOutcome, toolName: string): RuntimeErrorRecord {
  if (outcome.error) return outcome.error;
  return makeError({
    code: "TOOL_CONTRACT_NO_ERROR",
    source: "TOOL_HANDLER",
    category: "INTERNAL",
    // 同样的输入再来一次还是同样的违约 —— 让模型改输入没有意义。
    retryability: "NEVER",
    // 【定】沿用工具自己报的副作用状态。工具说不清错误，不代表它说不清
    // 有没有写下去 —— 把这里硬编成 NO_EFFECT 会凭空抹掉一条恢复线索。
    sideEffectState: outcome.sideEffectState,
    safeMessage:
      `工具 ${toolName} 报告失败（ok: false）却没有附带 error —— 这是工具的契约违反。` +
      `Harness 合成了这条记录以保住批内配对（不变量 8）。请检查该工具的实现。`,
  });
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

/**
 * 给审批等待加超时。超时按**拒绝**处置（见 ApprovalPolicySnapshot 的说明）。
 *
 * 不用 AbortSignal：`ApprovalDecider` 是一个 `(action) => Promise` 的窄接口，
 * 给它加 signal 参数会波及所有实现（含验收脚本里的 scripted decider）。
 * 而这里真正要的只是「等不到就当拒绝」，Promise.race 足够表达，
 * 代价是被丢弃的那个 Promise 仍会在后台完成 —— 单进程 CLI 里无害。
 */
async function withApprovalTimeout(
  deps: BatchDeps,
  action: PreparedAction,
): Promise<ApprovalDecision> {
  const ms = deps.approvalPolicy.approvalTimeoutMs;
  if (!ms || ms <= 0) return deps.approvalDecider(action);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.approvalDecider(action),
      new Promise<ApprovalDecision>((resolve) => {
        timer = setTimeout(
          () => resolve({ approved: false, reason: `审批等待超过 ${ms}ms，按拒绝处置` }),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
