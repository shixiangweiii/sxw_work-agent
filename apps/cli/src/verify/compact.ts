/**
 * 验收项 4：verify:compact
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：Compact 真的落地了吗？—— 压完之后**下一轮**是不是真的变小了？
 *
 * 这条验收项是为存量清单 R-6 补的。R-6 的要害不是「没跑过」，而是
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
 * ══════════════════════════════════════════════════════════════════════
 *
 * 默认阈值是 60k/100k，脚本化模型撞不到 —— 这正是它一直没被跑过的原因。
 * 所以这里把阈值压到几百 token，并让 countTokens 随上下文真的增长。
 */

import {
  CollectingTraceSink,
  DEFAULT_CONTEXT_POLICY,
  findOrphanResults,
  findUnpairedToolUses,
  type ContextMessage,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import { listDirSnapshot } from "@workagent/micro-cases";
import { compose } from "../compose.js";
import {
  ScriptedModelPort,
  banner,
  estimateFromBody,
  fact,
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

const POLICY = {
  ...DEFAULT_CONTEXT_POLICY,
  reservedOutputTokens: 1_024,
  softInputLimitTokens: 600,
  hardInputLimitTokens: 20_000,
  // 注意它是**帧级**预算：1 个工具的固定开销 180，system prompt ＋ 时间事实
  // 再占一百多。compileFrame 会先扣掉这些，剩下的才是留给 messages 的额度。
  compactTargetTokens: 440,
};

async function main(): Promise<void> {
  banner(
    "验收项 4：Compact 是否真的落地（R-6）",
    "压缩之后，下一轮的上下文是真的变小了，还是又胖回去了？",
  );

  const ws = tempWorkspace();
  const trace = new CollectingTraceSink();

  try {
    // 六轮：前五轮各调一次工具并附一段长推理，第六轮收尾。
    // 上下文因此单调增长，中途必然越过 softInputLimit。
    const script = [
      ...Array.from({ length: 5 }, (_, i) => ({
        reasoning: LONG_REASONING,
        text: `第 ${i + 1} 步。`,
        toolCalls: [{ toolCallId: `tc_${i}`, name: "list_dir", input: { path: "." } }],
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
      contextPolicy: POLICY,
      tools: FIXTURE_TOOLS,
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
    if (!triggered) {
      process.exit(1);
    }

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
     * 主判据用**帧内条目数**，不用 token 数。
     *
     * 理由是它不是启发式：`state.messages` 每轮只增不减（助手回合 ＋ 工具结果），
     * 所以 `ContextFrameCompiled.items` 在没有回写时必然单调不降。
     * **只要出现过一次下降，就证明压缩结果真的进了 state.messages** ——
     * 没有别的机制能让它变小。
     *
     * token 数只作为辅助观察：压缩之后还会继续加新消息，涨回去是正常的，
     * 拿它做主判据就得挑一个「涨多少算失控」的阈值，而那个阈值没有依据。
     */
    const itemCounts = frames.map((f) => f.payload.items);
    const drops = itemCounts.filter((n, i) => i > 0 && n < itemCounts[i - 1]!);
    fact("逐轮帧内条目数", itemCounts.join(" → "));

    const writebackOk = drops.length > 0;
    verdict(
      writebackOk,
      writebackOk
        ? `压缩结果确实回写进了 state.messages —— 帧内条目数出现 ${drops.length} 次下降，` +
          `而 messages 只增不减，没有回写就不可能变小`
        : "压缩结果没有回写：帧内条目数全程单调不降，说明下一轮仍从未压缩的 state.messages 追加",
    );

    // ── D. COMPACT_BOUNDARY 有没有真的落盘
    section("D. transcript 里的 COMPACT_BOUNDARY（R-6 第 2 条的判据）");
    const entries: TranscriptEntry[] = await composed.ports.transcript.readAll(runId as never);
    const boundaries = entries.filter((e) => e.kind === "COMPACT_BOUNDARY");
    fact("transcript 条目数", entries.length);
    fact("COMPACT_BOUNDARY 条数", boundaries.length);
    fact("boundary 带摘要", boundaries.every((b) => !!b.compactSummary) ? "是" : "否");

    const boundaryOk = boundaries.length > 0 && boundaries.every((b) => !!b.compactSummary);
    verdict(
      boundaryOk,
      boundaryOk
        ? "boundary 已落盘且带摘要 —— rebuildFromEntries 的「从最后一个 boundary 之后重建」语义这才被真正激活"
        : "没有写 COMPACT_BOUNDARY，重建语义仍然是死代码",
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

    section("总判定");
    const allOk = triggered && writebackOk && boundaryOk && rebuildOk && strippedOk;
    verdict(
      allOk,
      allOk
        ? "Compact 真的落地了：压缩结果进了 state.messages 与 transcript，" +
          "重建语义被激活，配对完好，推理块不再每轮重复付费"
        : "Compact 仍然只是「发了个事件」",
    );

    console.log(
      "\n   为什么这条验收项不看事件的有无：R-6 修复前 ContextCompacted 照常发出，\n" +
        "   只看事件流会得到一个「压缩正常工作」的错误结论。所有判据都落在\n" +
        "   下一轮的实际 token 数和 transcript 的实际内容上。\n",
    );

    process.exit(allOk ? 0 : 1);
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
        toolCalls: [{ toolCallId: `tc_${i}`, name: "list_dir", input: { path: "." } }],
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
