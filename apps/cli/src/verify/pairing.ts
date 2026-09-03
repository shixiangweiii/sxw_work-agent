/**
 * 验收项 2：verify:pairing
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：批内配对不变量在没有状态机的情况下能否守住？
 *
 * 不变量 8：批内每个 Tool Call 在返回模型前必须拥有恰好一个协议合法的 result。
 *
 * 它的理据不是「否则 Provider 会 400」—— 选定端点实测：
 *   缺 3 个 tool_result  → 200 接受
 *   篡改 tool_call_id    → 200 接受
 * 理据是「否则模型看到的是一个失真的世界」，而且**没有任何外部兜底**。
 *
 * 删掉纯 Kernel 之后，这条不变量失去了在纯函数里被穷举测试的可能，
 * 退化为分散在三条中断路径上的手写纪律。本项就是那三条路径的注入测试。
 *
 * ── 覆盖范围（阶段 2 补齐）────────────────────────────────────────────
 *
 * §9.2 的三条中断路径现在**各有一条真注入**：
 *   流式中断      → ScriptedModelPort 的 interrupted 标志
 *   工具执行中断  → `slow_write` 的 delay_ms ＋ 定时 cancel（阶段 3 换载体）
 *   模型错误      → ScriptedModelPort 的 throwError
 *
 * ── 阶段 3：中断判据的载体从 `write_note` 换成 `slow_write` ────────────
 *
 * 阶段 2 这条判据挂在 `write_note` 的 `delay_ms` 上。阶段 3 把那个工具
 * 迁进 `tools/common` 并改名 `write_file`，**同时去掉了 `delay_ms`** ——
 * 一个通用工具的入参里不该有「请慢一点」这种只服务于测量的旋钮。
 *
 * 【定】替代品必须是**可控慢的写**，不是可控慢的空转。
 * 纯延迟的 noop 测的是「延迟被取消」，永远 `NO_EFFECT`，
 * `sideEffectState` 的诚实上报测不到 —— 而那恰恰是取消路径上要守的东西。
 *
 * 阶段 1 用「第二个 Action 被审批拒绝」代偿了第二条，脚本抬头当时写明了
 * 不覆盖。那个代偿测的是**审批闸门**，与**执行中取消**在 settle-batch 里
 * 走的是不同出口 —— 现在两者都有独立场景，代偿场景保留为审批用例。
 *
 * 另加一段 orphan result 的**反向**注入：`findOrphanResults()` 在阶段 1
 * 有实现、有调用，却没有任何用例能让它返回非空 —— 一个永远返回空数组的
 * 检查器和没有检查器是分不出来的。
 *
 * 挂了意味着：消息级恢复下的批内配对代价比预估更大。
 * ══════════════════════════════════════════════════════════════════════
 */

