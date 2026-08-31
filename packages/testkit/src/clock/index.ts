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
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
}
