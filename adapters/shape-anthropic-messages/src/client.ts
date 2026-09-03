/**
 * ModelPort 实现：Anthropic Messages 形状的网络调用与流式传输。
 *
 * 这是全仓库唯一允许 import @anthropic-ai/sdk 的地方（V05 §4.2 禁止项）。
 * 判据：grep -r "@anthropic-ai/sdk" packages/ apps/ cases/ 必须无结果。
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  EndpointCapabilityProfile,
  ModelContent,
  ModelInvocationObserver,
  ModelInvocationResult,
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
  ModelUsage,
  ProviderFailureObservation,
  UsageFieldKey,
} from "@workagent/harness-runtime";
import { assertCredentialGoesWhereIntended } from "./credential-guard.js";
import { readAnthropicErrorFacts } from "./error-facts.js";

export interface AnthropicClientDeps {
  baseUrl: string;
  apiKey: string;
  profile: EndpointCapabilityProfile;
  timeoutMs?: number;
}

export function createAnthropicModelPort(deps: AnthropicClientDeps): ModelPort {
  // 【定】启动前断言，不是出错后记录。凭证越界在 Spike 0 期间真实发生过一次。
  assertCredentialGoesWhereIntended({
    baseUrl: deps.baseUrl,
    apiKey: deps.apiKey,
    endpointId: deps.profile.endpointId,
  });

  const client = new Anthropic({
    apiKey: deps.apiKey,
    baseURL: deps.baseUrl,
    timeout: deps.timeoutMs ?? 180_000,
    maxRetries: 0, // 重试由 Runtime 按 retryability 决定，不交给 SDK 盲重
  });

  return new AnthropicModelPort(client, deps.profile);
}

class AnthropicModelPort implements ModelPort {
  constructor(
    private readonly client: Anthropic,
    private readonly profile: EndpointCapabilityProfile,
  ) {}

  async *invoke(
    request: ModelRequest,
    signal: AbortSignal,
    observer: ModelInvocationObserver,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult> {
    const blocks = new Map<number, PartialBlock>();
    let stopReason = "";
    let usage: ModelUsage = emptyUsage();
    let interrupted = false;

    try {
      const response = await this.client.messages.create(
        request.body as Anthropic.MessageCreateParamsStreaming,
        { signal },
      ).withResponse();
      const stream = response.data;
      observer.responseMetadata({
        status: response.response.status,
        ...(typeof response.request_id === "string" ? { requestId: response.request_id } : {}),
      });

      for await (const ev of stream as AsyncIterable<Record<string, any>>) {
        // SDK 解码后的 Provider 事件必须先离开适配器，之后才能按端点声明归一化。
        // ping 被 SDK 丢弃；流内 SSE error 由 catch 记录为独立 provider_error。
        observer.providerEvent(ev);
        switch (ev["type"]) {
          case "message_start": {
            usage = mergeUsage(usage, readUsagePartial(ev["message"]?.usage, this.profile), this.profile);
            break;
          }
          case "content_block_start": {
            const idx = Number(ev["index"]);
            const b = ev["content_block"] ?? {};
            blocks.set(idx, {
              type: String(b["type"] ?? "text"),
              text: "",
              toolCallId: b["id"] ? String(b["id"]) : undefined,
              toolName: b["name"] ? String(b["name"]) : undefined,
              partialJson: "",
              closed: false,
            });
            /**
             * 【定】这里**不再 yield `block_start`**。
             *
             * 块的形态与闭合状态全部记在上面这个 `blocks` Map 里，由
             * `assemble()` 消费；而那四个块级流事件（block_start / block_stop /
             * tool_input_delta / reasoning_delta）在 Runtime 侧**一个消费者都没有**
             * —— 唯一读过它们的是同样没人调的 `ModelProtocolPort.isBlockClosed`。
             * 见 `ports/index.ts` 里 `ModelStreamEvent` 的说明。
             */
            break;
          }
          case "content_block_delta": {
            const idx = Number(ev["index"]);
            const block = blocks.get(idx);
            if (!block) break;
            const d = ev["delta"] ?? {};
            if (d["type"] === "text_delta") {
              const t = String(d["text"] ?? "");
              block.text += t;
              yield { type: "text_delta", text: t };
            } else if (d["type"] === "thinking_delta") {
              // 推理增量照常累进块里（`assemble()` 会把它产出成 reasoning 内容），
              // 但**不 yield** —— 全仓没有推理流的消费者。见上面 block_start 那段。
              block.text += String(d["thinking"] ?? "");
            } else if (d["type"] === "signature_delta") {
              block.signature = (block.signature ?? "") + String(d["signature"] ?? "");
            } else if (d["type"] === "input_json_delta") {
              // 同上：参数 JSON 增量只累进块里，闭合与解析由 `assemble()` 做。
              block.partialJson += String(d["partial_json"] ?? "");
            }
            break;
          }
          case "content_block_stop": {
            // 【定】闭合**必须**记进块里 —— `assemble()` 的
            // 「未闭合的 Tool Call 不得转为 ProposedAction」（§8.4）读的就是它。
            // 不再 yield `block_stop`：那个事件零消费者，见上面 block_start 那段。
            const block = blocks.get(Number(ev["index"]));
            if (block) block.closed = true;
            break;
          }
          case "message_delta": {
            stopReason = String(ev["delta"]?.stop_reason ?? stopReason);
            const u = ev["usage"];
            // 【定】只覆盖这条消息里**实际出现**的字段。
            // message_delta 通常只带累计 output_tokens；整体 spread 一个补 0 的
            // 完整对象，会把 message_start 拿到的 input / cache 两项抹成 0，
            // 进而让 §19.3 的计费公式与 maxInputTokens 预算同时归零。
            if (u) usage = mergeUsage(usage, readUsagePartial(u, this.profile), this.profile);
            break;
          }
        }
      }
    } catch (err) {
      // Abort 是预期路径，不是异常。半截内容按 §8.4 处置：
      // 未闭合的 tool call 不得转为 ProposedAction。
      if (signal.aborted || (err as { name?: string })?.name === "AbortError") {
        interrupted = true;
      } else {
        observer.providerFailure(providerFailureOf(err));
        throw err;
      }
    }

    /**
     * Anthropic SDK 在底层响应因 AbortSignal 关闭时不保证抛 AbortError：
     * 某些流会直接让 async iterator 正常结束。只在 catch 里置 interrupted，
     * 就会把已经 abort、只收到完整前缀的半截流误报成 COMPLETED。
     * signal 是这次调用是否被中断的权威事实，迭代结束后必须再对一次。
     */
    if (signal.aborted) interrupted = true;

    return assemble(blocks, stopReason, usage, interrupted, this.profile);
  }

  async countTokens(request: ModelRequest): Promise<number | undefined> {
    if (!this.profile.tokens.hasCountTokensEndpoint) return undefined;
    try {
      const r = (await this.client.messages.countTokens(
        request.body as Anthropic.MessageCountTokensParams,
      )) as { input_tokens?: number };
      return r.input_tokens;
    } catch {
      return undefined;
    }
  }
}

