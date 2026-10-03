/**
 * Spike 1 的配置来源：**根 `.env`**（用户指定：以它配置的模型为准）。
 *
 * override: true 与 compose.ts 同一条理由：shell 里 export 过的同名变量不得存活
 * （本会话的环境里就有 ANTHROPIC_BASE_URL）。我们另外把 baseURL / apiKey / authToken
 * 全部显式传给 SDK，三者都不从环境变量隐式读取。
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SPIKE_ROOT = resolve(HERE, "..");
export const REPO_ROOT = resolve(SPIKE_ROOT, "../..");

loadDotenv({ path: resolve(REPO_ROOT, ".env"), quiet: true, override: true });

export type EndpointName = "deepseek" | "bailian";

export interface EndpointConfig {
  name: EndpointName;
  baseURL: string;
  apiKey: string;
  model: string;
  host: string;
}

const SPECS: Record<
  EndpointName,
  { urlKey: string; keyKey: string; modelKey: string; hostSuffix: string }
> = {
  deepseek: {
    urlKey: "deepseek_base_url_Anthropic",
    keyKey: "deepseek_api_key",
    modelKey: "deepseek_model",
    hostSuffix: "api.deepseek.com",
  },
  bailian: {
    urlKey: "dashscope_base_url_Anthropic",
    keyKey: "dashscope_api_key",
    modelKey: "dashscope_model",
    hostSuffix: "maas.aliyuncs.com",
  },
};

/**
 * 凭证去向断言：Key 只能发往它自己那家的主机。与 Atlas 的 credential-guard 同一条纪律 ——
 * 与其依赖配置正确，不如在发出前断言一次。
 */
export function endpoint(name: EndpointName): EndpointConfig {
  const spec = SPECS[name];
  const baseURL = process.env[spec.urlKey] ?? "";
  const apiKey = process.env[spec.keyKey] ?? "";
  const model = process.env[spec.modelKey] ?? "";
  if (!baseURL || !apiKey || !model) {
    throw new Error(`根 .env 缺少 ${spec.urlKey} / ${spec.keyKey} / ${spec.modelKey}`);
  }
  const host = new URL(baseURL).host;
  if (host !== spec.hostSuffix && !host.endsWith(`.${spec.hostSuffix}`)) {
    throw new Error(
      `拒绝执行：${name} 的 baseURL 主机 ${host} 不属于 ${spec.hostSuffix}，凭证不得发往那里。`,
    );
  }
  return { name, baseURL, apiKey, model, host };
}

export function endpointsFromArgs(argv: string[]): EndpointName[] {
  const i = argv.indexOf("--endpoint");
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (raw === undefined) return ["deepseek", "bailian"];
  if (raw !== "deepseek" && raw !== "bailian") {
    throw new Error(`--endpoint 只能是 deepseek 或 bailian，收到：${raw}`);
  }
  return [raw];
}
