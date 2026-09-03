/**
 * Runtime Ports（V05 §8.7）。共 **15** 个，**全部有实现**。
 *
 * §2.5 规格纪律第 4 条：每新增一个 Port，必须同时指出强制它存在的不变量。
 * 下面每个接口的注释都写了这一条。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】**不留「只有接口、没有实现」的 Port。**
 *
 * 此前挂着 `CapabilityLeasePort` 与 `SecretResolverPort` 两个空壳，
 * 而各自的注释里写的是「明确不做」（决 5 / 决 2）—— 一个公共接口
 * 同时声明「我存在」和「我不做」，读的人只会记住前半句。
 * 真需要时再加，那时它会连着实现一起来。
 * ══════════════════════════════════════════════════════════════════════
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
import type { ExecutionPrivilege, ModelUsage, RunSpec, RunStatus } from "../types/run.js";
import type {
  EffectResolutionDescriptor,
  ExecutionAttempt,
  PreparedAction,
  ResolvedEffect,
  ToolDefinition,
  VerificationResult,
} from "../types/tool.js";
import type { JsonValue, RunId, RunSpecId, Timestamp } from "../types/ids.js";
import type {
  ModelInvocationAuditStart,
  ModelInvocationAuditWriter,
  ModelInvocationObserver,
} from "../types/model-audit.js";

/**
 * ModelPort —— 网络调用与流式传输。
 * 强制它的不变量：主循环不得 import Provider SDK（§4.2 禁止项）。
 */