import {
  CollectingTraceSink,
  findOrphanResults,
  findUnpairedToolUses,
  type ContextMessage,
} from "@workagent/harness-runtime";
import { approveExcept } from "@workagent/testkit";
import type { ApprovalDecider, ToolSnapshot } from "@workagent/harness-runtime";
import { compose, DEFAULT_TOOLS, type ComposeOptions } from "../compose.js";
import { ScriptedModelPort, banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

/**
 * 会抛异常的 Port 实现（R-4 的注入器）。
 *
 * 【定】它们抛的是**裸异常**，不是返回 ok:false —— 这正是 R-4 要防的形态。
 * 阶段 1 的四个真实现都在内部 try/catch 了，所以这条路径在真实现下走不到；
 * 而阶段 2 换实现的那一刻它就变成活跃 bug。注入是唯一能提前测到它的办法。
 *
 * ── 为什么不用 `as never` ─────────────────────────────────────
 *
 * 用 `as never` 断言掉类型检查的话，方法名拼错（`resolv`）会静默退化成
 * 「属性不存在 → 调用时 TypeError」，而 TypeError 同样被 guard() 收敛，
 * **用例照样绿**。那时这条用例验证的就不再是「Port 抛异常时配对守不守得住」，
 * 而是「调用一个不存在的方法会怎样」—— 两回事，而且没人看得出来。
 *
 * 三个 Port 都是单方法接口，所以写成真实类型完全不费劲：函数体只有 throw 时
 * 返回类型推断为 never，而 never 可赋给任何返回类型；下面的 satisfies
 * 因此既放行这些桩，又能在方法名写错时报错。
 */
const throwingPorts = {
  effects: {
    effects: {
      resolve() {
        throw new Error("注入：EffectResolver 内部炸了");
      },
    },
  },
  redaction: {
    redaction: {
      redact() {
        throw new Error("注入：Redaction 内部炸了");
      },
    },
  },
  verification: {
    verification: {
      async verify() {
        throw new Error("注入：Verifier 内部炸了");
      },
    },
  },
} satisfies Record<string, ComposeOptions["portOverrides"]>;

interface Scenario {
  name: string;
  path: string;
  build(): ScriptedModelPort;
  approvals?: number[];
  /** R-4 的注入点：让某个 Port 抛异常，看不变量 8 还守不守得住。 */
  portOverrides?: ComposeOptions["portOverrides"];
  /** 审批器本身抛异常（ApprovalDecider 不是 Port，但同属 R-4 的四个调用点）。 */
  throwingApproval?: boolean;
  /**
   * 真正的「工具执行到一半被 cancel」注入（存量清单 §4 第 1 条）。
   *
   * 阶段 1 用「第二个 Action 被审批拒绝」代偿了 §9.2 的第二条中断路径，
   * 脚本抬头也写明了不覆盖。那个代偿测的是**审批闸门**，不是**执行中取消** ——
   * 两者在 settle-batch 里走的是不同的出口。
   *
   * 数值 = 等多少毫秒后 cancel。`slow_write` 的 `delay_ms` 让工具可控地慢下来，
   * 于是取消必然落在 execute() 执行期间。
   */
  cancelAfterMs?: number;
  expectTerminal: string;
  /**
   * 【定】必须连 outcome 一起断言。
   *
   * 只断言 Terminal 会漏掉一整类错误：一个 requiredForSuccess 的写操作被用户拒绝，
   * 配对完全合规、循环也正常终止，但 Run 结算成 SUCCESS —— 这个脚本以前
   * 就是这么把一个错误结论固化下来的（期望值写的是 COMPLETED）。
   */
  expectOutcome: string;
}

const CALLS_3 = [
  { toolCallId: "tc_1", name: "list_dir", input: { path: "." } },
  { toolCallId: "tc_2", name: "write_file", input: { path: "a.txt", content: "A" } },
  { toolCallId: "tc_3", name: "list_dir", input: { path: "." } },
];

const scenarios: Scenario[] = [
  {
    name: "中断路径 B：工具执行中被 cancel（存量清单 §4 第 1 条）",
    path: "第 2 个 call 是一个慢写；执行到一半 cancel() → 它与第 3 个都必须有合法 result",
    build: () =>
      new ScriptedModelPort([
        {
          text: "三件事",
          toolCalls: [
            CALLS_3[0]!,
            { toolCallId: "tc_2", name: "slow_write", input: { path: "a.txt", content: "A", delay_ms: 800 } },
            CALLS_3[2]!,
          ],
        },
        { text: "收尾", toolCalls: [] },
      ]),
    cancelAfterMs: 250,
    expectTerminal: "ABORTED_TOOLS",
    expectOutcome: "CANCELLED",
  },
  {
    name: "基线：三个 call 全部正常执行",
    path: "（无中断）",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "先做三件事", toolCalls: CALLS_3 },
        { text: "做完了。", toolCalls: [] },
      ]),
    expectTerminal: "COMPLETED",
    expectOutcome: "SUCCESS",
  },
  {
    name: "中断路径 A：流式中断",
    path: "模型响应流被 abort，call 已发出但未执行",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "开始", toolCalls: CALLS_3, interrupted: true },
      ]),
    expectTerminal: "ABORTED_STREAMING",
    expectOutcome: "CANCELLED",
  },
  {
    name: "审批拒绝：必需操作未完成",
    path: "第 2 个 call（requiredForSuccess 的 write_file）被用户拒绝，第 3 个仍需 result",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "开始", toolCalls: CALLS_3 },
        { text: "有一个被拒了，我停下。", toolCalls: [] },
      ]),
    // 第 2 个（write_file，index 0 的审批调用）被拒绝
    approvals: [0],
    // 配对合规、循环正常终止，但必需操作确实没做成 —— 不能判 SUCCESS。
    expectTerminal: "COMPLETED_WITH_LIMITS",
    /**
     * 【定】阶段 2 起这里是 `USER_REJECTED`，不再是 COMPLETED_WITH_LIMITS（决 2）。
     *
     * **这不是回归，是预期变更。** A-1 修复当时把「用户拒绝了必需操作」
     * 结算成 COMPLETED_WITH_LIMITS，因为那时 `USER_REJECTED` 有值域、
     * 无事实来源 —— 结算看到一条失败的必需验证，分不出「用户按了 N」
     * 和「工具挂了」。阶段 2 给 VerificationResult 加了 `unmetCause`，
     * 这个区分才第一次有事实支撑。
     *
     * 语义边界见 settle-outcome.ts：**仅当所有**未达成的必需项都是用户拒绝
     * 时才判 USER_REJECTED；混着别的成因就仍是 COMPLETED_WITH_LIMITS。
     * 本场景只有一个被拒的写操作，所以是纯粹的用户拒绝。
     */
    expectOutcome: "USER_REJECTED",
  },
  {
    name: "中断路径 C：模型错误",
    path: "第一轮成功发出 call，第二轮请求抛错",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "开始", toolCalls: CALLS_3 },
        { toolCalls: [], throwError: { status: 400, message: "invalid request body" } },
      ]),
    expectTerminal: "MODEL_ERROR",
    expectOutcome: "FAILED",
  },

  // ── R-4：四个 Port 调用点各注入一次裸异常 ─────────────────────────
  //
  // 期望**不是**「Run 挂掉」，而是：批仍然 3/3 配对、Run 走到具名 Terminal、
  // 且 outcome 如实反映「必需操作没做成」。修复前这四条会让异常穿透 generator，
  // runLoop 收不到 BatchOutcome，Facade 的 status 永久停在 RUNNING。
  {
    name: "R-4 注入 A：EffectResolverPort.resolve() 抛异常",
    path: "三个 call 全部在 Effect 解析阶段炸掉，一个都没执行",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "开始", toolCalls: CALLS_3 },
        { text: "全都失败了。", toolCalls: [] },
      ]),
    portOverrides: throwingPorts.effects,
    // write_file 是 requiredForSuccess，没走到 Verification → 补一条 FAILED。
    expectTerminal: "COMPLETED_WITH_LIMITS",
    expectOutcome: "COMPLETED_WITH_LIMITS",
  },
  {
    name: "R-4 注入 B：ApprovalDecider 抛异常",
    path: "write_file 触发审批，审批器炸掉 —— 没批准就等于没执行",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "开始", toolCalls: CALLS_3 },
        { text: "审批出问题了。", toolCalls: [] },
      ]),
    throwingApproval: true,
    expectTerminal: "COMPLETED_WITH_LIMITS",
    expectOutcome: "COMPLETED_WITH_LIMITS",
  },
  {
    name: "R-4 注入 C：RedactionPort.redact() 抛异常",
    path: "工具已执行完，脱敏阶段炸掉 —— 副作用状态不得因此被改写",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "开始", toolCalls: CALLS_3 },
        { text: "脱敏出问题了。", toolCalls: [] },
      ]),
    portOverrides: throwingPorts.redaction,
    expectTerminal: "COMPLETED_WITH_LIMITS",
    expectOutcome: "COMPLETED_WITH_LIMITS",
  },
  {
    name: "R-4 注入 D：VerificationPort.verify() 抛异常",
    path: "工具已执行完，验证阶段炸掉 —— 等价于「没得出通过结论」",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "开始", toolCalls: CALLS_3 },
        { text: "验证出问题了。", toolCalls: [] },
      ]),
    portOverrides: throwingPorts.verification,
    expectTerminal: "COMPLETED_WITH_LIMITS",
    expectOutcome: "COMPLETED_WITH_LIMITS",
  },
];

