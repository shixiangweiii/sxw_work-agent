/**
 * ContextFrame 编译（V05 §11）。
 *
 * 主循环第 ① 步：外置大结果 → Compact → 协议校验。
 *
 * 【定】本模块不认识任何具体端点。协议角色档位、token 精度、校验强度
 * 全部经 ModelProtocolPort 取得 —— 那是形状适配器 ＋ 端点能力声明的组合出口。
 */

import type {
  ContextBudgetPolicy,
  ContextFrame,
  ContextFrameOutcome,
  ContextItem,
  ContextTrust,
  TrustSummary,
} from "../types/context.js";
import type { ContextMessage } from "../types/transcript.js";
import type { ExecutionPrivilege } from "../types/run.js";
import type { ModelProtocolPort } from "../ports/index.js";
import type { IdGeneratorPort } from "../ports/index.js";
import { asId, digest, type ContextFrameId, type ModelInvocationId, type RunId } from "../types/ids.js";
import { compactMessages } from "./compact.js";

export interface CompileDeps {
  protocol: ModelProtocolPort;
  ids: IdGeneratorPort;
  policy: ContextBudgetPolicy;
  systemPrompt: string;
  /**
   * tool 定义的固定开销。实测 2 个单参数工具 = 360 token，折合每工具约 180。
   * 20 个工具就是约 3600 token 的起步价，与任务内容无关。
   * 【定】阈值判断必须先扣除它，否则「还剩多少上下文可用」算错。
   */
  fixedOverheadTokens: number;
  /**
   * IANA 时区名，来自 AgentSpec。与 `now` 一起构成注入给模型的受信时间事实。
   *
   * 【定】时间必须经 ClockPort（即这里的 `now` / `timeFactAt`）取得，
   * 不得在本模块调 `Date.now()` —— 帧内容要能从入参完整推出来，
   * 而一个直接读挂钟的表达式让同一份输入产出两种帧。
   *
   * （此前这条的理由写的是「验收脚本用 FakeClock」，而 `FakeClock` 因为
   * 零使用者已于 2026-08-31 删除 —— 理由没了，规则仍然成立，
   * 所以换成它真正站得住的那个理由。见 `ClockPort` 的注释。）
   */
  timezone: string;
  /**
   * 随 AgentSpec 冻结的执行特权档位（ADR-0012）。
   *
   * 【定】它只在 `UNRESTRICTED` 时产生一条 SYSTEM_NOTICE。理由不是省 token，
   * 是**只有那一档才需要更正一句已经说出口的话**：`run_shell` 的
   * description 里写着三条沙箱规则，而那三条在 UNRESTRICTED 下不成立。
   * M1 那条教训（description 承诺「系统临时目录」而实现只放行 per-call
   * $TMPDIR，模型照着写 /tmp 白花一轮）说的就是**模型是那句话唯一的读者**。
   */
  executionPrivilege: ExecutionPrivilege;
  /**
   * 输出预算恢复用（V05 §16.1）。
   *
   * 主循环识别出「推理吃光输出预算」后会抬高上限重试 —— 但抬高的值必须
   * 真的进到下一次请求里，否则就是用同样的 max_tokens 重发同一个请求，
   * 连撞两次同一堵墙后报 CONTEXT_EXHAUSTED，把真因掩盖掉。
   * 【定】这是 LoopState.maxOutputTokensOverride 的唯一消费点。
   */
  reservedOutputTokensOverride?: number | undefined;
  runId: RunId;
  now: number;
  /**
   * 注入给模型的那条受信时间事实用的时刻（决 3）。
   *
   * 【定】它是**本执行段的起始时刻**，不是 `now` —— 两者刻意分开：
   *
   *   · `now` 每轮变，服务于预算、事件时间戳这些「此刻」语义；
   *   · `timeFactAt` 一段内不变，服务于「模型看到的当前时间」。
   *
   * 为什么要冻：STRICT_PREFIX 下每轮重渲染时间戳会让前缀从第一条 item
   * 就分叉，历史永远缓存不到；而分钟粒度还让失效**不确定** ——
   * 跑得快就不失效，跨了分钟边界就在某个说不准的轮次失效一次。
   *
   * 为什么冻到「段」而不是「整个 Run」：跨进程 resume 是阶段 2 的招牌能力，
   * 冻到 Run 级会让周一起的 Run 在周三 resume 时把周一的日期写进产物 ——
   * 那比编造更糟，因为它是被 system prompt 背书的错误。
   * 段边界重新冻结，段内稳定，两头都要得到。
   */
  timeFactAt: number;
}

