/**
 * verify:progress —— 批 3 验收（阶段 3）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：**长任务不被误杀、原地打转会被叫停、人机通道真的通。**
 *
 *   A 段  `ToolProgress` 真的发出并进 Trace；长任务不被步骤级超时误杀
 *   B 段  无进展：同工具同输入同 digest 连续 N 次 → 具名终止
 *   C 段  真实慢工具执行中 cancel：transcript 里不存在无 result 的 tool_use
 *   D 段  `request_handoff` → `WAITING_FOR_INTERACTION` 可达；
 *         完成信号**不被当成任务成功**
 *   E 段  **接管中崩溃后 resume**：真 kill → 新进程识别出等待交互状态
 *         并重新发起接管，**不直接进主循环调模型**
 *   F 段  接管等待**不计入 active** 墙钟
 *   G 段  运行期 interject 进入下一轮 ContextFrame；三种 stdin 语义互不串台
 *
 * ── A 段与 B 段问的是两个不同的问题 ────────────────────────────────────
 *
 *   A：**进展回报得出来吗** —— 工具自己回报的进展有没有真的发出并进 Trace，
 *      以及一个「久」的工具会不会被步骤级超时误杀。
 *   B：**在原地打转吗** —— 判据是批指纹连续重复。
 *
 * 【定】§16.2 还有第三个问题「**还活着吗**」（久没动静就该杀），
 * 本阶段**不做**，A 段也不再声称在测它（阶段 3 收口批改）。
 * 原因是 `ToolProgress` 在工具执行完之后才被排空，事件时间戳是批结算时刻 ——
 * 拿它判存活会得到自信的错误答案。Guard 那一侧只写不读的 `lastProgressAt`
 * 已经删掉；要真做得先把工具执行改成 generator 形态。
 *
 * 把「还活着」和「在原地打转」混成一个的后果仍然成立、也仍然要防：
 * 一个老老实实回报进展的工具，会掩盖住「模型第三次发起同一个调用」这件事。
 * 所以就算将来接上存活判定，它也不得重置无进展计数。
 * ══════════════════════════════════════════════════════════════════════
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  CollectingTraceSink,
  NO_PROGRESS_THRESHOLD,
  findOrphanResults,
  findUnpairedToolUses,
  makeError,
  type ContextMessage,
  type RunId,
  type RunStatus,
} from "@workagent/harness-runtime";
import { SqliteRunStore, openDb } from "@workagent/store-sqlite";
import { SystemClock, runSegment } from "@workagent/testkit";
import type { HandoffChannel, QuestionChannel } from "@workagent/tools-common";
import { compose } from "../compose.js";
import { StdinChannel } from "../stdin-channel.js";
import { ScriptedModelPort, banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

const WORKER = resolve(fileURLToPath(new URL(".", import.meta.url)), "workers/run-segment.ts");

interface ToolCall {
  toolCallId: string;
  name: string;
  input: unknown;
}

async function main(): Promise<void> {
  banner(
    "批 3 验收：长任务与人机通道（verify:progress）",
    "长任务会被误杀吗？原地打转叫得停吗？请人接手这条路真的通吗？",
  );

  await sectionProgress();
  await sectionNoProgress();
  await sectionCancelSlowTool();
  await sectionHandoff();
  await sectionHandoffCrash();
  await sectionWaitNotCounted();
  await sectionInterject();
  await sectionStdinArbitration();
  await sectionAskUser();
  await sectionDefeatedFallbacks();
}

/** A 段：进展真的发出并落进 Trace；长任务不被步骤级超时误杀。 */
async function sectionProgress(): Promise<void> {
  section("A. ToolProgress 真的发出并进 Trace；长任务不被步骤级超时误杀");
  console.log(
    "   U-3 修之前：`ToolProgress` 事件类型有定义、**零发出点** —— `ctx.onProgress`\n" +
      "   只是把字符串塞进一个没有任何消费者的数组。\n" +
      "   这是「未接线比不写更糟」的又一例：读代码的人会以为进展是被监控的。\n\n" +
      "   ── 段标题在阶段 3 收口批改过 ────────────────────────────────────\n" +
      "   它此前写的是「Guard 真的消费」，而 Guard 那一侧只有 `noteProgress()`\n" +
      "   往一个**全仓没有读者**的字段里写时间戳，没有任何基于它的判定。\n" +
      "   那半边已经删掉（进展事件是批结算时才排空的，时间戳不是进展发生的\n" +
      "   时刻，拿它判存活会得到自信的错误答案 —— 见 progress-guard.ts 文件头）。\n" +
      "   这里验的是：进展**真的发出并落进 Trace**（事后可读的工作量证据），\n" +
      "   以及一个 600ms 的慢工具不会被 60s 的步骤级超时误杀。\n",
  );

  const ws = tempWorkspace();
  try {
    const trace = new CollectingTraceSink();
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      modelPortOverride: new ScriptedModelPort([
        {
          text: "慢慢写",
          // slow_write 每 200ms 回报一次进展 —— 600ms 应当至少报 3 次。
          toolCalls: [
            { toolCallId: "p1", name: "slow_write", input: { path: "a.txt", content: "A", delay_ms: 600 } },
          ],
        },
        { text: "做完了。", toolCalls: [] },
      ]),
    });

    const started = Date.now();
    const gen = composed.runtime.start(composed.makeRunSpec("跑一个慢工具"));
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const elapsed = Date.now() - started;
    composed.db.close();

    const progressEvents = trace.byType("ToolProgress");
    for (const p of progressEvents.slice(0, 3)) console.log(`     · ${p.payload.note}`);

    fact("ToolProgress 事件数", progressEvents.length);
    fact("工具耗时", `${elapsed}ms（工具内部延迟 600ms）`);
    fact("Terminal / Outcome", `${r.value.terminal.reason} / ${r.value.outcome?.kind ?? "未结算"}`);

    const ok =
      progressEvents.length >= 3 &&
      r.value.terminal.reason === "COMPLETED" &&
      r.value.outcome?.kind === "SUCCESS";
    verdict(
      ok,
      ok
        ? `慢工具执行期间回报了 ${progressEvents.length} 次进展，事件真的发了出来并落进 Trace；` +
          `而这个「久」没有让它被步骤级超时打断 —— 长任务不被误杀`
        : progressEvents.length < 3
          ? `只收到 ${progressEvents.length} 条 ToolProgress —— 事件仍然没有生产点`
          : `长任务被误杀了：${r.value.terminal.reason}`,
    );
  } finally {
    ws.cleanup();
  }
}