async function main(): Promise<void> {
  banner(
    "验收项 2：批内配对不变量 ＋ 结算真实性",
    "异常路径注入后，配对是否仍然一一对应，且 outcome 与实际执行事实一致？",
  );
  console.log(
    "\n   覆盖说明：§9.2 的三条中断路径现在**各有一条真注入** ——\n" +
      "   流式中断、**工具执行中被 cancel**（用 slow_write 的 delay_ms）、模型错误；\n" +
      "   外加 R-4 的四条 Port 异常注入（Effect / Approval / Redaction / Verification），\n" +
      "   以及一条让 findOrphanResults() 返回非空的反向注入。\n" +
      "   阶段 1 用「第二个 Action 被审批拒绝」代偿第二条，那个场景保留为审批用例 ——\n" +
      "   它测的是审批闸门，与执行中取消在 settle-batch 里走的是不同出口。",
  );

  section("选定端点对配对的兜底强度（实测）");
  fact("validatesToolResultPairing", "false —— 缺 result 一律 200 放行");
  fact("validatesToolCallId", "false —— 篡改 id 一律 200 放行");
  console.log(
    "\n   也就是说：违反了不会报错，只会让模型看到一个失真的世界。\n" +
      "   下面这个扫描是唯一会发现违反的东西。",
  );

  for (const sc of scenarios) {
    section(sc.name);
    console.log(`   路径：${sc.path}`);

    const ws = tempWorkspace();
    const trace = new CollectingTraceSink();
    try {
      const composed = compose({
        dbPath: ":memory:",
        workspaceRoot: ws.root,
        approvalDecider: sc.throwingApproval
          ? async () => {
              throw new Error("注入：ApprovalDecider 内部炸了");
            }
          : sc.approvals
            ? approveExcept(sc.approvals)
            : async () => ({ approved: true }),
        trace,
        modelPortOverride: sc.build(),
        portOverrides: sc.portOverrides,
      });

      const spec = composed.makeRunSpec("三件事");
      const gen = composed.runtime.start(spec);
      let runId = "";
      let r = await gen.next();
      /**
       * 定时 cancel。挂在这里而不是等某个事件，是因为要保证取消落在
       * **execute() 执行期间** —— 等事件的话最早只能等到 AttemptStarted，
       * 而那一刻 generator 是挂起的，取消会在工具开跑前就生效，
       * 又变成了「执行前取消」。
       */
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      if (sc.cancelAfterMs !== undefined) {
        cancelTimer = setTimeout(() => {
          if (runId) composed.runtime.cancel(runId as never, "注入：执行中取消");
        }, sc.cancelAfterMs);
      }
      while (!r.done) {
        if (!runId) runId = String(r.value.runId);
        r = await gen.next();
      }
      if (cancelTimer) clearTimeout(cancelTimer);

      const messages: ContextMessage[] = await composed.ports.transcript.rebuildMessages(
        runId as never,
      );
      const unpaired = findUnpairedToolUses(messages);
      const orphans = findOrphanResults(messages);

      const calls = countBlocks(messages, "tool_call");
      const results = countBlocks(messages, "tool_result");
      const settled = trace.byType("ActionBatchSettled")[0]?.payload;

      const outcomeKind = r.value.outcome?.kind ?? "未结算";
      fact("Terminal", r.value.terminal.reason);
      fact("Outcome", outcomeKind);
      for (const i of r.value.outcome?.incompleteItems ?? []) {
        console.log(`     · 未完成：${i.what} —— ${i.why.slice(0, 80)}`);
      }
      fact("transcript 中 tool_call 数", calls);
      fact("transcript 中 tool_result 数", results);
      fact("无 result 的 tool_use", unpaired.length === 0 ? "0（合规）" : unpaired.map((u) => u.toolCallId).join(", "));
      fact("无 call 的 tool_result", orphans.length === 0 ? "0（合规）" : orphans.join(", "));
      if (settled) fact("批结算", `${settled.resultCount}/${settled.callCount}`);

      const pairingOk = unpaired.length === 0 && orphans.length === 0 && calls === results;
      const settlementOk =
        r.value.terminal.reason === sc.expectTerminal && outcomeKind === sc.expectOutcome;
      const ok = pairingOk && settlementOk;

      verdict(
        ok,
        ok
          ? `${calls} 个 call、${results} 个 result 一一对应；结算为 ${outcomeKind}`
          : !pairingOk
            ? "配对被破坏"
            : `结算与预期不符（期望 ${sc.expectTerminal} / ${sc.expectOutcome}，` +
              `实际 ${r.value.terminal.reason} / ${outcomeKind}）`,
      );
    } catch (err) {
      verdict(false, `场景抛出异常：${(err as Error).message.slice(0, 160)}`);
    } finally {
      ws.cleanup();
    }
  }

  // ── 工具违约：ok:false 却不带 error（阶段 3.5 撞出来的）
  section("工具违约：ok:false 却没带 error，Harness 不得崩");
  console.log(
    "   `ToolExecutionOutcome.error` 在类型上是**可选**的，而结算处原本写的是\n" +
      "   `renderError(outcome.error!)` —— 一个非空断言掩着一个真洞：任何工具\n" +
      "   返回 ok:false 而忘了带 error，那一行就抛 TypeError，**整个 Run 当场崩掉**。\n\n" +
      "   为什么这条值得单列：`tools/` 这一层的全部意义就是让工具包能被独立地写、\n" +
      "   独立地接进来。一个第三方工具包的疏忽不该让 Harness 崩溃 ——\n" +
      "   它该拿到一条说得清楚的 tool_result，而这一批的配对也必须照样守住。\n\n" +
      "   2026-08-30 阶段 3.5 期间用故障注入撞出来的（改 ask_user 的 NO_ANSWER\n" +
      "   分支返回 ok:false 时，堆栈直接停在 settle-batch 那一行）。\n",
  );
  {
    const ws = tempWorkspace();
    try {
      const composed = compose({
        dbPath: ":memory:",
        workspaceRoot: ws.root,
        approvalDecider: async () => ({ approved: true }),
        trace: new CollectingTraceSink(),
        portOverrides: {
          // 【定】违约的是**工具**，所以旋钮拧在 ToolHandlerPort 上，
          // 不是在被测的结算逻辑里加分支。
          tools: {
            async execute() {
              return { ok: false, output: "", sideEffectState: "NO_EFFECT" as const };
            },
          },
        },
        modelPortOverride: new ScriptedModelPort([
          { toolCalls: [{ toolCallId: "bad1", name: "now", input: {} }] },
          { text: "收到错误，收尾。", toolCalls: [] },
        ]),
      });

      let crashed: string | undefined;
      let runId = "";
      try {
        const gen = composed.runtime.start(composed.makeRunSpec("工具违约"));
        let r = await gen.next();
        while (!r.done) {
          if (!runId) runId = String(r.value.runId);
          r = await gen.next();
        }
      } catch (err) {
        crashed = String((err as Error).message).slice(0, 120);
      }

      const messages = runId
        ? await composed.ports.transcript.rebuildMessages(runId as never)
        : [];
      const unpaired = findUnpairedToolUses(messages).length;
      const res = messages
        .flatMap((m) => m.content)
        .find((c) => c.type === "tool_result" && c.toolCallId === "bad1");
      const body =
        res?.type === "tool_result" ? (JSON.parse(res.content) as Record<string, unknown>) : {};
      composed.db.close();

      fact("Run 有没有崩", crashed ?? "没有");
      fact("bad1 有没有 result", res ? "有" : "无 ← 违反不变量 8");
      fact("合成的错误码", String(body["code"] ?? "（无）"));
      fact("未配对 tool_use", unpaired);

      const ok =
        crashed === undefined &&
        res !== undefined &&
        body["code"] === "TOOL_CONTRACT_NO_ERROR" &&
        unpaired === 0;
      verdict(
        ok,
        ok
          ? "工具违约被合成成一条**点名违约**的 tool_result（TOOL_CONTRACT_NO_ERROR），" +
            "Run 没崩、批内配对守住 —— 排查的人能一眼看出问题在工具的返回值上，" +
            "而不是在它做的那件事上"
          : `工具违约没有被正确兜住：崩=${crashed ?? "无"} result=${res ? "有" : "无"} ` +
            `code=${body["code"]} 未配对=${unpaired}`,
      );
    } finally {
      ws.cleanup();
    }
  }

  // ── orphan result 的反向注入（存量清单 §4 第 4 条）
  section("反向注入：让 findOrphanResults() 返回非空");
  console.log(
    "   前面所有场景都断言它 == 0。但一个**永远返回空数组**的检查器与\n" +
      "   一个正确的检查器，在这些断言下是分不出来的 —— 判别力必须单独验。\n",
  );
  {
    const ws = tempWorkspace();
    try {
      const composed = compose({
        dbPath: ":memory:",
        workspaceRoot: ws.root,
        approvalDecider: async () => ({ approved: true }),
        trace: new CollectingTraceSink(),
        modelPortOverride: new ScriptedModelPort([{ text: "什么都不做", toolCalls: [] }]),
      });
      const gen = composed.runtime.start(composed.makeRunSpec("空跑"));
      let runId = "";
      let r = await gen.next();
      while (!r.done) {
        if (!runId) runId = String(r.value.runId);
        r = await gen.next();
      }

      const before = findOrphanResults(await composed.ports.transcript.rebuildMessages(runId as never));

      // 直接往 transcript 注入一条「有 result 无 call」的消息 —— 锚点错配的形状。
      await composed.ports.transcript.append({
        runId: runId as never,
        kind: "MESSAGE",
        message: {
          role: "user",
          turn: 99,
          content: [{ type: "tool_result", toolCallId: "tc_does_not_exist", content: "{}", isError: false }],
        },
        createdAt: Date.now(),
      });

      const after = findOrphanResults(await composed.ports.transcript.rebuildMessages(runId as never));
      composed.db.close();

      fact("注入前 orphan", before.length);
      fact("注入后 orphan", `${after.length}（${after.join(",")}）`);
      const ok = before.length === 0 && after.length === 1 && after[0] === "tc_does_not_exist";
      verdict(
        ok,
        ok
          ? "注入一条锚点错配的 tool_result 后检查器立刻报出它 —— 前面那些「== 0」的断言因此是有判别力的"
          : "findOrphanResults 没有报出注入的 orphan，前面所有断言都失去意义",
      );
    } finally {
      ws.cleanup();
    }
  }
  console.log(
    "\n   R-4 那四条的判别力是验证过的：把 guard() 改成 rethrow，四条全部翻红，\n" +
      "   报错形态正是「场景抛出异常」—— 异常穿透 generator，runLoop 收不到 BatchOutcome。\n" +
      "   也就是说它们不是摆着好看的绿灯。",
  );

  console.log(
    "\n   这条验收项是删掉纯 Kernel 的直接代价（V05 §8.2 末尾）。\n" +
      "   纯函数形态下这条不变量可以穷举测试；while 循环形态下只能靠\n" +
      "   「所有出口都经过 finalize()」这条手写纪律 —— 所以它需要被反复审视。\n",
  );

  await sectionAttribution();
  await sectionCancelledCause();
}