export async function compileFrame(
  messages: ContextMessage[],
  deps: CompileDeps,
): Promise<ContextFrameOutcome> {
  const compactionApplied: ContextFrameOutcome["compactionApplied"] = [];
  let working = messages;
  /**
   * R-6：压缩产物必须能被调用方取走。
   *
   * 修复前它们只活在这个函数的局部变量里，runLoop 拿不到，于是下一轮
   * 又从原始 state.messages 开始 —— 压缩事件照发，历史照样越滚越长。
   */
  let compacted: { messages: ContextMessage[]; summary?: ContextMessage; kept: ContextMessage[] } | undefined;

  // ① 首次成帧
  let frame = buildFrame(working, deps);
  let count = await deps.protocol.countTokens(frame);
  frame.totalTokens = count.tokens;

  // ② soft limit 之下：Context Runtime 自治压缩
  if (count.tokens > deps.policy.softInputLimitTokens) {
    /**
     * 【定】阈值与估算必须是同一个单位。
     *
     * `compactTargetTokens` 是**帧级**预算，而 Compact 只看得见 messages。
     * 直接把帧级数字交给它，等于拿一个含工具定义开销、system prompt、
     * 时间事实的预算去卡一个不含这些东西的估算 —— 目标看起来永远已经达成，
     * 一条消息都不会被丢。这是 R-3「固定开销重复相加」的同款单位错配，
     * 只是方向相反：那边多减一次，这边少减一次。
     *
     * 所以先把 Compact 够不到的部分扣掉，剩下的才是留给 messages 的额度。
     */
    const nonMessageTokens =
      deps.fixedOverheadTokens +
      frame.items
        .filter((i) => i.kind === "SYSTEM_INSTRUCTION" || i.kind === "SYSTEM_NOTICE")
        .reduce((n, i) => n + i.estimatedTokens, 0);

    const result = compactMessages(working, {
      protocol: deps.protocol,
      targetTokens: Math.max(0, deps.policy.compactTargetTokens - nonMessageTokens),
      now: deps.now,
    });
    if (result.freedTokens > 0) {
      working = result.messages;
      compacted = { messages: result.messages, summary: result.summary, kept: result.kept };
      compactionApplied.push(result.record);
      frame = buildFrame(working, deps);
      count = await deps.protocol.countTokens(frame);
      frame.totalTokens = count.tokens;
    }
  }

  const irreducible = computeIrreducible(frame, deps, count.accuracy);
  frame.irreducibleTokens = irreducible;

  /**
   * ③ hard limit（R-3）。
   *
   * ── 修之前这里有三个叠在一起的口径错误 ────────────────────────────
   *
   * 1. **可以超限发出。** 只有 `irreducible + fixedOverhead` 也超硬限时才返回
   *    COMPACTION_INSUFFICIENT，否则**照常 READY 发出去**。而 Compact 永久
   *    保留全部用户输入、`computeIrreducible()` 又不把它们计入 irreducible ——
   *    于是「压缩完仍然超硬限」的帧会被当成正常帧发给 Provider。
   *    超硬限就是超硬限，压不压得动是**下一个**问题。
   *
   * 2. **重复相加。** `computeIrreducible()` 起手就是 `sum = fixedOverheadTokens`，
   *    这里又加了一次。同一笔开销在同一个比较里算了两遍。
   *
   * 3. **精确路径上根本不该加。** `fixedOverheadTokens` 是「工具数 × 180」的
   *    本地估算，而端点的 `count_tokens` 返回值**已经包含**工具定义开销
   *    （Spike p4 实测：无 tool 15 → 有 tool 374，差 359 就是工具）。
   *    在精确路径上再扣一次，阈值基准本身就是错的。
   *
   * 修法是把三种口径显式分开，见 `computeIrreducible` 的判定表。
   * 这里只做一件事：**超硬限一律不发**。
   *
   * 【定】不再回一个 `irreducibleExceedsHardLimit` 标志位。它带着一整段
   * 「两种处置在 D-05 里是分开的」的说明，而主循环只读 `status`、
   * 从来没有第二种处置 —— 一个自称存在的分支比一个缺失的分支更误导。
   */
  if (count.tokens > deps.policy.hardInputLimitTokens) {
    return {
      status: "COMPACTION_INSUFFICIENT",
      totalTokens: count.tokens,
      irreducibleTokens: irreducible,
      fixedOverheadTokens: deps.fixedOverheadTokens,
      compactionApplied,
    };
  }

  // ④ 协议校验。失败不得发起模型调用（V05 §11.5 不变量 7）
  const validation = deps.protocol.validateFrame(frame);
  if (!validation.ok) {
    return {
      status: "PROTOCOL_INVALID",
      totalTokens: count.tokens,
      irreducibleTokens: irreducible,
      fixedOverheadTokens: deps.fixedOverheadTokens,
      compactionApplied,
      protocolError: validation.violations.join("；"),
    };
  }

  return {
    status: compactionApplied.length > 0 ? "COMPACTED_READY" : "READY",
    frame,
    totalTokens: count.tokens,
    irreducibleTokens: irreducible,
    fixedOverheadTokens: deps.fixedOverheadTokens,
    compactionApplied,
    compactedMessages: compacted?.messages,
    compactSummary: compacted?.summary,
    compactKept: compacted?.kept,
  };
}