/** B 段：无进展被叫停，且是**具名**终止。 */
async function sectionNoProgress(): Promise<void> {
  section(`B. 无进展：同工具同输入同 digest 连续 ${NO_PROGRESS_THRESHOLD} 次 → 具名终止`);
  console.log(
    "   §16.2 的第二种形态（「多个不同调用但外部状态无变化」）**本批明确不做**：\n" +
      "   判定「外部状态无变化」需要状态观察基础设施，现在没有 ——\n" +
      "   硬做会造出一个没有判别力的检查，那比不做更糟。\n",
  );

  const ws = tempWorkspace();
  try {
    const trace = new CollectingTraceSink();
    // 模型反复发起**完全相同**的调用：这正是「没读工具返回的诊断」的形状。
    const sameCall: ToolCall = { toolCallId: "n", name: "list_dir", input: { path: "." } };
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      modelPortOverride: new ScriptedModelPort(
        Array.from({ length: 8 }, (_, i) => ({
          text: `第 ${i + 1} 次`,
          toolCalls: [{ ...sameCall, toolCallId: `n${i}` }],
        })),
      ),
    });

    const gen = composed.runtime.start(composed.makeRunSpec("原地打转"));
    let r = await gen.next();
    while (!r.done) r = await gen.next();

    composed.db.close();

    const ev = trace.byType("NoProgressDetected")[0]?.payload;
    const turns = trace.byType("TurnStarted").length;
    fact("NoProgressDetected", ev ? `${ev.toolName} × ${ev.repeats}` : "（没有触发）");
    fact("总轮数", `${turns}（脚本准备了 8 轮）`);
    fact("Terminal", r.value.terminal.reason);
    fact("Outcome", r.value.outcome?.kind ?? "未结算");

    const ok =
      ev !== undefined &&
      ev.repeats === NO_PROGRESS_THRESHOLD &&
      r.value.terminal.reason === "NO_PROGRESS" &&
      turns === NO_PROGRESS_THRESHOLD;
    verdict(
      ok,
      ok
        ? `第 ${NO_PROGRESS_THRESHOLD} 次相同调用时 Guard 触发，Run 停在具名 Terminal ` +
          `NO_PROGRESS（不是 MAX_TURNS，也不是静默跑完 8 轮）`
        : `期望第 ${NO_PROGRESS_THRESHOLD} 轮触发 NO_PROGRESS，实际跑了 ${turns} 轮、` +
          `停在 ${r.value.terminal.reason}`,
    );

    // 判别力：**不同**的调用不该被判成无进展。
    const ws2 = tempWorkspace();
    try {
      const trace2 = new CollectingTraceSink();
      const c2 = compose({
        dbPath: ":memory:",
        workspaceRoot: ws2.root,
        approvalDecider: async () => ({ approved: true }),
        trace: trace2,
        modelPortOverride: new ScriptedModelPort([
          ...Array.from({ length: 5 }, (_, i) => ({
            text: `看第 ${i} 个`,
            // 每轮换一个路径 —— inputDigest 不同，不该触发。
            toolCalls: [{ toolCallId: `d${i}`, name: "stat", input: { path: `f${i}.txt` } }],
          })),
          { text: "做完了。", toolCalls: [] },
        ]),
      });
      const g2 = c2.runtime.start(c2.makeRunSpec("每次都不一样"));
      let r2 = await g2.next();
      while (!r2.done) r2 = await g2.next();
      c2.db.close();

      const falsePositive = trace2.byType("NoProgressDetected").length > 0;
      fact("反向：5 次不同调用是否被误判", falsePositive ? "被误判（错）" : "没有（对）");
      verdict(
        !falsePositive && r2.value.terminal.reason === "COMPLETED",
        !falsePositive && r2.value.terminal.reason === "COMPLETED"
          ? "连续 5 次**不同**的调用没有被判成无进展 —— Guard 不是「超过 N 轮就停」"
          : "正常推进被误判成无进展，Guard 过严",
      );
    } finally {
      ws2.cleanup();
    }
  } finally {
    ws.cleanup();
  }
}

/** C 段：真实慢工具执行中被 cancel，配对不变量守住。 */
async function sectionCancelSlowTool(): Promise<void> {
  section("C. 真实慢工具执行中 cancel：配对不变量守住");
  console.log(
    "   `fetch_url` 是第一个**真的慢**的工具（此前只有 delay_ms 这个假的慢）。\n" +
      "   慢是由一个**不可路由的公网地址**（RFC 5737 TEST-NET-1）造出来的：\n" +
      "   TCP 连接一直挂着，而它不是私网，所以过得了 SSRF 护栏。\n" +
      "   步骤级 AbortSignal（U-2 已做）因此是在真实网络等待上验的，\n" +
      "   不是在一个 setTimeout 上。\n",
  );

  /**
   * ── 怎么造出一个「真的慢」又能过护栏的地址 ──────────────────────────────
   *
   * 本机起一个不回包的服务器是最直接的想法，但**行不通**：护栏拒绝
   * 127.0.0.1 与 localhost，于是测到的会是「被护栏挡住」而不是
   * 「执行中被取消」—— 两件完全不同的事。
   *
   * 【定】用 RFC 5737 的 TEST-NET-1（192.0.2.0/24）。它是标准保留的
   * **文档用地址**：全球不可路由，但**不是私网** —— 所以它过得了护栏，
   * 而 TCP 连接会一直挂到超时。这正是我们要的真实网络等待。
   *
   * 不引入任何依赖，也不给护栏开测试后门（那会在生产代码里留一个绕过口）。
   */
  const SLOW_URL = "http://192.0.2.1/slow";
  const ws = tempWorkspace();
  try {
    const trace = new CollectingTraceSink();
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      modelPortOverride: new ScriptedModelPort([
        {
          text: "取一个很慢的 URL，外加两件别的事",
          toolCalls: [
            { toolCallId: "s1", name: "stat", input: { path: "." } },
            { toolCallId: "s2", name: "fetch_url", input: { url: SLOW_URL } },
            { toolCallId: "s3", name: "stat", input: { path: "." } },
          ],
        },
        { text: "收尾", toolCalls: [] },
      ]),
    });

    const gen = composed.runtime.start(composed.makeRunSpec("慢请求中途取消"));
    let runId = "";
    let r = await gen.next();
    // 取消必须落在 fetch 真的在等的时候。
    const timer = setTimeout(() => {
      if (runId) composed.runtime.cancel(runId as RunId, "注入：慢请求执行中取消");
    }, 700);
    while (!r.done) {
      if (!runId) runId = String(r.value.runId);
      r = await gen.next();
    }
    clearTimeout(timer);

    const messages = await composed.ports.transcript.rebuildMessages(runId as RunId);
    const unpaired = findUnpairedToolUses(messages);
    const orphans = findOrphanResults(messages);
    const calls = countBlocks(messages, "tool_call");
    const results = countBlocks(messages, "tool_result");
    composed.db.close();

    fact("Terminal / Outcome", `${r.value.terminal.reason} / ${r.value.outcome?.kind ?? "未结算"}`);
    fact("tool_call / tool_result", `${calls} / ${results}`);
    fact("无 result 的 tool_use", unpaired.length === 0 ? "0（合规）" : unpaired.map((u) => u.toolCallId).join(", "));
    fact("无 call 的 tool_result", orphans.length === 0 ? "0（合规）" : orphans.join(", "));

    const ok = unpaired.length === 0 && orphans.length === 0 && calls === results && calls === 3;
    verdict(
      ok,
      ok
        ? `真实网络等待中被取消，3 个 call 仍然 3 个 result 一一对应 —— ` +
          `步骤级 AbortSignal 在真的慢的工具上生效，且不变量 8 没有被中断破坏`
        : "配对被破坏：真实慢工具的取消路径上有缺口",
    );
  } finally {
    ws.cleanup();
  }
}

