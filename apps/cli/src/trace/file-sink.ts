/**
 * 把事件流落成 JSONL（V05 §19）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 起因：2026-08-24 的评测报告在「可观测与可审计」一项上扣分，理由是
 * CLI 用 `NullTraceSink` ＋ `InMemoryTranscriptStore`，进程退出后只剩一句
 * 「transcript: 21 条」，没有任何可重读的 run artifact。
 *
 * 两者性质不同，只有后半句是缺陷：
 *
 *   · transcript 内存态是**阶段 1 的定义**，SQLite 是阶段 2 的事，不该在这儿修；
 *   · 而 `CollectingTraceSink` 早就存在，三条 verify 脚本都在用 ——
 *     **唯一没有 trace 的路径，恰好是唯一跑真实端点的路径**。这个不对称没有理由。
 *
 * 所以这里补的是 trace 落盘，不是持久化 transcript。两者不要混为一谈：
 * 事件不是恢复的来源（恢复只读 transcript），它是诊断与评测的来源。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 格式：一行一个 JSON 对象。
 *
 *   第一行    { "kind": "header", ... }   运行的身份：commit / 端点 / 模型 / 任务
 *   中间 N 行 { "kind": "event",  ... }   完整事件流，带 D-2 统一后的 sequence
 *   最后一行  { "kind": "footer", ... }   terminal / outcome / 预算
 *
 * 选 JSONL 而不是一个大 JSON 数组，是因为它对**进程被 kill** 是安全的：
 * 崩溃时已经写下的行仍然可读，缺的只是 footer。而一个没闭合的 JSON 数组
 * 整份都解析不了 —— 恰好在最需要看轨迹的那种情况下最没用。
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEvent, TraceSinkPort } from "@workagent/harness-runtime";

export interface TraceHeader {
  runId?: string;
  commit: string;
  endpointProfile: string;
  modelId: string;
  task: string;
  workspaceRoot: string;
  timezone: string;
  startedAt: string;
}

export class FileTraceSink implements TraceSinkPort {
  private headerWritten = false;
  private eventCount = 0;
  /**
   * header 是个 thunk，不是值 —— 两个先后顺序逼出来的：
   *
   *   · sink 必须先存在，`compose()` 才拿得到它；
   *   · 而 header 里的端点声明、modelId、时区，全都要等 compose 之后才知道。
   *
   * 写 header 的时机是第一个事件到达时（那时 runId 才由 Facade 生成好），
   * 到那一刻这两件事都已经完成。用 thunk 表达这个「读得晚」，
   * 比传一个稍后被就地改掉的对象要难用错。
   */
  constructor(
    readonly filePath: string,
    private readonly header: () => Omit<TraceHeader, "runId">,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "", "utf8");
  }

  emit(event: RunEvent): void {
    if (!this.headerWritten) {
      this.write({ kind: "header", ...this.header(), runId: String(event.runId) });
      this.headerWritten = true;
    }
    this.eventCount += 1;
    this.write({ kind: "event", ...event });
  }

  /**
   * 收尾。CLI 在 generator 耗尽后调用。
   *
   * 【定】它不是 TraceSinkPort 的一部分 —— Port 只管 emit。
   * 「一次 Run 的边界在哪」是 CLI 知道的事，不是 sink 该猜的。
   */
  finish(footer: Record<string, unknown>): void {
    this.write({ kind: "footer", eventCount: this.eventCount, ...footer });
  }

  private write(obj: unknown): void {
    // 同步写。事件量在阶段 1 是几十条量级，异步排队带来的「崩溃时丢最后几行」
    // 比那点 IO 开销更贵 —— 最后几行恰恰是最想看的。
    appendFileSync(this.filePath, `${JSON.stringify(obj)}\n`, "utf8");
  }
}