// ══════════════════════════════════════════════════════════ 构帧

function buildFrame(messages: ContextMessage[], deps: CompileDeps): ContextFrame {
  const items: ContextItem[] = [];

  items.push(
    finishItem(
      {
        kind: "SYSTEM_INSTRUCTION",
        source: { kind: "SYSTEM" },
        trust: "SYSTEM_TRUSTED",
        protocolRole: "ORDINARY",
        content: { type: "text", text: deps.systemPrompt },
      },
      deps,
    ),
  );

  /**
   * 受信时间事实。
   *
   * ── 为什么必须有 ──────────────────────────────────────────────
   *
   * 模型对「现在是哪年」只有训练先验，没有任何事实覆写它，于是会自己编一个。
   * 2026-08-24 的评测实跑里它在交接清单上写了「盘点时间：2025年」；
   * 而更早一次实跑同样缺时间源，模型选择了回避
   * （写成「盘点时间：2026Q2 归档目录完整盘点」）。
   *
   * 两次表现不同这件事本身就是判据：**「模型会自己糊过去」不是缓解措施**，
   * 回避和编造都是它在没有事实时的随机选择。所以这里给的是事实，
   * system prompt 里那句「无依据不要写日期」只是配套，不能替代它。
   *
   * ── 为什么是独立一条 item，而不是拼进 systemPrompt ─────────────
   *
   * 端点声明 cacheMatching = STRICT_PREFIX（改前缀第一处 → 命中归零）。
   * 把每次都变的时间戳拼进 system block，等于让将来接 cache_control 时
   * 整个前缀永远命不中。单独一条排在 system 之后，system block 保持完全稳定。
   *
   * ── 注入 vs now 工具：主次不能颠倒 ────────────────────────────
   *
   * 工具要模型记得调。**它上次就没调 —— 直接编了一个。**
   * 注入是零轮次、零 token 往返、且不可能被跳过的那条路径，所以它是主机制。
   *
   * 阶段 2 补了一个只读 `now` 工具，但那是**补充**：段级冻结之后这条事实
   * 最多过时「本段已跑的时长」，需要精确到分钟的任务才需要去调它。
   * 【定】不得反过来 —— 删掉这条注入、改由模型自己调 now，
   * 那正是上面那句实测记录否掉过的方案。
   */
  /**
   * ── 执行特权档位（ADR-0012）─────────────────────────────────────────────
   *
   * 【定】排在时间事实**之前**。时间事实每段都变，是前缀缓存的第一个断点；
   * 而这一条在一个 Run 内恒定 —— 放在它后面等于把一段本可稳定的前缀
   * 挪到断点之后，白白让它每段重算（端点声明 cacheMatching = STRICT_PREFIX）。
   *
   * 【定】只在 UNRESTRICTED 时出现，且措辞必须是**更正**而不是补充。
   * 模型手里同时有 `run_shell` description 里那三条沙箱规则，两者冲突时
   * 它得知道听谁的 —— 说不清楚的话，一个"保守"的模型会继续按沙箱规划命令，
   * 而那正好让这个档位白开。
   */
  if (deps.executionPrivilege === "UNRESTRICTED") {
    items.push(
      finishItem(
        {
          kind: "SYSTEM_NOTICE",
          source: { kind: "SYSTEM" },
          trust: "SYSTEM_TRUSTED",
          protocolRole: "ORDINARY",
          content: { type: "text", text: UNRESTRICTED_FACT },
        },
        deps,
      ),
    );
  }

  items.push(
    finishItem(
      {
        kind: "SYSTEM_NOTICE",
        source: { kind: "SYSTEM" },
        trust: "SYSTEM_TRUSTED",
        protocolRole: "ORDINARY",
        content: { type: "text", text: renderTimeFact(deps.timeFactAt, deps.timezone) },
      },
      deps,
    ),
  );

  for (const m of messages) {
    for (const c of m.content) {
      const partial = {
        kind: kindOf(m.role, c.type),
        source: { kind: sourceOf(m.role, c.type) },
        trust: trustOf(m.role, c.type),
        // 占位，下面立刻由端点声明覆盖
        protocolRole: "ORDINARY" as ContextItem["protocolRole"],
        content: c,
        protocolGroupId:
          c.type === "tool_call" || c.type === "tool_result" ? c.toolCallId : undefined,
      };
      const item = finishItem(partial, deps);
      // 【定】档位由端点能力声明给出，不由本模块推断。
      item.protocolRole = deps.protocol.protocolRoleOf(item);
      items.push(item);
    }
  }

  const frame: ContextFrame = {
    id: asId<ContextFrameId>(deps.ids.next("frame")),
    runId: deps.runId,
    invocationId: asId<ModelInvocationId>(deps.ids.next("inv")),
    endpointProfileVersion: `${deps.protocol.profile.id}@${deps.protocol.profile.observedAt}`,
    items,
    totalTokens: 0,
    irreducibleTokens: 0,
    fixedOverheadTokens: deps.fixedOverheadTokens,
    // 【定】必须同时覆盖推理与正文 —— 实测推理可以吃光整个输出预算，
    // 而接口返回成功、无错误码、内容为空。
    // override 非空时来自上一轮的输出预算恢复，见 CompileDeps 的说明。
    reservedOutputTokens: deps.reservedOutputTokensOverride ?? deps.policy.reservedOutputTokens,
    trustSummary: summarize(items),
    contentHash: "",
    createdAt: deps.now,
  };
  frame.contentHash = hashFrame(frame);
  return frame;
}

