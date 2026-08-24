/**
 * Runtime Ports（V05 §8.7）。共 14 个。
 *
 * D-14：阶段 1 实现 10 个（标 ★），4 个只留接口。
 * 四个不实现的共同点：阶段 1 没有任何用例能检验它们设计得对不对，实现了也是盲写。
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
import type { ModelUsage } from "../types/run.js";
import type {
  EffectResolutionDescriptor,
  ExecutionAttempt,
  PreparedAction,
  ResolvedEffect,
  ToolDefinition,
  VerificationResult,
} from "../types/tool.js";
import type { JsonValue, RunId } from "../types/ids.js";

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
  lastSequence(runId: RunId): Promise<number>;
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
}

export interface ToolExecutionOutcome {
  ok: boolean;
  output: string;
  error?: RuntimeErrorRecord;
  sideEffectState: ExecutionAttempt["sideEffectState"];
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

// ═════════════════════════════════════════ 阶段 1 只留接口，不实现（4）

/**
 * CapabilityLeasePort —— 并发保护（EXCLUSIVE / KEYED lease，含 PARKED）。
 * 不实现的理由：lease 语义要到 Browser Capability 才有真需求（阶段 3）。
 */
export interface CapabilityLeasePort {
  acquire(key: string, runId: RunId): Promise<{ leaseId: string }>;
  release(leaseId: string): Promise<void>;
  park(leaseId: string, interactionId: string): Promise<void>;
  unpark(leaseId: string): Promise<void>;
}

/**
 * ArtifactStorePort —— Artifact 登记与 lineage。
 * 不实现的理由：阶段 1 Micro Case 不产出 Artifact。
 */
export interface ArtifactStorePort {
  register(input: unknown): Promise<{ artifactId: string }>;
  markVerified(artifactId: string, ok: boolean): Promise<void>;
}

/**
 * BlobStorePort —— 大结果外置。
 * 不实现的理由：大结果外置要到 Case 01 才有真实的大结果（阶段 3）。
 * 注：它同时是数据最小化机制 —— 外置的内容不进模型也就不出境（V05 §22.7）。
 */
export interface BlobStorePort {
  put(content: string): Promise<{ ref: string; hash: string; size: number }>;
  get(ref: string): Promise<string>;
}

/**
 * SecretResolverPort —— Secret 明文的短暂解析。
 * 不实现的理由：阶段 1 没有需要 secret 的工具。
 * 注意端点凭证不走这里 —— 它由 Composition Root 直接注入形状适配器（阶段 3 再收口）。
 */
export interface SecretResolverPort {
  resolve(ref: string): Promise<string>;
}

// ══════════════════════════════════════════════════════════ 装配

export interface RuntimePorts {
  model: ModelPort;
  protocol: ModelProtocolPort;
  transcript: TranscriptStorePort;
  tools: ToolHandlerPort;
  redaction: RedactionPort;
  effects: EffectResolverPort;
  verification: VerificationPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  trace: TraceSinkPort;
}
