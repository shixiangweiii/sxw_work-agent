import OpenAI from "openai";

/**
 * 「OpenAI 兼容」阵营的客户端。
 *
 * 注意：本 Spike 把 OpenAI 官方与第三方兼容实现（阿里云百炼 / DashScope 等）
 * 视为同一阵营的不同实现来测。这本身就是一个待验证的假设 ——
 * 「兼容」到底是真契约还是营销词，直接决定 ModelProtocolPort 的抽象边界（D-07）。
 *
 * 因此日志里的 provider 标签必须如实反映实际端点，不能一律写 "openai"。
 */

/** 兼容多种命名：OPENAI_* 优先，其次 LLM_*，再次 DASHSCOPE_*。 */
function pick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

export const OPENAI_BASE_URL = pick("OPENAI_BASE_URL", "LLM_BASE_URL");

export const OPENAI_API_KEY_NAME = pick("OPENAI_API_KEY")
  ? "OPENAI_API_KEY"
  : pick("DASHSCOPE_API_KEY")
    ? "DASHSCOPE_API_KEY"
    : "OPENAI_API_KEY";

/**
 * 日志与文件名里的 provider 标签。
 * 默认按 base URL 推断，可用 OPENAI_PROVIDER_LABEL 覆盖。
 */
export const OPENAI_PROVIDER_LABEL =
  process.env.OPENAI_PROVIDER_LABEL ||
  (!OPENAI_BASE_URL
    ? "openai"
    : /aliyuncs|dashscope/i.test(OPENAI_BASE_URL)
      ? "dashscope"
      : "openai-compatible");

export function openaiClient(): OpenAI {
  return new OpenAI({
    apiKey: pick("OPENAI_API_KEY", "DASHSCOPE_API_KEY") ?? "dry-run-placeholder",
    baseURL: OPENAI_BASE_URL, // undefined 时走官方默认
    maxRetries: 0, // Spike 要观测原始错误，不要 SDK 悄悄重试
  });
}

export const OPENAI_MODEL = pick("OPENAI_MODEL", "LLM_MODEL") || "gpt-5";

export const OPENAI_CHEAP_MODEL =
  pick("OPENAI_CHEAP_MODEL", "LLM_CHEAP_MODEL") || OPENAI_MODEL;

export const OPENAI_REASONING_MODEL =
  pick("OPENAI_REASONING_MODEL", "LLM_REASONING_MODEL") || OPENAI_MODEL;