/**
 * UNRESTRICTED 档的更正声明（ADR-0012）。
 *
 * 【定】它是一条**常量**，不拼任何运行期变量 —— 一个 Run 内恒定是前缀缓存
 * 能覆盖它的前提（见上面插入点的说明）。
 *
 * 【定】不写"你现在可以为所欲为"这类鼓励性措辞。它要传达的是两件事实
 * （旧规则失效、你仍然要对后果负责），不是一句授权。措辞往鼓励方向偏，
 * 换来的是模型更愿意用 `rm -rf` 这种一步到位的写法 —— 而这一档下
 * 没有任何东西会拦住它。
 */
const UNRESTRICTED_FACT =
  "[系统事实] 本次运行的执行特权档位是 UNRESTRICTED（无沙箱）。\n" +
  "run_shell 的工具说明里那几条沙箱规则本次**不生效**：写入不再限于 workspace 与 $TMPDIR、" +
  "命令默认可以联网（不需要传 allow_network）、写到 workspace 之外也不会被系统拒绝。\n" +
  "仍然生效的是：读不到凭证文件（.env / .ssh / .aws），以及 read_file / search 的读黑名单。\n" +
  "这意味着你的命令会直接作用在用户的真实机器上，没有任何沙箱兜底。" +
  "删除、覆盖、移动这类操作请先确认目标路径，优先把产物写在 workspace 里；" +
  "只有任务确实要求时才动 workspace 之外的东西。";

