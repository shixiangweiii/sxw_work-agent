/**
 * verify:artifact —— 批 2 验收（阶段 3）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：**大结果外置得回来吗？产物验得出真假吗？外发在 Trace 上查得到吗？**
 *
 *   A 段  外置发生、stub 协议合法、`read_blob` 逐字取回
 *   B 段  外置前后 validateFrame() 都通过，配对不变量不被破坏
 *   C 段  `fetch_url` 的内容标 EXTERNAL_UNTRUSTED，且 Trace 上有对应事实
 *   D 段  URL scope 的 riskFact ＋ dataMovement；私网与 localhost 被拒
 *   E 段  Artifact 登记 → 检查器执行 → 事实进表 → deliveredArtifactIds 非空
 *   F 段  **判别力**：坏 ZIP / 非法 JSON / 坏编码 各一次，且两种 role 的
 *         结算结果**可区分**（DELIVERABLE → FAILED；INTERMEDIATE → 有限完成）
 *   G 段  **反向判别力**：正常产物不被误判失败
 *
 * ── G 段为什么不能省 ────────────────────────────────────────────────────
 *
 * 只测「拒绝」的话，一个**永远拒绝**的闸门也能全绿。
 * 这是 `verify:drift` E 段留下的教训，本脚本照抄那个形态。
 *
 * ── C 段的断言被换过**两次** ────────────────────────────────────────────
 *
 * 第一次（方案 §503）：原版写的是「不可信内容不能自动批准 Action」，
 * **在决 3 之下恒真** —— 所有 Action 本来就自动批准，无从失败。
 *
 * 第二次（阶段 3 收口批）：换上去的 `untrustedFlowed && frames.length >= 2`
 * **同样恒真** —— 不变量 8 保证有 tool_result，有工具批就必然编第二帧。
 * 抬头换了、判据没换，而这一段的抬头写的正是「一条永远成立的断言不是判据」。
 *
 * 现在钉的是数字与方向：第二帧的 `untrustedItems` 要与 tool_result 数对上，
 * 第一帧要**不含**不可信内容。见 C 段里那段注释。
 * ══════════════════════════════════════════════════════════════════════
 */

import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CollectingTraceSink,
  DEFAULT_CONTEXT_POLICY,
  findOrphanResults,
  findUnpairedToolUses,
  type ContextMessage,
  type PreparedAction,
  type RunId,
  type RunOutcome,
  type ModelInvocationResult,
  type ModelPort,
  type ModelRequest,
  type ModelStreamEvent,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolHandlerPort,
} from "@workagent/harness-runtime";
import { CommonToolHandler } from "@workagent/tools-common";
import { compose } from "../compose.js";
import {
  ScriptedModelPort,
  banner,
  fact,
  makeUsage,
  runVerify,
  section,
  tempWorkspace,
  verdict,
} from "./harness.js";

interface ToolCall {
  toolCallId: string;
  name: string;
  input: unknown;
}

interface RunResult {
  runId: string;
  results: Map<string, { content: string; isError: boolean }>;
  messages: ContextMessage[];
  trace: CollectingTraceSink;
  outcome?: RunOutcome;
  terminal: string;
  /** 留给调用方读 blob / artifact 的句柄。用完必须 close。 */
  composed: ReturnType<typeof compose>;
}

