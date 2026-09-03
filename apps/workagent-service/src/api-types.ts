/**
 * Layer 1 ↔ Layer 2 的线上契约（V05 §5.4）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它**不是** Runtime 类型的再导出。
 *
 * 界面拿到的是投影结果，不是执行状态。两者长得像的地方（status、budgetUsage）
 * 是因为投影**原样转述**了它们（不得绕过 #6），不是因为共用类型。
 * 一旦这里 `export type RunStatus = import("@workagent/harness-runtime").RunStatus`，
 * 下一步就会有人在界面里 import Runtime 的枚举来做判断 ——
 * 而 §5.2【定】说的正是「合法状态迁移不由 UI 拥有」。
 *
 * ── 为什么没有 packages/application-api-contracts ──────────────────────
 *
 * §27.2 的目录规划里有这个包。本批不建：UI 是浏览器里的原生 JS，
 * 它 import 不了任何 TS 类型（边界 grep 第 8 条正是这么守的），
 * 所以这个包只会有**一个**消费者。而「类型、事件、类都在但运行时从不执行」
 * 是本仓明令要避免的形态 —— 一个只有一个消费者的契约包，就是那种形态的包装版。
 * ══════════════════════════════════════════════════════════════════════
 */

// ══════════════════════════════════════════════════════ 投影项（§5.3）

export type UiEntryKind =
  | "USER_MESSAGE"
  | "ASSISTANT_MESSAGE"
  | "TOOL_ACTIVITY"
  | "APPROVAL"
  | "INTERACTION"
  | "ARTIFACT"
  | "SYSTEM_NOTICE";

/**
 * 每个投影项**必须**带来源（§5.3 原文：「保存 `sourceRunId` 与至少一个
 * `sourceSequence / sourceActionId`」）。
 *
 * 【定】`track` 要分得清是哪条轨道。两条轨道的可靠性不同：
 * transcript 是恢复的唯一来源、落 SQLite、永不删除；
 * 事件流是诊断来源、落 JSONL、可以缺失（`--no-trace` 就没有）。
 * 界面上一条「这个工具的入参是 X」如果来自事件流，它的证据等级比来自
 * transcript 低一档 —— 混在一起会让人以为两者一样硬。
 */
export interface UiSource {
  track: "TRANSCRIPT" | "EVENT";
  sequence: number;
}

export interface UiEntryBase {
  /**
   * 稳定 id。**投影两次必须得到同一个 id**，否则 §23.2 第 2 条的
   * 「幂等、至少一次」在客户端合并时不成立（同一条会被插两遍）。
   * 因此它只能由**来源**推出，不能用自增计数或时间戳。
   */
  id: string;
  kind: UiEntryKind;
  source: UiSource;
  at: number;
  turn?: number;
}

export interface UiUserMessage extends UiEntryBase {
  kind: "USER_MESSAGE";
  text: string;
  /** 三种来源在界面上要分得开：任务原文 / 运行期插话 / 系统提示（软限、恢复结果）。 */
  origin: "TASK" | "INTERJECTION" | "SYSTEM";
}

export interface UiAssistantMessage extends UiEntryBase {
  kind: "ASSISTANT_MESSAGE";
  text: string;
  /**
   * 推理块的**长度**，不是内容。
   *
   * 【定】不投影推理原文。理由与 `run-loop.ts` 的 `textOf()` 一致：
   * 推理是模型的草稿，不是它对用户的交代。但**有没有推理、有多长**是白盒
   * 该说的事 —— D-3 实测过它「被回传、被计费，却不出现在 count_tokens 里」，
   * 一个看不见推理长度的界面会让那笔账继续隐形。
   */
  reasoningChars: number;
}

/**
 * 一次工具活动。**它是两条轨道合并的产物**（决 5）：
 *
 *   入参 / 结果原文  ← transcript（事件流里没有）
 *   effect / 审批 / 验证 / 外置 / 时长 ← 事件流（transcript 里没有）
 */
