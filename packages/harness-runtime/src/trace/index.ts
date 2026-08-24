/**
 * Trace sink（V05 §19.1）。
 *
 * Event 不是独立的持久化轨道 —— 它从 generator yield 给消费方，
 * 由这里落盘用于诊断，**恢复不读它**。
 *
 * 阶段 1 先 console，接口按最终形态定。
 */

import type { RunEvent } from "../types/event.js";
import type { TraceSinkPort } from "../ports/index.js";

export class NullTraceSink implements TraceSinkPort {
  emit(_event: RunEvent): void {
    /* 验收脚本用：事件由脚本自己消费，不重复打印 */
  }
}

export class CollectingTraceSink implements TraceSinkPort {
  readonly events: RunEvent[] = [];
  emit(event: RunEvent): void {
    this.events.push(event);
  }
  byType<T extends RunEvent["type"]>(type: T): Extract<RunEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<RunEvent, { type: T }>[];
  }
}