/** 从请求体里取最后一条 tool_result 的 JSON 正文。翻页模型靠它决定下一步。 */
function lastToolResult(request: ModelRequest): Record<string, unknown> | undefined {
  const msgs =
    (request.body as { messages?: Array<{ content?: unknown[] }> }).messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const content = msgs[i]?.content ?? [];
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const b = content[j] as { type?: string; content?: string };
      if (b?.type === "tool_result") {
        try {
          return JSON.parse(String(b.content)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * 一个**会看上一轮结果**的脚本化模型，专门用来把 blob 翻到底。
 *
 * ── 【定】为什么 A 段不能用 ScriptedModelPort ──────────────────────────
 *
 * ref 带随机后缀、续页偏移要从上一页的 `nextLineOffset` 里读 —— 两者都只有
 * 跑起来才知道。写死脚本就只能绕过工具层直接调 `ports.blobs.get()`，
 * 而 **那一跳恰恰是出过事的地方**：`line_offset` 在 `CommonToolHandler` 里
 * 被丢掉，`read_blob` 对单行 blob 完全失效，2026-08-28 摸底考试题 1 因此
 * 3/3 全灭 —— 而这一段当时是**绿的**，因为它测的是 bug 下面那一层。
 *
 * 段标题写着「read_blob 逐字取回」，断言打的却是 Port。抬头与断言不符，
 * 与阶段 3 收口批修掉的那四条是同一个形态。
 *
 * 它模仿的就是真实模型的动作：拿到 stub → 用 ref 取第一页 →
 * 看到 truncated 就把 nextStartLine / nextLineOffset 原样传回去接着取。
 */
class BlobPagingModelPort implements ModelPort {
  private seq = 0;

  async *invoke(
    request: ModelRequest,
    _signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult> {
    const last = lastToolResult(request);
    let call: ToolCall | undefined;

    if (last === undefined) {
      call = { toolCallId: "a1", name: "read_file", input: { path: "huge.txt" } };
    } else if (last["status"] === "EXTERNALIZED") {
      this.seq += 1;
      call = {
        toolCallId: `p${this.seq}`,
        name: "read_blob",
        input: { ref: String(last["ref"]), start_line: 1, limit: 2_000 },
      };
    } else if (last["truncated"] === true) {
      this.seq += 1;
      call = {
        toolCallId: `p${this.seq}`,
        name: "read_blob",
        input: {
          ref: String(last["ref"]),
          start_line: Number(last["nextStartLine"] ?? 1),
          limit: 2_000,
          line_offset: Number(last["nextLineOffset"] ?? 0),
        },
      };
    }

    const usage = makeUsage(100, 20);
    if (!call) {
      return {
        content: [{ type: "text", text: "取完了。" }],
        toolCalls: [],
        stopReason: "end_turn",
        usage,
        interrupted: false,
      };
    }
    return {
      content: [
        { type: "tool_call", toolCallId: call.toolCallId, name: call.name, input: call.input },
      ],
      toolCalls: [call],
      stopReason: "tool_use",
      usage,
      interrupted: false,
    };
  }

  async countTokens(): Promise<number | undefined> {
    return 100;
  }
}

/** 跑一段脚本化 Run（可多轮），把 tool_result 与事件都收回来。 */
async function runScript(
  workspaceRoot: string,
  turns: Array<{ text?: string; toolCalls: ToolCall[] }>,
  /** F 段用它注入一个「会谎报产物内容」的 Handler。见那一段的说明。 */
  toolsOverride?: ToolHandlerPort,
  /** A 段用它注入会看上一轮结果的翻页模型。见 BlobPagingModelPort 的说明。 */
  modelOverride?: ModelPort,
): Promise<RunResult> {
  const trace = new CollectingTraceSink();
  const composed = compose({
    dbPath: ":memory:",
    workspaceRoot,
    approvalDecider: async () => ({ approved: true }),
    trace,
    modelPortOverride:
      modelOverride ?? new ScriptedModelPort([...turns, { text: "做完了。", toolCalls: [] }]),
    ...(toolsOverride ? { portOverrides: { tools: toolsOverride } } : {}),
  });

  const gen = composed.runtime.start(composed.makeRunSpec("verify:artifact 夹具"));
  let runId = "";
  let r = await gen.next();
  while (!r.done) {
    if (!runId) runId = String(r.value.runId);
    r = await gen.next();
  }

  const messages = await composed.ports.transcript.rebuildMessages(runId as RunId);
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "tool_result") results.set(c.toolCallId, { content: c.content, isError: c.isError });
    }
  }

  return {
    runId,
    results,
    messages,
    trace,
    ...(r.value.outcome ? { outcome: r.value.outcome } : {}),
    terminal: r.value.terminal.reason,
    composed,
  };
}

function parse(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _unparsed: raw };
  }
}

// ══════════════════════════════════════════════════════════════ main

async function main(): Promise<void> {
  banner(
    "批 2 验收：大结果与产物（verify:artifact）",
    "外置的东西取得回来吗？产物的完整性验得出真假吗？数据去哪了查得到吗？",
  );

  await sectionBlobRoundTrip();
  await sectionFetchTrust();
  await sectionArtifacts();
}