export interface UiToolActivity extends UiEntryBase {
  kind: "TOOL_ACTIVITY";
  /** 刻意透传的关联键；内置 UI 暂不单独展示，外部白盒消费者可据此对齐原始调用。 */
  toolCallId: string;
  toolName: string;
  /** 规范化前的模型原始入参。来自 transcript 的 tool_call 块。 */
  input?: unknown;
  /** 工具结果原文（已脱敏 —— 落 transcript 时就已经过 RedactionPort）。 */
  result?: string;
  resultIsError?: boolean;
  effect?: string;
  /**
   * 这次调用的风险事实与数据去向（护栏 3）。
   *
   * 【定】它们必须显示出来。`policy.ts` 把「让外发在 Trace 上可审计」
   * 列为「越界读放行」的依据之一，而在事件里补上它们之后，
   * 这里是那句话的**第一个人类可读出口** —— 不接消费点等于只把
   * 未接线从一层挪到了另一层。
   */
  riskFacts?: string[];
  dataMovement?: { destination: string; scope: string };
  status?: string;
  sideEffectState?: string;
  durationMs?: number;
  /** 被 Policy 直接拒绝时的原因（`ActionRejected`）。 */
  rejected?: { stage: string; reason: string };
  /**
   * `decidedBy` 是 ADR-0012 加的：**谁做的这个决定**。
   *
   * 少了它，一条 AUTO 档跑完的 Run 与一条被逐步审视过的 Run 在界面上
   * 完全一样 —— 而白盒界面的全部意义就是不让这种事发生。
   */
  approval?: { requested: boolean; approved?: boolean; reason?: string; decidedBy?: string };
  verification?: { status: string; required: boolean; detail: string };
  progress: string[];
  /** 大结果外置（§11.4）。有它说明 transcript 上那条 stub 不是全部内容。 */
  externalized?: { ref: string; sizeBytes: number; approxTokens: number };
  /** §18.2 三条分支：这次 resume 对这个未配对调用做了什么。 */
  resumeBranch?: { branch: string; hasPreFingerprint: boolean };
}

export interface UiApproval extends UiEntryBase {
  kind: "APPROVAL";
  /** 刻意透传的关联键；内置 UI 暂不单独展示，不能据零 DOM 读取点删掉。 */
  actionId: string;
  effect: string;
  reason: string;
  approved?: boolean;
  decisionReason?: string;
  /** 谁做的这个决定（ADR-0012）。`UNDECLARED` = decider 没声明，**不猜**。 */
  decidedBy?: string;
}

export interface UiInteraction extends UiEntryBase {
  kind: "INTERACTION";
  actionId: string;
  toolName: string;
  detail: string;
  /** 【定】它说的是「人应答了没有」，不是「任务成功了没有」（§20.3）。 */
  answered?: boolean;
}

export interface UiArtifact extends UiEntryBase {
  kind: "ARTIFACT";
  artifactId: string;
  logicalId: string;
  version: number;
  role: string;
  artifactKind: string;
  sourceResourceRef?: string;
  /** 【定】`checksRun` 为空 ≠ 通过，界面必须分得开（事件类型注释的原话）。 */
  verified?: { ok: boolean; checksRun: string[]; detail: string };
}

export interface UiSystemNotice extends UiEntryBase {
  kind: "SYSTEM_NOTICE";
  /** 事件类型原名。界面按它分色，不做二次归类 —— 归类会丢信息。 */
  eventType: string;
  text: string;
  severity: "INFO" | "WARN" | "ERROR";
}

export type UiTranscriptEntry =
  | UiUserMessage
  | UiAssistantMessage
  | UiToolActivity
  | UiApproval
  | UiInteraction
  | UiArtifact
  | UiSystemNotice;

// ═══════════════════════════════════════════════════════ 逐轮解剖

/**
 * 一轮的解剖（决 3 的主视图）。
 *
 * 【定】每个字段都直接来自一个事件的 payload 或一条 RUN_META，
 * **没有一个是算出来的**（不得绕过 #6）。
 */
export interface UiTurn {
  turn: number;
  startedAtSequence: number;
  /** 主行展示同一轮最后一次编译帧；每次调用的精确帧在 modelCalls[].frame。 */
  frame?: UiModelFrame;
  /**
   * 这一轮里的**每一次**模型调用。
   *
   * 【定】是数组不是单值。输出预算恢复与模型错误重试都在**同一个 turn 内**
   * 再调一次模型（`continue` 且不递增 turnCount），而累计预算把它们全算进去了。
   * 单值字段会让逐轮解剖显示最后一次、`budgetAfter` 显示全部 —— 同一行自相矛盾。
   */
  modelCalls: UiModelCall[];
  compaction: Array<{
    freedTokens: number;
    reason: string;
    removedMessageCount: number;
    removedToolResultCount: number;
    recoveryIndexRef?: string;
  }>;
  toolNames: string[];
  /** 具名 transition（循环纪律第 2 条在界面上的落点）。 */
  transition?: string;
  /** 这一轮结束时落盘的累计预算（来自该轮边界的 RUN_META，不是求和）。 */
  budgetAfter?: UiBudgetUsage;
}

