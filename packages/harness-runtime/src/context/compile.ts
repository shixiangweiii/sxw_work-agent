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

  // ① 首次成帧
  let frame = buildFrame(working, deps);
  let count = await deps.protocol.countTokens(frame);
  frame.totalTokens = count.tokens;

  // ② soft limit 之下：Context Runtime 自治压缩
  if (count.tokens > deps.policy.softInputLimitTokens) {
    const result = compactMessages(working, {
      protocol: deps.protocol,
      targetTokens: deps.policy.compactTargetTokens,
      now: deps.now,
    });
    if (result.freedTokens > 0) {
      working = result.messages;
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
      item.kind === "SYSTEM_INSTRUCTION"
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
