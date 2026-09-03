/**
 * 验收项 4：verify:compact
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：Compact 真的落地了吗？—— 压完之后**下一轮**是不是真的变小了？
 *
 * 这条验收项针对 Compact 曾经的真实缺口；要害不是「没跑过」，而是
 * **「跑到了也不对」**，三个缺陷叠在一起：
 *
 *   1. 压缩只作用于 compileFrame 内的局部变量，runLoop 后续仍从原始
 *      state.messages 追加 → 下一轮又看到未压缩的历史；
 *   2. 从不写 COMPACT_BOUNDARY → transcript 的「从最后一个 boundary 之后
 *      重建」语义永远不触发，resume 重建不出刚才用过的压缩上下文；
 *   3. targetTokens 收了但一次没读 → 能丢的一次全丢光。
 *
 * 前两条都有一个共同的恶劣性质：**ContextCompacted 事件照常发出**。
 * 只看事件流，压缩是生效的。所以这个脚本一条都不看事件的「有没有」，
 * 只看下一轮的实际 token 数和 transcript 的实际内容。
 *
 * 挂了意味着：Replay 的重建语义从第一天起就对不上，而且没人看得出来。
 *
 * ── 阶段 3：C 段判据被换过，因为老判据两个方向都会骗人 ──────────────────
 *
 * 老判据是「帧内条目数出现过一次下降」。实测下来它**假红也假绿**：
 * 压缩发生在 `compileFrame` 内部，`ContextFrameCompiled` 报的永远是压缩
 * **后**的帧 —— 回不回写，那一帧都是压过的，从帧的大小上看不出区别。
 *
 * 新判据看的是「压缩每轮要干多少活」。判别力已实测（只改回写那一行）：
 *   有回写 freedTokens 128→167→167→167→167（丢 0→2→2→2→2）→ 6 ✓ / 0 ✗
 *   无回写 freedTokens 128→295→462→629→796（丢 0→2→4→6→8）→ 4 ✓ / 2 ✗
 * ══════════════════════════════════════════════════════════════════════
 *
 * 默认阈值是 60k/100k，脚本化模型撞不到 —— 这正是它一直没被跑过的原因。
 * 所以这里把阈值压到几百 token，并让 countTokens 随上下文真的增长。
 */