export interface UiModelCall {
  /** 只用于投影与 DOM 的稳定 id，由 invocationId 推出。 */
  id: string;
  ordinal: number;
  startedAtSequence: number;
  invocationId: string;
  frameId?: string;
  frame?: UiModelFrame;
  /** 只是事件轨道观察结果；调用真实 outcome 以 sidecar invocation_end 为准。 */
  traceStatus: "STARTED" | "RETURNED" | "FAILED";
  inputTokens?: number;
  outputTokens?: number;
  billedInputTokens?: number;
  cacheReadInputTokens?: number;
  stopReason?: string;
  durationMs?: number;
  toolCallCount?: number;
  runtimeErrors: Array<{
    code: string;
    category: string;
    retryability: string;
    safeMessage: string;
  }>;
  auditFailure?: { stage: string; message: string };
}

export interface UiModelFrame {
  items: number;
  totalTokens: number;
  fixedOverheadTokens: number;
  hasExternalUntrusted: boolean;
  untrustedItems: number;
}

export interface UiModelInvocationAudit {
  state: "COMPLETE" | "INCOMPLETE" | "CORRUPT" | "NOT_CAPTURED";
  errors: Array<{ line: number; message: string }>;
  request?: {
    runId: string;
    invocationId: string;
    frameId: string;
    turn: number;
    endpointProfileVersion: string;
    modelId: string;
    startedAt: number;
    body: unknown;
  };
  responseMetadata?: {
    status: number;
    requestId?: string;
    observedAt: number;
  };
  providerEvents: Array<{
    index: number;
    observedAt: number;
    event: unknown;
  }>;
  providerError?: {
    observedAt: number;
    failure: unknown;
  };
  invocationEnd?: {
    outcome: "COMPLETED" | "INTERRUPTED" | "FAILED";
    finishedAt: number;
    durationMs: number;
    result?: unknown;
    error?: unknown;
    interruptionReason?: string;
  };
  /** 路径身份与 request 身份冲突时不把任何敏感正文送进浏览器。 */
  contentWithheld?: boolean;
}

export interface UiBudgetUsage {
  turns: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  billedInputTokens: number;
  activeWallClockMs: number;
  startedAt: number;
}

/** 一条预算轴的读数。`limit` 缺席 = 这条轴没设上限（`DEFAULT_BUDGETS` 里真的有）。 */
export interface UiBudgetAxis {
  axis: string;
  used: number;
  limit?: number;
  unit: "count" | "ms" | "token";
}

// ═══════════════════════════════════════════════════ 等人的三条通道

export type UiPendingKind = "APPROVAL" | "HANDOFF" | "QUESTION";

/**
 * 一个正在等人的请求。
 *
 * 【定】`kind` 三选一，**不合并成一个通用的「问用户」**。
 * ADR-0008 的结论在界面上同样成立：三者的失败语义不同
 * （没人审批 = 拒绝；没人接管 = 那件事真的没做；没人回答 = 自己定），
 * 一个通用面板会让第一个实现的人把三种处置写成同一种。
 */
export interface UiPending {
  pendingId: string;
  runId: string;
  kind: UiPendingKind;
  requestedAt: number;
  /** APPROVAL */
  approval?: {
    actionId: string;
    toolName: string;
    effectType: string;
    scopeKind: string;
    scopeValue: string;
    reversibility: string;
    /** PROCESS scope 时的命令原文。见 `main.ts` 里 ANSI 伪造那段的同源理由。 */
    command?: string;
    description?: string;
    allowNetwork?: boolean;
    /**
     * 这条命令**自称**要交付什么（ADR-0010 的 `artifact_path` / `artifact_role`）。
     *
     * 【定】它必须出现在审批面上。ADR-0010 选「执行前按路径声明」而不是
     * 「执行后扫 workspace」，一半理由就是这个：路径在命令入参里，
     * 于是人批准的不只是「跑这条命令」，还有「它自称要交付这个文件」。
     * 不显示的话那半个理由就没兑现 —— 又一个「声明与实现不符」。
     */
    artifactPath?: string;
    artifactRole?: string;
    /**
     * EXTERNAL_TOOL scope（外部 MCP 工具）的**完整入参 JSON**。
     *
     * 【定】整份带上、不挑字段。Atlas 不解析 MCP 的参数 —— 那正是
     * 「换个 MCP 只改配置」这条能力的代价 —— 所以没有哪个字段能被认定为
     * 「关键字段」单独挑出来展示；挑就等于 Atlas 假装看懂了它，
     * 而那个假装迟早在某个服务器上错。
     *
     * 它比 `command` 更要紧：`run_shell` 背后还有 seatbelt 兜着，
     * 而 MCP 工具**没有沙箱**，这张卡是唯一还在的闸门。
     */
    externalArgs?: string;
    /** 自动放行档位下为什么没放行。 */
    why?: string;
  };
  /** HANDOFF */
  handoff?: { instructions: string; expectedCompletion: string };
  /** QUESTION */
  question?: { question: string; options: string[] };
}

