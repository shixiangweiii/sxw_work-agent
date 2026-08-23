/**
 * P5　缓存断点【可延后】
 *
 * V03 :1594【验】：「把 CACHE_BREAKPOINT 作为 ContextProtocolRole 的一种，
 * Compact 时优先在断点之后动刀，保持断点之前的前缀稳定；具体断点放置规则
 * 以 Spike 0 结论为准」。
 *
 * 关键实验：在断点之前插入或改写一条消息（模拟 Compact 重写中部），
 * 观察缓存是否失效 —— 这直接验证 §11.8 的「Compact 破坏稳定前缀」假设。
 *
 * 喂给：§11.8、§11.6 Compact 策略、§19.3 cachedInputTokens
 */

import { probe, openRecorder, requireKey, DRY_RUN } from "../harness.js";
import {
  anthropicClient,
  ANTHROPIC_MODEL,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_API_KEY_NAME,
} from "../clients/anthropic.js";
import {
  openaiClient,
  OPENAI_MODEL,
  OPENAI_PROVIDER_LABEL,
  OPENAI_API_KEY_NAME,
} from "../clients/openai.js";
import { anthropicTools, openaiChatTools, SYSTEM_PROMPT } from "../tools.js";

/**
 * 缓存通常有最小长度门槛，前缀必须够长才可能命中。
 *
 * per-run nonce 是必须的：前缀内容若每次运行都相同，第二次跑时「改写后的前缀」
 * 已经被上一次跑热了，第 3 步会命中缓存，得出与真相相反的结论。
 * 实测踩过一次 —— 首跑 cached=0（正确），复跑 cached=4224（被自己的历史污染）。
 * 本探针的结论是 §11.8 的承重证据，必须每次都从冷缓存开始。
 */
const RUN_NONCE = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const BULK = `[${RUN_NONCE}] ` + "以下是背景资料，请在回答时参考。".repeat(500);

/**
 * 改写前缀后的判据。
 *
 * 初版只判 `changed[0] === 0`（全量失效）与 `> 0`（未失效）两种。实测 DeepSeek 的
 * Anthropic 形状落在两者之间：基线稳定命中 4864，改写后**掉到 384** —— 而 384 恰好是
 * tools + system 这段没被改动的公共前缀（P4 独立测得同一个数）。
 *
 * 这是**部分失效**：改写点之后的缓存全丢，改写点之前的保留。二分判据会把它误报成
 * 「缓存不以严格前缀匹配为准」，恰好是相反的结论。§11.8 关心的正是这个量。
 */
function cacheVerdict(same: number[], changed: number[]): { kind: "gone" | "partial" | "kept"; text: string } {
  const baseline = same[0] ?? 0;
  const first = changed[0] ?? 0;
  if (first === 0) {
    return { kind: "gone", text: `改写前缀后**第一次**请求命中归零 —— 旧缓存全量失效，§11.8 成立` };
  }
  if (baseline > 0 && first < baseline * 0.5) {
    return {
      kind: "partial",
      text:
        `改写前缀后**第一次**请求从 ${baseline} 掉到 ${first} —— **部分失效**：` +
        `改写点之后的缓存全丢，改写点之前（tools + system 等公共前缀）保留。` +
        `§11.8 成立，且给出了它的精确形态：代价与「改写点有多靠前」成正比`,
    };
  }
  return {
    kind: "kept",
    text: `改写前缀后第一次仍命中 ${first} tokens（基线 ${baseline}）—— 缓存不以严格前缀匹配为准，§11.8 的张力假设在本实现上不成立`,
  };
}

/**
 * 「只改第一处」与「全量改写」两个条件合起来判定缓存的匹配方式。
 *
 * 前缀是同一句话重复 500 次，所以单看「只改第一处」区分不出严格前缀匹配和分块哈希匹配 ——
 * 后者下，第一块之后的各块逐字相同，仍会命中。这决定 §11.8 的代价模型完全不同：
 * 前缀匹配下 Compact 改写中部会作废其后全部；分块匹配下只作废被改的那几块。
 */
