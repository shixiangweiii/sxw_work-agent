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

  /**
   * countTokens 默认返回写死的 100。
   *
   * 这个默认值本身就是存量清单 §4 第 3 条说的那个覆盖缺口：token 与预算路径
   * 在脚本化模型下**永远是常量**，所以 usage 清零、预算轴、口径错配这类问题
   * 能同时存在而三条脚本全绿。
   *
   * verify:compact 传入 `estimateFromBody` 让计数随上下文真的增长 ——
   * 不这样，Compact 的阈值一辈子撞不到，也就永远测不着。
   */
  constructor(
    private readonly script: ScriptedTurn[],
    private readonly countTokensImpl: (body: unknown) => number = () => 100,
  ) {}

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

  async countTokens(r: ModelRequest): Promise<number | undefined> {
    return this.countTokensImpl(r.body);
  }

  get turnsConsumed(): number {
    return this.turn;
  }
}

/**
 * 按请求体大小估算 token 数。
 *
 * 【定】它模拟的是「端点的 count_tokens」，所以必须**随上下文增长而增长** ——
 * 这正是常量 100 做不到的那件事。系数取 2.5，与形状适配器里的本地估算一致，
 * 不追求准确，只要求单调。
 */
export function estimateFromBody(body: unknown): number {
  return Math.ceil(JSON.stringify(body).length / 2.5);
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