/** A ＋ B 段：外置 → stub → read_blob 逐字取回；配对与协议不被破坏。 */
async function sectionBlobRoundTrip(): Promise<void> {
  section("A. 外置 → stub → read_blob 逐字取回");
  console.log(
    "   只做 stub 不给取回通路，是**比静默截断更糟的信息阻断**：\n" +
      "   静默截断至少给了错误的完整感，阻断是明知有东西而拿不到。\n" +
      "   所以这一段的落点是「逐字比对」，不是「stub 长得对不对」。\n",
  );

  const ws = tempWorkspace();
  let composed: RunResult["composed"] | undefined;
  try {
    /**
     * 夹具尺寸有两个约束，缺一条判据就失去意义：
     *
     *   · **要超过外置阈值**（8000 tokens ≈ 20000 字符），否则根本不外置；
     *   · **行数要落在 `read_file` 的单页上限（2000 行）之内**，
     *     否则工具结果本身就只装了前 2000 行 —— 那时「取回内容 == 文件原文」
     *     本来就不成立，判据会红在一个与外置无关的地方。
     *
     * 1500 行 × 约 50 字符 ≈ 75000 字符 ≈ 30000 tokens，两条都满足。
     */
    const lines = Array.from(
      { length: 1_500 },
      (_, i) => `第 ${i + 1} 行：这里放一段足够长的内容，用来把工具结果撑过外置阈值。`,
    );
    const original = lines.join("\n");
    writeFileSync(join(ws.root, "huge.txt"), original, "utf8");

    // 第一轮读大文件（触发外置），第二轮把 ref 取回来。
    /**
     * 【定】一个 Run 走完「读大文件 → 外置 → 逐页取回」，
     * 而且**每一页都是真的 `read_blob` 工具调用**（经 CommonToolHandler）。
     *
     * 此前这里是两个 Run ＋ 直接调 `ports.blobs.get()`：store 层一直是对的，
     * 所以那样测永远绿 —— 而真实事故就发生在被跳过的那一跳上。
     */
    const r1 = await runScript(ws.root, [], undefined, new BlobPagingModelPort());
    const stub = parse(r1.results.get("a1")?.content);
    const ref = String(stub["ref"] ?? "");
    const ext = r1.trace.byType("ToolResultExternalized")[0]?.payload;

    fact("stub.status", String(stub["status"]));
    fact("stub.ref", ref || "（没有 ref）");
    fact("stub 里有 preview / retrieval", `${stub["preview"] !== undefined} / ${stub["retrieval"] !== undefined}`);
    fact("stub 长度", `${(r1.results.get("a1")?.content ?? "").length} 字符`);
    fact("ToolResultExternalized 事件", ext ? `${ext.approxTokens} tokens → ${ext.ref}` : "（没有发）");

    // stub 必须结构合法：能 JSON.parse、有 status、有 ref、有取回说明。
    const stubOk =
      stub["status"] === "EXTERNALIZED" &&
      ref.length > 0 &&
      typeof stub["preview"] === "string" &&
      typeof stub["retrieval"] === "string" &&
      ext !== undefined;

    /**
     * ── 逐字取回：**翻页翻到底**，然后与原始工具结果比对 ─────────────────
     *
     * 【定】比对对象是**工具结果全文**，不是被读的那个文件。
     * 外置的是 `read_file` 的返回值（一个 JSON），文件内容只是它的一个字段。
     *
     * 【定】必须真的翻页，不能一次要 100000 行。
     * 被外置的东西几乎都是**一行 JSON**（totalLines === 1），只按行分页的话
     * 一次就把 64KB 全拿回来了 —— 刚外置掉的东西原样搬回上下文。
     * 所以这里的循环同时在验：字符预算这一层真的存在，且 next* 接得上。
     */
    let roundTripOk = false;
    let fetched = "";
    let pages = 0;
    let distinctPages = 0;
    if (ref) {
      /**
       * 【定】页面正文从 **transcript 里的 tool_result** 收，
       * 不再自己调 store —— 收的是模型真正看见的那些字节。
       *
       * 翻页动作由 `BlobPagingModelPort` 发起：它照真实模型的做法，
       * 把上一页的 `nextStartLine` / `nextLineOffset` 原样传回去。
       */
      const pageBodies: string[] = [];
      for (const [id, res] of r1.results) {
        if (!id.startsWith("p")) continue;
        const page = parse(res.content);
        if (typeof page["content"] !== "string") continue;
        pageBodies.push(String(page["content"]));
      }
      pages = pageBodies.length;
      fetched = pageBodies.join("");
      distinctPages = new Set(pageBodies).size;

      /**
       * ── 【定】「每页互不相同」是这一段真正的判别力 ──────────────────────
       *
       * `line_offset` 被丢掉时的表现**不是报错，是每页都返回第 1 页**：
       * 页数照样涨、`truncated` 照样是 true、`nextLineOffset` 照样有值 ——
       * 一个看起来完全正常、实际上永远读不完的循环。
       *
       * 只断言「重组后等于原文」也能抓到它（拼出来的是 5 份第 1 页），
       * 但失败信息会指向「内容对不上」，而真正的病因是「翻页没动」。
       * 把它单独钉出来，红的时候一眼看得出是哪一种坏法。
       */
      fact("每页互不相同", `${distinctPages}/${pages}`);

      /**
       * 【定】比对的落点是**被读文件的原文**，不是「取回的字节数对不对」。
       *
       * 拼回来的是 `read_file` 的完整结果 JSON；把它解析开，`content` 字段
       * 必须与磁盘上那份文件逐字一致。这条等式一旦成立，
       * 「外置 → stub → 翻页取回」整条链路没有丢过任何一个字符。
       *
       * 只比长度或只比前缀都不够：一次在中间丢了一页的重组，
       * 长度对不上，但**前缀是对的** —— 而前缀恰恰是最容易被抽查到的部分。
       */
      let reassembled: { content?: string } = {};
      try {
        reassembled = JSON.parse(fetched) as { content?: string };
      } catch {
        /* 拼不出合法 JSON 本身就说明翻页重组坏了 */
      }
      // pages > 1 是判据的一部分：只有真的翻了页，才证明字符预算那一层存在。
      // distinctPages === pages 钉住「每一页都往前走了」——见上面那段说明。
      roundTripOk = pages > 1 && distinctPages === pages && reassembled.content === original;
      fact("read_blob 翻页次数", pages);
      fact("取回总长度", `${fetched.length} 字符`);
      fact("重组后可解析为 JSON", reassembled.content !== undefined ? "是" : "否");
      fact(
        "逐字比对（文件原文 vs 取回结果的 content 字段）",
        reassembled.content === original
          ? `完全一致（${original.length} 字符）`
          : `不一致（原文 ${original.length}，取回 ${reassembled.content?.length ?? 0}）`,
      );
    }
    composed = r1.composed;

    verdict(
      stubOk && roundTripOk,
      stubOk && roundTripOk
        ? `超阈值结果被外置成结构合法的 stub（${(r1.results.get("a1")?.content ?? "").length} 字符），` +
          `经 ${pages} 次翻页取回后重组，文件原文 ${original.length} 字符逐字一致 —— 外置没有丢任何东西，` +
          `且单页有字符预算（工具结果是一行 JSON，只按行分页会把它整个搬回来）`
        : !stubOk
          ? "stub 结构不合法（缺 status / ref / preview / retrieval，或事件没发）"
          : pages <= 1
            ? "一次就取回了全部内容 —— 单页没有字符预算，外置等于白做"
            : "取回并重组后与原文不一致 —— 外置或翻页丢了东西",
    );

    // ── B 段
    section("B. 外置不破坏协议与配对");
    const unpaired = findUnpairedToolUses(r1.messages);
    const orphans = findOrphanResults(r1.messages);
    // stub 必须是**协议合法的 tool_result**：JSON 可解析、非空、不是 error。
    const resultBlock = r1.results.get("a1");
    const protocolOk =
      resultBlock !== undefined &&
      resultBlock.isError === false &&
      resultBlock.content.length > 0 &&
      stub["_unparsed"] === undefined;

    fact("无 result 的 tool_use", unpaired.length === 0 ? "0（合规）" : unpaired.length);
    fact("无 call 的 tool_result", orphans.length === 0 ? "0（合规）" : orphans.length);
    fact("stub 是合法 tool_result", protocolOk ? "是（可解析、非空、isError=false）" : "否");
    fact("Run 终止", `${r1.terminal} / ${r1.outcome?.kind ?? "未结算"}`);

    verdict(
      unpaired.length === 0 && orphans.length === 0 && protocolOk && r1.terminal === "COMPLETED",
      unpaired.length === 0 && orphans.length === 0 && protocolOk && r1.terminal === "COMPLETED"
        ? "外置之后配对仍然一一对应，stub 是协议合法的 tool_result，帧照常通过校验并发了出去"
        : "外置破坏了配对或协议合法性",
    );
  } finally {
    composed?.db.close();
    ws.cleanup();
  }
}

