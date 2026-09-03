/**
 * 验收脚本共用工具。
 *
 * 【定·D-25】验收项以**可运行脚本**交付，不是测试套件。
 * 它们输出可读证据供人判断，而不是断言绿灯 —— 与 Spike 0 的探针形态一致。
 *
 * 代价是回归靠人，收益是每次运行都产出可读证据而不是一个布尔值。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelInvocationObserver,
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

// ══════════════════════════════════════════════ 判据登记与统一收尾

/**
 * 本次运行打印过的每一条判据。
 *
 * 【定】退出码只能由这个登记表推出，**不得手写布尔表达式**。
 *
 * 理由是实测，不是洁癖：`verify:resume` 的 C 段判据（「恢复产物与基线逐字一致」）
 * 算出来了、打印了、还被实施记录列为阶段 2 最有价值的发现之一 ——
 * 却漏在 `process.exit(...)` 的合取式外面。那条判据在 `verify:all` 的 `&&` 链
 * 语义里只读不判：恢复写坏产物、丢掉基线做过的调用，退出码照样是 0。
 * 同一批还查出 persistence 的 F 段（批 1 期间的「已知红」豁免）在转绿之后
 * 仍被排除在退出码外。
 *
 * 手写表达式漏一项**不会有任何征兆**。D-25 决定不写单测，这些脚本就是本项目
 * 唯一的测量仪器；仪器上有一根线没接，比没有那根线更糟 —— 它还会打绿勾。
 * 让退出码从 `verdict()` 的调用本身推出，是唯一能机械杜绝这件事的形状。
 */
const verdictLog: Array<{ ok: boolean; text: string }> = [];

export function verdict(ok: boolean, text: string): boolean {
  verdictLog.push({ ok, text });
  console.log(`\n   ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${text}`);
  return ok;
}

/** 汇总登记表。返回 true 表示每一条判据都通过。零判据也算失败——脚本没跑起来。 */
function concludeVerdicts(): boolean {
  const failed = verdictLog.filter((v) => !v.ok);
  const passed = verdictLog.length - failed.length;
  console.log(
    `\n   判据合计 ${verdictLog.length} 条：\x1b[32m${passed} ✓\x1b[0m / ` +
      (failed.length > 0 ? `\x1b[31m${failed.length} ✗\x1b[0m` : "0 ✗"),
  );
  for (const f of failed) console.log(`     \x1b[31m✗\x1b[0m ${f.text}`);
  return failed.length === 0 && verdictLog.length > 0;
}

/**
 * 验收脚本的统一入口。两件事，各自有实测理由：
 *
 * 1. **清理先于退出。** `process.exit()` **不解开 try/finally** ——
 *    把 exit 写在 try 里，`finally { rmSync }` 就是死代码。实测：本机 `$TMPDIR`
 *    积了 104 个 `workagent-*` 残留目录，每跑一次 `verify:all` 约增 4 个，
 *    里面是完整的 runs.db 与 workspace。这里把 exit 移到 finally 之后。
 * 2. **退出码由登记表推出**（见 `verdictLog`）。
 *
 * 仍用 `process.exit()` 而不是 `process.exitCode`：脚本里有 SQLite 句柄与子进程，
 * 靠事件循环自然退出有挂住的风险，而验收脚本挂住比泄漏更难排查。
 * 清理已经在 finally 里跑完了，此时强制退出是安全的。
 *
 * `body` 里的早退站点直接 `return` 即可 —— 它此前打印的那条 `verdict(false, …)`
 * 会把退出码带成 1，不需要也不应该再手动 exit。
 */
export async function runVerify(
  body: () => Promise<void>,
  cleanup?: () => void | Promise<void>,
): Promise<void> {
  let ok = false;
  try {
    await body();
    ok = concludeVerdicts();
  } catch (err) {
    console.error(err);
    ok = false;
  } finally {
    await cleanup?.();
  }
  process.exit(ok ? 0 : 1);
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
    /**
     * 起始轮次。**跨进程 resume 的验收必须用它**：恢复段是一个新进程、
     * 新的 ScriptedModelPort，从第 0 轮重放会把已经配过对的 toolCallId
     * 再发一次，那不是「模型继续干活」，是一份失真的世界。
     */
    startTurn = 0,
    /**
     * 每轮的 usage。默认写死 input 100 / output 20 —— **那正是存量清单
     * §4 第 3 条说的覆盖缺口**：token 与预算路径在脚本化模型下永远是常量，
     * 所以 usage 清零、预算轴、口径错配这类问题能同时存在而脚本全绿。
     * `verify:budget` 传真实数值让 token 轴能被撞到。
     */
    private readonly usageImpl: ModelUsage = defaultUsage(),
  ) {
    this.turn = startTurn;
  }

  async *invoke(
    request: ModelRequest,
    _signal: AbortSignal,
    _observer: ModelInvocationObserver,
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
      usage: this.usageImpl,
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

function defaultUsage(): ModelUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    billedInputTokens: 100,
  };
}

/**
 * 供验收脚本构造非默认 usage。
 *
 * ── 【定】`cacheRead` 这个参数是判别力本身，不是可选的方便 ─────────────────
 *
 * 这个函数原先无条件写 `cacheReadInputTokens: 0` ＋
 * `billedInputTokens: inputTokens` —— 于是**在每一个脚本化夹具里，
 * `inputTokens` 与 `billedInputTokens` 永远是同一个数**。
 *
 * 后果不是「少测了一个字段」：任何「该读 billed 却读了 input」的代码，
 * 在这套夹具下都测不出来，因为两个值恒等。主循环的漂移观测点就是这么
 * 带着 `usage.inputTokens` 绿了一个阶段，直到 2026-08-28 摸底考试在
 * 14/14 个真实 run 上打出 1482% 的假漂移才被发现（对 billed 比是 0.14%）。
 *
 * 所以凡是要验「读的是哪个 token 口径」的判据，都必须传一个非零 `cacheRead`
 * 让两者显式不等。默认仍为 0，既有调用点不受影响。
 */
export function makeUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
): ModelUsage {
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens,
    // §19.3：计费输入含缓存两项（profile 的 billedInputFormula = INPUT_PLUS_CACHE）。
    billedInputTokens: inputTokens + cacheReadInputTokens,
  };
}
