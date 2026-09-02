/**
 * 事件流的终端渲染。
 *
 * 阶段 1 没有 GUI（那是阶段 4）。这里是「Layer 1 通过 RunEvent 流驱动」
 * 这条约束的最小兑现 —— 换成任何 UI 都只是换一个投影器。
 */

import type { RunEvent } from "@workagent/harness-runtime";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

/**
 * 「当前是否正在流式输出」。
 *
 * ── M-9：为什么它可以是模块级的（也为什么要写清楚）────────────────────
 *
 * 存量清单把它记成「模块级可变状态」，那个担心是对的形状但结论要限定：
 * 它描述的是**这个进程的这一个终端**的光标位置 —— 一个进程只有一个 stdout，
 * 所以「谁在流式输出」天然是进程级的，不是 Run 级的。
 *
 * 真正的风险不是并发 Run（CLI 一次只跑一个），而是**忘记收尾**：
 * 流式输出到一半去打一行别的，光标还停在行内，输出就串了。
 * 所以关键不在于把它挪进对象里，而在于**每一个会打断流的地方都调
 * `finishRendering()`** —— 审批提问、E-3 的降级提示、最终收尾都调了。
 *
 * 【定】要给 CLI 之外的消费方复用渲染时，必须先把它变成 renderer 实例上的
 * 字段。在那之前，把这个约束写下来比搬一次代码更有用。
 */
let streaming = false;

export function renderEvent(e: RunEvent): void {
  const tag = (s: string, color = CYAN): string => `${color}[${s}]${RESET}`;

  // 流式文本要连续输出，遇到非 delta 事件先收尾换行
  if (e.type !== "ModelStreamDelta" && streaming) {
    process.stdout.write("\n");
    streaming = false;
  }

  switch (e.type) {
    case "RunStarted":
      console.log(
        `${tag("RunStarted")} endpoint=${e.payload.endpointId} model=${e.payload.modelId}\n` +
          `${DIM}任务：${e.payload.task}${RESET}`,
      );
      break;

    case "TurnStarted":
      console.log(`\n${tag(`Turn ${e.payload.turn}`, BOLD)}`);
      break;

    case "ContextFrameCompiled":
      console.log(
        `${DIM}  ContextFrame: ${e.payload.items} 项 / ${e.payload.totalTokens} tokens ` +
          `（固定开销 ${e.payload.fixedOverheadTokens}）${e.payload.compacted ? " [已压缩]" : ""}${RESET}`,
      );
      break;

    case "ContextCompacted":
      console.log(`${tag("Compact", YELLOW)} 释放 ${e.payload.freedTokens} tokens：${e.payload.reason}`);
      break;

    case "ModelStreamDelta":
      if (!streaming) {
        process.stdout.write(`${DIM}  «${RESET}`);
        streaming = true;
      }
      process.stdout.write(e.payload.text);
      break;

    case "ModelInvocationCompleted": {
      const u = e.payload.usage;
      console.log(
        `${DIM}  模型返回 ${e.payload.toolCallCount} 个 tool call，` +
          `stop=${e.payload.stopReason}，${e.payload.durationMs}ms\n` +
          `  usage: in=${u.inputTokens} out=${u.outputTokens} ` +
          `cacheRead=${u.cacheReadInputTokens ?? 0} → billed=${u.billedInputTokens}${RESET}`,
      );
      break;
    }

    case "ActionBatchPlanned":
      console.log(
        `${tag("ActionBatch")} ${e.payload.callCount} 个 call，模式 ${e.payload.mode}`,
      );
      break;

    case "ActionProposed":
      console.log(`  ${DIM}→${RESET} ${e.payload.toolName}  ${DIM}${e.payload.effect}${RESET}`);
      break;

    case "ActionRejected":
      console.log(`  ${RED}✗${RESET} 拒绝（${e.payload.stage}）：${e.payload.reason}`);
      break;

    case "ApprovalRequested":
      console.log(`  ${YELLOW}?${RESET} 需要确认：${e.payload.reason}`);
      break;

    case "ApprovalDecided":
      console.log(
        `  ${e.payload.approved ? `${GREEN}✓${RESET} 已批准` : `${RED}✗${RESET} 已拒绝`}` +
          (e.payload.reason ? `：${e.payload.reason}` : ""),
      );
      break;

    case "AttemptCompleted":
      console.log(
        `  ${e.payload.status === "SUCCEEDED" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ` +
          `${e.payload.status}  ${DIM}副作用=${e.payload.sideEffectState}  ${e.payload.durationMs}ms${RESET}`,
      );
      break;

    case "VerificationCompleted":
      if (e.payload.status === "SKIPPED") break;
      console.log(
        `  ${e.payload.status === "PASSED" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ` +
          `Verification${e.payload.required ? "（必需）" : ""}：${e.payload.detail}`,
      );
      break;

    case "ActionBatchSettled":
      console.log(
        `${tag("Settled")} ${e.payload.resultCount}/${e.payload.callCount} 有 result` +
          (e.payload.resultCount === e.payload.callCount
            ? ` ${GREEN}✓${RESET}`
            : ` ${RED}← 违反不变量 8${RESET}`),
      );
      break;

    case "InterjectionAccepted":
      console.log(`${tag("插话", YELLOW)} ${e.payload.content}`);
      break;

    case "LoopContinued":
      console.log(`${DIM}  ↻ continue: ${e.payload.transition.reason}${RESET}`);
      break;

    case "BudgetHardLimitReached":
      console.log(
        `${tag("预算硬墙", RED)} ${e.payload.axis}: ${e.payload.used} / ${e.payload.limit}`,
      );
      break;

    case "RuntimeErrorOccurred": {
      const err = e.payload.error;
      console.log(
        `${tag("Error", RED)} ${err.code}  ${DIM}${err.source}/${err.category}/` +
          `${err.retryability}/副作用=${err.sideEffectState}${RESET}\n  ${err.safeMessage}`,
      );
      break;
    }

    case "ModelInvocationAuditFailed":
      console.error(
        `${tag("审计写入失败", RED)} invocation=${e.payload.invocationId} ` +
          `stage=${e.payload.stage}\n  ${e.payload.message}\n` +
          `  ${YELLOW}模型调用与 Run 已继续执行；该调用的 sidecar 不完整。${RESET}`,
      );
      break;

    case "EndpointBehaviorDrift":
      console.log(
        `${tag("端点漂移", RED)} ${e.payload.field}\n` +
          `  声明 ${e.payload.declared} / 实际 ${e.payload.observed} → ${e.payload.disposition}`,
      );
      break;

    case "ResumeStarted":
      console.log(
        `${tag("Resume", YELLOW)} 从 sequence ${e.payload.fromSequence} 重建了 ` +
          `${e.payload.rebuiltMessages} 条消息`,
      );
      break;

    case "ResumeUnpairedToolUse":
      console.log(
        `  ${YELLOW}!${RESET} 未配对 tool_use ${e.payload.toolCallId}（${e.payload.toolName}）` +
          ` → 分支 ${e.payload.branch}`,
      );
      break;

    case "RecoveryRequired":
      console.log(`${tag("RECOVERY_REQUIRED", RED)} ${e.payload.items} 项需要人工确认`);
      break;

    default:
      break;
  }
}

export function finishRendering(): void {
  if (streaming) {
    process.stdout.write("\n");
    streaming = false;
  }
}