function countBlocks(messages: ContextMessage[], type: "tool_call" | "tool_result"): number {
  let n = 0;
  for (const m of messages) for (const c of m.content) if (c.type === type) n += 1;
  return n;
}


/**
 * 归责必须来自事实：只有 `decidedBy === "HUMAN"` 的否决才算「用户拒绝」。
 *
 * ── 二次评审 P1-6，而它是一条**既有账**（HEAD 就是这样）─────────────────
 *
 * 此前**任何** `approved:false` 都写 `USER_REJECTED`：非交互环境无人应答、
 * 等待被 Ctrl+C 打断、审批超时，统统算成"用户拒绝"。而 `UnmetCause` 自己的
 * 【定】写着「必须来自事实（谁拒的），不得由结算逻辑推断」，
 * ADR-0001 更写着「判 USER_REJECTED 等于把责任栽给用户」。
 *
 * `decidedBy`（ADR-0012 加的）第一次提供了那个事实，这一段是它的判据。
 * **必须成对**：只验其中一侧的话，一个恒写某个成因的实现照样全绿。
 */
async function sectionAttribution(): Promise<void> {
  section("归责：只有人明确否决才算 USER_REJECTED");

  const run = async (decider: ApprovalDecider): Promise<{ kind?: string; causes: string[] }> => {
    const ws = tempWorkspace();
    try {
      const composed = compose({
        dbPath: ":memory:",
        workspaceRoot: ws.root,
        approvalDecider: decider,
        trace: new CollectingTraceSink(),
        modelPortOverride: new ScriptedModelPort([
          {
            /**
             * 【定】必须用一个 `requiredForSuccess: true` 的工具。
             *
             * 第一版用了 `append_log`（它声明的是 false）—— 拒绝它根本不产生
             * 未完成的必需项，于是**两侧都判 SUCCESS**，判据分不出任何东西。
             * 又一次「夹具让正确值与错误值恰好相等」，跑一次就看见了。
             */
            text: "写一个文件",
            toolCalls: [
              { toolCallId: "r1", name: "write_file", input: { path: "a.txt", content: "x" } },
            ],
          },
          { text: "好了。", toolCalls: [] },
        ]),
        tools: DEFAULT_TOOLS.filter((t: ToolSnapshot) => t.definition.name === "write_file"),
      });
      const gen = composed.runtime.start(composed.makeRunSpec("归责夹具"));
      let r = await gen.next();
      while (!r.done) r = await gen.next();
      composed.db.close();
      return {
        ...(r.value.outcome?.kind ? { kind: r.value.outcome.kind } : {}),
        causes: (r.value.outcome?.incompleteItems ?? []).map((it) => String(it.why)),
      };
    } finally {
      ws.cleanup();
    }
  };

  // ① 人明确按了「否」
  const byHuman = await run(async () => ({
    approved: false,
    reason: "我不想让它写",
    decidedBy: "HUMAN",
  }));
  fact("人明确否决 → outcome", byHuman.kind ?? "未结算");
  verdict(
    byHuman.kind === "USER_REJECTED",
    "人明确否决（decidedBy=HUMAN）→ 结算 USER_REJECTED —— 这是决 2 唯一想表达的那件事",
  );

  // ② 没有人应答（非交互降级 / 超时 / 等待被中断都走这一支）
  const noAnswer = await run(async () => ({
    approved: false,
    reason: "非交互环境下无人应答，按拒绝处置",
    decidedBy: "UNDECLARED",
  }));
  fact("无人应答 → outcome", noAnswer.kind ?? "未结算");
  fact("未完成项的理由", noAnswer.causes.join(" | ").slice(0, 120) || "（无）");
  verdict(
    noAnswer.kind === "COMPLETED_WITH_LIMITS" &&
      noAnswer.causes.some((w) => w.includes("没有拿到任何人的应答")),
    "没有人应答时**不**归责给用户：结算 COMPLETED_WITH_LIMITS，理由如实写「没有拿到任何人的应答」——" +
      "E-3 那句「结算 USER_REJECTED，而全程没有任何人拒绝过任何东西」说的就是这个形状",
  );
}