function providerFailureOf(error: unknown): ProviderFailureObservation {
  const facts = readAnthropicErrorFacts(error);
  return {
    kind: facts.providerResponded ? "PROVIDER" : "TRANSPORT",
    name: facts.name,
    message: facts.message,
    ...(facts.status === undefined ? {} : { status: facts.status }),
    ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
    ...(facts.errorBody === undefined ? {} : { errorBody: facts.errorBody }),
  };
}

interface PartialBlock {
  type: string;
  text: string;
  signature?: string;
  toolCallId?: string;
  toolName?: string;
  partialJson: string;
  closed: boolean;
}

function assemble(
  blocks: Map<number, PartialBlock>,
  stopReason: string,
  usage: ModelUsage,
  interrupted: boolean,
  profile: EndpointCapabilityProfile,
): ModelInvocationResult {
  const content: ModelContent[] = [];
  const toolCalls: ModelInvocationResult["toolCalls"] = [];

  const indices = [...blocks.keys()].sort((a, b) => a - b);
  for (const idx of indices) {
    const b = blocks.get(idx)!;

    // 闭合判据：有显式事件时用事件，没有时用「后继 index 已开始」。
    const closed = profile.context.hasExplicitBlockCloseEvent
      ? b.closed
      : indices.some((i) => i > idx);

    if (b.type === "thinking") {
      // 推理块的保留策略由端点声明决定，这里只负责如实产出。
      content.push({ type: "reasoning", text: b.text, signature: b.signature ?? "" });
    } else if (b.type === "text") {
      if (b.text.length > 0) content.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      // 【定】未闭合的 Tool Call 不得转为 ProposedAction（V05 §8.4）。
      if (!closed) continue;
      let input: unknown = {};
      try {
        input = b.partialJson.length > 0 ? JSON.parse(b.partialJson) : {};
      } catch {
        continue; // 参数 JSON 不完整，同样不得转为 Action
      }
      const id = b.toolCallId ?? `toolu_missing_${idx}`;
      const name = b.toolName ?? "unknown";
      content.push({ type: "tool_call", toolCallId: id, name, input });
      toolCalls.push({ toolCallId: id, name, input });
    }
  }

  return { content, toolCalls, stopReason, usage, interrupted };
}

