/**
 * Anthropic Messages 形状适配器（V05 §8.6、§8.7）。
 *
 * D-07 的代码形态：每个方法的左边来自形状，右边来自端点能力声明。
 *
 *   buildRequest      形状提供请求结构      端点提供常量
 *   validateFrame     形状提供协议规则      端点提供校验强度
 *   protocolRoleOf    形状提供载体          端点提供约束档位
 *   countTokens       形状提供端点路径      端点提供精度
 *   classifyError     —                    端点提供判别式
 *   isBlockClosed     形状提供事件          端点提供有无
 *
 * 【定】本文件不得出现任何具体端点的名字或行为常量。
 * 「百炼会不会校验配对」不是这里的知识，是 profile 的数据。
 */

import type {
  ContextFrame,
  ContextItem,
  EndpointCapabilityProfile,
  FrameValidation,
  ModelProtocolPort,
  ModelRequest,
  ModelStreamEvent,
  RuntimeErrorRecord,
  TokenCount,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { makeError } from "@workagent/harness-runtime";

export interface AnthropicProtocolDeps {
  profile: EndpointCapabilityProfile;
  tools: ToolSnapshot[];
  systemPrompt: string;
  /** 端点的 count_tokens 调用。没有该能力时传 undefined。 */
  countTokensFn?: (body: unknown) => Promise<number>;
  maxOutputTokens: number;
}

export function createAnthropicProtocol(deps: AnthropicProtocolDeps): ModelProtocolPort {
  return new AnthropicMessagesProtocol(deps);
}

class AnthropicMessagesProtocol implements ModelProtocolPort {
  readonly profile: EndpointCapabilityProfile;

  constructor(private readonly deps: AnthropicProtocolDeps) {
    this.profile = deps.profile;
  }

  // ───────────────────────────────────────────────────── buildRequest

  buildRequest(frame: ContextFrame): ModelRequest {
    const messages = toAnthropicMessages(frame.items);

    const body: Record<string, unknown> = {
      model: this.profile.modelId,
      max_tokens: frame.reservedOutputTokens || this.deps.maxOutputTokens,
      system: this.deps.systemPrompt,
      messages,
      stream: true,
    };

    if (this.deps.tools.length > 0) {
      body["tools"] = this.deps.tools.map((t) => ({
        name: t.definition.name,
        description: t.definition.description,
        input_schema: t.definition.inputSchema,
      }));
    }

    // 端点声明说这个开关有效时才发。无效时发它没有坏处但也没有意义 ——
    // 实测四端点全部静默接受，三个不生效，没有一个会告诉你「我不支持」。
    // 串行由 Runtime 自持保证（D-01），这里只是可有可无的加成。
    if (this.profile.protocol.honorsDisableParallelToolCalls) {
      body["tool_choice"] = { type: "auto", disable_parallel_tool_use: true };
    }

    return { body, modelId: this.profile.modelId };
  }

  // ───────────────────────────────────────────────────── countTokens

  async countTokens(frame: ContextFrame): Promise<TokenCount> {
    if (this.profile.tokens.hasCountTokensEndpoint && this.deps.countTokensFn) {
      const body = this.buildRequest(frame).body as Record<string, unknown>;
      // count_tokens 端点不接受 stream / max_tokens
      const { stream: _s, max_tokens: _m, ...countable } = body;
      try {
        const tokens = await this.deps.countTokensFn(countable);

        /**
         * 端点声明 count_tokens 不算推理块时，本地补一个估算（D-3）。
         *
         * 实测（probe:reasoning-tokens，2026-08-25）：同一个 body 加不加 thinking 块，
         * count_tokens 返回 765 / 765 —— 差 0，端点对推理块完全视而不见；
         * 而同一 body 的真实 inference usage.input_tokens 是 888。
         *
         * 【定】不补的话，返回值对含推理块的帧是**下界而非实际值**，
         * 而 Context 阈值判定拿它当实际值用 —— 实跑里 4 轮就低估了 393 token，
         * 且随轮次放大。宁可估得糙，也不能让阈值基准系统性偏向「还够用」那一侧。
         *
         * 补完之后精度降级为 ESTIMATED：这一帧的数已经不是端点给的了。
         */
        const reasoning = this.profile.tokens.countTokensExcludesReasoning
          ? estimateReasoningTokens(frame)
          : 0;

        return {
          tokens: tokens + this.profile.tokens.perRequestBaseTokens + reasoning,
          accuracy:
            this.profile.tokens.countTokensAccuracy === "EXACT" && reasoning === 0
              ? "EXACT"
              : "ESTIMATED",
        };
      } catch {
        // 端点侧失败时退回本地估算，而不是让整个帧编译失败。
      }
    }
    return { tokens: estimateTokens(frame) + this.profile.tokens.perRequestBaseTokens, accuracy: "ESTIMATED" };
  }

  // ──────────────────────────────────────────────────── validateFrame

  /**
   * 【定】不管端点校验强度如何，Runtime 一律自己校验。
   *
   * 端点声明只影响「违规会不会被外部发现」，不影响「Runtime 要不要自己保证」。
   * 选定端点上 validatesToolResultPairing = false —— 缺 result 会被 200 放行，
   * 模型于是看到一个失真的世界，而且没有任何东西会告诉你。
   */
  validateFrame(frame: ContextFrame): FrameValidation {
    const violations: string[] = [];

    const calls = new Map<string, string>();
    const results = new Set<string>();
    for (const item of frame.items) {
      const c = item.content;
      if (!c) continue;
      if (c.type === "tool_call") calls.set(c.toolCallId, c.name);
      if (c.type === "tool_result") {
        if (results.has(c.toolCallId)) {
          violations.push(`tool_call_id ${c.toolCallId} 有多于一个 result（不变量 8）`);
        }
        results.add(c.toolCallId);
      }
    }

    for (const [id, name] of calls) {
      if (!results.has(id)) {
        violations.push(`tool_call ${id}（${name}）没有 result（不变量 8）`);
      }
    }
    for (const id of results) {
      if (!calls.has(id)) {
        violations.push(`tool_result ${id} 没有对应的 tool_call —— 锚点错配`);
      }
    }

    // 端点要求推理块必须存在时，检查每个含 tool_call 的 assistant 回合是否带了块。
    if (this.profile.context.reasoningBlockRule !== "DROPPABLE") {
      const assistantTurns = groupAssistantTurns(frame.items);
      for (const turn of assistantTurns) {
        const hasToolCall = turn.some((i) => i.content?.type === "tool_call");
        const hasReasoning = turn.some((i) => i.content?.type === "reasoning");
        if (hasToolCall && !hasReasoning) {
          violations.push(
            `assistant 回合含 tool_call 但缺推理块。当前端点 reasoningBlockRule=` +
              `${this.profile.context.reasoningBlockRule}，块本身不得消失。`,
          );
        }
      }
    }

    return { ok: violations.length === 0, violations };
  }

  // ─────────────────────────────────────────────────── protocolRoleOf

  /**
   * 档位由端点能力声明给出，不由 Context 模块推断（V05 §11.2）。
   *
   * 这一行是整个 §8.6 是否落地的判据：换一个 reasoningBlockRule 不同的 profile，
   * Context 层的行为必须改变，而主循环代码一个字不动。
   */
  protocolRoleOf(item: ContextItem): ContextItem["protocolRole"] {
    const c = item.content;
    if (!c) return "ORDINARY";

    if (c.type === "tool_call" || c.type === "tool_result") {
      return "PROTOCOL_GROUP_MEMBER";
    }

    if (c.type === "reasoning") {
      switch (this.profile.context.reasoningBlockRule) {
        case "DROPPABLE":
          return "ORDINARY";
        case "PLACEHOLDER_REQUIRED":
          return "PLACEHOLDER_REQUIRED";
        case "VERBATIM_REQUIRED":
          return "REQUIRED_VERBATIM";
      }
    }

    return "ORDINARY";
  }

  // ─────────────────────────────────────────────────── classifyError

  /**
   * 判别式来自端点声明。四个端点没有任何两个可以共用一张表 ——
   * 选定端点连 type / code 字段都没有，只能 HTTP_STATUS + MESSAGE_MATCH。
   */
  classifyError(err: unknown): RuntimeErrorRecord {
    const e = err as { status?: number; message?: string; name?: string } | undefined;
    const status = e?.status;
    const message = String(e?.message ?? err ?? "unknown");
    const discriminators = this.profile.errors?.discriminators ?? ["HTTP_STATUS", "MESSAGE_MATCH"];

    // SDK 自己拦截的错误（没有 status）。实测：max_tokens 过大被 SDK 拦下，
    // 根本没发出请求。归到 MODEL_PROVIDER 会让 retryability 判断出错 —— 重试多少次都没用。
    if (status === undefined && !/fetch|network|socket|ECONN|timeout/i.test(message)) {
      return makeError({
        code: "MODEL_SDK_REJECTED",
        source: "MODEL_SDK",
        category: "VALIDATION",
        retryability: "NEVER",
        sideEffectState: "NOT_STARTED",
        safeMessage: `SDK 在发出请求前拒绝：${message.slice(0, 200)}`,
        endpointId: this.profile.endpointId,
      });
    }

    const useMessage = discriminators.includes("MESSAGE_MATCH");

    if (status === 401 || status === 403) {
      return makeError({
        code: "MODEL_AUTH",
        source: "MODEL_PROVIDER",
        category: status === 401 ? "AUTHENTICATION" : "AUTHORIZATION",
        retryability: "NEVER",
        sideEffectState: "NO_EFFECT",
        safeMessage: `端点拒绝凭证（HTTP ${status}）`,
        endpointId: this.profile.endpointId,
      });
    }

    if (status === 429) {
      // 配额与限流处置完全不同：前者可能要等很久或换端点，后者退避重试即可。
      const isQuota = useMessage && /quota|insufficient|billing|balance/i.test(message);
      return makeError({
        code: isQuota ? "MODEL_QUOTA" : "MODEL_RATE_LIMIT",
        source: "MODEL_PROVIDER",
        category: isQuota ? "QUOTA" : "RATE_LIMIT",
        retryability: isQuota ? "AFTER_USER_ACTION" : "SAME_INPUT_BACKOFF",
        sideEffectState: "NO_EFFECT",
        safeMessage: `${isQuota ? "配额耗尽" : "触发限流"}（HTTP 429）：${message.slice(0, 160)}`,
        endpointId: this.profile.endpointId,
      });
    }

    if (status !== undefined && status >= 500) {
      return makeError({
        code: "MODEL_UNAVAILABLE",
        source: "MODEL_PROVIDER",
        category: "UNAVAILABLE",
        retryability: "SAME_INPUT_BACKOFF",
        sideEffectState: "UNKNOWN",
        safeMessage: `端点暂不可用（HTTP ${status}）`,
        endpointId: this.profile.endpointId,
      });
    }

    if (status === 400) {
      const isContext = useMessage && /context|too long|token.*exceed|length/i.test(message);
      return makeError({
        code: isContext ? "MODEL_CONTEXT_TOO_LONG" : "MODEL_BAD_REQUEST",
        source: "MODEL_PROVIDER",
        category: isContext ? "CAPACITY" : "PROTOCOL",
        retryability: isContext ? "AFTER_ENVIRONMENT_CHANGE" : "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `请求被拒绝（HTTP 400）：${message.slice(0, 200)}`,
        endpointId: this.profile.endpointId,
      });
    }

    return makeError({
      code: "MODEL_UNKNOWN",
      source: status === undefined ? "RUNTIME" : "MODEL_PROVIDER",
      category: "UNKNOWN",
      retryability: "SAME_INPUT_BACKOFF",
      sideEffectState: "UNKNOWN",
      safeMessage: `未分类的模型错误${status ? `（HTTP ${status}）` : ""}：${message.slice(0, 200)}`,
      endpointId: this.profile.endpointId,
    });
  }

  // ─────────────────────────────────────────────────── isBlockClosed

  /**
   * 闭合判据。形状提供事件，端点提供有无。
   *
   * 有 content_block_stop 时直接判定；没有时退回「后继 index 出现 ⟹ 前一 index 已闭合」
   * —— 这是 Spike P3 从 OpenAI 形状里逼出来的判据，比「参数 JSON 能否解析」更强。
   */
  isBlockClosed(index: number, seen: ModelStreamEvent[]): boolean {
    if (this.profile.context.hasExplicitBlockCloseEvent) {
      return seen.some((e) => e.type === "block_stop" && e.index === index);
    }
    return seen.some(
      (e) => (e.type === "block_start" || e.type === "tool_input_delta") && e.index > index,
    );
  }
}

// ══════════════════════════════════════════════════════════ 翻译层

/**
 * ContextItem[] → Anthropic messages。
 *
 * Anthropic 形状的一个结构约束：tool_result 必须放在 user 消息里，
 * 而 tool_use 在 assistant 消息里。翻译在这里完成，Context 层不需要知道。
 */
function toAnthropicMessages(items: ContextItem[]): unknown[] {
  const messages: Array<{ role: string; content: unknown[] }> = [];

  for (const item of items) {
    const c = item.content;
    if (!c) continue;
    if (item.kind === "SYSTEM_INSTRUCTION") continue; // system 走顶层字段

    const role = roleOf(item);
    const block = toBlock(c);
    if (!block) continue;

    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      messages.push({ role, content: [block] });
    }
  }

  return messages;
}

