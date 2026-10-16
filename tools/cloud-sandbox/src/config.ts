/**
 * 云沙箱池的配置（ADR-0016）。
 *
 * ── 【定】放 `.workagent-state/`，跨 workspace ──────────────────────────
 *
 * 与 `mcp.json` 同一个位置，但**理由不同**，别抄错：
 *   mcp.json 放那里是因为 MCP 进程绑 Atlas 会话、跨 Run 存活（登录态在浏览器里），
 *            切一次 workspace 等于关掉浏览器；
 *   这里放那里是因为它是**部署配置** —— 池子地址与调用方 Key 属于这台机器
 *            怎么接那个服务，与「正在做哪个项目」无关。
 *
 * ── 【定】配了连不上就**启动失败**，没配就当没有这个工具 ────────────────
 *
 * 照 ADR-0011：降级成「少几个工具」的失败形态特别难查 —— 同一句任务昨天
 * 能跑云沙箱今天不能，而 Run 照常跑到底，最后告诉你「我做不了那件事」。
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface CloudSandboxConfig {
  /** 池子的基地址，例如 http://127.0.0.1:8000 */
  baseUrl: string;
  /** 调用方 API Key（池子开了鉴权时必填）。**是凭证**，不进任何展示面。 */
  apiKey?: string;
  /** 借用等待上限（毫秒）。池子那边也有上限，取小。 */
  waitTimeoutMs: number;
  /** 普通 HTTP 请求超时（毫秒）。执行类请求另按命令超时放宽。 */
  requestTimeoutMs: number;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** 配置文件的默认位置（相对 `.workagent-state/`）。 */
export const CONFIG_FILENAME = "cloud-sandbox.json";

export class CloudSandboxConfigError extends Error {}

/**
 * 读配置。**文件不存在不是错误** —— 那表示这台机器没接池子，工具就不装。
 * 文件存在但内容不对**是**错误：一个被静默忽略的配置与一个生效的配置，
 * 在用户那里完全不可区分（M-5 那条教训的形态）。
 */
export function loadCloudSandboxConfig(path: string): CloudSandboxConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CloudSandboxConfigError(`读不了云沙箱配置 ${path}：${(e as Error).message}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new CloudSandboxConfigError(`云沙箱配置 ${path} 不是合法 JSON：${(e as Error).message}`);
  }
  return parseCloudSandboxConfig(obj, path);
}

export function parseCloudSandboxConfig(obj: unknown, source: string): CloudSandboxConfig {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new CloudSandboxConfigError(`云沙箱配置 ${source} 必须是一个对象`);
  }
  const o = obj as Record<string, unknown>;
  const known = new Set(["baseUrl", "apiKey", "waitTimeoutMs", "requestTimeoutMs"]);
  const unknownKeys = Object.keys(o).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    // 【定】未知键报错而不是忽略：拼错的键看起来生效了、实际什么都没变
    throw new CloudSandboxConfigError(
      `云沙箱配置 ${source} 有不认识的字段：${unknownKeys.join("、")}。合法字段只有 ${[...known].join("、")}`,
    );
  }
  const baseUrl = typeof o.baseUrl === "string" ? o.baseUrl.trim().replace(/\/+$/, "") : "";
  if (!baseUrl) throw new CloudSandboxConfigError(`云沙箱配置 ${source} 缺少 baseUrl`);
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new CloudSandboxConfigError(`云沙箱配置 ${source} 的 baseUrl 必须以 http:// 或 https:// 开头`);
  }
  if (o.apiKey !== undefined && typeof o.apiKey !== "string") {
    throw new CloudSandboxConfigError(`云沙箱配置 ${source} 的 apiKey 必须是字符串`);
  }
  return {
    baseUrl,
    ...(typeof o.apiKey === "string" && o.apiKey ? { apiKey: o.apiKey } : {}),
    waitTimeoutMs: positive(o.waitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS, "waitTimeoutMs", source),
    requestTimeoutMs: positive(o.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs", source),
  };
}

function positive(v: unknown, dflt: number, name: string, source: string): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
    throw new CloudSandboxConfigError(`云沙箱配置 ${source} 的 ${name} 必须是正整数毫秒数`);
  }
  return v;
}

/** `.workagent-state/cloud-sandbox.json` 的绝对路径。 */
export function defaultConfigPath(stateDir: string): string {
  return isAbsolute(stateDir) ? resolve(stateDir, CONFIG_FILENAME) : resolve(process.cwd(), stateDir, CONFIG_FILENAME);
}