/** C ＋ D 段：外部内容的 trust 与外发可审计。 */
async function sectionFetchTrust(): Promise<void> {
  section("C. fetch_url：外部内容的 trust 链路第一次名副其实");
  console.log(
    "   `compile.ts` 从阶段 1 就把所有 tool_result 标成 EXTERNAL_UNTRUSTED，\n" +
      "   `run-loop.ts` 也早就把它喂给 Policy —— 但此前流过那条链路的\n" +
      "   **全是用户自己放进 workspace 的内容**。「不可信内容」在阶段 1–2\n" +
      "   是一个没有实例的类型。\n",
  );

  const server = await startLocalServer();
  const ws = tempWorkspace();
  let composed: RunResult["composed"] | undefined;
  try {
    /**
     * 【定】这里用的是**真实的** HTTP 请求，只是打到本机的一个临时服务器上。
     *
     * 而 fetch_url 的护栏恰恰拒绝 localhost —— 所以这一段测的是
     * 「护栏真的挡住了」，而 C 段的 trust 判定改用 `read_file` 的结果验证
     * （trust 标记与内容来源无关，它对所有 tool_result 一视同仁）。
     * 想测「取回外网内容」得联网，那属于评测，不在本脚本范围。
     */
    writeFileSync(join(ws.root, "note.txt"), "一段来自外部的素材\n", "utf8");

    const r = await runScript(ws.root, [
      {
        text: "取一个 URL 和一个文件",
        toolCalls: [
          { toolCallId: "c1", name: "fetch_url", input: { url: `http://127.0.0.1:${server.port}/x` } },
          { toolCallId: "c2", name: "fetch_url", input: { url: "http://localhost/x" } },
          { toolCallId: "c3", name: "fetch_url", input: { url: "http://169.254.169.254/latest/meta-data/" } },
          { toolCallId: "c4", name: "fetch_url", input: { url: "file:///etc/passwd" } },
          { toolCallId: "c5", name: "read_file", input: { path: "note.txt" } },
        ],
      },
    ]);
    composed = r.composed;

    // C：帧里的 trust 汇总。任何 tool_result 都该被标成不可信。
    const frames = r.trace.byType("ContextFrameCompiled");
    const proposals = r.trace.byType("ActionProposed");
    const toolResults = r.messages.flatMap((m) => m.content).filter((c) => c.type === "tool_result");
    fact("编帧次数", frames.length);
    fact(
      "第二帧（含 tool_result）",
      `${frames[1]?.payload.items ?? 0} 项 —— tool_result 一律标 EXTERNAL_UNTRUSTED`,
    );
    fact("第一帧 trust（只有任务消息）", JSON.stringify(frames[0]?.payload.trust ?? null));
    fact("第二帧 trust", JSON.stringify(frames[1]?.payload.trust ?? null));
    fact("这一批产生的 tool_result 数", toolResults.length);

    /**
     * ── 【定】这一段的判据在阶段 3 收口批被换掉过一次 ─────────────────────
     *
     * 原版是 `untrustedFlowed && frames.length >= 2`，两项都是**结构保证**：
     * 不变量 8 保证每个 tool_call 都有 result（工具全失败也照样有），
     * 有工具批就必然编第二帧 —— 唯一的失败路径是 Run 本身崩掉，与 trust 无关。
     *
     * 那正是方案 §503 点名要换掉的形态，而换的时候只换了抬头：
     * 「一条永远成立的断言不是判据，是装饰」这句话写在本文件头上，
     * 而它下面那条断言自己就是。
     *
     * 现在钉三件事：
     *   ① 第二帧确实标了不可信，且 `untrustedItems` 与 tool_result 数**对得上**
     *      —— 数字对得上才排除「标了个常量」；
     *   ② 第一帧（只有任务消息）**没有**不可信内容 —— 反向判别力，
     *      一个恒返回 true 的实现在这里当场翻红；
     *   ③ 这条事实进了 Trace（`payload.trust` 存在）—— §503 要的「留得下记录」。
     */
    const f0 = frames[0]?.payload.trust;
    const f1 = frames[1]?.payload.trust;
    const cOk =
      toolResults.length > 0 &&
      f0?.hasExternalUntrusted === false &&
      f0.untrustedItems === 0 &&
      f1?.hasExternalUntrusted === true &&
      f1.untrustedItems === toolResults.length;
    verdict(
      cOk,
      cOk
        ? `外部内容进入上下文后被标成 EXTERNAL_UNTRUSTED（第二帧 ${f1?.untrustedItems} 项，` +
          `与 ${toolResults.length} 个 tool_result 一一对上），而只有任务消息的第一帧不含不可信内容；` +
          `这条事实现在落在 ContextFrameCompiled 上，Trace 查得到`
        : `trust 汇总不成立：第一帧 ${JSON.stringify(f0)}，第二帧 ${JSON.stringify(f1)}，` +
          `tool_result ${toolResults.length} 个`,
    );

    // ── D 段
    section("D. URL scope 的 riskFact ＋ dataMovement；私网与 localhost 被拒");
    console.log(
      "   `EffectScope.kind` 从阶段 1 起就有 \"URL\"，但 effect-resolver 只对\n" +
        "   FILE / DIRECTORY 判过风险 —— URL scope 拿不到任何 riskFact。\n" +
        "   决 3 之下审批全部放行，所以这几条 fact 当前**不阻断任何东西**；\n" +
        "   它们的价值是让「这次调用把数据发去了哪里」在 Trace 上可审计。\n",
    );

    const denied = ["c1", "c2", "c3", "c4"].map((id) => ({
      id,
      res: r.results.get(id),
    }));
    for (const d of denied) {
      const isDenied = d.res?.isError === true && d.res.content.includes("TOOL_URL_DENIED");
      fact(`${d.id} 被拒`, isDenied ? "是" : `否 → ${d.res?.content.slice(0, 90)}`);
    }
    const allDenied = denied.every(
      (d) => d.res?.isError === true && d.res.content.includes("TOOL_URL_DENIED"),
    );

    // riskFact 走 ActionProposed 的 effect 字段 —— 它是 Trace 上看得见的那一面。
    const urlProposals = proposals.filter((p) => p.payload.toolName === "fetch_url");
    for (const p of urlProposals.slice(0, 2)) {
      console.log(`     · ${p.payload.toolName}: ${p.payload.effect}`);
    }
    const networkEffect = urlProposals.every((p) => p.payload.effect.startsWith("NETWORK "));

    verdict(
      allDenied && networkEffect && urlProposals.length === 4,
      allDenied && networkEffect
        ? `私网(169.254)、localhost、127.0.0.1 与 file:// 四条全部被拒；` +
          `URL scope 的 effect 如实标成 NETWORK（不是 READ）—— 数据流出在 Trace 上看得见`
        : !allDenied
          ? "有 URL 没被护栏挡住"
          : "URL scope 的 effectType 没有标成 NETWORK",
    );

    // riskFact 与 dataMovement 直接对 Resolver 验一次 —— 事件载荷里只带了摘要。
    const eff = r.composed.ports.effects.resolve(
      {
        kind: "DECLARATIVE",
        version: "1.0.0",
        rules: [
          {
            pointer: "/url",
            effectType: "NETWORK",
            scopeKind: "URL",
            reversibility: "REVERSIBLE",
            operation: "fetch",
          },
        ],
      },
      { url: "https://example.com/collect?d=SECRET&k=2" },
      ws.root,
    );
    fact("riskFacts", eff.riskFacts.join(", ") || "（空）");
    fact("dataMovement.destination", eff.dataMovement?.destination ?? "（未填）");
    fact("dataMovement.scope", eff.dataMovement?.scope ?? "（未填）");

    const movementOk =
      eff.riskFacts.includes("EXTERNAL_ENDPOINT") &&
      eff.riskFacts.includes("URL_CARRIES_QUERY") &&
      eff.riskFacts.includes("DATA_LEAVES_HOST") &&
      eff.dataMovement?.destination === "example.com" &&
      // 【定】记参数名不记参数值 —— 否则这条审计记录自己会变成第二个泄漏点。
      !JSON.stringify(eff.dataMovement).includes("SECRET");

    verdict(
      movementOk,
      movementOk
        ? "带 query 的外发被标出三条 riskFact，dataMovement 记下了目的地 host 与参数名，" +
          "且**参数值没有被抄进审计记录**"
        : "URL scope 的 riskFact / dataMovement 不完整，或把参数值也记进了日志",
    );
  } finally {
    composed?.db.close();
    ws.cleanup();
    server.close();
  }
}

