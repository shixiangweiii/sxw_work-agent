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
 *
 * （这张表此前还有一行 `isBlockClosed`。它删了 —— 那条规则的活实现在
 *  `client.ts` 的 `assemble()` 里，见本文件末尾那段说明。）
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
  RuntimeErrorRecord,
  TokenCount,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { makeError, renderToolResultForModel } from "@workagent/harness-runtime";
import { readAnthropicErrorFacts, type AnthropicErrorFacts } from "./error-facts.js";

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

    /**
     * ── U-9：主动前缀缓存 ────────────────────────────────────────────
     *
     * 在此之前全仓没有一处发 `cache_control`，profile 的 `cacheMatching`
     * 与 `supportsExplicitCacheBreakpoints` 两个字段除类型定义外零消费 ——
     * 评测报告记录的那 15% 命中率完全来自端点的**隐式**缓存，
     * Harness 从来没有主动做过任何事。
     *
     * 断点一：`tools` ＋ `system` 这一段。它**完全稳定** ——
     * 实测工具定义固定开销 540 token，加 system 约 640，一个 Run 内一字不变。
     *
     * 这也是为什么受信时间事实被刻意放成 messages[0] 而不是拼进 system
     * （见 context/compile.ts）：拼进去的话这个断点前面的内容每轮都变，
     * STRICT_PREFIX 下命中率直接归零。决 3 把它冻到执行段级之后，
     * 连 messages[0] 也在段内稳定了。
     *
     * ── 断点二：messages 末尾。【定】这里原先什么都不打，理由是错的 ─────────
     *
     * 原注释写的是「会长大的是 messages，而 messages 每轮都在变，
     * 打在那里没有意义」。**这条推理在 STRICT_PREFIX 下不成立**：
     * transcript 是**只追加**的，第 N 轮的 messages 是第 N+1 轮的严格前缀。
     * 「每轮都在变」把「尾部在增长」和「中间被改写」当成了同一件事，
     * 而前缀缓存要的恰恰只是前者。
     *
     * 2026-08-28 办公任务实跑给了量化代价：`cacheReadInputTokens` 在**每个 run 的
     * 每一次调用**上恒为 3405（就是 tools＋system 这一段），
     * `cacheCreationInputTokens` 恒为 0，而 `inputTokens` 从 230 涨到 71,334 ——
     * **对话部分一次都没进过缓存**。题 1 单次 run 累计 billed 420,784，
     * 而最终上下文只有约 75k：同一份内容被全价重计了约 5.6 倍，
     * 并直接拉长 prefill 时延，加剧墙钟撞墙。
     *
     * 【定】断点打在**最后一个 block** 上、每轮重建，不试图维持一个长命断点：
     * Compact 会回改历史（剥离推理块），前缀随之改变、缓存失效。
     * 这是固有代价 —— 也正是"每轮在末尾重新打一个"比"打一个就不动"更合适的原因：
     * 失效之后下一轮自动重新建立，不需要任何人去管理断点的生命周期。
     */
    const wantsBreakpoint = this.profile.context.supportsExplicitCacheBreakpoints === true;

    if (wantsBreakpoint && messages.length > 0) {
      const lastMsg = messages[messages.length - 1]!;
      const lastBlock = lastMsg.content[lastMsg.content.length - 1];
      if (lastBlock && typeof lastBlock === "object") {
        (lastBlock as Record<string, unknown>)["cache_control"] = { type: "ephemeral" };
      }
    }

    const body: Record<string, unknown> = {
      model: this.profile.modelId,
      max_tokens: frame.reservedOutputTokens || this.deps.maxOutputTokens,
      // 打了断点就得用 block 形式的 system —— 字符串形式挂不上 cache_control。
      system: wantsBreakpoint
        ? [
            {
              type: "text",
              text: this.deps.systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ]
        : this.deps.systemPrompt,
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
    const facts = readAnthropicErrorFacts(err);
    const status = facts.status;
    const message = facts.message || "unknown";
    const discriminators = this.profile.errors?.discriminators ?? ["HTTP_STATUS", "MESSAGE_MATCH"];

    /**
     * 没有 status 的错误 = SDK 侧，分两类，**默认方向很关键**。
     *
     * ── 原来的写法错在哪（N-4，二次评审 2026-08-27）──────────────────────
     *
     * 原判据是「没有 status 且消息不含 fetch|network|socket|ECONN|timeout
     * → SDK 发请求前拒绝 / NEVER」。而 Anthropic SDK 的连接错误消息是
     * **`"Connection error."`**（`APIConnectionError`，SDK 源码 core/error.js:76），
     * 上述关键词一个都不含（"connection" 不含子串 "econn"）。
     * 于是一次断网被判成「永不重试」，`run-loop` 直接 `MODEL_ERROR` 收尾。
     *
     * 更要命的是它和 `client.ts` 的 `maxRetries: 0` 互相拆台：那行注释写着
     * 「重试由 Runtime 按 retryability 决定，不交给 SDK 盲重」—— SDK 让出了
     * 自己的重试，而 Runtime 这边判 NEVER。两端都以为对方在管。
     *
     * ── 现在的形状 ────────────────────────────────────────────────────
     *
     * 判别式用**构造器名**而不是消息文案。类名是 SDK 的导出符号，改动会破坏
     * 使用方，比一句提示语稳定得多 —— ADR-0001 记过同一条教训：
     * 「解析文案的判据会在改一句提示语时静默失效」。
     * 消息关键词只作为兜底，覆盖非 SDK 抛出的裸 fetch / Node 错误。
     *
     * 【端点】这段不读端点声明：SDK 是形状层的东西，四个端点共用同一份 SDK。
     */
    if (status === undefined) {
      const ctor = facts.constructorName;

      // 我们自己 abort 的。不是故障，更不是「SDK 拒绝」——取消由主循环的
      // interrupt 路径处置，这里只保证它不会被误判成永久失败。
      if (ctor === "APIUserAbortError" || /aborted/i.test(message)) {
        return makeError({
          code: "MODEL_ABORTED",
          source: "MODEL_SDK",
          category: "CANCELLED",
          retryability: "NEVER",
          sideEffectState: "NO_EFFECT",
          safeMessage: "模型调用被取消",
          endpointId: this.profile.endpointId,
        });
      }

      /**
       * HTTP 200 后的 SSE `event:error` 是 Provider 失败，不是连接失败：SDK 抛出的
       * APIError 没有 status，但保留 requestID / error body。必须排在消息关键词
       * 网络兜底之前，否则 Provider 文案里一句 "connection" 又会把来源改错。
       */
      if (facts.providerResponded) return classifyStreamProviderError(facts, this.profile.endpointId);

      const isTimeout = ctor === "APIConnectionTimeoutError" || /timed?\s?out|ETIMEDOUT/i.test(message);
      const isNetwork =
        isTimeout ||
        ctor === "APIConnectionError" ||
        /fetch|network|socket|ECONN|EAI_AGAIN|ENOTFOUND|EPIPE|connection/i.test(message);

      if (isNetwork) {
        return makeError({
          code: isTimeout ? "MODEL_TIMEOUT" : "MODEL_NETWORK",
          source: "MODEL_SDK",
          category: isTimeout ? "TIMEOUT" : "UNAVAILABLE",
          // 退避重试。跨进程 resume 的招牌能力意味着长时运行，撞上网络抖动
          // 是常态而不是异常 —— 对着一个本该退避的瞬时故障收尾，方向是反的。
          retryability: "SAME_INPUT_BACKOFF",
          // 与 5xx 分支一致：请求可能已经到达服务端，也可能没有。诚实的答案是不知道。
          sideEffectState: "UNKNOWN",
          safeMessage: `${isTimeout ? "请求超时" : "连接失败"}：${message.slice(0, 160)}`,
          endpointId: this.profile.endpointId,
        });
      }

      // 剩下的才是真正的「SDK 发请求前就拒绝了」。
      // 实测：max_tokens 过大被 SDK 拦下，根本没发出请求 —— 重试多少次都没用。
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

    if (status >= 500) {
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

    // 走到这里 status 一定是数字：上面 `status === undefined` 那一支已经 return 了。
    return makeError({
      code: "MODEL_UNKNOWN",
      source: "MODEL_PROVIDER",
      category: "UNKNOWN",
      retryability: "SAME_INPUT_BACKOFF",
      sideEffectState: "UNKNOWN",
      safeMessage: `未分类的模型错误（HTTP ${status}）：${message.slice(0, 200)}`,
      endpointId: this.profile.endpointId,
    });
  }

  /**
   * ── 这里**故意没有** `isBlockClosed` ──────────────────────────────────
   *
   * 它曾经在这个类上，实现得也对（有 `content_block_stop` 就用事件，没有就用
   * 「后继 index 出现 ⟹ 前一 index 已闭合」，那是 Spike P3 从 OpenAI 形状里
   * 逼出来的判据）。删掉的理由不是它写错了，是**同一条规则在 `client.ts` 的
   * `assemble()` 里还有一份，而那一份才是活的** —— §8.4「未闭合的 Tool Call
   * 不得转为 ProposedAction」走的是它，读的是同一个
   * `profile.context.hasExplicitBlockCloseEvent`。
   *
   * 这一份零调用点：它唯一的输入 `ModelStreamEvent[]` 里那几个块级事件，
   * 也只有它一个读者。两个零消费者互相引用，链路看起来是通的。
   *
   * 【定】要恢复它，先回答「谁调它」—— 如果答案还是 `assemble()`，
   * 那就该把 `assemble()` 改成调它，而不是再摆一份。
   */
}

function classifyStreamProviderError(
  facts: AnthropicErrorFacts,
  endpointId: EndpointCapabilityProfile["endpointId"],
): RuntimeErrorRecord {
  const type = facts.providerErrorType ?? "unknown";
  const common = {
    source: "MODEL_PROVIDER" as const,
    sideEffectState: "UNKNOWN" as const,
    safeMessage: `模型流返回 Provider 错误（${type}）：${facts.message.slice(0, 160)}`,
    endpointId,
  };

  switch (type) {
    case "rate_limit_error":
      return makeError({
        ...common,
        code: "MODEL_RATE_LIMIT",
        category: "RATE_LIMIT",
        retryability: "SAME_INPUT_BACKOFF",
      });
    case "overloaded_error":
    case "api_error":
      return makeError({
        ...common,
        code: "MODEL_UNAVAILABLE",
        category: "UNAVAILABLE",
        retryability: "SAME_INPUT_BACKOFF",
      });
    case "timeout_error":
      return makeError({
        ...common,
        code: "MODEL_TIMEOUT",
        category: "TIMEOUT",
        retryability: "SAME_INPUT_BACKOFF",
      });
    case "billing_error":
      return makeError({
        ...common,
        code: "MODEL_QUOTA",
        category: "QUOTA",
        retryability: "AFTER_USER_ACTION",
      });
    case "authentication_error":
      return makeError({
        ...common,
        code: "MODEL_AUTH",
        category: "AUTHENTICATION",
        retryability: "NEVER",
      });
    case "permission_error":
      return makeError({
        ...common,
        code: "MODEL_AUTH",
        category: "AUTHORIZATION",
        retryability: "NEVER",
      });
    case "invalid_request_error":
      return makeError({
        ...common,
        code: "MODEL_BAD_REQUEST",
        category: "PROTOCOL",
        retryability: "AFTER_MODEL_CORRECTION",
      });
    case "not_found_error":
      return makeError({
        ...common,
        code: "MODEL_NOT_FOUND",
        category: "NOT_FOUND",
        retryability: "AFTER_ENVIRONMENT_CHANGE",
      });
    default:
      return makeError({
        ...common,
        code: "MODEL_UNKNOWN",
        category: "UNKNOWN",
        retryability: "SAME_INPUT_BACKOFF",
      });
  }
}

// ══════════════════════════════════════════════════════════ 翻译层

/**
 * ContextItem[] → Anthropic messages。
 *
 * Anthropic 形状的一个结构约束：tool_result 必须放在 user 消息里，
 * 而 tool_use 在 assistant 消息里。翻译在这里完成，Context 层不需要知道。
 *
 * 返回类型是具体的（不是 `unknown[]`）：`buildRequest` 要往**最后一个 block**
 * 上挂 cache_control，拿 `unknown[]` 就只能靠断言硬转。
 * `toBlock()` 每次都新建对象，所以那次挂载是安全的局部改写，不会串到别的请求上。
 */
function toAnthropicMessages(items: ContextItem[]): Array<{ role: string; content: unknown[] }> {
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
        content: renderToolResultForModel(c.content, c.resourceRefs),
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
    else if (c.type === "tool_result") {
      chars += renderToolResultForModel(c.content, c.resourceRefs).length;
    }
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
