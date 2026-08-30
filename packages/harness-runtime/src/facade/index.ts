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
  ArtifactCheckFact,
  RecoveryItem,
  ResumableRunFacts,
  RunOutcome,
  RunSnapshot,
  RunSpec,
  RunStatus,
} from "../types/run.js";
import type { ActionBatchId, ActionId, ModelInvocationId, RunId } from "../types/ids.js";
import { asId } from "../types/ids.js";
import type { RunListItem, RuntimePorts, ToolExecutionContext } from "../ports/index.js";
import { assertResumeEndpointMatches, freezeRunSpec } from "../model/capability/profile-loader.js";
import { assertResumeWorkspaceMatches } from "../workspace/index.js";
import type {
  ApprovalDecider,
  PreparedAction,
  ToolSnapshot,
  VerificationResult,
} from "../types/tool.js";
import type { ContextMessage } from "../types/transcript.js";
import type { EndpointCapabilityProfile } from "../types/endpoint.js";
import type { ModelContent } from "../types/context.js";
import { runLoop } from "../loop/run-loop.js";
import { settleWallOutcome } from "../verification/settle-outcome.js";
import { RunInterrupts } from "../loop/interrupt/index.js";
import {
  findUnpairedToolUses,
  makeActionFactEntry,
  makeRunFactsEntry,
  readActionPreFingerprints,
  readRunFacts,
  type UnpairedToolUse,
} from "../transcript/index.js";
import { executeBatch } from "../action/settle-batch.js";
import { ToolRegistry, validateAndNormalize } from "../tool-runtime/index.js";
import { makeError } from "../types/error.js";

export interface HarnessRuntimeDeps {
  ports: RuntimePorts;
  approvalDecider: ApprovalDecider;
  workspaceRoot: string;
  /**
   * 当前进程 compose 出来的端点能力声明。
   *
   * 【定】它只在 `resume()` 里被用来**比对**冻结的那一份（§18.3），
   * 绝不用来顶替它。放在 deps 里而不是从 Port 里挖，是因为「当前端点是谁」
   * 是 Composition Root 的知识 —— Runtime 不该有办法自己去查。
   */
  currentEndpointProfile: EndpointCapabilityProfile;
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
  /**
   * 进程内中断句柄。
   *
   * 【定】这两个**不能**落库，也不该落库：`AbortController` 不可跨进程，
   * 「谁在跑」这件事的作用域天然就是进程。跨进程的并发保护由
   * `runs.status` 与「一个 Run 一个循环」（不变量 4）共同承担。
   */
  private readonly interruptsByRun = new Map<string, RunInterrupts>();
  /** 【定】一个 Run 同时只允许有一个循环在跑（本进程内）。 */
  private readonly running = new Set<string>();

  constructor(private readonly deps: HarnessRuntimeDeps) {}

  async *start(spec: RunSpec): AsyncGenerator<RunEvent, StartResult> {
    const runId = asId<RunId>(this.deps.ports.ids.next("run"));
    const interrupts = new RunInterrupts();
    this.interruptsByRun.set(String(runId), interrupts);
    this.running.add(String(runId));

    /**
     * 【定】M-4：进 RunSpec 的是**深冻结**的那一份。
     *
     * 阶段 1 只冻了 `endpointProfile`，`toolSnapshots` 与各 policy 还是活对象。
     * 跨进程之后这条不能再含糊：盘上那份是快照，内存那份若还能改，
     * §18.3 的「声明是否仍与冻结版一致」就变成了自己跟自己比。
     */
    const frozen = freezeRunSpec(spec);
    await this.deps.ports.runs.createRun({
      runId,
      spec: frozen,
      status: "RUNNING",
      now: this.deps.ports.clock.now(),
    });

    try {
      const gen = runLoop({
        runId,
        spec: frozen,
        ports: this.deps.ports,
        interrupts,
        approvalDecider: this.deps.approvalDecider,
        workspaceRoot: this.deps.workspaceRoot,
      });

      let r = await gen.next();
      while (!r.done) {
        await this.trackWaitStatus(runId, r.value);
        yield r.value;
        r = await gen.next();
      }
      await this.setStatus(runId, terminalToStatus(r.value.terminal));
      return r.value;
    } finally {
      this.running.delete(String(runId));
    }
  }

