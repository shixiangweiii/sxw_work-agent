/**
 * P6　错误分类【应答】
 *
 * 目标：判断 §13.1 的 RuntimeErrorRecord 能否从 Provider 错误可靠映射出
 * (source, category, retryability) 三元组。
 *
 * 一个必须确认的分辨：模型返回的 tool 入参不符合 schema 时，Provider 大概率
 * 不会报错 —— 那是 Runtime 侧校验的职责。确认这一点本身就是发现，
 * 它决定 §13.1 中 TOOL_INPUT 与 MODEL_PROVIDER 两个 source 的边界。
 *
 * 喂给：§13.1 错误分类、§13.2 ErrorDisposition
 */

import { probe, openRecorder, requireKey, DRY_RUN } from "../harness.js";
import {
  anthropicClient,
  ANTHROPIC_MODEL,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_API_KEY_NAME,
  ANTHROPIC_BASE_URL,
} from "../clients/anthropic.js";
import {
  openaiClient,
  OPENAI_MODEL,
  OPENAI_PROVIDER_LABEL,
  OPENAI_API_KEY_NAME,
  OPENAI_BASE_URL,
} from "../clients/openai.js";
import { anthropicTools, openaiChatTools, SYSTEM_PROMPT } from "../tools.js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({ probe: "p6", provider: ANTHROPIC_PROVIDER_LABEL, model: ANTHROPIC_MODEL });

  // 与 OpenAI 路径同样的 C-4 修正：body 必须是真实发出的请求体，不是占位备注。
  const invalidKeyClient = new Anthropic({
    apiKey: "sk-ant-invalid-key-for-probe",
    baseURL: ANTHROPIC_BASE_URL, // 必须打到同一端点，否则测的是别人家的鉴权
    maxRetries: 0,
  });

  const bodyInvalidModel = {
    model: "definitely-not-a-real-model-9999",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  };
  const bodyAuth = { model: ANTHROPIC_MODEL, max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
  const bodyBadToolSchema = {
    model: ANTHROPIC_MODEL,
    max_tokens: 16,
    tools: [{ name: "bad_tool", description: "x", input_schema: { properties: "not-an-object" } }],
    messages: [{ role: "user", content: "hi" }],
  };
  const bodyMissingMaxTokens = { model: ANTHROPIC_MODEL, messages: [{ role: "user", content: "hi" }] };
  const bodyHugeMaxTokens = {
    model: ANTHROPIC_MODEL,
    max_tokens: 99_999_999,
    messages: [{ role: "user", content: "hi" }],
  };

  const cases: Array<[string, any, () => Promise<any>, string?]> = [
    ["无效模型名", bodyInvalidModel, () => client.messages.create(bodyInvalidModel as any)],
    [
      "认证失败",
      bodyAuth,
      () => invalidKeyClient.messages.create(bodyAuth as any),
      "使用无效 apiKey，端点相同",
    ],
    [
      "tool 定义 schema 非法",
      bodyBadToolSchema,
      () => client.messages.create(bodyBadToolSchema as any),
      "input_schema.properties 为字符串，不是合法 JSON Schema",
    ],
    [
      "请求体格式错误（max_tokens 缺失）",
      bodyMissingMaxTokens,
      () => client.messages.create(bodyMissingMaxTokens as any),
    ],
    ["max_tokens 超模型上限", bodyHugeMaxTokens, () => client.messages.create(bodyHugeMaxTokens as any)],
  ];

  for (const [label, body, fn, hint] of cases) {
    rec.step(hint ? `${label}（${hint}）` : label);
    const r = await rec.call(label, body, fn);
    if (DRY_RUN) continue;

    // C-3 修正：对称处理「意外成功」
    if (r.ok) {
      rec.finding(
        `【意外成功】${label} 未报错 —— 该实现不校验此项，` +
          `对应的错误在 §13.1 中永远不会以 source=MODEL_PROVIDER 出现`
      );
    } else {
      rec.note(`${label} 错误三要素`, {
        errorClass: r.error?.__errorClass,
        status: r.error?.status,
        type: (r.error?.error as any)?.type ?? r.error?.type,
      });
    }
  }
  rec.finding(
    `[${ANTHROPIC_PROVIDER_LABEL}] 错误体已全量入日志 —— ` +
      `供填写 §13.1 的 (source, category, retryability) 映射表`
  );

  // ---------------------------------------------- 关键分辨：入参不合 schema 谁报错
  rec.step("【关键分辨】模型返回的 tool 入参不合 schema 时，Provider 报错还是放行？");
  const b = {
    model: ANTHROPIC_MODEL,
    max_tokens: 512,
    system: "无论用户问什么，都调用 get_weather，但故意把参数名写成 cityName 而不是 city。",
    tools: anthropicTools,
    messages: [{ role: "user", content: "查一下北京天气" }],
  };
  const r = await rec.call("诱导模型产生不合 schema 的入参", b, () => client.messages.create(b as any));
  if (r.ok) {
    const tu = ((r.value as any).content ?? []).filter((x: any) => x.type === "tool_use");
    rec.note("模型实际产生的入参", tu.map((t: any) => t.input));
    const conformant = tu.every((t: any) => "city" in (t.input ?? {}));
    rec.finding(
      conformant
        ? "Provider 侧对入参做了约束（模型未能产出不合 schema 的入参）—— 需换更强的诱导手段再确认"
        : "【关键】Provider 放行了不合 schema 的入参 —— 入参校验完全是 Runtime 的责任，" +
            "§13.1 中这类错误的 source 应为 TOOL_INPUT 而非 MODEL_PROVIDER"
    );
  }

  rec.unansweredItem("429 rate limit 的错误体（难以主动触发，允许未解答）");

  await rec.close();
}

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({ probe: "p6", provider: OPENAI_PROVIDER_LABEL, model: OPENAI_MODEL });

  // C-4 修正：body 必须是**真实发出的请求体**，而不是一句备注。
  // 之前用 { note: "…" } 占位，导致 raw 里的 request 记录无法复现实际请求，
  // 违反 harness 自己的契约（「把完整请求体写进 raw」）。
  const invalidKeyClient = new OpenAI({
    apiKey: "sk-invalid-key-for-probe",
    baseURL: OPENAI_BASE_URL, // 必须打到同一端点，否则测的是别人家的鉴权
    maxRetries: 0,
  });

  const bodyInvalidModel = {
    model: "definitely-not-a-real-model-9999",
    messages: [{ role: "user", content: "hi" }],
  };
  const bodyAuth = { model: OPENAI_MODEL, messages: [{ role: "user", content: "hi" }] };
  const bodyBadToolSchema = {
    model: OPENAI_MODEL,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "bad", parameters: { type: "not-a-type" } } }],
  };
  const bodyMissingMessages = { model: OPENAI_MODEL };

  const cases: Array<[string, any, () => Promise<any>, string?]> = [
    ["无效模型名", bodyInvalidModel, () => client.chat.completions.create(bodyInvalidModel as any)],
    [
      "认证失败",
      bodyAuth,
      () => invalidKeyClient.chat.completions.create(bodyAuth as any),
      "使用无效 apiKey，端点相同",
    ],
    [
      "tool 定义 schema 非法",
      bodyBadToolSchema,
      () => client.chat.completions.create(bodyBadToolSchema as any),
      "parameters.type 为 not-a-type，不是合法 JSON Schema",
    ],
    [
      "请求体格式错误（messages 缺失）",
      bodyMissingMessages,
      () => client.chat.completions.create(bodyMissingMessages as any),
    ],
  ];

  for (const [label, body, fn, hint] of cases) {
    rec.step(hint ? `${label}（${hint}）` : label);
    const r = await rec.call(label, body, fn);
    if (DRY_RUN) continue;

    // C-3 修正：两条路径必须对称处理「意外成功」。
    // 之前只在 !r.ok 时记录，导致「非法 tool schema 被 200 接受」这一发现
    // 在 findings 里完全不出现，只能靠人工翻 raw 日志才能捞到。
    if (r.ok) {
      rec.finding(
        `【意外成功】${label} 未报错 —— 该实现不校验此项，` +
          `对应的错误在 §13.1 中永远不会以 source=MODEL_PROVIDER 出现`
      );
    } else {
      rec.note(`${label} 错误三要素`, {
        errorClass: r.error?.__errorClass,
        status: r.error?.status,
        type: (r.error?.error as any)?.type ?? r.error?.type,
        code: (r.error?.error as any)?.code ?? r.error?.code,
      });
    }
  }
  rec.finding(
    `[${OPENAI_PROVIDER_LABEL}] 错误体已全量入日志 —— ` +
      `供填写 §13.1 的 (source, category, retryability) 映射表`
  );

  await rec.close();
}

await probe("P6", "错误分类 —— 能否可靠映射到 (source, category, retryability)", async () => {
  await anthropic();
  await openai();
});
