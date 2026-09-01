/**
 * 把事件流落成 JSONL（V05 §19）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 起因：2026-08-24 的评测报告在「可观测与可审计」一项上扣分，理由是
 * CLI 当时装的是 `NullTraceSink`，进程退出后只剩一句「transcript: 21 条」，
 * 没有任何可重读的 run artifact —— 而 `CollectingTraceSink` 早就存在，
 * 三条 verify 脚本都在用。**唯一没有 trace 的路径，恰好是唯一跑真实端点的路径。**
 * 这个不对称没有理由。
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEvent, TraceSinkPort } from "@workagent/harness-runtime";

export interface TraceHeader {
  runId?: string;
  commit: string;
  endpointProfile: string;
  modelId: string;
  task: string;
  workspaceRoot: string;
  /**
   * 本段的执行特权档位（ADR-0012，二次评审 P2-5）。
   *
   * 【定】必填，两个入口都要写。少了它，一份 JSONL 独立拿出来时
   * 回答不了「这一段当时有没有沙箱」—— 而这份文件的全部意义就是
   * 「可审计的唯一 artifact」。见 `RunStarted.executionPrivilege` 那段：
   * 唯一看起来能替代它的东西（界面上的当前服务档位）在重启换档之后就是错的。
   */
  executionPrivilege: string;
  timezone: string;
  startedAt: string;
  /**
   * 本文件里的第几个执行段（0 起）。resume 一次多一段。
   *
   * N-1（阶段 2 自己引入的缺口）：跨进程 resume 之前，trace 文件按**进程启动
   * 时间**命名，于是一个 Run 跨三个进程就是三个互不相干的 JSONL。
   * 而「Trace 是可审计的唯一 artifact」这个说法，在文件分裂之后自己就不成立了。
   */
  segmentIndex?: number;
  /** 本段是恢复而来时，上一段结束时的 transcript 末尾序号。 */
  resumedFrom?: number;
}

export class FileTraceSink implements TraceSinkPort {
  private headerWritten = false;
  private eventCount = 0;
  private resolvedPath: string | undefined;
  private segmentIndex = 0;

  /**
   * header 是个 thunk，不是值 —— 两个先后顺序逼出来的：
   *
   *   · sink 必须先存在，`compose()` 才拿得到它；
   *   · 而 header 里的端点声明、modelId、时区，全都要等 compose 之后才知道。
   *
   * 写 header 的时机是第一个事件到达时（那时 runId 才由 Facade 生成好），
   * 到那一刻这两件事都已经完成。用 thunk 表达这个「读得晚」，
   * 比传一个稍后被就地改掉的对象要难用错。
   *
   * `pathFor` 同理是函数而不是字符串：**文件名要按 runId 定**，而 `start()`
   * 路径上 runId 要等第一个事件才存在。这就是 N-1 的修法 ——
   * 一个 Run 一个文件，resume 往同一个文件里续写下一段。
   */
  constructor(
    private readonly pathFor: (runId: string) => string,
    private readonly header: () => Omit<TraceHeader, "runId" | "segmentIndex">,
  ) {}

  /** 第一个事件到达前它是 undefined —— 那时还不知道 runId，也就还没有文件。 */
  get filePath(): string | undefined {
    return this.resolvedPath;
  }

  emit(event: RunEvent): void {
    if (!this.headerWritten) {
      const path = this.pathFor(String(event.runId));
      this.resolvedPath = path;
      mkdirSync(dirname(path), { recursive: true });

      /**
       * 已存在就**续写**，不覆盖。段号 = 文件里已有的 header 行数。
       *
       * 覆盖会把上一段的轨迹删掉 —— 而跨进程恢复的那次运行，正是最需要
       * 把两段并排着看的时候。
       */
      if (existsSync(path)) {
        this.segmentIndex = countHeaders(path);
      } else {
        writeFileSync(path, "", "utf8");
        this.segmentIndex = 0;
      }

      this.write({
        kind: "header",
        ...this.header(),
        runId: String(event.runId),
        segmentIndex: this.segmentIndex,
      });
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
    // 一个事件都没发出过（比如 resume 前就抛了）时没有文件，也就没有 footer 可写。
    if (!this.resolvedPath) return;
    this.write({ kind: "footer", segmentIndex: this.segmentIndex, eventCount: this.eventCount, ...footer });
  }

  private write(obj: unknown): void {
    // 同步写。事件量是几十到几百条量级，异步排队带来的「崩溃时丢最后几行」
    // 比那点 IO 开销更贵 —— 最后几行恰恰是最想看的。
    // 阶段 2 之后这一点更硬：verify:crash 靠的就是被 kill -9 之后盘上还剩什么。
    appendFileSync(this.resolvedPath!, `${JSON.stringify(obj)}\n`, "utf8");
  }
}

/** 数已有的 header 行，得出本次是第几段。坏行忽略——它不该让恢复失败。 */
function countHeaders(path: string): number {
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      if ((JSON.parse(line) as { kind?: string }).kind === "header") n += 1;
    } catch {
      /* 忽略 */
    }
  }
  return n;
}
