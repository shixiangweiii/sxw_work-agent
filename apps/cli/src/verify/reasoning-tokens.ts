/**
 * 探针：count_tokens 到底算不算推理块？（存量清单 D-3）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：`countTokensAccuracy: "EXACT"` 这个声明的适用范围有没有被高估？
 *
 * 起因是两次真实实跑的逐轮数据 —— `ContextFrameCompiled.totalTokens`
 * （走 count_tokens 精确路径）从第二轮起系统性低于同轮 `usage.inputTokens`，
 * 而且随轮次放大：
 *
 *     实跑 A turn 1   声明 756   实收 751   ＋5     ← 这个 ＋5 是 D-1
 *     实跑 A turn 2   声明 816   实收 919   −103
 *     实跑 B turn 2   声明 880   实收 1013  −133
 *     实跑 B turn 3   声明 1198  实收 1337  −139
 *     实跑 B turn 4   声明 2154  实收 2547  −393
 *
 * 推断是差额来自 assistant 回合里的推理块，但**没有证实**，所以 D-3 标【验】。
 * 一直没被发现的原因是 run-loop 第 ② 步只 yield text_delta，
 * reasoning_delta 被丢弃 —— 推理块在终端上完全不可见。
 *
 * ── 为什么必须先跑这条 ────────────────────────────────────────
 *
 * R-3 要修的正是 Context 阈值基准，而基准建立在「精确路径 = 可信」这个前提上。
 * 这条如果成立，前提不成立。**先探针，再改阈值。**
 *
 * 它同时决定 R-6 要不要做「块级剥离推理块」那一项。
 *
 * ── 为什么是独立脚本而不是 verify:endpoint-profile 的一段 ──────
 *
 * 这条探针必须发真实请求、要花钱。verify:all 是每次改完代码都跑的东西，
 * 把一次真实 inference 塞进去，等于让日常回归依赖网络与配额。
 * 清单原话是「建议进 spikes/，或作为 verify:endpoint-profile 的一段」——
 * 这里取第一种精神：一次性探针，显式调用，不进 verify:all。
 *
 *     npm run probe:reasoning-tokens
 * ══════════════════════════════════════════════════════════════════════
 */

import { resolve } from "node:path";
import { loadProfileFromFile, type ModelRequest } from "@workagent/harness-runtime";
import { createAnthropicModelPort } from "@workagent/shape-anthropic-messages";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TOOLS,
  REPO_ROOT,
  loadEnv,
  readEndpointConfig,
} from "../compose.js";
import { banner, fact, section, verdict } from "./harness.js";

/**
 * 一段够长的推理文本。
 *
 * 长度是刻意的：差额要显著大于 count_tokens 本身的抖动，
 * 才能把「没算」与「算得不准」区分开。太短的话两者都是个位数差。
 */
const THINKING = [
  "用户要我盘点这个目录。我先想一下步骤：",
  "第一步应该是看看根目录下有什么，确认目标目录确实存在，而不是直接假设它在。",
  "第二步是逐个进入子目录，把文件名和字节数都拿到手。",
  "这里要注意的是，list_dir 返回的是结构化数据，我不能凭目录名猜测里面有什么。",
  "第三步是汇总，算出每个子目录的文件数和总大小，找出空目录和最大的那个文件。",
  "最后写清单并追加日志。写之前我要确认统计数字都是从工具返回值里来的，",
  "而不是我自己推算的 —— 推算出来的数字看起来一样合理，但可能是错的。",
].join("");

