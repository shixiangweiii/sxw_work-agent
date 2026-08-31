/**
 * Runtime Host（V05 §6.6）—— Layer 2 里唯一碰 Runtime 的地方。
 *
 * 职责（§6.6 原文）：创建并配置 Harness Runtime；从 Endpoint Registry 创建 RunSpec；
 * `resume()` 未结束的 Run；把用户输入、插话、Approval 决策、Cancel、
 * Interaction Completion、Recovery Decision 路由到对应的等待或 Interject 队列；
 * 消费 RunEvent 流并投影；监督 AbortController 传播。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它**不推进执行语义**（决 6，边界 grep 第 9 条）。
 *
 * 具体形态：界面上看到一个 Run 状态是 `RUNNING` 而进程里没有循环在跑它
 * （上次崩了），最自然的「修复」是在这里补一句
 * `ports.runs.setStatus(runId, "FAILED")`。**那一行会让 Layer 2 成为
 * 第二个状态推进者**，而 §23.1 的裁决规则（执行语义以 Runtime 事件为准）
 * 从此不成立 —— 且盘上看不出来。
 *
 * 正确的处置在 `UiRunListItem.liveInThisProcess`：**如实显示两个事实**
 * （盘上的状态是 RUNNING、本进程里没人在跑），让人自己得出「上次崩了」。
 * 投影不修正事实，它转述事实。
 * ══════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  asId,
  readBudgetAxes,
  readRunFacts,
  ToolRegistry,
  type RecoveryItem,
  type RunEvent,
  type RunId,
  type RunOutcome,
  type RunSnapshot,
  type RunSpec,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import { isInsideWorkspace } from "@workagent/tools-common";
import {
  autoGrantVerdict,
  compose,
  DEFAULT_TOOLS,
  gitProvenance,
  hostOf,
  REPO_ROOT,
  type Composed,
  type ComposeOptions,
  type EndpointChoice,
} from "../../cli/src/compose.js";
import { FileTraceSink } from "../../cli/src/trace/file-sink.js";
import type {
  UiArtifactRecord,
  UiPending,
  UiRunDetail,
  UiRunListItem,
  UiServiceInfo,
} from "./api-types.js";
import { PendingHub, type PendingAnswer } from "./human-channels.js";
import { projectTimeline, projectTurns } from "./projection.js";

export interface RunHostOptions {
  workspaceRoot: string;
  dbPath: string;
  endpoint: EndpointChoice;
  /** trace JSONL 的目录。与 CLI 同一个约定（`.workagent-runs/<runId>.jsonl`）。 */
  traceDir: string;
  /** 验收脚本用：注入脚本化 ModelPort、子集工具、固定时区等。 */
  composeOverrides?: Pick<
    ComposeOptions,
    "modelPortOverride" | "profileOverride" | "tools" | "timezone" | "contextPolicy"
  >;
}

interface LiveRun {
  runId: string;
  /** 逐 Run 的取消源。审批等待挂在它上面（见 human-channels 的 signalFor）。 */
  aborter: AbortController;
  /** 本段的事件缓冲，供 SSE 重连按 `since` 续拉。 */
  events: RunEvent[];
  outcome?: RunOutcome;
  /** 【定】只装 `terminal.reason` 这个字符串，名字跟着实际内容走。 */
  terminalReason?: string;
  /**
   * 「**本进程里**这一段执行还在跑吗」——**正向**布尔：跑着为 `true`。
   *
   * ══════════════════════════════════════════════════════════════════
   * 【定】名字与极性必须一起改。
   *
   * 它此前叫 `done`（完成为 true）。2026-08-31 的清理把名字换成
   * `segmentActive` 却**没有翻转极性** —— 六处读写里五处仍是
   * 「false ＝ 在跑」，只有 `aborterFor()` 那一处被翻了，于是字段
   * 内部自相矛盾：谁按名字去「修正」另外五处，逻辑会部分反转。
   *
   * 那次改名当时没造成行为错误（可达路径恰好对上），也**没有任何判据
   * 会响** —— 极性是内部约定，而当时的两条 live 判据都只验 `false`。
   * 配对判据（跑动中必须 `true`）随本次一并补上。
   *
   * 与「Run 完成了吗」是两个事实：历史 Run 在盘上可能正是 `RUNNING`，
   * 而这里没人在跑它。界面要把它们**分开**显示（见 `liveInThisProcess`）。
   * ══════════════════════════════════════════════════════════════════
   */
  segmentActive: boolean;
  error?: string;
  /**
   * 后台消费 generator 的那个 Promise。
   *
   * 【定】必须存下来，`close()` 要 await 它（评审 codex P1-6）。
   * 不存的话，Ctrl+C 的顺序是「cancel → 立刻 db.close()」，而 Runtime 侧
   * 被 abort 唤醒的那条链还在微任务队列里 —— 它随后要写 transcript 与终态，
   * 撞上一个已经关掉的 SQLite。「Ctrl+C 优雅取消」这句话因此是假的：
   * 留下的可能是 RUNNING 状态与未落盘的配对补齐。
   */
  pump?: Promise<void>;
  /** 本段的 trace sink（写 header / event / footer 三种行，与 CLI 同一个契约）。 */
  sink?: FileTraceSink;
  /**
   * 停在 `RECOVERY_REQUIRED` 时那些状态未知的副作用。
   *
   * 【定】它不在 `outcome` 里 —— 那个状态是**非终态**，按定义没有 outcome。
   * 见 `settleRecord()` 的说明。
   */
  recoveryItems?: RecoveryItem[];
}

/** `start()` / `resume()` 的返回形状。`recoveryItems` 只在非终态那条路径上有。 */
interface DriveResult {
  terminal: { reason: string; recoveryItems?: RecoveryItem[] };
  outcome?: RunOutcome;
}

/** start 还不知道 runId 时先占的哨兵。见 `claimForeground()`。 */
const STARTING = "\u0000starting";

type EventListener = (e: RunEvent) => void;

