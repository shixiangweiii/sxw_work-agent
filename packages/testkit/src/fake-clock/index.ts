/**
 * FakeClock（V05 §24.2）。
 *
 * 阶段 1 用真时钟跑真端点，但 sleep 走这里 —— 验收脚本要能把
 * 「可控慢的工具」的延迟压缩掉，否则跑一次要等很久。
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

export class FakeClock implements ClockPort {
  private current: number;
  constructor(startAt = 1_700_000_000_000) {
    this.current = startAt;
  }
  now(): number {
    return this.current;
  }
  /** 不真等，直接推进虚拟时间。 */
  async sleep(ms: number): Promise<void> {
    this.current += ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