async function main(): Promise<void> {
  banner(
    "探针 D-3：count_tokens 算不算推理块",
    "含 thinking 块的帧上，count_tokens 与真实 usage.input_tokens 差在哪？",
  );

  loadEnv();
  const cfg = readEndpointConfig();
  const profile = loadProfileFromFile(cfg.profilePath);
  const model = createAnthropicModelPort({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, profile });

  section("A. 端点当前的声明");
  fact("endpointId", String(profile.endpointId));
  fact("modelId", profile.modelId);
  fact("countTokensAccuracy", profile.tokens.countTokensAccuracy);
  fact("perRequestBaseTokens", profile.tokens.perRequestBaseTokens);
  fact("reasoningBlockRule", profile.context.reasoningBlockRule);
  console.log(
    "\n   注意：下面三个数都是**端点原始返回值**，没有叠加 perRequestBaseTokens。\n" +
      "   protocol.countTokens() 会额外 ＋" + profile.tokens.perRequestBaseTokens +
      "，那是 D-1 单独的问题，这里不掺进来。",
  );

  // ── 两个只差一个 thinking 块的 body。
  //    形状与 protocol.ts 的 toBlock() 一致 —— 探针要测的是生产路径真会发出去的东西。
  section("B. 两个只差一个 thinking 块的请求体");

  const withThinking = buildBody(profile.modelId, true);
  const withoutThinking = buildBody(profile.modelId, false);

  fact("(a) 保留 thinking 块", `${blockCount(withThinking)} 个内容块`);
  fact("(b) 去掉 thinking 块", `${blockCount(withoutThinking)} 个内容块`);
  fact("thinking 文本长度", `${THINKING.length} 字符`);
  fact("本地估算（chars / 2.5）", `约 ${Math.ceil(THINKING.length / 2.5)} tokens`);

  section("C. 三次测量");

  const a = await model.countTokens(countable(withThinking));
  const b = await model.countTokens(countable(withoutThinking));

  if (a === undefined || b === undefined) {
    verdict(false, "端点没有返回 count_tokens 结果 —— 探针无法继续");
    process.exitCode = 1;
    return;
  }

  fact("(a) count_tokens  含 thinking", a);
  fact("(b) count_tokens  无 thinking", b);
  fact("    (a) − (b)", a - b);

  // (c) 同一个 body 发一次真实 inference，读 usage.input_tokens。
  //     max_tokens 给小值 —— 我们只要 input 侧的数，输出多少无所谓。
  const c = await realInputTokens(model, withThinking, profile.modelId);
  fact("(c) 真实 usage.inputTokens", c ?? "（取不到）");

  if (c === undefined) {
    verdict(false, "真实调用没拿到 usage.input_tokens —— 探针无法继续");
    process.exitCode = 1;
    return;
  }

  fact("    (c) − (a)", c - a);

  // ── 判定
  section("D. 判定");

  const deltaAB = a - b;
  const deltaCA = c - a;
  const thinkingEstimate = Math.ceil(THINKING.length / 2.5);

  // count_tokens 自己认为 thinking 值多少 token
  const countedThinking = deltaAB;
  // 真实计费与 count_tokens 的缺口
  const missing = deltaCA;

  console.log(
    "   判据：\n" +
      "     · (a) ≈ (b)  ⟹ count_tokens 压根没把 thinking 算进去；\n" +
      "     · (c) > (a)  ⟹ 端点计费时算了，而我们的阈值判定没算 —— 系统性低估；\n" +
      "     · 两者同时成立 ⟹ D-3 的推断成立，EXACT 的适用范围被高估。\n",
  );

  const countIgnoresThinking = countedThinking < thinkingEstimate * 0.3;
  const billingIncludesThinking = missing > thinkingEstimate * 0.3;

  fact("count_tokens 认为 thinking 值", `${countedThinking} tokens`);
  fact("真实计费比 count_tokens 多", `${missing} tokens`);
  fact("thinking 的本地估算", `${thinkingEstimate} tokens`);

  if (countIgnoresThinking && billingIncludesThinking) {
    verdict(
      true,
      `D-3 推断成立：count_tokens 忽略 thinking（只算 ${countedThinking}），` +
        `而端点按 ${missing} tokens 计费。countTokensAccuracy: "EXACT" 只在无推理块的帧上成立。`,
    );
    console.log(
      "\n   → 应做的两件事：\n" +
        "     1. bailian-anthropic.json 收窄 countTokensAccuracy 的适用范围声明；\n" +
        "     2. R-6 补「块级剥离推理块」—— 声明 DROPPABLE 却每轮付费，这笔钱是白花的。",
    );
  } else if (!countIgnoresThinking && Math.abs(missing) < thinkingEstimate * 0.3) {
    verdict(
      true,
      `D-3 推断不成立：count_tokens 把 thinking 算进去了（${countedThinking} tokens），` +
        `且与真实计费吻合（差 ${missing}）。低估另有原因，需要换个方向查。`,
    );
    console.log(
      "\n   → R-6 的「块级剥离推理块」那一项不做；\n" +
        "     实跑观察到的逐轮低估要另找成因（候选：tool 定义开销、system 侧、缓存字段口径）。",
    );
  } else {
    verdict(
      false,
      `结果不落在两种干净形态上：count_tokens 算了 ${countedThinking}、` +
        `真实计费多 ${missing}、本地估算 ${thinkingEstimate}。需要人看一眼再下结论。`,
    );
  }

  section("这条探针的边界");
  console.log(
    "   单次测量、单个 body、单个端点。它能定性回答「算没算」，\n" +
      "   不能给出误差分布，也不能替换 §24.6 的端点能力回归。\n" +
      "   结论回写 profile 时必须带 evidenceRef 指向本次运行（D-1 要的就是这个粒度）。",
  );
  console.log();
}