void runVerify(main);

/**
 * 「压根没启动」也必须有名字（2026-09-01 评审 C7）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * `UnmetCause` 的值域里一直有 `CANCELLED`，注释写着「被取消（用户 cancel
 * 或批内策略跳过）」—— 而它**零生产者**：`causeByCall` 只在 Policy 拒绝、
 * 审批否决、工具报错这三处被写，「批被中断、后面几个 call 根本没轮到」
 * 那条路径一个字都不记。
 *
 * 于是一次跑到一半被 Ctrl+C 的 Run，那些没做成的必需操作在
 * `unmetCauseCounts` 里全部落进 `UNSPECIFIED`（`tallyUnmetCauses` 的缺省）。
 * 「说不出为什么」与「因为被取消了」在归因报告里是两件事 ——
 * 而后者恰恰是最不需要排查的那一类。
 *
 * ── 【定】夹具的第二个 call 必须是 `requiredForSuccess: true` 的工具 ──────
 *
 * 这是隔壁 `sectionAttribution` 已经栽过一次的坑（它第一版用了 `append_log`，
 * 那个声明的是 false，于是拒不拒绝两侧都判 SUCCESS，判据分不出任何东西）。
 * 非必需的工具被跳过**根本不产生未完成项**，`recordUnmetRequired` 会直接
 * `continue`，这条判据就永远是绿的 —— 无论接没接线。
 *
 * 所以这里用 `write_file`（required: true），并且它必须**排在慢工具后面**：
 * 取消要落在「前一个还在跑、它还没轮到」的那一刻。
 * ══════════════════════════════════════════════════════════════════════
 */
