/**
 * Runtime Ports（V05 §8.7）。共 **15** 个。
 *
 * D-14：阶段 1 实现 10 个（标 ★），4 个只留接口。
 * 四个不实现的共同点：阶段 1 没有任何用例能检验它们设计得对不对，实现了也是盲写。
 *
 * 阶段 2 新增第 15 个 `RunStorePort`（也标 ★）—— 跨进程 resume 的前提。
 * 它不是「顺手多加一个」：§8.7 原本 14 个是在**单进程**假设下数出来的，
 * 那个假设在阶段 2 被去掉了。
 *
 * §2.5 规格纪律第 4 条：每新增一个 Port，必须同时指出强制它存在的不变量。
 * 下面每个接口的注释都写了这一条。
 */

import type {
  ContextFrame,
  ContextItem,
  ModelContent,
} from "../types/context.js";
import type { EndpointCapabilityProfile } from "../types/endpoint.js";
import type { RuntimeErrorRecord } from "../types/error.js";
import type { RunEvent } from "../types/event.js";
import type { ContextMessage, TranscriptEntry } from "../types/transcript.js";
import type { ModelUsage, RunSpec, RunStatus } from "../types/run.js";
import type {
  EffectResolutionDescriptor,
  ExecutionAttempt,
  PreparedAction,
  ResolvedEffect,
  ToolDefinition,
  VerificationResult,
} from "../types/tool.js";
import type { JsonValue, RunId, RunSpecId, Timestamp } from "../types/ids.js";

// ═══════════════════════════════════════════════ ★ 阶段 1 实现（10）

/**
 * ★ ModelPort —— 网络调用与流式传输。
 * 强制它的不变量：主循环不得 import Provider SDK（§4.2 禁止项）。
 */