// ═══════════════════════════════════════════════════════ 顶层响应

export interface UiServiceInfo {
  workspaceRoot: string;
  dbPath: string;
  endpoint: string;
  /** 只有 host —— 与 CLI 打印时同一条纪律：完整 URL 的路径里有时带部署标识。 */
  endpointHost: string;
  profileId: string;
  modelId: string;
  /** 人读的一句话，由 `describeModes()` 唯一给出。 */
  approvalMode: string;
  /**
   * 机器读的档位（ADR-0012）。
   *
   * 【定】与上面那句人话**分成两个字段**，不让界面去解析 `approvalMode`。
   * 从一句给人读的话里 parse 出状态，是"第二事实来源"最常见的长法：
   * 那句话为了读着顺改一个字，界面的开关就会静默停在错误的位置上。
   */
  approvalModeId: "CONFIRM" | "DEFAULT" | "AUTO";
  /** 同上，第二条轴。**界面上只读** —— 它随 Run 冻结，改它要重启服务。 */
  executionPrivilege: "SANDBOXED" | "UNRESTRICTED";
  /**
   * 边界让渡的警告（`fullAccessWarning()`）。没有就不出现。
   *
   * 【定】它是一个**独立字段**而不是塞进 `notices` —— notices 是装配期的
   * 提示流水，会被划过去；这一条要常驻在界面顶部，因为它描述的是
   * 「此刻这台机器上没有闸门」，而那不是一条一次性通知。
   */
  fullAccessWarning?: string;
  toolNames: string[];
  /** 工具数 × 180（§16.1【定·实测】）。过拟合警报，随工具数线性增长。 */
  fixedOverheadTokens: number;
  notices: UiNotice[];
  /**
   * 下一个 Run 的默认预算 —— 界面「新任务」栏里那几个输入框的占位值。
   *
   * 【定】它与 `UiRunDetail.budgetAxes` 是**两个事实**：那边是
   * 「这个 Run 冻结的限额与已经用掉多少」，这边是「下一个 Run 起步用什么」。
   * `--max-turns` 调过之后两者会不一样，而那正是对的。
   */
  budgetDefaults: UiBudgetDefault[];
  traceDir: string;
}

/**
 * 一条装配期诊断。**`text` 随时该看见，`detail` 用到时才展开。**
 *
 * 【定】三份结构相同的声明之一（另两份：`McpNotice` 在 `tools/mcp/src/index.ts`、
 * `Notice` 在 `apps/cli/src/compose.ts`）。依赖方向是 `apps → tools`，
 * 反过来 import 会破坏分层，所以只能靠结构类型对齐 —— 改一处要三处一起改。
 *
 * 为什么必须分两个字段而不是让界面按 `\n` 切一条散文串：与
 * 「读 `approvalModeId` 这个机器字段、不解析 `approvalMode` 那句人话」同源。
 * 文案会为了读着顺增删换行，而界面上的表现是**该常驻的那句话被折进去了** ——
 * 具体到 MCP 那条：折进去的会是「输出目录固定在 …」，
 * 而它是 Run `run_6c3fec671ceb` 真的踩过的坑。
 */
export interface UiNotice {
  text: string;
  detail?: string;
}

/** 一条轴的默认限额。`limit` 缺席 = 这条轴没设上限（`maxTotalWallClockMs` 就是）。 */
export interface UiBudgetDefault {
  axis: string;
  /** `RunBudgets` 上的字段名。界面只用来显示，覆盖时送的是 `axis`。 */
  field: string;
  limit?: number;
  unit: "count" | "ms" | "token";
}

export interface UiRunListItem {
  runId: string;
  status: string;
  task: string;
  createdAt: number;
  updatedAt: number;
  /** 本进程内有没有一个循环在跑它。**它不是状态**，是「谁在跑」（见决 6）。 */
  liveInThisProcess: boolean;
}

/**
 * 一个可选的工作空间。
 *
 * 【定】`dbPath` / `traceDir` 要露出来给界面看。它们是「这个 workspace 的
 * Run 存在哪」的唯一事实 —— 而阶段 4 收口批刚因为「`--db` 与 `--workspace`
 * 分开、同一个库里躺着不同目录的 Run」吃过一次亏（S4-5）。
 * 把存储位置摆在界面上，那种错配一眼就能看见。
 */