// ══════════════════════════════════════════════════════════════ 请求体

/**
 * 一个真实形态的多轮 body：user 任务 → assistant（thinking ＋ 正文 ＋ tool_use）
 * → user（tool_result）。
 *
 * 这正是实跑里从第二轮起发出去的东西 —— D-3 观察到的低估就发生在这个形状上。
 * 块的写法对齐 protocol.ts 的 toBlock()，不要在这里另起一套。
 */
function buildBody(modelId: string, withThinking: boolean): Record<string, unknown> {
  const assistantContent: unknown[] = [];
  if (withThinking) {
    assistantContent.push({ type: "thinking", thinking: THINKING, signature: "" });
  }
  assistantContent.push({ type: "text", text: "我先看看这个目录下有什么。" });
  assistantContent.push({
    type: "tool_use",
    id: "toolu_probe_1",
    name: "list_dir",
    input: { path: "2026Q2归档" },
  });

  return {
    model: modelId,
    max_tokens: 256,
    system: DEFAULT_SYSTEM_PROMPT,
    stream: true,
    tools: DEFAULT_TOOLS.map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      input_schema: t.definition.inputSchema,
    })),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "帮我盘点 2026Q2归档 目录，写一份交接清单。" }],
      },
      { role: "assistant", content: assistantContent },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_probe_1",
            content: '{"path":"2026Q2归档","total":4,"entries":[{"name":"临时","kind":"directory"}]}',
            is_error: false,
          },
        ],
      },
    ],
  };
}

/** count_tokens 端点不接受 stream / max_tokens —— 与 protocol.countTokens() 同一处理。 */
function countable(body: Record<string, unknown>): ModelRequest {
  const { stream: _s, max_tokens: _m, ...rest } = body;
  return { body: rest, modelId: String(body["model"]) };
}

function blockCount(body: Record<string, unknown>): number {
  const messages = body["messages"] as Array<{ content: unknown[] }>;
  return messages.reduce((n, m) => n + m.content.length, 0);
}

async function realInputTokens(
  model: ReturnType<typeof createAnthropicModelPort>,
  body: Record<string, unknown>,
  modelId: string,
): Promise<number | undefined> {
  const ac = new AbortController();
  const stream = model.invoke({ body, modelId }, ac.signal);
  let r = await stream.next();
  while (!r.done) r = await stream.next();
  return r.value.usage.inputTokens || undefined;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
