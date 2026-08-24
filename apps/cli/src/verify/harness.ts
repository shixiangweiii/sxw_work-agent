/**
 * 验收脚本共用工具。
 *
 * 【定·D-25】三条验收项以**可运行脚本**交付，不是测试套件。
 * 它们输出可读证据供人判断，而不是断言绿灯 —— 与 Spike 0 的探针形态一致。
 *
 * 代价是回归靠人，收益是每次运行都产出可读证据而不是一个布尔值。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelInvocationResult,
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
  ModelUsage,
} from "@workagent/harness-runtime";

export function banner(title: string, question: string): void {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`  验证：${question}`);
  console.log("═".repeat(72));
}

export function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

export function fact(label: string, value: unknown): void {
  console.log(`   ${label.padEnd(34)} ${String(value)}`);
}

export function verdict(ok: boolean, text: string): void {
  console.log(`\n   ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${text}`);
}

export function tempWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "workagent-verify-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ══════════════════════════════════════════════ 脚本化 ModelPort

export interface ScriptedTurn {
  /** 这一轮模型要调的工具。空数组 = 结束循环。 */
  toolCalls: Array<{ toolCallId: string; name: string; input: unknown }>;
  text?: string;
  reasoning?: string;
  /** 模拟流式中断：产出 tool call 但标记 interrupted。 */
  interrupted?: boolean;
  /** 模拟请求失败。 */
  throwError?: { status?: number; message: string };
}

/**
 * 不发真实请求的 ModelPort。
 *
 * 存在的理由：verify:pairing 要注入「模型错误」这条中断路径，
 * 而真实端点不会按需报错。verify:resume 也需要可复现的轮次序列。
 *
 * 【定】它只替换 ModelPort，不替换 ModelProtocolPort ——
 * 形状适配器与端点能力声明的读取路径必须真的走一遍，否则
 * verify:endpoint-profile 就测不到东西了。
 */
export class ScriptedModelPort implements ModelPort {
  private turn = 0;
  readonly requestBodies: unknown[] = [];

  constructor(private readonly script: ScriptedTurn[]) {}

  async *invoke(
    request: ModelRequest,
    _signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult> {
    this.requestBodies.push(request.body);
    const t = this.script[this.turn] ?? { toolCalls: [], text: "（脚本已耗尽，结束）" };
    this.turn += 1;

    if (t.throwError) {
      const err = new Error(t.throwError.message) as Error & { status?: number };
      if (t.throwError.status !== undefined) err.status = t.throwError.status;
      throw err;
    }

    if (t.text) yield { type: "text_delta", text: t.text };

    const content: ModelInvocationResult["content"] = [];
    if (t.reasoning) content.push({ type: "reasoning", text: t.reasoning, signature: "" });
    if (t.text) content.push({ type: "text", text: t.text });
    for (const c of t.toolCalls) {
      content.push({ type: "tool_call", toolCallId: c.toolCallId, name: c.name, input: c.input });
    }

    return {
      content,
      toolCalls: t.toolCalls,
      stopReason: t.toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: usage(),
      interrupted: t.interrupted ?? false,
    };
  }

  async countTokens(_r: ModelRequest): Promise<number | undefined> {
    return 100;
  }

  get turnsConsumed(): number {
    return this.turn;
  }
}

function usage(): ModelUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    billedInputTokens: 100,
  };
}