/**
 * 只读出**这条消息里真实出现过**的 usage 字段。
 *
 * 「缺失」与「为 0」必须分开：Anthropic 形状把 usage 拆在 message_start 与
 * message_delta 两处发送，前者给 input / cache，后者通常只给累计 output。
 * 把缺失字段补成 0 再整体合并，等于用后一条抹掉前一条。
 */
export function readUsagePartial(
  u: Record<string, any> | undefined,
  p: EndpointCapabilityProfile,
): Partial<ModelUsage> {
  if (!u) return {};
  const map = p.tokens.usageFieldMap;
  const pick = (k: UsageFieldKey, fallback: string): number | undefined => {
    const field = map[k] ?? fallback;
    const raw = u[field] ?? u[fallback];
    return raw === undefined || raw === null ? undefined : Number(raw);
  };

  const out: Partial<ModelUsage> = {};
  const inputTokens = pick("inputTokens", "input_tokens");
  const outputTokens = pick("outputTokens", "output_tokens");
  const cacheCreation = pick("cacheCreationInputTokens", "cache_creation_input_tokens");
  const cacheRead = pick("cacheReadInputTokens", "cache_read_input_tokens");

  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (cacheCreation !== undefined) out.cacheCreationInputTokens = cacheCreation;
  if (cacheRead !== undefined) out.cacheReadInputTokens = cacheRead;
  return out;
}

/**
 * 合并一段 usage 增量。
 *
 * billedInputTokens 是派生字段，不参与合并 —— 每次都从合并后的原始字段重算。
 * 【定】只读 input_tokens 会在缓存命中时低估达 85%，命中时它只剩非缓存部分。
 */
export function mergeUsage(
  base: ModelUsage,
  patch: Partial<ModelUsage>,
  p: EndpointCapabilityProfile,
): ModelUsage {
  const merged: ModelUsage = { ...base, ...patch };
  const cacheRead = merged.cacheReadInputTokens ?? 0;
  const cacheCreation = merged.cacheCreationInputTokens ?? 0;
  merged.billedInputTokens =
    p.tokens.billedInputFormula === "INPUT_PLUS_CACHE"
      ? merged.inputTokens + cacheRead + cacheCreation
      : merged.inputTokens;
  return merged;
}

export function emptyUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, billedInputTokens: 0 };
}