function roleOf(item: ContextItem): "user" | "assistant" {
  const c = item.content;
  if (c?.type === "tool_result") return "user";
  switch (item.kind) {
    case "ASSISTANT_MESSAGE":
    case "MODEL_REASONING":
    case "MODEL_TOOL_CALL":
      return "assistant";
    default:
      return "user";
  }
}

function toBlock(c: NonNullable<ContextItem["content"]>): unknown | null {
  switch (c.type) {
    case "text":
      return c.text.length > 0 ? { type: "text", text: c.text } : null;
    case "reasoning":
      return { type: "thinking", thinking: c.text, signature: c.signature ?? "" };
    case "tool_call":
      return { type: "tool_use", id: c.toolCallId, name: c.name, input: c.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: c.toolCallId,
        content: c.content,
        is_error: c.isError,
      };
  }
}

/** 把连续的 assistant 项分组成「回合」，用于推理块占位检查。 */
function groupAssistantTurns(items: ContextItem[]): ContextItem[][] {
  const turns: ContextItem[][] = [];
  let cur: ContextItem[] = [];
  for (const item of items) {
    if (roleOf(item) === "assistant") {
      cur.push(item);
    } else if (cur.length > 0) {
      turns.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) turns.push(cur);
  return turns;
}

/** 本地估算。仅在端点无 count_tokens 或调用失败时使用，误差未经实测。 */
function estimateTokens(frame: ContextFrame): number {
  let chars = 0;
  for (const item of frame.items) {
    const c = item.content;
    if (!c) continue;
    if (c.type === "text" || c.type === "reasoning") chars += c.text.length;
    else if (c.type === "tool_call") chars += c.name.length + JSON.stringify(c.input).length;
    else if (c.type === "tool_result") chars += c.content.length;
  }
  // 中英混排的粗略系数。标记为 ESTIMATED，调用方据此放宽阈值。
  return Math.ceil(chars / 2.5) + frame.fixedOverheadTokens;
}

/**
 * 帧内推理块的 token 估算，只在端点声明 count_tokens 排除推理块时使用（D-3）。
 *
 * 系数 1.9 不是 2.5，是实测反推的：229 字符的中文推理文本，端点按 123 token 计费
 * （888 − 765），229 / 123 ≈ 1.86。上面 estimateTokens() 的 2.5 是中英混排的粗系数，
 * 推理块在实跑里几乎全是中文，用 2.5 会低估约 25% —— 而这个数是要拿去顶
 * 阈值判定的，宁可偏保守。
 *
 * 【端点】这个系数对应中文为主的推理内容。换语种或换模型都可能不成立，
 * 所以它待在形状适配器里，不进 Runtime。
 */
function estimateReasoningTokens(frame: ContextFrame): number {
  let chars = 0;
  for (const item of frame.items) {
    if (item.content?.type === "reasoning") chars += item.content.text.length;
  }
  return Math.ceil(chars / 1.9);
}
