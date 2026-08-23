/**
 * P7　上下文超限【应答】
 *
 * 决定 §11.6 的 COMPACTION_INSUFFICIENT 能否**提前判定**。
 * 这是 D-05 候选 A（先做更激进的 Compact）是否有执行机会的前提：
 * 如果只能发出去才知道超限，那 Kernel 拿到的永远是「已经失败」，
 * 而不是「即将超限」，D-05 的候选 A 就没有触发点。
 *
 * 用便宜模型，控制花费。
 *
 * 喂给：§11.6 COMPACTION_INSUFFICIENT、§10.1 CONTEXT_EXHAUSTED、D-05
 */

import { probe, openRecorder, requireKey, DRY_RUN, checkOutputBudget } from "../harness.js";
import {
  anthropicClient,
  ANTHROPIC_CHEAP_MODEL,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_API_KEY_NAME,
} from "../clients/anthropic.js";
import {
  openaiClient,
  OPENAI_CHEAP_MODEL,
  OPENAI_PROVIDER_LABEL,
  OPENAI_API_KEY_NAME,
} from "../clients/openai.js";

/**
 * 目标：稳超常见模型窗口。单位是「重复次数」，不是 token。
 * 实测口径（qwen3.7-plus）：约 1.85 字符/token，故 200k 次重复 ≈ 120 万字符 ≈ 65 万 token。
 */
const HUGE_REPEATS = 200_000;
const HUGE = "上下文填充。".repeat(HUGE_REPEATS);

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({
    probe: "p7",
    provider: ANTHROPIC_PROVIDER_LABEL,
    model: ANTHROPIC_CHEAP_MODEL,
    params: { hugeRepeats: HUGE_REPEATS, hugeChars: HUGE.length },
  });

  rec.step("能否在发送前判定超限（countTokens 对超窗 payload 的反应）");
  const countBody = { model: ANTHROPIC_CHEAP_MODEL, messages: [{ role: "user", content: HUGE }] };
  const est = await rec.call("预估超窗 payload", countBody, () =>
    (client as any).messages.countTokens(countBody)
  );
  if (est.ok) {
    rec.note("预估结果", est.value);
    rec.finding(
      `countTokens 对超窗 payload 正常返回 ${(est.value as any).input_tokens} tokens —— ` +
        `**可以提前判定**，§11.6 的 COMPACTION_INSUFFICIENT 有触发点，D-05 候选 A 可行`
    );
  } else if (!DRY_RUN) {
    rec.finding(
      `countTokens 对超窗 payload 也报错（status=${est.error?.status}）—— ` +
        `无法用它提前判定，只能靠本地估算或直接发送`
    );
  }

  rec.step("实际发送超窗请求，观察错误形态");
  const sendBody = {
    model: ANTHROPIC_CHEAP_MODEL,
    max_tokens: 32,
    messages: [{ role: "user", content: HUGE }],
  };
  const r = await rec.call("发送超窗请求", sendBody, () => client.messages.create(sendBody as any));
  if (!DRY_RUN) {
    if (r.ok) {
      rec.finding("【意外】超窗请求被接受 —— HUGE_REPEATS 不够大，调大后重跑");
    } else {
      rec.note("超窗错误三要素", {
        errorClass: r.error?.__errorClass,
        status: r.error?.status,
        message: String(r.error?.message).slice(0, 400),
      });
      const msg = String(r.error?.message ?? "");
      const hasNumbers = /\d{4,}/.test(msg);
      rec.finding(
        hasNumbers
          ? "超窗错误消息中含具体 token 数 —— 可用于校准本地估算"
          : "超窗错误消息中不含具体 token 数 —— 只能知道超了，不知道超多少"
      );
    }
  }

  await rec.close();
}

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({
    probe: "p7",
    provider: OPENAI_PROVIDER_LABEL,
    model: OPENAI_CHEAP_MODEL,
    params: { hugeRepeats: HUGE_REPEATS },
  });

  rec.step("发送超窗请求，观察错误形态");
  const body = {
    model: OPENAI_CHEAP_MODEL,
    max_completion_tokens: 32,
    messages: [{ role: "user", content: HUGE }],
  };
  const r = await rec.call("发送超窗请求", body, () => client.chat.completions.create(body as any));
  if (!DRY_RUN) {
    if (r.ok) {
      // M-3 修正：「被接受」不是探针失败，而是一个关于窗口大小的确定事实。
      // 之前的文案写成「调大后重跑」，把正面结果引向了返工。
      const usage = (r.value as any).usage ?? {};
      const actual = usage.prompt_tokens ?? 0;
      const estimated = Math.round(HUGE.length / 1.85);
      const truncated = actual < estimated * 0.5;

      rec.note("送出字符数 / 估算 token / 实际计费 token", {
        chars: HUGE.length,
        estimated,
        actual,
        finishReason: (r.value as any).choices?.[0]?.finish_reason,
      });

      if (truncated) {
        rec.finding(
          `【严重】实际计费 ${actual} tokens，远低于估算 ${estimated} —— ` +
            `端点疑似**静默截断**上下文。这比报错危险得多：模型看到的是残缺输入，` +
            `而 Runtime 完全无从察觉，§11.6 的 COMPACTION_INSUFFICIENT 永远不会触发`
        );
      } else {
        rec.finding(
          `[${OPENAI_PROVIDER_LABEL}] 接受了 ${actual} prompt tokens 且未静默截断 —— ` +
            `本模型上下文窗口 ≥ ${actual}。结合「无预检端点」，` +
            `§11.6 的超限判定只能靠 Runtime 本地估算，D-05 候选 A 缺少可靠触发点`
        );
      }
      checkOutputBudget(rec, r.value);
    } else {
      rec.note("超窗错误三要素", {
        errorClass: r.error?.__errorClass,
        status: r.error?.status,
        code: (r.error?.error as any)?.code,
        message: String(r.error?.message).slice(0, 400),
      });
      rec.finding(
        "OpenAI 超窗错误已入日志 —— 与 Anthropic 对照，判断「超窗」能否成为一个跨家可识别的 category"
      );
    }
  }

  rec.unansweredItem("接近但未超限时输出是否被截断（需要精确逼近窗口边界，本探针不覆盖）");

  await rec.close();
}

await probe("P7", "上下文超限 —— 能否提前判定、错误是否含 token 数", async () => {
  await anthropic();
  await openai();
});
