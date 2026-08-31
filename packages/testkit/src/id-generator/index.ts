/**
 * IdGeneratorPort 的实现。
 *
 * 【定】这里**只有** `RandomIdGenerator`。
 *
 * 原本还有一个 `DeterministicIdGenerator`（「Replay 要能逐字节一致，
 * ID 里混进随机数两次运行就永远 diff 不干净」）—— 理由成立，
 * 但 Replay 至今没做，而它全仓零使用者。真做 Replay 的那天第一步是
 * 写那个比对器，不是先摆一个没人调的生成器。
 */

import { randomUUID } from "node:crypto";
import type { IdGeneratorPort } from "@workagent/harness-runtime";

export class RandomIdGenerator implements IdGeneratorPort {
  next(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }
}