/**
 * 把 ClockPort 的时间戳渲染成模型能直接引用的事实。
 *
 * 写明星期与时区是刻意的：办公类产物里「本周」「下周一」这类相对表述很常见，
 * 只给一个 ISO 串，模型还是得自己推算星期，那又是一次可能出错的推断。
 *
 * 【定】只用传进来的 `now`，不碰 `Date.now()` —— 这一行的输出是帧内容的一部分，
 * 必须由入参唯一决定（同一份 CompileDeps 编两次要逐字一致）。
 */
function renderTimeFact(now: number, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  });
  return (
    `[系统事实] 当前时间：${fmt.format(new Date(now))}（${timezone}）。\n` +
    `这是本次执行开始时的可信时间。需要写日期、时间戳或做时间推算时以它为准，不要另行推测；\n` +
    `若任务需要精确到分钟，或本次运行已持续较久，调用 now 工具取当前时刻。`
  );
}

/**
 * 【定】`Omit` 的键必须是 `ContextItem` 上**真的存在**的字段。
 *
 * 这里此前还 Omit 着一个 `redactionApplied`，而那个字段（恒 `true`、
 * 不变量 13 的名义载体）已经在 2026-08-31 那批删掉了。
 * `Omit<T, K>` 对不存在的 K **不报错**，于是它作为一句失效的声明留了下来 ——
 * 读的人会以为 `ContextItem` 上还有一个跟脱敏有关的字段。
 */
type PartialItem = Omit<ContextItem, "id" | "contentHash" | "estimatedTokens" | "createdAt">;

function finishItem(p: PartialItem, deps: CompileDeps): ContextItem {
  const text = renderText(p.content);
  return {
    ...p,
    id: asId(deps.ids.next("ci")),
    contentHash: digest(text),
    estimatedTokens: Math.ceil(text.length / 2.5),
    createdAt: deps.now,
  };
}

function renderText(c: ContextItem["content"]): string {
  if (!c) return "";
  switch (c.type) {
    case "text":
    case "reasoning":
      return c.text;
    case "tool_call":
      return `${c.name}(${JSON.stringify(c.input)})`;
    case "tool_result":
      return c.content;
  }
}

function kindOf(role: string, type: string): ContextItem["kind"] {
  if (type === "reasoning") return "MODEL_REASONING";
  if (type === "tool_call") return "MODEL_TOOL_CALL";
  if (type === "tool_result") return "TOOL_RESULT";
  return role === "assistant" ? "ASSISTANT_MESSAGE" : "USER_MESSAGE";
}

function sourceOf(role: string, type: string): ContextItem["source"]["kind"] {
  if (type === "tool_result") return "TOOL";
  return role === "assistant" ? "RUN" : "USER";
}