export class RunHost {
  private readonly composed: Composed;
  private readonly pendingHub = new PendingHub();
  private readonly runs = new Map<string, LiveRun>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  /** runId → 任务原文，供 trace header 用（RunSpec 在库里，但 header 要同步写）。 */
  private readonly taskCache = new Map<string, string>();
  /**
   * 「已开始、还不知道 runId」那个窗口里的任务原文。见 `startRun` 的说明。
   * 单槽的前提是前台槽位保证同时只有一个 Run 处在这个窗口里。
   */
  private pendingTask: string | undefined;
  /**
   * 【定】同时只跑一个 Run（§6.4「v0.1 一个 Session 同时只允许一个
   * Foreground Active Run」，D-09）。
   *
   * 不是偷懒：`HandoffChannel` / `QuestionChannel` 的请求**不带 runId**，
   * 两个 Run 并发时一个接管请求会被挂到错误的 Run 上，而界面上完全看不出来。
   * 要放开这条，得先给那两个接口加 runId —— 那是 Runtime 侧的接口变更，
   * 需要一个真实的并发场景来支撑，本批没有。
   *
   * 【定】名字是 **holder** 不是 runId：它也可能装 `STARTING` 哨兵
   * （start 已经占位、runId 还没从第一个事件里出来的那个窗口）。
   */
  private foregroundHolder = "";

  constructor(private readonly opts: RunHostOptions) {
    this.composed = compose({
      workspaceRoot: opts.workspaceRoot,
      dbPath: opts.dbPath,
      endpoint: opts.endpoint,
      // 【定】三条通道全部走浏览器，用的是与 CLI 同一批注入点（决 4）。
      approvalDecider: this.pendingHub.approvalDecider(
        (a) => autoGrantVerdict(a, opts.workspaceRoot),
        (runId) => this.aborterFor(runId).signal,
      ),
      handoff: this.pendingHub.handoffChannel(() => this.foregroundHolder),
      question: this.pendingHub.questionChannel(() => this.foregroundHolder),
      /**
       * 【定】Trace 仍然落盘，Web 入口不例外。
       *
       * 事件缓冲是**进程内**的，进程一关就没了；而「这个 Run 当时发生了什么」
       * 必须留得下来 —— 界面上看历史 Run 的事件流，读的就是这些文件
       * （见 `loadTraceEvents`）。CLI 那边默认开着 trace 的理由原样适用：
       * 忘记开的那次恰恰是最想回看的那次。
       */
      trace: {
        emit: (e: RunEvent) => this.onEvent(e),
      },
      ...(opts.composeOverrides ?? {}),
    });
  }

  // ──────────────────────────────────────────────────────────── 只读

  info(): UiServiceInfo {
    const tools = this.opts.composeOverrides?.tools ?? DEFAULT_TOOLS;
    return {
      workspaceRoot: this.opts.workspaceRoot,
      dbPath: this.opts.dbPath,
      endpoint: this.opts.endpoint,
      // 【定】只取 host。完整 URL 的路径里有时带部署标识，而这一行会被贴进报告。
      // key 一个字都不出现（§22.3，判据在 verify:ui E 段）。
      endpointHost: hostOf(this.composed.endpointBaseUrl),
      profileId: String(this.composed.profile.id),
      modelId: this.composed.profile.modelId,
      approvalMode:
        "workspace 内的写自动放行；IRREVERSIBLE（追加/删除）与 EXECUTE 停下来问；越界写直接拒绝",
      toolNames: tools.map((t) => t.definition.name),
      // 【定】调 `ToolRegistry` 的那一份，**不抄公式**。
      // 这里此前写着 `tools.length * 180`，而 §16.1 那个系数的权威副本在
      // `fixedOverheadTokens()` 里 —— 改实现时这一处不会跟着变，
      // 而界面上那个「起步价」是给人读的过拟合警报。
      fixedOverheadTokens: new ToolRegistry(tools).fixedOverheadTokens(),
      notices: this.composed.notices,
      traceDir: this.opts.traceDir,
    };
  }

  async listRuns(limit = 50): Promise<UiRunListItem[]> {
    const rows = await this.composed.runtime.list(limit);
    return rows.map((r) => ({
      runId: String(r.runId),
      status: r.status,
      task: r.task,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      liveInThisProcess: this.isLive(String(r.runId)),
    }));
  }

  pending(runId?: string): UiPending[] {
    return this.pendingHub.list(runId);
  }

  answerPending(pendingId: string, answer: PendingAnswer): boolean {
    return this.pendingHub.answer(pendingId, answer);
  }

  onPendingChange(fn: () => void): () => void {
    return this.pendingHub.onChange(fn);
  }