/** D 段：接管可达，且完成信号不被当成任务成功。 */
async function sectionHandoff(): Promise<void> {
  section("D. request_handoff → WAITING_FOR_INTERACTION 可达；完成信号 ≠ 任务成功");
  console.log(
    "   §20.3【定】完成信号不等于任务成功，必须重新 Observation ——\n" +
      "   这是接管与「盲目继续」的唯一区别。\n" +
      "   Runtime 无法自己观察一句自由文本的 expectedCompletion，所以它做的是：\n" +
      "   把结果如实标成**用户的声明**，并要求下一步先去核实。\n" +
      "   这一段验的是那个形状真的成立，不是「模型一定会照做」。\n\n" +
      "   ── 判据在阶段 3 收口批被收紧过 ────────────────────────────────\n" +
      "   原版的 ok 六项**全部来自 h1 那一次 request_handoff 的返回值** ——\n" +
      "   把脚本第二轮那次核实（h2 的 stat）整轮删掉，这一段照样全绿。\n" +
      "   而 §20.3【定】要的正是「断言观察**真的发生了**，不只是状态流转」。\n" +
      "   所以现在还要钉：h2 的 tool_result 在 transcript 上、且它真的读到了\n" +
      "   expectedCompletion 点名的那个文件，Run 也真的跑到了终态。\n",
  );

  const ws = tempWorkspace();
  try {
    const trace = new CollectingTraceSink();
    /** 记录接管发生时 Run 的状态 —— 它是 WAITING_FOR_INTERACTION 可达的唯一证据。 */
    let statusDuringWait: RunStatus | undefined;
    let runIdRef = "";

    const handoff: HandoffChannel = {
      async await() {
        // 等待期间去库里读一次状态：这时循环正阻塞在 await 上。
        if (runIdRef) statusDuringWait = await composed.ports.runs.getStatus(runIdRef as RunId);
        /**
         * 【定】这个假的「人」要**真的去外部世界做那件事**。
         *
         * 不写这个文件的话，后面那次核实观察到的是「没做成」——
         * 那测的是另一件事。这一段要验的是「重新观察这一步真的发生了
         * 并且真的读到了外部世界」，所以外部世界得先有东西可读。
         */
        writeFileSync(join(ws.root, "confirmed.txt"), "已在外部系统确认\n", "utf8");
        return { note: "我去系统里点过确认了" };
      },
    };

    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      handoff,
      modelPortOverride: new ScriptedModelPort([
        {
          text: "这一步得请人来",
          toolCalls: [
            {
              toolCallId: "h1",
              name: "request_handoff",
              input: {
                instructions: "去内部系统里把这张单据标成已确认",
                expected_completion: "workspace 里出现 confirmed.txt",
              },
            },
          ],
        },
        // 接管之后先去**核实**，这正是 §20.3 要的形状。
        { text: "核实一下", toolCalls: [{ toolCallId: "h2", name: "stat", input: { path: "confirmed.txt" } }] },
        { text: "确认过了。", toolCalls: [] },
      ]),
    });

    const gen = composed.runtime.start(composed.makeRunSpec("需要人接手"));
    let r = await gen.next();
    while (!r.done) {
      if (!runIdRef) runIdRef = String(r.value.runId);
      r = await gen.next();
    }

    const messages = await composed.ports.transcript.rebuildMessages(runIdRef as RunId);
    const handoffResult = messages
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "h1");
    const payload =
      handoffResult?.type === "tool_result" ? (JSON.parse(handoffResult.content) as Record<string, unknown>) : {};
    /**
     * h2 = 接管之后那次**重新观察**。§20.3 的落点就在这里 ——
     * 没有它，「完成信号 ≠ 任务成功」只是一句措辞。
     */
    const observeResult = messages
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "h2");
    const observed =
      observeResult?.type === "tool_result"
        ? (JSON.parse(observeResult.content) as Record<string, unknown>)
        : undefined;
    const statusAfter = await composed.ports.runs.getStatus(runIdRef as RunId);
    composed.db.close();

    const req = trace.byType("InteractionRequested")[0]?.payload;
    const done = trace.byType("InteractionCompleted")[0]?.payload;

    fact("InteractionRequested", req ? `${req.toolName}` : "（没有发）");
    fact("等待期间的 Run 状态", statusDuringWait ?? "（没读到）");
    fact("InteractionCompleted.answered", String(done?.answered));
    fact("接管结果 status", String(payload["status"]));
    fact("结果里是否声称已完成", /已完成|已核实|success/i.test(String(payload["note"] ?? "")) ? "是（错）" : "否（对）");
    fact("结果里有 nextStep 要求核实", payload["nextStep"] !== undefined ? "是" : "否");
    fact(
      "接管后是否真的重新观察了",
      observed === undefined
        ? "没有（h2 的 tool_result 不在 transcript 上）"
        : `是 —— stat(${String(observed["path"])}) → exists=${String(observed["exists"])}`,
    );
    fact("最终状态 / Terminal", `${statusAfter} / ${r.value.terminal.reason}`);

    /**
     * 【定】最后两项是「观察真的发生了」的判据，不能省。
     * 只断言前六项的话，一个「拿到完成信号就直接收尾」的模型脚本
     * 也能让这一段全绿 —— 而那恰恰是 §20.3 要防的那个行为。
     */
    const ok =
      req !== undefined &&
      done?.answered === true &&
      statusDuringWait === "WAITING_FOR_INTERACTION" &&
      payload["status"] === "HANDOFF_COMPLETED_BY_USER" &&
      payload["nextStep"] !== undefined &&
      String(payload["note"]).includes("他的声明") &&
      observed?.["exists"] === true &&
      r.value.terminal.reason === "COMPLETED";

    verdict(
      ok,
      ok
        ? "接管期间 Run 的状态真的是 WAITING_FOR_INTERACTION（此前这个值全仓只出现在类型定义里）；" +
          "完成信号被如实标成「用户的声明，不是已核实的事实」并要求下一步先核实，" +
          "而那次核实**真的发生了**：h2 的 stat 读回了 expectedCompletion 点名的文件"
        : statusDuringWait !== "WAITING_FOR_INTERACTION"
          ? `等待期间状态是 ${statusDuringWait}，WAITING_FOR_INTERACTION 仍然不可达`
          : observed?.["exists"] !== true
            ? "接管之后没有重新观察（或观察没读到 expectedCompletion 点名的东西）—— §20.3 落空"
            : "接管结果的措辞把「人说做完了」当成了「任务成功了」",
    );

    // 判别力：没有接管通道时必须**如实报错**，不能静默挂起或假装成功。
    const ws2 = tempWorkspace();
    try {
      const c2 = compose({
        dbPath: ":memory:",
        workspaceRoot: ws2.root,
        approvalDecider: async () => ({ approved: true }),
        trace: new CollectingTraceSink(),
        // 【定】刻意不传 handoff
        modelPortOverride: new ScriptedModelPort([
          {
            text: "请人",
            toolCalls: [
              {
                toolCallId: "x1",
                name: "request_handoff",
                input: { instructions: "做点什么", expected_completion: "出现某个结果" },
              },
            ],
          },
          { text: "结束", toolCalls: [] },
        ]),
      });
      const g2 = c2.runtime.start(c2.makeRunSpec("没有接管通道"));
      let runId2 = "";
      let r2 = await g2.next();
      while (!r2.done) {
        if (!runId2) runId2 = String(r2.value.runId);
        r2 = await g2.next();
      }
      const msgs2 = await c2.ports.transcript.rebuildMessages(runId2 as RunId);
      const res2 = msgs2.flatMap((m) => m.content).find((c) => c.type === "tool_result");
      const text2 = res2?.type === "tool_result" ? res2.content : "";
      c2.db.close();

      const reported = text2.includes("TOOL_HANDOFF_NO_CHANNEL");
      fact("无通道时的返回", reported ? "TOOL_HANDOFF_NO_CHANNEL（如实报错）" : text2.slice(0, 90));
      verdict(
        reported,
        reported
          ? "没有接管通道时如实报装配错误 —— 「能发起接管却无人接收」不会静默把 Run 挂死"
          : "没有接管通道时没有如实报错",
      );
    } finally {
      ws2.cleanup();
    }
  } finally {
    ws.cleanup();
  }
}

