/**
 * 「人在浏览器里」的三条通道（阶段 4 决 4）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】三个接口一个字不改：`ApprovalDecider` / `HandoffChannel` / `QuestionChannel`。
 *
 * `compose.ts` 里那句「只有这一层知道『人在哪』（终端、GUI、还是一个没有人的 CI）」
 * 写了一个阶段，而在此之前**只有终端这一种人**。本文件是那句话的第一次兑现，
 * 也是阶段 4 研究问题的判别力所在：如果它们真是注入点，Runtime 一行不改；
 * 如果不是，这个文件写不出来 —— 而那本身就是最有价值的发现。
 *
 * ── 【定】浏览器与终端有一处语义差别，不得抹平 ──────────────────────────
 *
 *   无 TTY   = **真的没有人**。审批按拒绝处置，接管按「没有人」处置。
 *   浏览器没连 = 人可能只是关了标签页，**稍后会回来**。
 *
 * 所以这里的等待**不按拒绝处置**，它一直等到有人应答、或 Run 被取消
 * （signal abort）。把两者做成同一种处置，会让「关掉标签页」变成
 * 「拒绝了这次写入」—— 而那正是 E-3 那条教训的形状：
 * 结算成 USER_REJECTED，而全程没有任何人拒绝过任何东西。
 *
 * 代价明说：没人看着的时候，一个等审批的 Run 会一直挂着。这是**正确的**行为
 * （审批的意义就是等人），但它意味着无人值守跑批不要用 Web 入口 —— 用 CLI，
 * 那里的非交互降级是为无人值守设计的。
 * ══════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from "node:crypto";
import type {
  ApprovalDecider,
  ApprovalDecision,
  PreparedAction,
} from "@workagent/harness-runtime";
import type { HandoffChannel, QuestionChannel } from "@workagent/tools-common";
import { stripUnsafeDisplayChars } from "../../cli/src/compose.js";
import type { ApprovalMode } from "../../cli/src/compose.js";
import type { UiPending } from "./api-types.js";

export type PendingAnswer =
  | { kind: "APPROVAL"; approved: boolean; reason?: string }
  | { kind: "HANDOFF"; note?: string }
  /** `choice` 为空串 = 人明确说「你自己定」，走 NO_ANSWER。 */
  | { kind: "QUESTION"; choice: string };

interface Waiter {
  pending: UiPending;
  resolve: (answer: PendingAnswer | undefined) => void;
}

/**
 * 所有正在等人的请求。
 *
 * 【定】它是**进程内**状态，与 `HarnessRuntime.interruptsByRun` 同一条理由：
 * 一个 `await` 的作用域天然就是进程（§18.6【定】「等待就是 await，
 * 进程死了所有等待一起死」）。落库会造出「盘上有一个等待、而没有任何代码在等它」
 * 的假象 —— 那比丢掉它更糟。
 *
 * 跨进程的那一半由 `runs.status`（`WAITING_FOR_APPROVAL` /
 * `WAITING_FOR_INTERACTION`）承担，它本来就是为这件事写的。
 */
export class PendingHub {
  private readonly waiters = new Map<string, Waiter>();
  private readonly listeners = new Set<() => void>();

