/**
 * 确定性 ID 生成器（V05 §24.2）。
 *
 * 存在的理由：Replay 要能逐字节一致。ID 里只要混进随机数或时间戳，
 * 两次运行的 transcript 就永远 diff 不干净。
 */

import type { IdGeneratorPort } from "@workagent/harness-runtime";
import { randomUUID } from "node:crypto";

export class DeterministicIdGenerator implements IdGeneratorPort {
  private readonly counters = new Map<string, number>();
  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  }
  reset(): void {
    this.counters.clear();
  }
}

export class RandomIdGenerator implements IdGeneratorPort {
  next(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }
}