  /**
   * 一个 Run 的完整白盒视图。
   *
   * 事件的来源有两个，**并集**：盘上的 trace（历史的全部段）∪ 本进程缓冲
   * （这一段正在发生的、可能还没 flush 的）。按 `sequence` 去重 ——
   * D-2 的全局单调序列保证这件事是安全的。
   *
   * 【定】这里原本是**二选一**（`live.events.length ? live.events : trace`），
   * 而注释写的却是「trace 是历史的全部段」。后果（三份评审各自指出）：
   * CLI 跑了一段崩了 → 界面上 resume → `detail()` 只用本进程缓冲，
   * **前一段的审批、帧构成、usage、产物事件全部从时间线与逐轮解剖里消失**，
   * 前几轮看起来像是 `--no-trace` 跑的。而「一个 Run 跨进程仍可完整审计」
   * 正是 N-1 修完之后明确要支持的场景 —— 当时只在**文件**里接上了，
   * **投影**里没有。
   *
   * 两者都没有（`--no-trace` 跑的 Run）时事件轨道为空 —— 界面会显示
   * 「事件 0 条」，那是**如实降级**：时间线还在（transcript 有），
   * 但每轮的帧构成、usage、审批决策都看不到。不要靠推算把它们补出来（不得绕过 #6）。
   */
  async detail(runId: string): Promise<UiRunDetail | undefined> {
    const id = asId<RunId>(runId);
    const spec = await this.composed.ports.runs.getRunSpec(id);
    if (!spec) return undefined;

    const snapshot = await this.composed.runtime.inspect(id);
    if (!snapshot) return undefined;

    const entries = await this.composed.ports.transcript.readAll(id);
    const live = this.runs.get(runId);
    const traceFile = this.traceFileFor(runId);
    const events = this.eventsFor(runId);
    const artifacts = await this.composed.ports.artifacts.listByRun(id);

    const input = { entries, events };
    const timeline = projectTimeline(input);
    const turns = projectTurns(input);

    /**
     * 【定】用 `snapshot.status`，**不再第二次查库、也不发明默认值**。
     *
     * 这里此前是 `getStatus(id) ?? "CREATED"` —— 而 `"CREATED"` 已经不在
     * `RunStatus` 的值域里（`createRun()` 一律以 RUNNING 落库，没有第二个起点）。
     * 它躲过了 typecheck 是因为 `UiRunDetail.status` 放宽成了 `string`：
     * 局部联合 widen 之后没有任何东西校验它。
     *
     * 更要紧的是它会**掩盖库不一致**：spec 行在而状态行不在，是一个要说出来
     * 的事实，不是一个可以用默认值糊过去的缺省。`inspect()` 那边已经为此抛了。
     */
    const status = snapshot.status;
    const outcome = live?.outcome ?? loadTraceOutcome(traceFile);
    /**
     * 【定】`RECOVERY_REQUIRED` 的项优先从 **transcript 的 RUN_META** 读。
     *
     * facade 在停住之前把 `recoveryItems` 落进了 RUN_META（`makeRunFactsEntry`），
     * 那是**跨进程仍然在**的权威副本；内存里的 `record.recoveryItems` 只是
     * 本段的镜像。先读盘、再回落内存，于是「服务重启后打开这个 Run」
     * 也能看见要确认哪几件事。
     */
    const facts = readRunFacts(entries);
    const recoveryItems: RecoveryItem[] =
      status === "RECOVERY_REQUIRED"
        ? (facts?.recoveryItems ?? live?.recoveryItems ?? [])
        : (outcome?.recoveryItems ?? live?.recoveryItems ?? []);

    const cursor = Math.max(
      0,
      ...entries.map((e) => e.sequence),
      ...events.map((e) => e.sequence),
    );

    /**
     * 【定】终态 Run 的墙钟要**冻住**，不能每刷新一次涨一点。
     *
     * `totalWallClockMs` 的读数是 `now - startedAt`，而 `now` 原本传的是
     * `clock.now()` —— 于是一个三天前跑完的 Run，今天打开会显示「总墙钟 3 天」，
     * 甚至在结束之后才越过预算墙。它不再是任何时点的事实。
     * 冻结点取**最后一条事实的时刻**（事件或 transcript 条目），那是真的。
     */
    const terminal = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
    const lastFactAt = Math.max(
      spec.createdAt,
      ...events.map((e) => e.occurredAt),
      ...entries.map((e) => e.createdAt),
    );
    const budgetNow = terminal ? lastFactAt : this.composed.ports.clock.now();

    return {
      runId,
      status,
      task: spec.input.task,
      liveInThisProcess: this.isLive(runId),
      /**
       * 【定】原样来自 `inspect()`，一个数都不重算（不得绕过 #6）。
       * 判据在 `verify:ui` C 段：这里的 budgetUsage 与 `inspect()` 逐字一致。
       */
      snapshot: {
        turnCount: snapshot.turnCount,
        consecutiveFailures: snapshot.consecutiveFailures,
        messageCount: snapshot.messageCount,
        budgetUsage: snapshot.budgetUsage,
        resumeBranchCounts: snapshot.resumeBranchCounts,
        unmetCauseCounts: snapshot.unmetCauseCounts,
      },
      // 【定】八条轴走 Runtime 的 readBudgetAxes —— 与 checkBudgets 同一张表。
      // 自己拼会把 inputTokens 拼成 usage.inputTokens（该读 billed），
      // 而那个错误不会有任何征兆。见那个函数的注释。
      budgetAxes: readBudgetAxes({
        usage: snapshot.budgetUsage,
        consecutiveFailures: snapshot.consecutiveFailures,
        budgets: spec.budgets,
        // 终态 Run 冻在最后一条事实的时刻，见上面 budgetNow 的说明。
        now: budgetNow,
      }),
      spec: {
        runSpecId: String(spec.id),
        /**
         * 【定】把 `origin` 送到界面上，是为了给它**第一个消费者**。
         *
         * 它此前有一个生产者（`makeRunSpec` 写死 `CLI`）、零消费者 ——
         * 于是 Web 起的 Run 自称 CLI 这件事整整一个阶段没有任何东西能与它矛盾。
         * 补一个枚举值容易，让它不再退回常量靠的是「有人读」＋ `verify:ui` 的判据。
         */
        origin: spec.origin.kind,
        endpointId: String(spec.agentSpec.model.endpointId),
        modelId: spec.agentSpec.model.modelId,
        endpointProfileRef: spec.agentSpec.model.endpointProfileRef,
        timezone: spec.agentSpec.timezone,
        toolCount: spec.agentSpec.toolSnapshots.length,
        createdAt: spec.createdAt,
        systemPrompt: spec.agentSpec.systemPrompt,
        approvalPolicy: {
          requiresApprovalFor: [...spec.agentSpec.approvalPolicy.requiresApprovalFor],
          ...(spec.agentSpec.approvalPolicy.approvalTimeoutMs !== undefined
            ? { approvalTimeoutMs: spec.agentSpec.approvalPolicy.approvalTimeoutMs }
            : {}),
        },
      },
      timeline,
      turns,
      artifacts: artifacts.map(toUiArtifact),
      recovery: {
        items: recoveryItems.map((i) => ({
          what: i.what,
          sideEffectState: i.sideEffectState,
        })),
        branchCounts: snapshot.resumeBranchCounts,
      },
      ...(outcome
        ? {
            outcome: {
              kind: outcome.kind,
              ...(outcome.summary ? { summary: outcome.summary } : {}),
              incompleteItems: outcome.incompleteItems.map((i) => ({ what: i.what, why: i.why })),
              recoveryItems: outcome.recoveryItems.map((i) => ({
                what: i.what,
                sideEffectState: i.sideEffectState,
              })),
              // 【定】原样转述 Runtime 的判定，不在这里重算（决 5 / 边界 9）。
              // 它与 `artifacts`（登记过的全部产物）是两件事，见 api-types 的说明。
              deliveredArtifactIds: [...outcome.deliveredArtifactIds],
            },
          }
        : {}),
      tracks: {
        transcriptEntries: entries.length,
        events: events.length,
        ...(existsSync(traceFile) ? { traceFile } : {}),
      },
      /**
       * 【定】`resume()` 抛出的错误原文，原样带给界面。
       *
       * 端点不一致、终态 Run、缺恢复决策 —— 这些都是 Runtime 的判定，
       * 而它们发生在 HTTP 响应**之后**（Run 在后台跑），所以那次 POST 的
       * 200 里没有它。少了这个字段，用户在界面上点 resume 会看到
       * 「什么都没发生」，而错误只存在于一个没人读的内存字段里 ——
       * 那正是本仓「未接线比不写更糟」说的形态。
       */
      ...(live?.error ? { serviceError: live.error } : {}),
      cursor,
    };
  }

