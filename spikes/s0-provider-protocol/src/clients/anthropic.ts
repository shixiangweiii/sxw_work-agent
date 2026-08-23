import Anthropic from "@anthropic-ai/sdk";

/**
 * 「Anthropic 形状」阵营的客户端。
 *
 * 与 clients/openai.ts 同理：官方与第三方兼容实现被视为同一形状的不同实现。
 * 日志里的 provider 标签必须如实反映实际端点。
 *
 * 本 Spike 的关键实验设计：让本文件与 openai.ts 指向**同一平台、同一模型、
 * 同一个 Key**，只有 API 形状不同 —— 这样任何行为差异都只能归因于协议形状，
 * 而不是模型能力或供应商实现。这是回答「ModelProtocolPort 要吸收哪一类差异」
 * 的最干净实验（V03 §30 D-07 重述后）。
 */

function pick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

export const ANTHROPIC_BASE_URL = pick("ANTHROPIC_BASE_URL", "LLM_ANTHROPIC_BASE_URL");

export const ANTHROPIC_API_KEY_NAME = pick("ANTHROPIC_API_KEY")
  ? "ANTHROPIC_API_KEY"
  : pick("DASHSCOPE_API_KEY")
    ? "DASHSCOPE_API_KEY"
    : "ANTHROPIC_API_KEY";

export const ANTHROPIC_PROVIDER_LABEL =
  process.env.ANTHROPIC_PROVIDER_LABEL ||
  (!ANTHROPIC_BASE_URL
    ? "anthropic"
    : /aliyuncs|dashscope/i.test(ANTHROPIC_BASE_URL)
      ? "bailian-anthropic-shape"
      : "anthropic-compatible");

export function anthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: pick("ANTHROPIC_API_KEY", "DASHSCOPE_API_KEY") ?? "dry-run-placeholder",
    baseURL: ANTHROPIC_BASE_URL, // undefined 时走官方默认
    maxRetries: 0, // Spike 要观测原始错误，不要 SDK 悄悄重试
  });
}

export const ANTHROPIC_MODEL =
  pick("ANTHROPIC_MODEL", "LLM_MODEL") || "claude-sonnet-5";

export const ANTHROPIC_CHEAP_MODEL =
  pick("ANTHROPIC_CHEAP_MODEL", "LLM_CHEAP_MODEL") || ANTHROPIC_MODEL;

export const ANTHROPIC_THINKING_MODEL =
  pick("ANTHROPIC_THINKING_MODEL", "LLM_REASONING_MODEL") || ANTHROPIC_MODEL;