function matchingModeFinding(
  label: string,
  same: number[],
  changed: number[],
  changedAll: number[]
): string {
  const baseline = same[0] ?? 0;
  const one = changed[0] ?? 0;
  const all = changedAll[0] ?? 0;
  const dropped = (x: number) => baseline > 0 && x < baseline * 0.5;

  if (dropped(one)) {
    return `[${label}] 【匹配方式：严格前缀】只改第一处即从 ${baseline} 掉到 ${one}，全量改写为 ${all} —— Compact 改写中部会作废改写点之后的全部缓存`;
  }
  if (!dropped(one) && dropped(all)) {
    return (
      `[${label}] 【匹配方式：分块，非严格前缀】只改第一处仍命中 ${one}（基线 ${baseline}），` +
      `全量改写才掉到 ${all} —— 缓存按块匹配，改一处只作废那一块。` +
      `§11.8「Compact 破坏稳定前缀」在本实现上被削弱：代价与**改动量**成正比，而不是与改动位置成正比`
    );
  }
  return `[${label}] 【匹配方式未判定】基线 ${baseline}、只改第一处 ${one}、全量改写 ${all} —— 两种条件都未使命中显著下降，需另设计探针`;
}

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({ probe: "p5", provider: ANTHROPIC_PROVIDER_LABEL, model: ANTHROPIC_MODEL });

  const mkBody = (prefixText: string, tail: string) => ({
    model: ANTHROPIC_MODEL,
    max_tokens: 64,
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    tools: anthropicTools,
    messages: [
      {
        role: "user",
        content: [
          // 断点放在这条长前缀之后
          { type: "text", text: prefixText, cache_control: { type: "ephemeral" } },
          { type: "text", text: tail },
        ],
      },
    ],
  });

  const readUsage = (v: any) => ({
    input: v?.usage?.input_tokens,
    cacheCreate: v?.usage?.cache_creation_input_tokens,
    cacheRead: v?.usage?.cache_read_input_tokens,
  });

  // 与 OpenAI 路径同一方法论：多次采样看分布，且只有「改写后第一次请求」
  // 能回答问题（从第二次起命中的是新前缀自己的条目）。
  const SAMPLES = 4;

  async function sample(label: string, prefix: string): Promise<number[]> {
    const hits: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const body = mkBody(prefix, `问题${i}：简单回一句。`);
      const r = await rec.call(`${label} #${i}`, body, () => client.messages.create(body as any));
      if (r.ok) {
        const u = readUsage(r.value);
        hits.push(u.cacheRead ?? 0);
        rec.note(`${label} #${i} usage`, u);
      }
    }
    return hits;
  }

  rec.step("预热（不计入统计）");
  const bWarm = mkBody(BULK, "预热");
  await rec.call("warm-up", bWarm, () => client.messages.create(bWarm as any));

  rec.step("基线：前缀不变，只改断点之后的内容");
  const same = await sample("前缀不变", BULK);

  rec.step("【关键】改写断点之前的前缀 —— 模拟 Compact 重写中部");
  const changed = await sample("改写前缀", BULK.replace("背景资料", "背景材料"));

  // 前缀是同一句话重复 500 次，因此「只改第一处」无法区分两种缓存实现：
  //   严格前缀匹配 —— 第一处一变，其后全部作废；
  //   分块哈希匹配 —— 第一块作废，其后各块逐字相同，仍然命中。
  // 全量改写让两者产生可区分的观测：分块哈希下也必须归零。
  rec.step("对照：全量改写前缀（区分「严格前缀匹配」与「分块哈希匹配」）");
  const changedAll = await sample("全量改写前缀", BULK.replaceAll("背景资料", "背景材料"));
  rec.note("全量改写前缀的命中样本", changedAll);

  const nonZero = (xs: number[]) => xs.filter((x) => x > 0).length;
  rec.note("前缀不变的命中样本", same);
  rec.note("改写前缀的命中样本", changed);

  if (nonZero(same) !== SAMPLES) {
    rec.finding(
      `[${ANTHROPIC_PROVIDER_LABEL}] 【方法论不成立】基线命中不稳定，样本 ${same.join("/")} —— ` +
        `显式 cache_control 断点在本实现上未产生稳定命中，无法据此判断改写前缀的影响`
    );
    rec.unansweredItem(
      "该实现的显式 cache_control 断点是否真正生效 —— 基线不稳定，当前设计不足以定论"
    );
  } else {
    const v = cacheVerdict(same, changed);
    rec.finding(`[${ANTHROPIC_PROVIDER_LABEL}] 基线 ${SAMPLES}/${SAMPLES} 稳定命中（${same[0]} tokens）；${v.text}`);
    rec.finding(matchingModeFinding(ANTHROPIC_PROVIDER_LABEL, same, changed, changedAll));
  }

  rec.step("断点数量上限探测");
  const many = {
    model: ANTHROPIC_MODEL,
    max_tokens: 32,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: anthropicTools,
    messages: [
      {
        role: "user",
        content: Array.from({ length: 6 }, (_, i) => ({
          type: "text",
          text: `分段 ${i}：` + "填充".repeat(200),
          cache_control: { type: "ephemeral" },
        })),
      },
    ],
  };
  const rMany = await rec.call("6 个断点", many, () => client.messages.create(many as any));
  if (!DRY_RUN)
    rec.finding(
      rMany.ok
        ? "6 个断点被接受 —— 上限至少为 6"
        : `6 个断点被拒绝（status=${rMany.error?.status}）—— 错误体中通常写明上限，见日志`
    );

  rec.unansweredItem("缓存 TTL（需要间隔重跑才能测，本探针不覆盖）");

  await rec.close();
}

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({ probe: "p5", provider: OPENAI_PROVIDER_LABEL, model: OPENAI_MODEL });

  rec.step(`[${OPENAI_PROVIDER_LABEL}] 无显式断点参数，测自动前缀缓存（多次采样）`);
  const mk = (prefix: string, tail: string) => ({
    model: OPENAI_MODEL,
    max_completion_tokens: 64,
    tools: openaiChatTools,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prefix + "\n\n" + tail },
    ],
  });

  const readUsage = (v: any) => ({
    prompt: v?.usage?.prompt_tokens,
    cached: v?.usage?.prompt_tokens_details?.cached_tokens,
  });

  // 单次采样在抖动信号上会给出自信的错误答案（实测踩过：同一条件三次分别是
  // 4352 / 0 / 4352）。因此每个条件重复采样，比较分布而不是比较单点。
  const SAMPLES = 4;

  async function sample(label: string, prefix: string): Promise<number[]> {
    const hits: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const body = mk(prefix, `问题${i}`);
      const r = await rec.call(`${label} #${i}`, body, () =>
        client.chat.completions.create(body as any)
      );
      if (r.ok) {
        const u = readUsage(r.value);
        hits.push(u.cached ?? 0);
        rec.note(`${label} #${i} usage`, u);
      }
    }
    return hits;
  }

  await rec.call("warm-up（不计入统计）", mk(BULK, "预热"), () =>
    client.chat.completions.create(mk(BULK, "预热") as any)
  );

  const same = await sample("前缀不变", BULK);
  const modified = BULK.replace("背景资料", "背景材料");
  const changed = await sample("改写前缀", modified);

  // 见 anthropic() 中同名步骤的说明：区分严格前缀匹配与分块哈希匹配。
  const changedAll = await sample("全量改写前缀", BULK.replaceAll("背景资料", "背景材料"));
  rec.note("全量改写前缀的命中样本", changedAll);

  const nonZero = (xs: number[]) => xs.filter((x) => x > 0).length;

  rec.note("前缀不变的命中样本", same);
  rec.note("改写前缀的命中样本", changed);

  // 关键：只有「改写后的第一次请求」能回答问题。
  // 从第二次起，新前缀已经被它自己写进了缓存，后续命中的是新条目，
  // 与「旧缓存是否失效」无关。这是本探针第一版被自己误导的地方。
  const firstAfterChange = changed[0];
  const stableBaseline = nonZero(same) === SAMPLES;

  if (!stableBaseline) {
    rec.finding(
      `[${OPENAI_PROVIDER_LABEL}] 【方法论不成立】基线（前缀不变）命中不稳定，样本 ${same.join("/")} —— ` +
        `缓存在连续相同请求间就已非确定，无法据此判断改写前缀的影响`
    );
    rec.unansweredItem("改写前缀是否导致缓存失效 —— 基线不稳定，当前设计不足以定论");
  } else {
    const v = cacheVerdict(same, changed);
    rec.finding(
      `[${OPENAI_PROVIDER_LABEL}] 基线 ${SAMPLES}/${SAMPLES} 稳定命中（${same[0]} tokens）；${v.text}` +
        (v.kind === "gone"
          ? `（其后 ${nonZero(changed)}/${SAMPLES - 1} 次命中的是新前缀自己的条目，与本结论无关）`
          : "")
    );
    rec.finding(matchingModeFinding(OPENAI_PROVIDER_LABEL, same, changed, changedAll));
  }

  await rec.close();
}

await probe("P5", "缓存断点 —— Compact 重写前缀是否使缓存失效", async () => {
  await anthropic();
  await openai();
});