/** E 段：接管中崩溃 → resume 识别等待交互状态并重新引导。 */
async function sectionHandoffCrash(): Promise<void> {
  section("E. 接管中崩溃后 resume：识别等待交互状态并重新发起，不直接调模型");
  console.log(
    "   阶段 2 已把 RunStatus 落库，但 resume 对 `WAITING_FOR_INTERACTION`\n" +
      "   **没有任何处理分支** —— 它会一路走到主循环然后直接调模型。\n" +
      "   那意味着：人被请求去做的那件事没做，而模型看到的是一个没有结果的调用。\n",
  );

  const tmp = mkdtempSync(join(tmpdir(), "workagent-handoff-"));
  try {
    const wsDir = join(tmp, "ws");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(tmp, "runs.db");

    const script = [
      {
        text: "请人接手",
        toolCalls: [
          {
            toolCallId: "hc1",
            name: "request_handoff",
            input: { instructions: "去外部系统确认", expected_completion: "出现 done.txt" },
          },
        ],
      },
      { text: "核实", toolCalls: [{ toolCallId: "hc2", name: "stat", input: { path: "done.txt" } }] },
      { text: "做完了。", toolCalls: [] },
    ];

    // 段 1：在「已经发出接管请求、正在等人」的那一刻被打死。
    const seg1 = runSegment({
      workerPath: WORKER,
      dbPath,
      workspace: wsDir,
      mode: "start",
      script,
      handoffMode: "hang",
      killAt: "InteractionRequested#1",
      timeoutMs: 30_000,
    });

    fact("段 1 是否被 kill", seg1.killed ? `是（${seg1.killedAt?.at}）` : `否：${seg1.error ?? "?"}`);

    // 盘上的状态必须是 WAITING_FOR_INTERACTION —— 这是 resume 能分辨的前提。
    const db = openDb({ path: dbPath });
    const statusOnDisk = await new SqliteRunStore(db).getStatus(seg1.runId as RunId);
    db.close();
    fact("崩溃后盘上的状态", statusOnDisk ?? "（读不到）");

    // 段 2：新进程 resume。这次接管通道会应答。
    const seg2 = runSegment({
      workerPath: WORKER,
      dbPath,
      workspace: wsDir,
      mode: "resume",
      runId: seg1.runId,
      script,
      scriptOffset: 1,
      handoffMode: "answer",
      timeoutMs: 30_000,
    });

    const branch = /@@BRANCH@@(\S+)/.exec(seg2.stdout)?.[1] ?? "（没有未配对项）";
    fact("恢复分支", branch);
    fact("段 2 Terminal / Outcome", `${seg2.terminal ?? "?"} / ${seg2.outcome ?? "?"}`);
    fact("段 2 消耗的脚本轮数", String(seg2.turnsConsumed ?? "?"));

    /**
     * 【定】判据有三条，缺一条这段就没测到点子上：
     *   ① 崩溃时盘上状态确实是 WAITING_FOR_INTERACTION（不再是 RUNNING）；
     *   ② resume 走了**分支一**（重新执行 request_handoff = 重新发起接管），
     *      而不是把它当成一个不可观察的副作用停在 RECOVERY_REQUIRED；
     *   ③ Run 最终跑到终态 —— 说明重新接管之后主循环接得上。
     */
    const ok =
      seg1.killed &&
      statusOnDisk === "WAITING_FOR_INTERACTION" &&
      branch === "IDEMPOTENT_RETRY" &&
      seg2.terminal === "COMPLETED";
    verdict(
      ok,
      ok
        ? "崩在等人那一刻，盘上状态是 WAITING_FOR_INTERACTION；新进程 resume 认出它、" +
          "重新发起了一次接管（分支一），拿到应答后接着跑到终态 —— 这个崩溃窗口不再是未定义的"
        : `状态 ${statusOnDisk} / 分支 ${branch} / 终止 ${seg2.terminal} —— 与预期不符`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** F 段：接管等待不计入 active 墙钟。 */
async function sectionWaitNotCounted(): Promise<void> {
  section("F. 接管等待不计入 active 墙钟");
  console.log(
    "   `waitingSince` 此前**只在 Approval 事件对上设置**（run-loop.ts）。\n" +
      "   于是接管的等待会全额计入 active：用户去外部系统操作 10 分钟回来，\n" +
      "   下一轮可能直接 BUDGET_EXHAUSTED —— 而那 10 分钟里 Agent 什么都没干。\n" +
      "   这是评审 pi 维度 6 指出的**后果**（它对成因的判断有误，但后果成立）。\n",
  );

  const WAIT_MS = 1_200;
  const ws = tempWorkspace();
  try {
    const trace = new CollectingTraceSink();
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      handoff: {
        async await() {
          await new Promise((r) => setTimeout(r, WAIT_MS));
          return { note: "等了一会儿才回来" };
        },
      },
      modelPortOverride: new ScriptedModelPort([
        {
          text: "请人",
          toolCalls: [
            {
              toolCallId: "w1",
              name: "request_handoff",
              input: { instructions: "慢慢做", expected_completion: "做完" },
            },
          ],
        },
        { text: "做完了。", toolCalls: [] },
      ]),
    });

    const started = Date.now();
    const gen = composed.runtime.start(composed.makeRunSpec("等人很久"));
    let runId = "";
    let r = await gen.next();
    while (!r.done) {
      if (!runId) runId = String(r.value.runId);
      r = await gen.next();
    }
    const wallElapsed = Date.now() - started;
    const snap = await composed.runtime.inspect(runId as RunId);
    composed.db.close();

    const active = snap?.budgetUsage.activeWallClockMs ?? -1;
    fact("真实墙钟", `${wallElapsed}ms`);
    fact("等人耗时", `${WAIT_MS}ms`);
    fact("记入 activeWallClockMs", `${active}ms`);

    /**
     * 判据：active 必须**明显小于**真实墙钟，且小于等待时长本身。
     *
     * 不写「active ≈ wall − wait」这种精确等式：段内还有编帧、落盘等
     * 真实耗时，精确等式会在慢机器上随机翻红。判据取「等待那一段确实被
     * 扣掉了」这个方向性事实 —— 它足以区分「扣了」和「没扣」。
     */
    const ok = active >= 0 && active < WAIT_MS && wallElapsed >= WAIT_MS;
    verdict(
      ok,
      ok
        ? `真实墙钟 ${wallElapsed}ms，其中 ${WAIT_MS}ms 在等人；` +
          `active 只记了 ${active}ms —— 等待段确实被扣掉了`
        : `active ${active}ms 没有明显小于等待时长 ${WAIT_MS}ms —— 等人的时间被算进了预算`,
    );
  } finally {
    ws.cleanup();
  }
}

/** G 段：运行期 interject 进入下一轮帧。 */
async function sectionInterject(): Promise<void> {
  section("G. 运行期 interject 进入下一轮 ContextFrame");
  console.log(
    "   主循环第 ⓪ 步的排空逻辑与 `runtime.interject()` 从阶段 1 就都在，\n" +
      "   **缺的一直只是调用点** —— 这条能力写完之后从来没有被任何人触发过。\n" +
      "   S1 补的 stdin 通道是那个调用点；这一段验的是插话真的进了下一轮上下文。\n\n" +
      "   三种 stdin 语义（RUNNING=插话 / WAITING_FOR_APPROVAL=审批 /\n" +
      "   WAITING_FOR_INTERACTION=接管完成）的仲裁在 G2 段实测 —— \n" +
      "   此前这里只写了一句「结构上不可能串台」，那是论证不是判据。\n",
  );

  const ws = tempWorkspace();
  try {
    const trace = new CollectingTraceSink();
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      modelPortOverride: new ScriptedModelPort([
        { text: "第一步", toolCalls: [{ toolCallId: "i1", name: "stat", input: { path: "." } }] },
        { text: "第二步", toolCalls: [{ toolCallId: "i2", name: "stat", input: { path: "." } }] },
        { text: "做完了。", toolCalls: [] },
      ]),
    });

    const NOTE = "补充一句：只看 .md 文件";
    const gen = composed.runtime.start(composed.makeRunSpec("跑两步"));
    let runId = "";
    let injected = false;
    let r = await gen.next();
    while (!r.done) {
      if (!runId) runId = String(r.value.runId);
      // 第一轮的批结算之后插话 —— 下一轮编帧时应当看到它。
      if (!injected && r.value.type === "ActionBatchSettled") {
        composed.runtime.interject(runId as RunId, NOTE);
        injected = true;
      }
      r = await gen.next();
    }

    const messages = await composed.ports.transcript.rebuildMessages(runId as RunId);
    composed.db.close();

    const accepted = trace.byType("InterjectionAccepted")[0]?.payload;
    const inTranscript = messages.some((m) =>
      m.content.some((c) => c.type === "text" && c.text.includes(NOTE)),
    );
    // 插话必须出现在**第二轮之前**：它的价值就在于影响后续决策。
    const acceptedIdx = trace.events.findIndex((e) => e.type === "InterjectionAccepted");
    const framesBefore = trace.events
      .slice(0, acceptedIdx)
      .filter((e) => e.type === "ContextFrameCompiled").length;

    fact("InterjectionAccepted", accepted ? accepted.content : "（没有发）");
    fact("插话进入 transcript", inTranscript ? "是" : "否");
    fact("插话被接受时已编过几帧", `${framesBefore}（之后还会再编帧，说明它进得了后续上下文）`);

    const ok = accepted?.content === NOTE && inTranscript && framesBefore < 3;
    verdict(
      ok,
      ok
        ? `运行期插入的一句话被排空进了 transcript，且发生在后续编帧之前 —— ` +
          `interject 从「有实现、无调用点」变成了真的可用`
        : "插话没有进入上下文，或进得太晚（后续帧看不到它）",
    );
  } finally {
    ws.cleanup();
  }
}