  /**
   * 把「循环正在等谁」如实反映到 `runs.status` 上（阶段 3 S10）。
   *
   * ── 为什么这件事必须做 ────────────────────────────────────────────────
   *
   * `WAITING_FOR_INTERACTION` 从阶段 1 起就在 `RunStatus` 的值域里，
   * 而**全仓只出现在类型定义中** —— 没有任何代码写入过它。
   * 于是「进程崩在等人的那一刻」在盘上表现为 `RUNNING`，
   * 与「崩在调模型的那一刻」完全不可区分，resume 也就无从做不同的处置。
   *
   * 【定】状态在这里写，不在 runLoop 里写：`runs` 是 Facade 的职责边界
   * （`runLoop` 拿到的是 ports，但生命周期语义归 Facade —— `start` /
   * `resume` 的终态映射也都在这一层）。
   *
   * 【定】写失败不得打断 Run。状态是**投影**，不是恢复来源（恢复走
   * transcript）—— 为了一次投影写入失败而中止一个正在等人的 Run，
   * 代价与收益完全不成比例。
   */
  private async trackWaitStatus(runId: RunId, e: RunEvent): Promise<void> {
    const next: RunStatus | undefined =
      e.type === "InteractionRequested"
        ? "WAITING_FOR_INTERACTION"
        : e.type === "ApprovalRequested"
          ? "WAITING_FOR_APPROVAL"
          : e.type === "InteractionCompleted" || e.type === "ApprovalDecided"
            ? "RUNNING"
            : undefined;
    if (!next) return;
    try {
      await this.setStatus(runId, next);
    } catch {
      /* 投影写失败不打断 Run，见上 */
    }
  }

