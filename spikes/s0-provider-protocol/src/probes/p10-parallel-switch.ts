/**
 * P10　强制单条开关的可靠性【计划外，第三轮加测】
 *
 * 起因：P1 在两个平台上给出相反的单次观测 ——
 *   百炼 OpenAI 形状：`parallel_tool_calls:false` → 返回 1 个；
 *   DeepSeek OpenAI 形状：同一参数 → 仍返回 4 个。
 *
 * D-01（v0.1 是否强制串行）直接依赖这一条。而本 Spike 已经栽过一次：
 * 在会抖动的信号上单次采样会给出自信的错误答案（见 Facts §6 更正说明）。
 * 「返回几个 tool call」是模型采样的结果，天然可能抖动，因此必须多次采样。
 *
 * 喂给：§30 D-01、§8.6 不变量 1
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

const PROMPT = "同时查一下北京和上海的天气和当前时间，四项都要。";
const SAMPLES = 3;

/** 把 n 次采样压成一句可判定的结论。 */
function verdict(label: string, param: string, off: number[], on: number[]): string {
  const allOne = off.length > 0 && off.every((n) => n === 1);
  const anyMulti = off.some((n) => n > 1);
  if (allOne) {
    return `[${label}] 【${param} 生效】关开样本 ${off.join("/")}，参数缺省样本 ${on.join("/")} —— ${SAMPLES}/${SAMPLES} 次都被压到 1 个，D-01 可以拿到协议层保障`;
  }
  if (anyMulti && off.every((n) => n > 1)) {
    return `[${label}] 【${param} 完全无效】关开样本 ${off.join("/")}，参数缺省样本 ${on.join("/")} —— 参数被接受但一次也没生效，D-01 只能靠 Runtime 自持`;
  }
  return `[${label}] 【${param} 不稳定】关开样本 ${off.join("/")}，参数缺省样本 ${on.join("/")} —— 时而生效时而不生效，比「完全无效」更危险：不能作为保障，也不能假设它无害`;
}

async function anthropic() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({
    probe: "p10",
    provider: ANTHROPIC_PROVIDER_LABEL,
    model: ANTHROPIC_MODEL,
    params: { samples: SAMPLES },
  });

  async function sample(label: string, toolChoice?: any): Promise<number[]> {
    const counts: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const body: any = {
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: anthropicTools,
        messages: [{ role: "user", content: PROMPT }],
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      };
      const r = await rec.call(`${label} #${i}`, body, () => client.messages.create(body));
      if (r.ok) {
        const n = ((r.value as any).content ?? []).filter((b: any) => b.type === "tool_use").length;
        counts.push(n);
        rec.note(`${label} #${i} tool_use 数`, n);
      }
    }
    return counts;
  }

  rec.step("参数缺省（基线）");
  const on = await sample("基线");
  rec.step("disable_parallel_tool_use: true");
  const off = await sample("关并行", { type: "auto", disable_parallel_tool_use: true });

  if (!DRY_RUN) rec.finding(verdict(ANTHROPIC_PROVIDER_LABEL, "disable_parallel_tool_use", off, on));
  await rec.close();
}

async function openai() {
  if (!requireKey(OPENAI_API_KEY_NAME)) return;
  const client = openaiClient();
  const rec = openRecorder({
    probe: "p10",
    provider: OPENAI_PROVIDER_LABEL,
    model: OPENAI_MODEL,
    params: { samples: SAMPLES },
  });

  async function sample(label: string, parallel?: boolean): Promise<number[]> {
    const counts: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const body: any = {
        model: OPENAI_MODEL,
        max_completion_tokens: 1024,
        tools: openaiChatTools,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: PROMPT },
        ],
        ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }),
      };
      const r = await rec.call(`${label} #${i}`, body, () => client.chat.completions.create(body));
      if (r.ok) {
        const n = ((r.value as any).choices?.[0]?.message?.tool_calls ?? []).length;
        counts.push(n);
        rec.note(`${label} #${i} tool_calls 数`, n);
      }
    }
    return counts;
  }

  rec.step("参数缺省（基线）");
  const on = await sample("基线");
  rec.step("parallel_tool_calls: false");
  const off = await sample("关并行", false);

  if (!DRY_RUN) rec.finding(verdict(OPENAI_PROVIDER_LABEL, "parallel_tool_calls:false", off, on));
  await rec.close();
}

await probe("P10", `强制单条开关的可靠性（每档 ${SAMPLES} 次采样）`, async () => {
  await anthropic();
  await openai();
});