/**
 * G2 段：`StdinChannel` 的三态仲裁 —— 同一个 stdin，三种语义互不串台。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】这一段是阶段 3 收口批补的，此前**零机械覆盖**。
 *
 * `StdinChannel` 全仓只在 `main.ts` 里被构造过一次；G 段测的是
 * `runtime.interject()`，D 段的接管走注入的假 `HandoffChannel`，
 * 审批走注入的 `approvalDecider` —— **三条路一行都不经过 StdinChannel**。
 * 也就是说防「三态串台」的 waiter 仲裁没有任何判据护着，
 * 而它恰恰是「恰好在等审批时敲了一句插话」这类最难复现的 bug 的所在地。
 *
 * 三条实测（用 PassThrough 驱动，不碰真 TTY）：
 *   ① RUNNING 敲一行            → onInterject 收到；
 *   ② 有人在 askLine 时敲一行     → **waiter 收到、onInterject 没收到**；
 *   ③ askLine 被 abort 后再敲一行 → **回到 onInterject**。
 *
 * 第 ③ 条是 `askLine` 里那句【定】（放弃等待必须把 waiter 清掉）唯一的判据：
 * 不清的话，下一行会被一个已经没人要的等待者吃掉，而**插话就此静默消失**。
 * ══════════════════════════════════════════════════════════════════════
 */