import {
  CollectingTraceSink,
  DEFAULT_CONTEXT_POLICY,
  compileFrame,
  compactMessages,
  findOrphanResults,
  findUnpairedToolUses,
  loadProfileFromFile,
  type ContextMessage,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import { join, resolve } from "node:path";
import {
  SqliteResourceStore,
  SqliteTranscriptStore,
  openDb,
} from "@workagent/store-sqlite";
import { listDirSnapshot } from "@workagent/tools-common";
import { compose, REPO_ROOT } from "../compose.js";
import {
  ScriptedModelPort,
  banner,
  estimateFromBody,
  fact,
  runVerify,
  section,
  tempWorkspace,
  verdict,
} from "./harness.js";

/** 够长的推理块，用来把上下文顶过阈值，也用来验证块级剥离真的发生了。 */
const LONG_REASONING = "我需要仔细想一想这一步该怎么做，".repeat(20);

/** 一个可辨认的标记：它只出现在推理块里，出现在请求体里就说明没剥干净。 */
const REASONING_MARK = "我需要仔细想一想";

/**
 * 【定】本脚本只注册它真正用到的那一个工具。
 *
 * 阶段 2 加 `now` 工具时这条脚本当场翻红：阈值是**帧级**的，而
 * `fixedOverheadTokens` 是「工具数 × 180」—— 多一个工具就多 180，
 * 留给 messages 的额度被挤掉一大块，压缩行为整个变形。
 *
 * 夹具不该对「case 包里现在有几个工具」敏感。它要验的是 Compact 的落地，
 * 不是工具清单。锁成单工具之后，将来再加工具也不会误伤这条脚本。
 */
const FIXTURE_TOOLS = [listDirSnapshot];

/**
 * 【定】system prompt 也要锁死，理由与 FIXTURE_TOOLS 一模一样。
 *
 * 阶段 3 的 S2.5 把生产 prompt 从 10 行扩到 40 行（工具选择指引），
 * 这条脚本当场翻红 —— 而且是**假红**：帧的起步价从 ~250 涨到 ~890，
 * 一举越过 softInputLimitTokens(600)，于是第一轮就触发压缩、
 * `compactTargetTokens - nonMessageTokens` 被夹到 0，Compact 每轮
 * 把能丢的都丢了，可帧内条目数照样单调上涨（新消息进得比丢得快）。
 *
 * 症状看起来正是 R-6「压了但没回写」，实际成因却是**夹具的基准被挪动了**。
 * 这类假红比漏测更贵：它会让人去改一段本来是对的 Runtime 代码。
 *
 * 夹具要验的是 Compact 的落地，不是「今天的 prompt 有多长」。
 */
const FIXTURE_PROMPT = "你是一个测试用的执行体。按要求调用工具，完成后用一句话说明。";

/**
 * 【定】Compact 夹具固定使用它所引用过探针结论的 qwen3.7-plus 声明。
 *
 * 在 modelId 可以从 `.env` 选择独立 profile 之后，不显式固定会让这条 Runtime
 * 验收随开发者当前使用的模型改变。它要测的是 Compact 回写，不是新模型尚未探明的
 * token/cache 行为；这与上面的单工具、固定 prompt 是同一条夹具隔离纪律。
 */
const FIXTURE_PROFILE = loadProfileFromFile(
  resolve(REPO_ROOT, "adapters/endpoint-profiles/bailian-anthropic.json"),
);

const POLICY = {
  ...DEFAULT_CONTEXT_POLICY,
  reservedOutputTokens: 1_024,
  softInputLimitTokens: 600,
  hardInputLimitTokens: 20_000,
  /**
   * 注意它是**帧级**预算：1 个工具的固定开销 180，system prompt ＋ 时间事实
   * 再占一百多。compileFrame 会先扣掉这些，剩下的才是留给 messages 的额度。
   *
   * 【定】取值必须让**消息级**丢弃真的发生在中途，而不只是剥推理块。
   *
   * 阶段 3 调整前这里是 440。它当时能过 C 段是个巧合：老的 system prompt
   * 恰好把 `compactTargetTokens - nonMessageTokens` 压到了 0，于是每一轮
   * 都把能丢的全丢了。换一段长度不同的 prompt，目标变成正数，
   * 压缩就退化成「只剥推理块」—— C 段（帧内条目数出现下降）永远不成立。
   *
   * 也就是说：**这个判据此前依赖的是一个没写下来的巧合。**
   * 现在把目标显式压到「只够留最近两轮」的量级，让丢弃在第 3–4 轮真的发生，
   * 后面还剩两轮能观察到条目数下降。
   */
  compactTargetTokens: 280,
};

async function main(): Promise<void> {
  banner(
    "验收项 4：Compact 是否真的落地（R-6）",
    "压缩之后，下一轮的上下文是真的变小了，还是又胖回去了？",
  );

  const ws = tempWorkspace();
  const trace = new CollectingTraceSink();

  try {
    /**
     * 六轮：前五轮各调一次工具并附一段长推理，第六轮收尾。
     * 上下文因此单调增长，中途必然越过 softInputLimit。
     *
     * ── 【定】每轮的入参必须**不同**（阶段 3 起）─────────────────────────
     *
     * Progress Guard（S9）会在「同工具 ＋ 同 normalized input ＋ 同 effect
     * digest」连续 3 次时具名终止 Run。原来这个夹具每轮都发完全相同的
     * `list_dir({path:"."})`，于是它在第 3 轮就被判成原地打转 ——
     * 压缩只来得及发生 2 次，C 段拿不到足够样本。
     *
     * 这不是 Guard 太严，是**夹具本身就长得像一个死循环**。
     * 换成每轮翻一页（cursor 递增）：入参不同、语义合理、上下文照样单调增长。
     */
    const script = [
      ...Array.from({ length: 5 }, (_, i) => ({
        reasoning: LONG_REASONING,
        text: `第 ${i + 1} 步。`,
        toolCalls: [{ toolCallId: `tc_${i}`, name: "list_dir", input: { path: ".", cursor: i } }],
      })),
      { text: "全部做完了。", toolCalls: [] },
    ];

    const model = new ScriptedModelPort(script, estimateFromBody);
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      modelPortOverride: model,
      profileOverride: FIXTURE_PROFILE,
      contextPolicy: POLICY,
      tools: FIXTURE_TOOLS,
      systemPrompt: FIXTURE_PROMPT,
    });

    section("A. 阈值与脚本");
    fact("softInputLimitTokens", POLICY.softInputLimitTokens);
    fact("compactTargetTokens", POLICY.compactTargetTokens);
    fact("脚本轮数", script.length);
    fact("每轮推理块长度", `${LONG_REASONING.length} 字符`);

    const gen = composed.runtime.start(composed.makeRunSpec("跑几轮把上下文顶大"));
    let runId = "";
    let r = await gen.next();
    while (!r.done) {
      if (!runId) runId = String(r.value.runId);
      r = await gen.next();
    }

    // ── B. 压缩到底有没有发生
    section("B. 压缩是否触发");
    const compactedEvents = trace.byType("ContextCompacted");
    const frames = trace.byType("ContextFrameCompiled");
    fact("ContextCompacted 事件数", compactedEvents.length);
    for (const e of compactedEvents) {
      console.log(`     · 省下 ${e.payload.freedTokens} tokens：${e.payload.reason}`);
    }
    fact("逐轮 totalTokens", frames.map((f) => f.payload.totalTokens).join(" → "));

    const triggered = compactedEvents.length > 0;
    verdict(triggered, triggered ? "压缩确实触发了" : "压缩没有触发 —— 阈值或脚本要调");
    // 没触发就没什么可验的了。直接 return —— 上面那条 verdict(false) 已把退出码
    // 带成 1，而 return 会让 finally 的 cleanup 正常跑完（process.exit() 不解开
    // try/finally，那正是 $TMPDIR 里那 104 个残留目录的成因）。
    if (!triggered) return;

    // ── C. 关键判据：压缩之后，下一轮真的变小了吗
    //
    // 这是唯一能区分「真压了」与「发了个事件」的判据。R-6 修复前，
    // 下一轮会因为 state.messages 没被回写而继续增长。
    section("C. 压缩之后的下一轮（R-6 第 1 条的判据）");
    const totals = frames.map((f) => f.payload.totalTokens);

    /**
     * 压缩那一轮的下标，**从事件顺序取，不要拿 totalTokens 去猜**。
     *
     * 曾经写的是 `totals.findIndex(t => t > softInputLimitTokens)`，它有个
     * 走得到的坑：`ContextCompacted` 的触发条件是**压缩前**的计数超阈值，
     * 而 `totals` 记的是**压缩后**的值。只要压缩把每一轮都拉回阈值以下，
     * findIndex 就返回 −1 —— 于是 peakBefore 退化成第一轮的值、after 变成全部轮次，
     * 判据整个失去意义（方向上会误报红，但那也只是碰巧不危险）。
     *
     * run-loop 在同一轮里先 emit `ContextCompacted` 再 emit `ContextFrameCompiled`，
     * 所以「第一条 ContextCompacted 之前有几条 ContextFrameCompiled」
     * 恰好就是压缩那一轮的 0-based 下标。这个数不依赖任何阈值比较。
     */
    const firstCompactAt = trace.events.findIndex((e) => e.type === "ContextCompacted");
    const compactedTurnIdx = trace.events
      .slice(0, firstCompactAt)
      .filter((e) => e.type === "ContextFrameCompiled").length;

    // 压缩发生在编帧内部，所以「压缩那一轮」的 totalTokens 已经是压后的值；
    // 要看回写有没有生效，得比较**再下一轮**与压缩前的峰值。
    const peakBefore = Math.max(...totals.slice(0, compactedTurnIdx + 1));
    const after = totals.slice(compactedTurnIdx + 1);

    fact("压缩发生在第几轮（1-based）", compactedTurnIdx + 1);
    fact("压缩前后的峰值", peakBefore);
    fact("压缩之后各轮", after.join(" → ") || "（压缩发生在最后一轮）");

    /**
     * ── 主判据：**每轮压缩的工作量是不是稳定的** ────────────────────────
     *
     * 【定】不要用「帧内条目数出现过一次下降」。
     *
     * 那是阶段 3 之前的写法，它在 HEAD 上绿得很脆，而且**判别力实测下会漏**：
     *   · 本脚本每轮固定新增 3 个条目，稳态压缩每轮丢一个协议单元（2 条），
     *     净增 1 —— **有回写也永远不下降**（假红）；
     *   · 反过来，把回写整个删掉，条目数变成 3→6→7→7→7→7，
     *     同样「没有下降」—— **无回写也判不出来**（假绿）。
     *   HEAD 之所以看到一次下降，是某一轮恰好攒够两个可丢单元一次丢了 4 条。
     *
     * 根因是：压缩发生在 `compileFrame` **内部**，所以 `ContextFrameCompiled`
     * 报的永远是压缩**后**的帧 —— 无论回写与否，那一帧都是压过的。
     * 从帧的大小上根本看不出回写。
     *
     * ── 看得出来的地方是「压缩每轮要干多少活」──────────────────────
     *
     * 没有回写时，`state.messages` 保留全部历史，于是**每一轮都在重压一份
     * 越来越长的历史**：同一批老消息被反复丢弃，freedTokens 单调递增。
     * 有回写时，老消息已经不在 messages 里了，每轮只需处理新增的那点，
     * freedTokens 进入平台期。
     *
     * 实测（同一份夹具，只改回写那一行）：
     *   无回写：128 → 295 → 462 → 629 → 796（丢 2 → 4 → 6 → 8 条）
     *   有回写：128 → 167 → 167 → 167 → 167（每次都只丢 2 条）
     *
     * 判据因此是：**压缩的 freedTokens 序列不得全程严格递增**。
     * 它不依赖「一次丢几条」，也不依赖任何阈值 —— 严格递增就是
     * 「同一批消息被反复重压」的定义。
     */
    const itemCounts = frames.map((f) => f.payload.items);
    fact("逐轮帧内条目数", itemCounts.join(" → "));

    const freed = compactedEvents.map((e) => e.payload.freedTokens);
    const droppedCounts = compactedEvents.map((e) => e.payload.removedMessageCount);
    fact("逐次压缩 freedTokens", freed.join(" → "));
    fact("逐次压缩丢弃条数", droppedCounts.join(" → "));

    // 需要至少 3 次压缩才谈得上「趋势」；少于 3 次说明夹具没跑到稳态。
    const enoughSamples = freed.length >= 3;
    const strictlyGrowing = freed.every((n, i) => i === 0 || n > freed[i - 1]!);
    const writebackOk = enoughSamples && !strictlyGrowing;
    verdict(
      writebackOk,
      !enoughSamples
        ? `只压缩了 ${freed.length} 次，不足以判断趋势 —— 夹具需要跑到稳态`
        : writebackOk
          ? `压缩结果确实回写进了 state.messages —— freedTokens 进入平台期` +
            `（${freed.join("→")}），说明老消息已经不在 messages 里了`
          : `压缩结果没有回写：freedTokens 全程严格递增（${freed.join("→")}），` +
            `丢弃条数也在涨（${droppedCounts.join("→")}）—— 同一批老消息每轮被重压一遍`,
    );

    // ── D. COMPACT_BOUNDARY 有没有真的落盘
    section("D. transcript 里的 COMPACT_BOUNDARY（R-6 第 2 条的判据）");
    const entries: TranscriptEntry[] = await composed.ports.transcript.readAll(runId as never);
    const boundaries = entries.filter((e) => e.kind === "COMPACT_BOUNDARY");
    fact("transcript 条目数", entries.length);
    fact("COMPACT_BOUNDARY 条数", boundaries.length);
    fact("boundary 带摘要", boundaries.every((b) => !!b.compactSummary) ? "是" : "否");
    fact("boundary 原子携带 kept snapshot", boundaries.every((b) => !!b.compactKept) ? "是" : "否");

    const boundaryOk =
      boundaries.length > 0 &&
      boundaries.every((b) => !!b.compactSummary && !!b.compactKept);
    verdict(
      boundaryOk,
      boundaryOk
        ? "boundary 以单条 payload 原子携带摘要与 kept snapshot，重建不会暴露半提交窗口"
        : "COMPACT_BOUNDARY 缺摘要或 kept snapshot，崩溃恢复仍可能丢上下文",
    );

    // ── D2. Compact 移出的工具结果能否通过恢复索引重新读回
    section("D2. Compact 恢复索引可读，旧结果没有不可逆消失");
    const indexed = compactedEvents.filter((event) => event.payload.recoveryIndexRef);
    const recovered: string[] = [];
    let indexShapeOk = indexed.length > 0;
    for (const event of indexed) {
      const indexPage = await composed.ports.resources.getTextPage(
        event.payload.recoveryIndexRef!,
      );
      if (!indexPage) {
        indexShapeOk = false;
        continue;
      }
      const index = JSON.parse(indexPage.content) as {
        protocolUnitsMovedWhole?: boolean;
        entries?: Array<{
          turn?: number;
          toolCallId?: string;
          toolName?: string;
          resultRef?: string;
          resourceRefs?: unknown[];
        }>;
      };
      if (index.protocolUnitsMovedWhole !== true || !Array.isArray(index.entries)) {
        indexShapeOk = false;
        continue;
      }
      for (const entry of index.entries) {
        if (
          typeof entry.turn !== "number" ||
          typeof entry.toolCallId !== "string" ||
          typeof entry.toolName !== "string" ||
          typeof entry.resultRef !== "string" ||
          !Array.isArray(entry.resourceRefs)
        ) {
          indexShapeOk = false;
          continue;
        }
        const page = await composed.ports.resources.getTextPage(entry.resultRef);
        if (!page) indexShapeOk = false;
        else recovered.push(page.content);
      }
    }
    const lastRequest = JSON.stringify(model.requestBodies.at(-1) ?? {});
    const oldestRemoved = !lastRequest.includes('"id":"tc_0"');
    const indexVisible = indexed.some((event) =>
      lastRequest.includes(event.payload.recoveryIndexRef!),
    );
    fact("带恢复索引的 Compact 次数", indexed.length);
    fact("从索引恢复的工具结果数", recovered.length);
    fact("当前请求不再内联最旧协议单元", oldestRemoved);
    fact("当前请求包含恢复索引 ref", indexVisible);
    verdict(
      indexShapeOk && recovered.length > 0 && oldestRemoved && indexVisible,
      "Compact 只把索引留在当前请求；索引含 turn/toolCallId/toolName/resultRef/resourceRefs，且原工具结果可分页恢复",
    );

    // ── E. 从 transcript 重建出来的，是不是压缩后的那份
    section("E. 重建结果 == 刚才真的发出去的东西");
    const rebuilt: ContextMessage[] = await composed.ports.transcript.rebuildMessages(
      runId as never,
    );
    const unpaired = findUnpairedToolUses(rebuilt);
    const orphans = findOrphanResults(rebuilt);
    const hasSummary = rebuilt.some(
      (m) => m.content.some((c) => c.type === "text" && c.text.startsWith("[已压缩]")),
    );

    fact("重建出的消息数", rebuilt.length);
    fact("重建结果含压缩摘要", hasSummary ? "是" : "否");
    fact("无 result 的 tool_use", unpaired.length === 0 ? "0（合规）" : String(unpaired.length));
    fact("无 call 的 tool_result", orphans.length === 0 ? "0（合规）" : String(orphans.length));

    // 【定】重建不能把配对拆开。Compact 丢消息时如果切断了一个 tool_call/result 组，
    // 选定端点会 200 放行 —— 这个扫描是唯一会发现它的东西。
    const rebuildOk = unpaired.length === 0 && orphans.length === 0 && rebuilt.length > 0;
    verdict(
      rebuildOk,
      rebuildOk
        ? `重建出 ${rebuilt.length} 条消息，配对完好 —— boundary 之后的 kept 被重新 append 过，没有在重建时丢失`
        : "重建结果不可用：配对被压缩切断，或 boundary 之后什么都没有",
    );

    // ── F. 推理块有没有被剥掉（R-6 第 4 条，D-3 的直接后果）
    section("F. 推理块是否被剥离（端点声明 DROPPABLE）");
    console.log(
      "   端点声明 reasoningBlockRule = DROPPABLE，protocolRoleOf 也把推理块判成\n" +
        "   ORDINARY（＝可丢）。但 Compact 是**消息级**的，而推理块与 tool_call 同处\n" +
        "   一条 assistant 消息 —— hasProtocolBlock() 会把整条保护住。\n" +
        "   不做块级剥离的话，声明允许丢、实现却每轮照付。\n" +
        "   D-3 探针实测：229 字符推理值 123 token，而 count_tokens 对它返回 0。\n",
    );

    /**
     * 判据是 A/B，不是绝对值。
     *
     * 「最后一轮里有几个推理片段」这个数本身说明不了问题 —— 0 既可能是
     * 剥干净了，也可能是压根没积累起来。所以这里用**同一份脚本 ＋ 只换
     * reasoningBlockRule** 跑一次对照：声明为 VERBATIM_REQUIRED 时推理块
     * 不许丢，两次的差就是剥离实际省下的东西。
     *
     * 这也顺带验证了原则十四：换一个端点声明，Runtime 行为必须变。
     */
    const controlMarks = await countReasoningMarksWithProfile(composed.profile);
    const lastBody = JSON.stringify(model.requestBodies[model.requestBodies.length - 1] ?? {});
    const marksInLast = lastBody.split(REASONING_MARK).length - 1;

    fact("本次（DROPPABLE）最后一轮推理片段数", marksInLast);
    fact("对照（VERBATIM_REQUIRED）同一轮片段数", controlMarks);

    const strippedOk = marksInLast < controlMarks;
    verdict(
      strippedOk,
      strippedOk
        ? `块级剥离生效：同一份脚本，仅把 reasoningBlockRule 从 VERBATIM_REQUIRED ` +
          `换成 DROPPABLE，最后一轮携带的推理片段从 ${controlMarks} 降到 ${marksInLast}`
        : `推理块没被剥掉：DROPPABLE 下仍携带 ${marksInLast} 个片段，与对照的 ${controlMarks} 无差别`,
    );

    /**
     * ── G：「最近两轮」是不是真的两轮（2026-09-01 评审 A1）───────────────
     *
     * 这一段是补给一条**已经存在过的缺陷**的：判定曾经写成
     * `working.map(m => m.turn).sort(desc).slice(0, 2)` —— 取的是**数组的前两项**
     * 而不是前两个**不同**的轮号。
     *
     * 【定】它此前没有任何判据，而且**不可能**被别的判据顺带抓住**：
     * 保护窗口小一半既不报错（配对组由 `protocolUnits` 另行保护，不变量 8 不破），
     * 也不改变 freedTokens 的方向（C 段看的是"每轮要干多少活"，丢得更多只会
     * 让那条更绿）。也就是说它是一个**只会让 Compact 更激进**的偏差 ——
     * 而 Compact 的判据几乎都在验"它真的丢了东西"。
     */
    section("G. 「最近两轮」是不是真的两轮");
    console.log(
      "   §11.6 要求完整保留最近两轮 —— 未完成 Action 与错误恢复状态都在那里。\n" +
        "   一个典型回合至少两条消息（assistant 的 tool_call ＋ user 的 tool_result），\n" +
        "   于是不去重的 `[4,4,3,3,…].slice(0,2)` 得到 [4,4]、Set 收成 {4}：\n" +
        "   「最近两轮」实际只保护了最近一轮，而丢掉的那一轮恰好装着「上一步为什么失败」。\n",
    );

    /**
     * 【定】夹具必须**每轮两条消息** —— 那正是触发条件本身。
     *
     * 每轮一条的话，有 bug 与没 bug 的实现给出**同一个答案**，这条判据
     * 就退化成装饰（办公任务实跑那条教训：「这条判据要区分的两个值，
     * 在夹具里相等吗？相等就先去改夹具，再写断言」）。
     *
     * 【定】全部用纯 text 的 assistant 消息：不带 tool_call 就不会被
     * `protocolUnits` 聚成大单元，也不会被 `isUserInput` 保护 ——
     * 于是唯一还在起作用的保护就是 `recentTurns`，判据因此只测它一个。
     */
    const mkMsg = (role: "user" | "assistant", turn: number, text: string): ContextMessage => ({
      role,
      origin: role === "user" ? "USER" : "MODEL",
      turn,
      content: [{ type: "text", text }],
    });
    const twoPerTurn: ContextMessage[] = [
      mkMsg("user", 0, "任务：把这件事做完"),
      ...[1, 2, 3, 4].flatMap((t) => [
        mkMsg("assistant", t, `第 ${t} 轮上半：${"补充说明".repeat(20)}`),
        mkMsg("assistant", t, `第 ${t} 轮下半：${"补充说明".repeat(20)}`),
      ]),
    ];
    const recentResult = compactMessages(twoPerTurn, {
      protocol: composed.ports.protocol,
      // 压到 1：逼它把所有**不受保护**的单元都丢掉，剩下的就是保护集本身。
      targetTokens: 1,
      now: Date.now(),
    });
    const keptTurns = [...new Set(recentResult.kept.map((m) => m.turn))].sort((a, b) => a - b);

    fact("夹具（每轮两条消息）", "turn 0 = user 任务；turn 1/2/3/4 各两条 assistant");
    fact("Compact 之后 kept 里的轮号", keptTurns.join(", ") || "（空）");
    fact("期望", "0（当前目标，永不丢）＋ 3 与 4（最近两轮）；2 应当被丢掉");

    const recentTwoOk =
      keptTurns.includes(4) && keptTurns.includes(3) && !keptTurns.includes(2);
    verdict(
      recentTwoOk,
      recentTwoOk
        ? "最近两轮（3 与 4）都完整保留，更早的 turn 2 被丢掉 —— 「最近两轮」名副其实"
        : `保护窗口不对：kept 里是 [${keptTurns.join(", ")}]，期望含 3 与 4、不含 2。` +
          `只剩 4 说明轮号没有去重（那正是这条判据要抓的形态）`,
    );

    section("H. 恢复索引持久化失败不得提交 Compact");
    const realResources = composed.ports.resources;
    let stagedRef = "";
    let putCount = 0;
    const partialFailureHistory: ContextMessage[] = [
      mkMsg("user", 0, "部分写入回滚夹具"),
      {
        role: "assistant",
        origin: "MODEL",
        turn: 1,
        content: [
          { type: "tool_call", toolCallId: "partial_call", name: "fixture_tool", input: {} },
        ],
      },
      {
        role: "user",
        origin: "TOOL",
        turn: 1,
        content: [
          { type: "tool_result", toolCallId: "partial_call", content: "partial", isError: false },
        ],
      },
      mkMsg("assistant", 2, "最近第二轮"),
      mkMsg("assistant", 3, "最近第一轮"),
    ];
    const failed = await compileFrame(partialFailureHistory, {
      protocol: composed.ports.protocol,
      ids: composed.ports.ids,
      resources: {
        put: async (input) => {
          putCount += 1;
          if (putCount === 2) throw new Error("INJECTED_INDEX_STORE_FAILURE");
          const reference = await realResources.put(input);
          stagedRef = reference.ref;
          return reference;
        },
        getMetadata: (ref) => realResources.getMetadata(ref),
        getTextPage: (ref, opts) => realResources.getTextPage(ref, opts),
        readForMaterialization: (ref) => realResources.readForMaterialization(ref),
        discardUncommitted: (refs) => realResources.discardUncommitted(refs),
      },
      policy: {
        ...POLICY,
        softInputLimitTokens: 1,
        compactTargetTokens: 1,
      },
      systemPrompt: FIXTURE_PROMPT,
      fixedOverheadTokens: 0,
      timezone: "Asia/Shanghai",
      executionPrivilege: "SANDBOXED",
      runId: runId as never,
      now: Date.now(),
      timeFactAt: Date.now(),
    });
    fact("故障状态", failed.status);
    fact("已提交 compaction record", failed.compactionApplied.length);
    const stagedWasRolledBack =
      stagedRef.length > 0 && (await realResources.getMetadata(stagedRef)) === undefined;
    fact("失败前已写入的临时 ref 已回滚", stagedWasRolledBack);
    verdict(
      failed.status === "CONTEXT_MATERIALIZATION_FAILED" &&
        failed.compactionApplied.length === 0 &&
        failed.compactedMessages === undefined &&
        stagedWasRolledBack,
      "ResourceStore 中途故障时具名失败、不产生 boundary 状态、不丢原上下文，并回滚已写入的临时 ref",
    );

    section("I. 进程重开后 Compact 索引与原工具结果仍可恢复");
    const persistentPath = join(ws.root, "compact-resume.db");
    const persistentDb = openDb({ path: persistentPath });
    const persistentResources = new SqliteResourceStore(persistentDb);
    const persistentTranscript = new SqliteTranscriptStore(persistentDb);
    const persistentRunId = "run_compact_resume" as never;
    const sentinel = "COMPACT_RECOVERY_SENTINEL_9f3b";
    const pairedHistory: ContextMessage[] = [
      mkMsg("user", 0, "恢复索引持久化夹具"),
      {
        role: "assistant",
        origin: "MODEL",
        turn: 1,
        content: [
          { type: "tool_call", toolCallId: "old_call", name: "fixture_tool", input: {} },
        ],
      },
      {
        role: "user",
        origin: "TOOL",
        turn: 1,
        content: [
          { type: "tool_result", toolCallId: "old_call", content: sentinel, isError: false },
        ],
      },
      mkMsg("assistant", 2, "最近第二轮"),
      mkMsg("assistant", 3, "最近第一轮"),
    ];
    const persisted = await compileFrame(pairedHistory, {
      protocol: composed.ports.protocol,
      ids: composed.ports.ids,
      resources: persistentResources,
      policy: { ...POLICY, softInputLimitTokens: 1, compactTargetTokens: 1 },
      systemPrompt: FIXTURE_PROMPT,
      fixedOverheadTokens: 0,
      timezone: "Asia/Shanghai",
      executionPrivilege: "SANDBOXED",
      runId: persistentRunId,
      now: Date.now(),
      timeFactAt: Date.now(),
    });
    const persistedRef = persisted.compactionApplied[0]?.recoveryIndexRef;
    if (persisted.compactSummary && persisted.compactKept) {
      await persistentTranscript.append({
        runId: persistentRunId,
        kind: "COMPACT_BOUNDARY",
        compactSummary: persisted.compactSummary,
        compactKept: persisted.compactKept,
        createdAt: Date.now(),
      });
    }
    persistentDb.close();

    const reopenedDb = openDb({ path: persistentPath });
    const reopenedResources = new SqliteResourceStore(reopenedDb);
    const reopenedTranscript = new SqliteTranscriptStore(reopenedDb);
    const rebuiltAfterRestart = await reopenedTranscript.rebuildMessages(persistentRunId);
    const reopenedEntries = await reopenedTranscript.readAll(persistentRunId);
    const reopenedIndex = persistedRef
      ? await reopenedResources.getTextPage(persistedRef)
      : undefined;
    let recoveredSentinel = false;
    if (reopenedIndex) {
      const index = JSON.parse(reopenedIndex.content) as {
        entries?: Array<{ resultRef?: string }>;
      };
      for (const entry of index.entries ?? []) {
        if (!entry.resultRef) continue;
        const page = await reopenedResources.getTextPage(entry.resultRef);
        if (page?.content === sentinel) recoveredSentinel = true;
      }
    }
    const rebuiltHasIndex =
      persistedRef !== undefined && JSON.stringify(rebuiltAfterRestart).includes(persistedRef);
    const boundaryCarriesWholeSnapshot = reopenedEntries.some(
      (entry) =>
        entry.kind === "COMPACT_BOUNDARY" &&
        entry.compactKept?.length === persisted.compactKept?.length,
    );
    fact("重开后的恢复索引", reopenedIndex ? persistedRef : "（读不到）");
    fact("重建 Context 含索引 ref", rebuiltHasIndex);
    fact("原工具结果哨兵可恢复", recoveredSentinel);
    fact("boundary 原子携带完整 kept", boundaryCarriesWholeSnapshot);
    verdict(
      reopenedIndex !== undefined &&
        rebuiltHasIndex &&
        recoveredSentinel &&
        boundaryCarriesWholeSnapshot,
      "单条 boundary 原子携带摘要与完整 kept；连接关闭并重开后索引和原工具结果仍可恢复",
    );

    section("J. Runtime Compact 摘要可再次压缩，旧恢复索引形成链");
    const priorIndex = await reopenedResources.put({
      kind: "text",
      mediaType: "application/vnd.workagent.compact-index+json; charset=utf-8",
      label: "prior compact index fixture",
      content: JSON.stringify({ type: "COMPACT_RECOVERY_INDEX", version: 1, entries: [] }),
      redactionDisposition: "TEXT_REDACTED",
    });
    const oldRuntimeSummary: ContextMessage = {
      role: "user",
      origin: "RUNTIME",
      turn: 1,
      recoveryIndexRefs: [priorIndex.ref],
      content: [{ type: "text", text: "旧 Compact 摘要".repeat(30) }],
    };
    const chained = await compileFrame(
      [
        mkMsg("user", 0, "真实用户目标"),
        oldRuntimeSummary,
        mkMsg("assistant", 2, "最近第二轮"),
        mkMsg("assistant", 3, "最近第一轮"),
      ],
      {
        protocol: composed.ports.protocol,
        ids: composed.ports.ids,
        resources: reopenedResources,
        policy: { ...POLICY, softInputLimitTokens: 1, compactTargetTokens: 1 },
        systemPrompt: FIXTURE_PROMPT,
        fixedOverheadTokens: 0,
        timezone: "Asia/Shanghai",
        executionPrivilege: "SANDBOXED",
        runId: persistentRunId,
        now: Date.now(),
        timeFactAt: Date.now(),
      },
    );
    const chainedRef = chained.compactionApplied[0]?.recoveryIndexRef;
    const chainedPage = chainedRef
      ? await reopenedResources.getTextPage(chainedRef)
      : undefined;
    const chainedIndex = chainedPage
      ? (JSON.parse(chainedPage.content) as { priorRecoveryIndexRefs?: string[] })
      : undefined;
    const oldSummaryRemoved =
      chained.compactKept?.every((message) => message !== oldRuntimeSummary) === true;
    const trueUserKept =
      chained.compactKept?.some(
        (message) => message.origin === "USER" && message.turn === 0,
      ) === true;
    fact("旧 Runtime 摘要已移出", oldSummaryRemoved);
    fact("真实用户目标仍保留", trueUserKept);
    fact("新索引指向旧索引", chainedIndex?.priorRecoveryIndexRefs?.join(", ") ?? "（无）");
    verdict(
      oldSummaryRemoved &&
        trueUserKept &&
        chainedIndex?.priorRecoveryIndexRefs?.includes(priorIndex.ref) === true,
      "Compact 摘要不再冒充真实用户输入永久累积；移出时旧索引进入新索引链，恢复能力不丢",
    );
    reopenedDb.close();

    console.log(
      "\n   为什么这条验收项不看事件的有无：R-6 修复前 ContextCompacted 照常发出，\n" +
        "   只看事件流会得到一个「压缩正常工作」的错误结论。所有判据都落在\n" +
        "   下一轮的实际 token 数和 transcript 的实际内容上。\n",
    );

  } finally {
    ws.cleanup();
  }
}

