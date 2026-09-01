/**
 * ClockPort 的真实现。
 *
 * 【定】这里**没有** FakeClock。它写在 V05 §24.2 里、也确实实现了，
 * 但全仓零使用者 —— 验收脚本用的是真时钟 ＋ 可控慢的工具。
 * 一个没有使用者的测试夹具与一条没有判据的断言是同一类东西。
 */

import type { ClockPort } from "@workagent/harness-runtime";

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }
  /**
   * 可被打断的等待。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】两条，都是评审实测出来的：
   *
   * ① **已经 aborted 的 signal 要立刻返回。**
   *    `addEventListener("abort")` 对一个**已经**触发过的 signal 不会再触发
   *    （实测确认）。原实现只挂监听，于是 Ctrl+C 之后才走到这里的那一次
   *    退避会**睡满**，而 `signal` 这个参数看起来是管用的。
   *
   * ② **打断时 `resolve`，不 `reject`。**
   *    唯一的消费者是 `run-loop.ts` 的模型错误退避，它在 `catch` 块里 await
   *    这一句。原实现 reject 一个 `AbortError` —— 那个异常会**穿过整个
   *    runLoop generator**：不经 `finish()`、没有具名 Terminal、不落
   *    `LoopTerminated`，最后在 `main().catch()` 里打成一句
   *    「启动失败：Aborted」。也就是说「Ctrl+C 协作式取消」在这条路径上
   *    表现为一次崩溃，而循环纪律第 2 条要求每个 return 都是具名 Terminal。
   *
   *    提前 resolve 之后，控制权回到循环顶部那句
   *    `if (interrupts.aborted) return yield* finish({ reason: "ABORTED_TOOLS" })`
   *    —— 取消由它承载，与其余取消路径同一个出口。
   *
   * 【定】语义因此是「**等到时间到、或等到被取消**」，不是「等不到就报错」。
   * 调用方判「有没有被取消」一律读 signal，不读这个函数的返回方式。
   * ══════════════════════════════════════════════════════════════════════
   */
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