export interface UiWorkspace {
  id: string;
  name: string;
  realPath: string;
  dbPath: string;
  traceDir: string;
}

export interface UiStateResponse {
  service: UiServiceInfo;
  runs: UiRunListItem[];
  pending: UiPending[];
  workspaces: UiWorkspace[];
  activeWorkspaceId: string;
}

export interface UiRunDetail {
  runId: string;
  status: string;
  task: string;
  liveInThisProcess: boolean;
  /**
   * 【定】原样来自 `runtime.inspect()`。服务不得重算 —— 判据在 verify:ui C 段
   * （UI 拿到的数字与 inspect() 逐字一致）。
   */
  snapshot: {
    turnCount: number;
    consecutiveFailures: number;
    messageCount: number;
    budgetUsage: UiBudgetUsage;
    resumeBranchCounts: Record<string, number>;
    unmetCauseCounts: Record<string, number>;
  };
  budgetAxes: UiBudgetAxis[];
  spec: {
    runSpecId: string;
    /**
     * 这个 Run 是谁发起的（`RunOrigin.kind`）。trace header 的 `entry` 则记录
     * 每个执行段实际由哪个入口运行；只有首段必然与这里对应。
     */
    origin: string;
    /**
     * 以下端点、时区与审批策略字段刻意保留为冻结 RunSpec 的全量白盒契约。
     * 内置 UI 暂未逐项展示，但 API 使用者可用它们解释或比对一次历史执行。
     */
    endpointId: string;
    modelId: string;
    endpointProfileRef: string;
    timezone: string;
    /**
     * 这个 Run **当时**的执行特权档位（ADR-0012 二次评审 P2-5）。
     *
     * 【定】它与 `UiServiceInfo.executionPrivilege`（当前服务档位）是
     * **两个字段**，界面必须分栏显示。重启换过档之后，用当前服务档位
     * 去解释一条历史 Run，答案会是错的 —— 而那个错看起来完全正常。
     */
    executionPrivilege: string;
    toolCount: number;
    createdAt: number;
    /** 冻结的 system prompt。白盒的一部分：模型到底被告知了什么。 */
    systemPrompt: string;
    approvalPolicy: {
      requiresApprovalFor: string[];
      /** 冻结策略的全量字段；内置 UI 暂不显示超时时间。 */
      approvalTimeoutMs?: number;
    };
  };
  timeline: UiTranscriptEntry[];
  turns: UiTurn[];
  artifacts: UiArtifactRecord[];
  recovery: {
    /** 停在 RECOVERY_REQUIRED 时的未销账项。 */
    items: Array<{ what: string; sideEffectState: string }>;
    branchCounts: Record<string, number>;
  };
  outcome?: {
    kind: string;
    summary?: string;
    incompleteItems: Array<{ what: string; why: string }>;
    recoveryItems: Array<{ what: string; sideEffectState: string }>;
    /**
     * Runtime **最终判定**的交付集合（二次评审 codex P2-3）。
     *
     * 【定】它与 `artifacts`（本 Run 登记过的**全部**产物）不是一回事，
     * 界面必须能分开显示。此前只有 `artifacts`，于是「哪几份是 Runtime
     * 认定交付了的」在白盒界面上**根本看不到** —— 而那正是
     * §17 的结论本身，也是这个界面存在的理由。
     */
    deliveredArtifactIds: string[];
  };
  /** 投影时两条轨道各读到多少条。缺口一眼可见（比如 `--no-trace` 跑的 Run）。 */
  tracks: { transcriptEntries: number; events: number; traceFile?: string };
  /**
   * 服务侧驱动这个 Run 时抛出的错误原文（多半来自 `resume()` 的闸门）。
   *
   * 【定】原文透传，**不翻译成某个 outcome.kind** —— 那是 Runtime 的判定，
   * Layer 2 不替它结算（决 6）。
   */
  serviceError?: string;
  /** 下一次增量拉取的游标。 */
  cursor: number;
}

export interface UiArtifactRecord {
  artifactId: string;
  logicalId: string;
  version: number;
  role: string;
  kind: string;
  path?: string;
  contentHash: string;
  sizeBytes: number;
  sourceResourceRef?: string;
  /** 【定】undefined ≠ false。「没验过」与「验过没通过」不是一回事。 */
  verified?: boolean;
  verifyDetail?: string;
  createdAt: number;
}
