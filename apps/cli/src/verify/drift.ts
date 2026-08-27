/**
 * verify:drift —— 阶段 2 批 4 的验收。
 *
 * 验证：**声明与实际不符时，Runtime 会不会静默继续？**（§8.6 不变量 4）
 *
 * 挂了意味着：§24.6 的「端点能力回归 ＋ DeepSeek 对照」失去意义 ——
 * 对照测试的全部价值建立在**能观测到漂移**上，检测不接线的话，
 * 对照跑了也读不出东西。
 *
 * ── 本脚本默认不发真实请求 ─────────────────────────────────────────────
 *
 * A–C 段是离线的：用 fake profile 造「声明与行为不符」的组合，
 * 断言事件真的发出、FAIL_FAST 真的终止。
 *
 * D 段（DeepSeek 对照实跑）要花钱，默认只做**装配检查**：
 * 声明能不能加载、U-6 的 baseUrl 断言灵不灵。真跑要显式加 `--live`。
 */

import { join, resolve } from "node:path";
import type { RunEvent } from "@workagent/harness-runtime";
import {
  CollectingTraceSink,
  DriftDetector,
  assertProfileMatchesEndpoint,
  loadProfileFromFile,
} from "@workagent/harness-runtime";
import { fakeProfile, strictFakeProfile } from "@workagent/testkit";
import { compose, REPO_ROOT, readEndpointConfig, loadEnv } from "../compose.js";
import { ScriptedModelPort, banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

async function main(): Promise<void> {
  banner(
    "verify:drift —— 端点漂移检测与对照端点装配（阶段 2 批 4）",
    "声明与实际行为不符时，Runtime 会不会静默继续？",
  );

  const live = process.argv.includes("--live");
  const results: Array<{ name: string; ok: boolean }> = [];

  // ────────────────────────────────────────────────────────── A
  section("A. 三条规则各自的判别力（纯函数层）");
  console.log(
    "   `DriftDetector` 在阶段 1 只被 export、**从未实例化** ——\n" +
      "   §8.6 不变量 4「不得静默继续」当时在运行时没有任何载体。\n",
  );

  const strict = strictFakeProfile();
  const d1 = new DriftDetector(strict);
  // 规则 2：声明「会校验配对」时不该报；换成不校验的声明才该报。
  const lenient = fakeProfile();
  const d2 = new DriftDetector(lenient);

  const r2 = d2.observePairingError(400, "messages.1: unexpected tool_result block");
  const r2none = d1.observePairingError(400, "messages.1: unexpected tool_result block");
  fact("声明不校验 ＋ 收到配对 400", r2 ? `报漂移（${r2.disposition}）` : "未报");
  fact("声明会校验 ＋ 收到配对 400", r2none ? "报漂移" : "未报（正确：声明与实际一致）");

  // 显式声明 EXACT —— fakeProfile 的默认值是 APPROXIMATE（一个虚拟端点
  // 没被测量过，不该声称精确，见 fake-endpoint-profile 的注释）。
  const exactClaim = {
    ...lenient,
    tokens: { ...lenient.tokens, countTokensAccuracy: "EXACT" as const },
  };
  const d3 = new DriftDetector(exactClaim);
  const r3 = d3.observeTokenAccuracy(1000, 1500);
  fact("声明 token 精确 ＋ 偏差 33%", r3 ? `报漂移（${r3.disposition}）` : "未报");

  const aOk =
    r2 !== null && r2.disposition === "FAIL_FAST" && r2none === null && r3 !== null;
  verdict(
    aOk,
    aOk
      ? "三条规则在「声明与实际不符」时报、在「一致」时不报 —— 有判别力，不是只会亮绿灯"
      : "规则的判别力不成立",
  );
  results.push({ name: "A", ok: aOk });

  // ────────────────────────────────────────────────────────── B
  section("B. 本地推理块补估不该被当成端点漂移");
  console.log(
    "   这条是 U-1 接线**当场**暴露的矛盾，值得单独验：\n" +
      "     · profile 声明 countTokensAccuracy = EXACT；\n" +
      "     · 而 D-3 证实端点对推理块一个 token 都不算，于是 countTokens()\n" +
      "       会本地补一个估算顶上去（D-4 的系数 1.9）。\n" +
      "   两条都对，但合起来意味着复合结果**故意不精确** —— 拿它去判\n" +
      "   「端点漂移了」是错的靶子：偏差来自我们自己的补估。\n",
  );
  const withComp = new DriftDetector({
    ...lenient,
    tokens: { ...lenient.tokens, countTokensAccuracy: "EXACT", countTokensExcludesReasoning: true },
  });
  const small = withComp.observeTokenAccuracy(1100, 1000); // 10%，补估的预期量级内
  const big = withComp.observeTokenAccuracy(2000, 1000); // 100%，超出预期
  fact("补估在预期量级内（10%）", small ? `报了（${small.disposition}）` : "未报");
  fact("远超补估量级（100%）", big ? `报了（${big.disposition}）` : "未报");
  const bOk = small === null && big !== null && big.disposition === "RECORD";
  verdict(
    bOk,
    bOk
      ? "有本地补估时只 RECORD 不 FAIL_FAST —— 不会因为我们自己的保守估算把 Run 打死"
      : "补估与端点漂移没有被区分开",
  );
  results.push({ name: "B", ok: bOk });

  // ────────────────────────────────────────────────────────── C
  section("C. 端到端：FAIL_FAST 真的终止，且事件真的发出");
  const ws = tempWorkspace();
  let cOk = false;
  try {
    const trace = new CollectingTraceSink();
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      // 声明「token 精确」但没有本地补估，而脚本化模型的两个常量对不上 ——
      // 这正是「声明与实际不符」的形状。
      profileOverride: {
        ...lenient,
        tokens: { ...lenient.tokens, countTokensAccuracy: "EXACT" },
      },
      modelPortOverride: new ScriptedModelPort([
        { text: "先看看", toolCalls: [{ toolCallId: "t1", name: "list_dir", input: { path: "." } }] },
        { text: "好了", toolCalls: [] },
      ]),
    });

    const gen = composed.runtime.start(composed.makeRunSpec("触发漂移"));
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    composed.db.close();

    const driftEvents = trace.events.filter((e: RunEvent) => e.type === "EndpointBehaviorDrift");
    fact("EndpointBehaviorDrift 事件数", driftEvents.length);
    fact("Terminal", r.value.terminal.reason);
    fact("Outcome", r.value.outcome?.kind ?? "未结算");
    cOk = driftEvents.length > 0 && r.value.terminal.reason === "MODEL_ERROR";
    verdict(
      cOk,
      cOk
        ? "漂移事件发出且 Run 以 MODEL_ERROR 终止 —— 不得静默继续这条不变量有了运行时载体"
        : "漂移发生了但 Run 照常跑完 —— 那正是不变量 4 要防的",
    );
  } finally {
    ws.cleanup();
  }
  results.push({ name: "C", ok: cOk });

  // ────────────────────────────────────────────────────────── D
  section("D. U-6：对照端点的装配检查");
  loadEnv();
  const dsProfile = loadProfileFromFile(
    resolve(REPO_ROOT, "adapters/endpoint-profiles/deepseek-anthropic.json"),
  );
  const blProfile = loadProfileFromFile(
    resolve(REPO_ROOT, "adapters/endpoint-profiles/bailian-anthropic.json"),
  );
  fact("DeepSeek 声明加载", `${dsProfile.id}（confidence=${dsProfile.confidence}）`);
  fact("  validatesToolResultPairing", String(dsProfile.protocol.validatesToolResultPairing));
  fact("  reasoningBlockRule", dsProfile.context.reasoningBlockRule);
  fact("  perRequestBaseTokens", String(dsProfile.tokens.perRequestBaseTokens));
  console.log(
    "   ↑ 三组判定与主力端点**处处相反**。这正是它作为对照端点的价值：\n" +
      "     百炼零兜底（缺 result 一律 200 放行），DeepSeek 会真的 400 ——\n" +
      "     把 Runtime 产出的请求打过去，是一次免费的正确性检查。\n",
  );

  // U-6 的判别力：拿百炼的声明配 DeepSeek 的 baseUrl，必须被挡下。
  let crossRejected = false;
  try {
    assertProfileMatchesEndpoint(blProfile, "https://api.deepseek.com/anthropic");
  } catch {
    crossRejected = true;
  }
  let selfAccepted = true;
  try {
    const cfg = readEndpointConfig(false, "deepseek");
    if (cfg.baseUrl) assertProfileMatchesEndpoint(dsProfile, cfg.baseUrl);
  } catch {
    selfAccepted = false;
  }
  fact("百炼声明 ＋ DeepSeek baseUrl", crossRejected ? "被拒绝（正确）" : "放行了（错误）");
  fact("DeepSeek 声明 ＋ 自己的 baseUrl", selfAccepted ? "放行（正确）" : "被拒（错误）");
  const dOk = crossRejected && selfAccepted;
  verdict(
    dOk,
    dOk
      ? "端点声明与 baseUrl 的对应关系在启动前被断言 —— 换 baseUrl 却忘了换声明会当场被挡下，而不是悄悄跑错"
      : "U-6 的断言没有判别力",
  );
  results.push({ name: "D", ok: dOk });

  // ────────────────────────────────────────────────────────── E
  /**
   * P1-1：§18.3【定】resume 前必须校验端点仍与 RunSpec 冻结的一致。
   *
   * 这条在阶段 1、阶段 2 一直是欠账：`profileMatches` 写好了、零调用点，
   * `profile-loader.ts` 自己的注释还写着「§18.3【定】要求 resume 时校验」。
   *
   * D 段那两条断言拦不住它 —— 它们只校验**新环境自身**的声明与 baseUrl / 模型名
   * 配套，压根不知道那个 Run 昨天是用什么跑的。于是「改 .env 换个模型，
   * 再 --resume 一个昨天的 Run」在阶段 2 是完全静默的。
   *
   * 这一段的判别力在于：**同一条 transcript，只换 compose 时的端点声明**，
   * 前者必须放行、后者必须被拒。只测「被拒」不够 —— 一个永远拒绝的闸门
   * 同样能让这条判据变绿。
   */
  section("E. P1-1：resume 的端点一致性闸门");
  const wsE = tempWorkspace();
  let eOk = false;
  try {
    const dbPath = join(wsE.root, "runs.db");
    const startedWith = compose({
      dbPath,
      workspaceRoot: wsE.root,
      approvalDecider: async () => ({ approved: true }),
      trace: new CollectingTraceSink(),
      profileOverride: lenient,
      modelPortOverride: new ScriptedModelPort([
        { text: "看一眼", toolCalls: [{ toolCallId: "e1", name: "list_dir", input: { path: "." } }] },
        { text: "好了", toolCalls: [] },
      ]),
    });
    /**
     * 【定】这个对照 Run 必须停在**可恢复**的状态。
     *
     * 跑到 COMPLETED 的话，「同一份声明也能 resume」这条对照会被生命周期闸门
     * 挡掉（终态拒绝 resume），于是三条结果全是「拒绝」—— 一个永远拒绝的闸门
     * 看起来和一个有判别力的闸门一模一样。所以这里当场 cancel，收在 CANCELLED。
     */
    const gen = startedWith.runtime.start(startedWith.makeRunSpec("起一个 Run"));
    let runId = "";
    let r = await gen.next();
    while (!r.done) {
      if (!runId) {
        runId = String(r.value.runId);
        startedWith.runtime.cancel(runId as never, "verify:drift E 段：留一个可恢复的 Run");
      }
      r = await gen.next();
    }
    fact("对照 Run 的终态", `${r.value.terminal.reason}（可恢复）`);
    startedWith.db.close();

    // 同一个库、同一条 transcript，两次 resume 只差 compose 时的那份声明。
    const tryResume = async (profile: typeof lenient, label: string): Promise<string> => {
      const c = compose({
        dbPath,
        workspaceRoot: wsE.root,
        approvalDecider: async () => ({ approved: true }),
        trace: new CollectingTraceSink(),
        profileOverride: profile,
        modelPortOverride: new ScriptedModelPort([{ text: "收尾", toolCalls: [] }]),
      });
      try {
        const g = c.runtime.resume(runId as never);
        let x = await g.next();
        while (!x.done) x = await g.next();
        return "放行";
      } catch (err) {
        return `拒绝：${(err as Error).message.split("\n")[0]}`;
      } finally {
        c.db.close();
      }
    };

    // 换了 modelId 的另一份声明 —— 其余字段一模一样。
    const otherModel = { ...lenient, modelId: `${lenient.modelId}-v2` };
    // 同一个 modelId，但把行为字段改了（相当于有人改了那份 JSON）。
    const editedBehavior = {
      ...lenient,
      protocol: { ...lenient.protocol, validatesToolResultPairing: !lenient.protocol.validatesToolResultPairing },
    };

    const same = await tryResume(lenient, "同一份声明");
    const changedModel = await tryResume(otherModel, "换了模型");
    const changedBehavior = await tryResume(editedBehavior, "声明被改过");

    fact("同一份声明 resume", same);
    fact("换了 modelId 再 resume", changedModel);
    fact("声明内容被改过再 resume", changedBehavior);

    eOk =
      same === "放行" && changedModel.startsWith("拒绝") && changedBehavior.startsWith("拒绝");
    verdict(
      eOk,
      eOk
        ? "同一条 transcript：端点未变时放行，换模型或改过声明内容时当场拒绝 —— §18.3 第一次有了运行时载体"
        : `闸门无判别力（同=${same} 换模型=${changedModel} 改声明=${changedBehavior}）`,
    );
  } finally {
    wsE.cleanup();
  }
  results.push({ name: "E", ok: eOk });

  if (!live) {
    console.log(
      "\n   \x1b[33mD 段的真实对照实跑未执行\x1b[0m（要花钱）。装配已就绪，跑它：\n" +
        "     npm run verify:drift -- --live\n" +
        "   §24.6 的判据是「对照端点未发现自持逻辑的系统性缺陷」——\n" +
        "   发现了就是阶段 1「配对不变量 100% 由 Runtime 自持」这个结论的反例。",
    );
  } else {
    section("D-live. DeepSeek 对照实跑（真实请求）");
    const ws2 = tempWorkspace();
    try {
      const trace = new CollectingTraceSink();
      const composed = compose({
        dbPath: ":memory:",
        workspaceRoot: ws2.root,
        approvalDecider: async () => ({ approved: true }),
        trace,
        endpoint: "deepseek",
        timezone: "Asia/Shanghai",
      });
      const gen = composed.runtime.start(
        composed.makeRunSpec("看看 workspace 根目录里有什么，然后写一份 summary.txt 说明你看到了什么。"),
      );
      let r = await gen.next();
      while (!r.done) r = await gen.next();
      composed.db.close();

      const drifts = trace.events.filter((e: RunEvent) => e.type === "EndpointBehaviorDrift");
      const errors = trace.events.filter((e: RunEvent) => e.type === "RuntimeErrorOccurred");
      fact("Terminal", r.value.terminal.reason);
      fact("Outcome", r.value.outcome?.kind ?? "未结算");
      fact("漂移事件", drifts.length);
      fact("运行时错误", errors.length);
      for (const e of errors) {
        console.log(`     · ${JSON.stringify((e.payload as { error: { safeMessage: string } }).error.safeMessage).slice(0, 160)}`);
      }
      const liveOk = r.value.terminal.reason === "COMPLETED" && errors.length === 0;
      verdict(
        liveOk,
        liveOk
          ? "在一个**会真的校验协议**的端点上跑通，未出现配对相关的 400 —— " +
              "阶段 1「批内配对不变量 100% 由 Runtime 自持」这个结论在对照端点上成立"
          : "对照端点上出现了错误，需要逐条看是不是自持逻辑的系统性缺陷（那是有价值的发现）",
      );
      results.push({ name: "D-live", ok: liveOk });
    } finally {
      ws2.cleanup();
    }
  }

  // ────────────────────────────────────────────────────────── 总判定
  section("总判定");
  const ok = results.every((r) => r.ok);
  verdict(
    ok,
    ok
      ? "漂移检测有运行时载体且有判别力；本地补估不被误判为端点漂移；对照端点声明就位、U-6 断言生效"
      : `失败段：${results.filter((r) => !r.ok).map((r) => r.name).join(" ")}`,
  );
  console.log(
    "\n   为什么 U-1 必须先于接 DeepSeek：§24.6 对照测试的意义**建立在能观测到漂移上**。\n" +
      "   `profileMatches` 与 `DriftDetector` 双双零调用点的状态下，\n" +
      "   把 baseUrl 换成 DeepSeek 而保留百炼声明，compose 会一声不吭。",
  );
}

void runVerify(main);