export interface ModelPort {
  invoke(
    request: ModelRequest,
    signal: AbortSignal,
    observer: ModelInvocationObserver,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult>;
  countTokens(request: ModelRequest): Promise<number | undefined>;
}

export interface ModelRequest {
  /** 已由形状适配器构造完成的请求体。主循环不认识它的内部结构。 */
  body: unknown;
  modelId: string;
}

/**
 * 流式事件。**只有一种**，因为只有一种有消费者。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】这里此前还有四个变体：`reasoning_delta` / `tool_input_delta` /
 * `block_start` / `block_stop`。形状适配器忠实产出它们，而**全仓唯一的
 * 消费者是 `run-loop` 那一句 `if (sev.type === "text_delta")`** ——
 * 另外四个只被一个同样没人调的 `ModelProtocolPort.isBlockClosed` 读过。
 * 两个零消费者互相引用，看起来像一条接好的链路。
 *
 * 【定】删掉它们**不丢任何信息**：块的闭合判定（§8.4「未闭合的 Tool Call
 * 不得转为 ProposedAction」）由形状适配器的 `assemble()` 自己做，
 * 它读的是同一个 `hasExplicitBlockCloseEvent` 声明，而且那份是活的。
 *
 * 要做「界面上显示推理过程」的那天，第一步是写那个消费者，
 * 第二步才是把 `reasoning_delta` 加回来 —— 不是先摆一个没人读的事件类型。
 * ══════════════════════════════════════════════════════════════════════
 */
export type ModelStreamEvent = { type: "text_delta"; text: string };

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
 * ModelProtocolPort —— 形状适配器 ＋ 端点能力声明的消费入口。
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
  /**
   * 【定】这里**没有** `isBlockClosed`。
   *
   * 它曾经在：签名是 `(index, seen: ModelStreamEvent[]) => boolean`，
   * 形状适配器认真实现了它（有显式 stop 事件就用事件，没有就用
   * 「后继 index 已出现」），**而全仓零调用点**。
   *
   * 更要紧的是它不是"少了个消费者"，是**一份重复实现**：同一条闭合规则
   * 在 `shape-anthropic-messages/client.ts` 的 `assemble()` 里还有一份，
   * 读同一个 `hasExplicitBlockCloseEvent` 声明，而**那一份是活的**
   * （§8.4「未闭合的 Tool Call 不得转为 ProposedAction」靠它）。
   *
   * 两份同规则、一份没人调 —— 这正是本仓反复清理的形态：改活的那份时，
   * 死的那份不会有任何征兆地留在原地，下一个人读到它会以为规则在 Port 上。
   */
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
 * TranscriptStorePort —— 消息追加与重建。
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
 * RunStorePort —— Run 身份的持久化。
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
 * ToolHandlerPort —— 工具执行。
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
  /**
   * 随 AgentSpec 冻结的执行特权档位（ADR-0012）。
   *
   * 【定】与 `timezone` 同一条理由，也同一条纪律：**工具不得自己去读宿主
   * 的档位**（环境变量、全局单例、模块级 let）。那样的档位是 transcript
   * 之外的隐藏状态 —— 与阶段 3.5 拒绝持久 cwd 是同一形态，
   * 而这次那个隐藏状态决定的是「这次副作用有没有边界」。
   *
   * Runtime 传的是一个档位，**不理解它意味着什么**（同 `artifactChecks`）。
   * 沙箱怎么落地是 `tools/common/src/exec/` 的事，边界 grep 第 7 条守着。
   */
  executionPrivilege: ExecutionPrivilege;
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

/**
 * 产物内容。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】`Uint8Array` 这一档是 ADR-0010 加的，理由不是「顺便支持一下二进制」。
 *
 * 在此之前它只有 `string`，后果是**整条产物通道在类型层就装不下二进制**：
 * 一个 58MB 的 zip 交付物进不了 `artifacts` 表，于是
 * `deliveredArtifactIds` 恒空、`kind:"zip"` 那个检查器**没有任何生产者**
 * （实测 Run `run_75f0d6afafa6`：产物完全正确，而 Harness 手里零事实）。
 *
 * 【定】不要为了省事把二进制按字符串传。`artifact-store` 算的是
 * `sha256(content, "utf8")`，而第二层检查读的是**磁盘上那一份**的字节 ——
 * 二进制经一次 UTF-8 往返之后两者必然不等，`DELIVERABLE` 检查失败会按
 * §1.2 第 3 条结算 `FAILED`：**一个把交付物做对了的 Run 会被判成失败。**
 * ══════════════════════════════════════════════════════════════════════
 */
export type ArtifactContent = string | Uint8Array;

/** 工具产出的交付物。Runtime 拿它去 `ArtifactStorePort.register()`。 */
export interface ProducedArtifact {
  /** 逻辑身份，通常就是 workspace 内的相对路径。同一个 logicalId 形成版本链。 */
  logicalId: string;
  role: ArtifactRole;
  /** 产物类型，决定跑哪些检查器（json / zip / binary / text / …）。 */
  kind: string;
  path?: string;
  content: ArtifactContent;
  /**
   * 执行前同名文件的字节数。**这个产物不是新建的，是在别人身上改出来的。**
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】不存在就**不带这个字段**。`undefined` 与 `0` 是两件事 ——
   * 后者说的是「执行前那里有一个空文件」。
   *
   * ── 它为什么值得单独存在（Run `run_18c20267c1a1` 实测）────────────────
   *
   * `run_shell` 早就在 `artifactNote` 里说了这句话，而且说得很准：
   *
   *     交付物 images.zip 覆盖了执行前就存在的同名文件（6256678 → 6412214 字节）
   *
   * 模型正是看到它之后才发现 `zip` 把上一个 Run 留下的 49 个文件**追加**进来了。
   * **引导面是有效的，缺的是这条事实只活在 tool result 的文本里** ——
   * 人在 Trace、事件流、界面上一个字都查不到。
   *
   * 而它撑着的问题是事后追查时最要紧的那个：**这个交付物是新建的，
   * 还是在一个来历不明的旧文件上改出来的？** 形态与 ADR-0011 那批修过的
   * `riskFacts` / `dataMovement` 一字不差：一条撑着结论的依据从未离开过
   * 产生它的那个函数。
   *
   * 【定】它是**审计事实**，不是结算依据 —— 覆盖一个已存在文件完全合法
   * （重新打包就是），所以它只上事件，不参与 outcome 判定。
   * ══════════════════════════════════════════════════════════════════════
   */
  replacedBytes?: number;
}

/**
 * RedactionPort —— 边界脱敏。
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
 * EffectResolverPort —— 把 Tool 参数解析为可信 EffectScope。
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
 * 受信任 Resolver —— `effectResolution.kind === "RESOLVER"` 那一档的实现形状。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】这里只有**类型**，实现必须来自 `tools/`，由 Composition Root 注入。
 *
 * 边界 4（Runtime 不得 import 任何工具实现）在这一条上最容易破：
 * 「把命令解析写进 `action/` 反正它是 Runtime 的一部分」是最自然的写法，
 * 而那等于让 Runtime 认识 shell 语法 —— 与认识工具名是同一种越界，
 * 只是 `grep -rnE "@workagent/tools-|tools/common" packages` 抓不到它。
 *
 * ── 为什么需要这一档（§12.4 原话）─────────────────────────────────────
 *
 * 「文件路径、Shell、Browser、批量操作必须使用受信任 Resolver。」
 * DECLARATIVE 那一档靠 JSON Pointer 指向输入里的目标字段，而**一条 shell
 * 命令的作用域读不出任何一个字段** —— `zip -r out.zip src` 的作用域既不是
 * `/command` 这个字符串本身，也不在任何单独的参数里，它要靠解析才能得出。
 * ══════════════════════════════════════════════════════════════════════
 */
export interface TrustedEffectResolver {
  resolve(normalizedInput: JsonValue, workspaceRoot: string): ResolvedEffect;
}

/**
 * VerificationPort —— 独立验证外部世界是否达到目标。
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

/**
 * ClockPort —— 时间与可打断的等待。
 *
 * 【定】这里**没有** FakeClock。它写在 V05 §24.2 里，但全仓零使用者，
 * 2026-08-31 连同 `DeterministicIdGenerator` 一起删了 —— 验收脚本用的是
 * 真时钟 ＋ 可控慢的工具。这条注释此前写着「测试注入 FakeClock」，
 * 而 `testkit/clock/index.ts` 的文件头同时写着「这里没有 FakeClock」：
 * 同一件事两处相反的说法，读的人只会记住先看到的那句。
 */
export interface ClockPort {
  now(): number;
  /**
   * 等 `ms` 毫秒，或等到 `signal` 被 abort —— **两种情况都正常返回，不抛**。
   *
   * 【定】打断时 resolve 而不是 reject。理由见 `SystemClock.sleep` 的实现注释：
   * 唯一的消费者在 `run-loop` 的 catch 块里 await 它，一个 AbortError 会
   * 穿过整个 generator，绕过 `finish()` 与具名 Terminal（循环纪律第 2 条）。
   * 判「有没有被取消」一律读 signal，不读这个函数的返回方式。
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * IdGeneratorPort —— id 分配。
 *
 * 【定】这里**没有**确定性实现。「Replay 要能逐字节一致」的理由成立，
 * 但 Replay 至今没做，`DeterministicIdGenerator` 全仓零使用者，已于
 * 2026-08-31 删除。真做 Replay 的那天第一步是写比对器，不是先摆一个没人调的
 * 生成器 —— 见 `testkit/id-generator/index.ts` 的文件头。
 */
export interface IdGeneratorPort {
  next(prefix: string): string;
}

/** TraceSinkPort —— 事件消费。CLI 写 JSONL，Web 入口转成 SSE。 */
export interface TraceSinkPort {
  emit(event: RunEvent): void;
}

/**
 * ModelInvocationAuditStorePort —— Provider I/O 的独立、追加式事实源。
 *
 * 强制它的不变量：完整请求与原始 Provider 流不得进入 transcript、SQLite 或
 * 主 Trace；同时任何审计 I/O 故障都不得改变模型调用与 Run 的结果。
 */
export interface ModelInvocationAuditStorePort {
  open(start: ModelInvocationAuditStart): ModelInvocationAuditWriter;
}

/**
 * BlobStorePort —— 大结果外置（阶段 3，§11.4）。
 *
 * 强制它的不变量：**§11.5 不变量 5 —— 外置必须保留协议合法的结构化 stub**，
 * 以及 §16.1 的上下文预算（超过 `inlineToolResultLimitTokens` 的结果不得
 * 原样进帧）。
 *
 * 【定】它同时是数据最小化机制 —— 外置的内容不进模型也就不出境（V05 §22.7）。
 *
 * ── 它为什么是被真需求逼出来的 ────────────────────────────────────────
 *
 * `read_file` 与 `fetch_url` 会产出超过 `inlineToolResultLimitTokens` 的结果。
 * 顺序是先建工具面，让机制被真需求逼出来 —— 而不是先实现 Port 再找用例。
 *
 * ── 【定】`get` 必须支持分页 ────────────────────────────────────────────
 *
 * 只有 `put` / `get(ref): string` 的话，取回一个 500KB 的 blob 会把它整个
 * 灌回上下文 —— 那就把刚刚外置掉的东西又搬了回来。分页语义与 `read_file`
 * 保持一致（按行、显式 truncated），这样模型在两个工具之间不需要换脑子。
 */
export interface BlobStorePort {
  /** 内容寻址：同一份内容只存一份，但每次调用得到自己的 ref。 */
  put(content: string): Promise<{ ref: string; hash: string; size: number }>;
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
 * ArtifactStorePort —— Artifact 登记、版本链与 lineage（阶段 3，§17）。
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
 *
 * 【定】**没有 Tombstone、没有 lineage** —— 全仓既没有删除产物的路径，
 * 也没有任何工具填过 `derivedFrom`。一个永远为空的 lineage 字段
 * 会让读代码的人以为派生关系是被记录的。真出现用例时再加。
 */
export interface ArtifactStorePort {
  register(input: ArtifactRegistration): Promise<ArtifactRecord>;
  /** 【定】带 detail —— 只记 ok 的话，「为什么没通过」在结算时无从引用。 */
  markVerified(artifactId: string, ok: boolean, detail: string): Promise<void>;
  get(artifactId: string): Promise<ArtifactRecord | undefined>;
  listByRun(runId: RunId): Promise<ArtifactRecord[]>;
}

/**
 * 产物在本次 Run 里的角色。**它决定检查失败时的 outcome 映射**（§1.2 第 3 条）：
 *
 *   DELIVERABLE  → 检查失败结算 `FAILED`
 *   INTERMEDIATE → 检查失败结算 `COMPLETED_WITH_LIMITS` ＋ 具名 incompleteItems
 *
 * 【定】两者必须可区分。一律降级为 COMPLETED_WITH_LIMITS 会让
 * 「交付物是坏的」和「某个中间步骤有瑕疵」在 outcome 上看不出差别。
 */
export type ArtifactRole = "DELIVERABLE" | "INTERMEDIATE";

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
  /** 【定】字节这一档见 `ArtifactContent` —— 按字符串传二进制会把 Run 判成 FAILED。 */
  content: ArtifactContent;
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
  /** 调用级原始请求/返回 sidecar；Runtime 只写，不从中恢复。 */
  modelAudit: ModelInvocationAuditStorePort;
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
 * ArtifactCheckerPort —— 产物**类型**的静态结构约束（§10.4 第二层）。
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
  /**
   * 【定】`content` 是**工具交上来的那一份**，而第 ① 项检查读的是**磁盘上那一份**。
   * 两次独立取数不一致就红 —— 这是这道闸门有判别力的全部来源，
   * 不要改成拿 `content` 重算 hash 去比 `record.contentHash`（同源，恒真）。
   */
  check(record: ArtifactRecord, content: ArtifactContent): Promise<ArtifactCheckOutcome>;
}

export interface ArtifactCheckOutcome {
  ok: boolean;
  /** 跑了哪些检查。**没有适用检查时为空数组** —— 那与「全部通过」不同。 */
  checksRun: string[];
  detail: string;
}