async function sectionStdinArbitration(): Promise<void> {
  section("G2. StdinChannel 三态仲裁：同一个 stdin，三种语义互不串台");
  console.log(
    "   此前这条只有一句结构论证（「同一时刻最多一个等待者」），没有判据。\n" +
      "   而 waiter 仲裁正是最难复现的那类 bug 的所在地 —— 结构论证挡不住改坏。\n",
  );

  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // 丢弃提示语，别把它打进验收输出里
  const interjected: string[] = [];
  const chan = new StdinChannel({
    onInterject: (t) => interjected.push(t),
    input,
    output,
    interactive: true,
  });
  /** 敲一行并把控制权让给 readline 的 'line' 回调。 */
  const type = async (line: string): Promise<void> => {
    input.write(`${line}\n`);
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
  };

  try {
    /**
     * ⚠️ 【定】这三步**不再调 `chan.setMode()`**，而这不是"顺手删掉"。
     *
     * 那个字段是纯写入的（`currentMode()` 零调用点、`line` 回调从不读它），
     * 于是这里的 `setMode` 是**装饰判据**的一种形态：它让这一段读起来像是
     * 「按三种状态各验一次」，而三次走的其实是同一条 `waiter` 分派路径。
     * 判据本身仍然成立（它验的一直是「谁在等」），只是别再让它假装
     * 自己在切状态 —— 与本仓拆掉的那几条装饰判据是同一条纪律。
     */

    // ① 没有人在等：这一行是插话
    await type("第一句插话");

    // ② 有人在等：这一行归等待者，**不能**同时变成插话
    const approval = chan.askLine("批准吗？");
    await type("y");
    const approvalGot = await approval;
    /**
     * 【定】在这里就把计数抓下来。
     *
     * 到段末再看 `interjected.length` 是**读晚了** —— 第 ③ 步会合法地
     * 再加一条，于是「那一行有没有同时变成插话」永远显示成「是」。
     * 第一版就是这么写的，判据是对的、打印是错的，而人看的是打印。
     */
    const interjectedAfterApproval = interjected.length;

    // ③ 等待被 abort（Ctrl+C）之后：waiter 必须被清干净，下一行回到插话
    const ac = new AbortController();
    const handoff = chan.askLine("做完了敲回车：", ac.signal);
    ac.abort();
    const handoffGot = await handoff;
    await type("abort 之后的插话");

    fact("① 无人在等时敲一行", interjected[0] ?? "（没收到）");
    fact("② 等审批时敲的那一行", `waiter 收到 "${approvalGot ?? "（无）"}"`);
    fact(
      "   同一行有没有同时变成插话",
      interjectedAfterApproval > 1 ? `是（错）：${interjected[1]}` : "否（对）",
    );
    fact("③ abort 后的等待返回", handoffGot === undefined ? "undefined（对）" : `"${handoffGot}"（错）`);
    fact("   abort 之后再敲的那一行", interjected[1] ?? "（被吃掉了）");

    const ok =
      interjected[0] === "第一句插话" &&
      approvalGot === "y" &&
      // 等待者在场的那一行**不得**同时进插话队列
      interjectedAfterApproval === 1 &&
      handoffGot === undefined &&
      interjected.length === 2 &&
      interjected[1] === "abort 之后的插话";

    verdict(
      ok,
      ok
        ? "三种语义各触发一次且互不串台：等待者在场时那一行只归等待者，" +
          "放弃等待之后 waiter 被清干净、下一行回到插话 —— 没有任何一句话被吃掉"
        : interjected.length > 2 || (interjected[1] !== undefined && approvalGot !== "y")
          ? "同一行既喂了等待者又当成了插话 —— 三态串台"
          : `abort 之后 waiter 没被清干净，插话被一个没人要的等待者吃掉了（收到 ${JSON.stringify(interjected)}）`,
    );
  } finally {
    chan.close();
    input.end();
  }
}

/**
 * H 段：`ask_user`（阶段 3.5）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】这一段要证明的**不是**「问了一句」，而是三件互相独立的事：
 *
 *   ① 有人时：Run 真的进 `WAITING_FOR_INTERACTION`，答案原样回到模型；
 *   ② 没人时：**ok:true ＋ NO_ANSWER**，不是失败 —— 这是决 3，
 *      与 `request_handoff` 的处置**刻意相反**；
 *   ③ 等待时间从 active 墙钟里扣掉。
 *
 * ② 是这一段的重心。它与 D 段的差别不是措辞而是语义：handoff 缺的是
 * 一个真实发生过的外部动作（没发生就是没发生），ask_user 缺的只是一个
 * 偏好（模型可以自己定）。把两者处置成同一种，会让一次本可完成的任务
 * 因为旁边没人而中止 —— 2026-08-30 的跑批里那个形态真的出现过。
 * ══════════════════════════════════════════════════════════════════════
 */