  /**
   * 两个只读出口，供验收脚本核对投影用。
   *
   * 【定】它们走的是**同一个 Port**，不另开一个 SQLite 句柄。
   * 验收脚本自己去读库的话，就变成「用另一条路径读到的数据去验这条路径」——
   * 两边不一致时分不清是投影错了还是读法不同。§24.1 对 Eval 的要求
   * （只经 Facade、不碰 Runtime 私有类）在这里同样适用。
   */
  transcriptEntries(runId: string): Promise<TranscriptEntry[]> {
    return this.composed.ports.transcript.readAll(asId<RunId>(runId));
  }

  inspectFor(runId: string): Promise<RunSnapshot | undefined> {
    return this.composed.runtime.inspect(asId<RunId>(runId));
  }

  /** 原始 trace 行（Trace Inspector）。读不到就返回空 —— 不是错误。 */
  traceLines(runId: string): unknown[] {
    const path = this.traceFileFor(runId);
    if (!existsSync(path)) return [];
    return readJsonl(path);
  }

  /**
   * 产物预览。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】它读的是**一条登记过的 Artifact**，不是「workspace 里的任意路径」。
   *
   * 原实现收 `?path=` 任意相对路径、只做词法前缀判定、直接 readFileSync。
   * 三份评审都点了它，我实测确认了两条：
   *
   *   · 任何 workspace 内文件都能读，**不需要是登记过的产物**；
   *   · workspace 里一个指向外部的 symlink（`link.txt → 仓库根/.env`）
   *     能把 **592 字节含 `dashscope_api_key` 的真实凭证**送进浏览器。
   *
   * 后者直接推翻了本阶段自己写的退出门槛「凭证不出现在任何 API 响应体」——
   * 而 E 段只扫了 state / detail / trace 三个响应，**恰恰漏掉了唯一一个
   * 直接返回文件正文的接口**。它还绕过了 ADR-0006 的读黑名单
   * （那条护栏的全部意义就是 `.env` 读不到）。
   *
   * 三道判定，缺一不可：
   *   ① 必须能在 ArtifactStore 里查到这条记录，且它属于这个 Run；
   *   ② 路径取**登记时的那一份**（`record.path`），不听调用方的；
   *   ③ `isInsideWorkspace` 的 **realpath** 判定 —— 词法前缀挡不住 symlink，
   *      而全仓写路径一直是两道（`fs-common.ts` 注释：两道都不能省）。
   * ══════════════════════════════════════════════════════════════════════
   */
  async artifactPreview(
    runId: string,
    artifactId: string,
  ): Promise<
    | { ok: true; content: string; sizeBytes: number; truncated: boolean; diskHash: string; hashMatchesRegistration: boolean }
    | { ok: false; why: string }
  > {
    const record = await this.composed.ports.artifacts.get(artifactId);
    if (!record) return { ok: false, why: "没有这条产物登记" };
    if (String(record.runId) !== runId) {
      return { ok: false, why: "这条产物不属于该 Run" };
    }
    if (!record.path) return { ok: false, why: "这条产物没有落盘路径（不是文件型产物）" };

    const target = resolve(this.opts.workspaceRoot, record.path);
    // 【定】realpath 判定。词法前缀对 symlink 是盲的 —— 实测放出去过真凭证。
    if (!isInsideWorkspace(this.opts.workspaceRoot, target)) {
      return { ok: false, why: "登记路径解析后不在 workspace 内（symlink？）—— 拒绝读取" };
    }
    if (!existsSync(target)) return { ok: false, why: "登记过，但磁盘上已经不在了" };

    const MAX = 512 * 1024;
    const raw = readFileSync(target);
    const sizeBytes = statSync(target).size;
    /**
     * 【定】重算磁盘 hash 并与登记值比对。
     *
     * 详情页展示的是**登记时**的 `contentHash` 与 `verified`，而预览读的是
     * **此刻**的字节。产物被后续工具或另一个 Run 改过之后，界面会同时显示
     * 旧 hash ＋「已验证」＋ 新内容 —— 那正是阶段 4 明确要回答的
     * 「hash 与磁盘上那一份对不对得上」（`ArtifactCheckerPort` 的【定】），
     * 而界面此前无法回答它。
     */
    const diskHash = createHash("sha256").update(raw).digest("hex");
    return {
      ok: true,
      content: raw.toString("utf8").slice(0, MAX),
      sizeBytes,
      truncated: sizeBytes > MAX,
      diskHash,
      hashMatchesRegistration: diskHash === record.contentHash,
    };
  }

  /**
   * 两条轨道里的事件：**盘上 trace ∪ 本进程缓冲**，按 sequence 去重。
   *
   * 【定】去重靠 D-2 的全局单调序列。同一条事件在两处出现是正常的
   * （当前段既进缓冲也落盘），它们是同一条 —— 取先见到的那一份即可。
   */
  private eventsFor(runId: string): RunEvent[] {
    const merged = new Map<number, RunEvent>();
    for (const e of loadTraceEvents(this.traceFileFor(runId))) merged.set(e.sequence, e);
    for (const e of this.runs.get(runId)?.events ?? []) merged.set(e.sequence, e);
    return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
  }