/**
 * 【定】ToolResult 默认 EXTERNAL_UNTRUSTED（V05 §22.4）。
 * 不可信内容中的文字不能创建 Grant、改变 Policy 或自动批准 Action。
 */
function trustOf(role: string, type: string): ContextTrust {
  if (type === "tool_result") return "EXTERNAL_UNTRUSTED";
  if (role === "assistant") return "MODEL_GENERATED";
  return "USER_PROVIDED";
}

function summarize(items: ContextItem[]): TrustSummary {
  const counts: Record<ContextTrust, number> = {
    SYSTEM_TRUSTED: 0,
    USER_PROVIDED: 0,
    MODEL_GENERATED: 0,
    EXTERNAL_UNTRUSTED: 0,
  };
  for (const i of items) counts[i.trust] += 1;
  return { hasExternalUntrusted: counts.EXTERNAL_UNTRUSTED > 0, counts };
}

/**
 * 不可压缩集（R-3）。
 *
 * 【端点】选定端点 reasoningBlockRule = DROPPABLE，所以只需覆盖配对组；
 * 换成 PLACEHOLDER_REQUIRED 的端点时，占位块也进入不可压缩集。
 *
 * ── 判定表：工具定义开销到底该不该算进来 ──────────────────────────────
 *
 * | 计数路径   | count_tokens 是否已含工具开销 | 这里该不该再加 |
 * |------------|------------------------------|----------------|
 * | EXACT      | **已含**（Spike p4 实测）      | **不加**       |
 * | ESTIMATED  | 不含（items 里没有工具定义）    | 加             |
 *
 * 混算的后果不是差几个 token，是**阈值基准整体偏移**：精确路径上多算一遍
 * 工具开销，20 个工具就是凭空多出 3600 token 的「不可压缩」额度，
 * 于是本来还能压的帧被判成压不动。
 *
 * 【定】调用方**不得**在这个返回值之外再加 `fixedOverheadTokens`。
 * 这个函数返回的就是完整的不可压缩集，加法只发生在这里一处。
 */
function computeIrreducible(
  frame: ContextFrame,
  deps: CompileDeps,
  accuracy: "EXACT" | "ESTIMATED",
): number {
  // 精确路径上 count_tokens 已经把工具定义算进 totalTokens 了，这里再加就是加两遍。
  let sum = accuracy === "EXACT" ? 0 : deps.fixedOverheadTokens;
  for (const item of frame.items) {
    if (
      item.protocolRole === "PROTOCOL_GROUP_MEMBER" ||
      item.protocolRole === "REQUIRED_VERBATIM" ||
      item.protocolRole === "PLACEHOLDER_REQUIRED" ||
      item.kind === "SYSTEM_INSTRUCTION" ||
      // 时间事实每帧重新生成，Compact 永远够不到它 —— 算进不可压缩集才是事实。
      item.kind === "SYSTEM_NOTICE" ||
      /**
       * 用户输入（R-3 的第一层）。
       *
       * Compact 明确永久保留「有 text 块的 user 消息」，也就是说它们
       * **压不掉**。而修复前 irreducible 不把它们算进去，于是一个超长
       * 用户输入会得到「irreducible 很小 → 还能压 → 照常发出」的判定，
       * 而实际上一条都压不动。超硬限的帧就这样被放行了。
       *
       * 【定】这里此前还并着一个 `USER_INTERJECTION` —— 而插话被 `kindOf()`
       * 归成 `USER_MESSAGE`，那个合取项从写下来就没命中过。
       * 一个恒假的判定读起来像是一条保护。
       */
      item.kind === "USER_MESSAGE"
    ) {
      sum += item.estimatedTokens;
    }
  }
  return sum;
}

function hashFrame(f: ContextFrame): string {
  return digest(f.items.map((i) => i.contentHash).join("|"));
}