async function sectionAskUser(): Promise<void> {
  section("H. ask_user：有人时拿到答案，没人时 NO_ANSWER 而不是失败");

  // ── ① 有人回答 ──
  const ws = tempWorkspace();
  let statusDuringWait: RunStatus | undefined;
  let runIdRef = "";
  let askedOptions: string[] = [];
  try {
    const trace = new CollectingTraceSink();
    const question: QuestionChannel = {
      async ask(req) {
        if (runIdRef) statusDuringWait = await composed.ports.runs.getStatus(runIdRef as RunId);
        askedOptions = req.options;
        return { choice: "扁平结构：md 与 images 平级" };
      },
    };
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      question,
      modelPortOverride: new ScriptedModelPort([
        {
          text: "这里有歧义，先问一句",
          toolCalls: [
            {
              toolCallId: "q1",
              name: "ask_user",
              input: {
                question: "归档目录用哪种结构？",
                options: "扁平结构：md 与 images 平级\n带顶层目录：都放进一个同名文件夹",
              },
            },
          ],
        },
        { text: "按你选的做完了。", toolCalls: [] },
      ]),
    });

    const gen = composed.runtime.start(composed.makeRunSpec("有歧义的归档任务"));
    let r = await gen.next();
    while (!r.done) {
      if (!runIdRef) runIdRef = String(r.value.runId);
      r = await gen.next();
    }

    const messages = await composed.ports.transcript.rebuildMessages(runIdRef as RunId);
    const res = messages
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "q1");
    const payload =
      res?.type === "tool_result" ? (JSON.parse(res.content) as Record<string, unknown>) : {};
    composed.db.close();

    const req = trace.byType("InteractionRequested")[0]?.payload;
    const done = trace.byType("InteractionCompleted")[0]?.payload;

    fact("等待期间 Run 状态", statusDuringWait ?? "（没读到）");
    fact("通道收到的选项数", askedOptions.length);
    fact("InteractionRequested", req ? `有（${req.toolName}）` : "无");
    fact("InteractionCompleted.answered", done ? String(done.answered) : "（无事件）");
    fact("工具返回 status", String(payload["status"]));
    fact("工具返回 choice", String(payload["choice"]));

    const okAnswered =
      statusDuringWait === "WAITING_FOR_INTERACTION" &&
      askedOptions.length === 2 &&
      req?.toolName === "ask_user" &&
      done?.answered === true &&
      payload["status"] === "ANSWERED" &&
      payload["choice"] === "扁平结构：md 与 images 平级";

    verdict(
      okAnswered,
      okAnswered
        ? "有人时：Run 进 WAITING_FOR_INTERACTION、选项按行拆成 2 个、" +
          "用户选的那一项**原样**回到模型 —— 与 request_handoff 共用同一条等待链路"
        : `有人应答这条路没走通：status=${statusDuringWait} 选项数=${askedOptions.length} ` +
          `事件=${req?.toolName} answered=${done?.answered} 返回=${JSON.stringify(payload)}`,
    );
  } finally {
    ws.cleanup();
  }

  // ── ② 没有人：必须 ok:true ＋ NO_ANSWER，不是失败 ──
  const ws2 = tempWorkspace();
  try {
    const trace2 = new CollectingTraceSink();
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws2.root,
      approvalDecider: async () => ({ approved: true }),
      trace: trace2,
      // 【定】刻意不传 question 通道 —— 模拟非交互环境 / CI。
      modelPortOverride: new ScriptedModelPort([
        {
          toolCalls: [
            {
              toolCallId: "q2",
              name: "ask_user",
              input: { question: "用哪种结构？", options: "甲\n乙" },
            },
          ],
        },
        { text: "没人回答，我自己选了甲，理由是……", toolCalls: [] },
      ]),
    });
    const gen = composed.runtime.start(composed.makeRunSpec("没人可问"));
    let runId = "";
    let r = await gen.next();
    while (!r.done) {
      if (!runId) runId = String(r.value.runId);
      r = await gen.next();
    }
    const outcome = r.value.outcome?.kind;
    const messages = await composed.ports.transcript.rebuildMessages(runId as RunId);
    const res = messages
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "q2");
    const isError = res?.type === "tool_result" ? res.isError : undefined;
    const payload =
      res?.type === "tool_result" && !res.isError
        ? (JSON.parse(res.content) as Record<string, unknown>)
        : {};
    composed.db.close();

    /**
     * 【定】必须同时断言 `InteractionCompleted.answered`（2026-08-30 评审 P2-2）。
     *
     * 原来这一段只看 tool_result 与 outcome，照不到事件字段 —— 而
     * `settle-batch.ts` 当时写的是 `answered: outcome.ok`，
     * 于是 NO_ANSWER（刻意的 `ok: true`）在 Trace 上被记成**「人应答了」**。
     *
     * 两个各自正确的决定（决 3 的 ok:true ＋ answered 的语义定义）
     * 在乘积处产生了一条错误事实。行为没坏，但非交互跑批的
     * 「人工参与率」会全是假的 —— 而那正是这个字段存在的唯一理由。
     */
    const doneEv = trace2.byType("InteractionCompleted")[0]?.payload;
    fact("无通道时 tool_result.isError", String(isError));
    fact("返回 status", String(payload["status"] ?? "（不是结构化结果）"));
    fact("InteractionCompleted.answered", doneEv ? String(doneEv.answered) : "（无事件）");
    fact("Run outcome", outcome ?? "（未结算）");

    const okNoAnswer =
      isError === false &&
      payload["status"] === "NO_ANSWER" &&
      doneEv?.answered === false &&
      outcome === "SUCCESS";
    verdict(
      okNoAnswer,
      okNoAnswer
        ? "没人时：ok:true ＋ NO_ANSWER，Run 照常跑完（SUCCESS），" +
          "**且 Trace 上 answered=false** —— 前半是决 3（与 request_handoff 刻意相反：" +
          "报失败会让一次本可完成的任务因为旁边没人而中止）；" +
          "后半是审计诚实：工具说没人答，事件就不能说人答了"
        : `没人时的处置不对：isError=${isError} status=${payload["status"]} ` +
          `answered=${doneEv?.answered}（期望 false） outcome=${outcome}`,
    );
  } finally {
    ws2.cleanup();
  }

  // ── ③ 选项数量非法必须报结构化错误，不能静默接受 ──
  const ws3 = tempWorkspace();
  try {
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws3.root,
      approvalDecider: async () => ({ approved: true }),
      trace: new CollectingTraceSink(),
      question: { async ask() { return { choice: "不该走到这里" }; } },
      modelPortOverride: new ScriptedModelPort([
        {
          toolCalls: [
            {
              toolCallId: "q3",
              name: "ask_user",
              input: { question: "只有一个选项算什么选择题", options: "唯一一项" },
            },
          ],
        },
        { text: "收到错误，改。", toolCalls: [] },
      ]),
    });
    const gen = composed.runtime.start(composed.makeRunSpec("非法选项"));
    let runId = "";
    let r = await gen.next();
    while (!r.done) {
      if (!runId) runId = String(r.value.runId);
      r = await gen.next();
    }
    const messages = await composed.ports.transcript.rebuildMessages(runId as RunId);
    const res = messages
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "q3");
    const isError = res?.type === "tool_result" ? res.isError : undefined;
    const text = res?.type === "tool_result" ? res.content : "";
    composed.db.close();

    fact("1 个选项时 isError", String(isError));
    fact("错误信息里有没有说清要求", /2\D{0,4}5|至少|要求/.test(text) ? "有" : "没有");
    verdict(
      isError === true && text.includes("候选"),
      isError === true && text.includes("候选")
        ? "选项数量非法时报**结构化错误**并说清要求（2–5 个），而不是静默按 1 个选项去问 —— " +
          "错误里说得出理由，模型才改得对（retryability: AFTER_MODEL_CORRECTION）"
        : `非法选项没有被挡下：isError=${isError} 内容=${text.slice(0, 120)}`,
    );
  } finally {
    ws3.cleanup();
  }
}