export interface ModelPort {
  invoke(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult>;
  countTokens(request: ModelRequest): Promise<number | undefined>;
}

export interface ModelRequest {
  /** 已由形状适配器构造完成的请求体。主循环不认识它的内部结构。 */
  body: unknown;
  modelId: string;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | { type: "block_start"; index: number; blockType: string }
  | { type: "block_stop"; index: number };

export interface ModelInvocationResult {
  /** 规范化后的助手消息内容。形状差异已被适配器吸收。 */
  content: ModelContent[];
  toolCalls: Array<{ toolCallId: string; name: string; input: unknown }>;
  stopReason: string;
  usage: ModelUsage;
  /** 中断时为 true。半截内容不进入后续 Context。 */
  interrupted: boolean;
}

/**
 * ★ ModelProtocolPort —— 形状适配器 ＋ 端点能力声明的消费入口。
 *
 * 每个方法的左边来自形状，右边来自端点。这就是 D-07 答案的代码形态。
 * 对外仍是一个 Port：调用方关心「这个帧合不合法」「这些块能不能删」，
 * 不关心答案来自形状还是端点。
 *
 * 强制它的不变量：端点差异不得出现在主循环、Context 模块或形状适配器中（原则十四）。
 */
export interface ModelProtocolPort {
  buildRequest(frame: ContextFrame): ModelRequest;
  countTokens(frame: ContextFrame): Promise<TokenCount>;
  validateFrame(frame: ContextFrame): FrameValidation;
  /** 某个 ContextItem 在当前端点下能否被丢弃 / 是否需要占位。 */
  protocolRoleOf(item: ContextItem): ContextItem["protocolRole"];
  classifyError(err: unknown): RuntimeErrorRecord;
  isBlockClosed(index: number, seen: ModelStreamEvent[]): boolean;
  /** 只读。供 Context 层判定档位，不供主循环读取。 */
  readonly profile: EndpointCapabilityProfile;
}

export interface TokenCount {
  tokens: number;
  /** EXACT 来自端点的 count_tokens；ESTIMATED 是本地估算。 */
  accuracy: "EXACT" | "ESTIMATED";
}

export interface FrameValidation {
  ok: boolean;
  violations: string[];
}

/**
 * ★ TranscriptStorePort —— 消息追加与重建。
 *
 * 强制它的不变量：消息先落盘再进内存 messages（不变量 5）。
 * append 是 async 且必须 await 完成才允许更新内存 —— 接口形态本身强制这条。
 */
export interface TranscriptStorePort {
  append(entry: Omit<TranscriptEntry, "sequence">): Promise<number>;
  /** 从最后一个 COMPACT_BOUNDARY 之后重建。 */
  rebuildMessages(runId: RunId): Promise<ContextMessage[]>;
  readAll(runId: RunId): Promise<TranscriptEntry[]>;
  /**
   * 最后一条**已落盘 transcript 条目**的序号。
   *
   * 注意它不是计数器的高水位 —— 事件也从同一条序列取号但不落 transcript，
   * 所以计数器通常已经跑在这个值前面。要续号请用 nextSequence()。
   */
  lastSequence(runId: RunId): Promise<number>;
  /**
   * 【定】D-2：事件与 transcript 条目共用一条单调序列，这里是**唯一取号点**。
   *
   * 在此之前 `types/event.ts` 的注释白纸黑字写着「与 transcript 同一条序列」，
   * 而 runLoop 的 seq 与 store 的 sequence 是两条各自递增的计数器，resume 后
   * 新 runLoop 的 seq 还从 0 重计。§23.2 的 Layer 2 投影游标依赖这条序列 ——
   * 带着两条计数器进 SQLite 之后没法收拾，所以这条必须早于持久化做掉。
   *
   * 后果是 transcript.sequence 会出现空洞（被事件占掉的号）。**这是正确的**：
   * 空洞恰好表达「这两条消息之间发生过 N 个事件」，两条轨道因此可以全序比较。
   *
   * atLeast：把计数器下限抬到这个值再分配。resume 时用它把计数器推回上次的
   * 高水位 —— 事件不落 transcript，单靠 transcript 恢复计数器会重发已经用掉的号。
   */
  nextSequence(runId: RunId, atLeast?: number): Promise<number>;
}

/**
 * ★ RunStorePort —— Run 身份的持久化（阶段 2 新增，第 15 个）。
 *
 * 强制它的不变量：**§18.4【定】resume 必须使用 RunSpec 冻结的那一份，
 * 不得使用当前配置**（连带不变量 14：端点能力声明须与冻结版一致）。
 *
 * 阶段 1 用内存 Map 就满足了这条 —— 进程没死，冻结的那份自然还在。
 * 跨进程之后它不再自动成立：`resume()` 第一步要读 RunSpec，而
 * §18.2 的三条分支判定完全依赖 `agentSpec.toolSnapshots`。若这时用
 * 「今天 compose 出来的」工具声明，改一次 `append_log` 的 verification
 * 就会让同一条 transcript 走进不同分支，**而盘上看不出来**。
 *
 * 为什么必须是 Port 而不是让 Facade 直接读库：Runtime 不得 import
 * `node:sqlite`（阶段 2 新增的第 5 条边界 grep）。
 *
 * 注意它**不存序号高水位** —— `lastSequence` 的权威副本在 transcript 的
 * `RUN_META` 里。存第二份就会有分叉的那天。
 */
export interface RunStorePort {
  /** 【定】RunSpec 与初始状态必须一起落盘：有 Run 无 spec 是不可恢复的状态。 */
  createRun(input: {
    runId: RunId;
    spec: RunSpec;
    status: RunStatus;
    now: Timestamp;
  }): Promise<void>;
  /** 读回**冻结的那一份**。取不到说明这个 Run 不存在，不要回退到当前配置。 */
  getRunSpec(runId: RunId): Promise<RunSpec | undefined>;
  getStatus(runId: RunId): Promise<RunStatus | undefined>;
  setStatus(runId: RunId, status: RunStatus, now: Timestamp): Promise<void>;
  /** 供 CLI 的 `--list-runs`。按 updatedAt 倒序。 */
  list(limit?: number): Promise<RunListItem[]>;
}

export interface RunListItem {
  runId: RunId;
  runSpecId: RunSpecId;
  status: RunStatus;
  /** 任务原文的前若干字符，供终端一眼认出是哪个 Run。 */
  task: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * ★ ToolHandlerPort —— 工具执行。
 * 强制它的不变量：每个外部副作用关联 Action 和 Attempt（不变量 3）。
 */
export interface ToolHandlerPort {
  execute(
    action: PreparedAction,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionOutcome>;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  workspaceRoot: string;
  onProgress(note: string): void;
  /**
   * 随 AgentSpec 冻结的 IANA 时区名。
   *
   * 【定】工具不得自己读宿主时区。注入给模型的受信时间事实用的是这个时区，
   * 工具若用另一个，模型会同时拿到两个时区不同的时间 —— 而它没有任何
   * 办法发现这件事。Replay 也要求时区随 Run 冻结而不是随重放机器变。
   */
  timezone: string;
}

export interface ToolExecutionOutcome {
  ok: boolean;
  output: string;
  error?: RuntimeErrorRecord;
  sideEffectState: ExecutionAttempt["sideEffectState"];
  /**
   * 工具**显式**声明「我刚产出了一个交付物」（阶段 3 S8，§17）。
   *
   * ── 【定】登记触发源是工具，不是 Runtime 扫 workspace ────────────────
   *
   * 与 §17【定】「Runtime Blob 不自动升级为 Artifact」是同一条理由：
   * 自动派生会把**用户自己放进 workspace 的文件**误当成本次 Run 的交付物。
   * 一个装着 200 份历史文档的目录，扫一遍就会「交付」200 个 artifact。
   *
   * ── 为什么是一个类型化字段，而不是从 output 里解析 ────────────────────
   *
   * 解析 output 就得约定一段格式，而格式会变；变的那天没有任何东西会告诉你，
   * 只会安静地不再登记任何产物。这与 `causeByCall`「在事情发生的那一刻
   * 记下来，不要事后从文案里猜」是同一条纪律。
   */
  artifact?: ProducedArtifact;
}

/** 工具产出的交付物。Runtime 拿它去 `ArtifactStorePort.register()`。 */
export interface ProducedArtifact {
  /** 逻辑身份，通常就是 workspace 内的相对路径。同一个 logicalId 形成版本链。 */
  logicalId: string;
  role: ArtifactRole;
  /** 产物类型，决定跑哪些检查器（json / zip / text / …）。 */
  kind: string;
  path?: string;
  content: string;
  derivedFrom?: string[];
}

/**
 * ★ RedactionPort —— 边界脱敏。
 *
 * 强制它的不变量：未脱敏原文不得离开 Adapter 边界（原则十二、不变量 13）。
 * 脱敏失败 = Tool 失败，不得降级为原样保存。
 */
export interface RedactionPort {
  redact(raw: string, profile: ToolDefinition["redaction"]): RedactionOutcome;
}

export interface RedactionOutcome {
  ok: boolean;
  text: string;
  report: { fieldsRedacted: string[]; bytesRedacted: number };
  error?: RuntimeErrorRecord;
}

/**
 * ★ EffectResolverPort —— 把 Tool 参数解析为可信 EffectScope。
 *
 * 强制它的不变量：每次 Action 执行前必须具有 ResolvedEffect（不变量 9）。
 * EffectScope 使用规范化语义对象，不以自由文本作为授权边界。
 */
export interface EffectResolverPort {
  resolve(
    descriptor: EffectResolutionDescriptor,
    normalizedInput: JsonValue,
    workspaceRoot: string,
  ): ResolvedEffect;
}

/**
 * ★ VerificationPort —— 独立验证外部世界是否达到目标。
 *
 * 强制它的不变量：Run 进入 COMPLETED 前必须结算 outcome.kind，
 * 且结算依据必须来自事实表（不变量 12）。
 * 它是唯一一个能把 SUCCESS 降级为 COMPLETED_WITH_LIMITS 的信号。
 */
export interface VerificationPort {
  verify(
    action: PreparedAction,
    outcome: ToolExecutionOutcome,
    ctx: ToolExecutionContext,
  ): Promise<VerificationResult>;