  // ────────────────────────────────────────────────────────── 生命周期

  /**
   * 起一个 Run。返回 runId —— 它由 Facade 生成，第一个事件才带出来，
   * 所以这里必须等到第一个事件（通常是 `RunStarted`）。
   */
  async startRun(task: string): Promise<{ runId: string }> {
    // 【定】同步占位再 await —— 见 claimForeground 的 TOCTOU 说明。
    this.claimForeground(STARTING);
    /**
     * ══════════════════════════════════════════════════════════════════
     * 【定】task 必须在**第一个事件之前**登记，否则 trace header 写的是「(未知)」。
     *
     * 原来 `taskCache.set()` 排在 `await this.drive(gen)` **之后**，而
     * header 是第一个事件到达时由 `sinkFor()` 生成的 —— 那时 drive 还没返回。
     * 于是纯 Web 起跑的 Run，JSONL 第一行永远是 `task:"(未知)"`，而下一行
     * `RunStarted` 与 SQLite 里都有正确任务：**同一个文件里前后矛盾**。
     *
     * 但 runId 要等第一个事件才知道，所以这里只能先挂在一个「在途」槽位上。
     * 它不需要是 Map —— 前台槽位（`claimForeground`）保证同时只有一个 Run
     * 处在「已开始、还不知道 runId」的窗口里。**这条不变量成立才允许用单槽**，
     * 将来放开并发（S4-4）时这里要跟着改成按某个请求级 key 索引。
     * ══════════════════════════════════════════════════════════════════
     */
    this.pendingTask = task;
    try {
      // 【定】入口身份从这里传进去。此前 makeRunSpec 写死 CLI，
      // 于是 Web 起的 Run 在 RunSpec 里自称 CLI，而 trace header 写着 web。
      const spec: RunSpec = this.composed.makeRunSpec(task, "WEB");
      const gen = this.composed.runtime.start(spec);
      const r = await this.drive(gen);
      this.taskCache.set(r.runId, task);
      return r;
    } catch (err) {
      this.releaseForeground(STARTING);
      throw err;
    } finally {
      // 认领完就清 —— 留着它会让下一个 Run 在 runId 未知的窗口里读到上一个的任务。
      this.pendingTask = undefined;
    }
  }

  async resumeRun(
    runId: string,
    recoveryDecision?: "CONTINUE" | "ABORT",
    recoveryNote?: string,
  ): Promise<{ runId: string }> {
    this.claimForeground(runId);
    const spec = await this.composed.ports.runs.getRunSpec(asId<RunId>(runId));
    if (spec) this.taskCache.set(runId, spec.input.task);
    const gen = this.composed.runtime.resume(asId<RunId>(runId), {
      ...(recoveryDecision ? { recoveryDecision } : {}),
      ...(recoveryNote ? { recoveryNote } : {}),
    });
    return this.drive(gen, runId);
  }

  cancel(runId: string, reason = "用户在界面上取消"): void {
    this.composed.runtime.cancel(asId<RunId>(runId), reason);
    /**
     * 【定】同时 abort 逐 Run 的等待源。少了这一步，一个停在审批上的 Run
     * 取消之后仍然挂在那个 await 上 —— 界面显示已取消，进程里还在等人。
     *
     * 【定】**只对已存在的记录动手，不凭空创建**（评审 zcode「同根因」）。
     * 这里原本调的是 `aborterFor()`，而它查不到就**建一个「在跑」的记录**
     * —— 于是对一个本进程从未跑过的历史 Run 点一次取消，它就在界面上变成
     * 「在跑」。实测复现过：`live: false → true`。
     * 这与决 6 反向违例：投影凭空断言了一个假事实。
     */
    this.runs.get(runId)?.aborter.abort();
  }

  interject(runId: string, text: string): void {
    this.composed.runtime.interject(asId<RunId>(runId), text);
  }

