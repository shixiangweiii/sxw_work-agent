/**
 * 中断机制（V05 §9.1）。
 *
 * 三种中断，三种机制，全都不持久化：
 *
 *   Cancel           单个 AbortController          立即，协作式
 *   Interject        进程内队列                    每轮迭代开始处排空
 *   Approval 决策     审批回调的 await              Action 执行前
 *
 * 「不持久化」是消息级恢复的直接推论：进程死了 Run 就结束，
 * 恢复时读 transcript 重来。队列里没排空的东西不是事实。
 *
 * 没有 Pause / Unpause —— 产品上的「暂停」实现为 cancel() ＋ 稍后 resume()。
 */

export interface InterjectionItem {
  content: string;
  intent: "ADD_CONTEXT" | "CONSTRAIN" | "REDIRECT";
  urgency: "NEXT_FRAME" | "NEXT_SAFE_POINT";
  at: number;
}

/**
 * 进程内插话队列。
 *
 * 【定】已排空并落盘为消息的才是事实，队列里的不是。
 * 因此 drain() 之后调用方必须先把它们落盘再进内存 messages（不变量 5）。
 */
export class InterjectQueue {
  private items: InterjectionItem[] = [];

  push(item: Omit<InterjectionItem, "at">, now: number): void {
    this.items.push({ ...item, at: now });
  }

  /** 排空并返回。调用方负责落盘。 */
  drain(): InterjectionItem[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  get size(): number {
    return this.items.length;
  }
}

/**
 * Run 级中断控制器。
 *
 * 【定】取消通过单个 AbortController 传播，signal 传给所有 Port 调用。
 * 一个 Run 一个 controller —— 不要为每一步新建，否则取消传不下去。
 */
export class RunInterrupts {
  private readonly controller = new AbortController();
  readonly interjections = new InterjectQueue();
  private cancelReason: string | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  get reason(): string | undefined {
    return this.cancelReason;
  }

  cancel(reason = "用户取消"): void {
    if (this.controller.signal.aborted) return;
    this.cancelReason = reason;
    this.controller.abort();
  }

  /**
   * 给单步加超时，但共享 Run 级取消。
   *
   * 等待就是 await —— 没有 Durable Timer，进程死了所有等待一起死，
   * 这与「进程死了 Run 就结束」是一致的（V05 §18.6）。
   */
  stepSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]);
  }
}
