/**
 * ContextFrame 编译（V05 §11）。
 *
 * 主循环第 ① 步：外置大结果 → Compact → 协议校验。
 *
 * 【定】本模块不认识任何具体端点。协议角色档位、token 精度、校验强度
 * 全部经 ModelProtocolPort 取得 —— 那是形状适配器 ＋ 端点能力声明的组合出口。
 */

import { createHash } from "node:crypto";
import type {
  ContextBudgetPolicy,
  ContextFrame,
  ContextFrameOutcome,
  ContextItem,
  ContextTrust,
  TrustSummary,
} from "../types/context.js";
import type { ContextMessage } from "../types/transcript.js";
import type { ModelProtocolPort } from "../ports/index.js";
import type { IdGeneratorPort } from "../ports/index.js";
import { asId, type ContextFrameId, type ModelInvocationId, type RunId } from "../types/ids.js";
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
   * 【定】时间必须经 ClockPort（即这里的 `now`）取得，不得在本模块调 Date.now()。
   * 验收脚本用 FakeClock，硬编码当前时间会让帧内容不可复现。
   */
  timezone: string;
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

  const irreducible = computeIrreducible(frame, deps);
  frame.irreducibleTokens = irreducible;

  // ③ hard limit 且不可再压 → 交主循环决策（D-05）
  if (count.tokens > deps.policy.hardInputLimitTokens) {
    if (irreducible + deps.fixedOverheadTokens > deps.policy.hardInputLimitTokens) {
      return {
        status: "COMPACTION_INSUFFICIENT",
        totalTokens: count.tokens,
        irreducibleTokens: irreducible,
        fixedOverheadTokens: deps.fixedOverheadTokens,
        compactionApplied,
      };
    }
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
   * 而更早一次实跑（存量清单附录）同样缺时间源，模型选择了回避
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
   * ── 为什么不做成 now 工具 ─────────────────────────────────────
   *
   * 工具要模型记得调。它上次就没调 —— 直接编了一个。注入是零轮次、
   * 零 token 往返、且不可能被跳过的那条路径。
   */
  items.push(
    finishItem(
      {
        kind: "SYSTEM_NOTICE",
        source: { kind: "SYSTEM" },
        trust: "SYSTEM_TRUSTED",
        protocolRole: "ORDINARY",
        content: { type: "text", text: renderTimeFact(deps.now, deps.timezone) },
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
    compilerVersion: "1.0.0",
    policyVersion: "1.0.0",
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
 * 把 ClockPort 的时间戳渲染成模型能直接引用的事实。
 *
 * 写明星期与时区是刻意的：办公类产物里「本周」「下周一」这类相对表述很常见，
 * 只给一个 ISO 串，模型还是得自己推算星期，那又是一次可能出错的推断。
 *
 * 【定】只用 deps.now，不碰 Date.now() —— FakeClock 下这一行必须可复现。
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
    `这是本次运行唯一可信的时间来源。需要写日期、时间戳或做时间推算时以它为准，不要另行推测。`
  );
}

type PartialItem = Omit<ContextItem, "id" | "contentHash" | "estimatedTokens" | "createdAt" | "redactionApplied">;

function finishItem(p: PartialItem, deps: CompileDeps): ContextItem {
  const text = renderText(p.content);
  return {
    ...p,
    id: asId(deps.ids.next("ci")),
    contentHash: sha256(text),
    estimatedTokens: Math.ceil(text.length / 2.5),
    // 阶段 1 的两个工具都在 ToolRuntime 里过了 RedactionPort，
    // 进到这里的内容一律已脱敏（不变量 13）。
    redactionApplied: true,
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
 * 不可压缩的部分。
 *
 * 【端点】选定端点 reasoningBlockRule = DROPPABLE，所以只需覆盖配对组；
 * 换成 PLACEHOLDER_REQUIRED 的端点时，占位块也进入不可压缩集。
 */
function computeIrreducible(frame: ContextFrame, deps: CompileDeps): number {
  let sum = deps.fixedOverheadTokens;
  for (const item of frame.items) {
    if (
      item.protocolRole === "PROTOCOL_GROUP_MEMBER" ||
      item.protocolRole === "REQUIRED_VERBATIM" ||
      item.protocolRole === "PLACEHOLDER_REQUIRED" ||
      item.kind === "SYSTEM_INSTRUCTION" ||
      // 时间事实每帧重新生成，Compact 永远够不到它 —— 算进不可压缩集才是事实。
      item.kind === "SYSTEM_NOTICE"
    ) {
      sum += item.estimatedTokens;
    }
  }
  return sum;
}

function hashFrame(f: ContextFrame): string {
  return sha256(f.items.map((i) => i.contentHash).join("|"));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}