  /** SSE 订阅。先补发 `since` 之后的缓冲事件，再挂上实时监听。 */
  subscribe(runId: string, since: number, fn: EventListener): () => void {
    for (const e of this.eventsSince(runId, since)) fn(e);
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  eventsSince(runId: string, since: number): RunEvent[] {
    // 与 detail() 同一条并集路径 —— 否则 SSE 重放会缺前段（见 eventsFor）。
    return this.eventsFor(runId).filter((e) => e.sequence > since);
  }

  /**
   * 关服务。
   *
   * 【定】**先取消，再等后台把终态写完，最后才关库**（评审 codex P1-6）。
   *
   * 原实现是「cancel 完立刻 `db.close()`」。等审批时尤其明确：abort 只是让那个
   * 等待的 Promise **准备**恢复，微任务还没轮到，SQLite 已经关了 —— 随后
   * Runtime 要写的配对补齐、RUN_META 与终态状态全部撞在一个关掉的库上。
   * 「Ctrl+C 会取消正在跑的 Run」这句话因此是假的：留下的可能是一个
   * RUNNING 状态 ＋ 未配对的 tool_use，而那正是阶段 2 花了整整一批去消灭的形态。
   *
   * 超时是必须的：一个卡在网络 IO 上的 Run 不该让 Ctrl+C 永远退不出去。
   * 超时发生时如实打印 —— **不假装收尾干净了**。
   */
  async close(timeoutMs = 5_000): Promise<void> {
    const pumps: Array<Promise<void>> = [];
    for (const [runId, r] of this.runs) {
      if (!r.segmentActive) continue;
      this.cancel(runId, "服务关闭");
      if (r.pump) pumps.push(r.pump);
    }
    if (pumps.length > 0) {
      const timedOut = await Promise.race([
        Promise.allSettled(pumps).then(() => false),
        new Promise<boolean>((ok) => setTimeout(() => ok(true), timeoutMs)),
      ]);
      if (timedOut) {
        console.warn(
          `⚠️  ${pumps.length} 个 Run 在 ${timeoutMs}ms 内没有收尾完，仍然关库 —— ` +
            `它们的终态可能没落盘，下次用 resume 接上（§18.2 会按未配对分支处置）。`,
        );
      }
    }
    for (const r of this.runs.values()) this.finishSegment(r);
    this.composed.db.close();
  }

  // ────────────────────────────────────────────────────────────── 内部

  /**
   * 这个 host 里有没有正在跑的 Run。
   *
   * 【定】切换 workspace 前要问它 —— 中途换根会让一个正在写文件的 Run
   * 后面的读写落到另一个目录里。见 `WorkspaceHosts.switchTo`。
   */
  hasLiveRun(): boolean {
    for (const r of this.runs.values()) if (r.segmentActive) return true;
    return false;
  }

  private isLive(runId: string): boolean {
    const r = this.runs.get(runId);
    return !!r && r.segmentActive;
  }

  /**
   * 占住前台槽位（§6.4 / D-09）。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】占位是**同步**的，不能等到第一个事件才置位。
   *
   * 原实现是 check-then-await：`currentRunId` 要等 `await gen.next()` 返回
   * 首个事件才赋值，而 `facade.start()` 在首个 yield 之前还有一次
   * `await createRun`（SQLite I/O）。两个几乎同时到达的 POST 都能通过检查，
   * 于是两个 Run 并发跑起来，后写入者覆盖 `currentRunId` ——
   * 而 `HandoffChannel` / `QuestionChannel` 的请求**不带 runId**，
   * 靠的正是这个全局值，接管请求会挂到错误的 Run 上（S4-4 的前提被架空）。
   *
   * 这是本仓反复记的「一条闸门排在另一条后面等于没有闸门」的形状：
   * 闸门在，但它检查的那个变量要到闸门后面才被设置。
   * ══════════════════════════════════════════════════════════════════════
   */
  private claimForeground(runId: string): void {
    const holder = this.currentHolder();
    if (holder) {
      throw new Error(
        `已有一个 Run 在跑（${holder}）。§6.4：同时只允许一个前台 Run。\n` +
          `等它结束，或在界面上取消它（取消后状态会变成 CANCELLED）。`,
      );
    }
    // 同步占位。resume 已知 runId 就用它；start 还不知道，先占一个哨兵，
    // 等第一个事件到达再换成真的 runId（见 drive()）。
    this.foregroundHolder = runId;
  }

  /** 谁在占前台。没人占时返回 undefined。 */
  private currentHolder(): string | undefined {
    if (!this.foregroundHolder) return undefined;
    if (this.foregroundHolder === STARTING) return STARTING;
    return this.isLive(this.foregroundHolder) ? this.foregroundHolder : undefined;
  }

  /** 让出前台槽位。**只有占着的那个 Run 能让**，避免后来者把别人的位子放掉。 */
  private releaseForeground(runId: string): void {
    if (this.foregroundHolder === runId || this.foregroundHolder === STARTING) this.foregroundHolder = "";
  }

  private aborterFor(runId: string): AbortController {
    const existing = this.runs.get(runId);
    if (existing) return existing.aborter;
    const created: LiveRun = {
      runId,
      aborter: new AbortController(),
      events: [],
      // 【定】默认 `false`（不在跑）。
      //
      // 这个分支只服务两个**查询型**调用点（审批的 signalFor、事件入口），
      // 它们拿到记录不等于「有循环在跑」。默认 true 的后果实测过：
      // 对历史 Run 点一次取消 → 它在界面上变成「在跑」，且再也回不去。
      // 真正的「在跑」只由 `beginSegment()` 置位。
      segmentActive: false,
    };
    this.runs.set(runId, created);
    return created.aborter;
  }

  /**
   * 消费事件流并扇出。
   *
   * 【定】第一个事件到达就返回，剩下的在后台跑完 —— HTTP 请求不能等一个
   * 可能跑十分钟的 Run。这不是「异步优化」：同步等的话，界面上永远看不到
   * 一个正在进行中的 Run，而白盒界面的一半价值就在过程里。
   */
  private async drive(
    gen: AsyncGenerator<RunEvent, DriveResult>,
    knownRunId?: string,
  ): Promise<{ runId: string }> {
    let runId = knownRunId ?? "";
    // resume 路径这里就知道 runId —— 必须换一个新的 AbortController（见 beginSegment）。
    let record = runId ? this.beginSegment(runId) : undefined;

    /**
     * ══════════════════════════════════════════════════════════════════
     * 【定】第一个 `gen.next()` **必须**包在 try/catch 里。
     *
     * `resume()` 的三道闸门（端点不一致 §18.3、终态 Run、缺恢复决策）
     * **全部在第一个 yield 之前 throw**。原实现只给「首个事件之后」的后台
     * 循环配了 try/finally，于是异常从这里直接穿出去，而 `beginSegment()`
     * 刚把记录置成 `segmentActive: true` —— 没有任何路径把它复位。三份评审各自
     * 独立报了这一条，我实测复现了它的完整后果：
     *
     *   · 对一个 COMPLETED 的 Run 点一次 resume（界面对所有非 live 的 Run
     *     都显示这个按钮）→ 它从此挂着「在跑」chip；
     *   · 若它恰好又是 `currentRunId`，**后续任何 start/resume 全部被
     *     单前台闸门拒掉，只能重启进程**；
     *   · 而那句错误提示还在建议「或在界面上取消它」—— 取消并不会复位
     *     这个标志位，用户照着提示做仍然是死的。
     *
     * 一个正常的误操作变成服务级不可用，这是本批最容易踩到的路径。
     * ══════════════════════════════════════════════════════════════════
     */
    let first: IteratorResult<RunEvent, DriveResult>;
    try {
      first = await gen.next();
    } catch (err) {
      const message = (err as Error).message;
      if (record) {
        record.segmentActive = false;
        // 错误原文喂给已有的 `serviceError` 字段 —— 界面下一次刷新就能看到，
        // 而不是只存在于那次 POST 的 500 响应里（决 6：如实转述，不翻译）。
        record.error = message;
      }
      this.releaseForeground(runId);
      throw err;
    }

    if (first.done) {
      /**
       * resume 一个已经没事可做的 Run 会走到这里（没有任何事件）。
       *
       * 【定】这里**必须关段**。`beginSegment()` 刚把 `segmentActive` 置成
       * true，而这条路径不经过 `pump` 的 finally —— 少了下面这一行，
       * 一个「什么都没发生就返回」的 resume 会让记录**永远挂着「在跑」**，
       * 界面上再也点不动它（与 codex 二次评审 P1-1 后半段指出的同一处；
       * 旧极性下同样漏，是 pre-existing）。
       */
      const rid = runId || "(未知)";
      if (record) {
        this.settleRecord(record, first.value);
        record.segmentActive = false;
        this.finishSegment(record);
      }
      this.releaseForeground(rid);
      return { runId: rid };
    }
    if (!runId) runId = String(first.value.runId);
    record = this.beginSegment(runId);
    // start 路径此前占的是哨兵，这里换成真的 runId。
    this.foregroundHolder = runId;
    // 第一个事件已经经由 trace sink 进过缓冲了（compose 里注入的那个），
    // 这里不重复 push —— 重复会让 SSE 的 since 游标看见两条同号事件。

    // 【定】存下这个 Promise，`close()` 要 await 它（见 LiveRun.pump）。
    record.pump = (async () => {
      try {
        let r = await gen.next();
        while (!r.done) r = await gen.next();
        this.settleRecord(record!, r.value);
      } catch (err) {
        record!.error = (err as Error).message;
      } finally {
        record!.segmentActive = false;
        // 【定】收尾时 abort 等待源：Run 结束了还挂着的等待没有人会去应答它，
        // 留着会让界面上出现一个永远点不掉的卡片。
        record!.aborter.abort();
        this.finishSegment(record!);
        this.releaseForeground(runId);
      }
    })();

    return { runId };
  }

  /**
   * 把 generator 的返回值如实记下来。
   *
   * 【定】`RECOVERY_REQUIRED` 的 `recoveryItems` **必须单独存**（评审 codex P1-1）。
   *
   * 那个状态按 §10.4 是**非终态**，所以 `StartResult.outcome` 是 undefined ——
   * 而 `detail()` 原本只从 `outcome?.recoveryItems` 取恢复项。后果是界面显示
   * 「状态未知、等人确认的副作用：（无）」，同时**照常给出 CONTINUE / ABORT 按钮**：
   * 用户被要求做一个决定，却看不到自己要确认的是哪几件事。
   *
   * 这是全部评审发现里最危险的一条 —— 仓里有【定】说「只有显式决策能销账」，
   * 而一个盲着做出的决策不是决策。CLI 那边一直是打出来的（`main.ts` 收尾处）。
   */
  private settleRecord(record: LiveRun, result: DriveResult): void {
    record.terminalReason = result.terminal.reason;
    if (result.outcome) record.outcome = result.outcome;
    const items = result.terminal.recoveryItems;
    if (items && items.length > 0) record.recoveryItems = [...items];
  }

  private ensureRecord(runId: string): LiveRun {
    this.aborterFor(runId);
    return this.runs.get(runId)!;
  }

  /**
   * 一段执行开始时，给这个 Run 换一个**新的** AbortController。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】不换会让 resume 之后的审批**永远等不到人**。
   *
   * `aborterFor()` 对同一个 runId 返回同一个 controller，而上一段收尾时
   * `finally` 里刚 `abort()` 过它。于是 resume 起来的第二段里，
   * `PendingHub.wait()` 一进去就看到 `signal.aborted === true`，
   * 立刻 resolve(undefined) → 审批被当成「等待被中断」→ 结算 `USER_REJECTED`，
   * **而全程没有任何人拒绝过任何东西**。
   *
   * 这正是 E-3 那个坑的形状（阶段 3 真实端点实跑撞出来的那次），
   * 换了一层壳：一个只在「第二段」才出现的失败，而第一段全绿。
   *
   * 事件缓冲**不清**：它是这个 Run 的完整轨迹，跨段累积才对得上 trace 文件
   * （N-1 修的就是「一个 Run 跨三个进程变成三份互不相干的记录」）。
   * ══════════════════════════════════════════════════════════════════════
   */
  private beginSegment(runId: string): LiveRun {
    const rec = this.ensureRecord(runId);
    if (rec.aborter.signal.aborted) rec.aborter = new AbortController();
    rec.segmentActive = true;
    delete rec.error;
    delete rec.terminalReason;
    return rec;
  }

  /**
   * 事件入口。由 compose 注入的 TraceSinkPort 调用 —— 也就是说
   * **所有**事件都经过这里，包括 `executeBatch` 内部那些在主循环里补号的。
   */
  private onEvent(e: RunEvent): void {
    const runId = String(e.runId);
    const rec = this.ensureRecord(runId);
    /**
     * 【定】`ModelStreamDelta` 不进缓冲区，只实时转发。
     *
     * 它是「正在打字」的过程量，一轮可能上百条；落地之后 transcript 上有完整
     * 正文。塞进重连缓冲的后果是：断线重连的人要把打字动画重看一遍，
     * 而缓冲区会被一堆几十字节的增量撑爆。
     */
    if (e.type !== "ModelStreamDelta") rec.events.push(e);
    for (const fn of this.listeners.get(runId) ?? []) fn(e);
    try {
      this.sinkFor(rec).emit(e);
    } catch {
      // 【定】trace 写失败不打断 Run。它是诊断轨道，不是恢复来源
      // （与 facade 里「投影写失败不打断 Run」同一条理由）。
    }
  }

  /**
   * 本段的 trace sink。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】**复用 CLI 的 `FileTraceSink`，不自己写 append。**
   *
   * 原实现只追加 `{kind:"event"}` 行，注释写着「header / footer 由 CLI 写」——
   * 而**纯 Web 起跑、纯 Web 跑完的 Run 没有任何人写这两种行**。三份评审都
   * 点了它的后果链：
   *
   *   · `loadTraceOutcome` 读的是 footer → 服务重启后 outcome / summary /
   *     未完成项在界面上全部蒸发（盘上 status 还是 COMPLETED）；
   *   · Trace 视图「段 N ＋ commit ＋ gitDirty」对 Web 段永远缺失 ——
   *     而 Roadmap §6.1 声明的正是「Trace 按段分组，每段带 commit / gitDirty」。
   *
   * 用同一个 sink 就顺带拿到了 segmentIndex 的计数（它数已有 header 行），
   * 于是「CLI 跑一段 → 界面 resume 一段」在同一个文件里真的接上了，
   * 而不只是事件行挨在一起。
   * ══════════════════════════════════════════════════════════════════════
   */
  private sinkFor(rec: LiveRun): FileTraceSink {
    if (rec.sink) return rec.sink;
    const created = new FileTraceSink(
      (runId) => this.traceFileFor(runId),
      () => ({
        ...gitProvenance(),
        nodeVersion: process.version,
        endpointProfile: `${this.composed.profile.id}@${this.composed.profile.observedAt}`,
        modelId: this.composed.profile.modelId,
        // 任务原文由 header 承载；Web 段起跑时它已经在 RunSpec 里。
        task: this.taskOf(rec.runId),
        workspaceRoot: this.opts.workspaceRoot,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        startedAt: new Date().toISOString(),
        // 【定】标出这一段是谁跑的。CLI 段与 Web 段在同一个文件里，
        // 事后要能分得清「这几轮是在浏览器里点出来的」。
        entry: "web",
      }),
    );
    rec.sink = created;
    return created;
  }

  /** 段收尾：写 footer。**只写一次**，`close()` 与正常收尾都会调它。 */
  private finishSegment(rec: LiveRun): void {
    if (!rec.sink) return;
    const sink = rec.sink;
    rec.sink = undefined;
    try {
      sink.finish({
        terminal: rec.terminalReason ? { reason: rec.terminalReason } : null,
        outcome: rec.outcome ?? null,
        ...(rec.error ? { serviceError: rec.error } : {}),
        ...(rec.recoveryItems ? { recoveryItems: rec.recoveryItems } : {}),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      /* 同上：诊断轨道写失败不影响任何执行事实 */
    }
  }

  /**
   * 任务原文。取不到就如实写 unknown —— header 是审计用的，不要猜。
   *
   * 【定】`pendingTask` 是第二档而不是第一档：runId 已经登记过的，
   * 以登记的那一份为准。反过来的话，一个 resume 段会被在途的新任务串味。
   */
  private taskOf(runId: string): string {
    return this.taskCache.get(runId) ?? this.pendingTask ?? "(未知)";
  }

  /**
   * ── 这里**故意没有** `notifyDone()` ──────────────────────────────────
   *
   * 写过一版：Run 结束时往监听者塞一条合成的 `LoopContinued`（`reason:
   * SERVICE_RUN_FINISHED`、`sequence: MAX_SAFE_INTEGER`）让界面去刷新。
   * 删掉了，两条理由：
   *
   * 1. **它是一条合成的事实混进了事实轨道。** 那条注释自己写着
   *    「合成的东西不得混进事实轨道」，而它本身就是。SSE 上带 `id:` 的行
   *    会进浏览器的 `Last-Event-ID`，一个假序号会毒化重连游标。
   * 2. **它是多余的。** Run 正常结束时 `LoopTerminated` 本来就会经
   *    trace sink 流到这里，界面收得到。唯一收不到的是 `resume()` 抛错那条
   *    路径 —— 而那条现在由 `UiRunDetail.serviceError` 承载（见 detail()），
   *    界面下一次刷新就会看到错误原文。
   */

  private traceFileFor(runId: string): string {
    return resolve(this.opts.traceDir, `${runId}.jsonl`);
  }
}

// ══════════════════════════════════════════════════════════════ 工具

function toUiArtifact(r: {
  artifactId: string;
  logicalId: string;
  version: number;
  role: string;
  kind: string;
  path?: string;
  contentHash: string;
  sizeBytes: number;
  verified?: boolean;
  verifyDetail?: string;
  createdAt: number;
}): UiArtifactRecord {
  return {
    artifactId: r.artifactId,
    logicalId: r.logicalId,
    version: r.version,
    role: r.role,
    kind: r.kind,
    ...(r.path ? { path: r.path } : {}),
    contentHash: r.contentHash,
    sizeBytes: r.sizeBytes,
    // 【定】undefined 原样透传。「没验过」与「验过没通过」不是一回事，
    // `?? false` 会把前者变成后者。
    ...(r.verified !== undefined ? { verified: r.verified } : {}),
    ...(r.verifyDetail ? { verifyDetail: r.verifyDetail } : {}),
    createdAt: r.createdAt,
  };
}

/**
 * 从 trace JSONL 读回事件。坏行忽略 —— 一行坏了不该让整个文件读不出来。
 *
 * 【定】**跳过 `ModelStreamDelta`，与内存缓冲同一条规则。**
 *
 * 缓冲刻意排除了 delta（见 `onEvent`），而这条读取路径原本不排除，
 * 于是点开一个历史 Run（`selectRun` 固定 `since=0`）会把整场历史的
 * 打字增量逐条重放给客户端 —— 实测一个真实 Run 里 **148 / 365 是 delta**，
 * 客户端会先闪一个装着全部历史正文的「正在输出」框，并为每一条重渲一次时间线。
 * 两条读取路径的规则不一致，本身就是一个会被下一个人踩到的坑。
 */
function loadTraceEvents(path: string): RunEvent[] {
  if (!existsSync(path)) return [];
  const out: RunEvent[] = [];
  for (const row of readJsonl(path)) {
    const r = row as { kind?: string; type?: string };
    if (r.kind !== "event") continue;
    if (r.type === "ModelStreamDelta") continue;
    const { kind: _kind, ...rest } = r as Record<string, unknown>;
    out.push(rest as unknown as RunEvent);
  }
  return out;
}

/** footer 里的 outcome。历史 Run（本进程没跑过）唯一的结算来源。 */
function loadTraceOutcome(path: string): RunOutcome | undefined {
  if (!existsSync(path)) return undefined;
  let found: RunOutcome | undefined;
  for (const row of readJsonl(path)) {
    const r = row as { kind?: string; outcome?: RunOutcome | null };
    if (r.kind === "footer" && r.outcome) found = r.outcome;
  }
  return found;
}

function readJsonl(path: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行忽略 */
    }
  }
  return out;
}


export { REPO_ROOT };