/** E / F / G 段：Artifact 登记、检查、结算映射与两个方向的判别力。 */
async function sectionArtifacts(): Promise<void> {
  section("E. Artifact 登记 → 检查器执行 → 事实进表 → deliveredArtifactIds 非空");
  console.log(
    "   §10.4【定】两层 Verification 不得互相替代。\n" +
      "   Action 级验的是「磁盘内容 == 计划内容」，所以对「计划本身就是坏的」\n" +
      "   在**结构上**是盲的 —— 写一个坏掉的 JSON，Action 级验证会通过。\n",
  );

  const ws = tempWorkspace();
  let composed: RunResult["composed"] | undefined;
  try {
    const r = await runScript(ws.root, [
      {
        text: "产出交付物",
        toolCalls: [
          {
            toolCallId: "e1",
            name: "write_file",
            input: {
              path: "report.json",
              content: JSON.stringify({ title: "汇总", items: [1, 2, 3] }, null, 2),
              artifact_role: "DELIVERABLE",
            },
          },
          {
            toolCallId: "e2",
            name: "write_file",
            input: { path: "notes.txt", content: "一些中间记录\n", artifact_role: "INTERMEDIATE" },
          },
          // 【定】没声明 artifact_role 的**不该**被登记 —— 登记触发源是工具，
          // 不是 Runtime 扫 workspace。
          { toolCallId: "e3", name: "write_file", input: { path: "draft.txt", content: "草稿" } },
        ],
      },
    ]);
    composed = r.composed;

    const registered = r.trace.byType("ArtifactRegistered").map((e) => e.payload);
    const verified = r.trace.byType("ArtifactVerified").map((e) => e.payload);
    const stored = await r.composed.ports.artifacts.listByRun(r.runId as RunId);

    for (const a of registered) console.log(`     · 登记 ${a.logicalId} v${a.version} (${a.role}/${a.kind})`);
    for (const v of verified) console.log(`     · 检查 ${v.artifactId}: ok=${v.ok} [${v.checksRun.join(", ")}]`);

    fact("ArtifactRegistered 事件数", registered.length);
    fact("ArtifactVerified 事件数", verified.length);
    fact("库里登记的产物数", stored.length);
    fact("未声明 role 的 draft.txt 被登记", registered.some((a) => a.logicalId === "draft.txt") ? "是（错）" : "否（对）");
    fact("outcome.kind", r.outcome?.kind ?? "未结算");
    fact("deliveredArtifactIds", JSON.stringify(r.outcome?.deliveredArtifactIds ?? []));

    const eOk =
      registered.length === 2 &&
      verified.length === 2 &&
      verified.every((v) => v.ok) &&
      verified.every((v) => v.checksRun.length > 0) &&
      !registered.some((a) => a.logicalId === "draft.txt") &&
      (r.outcome?.deliveredArtifactIds.length ?? 0) === 2 &&
      r.outcome?.kind === "SUCCESS";

    verdict(
      eOk,
      eOk
        ? "两个声明了 role 的产物被登记并各自跑了检查（checksRun 非空），" +
          "没声明的没有被登记，deliveredArtifactIds 接上了（不再恒空）"
        : `登记 / 检查 / 结算链路不完整（登记 ${registered.length}、检查 ${verified.length}、` +
          `delivered ${r.outcome?.deliveredArtifactIds.length ?? 0}、kind ${r.outcome?.kind}）`,
    );

    // ── G 段先做（它是 F 段的反面，放一起读更清楚）
    section("G. 反向判别力：正常产物**不**被误判失败");
    console.log(
      "   只测「拒绝」的话，一个**永远拒绝**的闸门也能全绿 —— verify:drift E 段的教训。\n",
    );
    const gOk = verified.length > 0 && verified.every((v) => v.ok) && r.outcome?.kind === "SUCCESS";
    fact("正常 JSON / 文本产物的检查结论", verified.map((v) => `${v.ok}`).join(", "));
    verdict(
      gOk,
      gOk
        ? "结构正常的 JSON 与文本产物全部通过，Run 结算 SUCCESS —— 检查器不是「一律拒绝」"
        : "正常产物被误判失败，检查器过严",
    );
  } finally {
    composed?.db.close();
    ws.cleanup();
  }

  // ── F 段：四种坏产物 ＋ role 分流
  section("F. 判别力：坏产物被抓住，且两种 role 的结算结果可区分");
  console.log(
    "   §1.2 第 3 条：DELIVERABLE 失败 → FAILED；INTERMEDIATE 失败 → COMPLETED_WITH_LIMITS。\n" +
      "   原版方案一律降级为 COMPLETED_WITH_LIMITS，那会让「**交付物是坏的**」和\n" +
      "   「某个中间步骤有瑕疵」在 outcome 上不可区分 —— 而前者意味着这次 Run 白跑了。\n\n" +
      "   ── 第 4 个 case 是阶段 3 收口批补的 ──────────────────────────────\n" +
      "   在此之前四项检查里的 **hash 一项恒真**：登记用 `a.content` 算 hash，\n" +
      "   检查器拿**同一份内存字符串**再算一次去比 —— 失败分支不可达，\n" +
      "   而它每次都进 checksRun，detail 报「4 项检查通过」。\n" +
      "   现在它比的是磁盘上那一份，所以「工具声称写了 X、实际写了 Y」\n" +
      "   这件事第一次能被抓住 —— 下面就注入这么一个会谎报的 Handler。\n",
  );

  const NUL = String.fromCharCode(0);
  const REPLACEMENT = String.fromCharCode(0xfffd);

  const cases: Array<{
    name: string;
    path: string;
    content: string;
    role: string;
    expectKind: RunOutcome["kind"];
    /** 设了它就注入谎报 Handler：磁盘写 content，声明给 Runtime 的是这一份。 */
    declaredInstead?: string;
    /** 期望是哪一项检查抓住的。不设就不钉具体项。 */
    expectCheck?: string;
  }> = [
    {
      name: "非法 JSON ＋ DELIVERABLE",
      path: "broken.json",
      content: '{"title": "汇总", "items": [1, 2,}',
      role: "DELIVERABLE",
      expectKind: "FAILED",
    },
    {
      name: "损坏的 ZIP ＋ DELIVERABLE",
      path: "archive.zip",
      // 有 PK 魔数但没有 End of Central Directory —— 被截断的归档，最常见的坏法。
      content: `PK${String.fromCharCode(3)}${String.fromCharCode(4)}${"x".repeat(64)}`,
      role: "DELIVERABLE",
      expectKind: "FAILED",
    },
    {
      name: "坏编码文本 ＋ DELIVERABLE",
      path: "report.txt",
      content: `正常开头${REPLACEMENT}${REPLACEMENT}后面是乱码${NUL}`,
      role: "DELIVERABLE",
      expectKind: "FAILED",
    },
    {
      // 【定】正文本身是完全正常的文本 —— 只有 hash 一项该失败。
      // 用一份坏文本的话，编码检查也会红，就分不清是谁抓住的了。
      name: "工具谎报产物内容（磁盘 ≠ 登记）＋ DELIVERABLE",
      path: "谎报.txt",
      content: "这是真正写到磁盘上的那一份内容。\n",
      declaredInstead: "这是工具声称写下去、但其实没有写的那一份内容。\n",
      expectCheck: "hash-matches-registration",
      role: "DELIVERABLE",
      expectKind: "FAILED",
    },
    {
      name: "同样的非法 JSON，但角色是 INTERMEDIATE",
      path: "scratch.json",
      content: '{"a": ',
      role: "INTERMEDIATE",
      expectKind: "COMPLETED_WITH_LIMITS",
    },
  ];

  let fOk = true;
  for (const c of cases) {
    const w = tempWorkspace();
    let comp: RunResult["composed"] | undefined;
    try {
      const r = await runScript(
        w.root,
        [
          {
            text: "产出",
            toolCalls: [
              {
                toolCallId: "f1",
                name: "write_file",
                input: { path: c.path, content: c.content, artifact_role: c.role },
              },
            ],
          },
        ],
        c.declaredInstead === undefined ? undefined : new LyingArtifactHandler(c.declaredInstead),
      );
      comp = r.composed;
      const v = r.trace.byType("ArtifactVerified")[0]?.payload;
      const kind = r.outcome?.kind ?? "未结算";
      // 钉住「是哪一项检查抓住的」：只断言 ok=false 的话，
      // 一个把所有产物都判坏的检查器同样能全绿。
      const caughtByExpected =
        c.expectCheck === undefined ||
        ((v?.checksRun ?? []).includes(c.expectCheck) && v?.detail.includes("hash") === true);
      const ok = v?.ok === false && kind === c.expectKind && caughtByExpected;
      if (!ok) fOk = false;
      console.log(
        `   ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${c.name.padEnd(34)} ` +
          `检查 ok=${v?.ok} → outcome ${kind}（期望 ${c.expectKind}）`,
      );
      if (v) console.log(`       ${v.detail.slice(0, 140)}`);
      // 【定】坏产物不得出现在 deliveredArtifactIds 里 ——
      // 把一个检查失败的产物列进去，等于对外宣称交付了一份坏东西。
      if ((r.outcome?.deliveredArtifactIds.length ?? 0) !== 0) {
        fOk = false;
        console.log(`       \x1b[31m坏产物却出现在 deliveredArtifactIds 里\x1b[0m`);
      }
    } finally {
      comp?.db.close();
      w.cleanup();
    }
  }

  verdict(
    fOk,
    fOk
      ? "四种坏产物各被**对应的**检查器抓住（含「磁盘 ≠ 登记」，由 hash 项抓）；" +
        "同一个错误在 DELIVERABLE 下结算 FAILED、在 INTERMEDIATE 下结算 COMPLETED_WITH_LIMITS " +
        "—— 两者可区分，且坏产物不进 deliveredArtifactIds"
      : "检查器漏判、抓错了项，或两种 role 的结算结果不可区分",
  );
}