  /**
   * 执行**前**拍一张外部世界的指纹（决 6）。
   *
   * 为什么复用这个 Port 而不新增一个：**前置观察与崩溃后观察必须是同一个
   * 实现**，否则两次测的不是同一个量，比对没有意义。而 VerificationPort
   * 本来就是「独立观察外部世界」的那一个。
   *
   * 返回 undefined = 这次观察不了。Runtime 据此把该 Action 归入
   * 「崩溃后不可观察」，也就是 §18.2 的第三条分支 —— **这是一个 Action 级
   * 事实，不是工具的静态属性**，故障注入可以逐次控制它。
   */
  observePre?(
    action: PreparedAction,
    ctx: ToolExecutionContext,
  ): Promise<ObservationResult | undefined>;

  /**
   * 崩溃恢复时：拿执行前的指纹和现在的外部世界比，判断那次执行发生没发生。
   *
   * 这是把 §18.2 窗口 A/B 的「不可区分」变成「可区分」的唯一途径 ——
   * 也是消息级恢复能不能用的关键：分支二占比越高，那个取舍越成立。
   */
  observePost?(
    action: PreparedAction,
    ctx: ToolExecutionContext,
    preFingerprint: JsonValue,
  ): Promise<{ applied: boolean; detail: string } | undefined>;
}

export interface ObservationResult {
  /**
   * 外部世界的指纹。**Runtime 不理解它的内容** —— 那是工具域知识，
   * 而依赖方向禁止 Runtime 认识 Case 包。这里只负责存取。
   */
  fingerprint: JsonValue;
  at: Timestamp;
}

/** ★ ClockPort —— 测试注入 FakeClock。 */
export interface ClockPort {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** ★ IdGeneratorPort —— 测试注入确定性实现，Replay 才可能逐字节一致。 */
export interface IdGeneratorPort {
  next(prefix: string): string;
}

/** ★ TraceSinkPort —— 事件消费。阶段 1 先 console，接口按最终形态定。 */
export interface TraceSinkPort {
  emit(event: RunEvent): void;
}

// ═════════════════════════════════════ 只留接口，不实现（阶段 3 后剩 2）

/**
 * CapabilityLeasePort —— 并发保护（EXCLUSIVE / KEYED lease，含 PARKED）。
 *
 * ── 阶段 3 决 5：**明确不做**，理由从「还没到时候」换成了「需求不在这里」──
 *
 * 阶段 1 写的是「lease 语义要到 Browser Capability 才有真需求（阶段 3）」。
 * 阶段 3 到了，结论是**不做**：lease 的真需求来自**多 Run 并发**，
 * 不是来自浏览器。当前是单进程、一 Run 一循环（§18.6【定】「等待就是 await，
 * 进程死了所有等待一起死」），三个场景里找不到一个通用工具需要独占。
 *
 * 但「人工接管」本身要做，且三场景都有需求 —— 那条走 `request_handoff`
 * ＋ `WAITING_FOR_INTERACTION`，不需要 lease。
 */
export interface CapabilityLeasePort {
  acquire(key: string, runId: RunId): Promise<{ leaseId: string }>;
  release(leaseId: string): Promise<void>;
  park(leaseId: string, interactionId: string): Promise<void>;
  unpark(leaseId: string): Promise<void>;
}

/**
 * SecretResolverPort —— Secret 明文的短暂解析。
 * 不实现的理由：阶段 3 首批工具明确不含需要凭证的（决 2 判定 ⏸）。
 * 注意端点凭证不走这里 —— 它由 Composition Root 直接注入形状适配器。
 */
export interface SecretResolverPort {
  resolve(ref: string): Promise<string>;
}

// ═══════════════════════════════════════ ★ 阶段 3 实现（17、18）

/**
 * ★ BlobStorePort —— 大结果外置（阶段 3，§11.4）。
 *
 * 强制它的不变量：**§11.5 不变量 5 —— 外置必须保留协议合法的结构化 stub**，
 * 以及 §16.1 的上下文预算（超过 `inlineToolResultLimitTokens` 的结果不得
 * 原样进帧）。
 *
 * 【定】它同时是数据最小化机制 —— 外置的内容不进模型也就不出境（V05 §22.7）。
 *
 * ── 阶段 1 不实现的理由，与阶段 3 实现的理由是同一句话 ────────────────────
 *
 * 代码里原本写着「大结果外置**要到 Case 01 才有真实的大结果**」。阶段 3 的
 * `read_file` 与 `fetch_url` 就是那个真实的大结果 —— **不是忘了做，
 * 是没有工具需要它**。所以顺序是先建工具面，让机制被真需求逼出来。
 *
 * ── 【定】`get` 必须支持分页 ────────────────────────────────────────────
 *
 * 只有 `put` / `get(ref): string` 的话，取回一个 500KB 的 blob 会把它整个
 * 灌回上下文 —— 那就把刚刚外置掉的东西又搬了回来。分页语义与 `read_file`
 * 保持一致（按行、显式 truncated），这样模型在两个工具之间不需要换脑子。
 */
export interface BlobStorePort {
  /** 内容寻址：同一份内容只存一份，但每次调用得到自己的 ref。 */
  put(input: {
    content: string;
    runId?: RunId;
    toolName?: string;
  }): Promise<{ ref: string; hash: string; size: number }>;
  /**
   * 按 ref 取回。`startLine` 从 1 起；`limit` 是最多返回多少行；
   * `lineOffset` 是起始行内的字符偏移（超长单行续取时用）。
   * 取不到时返回 undefined —— **不要抛**，模型给错 ref 是它自己纠正得了的。
   */
  get(
    ref: string,
    opts?: { startLine?: number; limit?: number; lineOffset?: number; maxChars?: number },
  ): Promise<BlobPage | undefined>;
}

export interface BlobPage {
  ref: string;
  hash: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  /**
   * 起始行内的字符偏移（0 起）。
   *
   * ── 它为什么必须存在 ────────────────────────────────────────────────
   *
   * 被外置的东西是**工具结果**，而工具结果几乎都是**一行 JSON** ——
   * 一个 64KB 的 `read_file` 结果，`totalLines` 就是 1。
   * 只按行分页的话，模型请求 100 行会拿回整整 64KB，
   * 刚刚外置掉的东西原样搬回上下文，外置等于白做。
   *
   * 【定】所以还有一层**字符预算**。超长单行按字符切片，
   * 并用 `lineOffset` / `nextLineOffset` 让模型接着取 ——
   * 这仍然是**分页**（模型知道还有多少、可以再取），不是截断（不得绕过 #6）。
   */
  lineOffset: number;
  /** 还有后续内容。**分页，不是截断** —— 模型带 next* 再取即可。 */
  truncated: boolean;
  /** 下一页的起点。`truncated` 为 false 时不出现。 */
  nextStartLine?: number;
  nextLineOffset?: number;
  content: string;
}

/**
 * ★ ArtifactStorePort —— Artifact 登记、版本链与 lineage（阶段 3，§17）。
 *
 * 强制它的不变量：**V05 §10.4【定】的第二层 Verification**（「这个产物本身
 * 是否完整合法」）在 `ArtifactRegistered` 之后触发 —— 没有登记就没有触发点。
 * 连带 `RunOutcome.deliveredArtifactIds`（阶段 1、2 恒空）。
 *
 * ── 【定】这是接口**重设计**，不是「实现现成接口」──────────────────────
 *
 * 原来的两个方法是：
 *
 *     register(input: unknown): Promise<{ artifactId: string }>
 *     markVerified(artifactId: string, ok: boolean): Promise<void>
 *
 * `input: unknown` 表达不了 §17 要求的任何一件事：版本链、Tombstone、
 * lineage、来源 Run 关联、`role` 与 Deliverable-Verified 标记。
 * `ok: boolean` 也丢掉了「为什么没通过」—— 而那正是结算时要写进
 * `incompleteItems` 的东西。
 *
 * ── 三条登记语义（§17【定】）────────────────────────────────────────────
 *
 * 1. **由工具显式产出后登记，不由 Runtime 扫 workspace 自动派生。**
 *    自动派生会把用户自己放进 workspace 的文件误当成本次 Run 的交付物。
 * 2. **内容变化形成新版本**，不原地覆盖。
 * 3. **删除优先 Tombstone**，不物理删除。
 */
export interface ArtifactStorePort {
  register(input: ArtifactRegistration): Promise<ArtifactRecord>;
  /** 【定】带 detail —— 只记 ok 的话，「为什么没通过」在结算时无从引用。 */
  markVerified(artifactId: string, ok: boolean, detail: string): Promise<void>;
  get(artifactId: string): Promise<ArtifactRecord | undefined>;
  listByRun(runId: RunId): Promise<ArtifactRecord[]>;
  /** 【定】Tombstone，不是 DELETE。「它曾经存在过」比「它现在没了」更重要。 */
  tombstone(artifactId: string, at: Timestamp): Promise<void>;
}

/**
 * 产物在本次 Run 里的角色。**它决定检查失败时的 outcome 映射**（§1.2 第 3 条）：
 *
 *   DELIVERABLE          → 检查失败结算 `FAILED`
 *   INTERMEDIATE / RESULT → 检查失败结算 `COMPLETED_WITH_LIMITS` ＋ 具名 incompleteItems
 *
 * 【定】两者必须可区分。一律降级为 COMPLETED_WITH_LIMITS 会让
 * 「交付物是坏的」和「某个中间步骤有瑕疵」在 outcome 上看不出差别。
 */
export type ArtifactRole = "DELIVERABLE" | "INTERMEDIATE" | "RESULT";

export interface ArtifactRegistration {
  runId: RunId;
  /**
   * 逻辑身份。同一个 logicalId 的多次登记形成版本链。
   * 通常就是 workspace 内的相对路径 —— 「同一个文件被改了两次」是
   * 版本链最常见的来源。
   */
  logicalId: string;
  role: ArtifactRole;
  /** 产物类型，决定跑哪些检查器（json / zip / text / …）。 */
  kind: string;
  /** workspace 内的相对路径。不落盘的产物可以没有。 */
  path?: string;
  content: string;
  /** lineage：从哪些 artifact 派生而来。 */
  derivedFrom?: string[];
}

export interface ArtifactRecord {
  artifactId: string;
  logicalId: string;
  version: number;
  runId: RunId;
  role: ArtifactRole;
  kind: string;
  path?: string;
  contentHash: string;
  sizeBytes: number;
  derivedFrom: string[];
  tombstonedAt?: Timestamp;
  /** undefined = 还没验过。【定】「没验过」与「验过没通过」不是一回事。 */
  verified?: boolean;
  verifyDetail?: string;
  createdAt: Timestamp;
}

// ══════════════════════════════════════════════════════════ 装配

export interface RuntimePorts {
  model: ModelPort;
  protocol: ModelProtocolPort;
  transcript: TranscriptStorePort;
  /** 阶段 2 新增。跨进程 resume 的前提，见上方接口注释。 */
  runs: RunStorePort;
  tools: ToolHandlerPort;
  redaction: RedactionPort;
  effects: EffectResolverPort;
  verification: VerificationPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  trace: TraceSinkPort;
  /** 阶段 3 新增。大结果外置（§11.4）。 */
  blobs: BlobStorePort;
  /** 阶段 3 新增。交付物登记与第二层 Verification（§17、§10.4）。 */
  artifacts: ArtifactStorePort;
  /**
   * 阶段 3 新增：Artifact 级检查器。
   *
   * 【定】Runtime 拥有**生命周期与结算语义**，检查器本身由工具包提供
   * （`tools/common/src/artifact-checks/`）—— 与 VerificationPort 同构：
   * Runtime 不理解「ZIP 能不能解开」，它只负责在 ArtifactRegistered 之后
   * 把检查跑起来，并把结果记进事实表。
   */
  artifactChecks: ArtifactCheckerPort;
}

/**
 * ★ ArtifactCheckerPort —— 产物**类型**的静态结构约束（阶段 3，§10.4 第二层）。
 *
 * 强制它的不变量：**§10.4【定】两层 Verification 不得互相替代。**
 *
 * Action 级验证的参照物是**模型自己的意图**（`write_file` 验的是
 * 「磁盘内容 == 计划内容」），所以它对「模型的意图本身不全」在结构上是盲的
 * —— 不是恰好没查到。第二层问的是另一个问题：这个产物**本身**完不完整合法。
 *
 * ── 【定】检查器必须有判别力，且不得写任务级规则 ──────────────────────
 *
 * 首批只做四项：JSON 可解析、ZIP 可解开、文本编码合法、hash 与登记一致。
 *
 * **「Markdown 可解析」不做** —— 任何文本都是合法 Markdown，它是一个
 * 永远绿灯的闸门。要做就得给出可失败的结构断言（标题层级存在、正文非空），
 * 首批不值得。
 *
 * 【定】「hash 与登记一致」比的是**磁盘上那一份**，不是 `content` 自比。
 * 拿入参 `content` 重算 hash 去比 `record.contentHash` 是同源比较，
 * 恒真 —— 那是本项目刚拆掉的第二个永远绿灯的闸门（阶段 3 收口批）。
 * 实现方因此需要知道产物落在哪（workspaceRoot 由 Composition Root 注入），
 * 这层「静态结构约束」也就包含**登记与实体一致**这一条。
 *
 * 任务业务规则属 Case，本阶段没有 Case 包可写，**因此一条都不写**。
 * 回归评测 §5.1 那次误判就是把逐 Run 变化的用户要求写死成硬门槛的现场。
 */
export interface ArtifactCheckerPort {
  check(record: ArtifactRecord, content: string): Promise<ArtifactCheckOutcome>;
}

export interface ArtifactCheckOutcome {
  ok: boolean;
  /** 跑了哪些检查。**没有适用检查时为空数组** —— 那与「全部通过」不同。 */
  checksRun: string[];
  detail: string;
}