  private async setStatus(runId: RunId, status: RunStatus): Promise<void> {
    await this.deps.ports.runs.setStatus(runId, status, this.deps.ports.clock.now());
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
    /**
     * 【定】读回**冻结的那一份** RunSpec，不是重新 compose 一份。
     *
     * 下面 §18.2 的三条分支判定完全依赖 `spec.agentSpec.toolSnapshots`：
     * 用今天的工具声明去判一条昨天的 transcript，改一次 `append_log` 的
     * verification 就会让同一条记录走进不同分支，**而盘上看不出来**。
     *
     * 取不到就抛，**不回退到当前配置** —— 「读不到就用现在的」是这条
     * 不变量最容易被顺手写出来的破法。
     */
    const spec = await this.deps.ports.runs.getRunSpec(runId);
    if (!spec) {
      throw new Error(
        `未知 Run：${runId}。\n` +
          `RunSpec 读不到，无法恢复 —— 恢复必须使用启动时冻结的那一份（§18.4【定】），` +
          `不能用当前配置顶替。\n` +
          `用 --list-runs 看看有哪些 Run，或确认 --db 指向的是同一个库。`,
      );
    }

    /**
     * §18.3【定】：端点一致性闸门。**必须在做任何事之前**。
     *
     * 排在生命周期闸门前面是刻意的：换了端点之后，连「这个 Run 现在是什么状态」
     * 都该被怀疑。让它在最早的地方失败，错误信息才指得准。
     */
    assertResumeEndpointMatches(
      { model: spec.agentSpec.model, profile: spec.endpointProfile },
      this.deps.currentEndpointProfile,
    );

    /**
     * §18.3 的第二维：**workspace 身份**（S4-5）。
     *
     * 与端点闸门并排、同样排在生命周期闸门之前 —— 换了执行条件之后，
     * 连「这个 Run 现在是什么状态」都该被怀疑。
     *
     * 【定】它对**缺失**那一档返回 `UNKNOWN_LEGACY` 而不是抛：这道闸门上线前
     * 创建的 Run 没有冻结 workspace，硬拒会把库里所有存量 Run 一次性变成
     * 不可恢复，而它们当初没做错什么。但也不能静默放行 —— 那正是这个洞
     * 原来的样子。所以下面**发一条事件**把「不知道」说出来。
     */
    const workspaceMatch = assertResumeWorkspaceMatches(spec.workspace, this.deps.workspaceRoot);

    /**
     * 【定】生命周期闸门。
     *
     * COMPLETED / FAILED 是终态，重跑它们会把已经结算过的副作用再做一遍 ——
     * 带真实写操作时就是重复副作用。CANCELLED 与 RECOVERY_REQUIRED 不在此列：
     * V05 §10 明确「没有 PAUSED，cancel() 后稍后 resume()」就是支持的路径。
     */
    const current = (await this.deps.ports.runs.getStatus(runId)) ?? "CREATED";
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
    this.interruptsByRun.set(key, interrupts);
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
      // 阶段 3 S8：第二层事实同样要接着累计，否则上一段验过的产物在结算时蒸发。
      const artifactChecks: ArtifactCheckFact[] = [...(priorFacts?.artifactChecks ?? [])];

      /**
       * D-2：取号走 store 的分配器，与 runLoop 同一条序列。
       *
       * 起点取「transcript 末尾」与「上次记下的高水位」的较大者。
       * 只看 transcript 末尾会重发上一段事件已经用掉的号 —— 事件不落 transcript，
       * 它在 transcript 上留不下痕迹，但在 Trace 里留得下。
       */
      let lastSequence = Math.max(lastSeq, priorFacts?.lastSequence ?? 0);
      const emit = async <T extends RunEvent["type"]>(
        type: T,
        payload: Extract<RunEvent, { type: T }>["payload"],
      ): Promise<RunEvent> => {
        lastSequence = await ports.transcript.nextSequence(runId, lastSequence);
        const e = {
          runId,
          sequence: lastSequence,
          occurredAt: ports.clock.now(),
          type,
          payload,
        } as RunEvent;
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

      yield await emit("ResumeStarted", {
        fromSequence: lastSeq,
        rebuiltMessages: messages.length,
      });

      /**
       * 【定】「这条 Run 没冻结 workspace，我无法核对」必须留在 Trace 上。
       *
       * 一条**放行了但没验过**的闸门，如果不说话，与「验过并通过」在事后
       * 完全不可区分 —— 而这两者对复盘的意义相反。用既有的
       * `RuntimeErrorOccurred` 承载（category INTERNAL、retryability NEVER、
       * 副作用 NO_EFFECT）：它不是错误，但它是**必须被看见的降级**。
       */
      if (workspaceMatch === "UNKNOWN_LEGACY") {
        yield await emit("RuntimeErrorOccurred", {
          error: makeError({
            code: "RESUME_WORKSPACE_UNVERIFIED",
            source: "RUNTIME",
            category: "INTERNAL",
            retryability: "NEVER",
            sideEffectState: "NO_EFFECT",
            safeMessage:
              `这个 Run 的 RunSpec 里没有冻结 workspace（它创建于 S4-5 闸门上线之前），` +
              `因此**无法核对**恢复时的目录是否与当初一致。本次以当前服务指向的 ` +
              `${this.deps.workspaceRoot} 继续。若它与当初不是同一个目录，` +
              `后续所有相对路径的读写都会落错地方。`,
          }),
        });
      }

      /**
       * ── S10 ③：上次崩在「等人」那一刻 ──────────────────────────────────
       *
       * 【定】`WAITING_FOR_INTERACTION` 不得成为一个**未定义的崩溃窗口**。
       *
       * 阶段 2 已经把 RunStatus 落库，但 resume 对这个状态**没有任何处理分支**
       * —— 它会一路走到主循环，然后**直接调模型**。那意味着：
       * 人被请求去做的那件事没有做，而模型收到的上下文里
       * 那次 `request_handoff` 是一个没有结果的调用，它只能瞎猜。
       *
       * 正确的处置是重新发起接管：`request_handoff` 声明了只读＋幂等，
       * 所以下面 §18.2 的**分支一**会真的把它重新执行一遍 ——
       * 而「重新执行 request_handoff」的语义恰恰就是「重新打印引导、重新等」。
       *
       * 也就是说这里不需要一条特殊路径，只需要**让它可见**：
       * 发一条事件，让 Trace 上能读出「这次 resume 是从等人的状态回来的」。
       */
      if (current === "WAITING_FOR_INTERACTION") {
        yield await emit("InteractionResumed", {
          pendingToolUses: findUnpairedToolUses(messages).map((u) => u.toolName),
        });
      }

      // ── 处理上一次停在 RECOVERY_REQUIRED 时用户给出的决策
      if (current === "RECOVERY_REQUIRED" && opts.recoveryDecision) {
        yield await emit("RecoveryResolved", {
          decision: opts.recoveryDecision,
          items: recoveryItems.length,
          note: opts.recoveryNote,
        });

        if (opts.recoveryDecision === "ABORT") {
          const terminal: Terminal = { reason: "ABORTED_TOOLS" };
          const outcome = settleWallOutcome("CANCELLED", {
            verifications,
            recoveryItems,
            artifactChecks,
            // R-7：outcome 必须能读出发生了什么。这条路径上「发生了什么」
            // 不是模型说的话，而是用户的恢复决策本身 —— 如实写它。
            summary:
              `用户对上次崩溃时状态未知的副作用给出 ABORT 决策，Run 收在 CANCELLED。` +
              (opts.recoveryNote ? `理由：${opts.recoveryNote}` : "未附理由。"),
          });

          /**
           * 【定】这条也是真正的终止，必须发 `LoopTerminated`（U-4）。
           *
           * U-4 修的是 runLoop 的 `finish()`，但 Run 不止从那里结束 ——
           * ABORT 决策直接在 facade 里收尾，绕过了整个主循环。漏掉这里的话，
           * §19.2「Trace 里能直接读出走了哪条路径」对**恢复被中止**这条路径
           * 仍然不成立，而这恰恰是最需要事后复盘的一种终止。
           *
           * 顺序同 run-loop：先 emit 再落事实（D-2）—— 反过来会让落盘的
           * lastSequence 停在事件号之前，下次取号撞上已经发出去的号。
           */
          yield await emit("LoopTerminated", { terminal, outcome });

          await ports.transcript.append(
            makeRunFactsEntry(
              runId,
              {
                turnCount: priorFacts?.turnCount ?? 0,
                consecutiveFailures: priorFacts?.consecutiveFailures ?? 0,
                budgetUsage: priorFacts?.budgetUsage ?? emptyBudget(ports.clock.now()),
                verifications,
                recoveryItems,
                artifactChecks,
                lastSequence,
                resumeBranchCounts: priorFacts?.resumeBranchCounts ?? {},
              },
              ports.clock.now(),
            ),
          );
          await this.setStatus(runId, "CANCELLED");
          return { terminal, outcome };
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
      /** 阶段 2 的测量装置：本次 resume 各分支命中次数，累加到历史值上。 */
      const branchCounts: Record<string, number> = { ...(priorFacts?.resumeBranchCounts ?? {}) };

      /**
       * 决 6：执行前指纹的索引。分支二的**真正判据**在这里，不在工具声明里。
       */
      const preFingerprints = readActionPreFingerprints(entries);

      for (const u of unpaired) {
        const def = registry.get(u.toolName)?.definition;
        const pre = preFingerprints.get(u.toolCallId);
        /**
         * ── §18.2 三条分支的判定（决 6 之后）────────────────────────────
         *
         * 变的是第三行。阶段 1 用 `def.verification.mode !== "NONE"`，
         * 那问的是「**执行后**能不能验」，被拿来回答「**崩溃后**能不能观察」。
         * 两者真的不同：`append_log` 执行后验不了（不知道该有几行），
         * 但崩溃后能不能观察，取决于**这次执行前有没有留下指纹**。
         *
         * 现在的判据是 Action 级事实（`ACTION_FACT` 里有没有这条 toolCallId
         * 的前置指纹）＋ Verifier 有没有 `observePost` 能力。于是：
         *
         *   · 同一个工具，拍了指纹 → 分支二；没拍 → 分支三；
         *   · 「拍不拍」由 Runtime 侧的 Verifier 决定，故障注入可以逐次控制。
         *
         * 这就是决 6 要的：把分流的旋钮从被测对象身上挪到测量装置这边。
         * 在此之前，阶段 2 的研究问题（有多少次 resume 落进第三条分支）
         * 是拿被测对象身上的一个静态字段去测它自己。
         */
        const canObserve =
          !!def?.recoveryObservation &&
          typeof ports.verification.observePost === "function" &&
          (!def.recoveryObservation.requiresPreFingerprint || pre !== undefined);

        const branch: ResumeBranch = !def
          ? "UNKNOWN_TOOL"
          : def.idempotency.isReadOnly || def.idempotency.isIdempotent
            ? "IDEMPOTENT_RETRY"
            : canObserve
              ? "OBSERVE_FIRST"
              : "RECOVERY_REQUIRED";

        branchCounts[branch] = (branchCounts[branch] ?? 0) + 1;
        yield await emit("ResumeUnpairedToolUse", {
          toolCallId: u.toolCallId,
          toolName: u.toolName,
          branch,
          // 把「为什么是这条分支」一并写进 Trace：光有分支名，
          // 事后分不清是工具本来就不可观察，还是这次没拍到指纹。
          hasPreFingerprint: pre !== undefined,
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
            timezone: spec.agentSpec.timezone,
            recordActionFact: async (fact) => {
              lastSequence = await ports.transcript.append(makeActionFactEntry(runId, fact));
            },
            ids: ports.ids,
            now: () => ports.clock.now(),
            signal: interrupts.signal,
            workspaceRoot: this.deps.workspaceRoot,
            hasUntrustedContext: hasUntrusted,
            // 【定】恢复路径也要外置。少了这两行，分支一重跑一个
            // `read_file` 会把几百 KB 原样灌进恢复后的第一帧 ——
            // 而恢复恰恰是上下文最紧张的时候（历史全都还在）。
            blobs: ports.blobs,
            inlineResultLimitTokens: spec.agentSpec.contextPolicy.inlineToolResultLimitTokens,
            artifacts: ports.artifacts,
            artifactChecks: ports.artifactChecks,
          });
          let br = await batchGen.next();
          while (!br.done) {
            // 与 emit() 同一个分配器 —— executeBatch 带的是占位号 0（D-2）。
            lastSequence = await ports.transcript.nextSequence(runId, lastSequence);
            const withSeq = { ...br.value, sequence: lastSequence } as RunEvent;
            ports.trace.emit(withSeq);
            // 分支一重跑 request_handoff 时又会进入等待 —— 状态要跟着走，
            // 否则「resume 之后再崩一次」会退回到那个未定义的窗口。
            await this.trackWaitStatus(runId, withSeq);
            yield withSeq;
            br = await batchGen.next();
          }
          verifications.push(...br.value.verifications);
          recoveryItems.push(...br.value.recoveryItems);
          artifactChecks.push(...br.value.artifactChecks);
          // executeBatch 保证 results 恰好一条，且 toolCallId 与请求一致（不变量 8）。
          await appendAndPush(br.value.results, turn);
          continue;
        }

        // ── 分支二：有 Observation → 先观察外部世界，据结果决定
        if (branch === "OBSERVE_FIRST" && def) {
          const observed = await this.observe(runId, def, u, interrupts.signal, spec.agentSpec.timezone, pre?.fingerprint);
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
        resumeBranchCounts: branchCounts,
        turnCount: priorFacts?.turnCount ?? turn,
        consecutiveFailures: priorFacts?.consecutiveFailures ?? 0,
        budgetUsage: priorFacts?.budgetUsage ?? emptyBudget(ports.clock.now()),
        verifications,
        recoveryItems,
        artifactChecks,
        // 交给 runLoop 接着用的高水位。少了它，runLoop 里的 emit 会从
        // resumeFrom.lastSequence ?? 0 起算，恢复段的事件号又回到 1（D-2）。
        lastSequence,
      };

      if (blocked) {
        /**
         * 【定】RECOVERY_REQUIRED 必须真的停住。
         *
         * 副作用状态未知时继续调模型 = 让模型在一个它以为已知、实际未知的世界里
         * 做下一步决策，而后续操作可能依赖那个未确认的外部状态。
         * 不变量 10（未知副作用不得自动重试）在消息级恢复下的落点就是这里。
         *
         * ── 这里**故意不发** `LoopTerminated`（U-4 的边界）─────────────
         *
         * `RECOVERY_REQUIRED` 是 V05 §10.4 明确的**非终态** —— Run 没有结束，
         * 所以 `StartResult.outcome` 是 undefined，也没有 outcome 可以塞进
         * `LoopTerminated` 的载荷。发一条「已终止」会在 Trace 上制造一个
         * 与生命周期相反的事实：下一次带决策 resume 还会继续往下跑。
         *
         * 这条路径在 Trace 上由 `RecoveryRequired` 表达，它已经带了 items 数。
         * 【定】不要因为「看起来和 ABORT 那条对称」就把这里也补上。
         */
        yield await emit("RecoveryRequired", { items: recoveryItems.length });
        await ports.transcript.append(makeRunFactsEntry(runId, facts, ports.clock.now()));
        await this.setStatus(runId, "RECOVERY_REQUIRED");
        return { terminal: { reason: "RECOVERY_REQUIRED", recoveryItems } };
      }

      await this.setStatus(runId, "RUNNING");

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
        await this.trackWaitStatus(runId, r.value);
        yield r.value;
        r = await gen.next();
      }
      await this.setStatus(runId, terminalToStatus(r.value.terminal));
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
    timezone: string,
    /** 执行前的指纹（决 6）。相对操作（如 append）没有它就判不出发生没发生。 */
    preFingerprint?: unknown,
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
        timezone,
      };
      /**
       * 决 6：优先走 `observePost` —— 它和执行前那次 `observePre` 是**同一个
       * 实现**，比的是同一个量。回退到 `verify()` 只是为了兼容没有实现
       * observePost 的 Verifier，那条路径下比的是「内容 == 计划内容」，
       * 对 append 这类相对操作给不出结论。
       */
      const post = this.deps.ports.verification.observePost;
      if (post && def.recoveryObservation) {
        /**
         * `preFingerprint` 可以是 undefined —— 对 `requiresPreFingerprint: false`
         * 的工具（覆盖写）而言，「目标内容 == 计划内容」是**绝对**判据，
         * 不需要起始状态。要不要前置指纹由 Verifier 自己判断，
         * Runtime 只负责把有的东西递过去。
         */
        const r = await post.call(
          this.deps.ports.verification,
          action,
          ctx,
          preFingerprint as never,
        );
        if (r) {
          return {
            verification: {
              id: `ver_${actionId}`,
              actionId,
              at: now,
              mode: "REOBSERVE",
              /**
               * 【定】`required: false`。
               *
               * 这一条不是「这个 Action 的验证」，是「崩溃后对外部世界的一次
               * 观察」—— 决 6 要拆开的正是这两者。标成 required 的话，
               * 一次「观察到没发生」会作为失败的 required Verification 永久
               * 留在事实表里，即便模型随后补做成功也翻不了案，Run 会被判成
               * COMPLETED_WITH_LIMITS。批 1 的 verify:persistence 实测到过
               * 这个现象（两份产物都正确落盘，outcome 却是有限完成）。
               */
              required: false,
              status: r.applied ? "PASSED" : "FAILED",
              detail: r.detail,
            },
          };
        }
      }

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
    this.interruptsByRun
      .get(String(runId))
      ?.interjections.push(
        { content, intent: "ADD_CONTEXT", urgency: "NEXT_SAFE_POINT" },
        this.deps.ports.clock.now(),
      );
  }

  cancel(runId: RunId, reason?: string): void {
    this.interruptsByRun.get(String(runId))?.cancel(reason);
  }

  /**
   * 只读投影（M-1）。**不是恢复来源** —— 恢复走 transcript。
   *
   * 阶段 1 这里返回的 turnCount / budgetUsage / messageCount 全是硬编码 0，
   * 也就是「只读投影」返回假数据。A-7 之后 transcript 的 `RUN_META` 里
   * 已经有真实的累计事实可读，跨进程之后它更是「看一眼这个 Run 现在
   * 怎么样了」的唯一入口，所以这次读真的。
   *
   * 改成 async 是必然的：事实在库里。没有外部调用者依赖它的同步性。
   */
  async inspect(runId: RunId): Promise<RunSnapshot | undefined> {
    const ports = this.deps.ports;
    const spec = await ports.runs.getRunSpec(runId);
    if (!spec) return undefined;

    const entries = await ports.transcript.readAll(runId);
    const facts = readRunFacts(entries);
    const messages = await ports.transcript.rebuildMessages(runId);

    return {
      runId,
      runSpecId: spec.id,
      status: (await ports.runs.getStatus(runId)) ?? "CREATED",
      turnCount: facts?.turnCount ?? 0,
      consecutiveFailures: facts?.consecutiveFailures ?? 0,
      // 没有 RUN_META（Run 刚建、一轮都没跑完）时如实回落到空预算，
      // 但 startedAt 用 spec 的创建时刻 —— 那个是真的。
      budgetUsage: facts?.budgetUsage ?? emptyBudget(spec.createdAt),
      messageCount: messages.length,
      updatedAt: ports.clock.now(),
      // 阶段 2 测量装置的对外出口（P1-2）。见 RunSnapshot 上的注释。
      resumeBranchCounts: { ...(facts?.resumeBranchCounts ?? {}) },
      unmetCauseCounts: tallyUnmetCauses(facts?.verifications ?? []),
    };
  }

  /** 供 CLI 的 `--list-runs`。 */
  async list(limit?: number): Promise<RunListItem[]> {
    return this.deps.ports.runs.list(limit);
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

/**
 * 未达成的**必需**项按成因聚合。
 *
 * 只数 `required && status !== "PASSED"` —— 与 `settle-outcome.ts` 判
 * `COMPLETED_WITH_LIMITS` / `USER_REJECTED` 用的是同一个筛子，
 * 两处口径必须一致，否则报告里的数字和 outcome 会互相打架。
 *
 * 没写 `unmetCause` 的记成 `UNSPECIFIED`，不悄悄丢掉：一条「没做成但说不出
 * 为什么」的记录本身就是要暴露的东西（P3-9 记的三种口径不统一就是这么来的）。
 */
function tallyUnmetCauses(verifications: VerificationResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of verifications) {
    if (!v.required || v.status === "PASSED") continue;
    const key = v.unmetCause ?? "UNSPECIFIED";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
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