function countBlocks(messages: ContextMessage[], type: "tool_call" | "tool_result"): number {
  let n = 0;
  for (const m of messages) for (const c of m.content) if (c.type === type) n += 1;
  return n;
}


void runVerify(main);

/**
 * I. 两条**被自己抵消掉**的兜底（2026-09-01 评审 A2 / A3）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这两条放在一起，因为它们是**同一种形态**：一个看起来在兜底的表达式，
 * 被紧挨着的另一句话抵消掉，而抵消是静默的。
 *
 *   `makeError`  `{ occurredAt: init.occurredAt ?? Date.now(), ...init }`
 *                —— 后面的 `...init` 把前面算好的值盖回去
 *   `sleep`      `signal?.addEventListener("abort", …)`
 *                —— 对一个**已经** aborted 的 signal 永远不触发
 *
 * 两条都不会报错、都不会被既有判据照到（`makeError` 的调用点没有一个传
 * `occurredAt`；`sleep` 的唯一调用点在模型错误退避那条罕见路径上）。
 *
 * 【定】判据打在**函数本身**而不是下游：`read_blob.line_offset` 那次的教训
 * 是「判据打在下游，跨不过出事的那一跳」。这两条的那一跳就在函数体内部。
 * ══════════════════════════════════════════════════════════════════════
 */
async function sectionDefeatedFallbacks(): Promise<void> {
  section("I. 两条被自己抵消掉的兜底：makeError 的时间戳、sleep 的 signal");

  // ── ① makeError：显式传 `occurredAt: undefined` 时兜底必须仍然生效
  //
  // 【定】夹具必须**显式传** undefined，不能只调不传。
  // 不传的话对象里根本没有那个键，展开顺序对错都一样 —— 又一次
  // 「这条判据要区分的两个值，在夹具里相等吗」。
  const err = makeError({
    code: "VERIFY_FALLBACK_PROBE",
    source: "RUNTIME",
    category: "INTERNAL",
    retryability: "NEVER",
    sideEffectState: "NO_EFFECT",
    safeMessage: "判据探针",
    occurredAt: undefined,
  });
  fact("显式传 occurredAt: undefined 时，字段是", JSON.stringify(err.occurredAt));
  const stampOk = typeof err.occurredAt === "number" && err.occurredAt > 0;
  verdict(
    stampOk,
    stampOk
      ? "`?? Date.now()` 真的兜住了 —— 展开必须排在它**前面**，" +
        "反过来写的话这个键会连同 undefined 一起被盖掉（实测：键直接消失）"
      : `occurredAt = ${JSON.stringify(err.occurredAt)} —— 兜底被 \`...init\` 抵消了`,
  );

  /**
   * ── ② sleep 必须验**两个时序**，缺一个就落进守卫重叠区 ────────────────
   *
   * ⚠️ 这一条是注入实测当场逼出来的：第一版只验「先 abort 再 sleep」，
   * 于是三向注入里**第三向没有翻红** —— `if (signal?.aborted) return` 那道
   * 早返回把 `onAbort` 整个挡在后面，「abort 时是 resolve 还是 reject」
   * 在那个夹具里**不可观察**。
   *
   * 本仓记过同一形态三次（ADR-0012 二次评审 P2-3/P2-4、归责 P1-6）：
   * 「两道守卫只在一个可观察量上重合，单摘任何一道都不红」。
   * 处置一律是**让每道守卫各有一个能单独触发它的时序**：
   *
   *   ②a 先 abort 再 sleep   → 只有「早返回」那道守得住
   *   ②b sleep 到一半才 abort → 只有 `onAbort` 那道守得住
   */
  const clock = new SystemClock();

  /** 跑一次 sleep，回报耗时与有没有抛。 */
  const probe = async (
    arm: (ac: AbortController) => void,
  ): Promise<{ elapsed: number; threw: string }> => {
    const ac = new AbortController();
    arm(ac);
    const t0 = Date.now();
    let threw = "";
    try {
      await clock.sleep(3_000, ac.signal);
    } catch (e) {
      threw = (e as Error).name || String(e);
    }
    return { elapsed: Date.now() - t0, threw };
  };

  // ②a：Ctrl+C 之后才走到退避的那个时序 —— signal 进来时已经是 aborted。
  const pre = await probe((ac) => ac.abort());
  // ②b：等待已经开始，人才按下 Ctrl+C —— 走的是 `onAbort` 那条路。
  const mid = await probe((ac) => setTimeout(() => ac.abort(), 30));

  fact("②a 先 abort 再 sleep(3000ms)", `${pre.elapsed}ms，抛：${pre.threw || "没有"}`);
  fact("②b sleep 到一半才 abort", `${mid.elapsed}ms，抛：${mid.threw || "没有"}`);

  /**
   * 【定】**四句都要断**。每一句各自挡住一种坏实现：
   *
   *   ②a 耗时 < 500ms   「只挂监听不查 aborted」→ 睡满 3 秒（不抛，所以只有耗时抓得住）
   *   ②a 不抛           （与 ②b 同理，留着保持两个时序对称）
   *   ②b 耗时 < 500ms   「abort 时什么都不做」→ 睡满 3 秒
   *   ②b 不抛           「abort 时 reject(AbortError)」→ **只有这一句抓得住**，
   *                     而那个异常会穿过整个 runLoop：不经 finish()、没有具名
   *                     Terminal、最后在 main().catch() 里打成「启动失败：Aborted」。
   *                     循环纪律第 2 条要求每个 return 都是具名 Terminal，
   *                     一次 Ctrl+C 不该变成一次崩溃。
   */
  const sleepOk =
    pre.elapsed < 500 && pre.threw === "" && mid.elapsed < 500 && mid.threw === "";
  verdict(
    sleepOk,
    sleepOk
      ? `两个时序都立刻返回且都不抛（${pre.elapsed}ms / ${mid.elapsed}ms）—— ` +
        "取消交回循环顶部那句 `if (interrupts.aborted)`，走具名 Terminal"
      : pre.elapsed >= 500
        ? `②a 睡满了 ${pre.elapsed}ms：\`addEventListener("abort")\` 对已经 aborted 的 ` +
          "signal 不触发，必须在挂监听之前先查一次 `signal.aborted`"
        : mid.elapsed >= 500
          ? `②b 睡满了 ${mid.elapsed}ms：abort 事件没有把等待唤醒`
          : `抛了（②a：${pre.threw || "无"}｜②b：${mid.threw || "无"}）：` +
            "那个异常会穿过 runLoop，绕过 finish() 与具名 Terminal",
  );
}