async function sectionCancelledCause(): Promise<void> {
  section("归责：没轮到执行的必需操作要记 CANCELLED，不是 UNSPECIFIED");

  const ws = tempWorkspace();
  try {
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      // 【定】自动批准 —— 这一段要测的是「取消」，不是审批。
      // 留着审批会让 write_file 先被拒，成因变成 NO_APPROVAL，靶子就换了。
      approvalDecider: async () => ({ approved: true, decidedBy: "AUTO" }),
      trace: new CollectingTraceSink(),
      modelPortOverride: new ScriptedModelPort([
        {
          text: "先慢慢写一个，再写第二个",
          toolCalls: [
            // 可控慢：取消要落在它执行到一半的时候。
            { toolCallId: "cx_1", name: "slow_write", input: { path: "slow.txt", content: "S", delay_ms: 800 } },
            // 【定】required: true，且排在后面 —— 它才是这条判据的观察对象。
            { toolCallId: "cx_2", name: "write_file", input: { path: "never.txt", content: "N" } },
          ],
        },
        { text: "收尾", toolCalls: [] },
      ]),
      tools: DEFAULT_TOOLS.filter((t: ToolSnapshot) =>
        ["slow_write", "write_file"].includes(t.definition.name),
      ),
    });

    const gen = composed.runtime.start(composed.makeRunSpec("取消归责夹具"));
    let runId = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let r = await gen.next();
    while (!r.done) {
      if (!runId) {
        runId = String(r.value.runId);
        // 定时取消。250ms 落在 slow_write 的 800ms 中间，此时 cx_2 还没轮到。
        timer = setTimeout(() => composed.runtime.cancel(runId as never, "注入：执行中取消"), 250);
      }
      r = await gen.next();
    }
    if (timer) clearTimeout(timer);

    const snap = await composed.runtime.inspect(runId as never);
    const counts = snap?.unmetCauseCounts ?? {};
    composed.db.close();

    fact("Terminal", r.value.terminal.reason);
    fact("Outcome", r.value.outcome?.kind ?? "未结算");
    fact("unmetCauseCounts", JSON.stringify(counts));

    /**
     * ══════════════════════════════════════════════════════════════════════
     * 【定】**三条一起断言**，缺一条就有一种坏实现不可区分：
     *
     *   CANCELLED ≥ 1    cx_2 压根没轮到执行 —— 少了它，「没启动」会落 UNSPECIFIED
     *   TOOL_FAILED ≥ 1  cx_1 执行到一半被取消 —— 少了它，一个「成因全写
     *                    CANCELLED」的实现照样全绿
     *   UNSPECIFIED = 0  少了它，一个「记了成因但没接到事实表」的实现照样全绿
     *
     * ── 第二条是这条判据自己打出来的（值得记）──────────────────────────
     *
     * 第一版只断言前两句里的头一句，跑出来是 `{UNSPECIFIED:1, CANCELLED:1}`：
     * `CANCELLED` 接线是对的，而 cx_1 落进了 UNSPECIFIED。回源发现
     * `causeByCall.set(…, "TOOL_FAILED")` 在**正常路径上根本没有消费者** ——
     * 详见 `settle-batch.ts` 里 `recordedCause` 那段。
     *
     * 也就是说：写这条判据的收益不止「守住 CANCELLED」，
     * 它当场暴露了一条**存在了更久**的断线。
     * ══════════════════════════════════════════════════════════════════════
     */
    const hasCancelled = (counts["CANCELLED"] ?? 0) >= 1;
    const hasToolFailed = (counts["TOOL_FAILED"] ?? 0) >= 1;
    const noUnspecified = (counts["UNSPECIFIED"] ?? 0) === 0;
    const causeOk = hasCancelled && hasToolFailed && noUnspecified;
    verdict(
      causeOk,
      causeOk
        ? "两种未达成项各归各的成因：没轮到的记 CANCELLED、执行中被取消的记 TOOL_FAILED，" +
          "没有一条落进 UNSPECIFIED —— 「是谁没做成」这个聚合终于答得出来"
        : `期望 CANCELLED ≥ 1、TOOL_FAILED ≥ 1、UNSPECIFIED = 0，实际 ${JSON.stringify(counts)}` +
          (hasCancelled ? "" : "｜缺 CANCELLED：没启动的那条没记成因") +
          (hasToolFailed ? "" : "｜缺 TOOL_FAILED：成因记了但没接到验证事实上") +
          (noUnspecified ? "" : "｜有 UNSPECIFIED：某条未达成项说不出为什么"),
    );
  } finally {
    ws.cleanup();
  }
}