/**
 * 对照组：同一份脚本，只把 reasoningBlockRule 换成 VERBATIM_REQUIRED。
 *
 * 那一档下推理块不得丢弃，Compact 的块级剥离不生效，于是历史里的推理块
 * 会一路累积到最后一轮。返回最后一轮请求体里的推理片段数。
 */
async function countReasoningMarksWithProfile(
  base: Parameters<typeof compose>[0]["profileOverride"] extends infer P ? NonNullable<P> : never,
): Promise<number> {
  const ws = tempWorkspace();
  try {
    const script = [
      ...Array.from({ length: 5 }, (_, i) => ({
        reasoning: LONG_REASONING,
        text: `第 ${i + 1} 步。`,
        toolCalls: [{ toolCallId: `tc_${i}`, name: "list_dir", input: { path: ".", cursor: i } }],
      })),
      { text: "全部做完了。", toolCalls: [] },
    ];
    const model = new ScriptedModelPort(script, estimateFromBody);
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: ws.root,
      approvalDecider: async () => ({ approved: true }),
      trace: new CollectingTraceSink(),
      modelPortOverride: model,
      contextPolicy: POLICY,
      tools: FIXTURE_TOOLS,
      systemPrompt: FIXTURE_PROMPT,
      profileOverride: {
        ...base,
        context: { ...base.context, reasoningBlockRule: "VERBATIM_REQUIRED" },
      },
    });
    const gen = composed.runtime.start(composed.makeRunSpec("对照组"));
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const lastBody = JSON.stringify(model.requestBodies[model.requestBodies.length - 1] ?? {});
    return lastBody.split(REASONING_MARK).length - 1;
  } finally {
    ws.cleanup();
  }
}

void runVerify(main);
