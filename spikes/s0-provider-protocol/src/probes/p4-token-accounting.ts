/**
 * P4　Token 会计口径【应答】
 *
 * V03 :2383【验】：「estimated 的判定口径与 ModelProtocolPort.countTokens() 的
 * 误差范围需要 Spike 0 确认」。
 *
 * 最有价值的可能结论：如果预估与实际的误差大到不能支撑 soft/hard limit 判断，
 * §11.6 的整套阈值机制需要重新设计。
 *
 * 另一个必须单独量化的量：tool 定义本身的固定开销。它是每次请求的固定成本，
 * 直接影响 §16.1 的预算轴与 §11.6 的阈值取值。
 *
 * 喂给：§11.6 阈值精度、§16.1 BudgetUsage、ModelProtocolPort.countTokens()
 */

import { probe, openRecorder, requireKey, DRY_RUN, checkOutputBudget } from "../harness.js";
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
import { anthropicTools, openaiChatTools, fakeToolResult, SYSTEM_PROMPT } from "../tools.js";

const SHORT = "北京今天天气怎么样？";
const LONG = "请分析以下内容并总结要点。".repeat(400);

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({ probe: "p4", provider: ANTHROPIC_PROVIDER_LABEL, model: ANTHROPIC_MODEL });

  /** 对同一 payload 先预估、再实发，记录两者差值。 */
  async function compare(label: string, payload: any) {
    rec.step(label);

    const countBody = { model: ANTHROPIC_MODEL, ...payload };
    const est = await rec.call(`预估 · ${label}`, countBody, () =>
      (client as any).messages.countTokens(countBody)
    );

    const sendBody = { model: ANTHROPIC_MODEL, max_tokens: 64, ...payload };
    const act = await rec.call(`实发 · ${label}`, sendBody, () =>
      client.messages.create(sendBody as any)
    );

    if (est.ok && act.ok) {
      const e = (est.value as any).input_tokens;
      const usage = (act.value as any).usage ?? {};
      // 关键：Anthropic 形状的 usage.input_tokens **不含**命中缓存的部分。
      // 只比 input_tokens 会在缓存命中时得到荒唐的偏差（实测 DeepSeek 上 -600%），
      // 那是探针缺陷而不是预估失准。计费输入 = 未命中 + 命中读 + 写入。
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      const a = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
      const diff = a - e;
      const pct = a ? ((diff / a) * 100).toFixed(2) : "n/a";
      rec.note("预估 / 实际 / 差值 / 偏差%", {
        estimated: e,
        actual: a,
        diff,
        pct,
        uncached: usage.input_tokens ?? 0,
        cacheRead,
        cacheWrite,
      });
      rec.finding(`${label}：预估 ${e}，实际 ${a}（其中命中缓存 ${cacheRead}），差 ${diff}（${pct}%）`);
      return { e, a };
    }
    return null;
  }

  const noTools = await compare("纯文本，无 tool 定义", {
    messages: [{ role: "user", content: SHORT }],
  });

  const withTools = await compare("同样文本 + tool 定义", {
    tools: anthropicTools,
    messages: [{ role: "user", content: SHORT }],
  });

  if (noTools && withTools) {
    const overhead = withTools.a - noTools.a;
    rec.finding(
      `【tool 定义固定开销】${overhead} tokens（2 个简单工具）—— ` +
        `这是每次请求的固定成本，§16.1 的预算与 §11.6 的阈值必须扣除它`
    );
  }

  await compare("+ system prompt", {
    system: SYSTEM_PROMPT,
    tools: anthropicTools,
    messages: [{ role: "user", content: SHORT }],
  });

  await compare("+ 一轮完整的 tool_use / tool_result 往返", {
    system: SYSTEM_PROMPT,
    tools: anthropicTools,
    messages: [
      { role: "user", content: SHORT },
      {
        role: "assistant",
        // thinking 块是 P9 逼出来的：DeepSeek 拒绝只含 tool_use 的 assistant 回合
        // （400 `content[].thinking ... must be passed back`），而百炼两个形状都不要求。
        // 为了让两个平台测的是同一个 payload，这里统一带上它。
        content: [
          { type: "thinking", thinking: "需要查北京天气，调用 get_weather。", signature: "" },
          { type: "tool_use", id: "toolu_fixed_0001", name: "get_weather", input: { city: "北京" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_fixed_0001",
            content: fakeToolResult("get_weather", { city: "北京" }),
          },
        ],
      },
    ],
  });

  await compare("长文本（约 400 次重复）", {
    messages: [{ role: "user", content: LONG }],
  });

  rec.step("usage 字段的完整形态");
  const b = {
    model: ANTHROPIC_MODEL,
    max_tokens: 64,
    tools: anthropicTools,
    messages: [{ role: "user", content: SHORT }],
  };
  const r = await rec.call("取 usage", b, () => client.messages.create(b as any));
  if (r.ok) {
    const usage = (r.value as any).usage;
    rec.note("usage 全量字段", usage);
    rec.finding(`usage 字段：${Object.keys(usage ?? {}).join(", ")}`);
    rec.finding(
      "§19.3 ModelUsage 的字段映射见日志；缺失字段即 estimated=true 的判定依据"
    );
  }

  if (!DRY_RUN) {
    rec.note(
      "结论待人工填写",
      "把上面各行的偏差% 汇总，判断 countTokens() 能否支撑 soft/hard limit 判断"
    );
  }

  await rec.close();
}

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({ probe: "p4", provider: OPENAI_PROVIDER_LABEL, model: OPENAI_MODEL });

  rec.step("是否存在预估端点");
  const probeCount = await rec.call(
    "尝试 /tokenize 类端点",
    { note: "探测该实现是否提供 token 预估" },
    () => (client as any).get?.("/tokenize") ?? Promise.reject(new Error("SDK 无通用 GET 入口"))
  );
  rec.finding(
    probeCount.ok
      ? `[${OPENAI_PROVIDER_LABEL}] 存在预估端点，见日志`
      : `[${OPENAI_PROVIDER_LABEL}] 无可用的官方预估端点 —— ` +
          `ModelProtocolPort 在该实现上只能用本地 tokenizer 估算，误差必须单独量化`
  );
  rec.unansweredItem(
    "本地 tokenizer 的选型与误差量级（该实现无官方预估端点可对标）—— 需在阶段 1 补测"
  );

  rec.step("实际 usage 的字段形态与固定开销");
  const measured: Record<string, number> = {};
  for (const [label, payload] of [
    ["空请求（单字符）", { messages: [{ role: "user", content: "." }] }],
    ["纯文本", { messages: [{ role: "user", content: SHORT }] }],
    ["+ tool 定义", { messages: [{ role: "user", content: SHORT }], tools: openaiChatTools }],
    ["长文本", { messages: [{ role: "user", content: LONG }] }],
  ] as const) {
    const b = { model: OPENAI_MODEL, max_completion_tokens: 64, ...(payload as any) };
    const r = await rec.call(`实发 · ${label}`, b, () => client.chat.completions.create(b as any));
    if (r.ok) {
      const usage = (r.value as any).usage;
      rec.note(`usage · ${label}`, usage);
      measured[label] = usage?.prompt_tokens;
      checkOutputBudget(rec, r.value);
    }
  }

  if (measured["空请求（单字符）"] !== undefined) {
    // 措辞校正：约 10 个 token 是 chat 模板（role 标记、起止符）的正常开销，
    // 不是「端点注入了大量隐藏内容」。但它确实意味着客户端无法仅凭自己发出的
    // 文本精确复现 token 数 —— 除非同时知道该实现的模板。
    rec.finding(
      `【每请求固定底数】单字符请求计 ${measured["空请求（单字符）"]} prompt tokens —— ` +
        `chat 模板开销。本地估算必须叠加这个常量，且该常量随实现而变`
    );
  }
  if (measured["纯文本"] !== undefined && measured["+ tool 定义"] !== undefined) {
    rec.finding(
      `【tool 定义固定开销】${measured["+ tool 定义"] - measured["纯文本"]} tokens（2 个简单工具）`
    );
  }
  rec.finding("usage 字段形态已入日志 —— 用于 §19.3 的跨实现字段映射表");

  await rec.close();
}

await probe("P4", "Token 会计口径 —— 预估 vs 实际、tool 定义固定开销", async () => {
  await anthropic();
  await openai();
});
