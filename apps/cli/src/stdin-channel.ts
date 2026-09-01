/**
 * 终端的**单一** stdin 通道（阶段 3 S1）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么必须是「单一」：三条运行期交互通道会抢同一个 stdin。
 *
 *   · 审批应答      —— 阶段 1 就有（`rl.question`）
 *   · 运行期插话    —— 阶段 3 S1 补（`interject` 从阶段 1 挂到现在）
 *   · 接管完成信号  —— 阶段 3 S10 补（人工接管）
 *
 * 各建各的 `readline.createInterface` 会让同一行被两个消费者抢，
 * 或者让先建的那个把行吃掉而后建的永远等不到 —— 这类 bug 只在
 * 「恰好在等审批时敲了一句插话」的时候出现，最难复现。
 *
 * 【定】所以只有这里创建 readline，其余人向它注册意图。
 *
 * ── 回车的含义按「谁在等」分派（S1 定死，S10 用第三条）──────────────────
 *
 * | 有人在 `askLine()` 上等吗 | 回车的含义                        |
 * |---------------------------|-----------------------------------|
 * | 没有                      | 提交插话                          |
 * | 有                        | 交给那个等待者（审批 / 接管 / 提问）|
 *
 * 一个正在 await 的等待者永远优先于插话。反过来（先看一个「当前状态」字段）
 * 会在状态还没来得及更新时把审批应答当成插话吞掉。
 *
 * ── 【定】这里**没有** `mode` / `setMode()` / `currentMode()` ──────────────
 *
 * 曾经有：一个 `StdinMode` 字段 ＋ 一个 setter ＋ 一个 getter，
 * `main.ts` 在三处 try/finally 里认真地拨它。而 `currentMode()` **零调用点**，
 * `line` 回调也从不读它 —— 也就是说那个字段是**纯写入**的。
 *
 * 更要紧的是它与上面这张表构成了一句假话：表原本按「状态」分派，
 * 而实现按「谁在等」分派，两者只是恰好总能得出同一个答案。
 * 一个只写不读的状态机会让下一个人以为「分派靠 mode」，
 * 然后在某处 `if (mode === …)` 上建一条逻辑 —— 那时它才第一次真的错。
 * 与 `ProgressGuard.lastProgressAt`、`DriftDetector.seen` 是同一形态。
 *
 * ── 非交互环境（无 TTY）必须优雅降级 ──────────────────────────────────
 *
 * 【定】不得让脚本化运行卡住。`npm run dev < /dev/null`、CI、
 * 以及把输出重定向到文件的场景都没有 TTY —— 在那里挂起等一个
 * 永远不会来的回车，比直接说「这里需要人」糟得多。
 * ══════════════════════════════════════════════════════════════════════
 */

import { createInterface, type Interface } from "node:readline";

export interface StdinChannelDeps {
  /** RUNNING 状态下敲入的一行去哪儿。 */
  onInterject(text: string): void;
  /**
   * 输入/输出流与「这里有没有人」。都不传时就是真的 stdin / stdout / isTTY。
   *
   * 【定】它们是为**验收脚本**开的注入口，不是为生产用的：
   * 三态仲裁（谁在等、abort 后 waiter 有没有被清干净）此前**零机械覆盖** ——
   * `StdinChannel` 全仓只在 `main.ts` 里被构造过一次，而 verify 里的审批与
   * 接管走的都是注入的假通道，一行都不经过这里。而它恰恰是
   * 「恰好在等审批时敲了一句插话」这类最难复现的 bug 的所在地。
   * 见 `verify:progress` G 段。
   */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  interactive?: boolean;
}

export class StdinChannel {
  private readonly rl: Interface | undefined;
  private readonly out: NodeJS.WritableStream;
  /** 正在等一行输入的人。先到先得，最多一个。**分派只看它**，见文件头。 */
  private waiter: ((line: string) => void) | undefined;

  constructor(private readonly deps: StdinChannelDeps) {
    const input = deps.input ?? process.stdin;
    this.out = deps.output ?? process.stdout;
    const interactive = deps.interactive ?? process.stdin.isTTY === true;
    if (!interactive) {
      // 优雅降级：不接管 stdin，也不报错。isInteractive 为 false 时
      // 调用方自己决定怎么办（见 askLine 的说明）。
      this.rl = undefined;
      return;
    }
    this.rl = createInterface({ input, output: this.out });
    this.rl.on("line", (raw) => {
      const line = raw.trim();
      const w = this.waiter;
      if (w) {
        this.waiter = undefined;
        w(line);
        return;
      }
      if (line.length === 0) return; // RUNNING 下的空回车不是插话
      this.deps.onInterject(line);
    });
  }

  get isInteractive(): boolean {
    return this.rl !== undefined;
  }

  /**
   * 等用户敲一行。
   *
   * 返回 undefined 有两种情况，调用方都必须处理，**不得当成空串继续**：
   *   · 无 TTY —— 这里根本没有人；
   *   · signal 被 abort（Ctrl+C）—— 用户不想等了。
   *
   * 【定】接上 signal 是 U-2 的一半：在此之前 Ctrl+C 打不断审批等待，
   * 用户得再敲一次回车才轮得到取消生效。
   */
  async askLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.rl) return undefined;
    if (signal?.aborted) return undefined;

    this.out.write(prompt);
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const done = (v: string | undefined): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = (): void => {
        // 【定】放弃等待时必须把 waiter 清掉，否则下一行会被这个
        // 已经没人要的等待者吃掉，而插话就此静默消失。
        if (this.waiter === handler) this.waiter = undefined;
        done(undefined);
      };
      const handler = (line: string): void => done(line);

      this.waiter = handler;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    this.rl?.close();
  }
}