  list(runId?: string): UiPending[] {
    const all = [...this.waiters.values()].map((w) => w.pending);
    return runId ? all.filter((p) => p.runId === runId) : all;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 应答一个等待。返回 false = 这个 id 不在等（已被应答过、或已被取消）。
   *
   * 【定】**幂等**：重复应答同一个 id 只有第一次生效。
   * 界面上双击一次「批准」不该批准两次 —— 而 §5.4 要求「所有命令携带
   * idempotency key」，`pendingId` 就是这里的 key。
   */
  answer(pendingId: string, answer: PendingAnswer): boolean {
    const w = this.waiters.get(pendingId);
    if (!w) return false;
    if (w.pending.kind !== answer.kind) return false;
    this.waiters.delete(pendingId);
    w.resolve(answer);
    this.notify();
    return true;
  }

  /** 等一个人。signal abort 时 resolve(undefined) —— 调用方各自决定这算什么。 */
  private wait(
    pending: UiPending,
    signal: AbortSignal,
  ): Promise<PendingAnswer | undefined> {
    return new Promise<PendingAnswer | undefined>((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      const onAbort = (): void => {
        // 【定】abort 时必须把 waiter 从表里清掉。留着的话，界面上会一直
        // 显示一个没有人在等的请求，点它会「成功」应答一个已经结束的 Run。
        // 这与 `StdinChannel` abort 时清 waiter 是同一条（那条有判别力实测）。
        this.waiters.delete(pending.pendingId);
        this.notify();
        resolve(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(pending.pendingId, {
        pending,
        resolve: (a) => {
          signal.removeEventListener("abort", onAbort);
          resolve(a);
        },
      });
      this.notify();
    });
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ────────────────────────────────────────────────── 三条通道的实现

  /**
   * 审批。
   *
   * `autoGrant` 由 Composition Root 注入（与 CLI 用**同一个**判定函数）——
   * 抄一份的直接后果是两个入口的闸门档位不一致，而那种不一致在绿灯下看不出来。
   */
  approvalDecider(
    autoGrant: (a: PreparedAction) => { ok: true } | { ok: false; why: string },
    /**
     * 当前审批档位（ADR-0012）。
     *
     * 【定】**读函数，不是值** —— 与 CLI 那边一字不差的理由：decider 在
     * `compose()` 的那一刻建出来、之后整个进程都用同一个闭包，传值进来
     * 就意味着档位在服务启动的那一刻被钉死，而界面上那个开关是要能中途拨的。
     */
    approvalMode: () => ApprovalMode,
    /**
     * 这个 Run 是否已被人说过「不再问」。
     *
     * 【定】逐 Run，且**由 RunHost 持有**而不是本类 —— `PendingHub` 的
     * 全部状态都是「谁在等」，而这是一条「谁不用再等了」的产品状态。
     * 混进来的话，一个 `clear()` 之类的操作会同时清掉两种语义不同的东西。
     */
    isElevated: (runId: string) => boolean,
    /**
     * 【定】Run 归属读的是 `action.runId`，**不是** compose 时绑定的某个变量。
     *
     * `ApprovalDecider` 只收一个 `PreparedAction`，而它自带 runId —— 于是审批
     * 的归属是精确的，不需要「当前 Run」这种晚绑定。接管与提问两条通道没有这个
     * 字段（`HandoffChannel.await` 只收 instructions / expectedCompletion / signal），
     * 那两条才必须靠 `currentRunId` 兜，也因此才需要「同时只跑一个 Run」的限制。
     *
     * 【定】等待要挂在**逐 Run 的 signal** 上。`ApprovalDecider` 的签名里没有
     * signal（CLI 那边挂的是进程级 SIGINT），所以由调用方按 runId 提供 ——
     * 挂错的后果是取消一个 Run 会把另一个 Run 的审批一起打断。
     */
    signalFor: (runId: string) => AbortSignal,
  ): ApprovalDecider {
    return async (action: PreparedAction): Promise<ApprovalDecision> => {
      const runId = String(action.runId);
      /**
       * 【定】档位每次调用重新读。少了这一行，界面上那个开关与
       * 「本次 Run 不再问」按钮全都不生效 —— 而它们会**看起来**生效
       * （按钮点得动、状态也变了），只是审批照旧弹出来。
       */
      const mode = approvalMode();
      if (mode === "AUTO" || isElevated(runId)) {
        return {
          approved: true,
          reason: mode === "AUTO" ? "AUTO 档" : "本次 Run 已设为不再询问",
          decidedBy: "AUTO",
        };
      }

      // CONFIRM 档跳过有限自动放行，直接问 —— 与 CLI 同一条分派顺序。
      const grant = mode === "CONFIRM" ? { ok: false as const, why: "CONFIRM 档：每一步都问" } : autoGrant(action);
      if (grant.ok) return { approved: true, reason: "默认档位自动放行", decidedBy: "AUTO_GRANT" };

      const signal = signalFor(runId);
      const e = action.resolvedEffect;
      const input = (action.normalizedInput ?? {}) as Record<string, unknown>;
      /**
       * ══════════════════════════════════════════════════════════════════
       * 【定】模型产出的展示文本必须剥控制字符，**与 CLI 同一个函数**。
       *
       * `textContent` 挡住了 HTML 注入，但**挡不住 Unicode 双向覆盖与零宽字符**。
       * 实测：一条命令带 RLO / PDF / ZWSP，三个控制字符原样进了 DOM ——
       *
       *     rm -rf /tmp/<RLO>gpj.eliforp<PDF>   浏览器显示成 rm -rf /tmp/profile.jpg
       *
       * 用户看到的顺序与真正交给 shell 的文本不同。审批是 EXECUTE 唯一的人工
       * 边界，**一个可以被展示内容伪造的边界不再是边界** —— 这句话 CLI 那边
       * 写了一个阶段，而 Web 这边（现在的主入口）没有兑现。
       * ══════════════════════════════════════════════════════════════════
       */
      const show = (v: unknown, fallback = ""): string =>
        typeof v === "string" ? stripUnsafeDisplayChars(v) : fallback;
      const pending: UiPending = {
        pendingId: randomUUID(),
        runId,
        kind: "APPROVAL",
        requestedAt: Date.now(),
        approval: {
          actionId: String(action.id),
          toolName: action.toolName,
          effectType: e.effectType,
          scopeKind: e.scope.kind,
          // scope.value 由受信 Resolver 产出，但它含模型给的路径片段 —— 一并剥。
          scopeValue: stripUnsafeDisplayChars(e.scope.value),
          reversibility: e.reversibility,
          why: grant.why,
          /**
           * PROCESS scope 必须把命令原文带上（与 `main.ts` 同源）。
           * `scope.value` 对一条 shell 命令是**程序名集合**（§12.4 不以自由文本
           * 作为授权边界），于是 `rm -rf build` 与 `rm -rf /` 在那一行里长得一样。
           * 那不是审批，那是盲批。
           */
          ...(e.scope.kind === "PROCESS"
            ? {
                command: show(input["command"], "(读不到命令原文)"),
                ...(typeof input["description"] === "string"
                  ? { description: show(input["description"]) }
                  : {}),
                allowNetwork: input["allow_network"] === true,
                /**
                 * 这条命令自称要交付什么（ADR-0010）。剥控制字符 ——
                 * 它和 command 一样完全由模型给，同一条理由。
                 */
                ...(typeof input["artifact_path"] === "string"
                  ? {
                      artifactPath: show(input["artifact_path"]),
                      artifactRole:
                        input["artifact_role"] === "INTERMEDIATE" ? "INTERMEDIATE" : "DELIVERABLE",
                    }
                  : {}),
              }
            : {}),
          /**
           * 外部 MCP 工具（ADR-0011）。**与 `main.ts` 的 EXTERNAL_TOOL 分支
           * 是同一份内容的两处**，必须一起改。
           *
           * 【定】不能并进上面的 PROCESS 分支：那一支会打出
           * 「沙箱：只能写 workspace 与 $TMPDIR」，而 MCP 工具**没有沙箱**。
           * 在审批的那一刻给出一句方向相反的保证，比不给保证更糟。
           *
           * 【定】整份入参带上，不挑字段。Atlas 不解析 MCP 的参数
           * （那正是"换个 MCP 只改配置"的代价），所以没有哪个字段能被
           * 认定为"关键字段"—— 挑就等于 Atlas 假装看懂了它。
           */
          ...(e.scope.kind === "EXTERNAL_TOOL"
            ? { externalArgs: stripUnsafeDisplayChars(JSON.stringify(input, null, 2)) }
            : {}),
        },
      };

      const answered = await this.wait(pending, signal);
      if (!answered || answered.kind !== "APPROVAL") {
        // 【定】等待被中断记 UNDECLARED，不是 HUMAN —— 没有人做过这个决定。
        return { approved: false, reason: "等待被中断（Run 被取消）", decidedBy: "UNDECLARED" };
      }
      return answered.approved
        ? { approved: true, ...(answered.reason ? { reason: answered.reason } : {}), decidedBy: "HUMAN" }
        : { approved: false, reason: answered.reason ?? "用户在界面上拒绝", decidedBy: "HUMAN" };
    };
  }

  /**
   * 人工接管（§20）。
   *
   * 【定】返回值不是「任务成功了」，只是「人说他做完了」——
   * §20.3 要求随后重新 Observation。这里只负责把人的信号递回去。
   */
  handoffChannel(currentRunId: () => string): HandoffChannel {
    return {
      await: async (request) => {
        const pending: UiPending = {
          pendingId: randomUUID(),
          runId: currentRunId(),
          kind: "HANDOFF",
          requestedAt: Date.now(),
          handoff: {
            // 同上：这两段也是模型写的，而人要照着它去动外部世界。
            instructions: stripUnsafeDisplayChars(request.instructions),
            expectedCompletion: stripUnsafeDisplayChars(request.expectedCompletion),
          },
        };
        const answered = await this.wait(pending, request.signal);
        if (!answered || answered.kind !== "HANDOFF") return undefined;
        return answered.note ? { note: answered.note } : {};
      },
    };
  }

  /**
   * 问一道选择题（ADR-0008）。
   *
   * 【定】与 handoff 分开两个实现，**不共用一条分支**。
   * 两者的失败语义相反：没人接管是失败（那件事真的没做），
   * 没人回答不是失败（模型自己定）。合并的第一天就会有人把它们写成同一种。
   */
  questionChannel(currentRunId: () => string, approvalMode: () => ApprovalMode): QuestionChannel {
    return {
      ask: async (request) => {
        /**
         * ── ADR-0012：AUTO 档不问，直接 NO_ANSWER（与 CLI 同一条口径）───────
         *
         * 【定】这一支**只对 `ask_user` 存在**，`handoffChannel` 里没有对应的
         * 一支，而那是刻意的：没人回答不是失败（模型自己定），没人接管是失败
         * （那件事真的没做）。见 ADR-0008 那张对照表 ——
         * 「两者表面上都是停下来等人」正是当初那次错误合并的成因。
         *
         * 【定】它照样进 `UiPending` 之外的可见轨道：工具会落一条
         * NO_ANSWER 的 tool_result，时间线上读得到。这里不额外造事件 ——
         * 造一条只有这一档才有的事件，等于让两个档位的事件流不同构。
         */
        if (approvalMode() === "AUTO") return undefined;
        const pending: UiPending = {
          pendingId: randomUUID(),
          runId: currentRunId(),
          kind: "QUESTION",
          requestedAt: Date.now(),
          question: {
            question: stripUnsafeDisplayChars(request.question),
            options: request.options.map(stripUnsafeDisplayChars),
          },
        };
        const answered = await this.wait(pending, request.signal);
        if (!answered || answered.kind !== "QUESTION") return undefined;
        // 空串 = 人明确说「你自己定」。工具会把 undefined 处置成 NO_ANSWER，
        // 那是一条正常的降级路径，不是错误（阶段 3.5 决 3）。
        if (answered.choice.length === 0) return undefined;
        const inList = request.options.includes(answered.choice);
        return inList
          ? { choice: answered.choice }
          : {
              choice: answered.choice,
              note: "用户没有选列表里的选项，而是自己写了一个答案",
            };
      },
    };
  }
}
