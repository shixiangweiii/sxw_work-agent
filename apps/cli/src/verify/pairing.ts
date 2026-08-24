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
import { compose } from "../compose.js";
import { ScriptedModelPort, banner, fact, section, tempWorkspace, verdict } from "./harness.js";

interface Scenario {
  name: string;
  path: string;
  build(): ScriptedModelPort;
  approvals?: number[];
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
  { toolCallId: "tc_2", name: "write_note", input: { path: "a.txt", content: "A" } },
  { toolCallId: "tc_3", name: "list_dir", input: { path: "." } },
];

const scenarios: Scenario[] = [
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
    path: "第 2 个 call（requiredForSuccess 的 write_note）被用户拒绝，第 3 个仍需 result",
    build: () =>
      new ScriptedModelPort([
        { reasoning: "开始", toolCalls: CALLS_3 },
        { text: "有一个被拒了，我停下。", toolCalls: [] },
      ]),
    // 第 2 个（write_note，index 0 的审批调用）被拒绝
    approvals: [0],
    // 配对合规、循环正常终止，但必需操作确实没做成 —— 不能判 SUCCESS。
    expectTerminal: "COMPLETED_WITH_LIMITS",
    expectOutcome: "COMPLETED_WITH_LIMITS",
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
];

async function main(): Promise<void> {
  banner(
    "验收项 2：批内配对不变量 ＋ 结算真实性",
    "异常路径注入后，配对是否仍然一一对应，且 outcome 与实际执行事实一致？",
  );
  console.log(
    "\n   覆盖说明（不夸大）：本脚本注入的是**流式中断、审批拒绝、模型错误**三条。\n" +
      "   「工具正在执行时被 cancel」这一条由 verify:resume 的 B 段顺带覆盖，\n" +
      "   本脚本没有注入它 —— 不要把这里的四个场景读成 §9.2 的三条中断路径全覆盖。",
  );

  section("选定端点对配对的兜底强度（实测）");
  fact("validatesToolResultPairing", "false —— 缺 result 一律 200 放行");
  fact("validatesToolCallId", "false —— 篡改 id 一律 200 放行");
  console.log(
    "\n   也就是说：违反了不会报错，只会让模型看到一个失真的世界。\n" +
      "   下面这个扫描是唯一会发现违反的东西。",
  );

  let allOk = true;

  for (const sc of scenarios) {
    section(sc.name);
    console.log(`   路径：${sc.path}`);

    const ws = tempWorkspace();
    const trace = new CollectingTraceSink();
    try {
      const composed = compose({
        workspaceRoot: ws.root,
        approvalDecider: sc.approvals ? approveExcept(sc.approvals) : async () => ({ approved: true }),
        trace,
        modelPortOverride: sc.build(),
      });

      const spec = composed.makeRunSpec("三件事");
      const gen = composed.runtime.start(spec);
      let runId = "";
      let r = await gen.next();
      while (!r.done) {
        if (!runId) runId = String(r.value.runId);
        r = await gen.next();
      }

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

      if (!ok) allOk = false;
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
      allOk = false;
      verdict(false, `场景抛出异常：${(err as Error).message.slice(0, 160)}`);
    } finally {
      ws.cleanup();
    }
  }

  section("总判定");
  verdict(
    allOk,
    allOk
      ? "四个场景的合成 result 都收敛到了 settle-batch.ts 的 finalize()，" +
        "且 outcome 与实际执行事实一致（必需操作没做成就不判 SUCCESS）"
      : "存在违反：配对有缺口，或 outcome 与实际执行事实不一致",
  );

  console.log(
    "\n   这条验收项是删掉纯 Kernel 的直接代价（V05 §8.2 末尾）。\n" +
      "   纯函数形态下这条不变量可以穷举测试；while 循环形态下只能靠\n" +
      "   「所有出口都经过 finalize()」这条手写纪律 —— 所以它需要被反复审视。\n",
  );

  process.exit(allOk ? 0 : 1);
}

function countBlocks(messages: ContextMessage[], type: "tool_call" | "tool_result"): number {
  let n = 0;
  for (const m of messages) for (const c of m.content) if (c.type === type) n += 1;
  return n;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