/**
 * 一个**会谎报产物内容**的 Tool Handler。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 文件照常写下去，但交给 Runtime 登记的 `artifact.content` 是另一份。
 *
 * 【定】旋钮长在**测量装置**这边，不长在工具身上（决 6 的口径）。
 * 另一条路是往 `tools/common` 加一个「会写坏产物」的工具 —— 那既污染
 * 能力面（每工具 180 token 的固定开销），又正是「能力面被测量需求
 * 反向定义」的现场。
 *
 * 它模拟的是真实故障：工具报了成功、`output` 说写了 X，而磁盘上是 Y
 * （写到一半失败、编码转换出错、或者干脆是个 bug）。
 * 在 hash 检查改成读盘之前，**这种事在两层验证下都是绿的**。
 * ══════════════════════════════════════════════════════════════════════
 */
class LyingArtifactHandler implements ToolHandlerPort {
  private readonly inner = new CommonToolHandler({});

  constructor(private readonly declared: string) {}

  async execute(action: PreparedAction, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const out = await this.inner.execute(action, ctx);
    if (!out.artifact) return out;
    return { ...out, artifact: { ...out.artifact, content: this.declared } };
  }
}

/**
 * 本机临时 HTTP 服务器。
 *
 * 它存在的唯一目的是给 D 段一个**真实可连**的 localhost 地址 ——
 * 护栏必须在「这个地址真的能连上」的前提下仍然拒绝，否则测的只是
 * 「连不上的地址会失败」，那和护栏没关系。
 */
async function startLocalServer(): Promise<{ port: number; close(): void }> {
  const srv: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("如果你看到这段文字，说明护栏没拦住 localhost。");
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, close: () => srv.close() };
}

void runVerify(main);
