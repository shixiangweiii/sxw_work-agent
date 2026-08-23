/**
 * Spike 0 探针框架。
 *
 * 刻意粗糙：只做三件事 —— 发请求、把完整请求/响应写进 raw/*.jsonl、打印一行结论。
 * 不做抽象、不做重试、不做错误恢复。这些代码 Spike 结束后丢弃。
 *
 * 硬性要求（来自实施计划）：
 *   1. API Key 永不落盘 —— 写盘前 scrub；
 *   2. 每个 raw 文件首行是 meta（SDK 版本 / 模型 ID / 日期 / 探针参数）；
 *      事实会过期，没有版本号的证据等于没有证据；
 *   3. 异常必须记录进同一个 jsonl，而不是抛出中断探针。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "raw");

// override: true 是刻意的。本 Spike 的 .env 是唯一配置源。
//
// 踩过的坑：shell 里预先 export 了 ANTHROPIC_BASE_URL=https://api.anthropic.com，
// 而 dotenv 默认不覆盖已有环境变量 —— 结果是把百炼的 Key 发往了官方端点。
// 请求被 401 拒绝，但凭证确实离开了预期边界。
// 对探针这类「配置即实验条件」的场景，环境变量泄漏进来是纯粹的危害。
// SPIKE_ENV_FILE 允许一次运行里切换 provider（`.env.deepseek` / `.env.dashscope`），
// 不必来回覆盖 .env —— 跨 provider 对照跑必须能原样复现。
const ENV_FILE = process.env.SPIKE_ENV_FILE
  ? path.resolve(ROOT, process.env.SPIKE_ENV_FILE)
  : path.join(ROOT, ".env");
dotenv.config({ path: ENV_FILE, quiet: true, override: true });

export const DRY_RUN =
  process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

/**
 * 凭证去向防护。
 *
 * 真实踩过的坑：shell 里预先 export 的 ANTHROPIC_BASE_URL 覆盖了 .env 的意图，
 * 把百炼的 Key 发往了 api.anthropic.com。请求被 401 拒绝，但凭证已经离开预期边界。
 *
 * 这是探针版的「§22 数据边界」：凭证只能去它该去的地方。
 * 与其依赖配置正确，不如在发出前断言一次。
 */
function assertKeyGoesWhereIntended(): void {
  if (DRY_RUN) return;
  const officialHosts = [/(^|\.)api\.anthropic\.com$/i, /(^|\.)api\.openai\.com$/i];
  const checks: Array<[string, string | undefined, string | undefined]> = [
    ["Anthropic 形状", process.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_API_KEY],
    ["OpenAI 形状", process.env.OPENAI_BASE_URL, process.env.OPENAI_API_KEY],
  ];
  const thirdPartyKey = process.env.DASHSCOPE_API_KEY;
  if (!thirdPartyKey) return;

  for (const [shape, baseUrl, ownKey] of checks) {
    if (ownKey) continue; // 该形状有自己的官方 Key，走官方端点是正常的
    let host: string;
    try {
      host = baseUrl ? new URL(baseUrl).host : shape.includes("Anthropic") ? "api.anthropic.com" : "api.openai.com";
    } catch {
      continue;
    }
    if (officialHosts.some((re) => re.test(host))) {
      console.error(
        `\n拒绝执行：${shape} 的 baseURL 指向官方端点 ${host}，` +
          `但当前只有第三方 Key（DASHSCOPE_API_KEY）。\n` +
          `这会把凭证发往非预期的服务。请在 .env 中用规范名设置 baseURL：\n` +
          `  ANTHROPIC_BASE_URL / OPENAI_BASE_URL\n` +
          `（注意 shell 里已 export 的同名变量会与 .env 冲突，用规范名才能被覆盖）\n`
      );
      process.exit(1);
    }
  }
}
assertKeyGoesWhereIntended();

/** 单个字符串字段写盘时的上限。超出记录原长度并截断，避免 P8 的 1MB 载荷撑爆日志。 */
const MAX_STRING_LEN = 20_000;

const SECRET_KEY_PATTERN =
  /^(api[-_]?key|authorization|x-api-key|secret|access[-_]?token|bearer)$/i;

// ---------------------------------------------------------------- scrub

/** 深拷贝并剥除疑似凭证的字段；同时截断超长字符串。 */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 40) return "[max-depth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.length > MAX_STRING_LEN) {
      return `[truncated ${value.length} chars] ${value.slice(0, MAX_STRING_LEN)}`;
    }
    // 兜底：即使字段名没命中，值看起来像 key 也剥掉
    if (/^(sk-|sk-ant-)/.test(value)) return "[REDACTED]";
    return value;
  }

  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  // Error 对象不可枚举字段较多，单独处理
  if (value instanceof Error) return serializeError(value);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : scrub(v, depth + 1);
  }
  return out;
}

/** 把任意抛出物摊平成可诊断的结构 —— 这本身就是 P6 的观测对象。 */
export function serializeError(err: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    __errorClass: err?.constructor?.name ?? typeof err,
    message: err?.message ?? String(err),
  };
  // SDK 通常把 HTTP 细节挂在这些字段上；全都捞出来，不预设形状
  for (const k of ["status", "type", "code", "param", "requestID", "request_id", "error", "headers"]) {
    if (err && err[k] !== undefined) out[k] = scrub(err[k]);
  }
  if (err?.stack) out.stackFirstLine = String(err.stack).split("\n")[1]?.trim();
  return out;
}

// ---------------------------------------------------------------- versions

const require_ = createRequire(import.meta.url);

function sdkVersion(pkg: string): string {
  for (const candidate of [`${pkg}/package.json`, pkg]) {
    try {
      const resolved = require_.resolve(candidate);
      // 从解析路径向上找 package.json
      let dir = candidate.endsWith("package.json") ? null : path.dirname(resolved);
      if (candidate.endsWith("package.json")) {
        return JSON.parse(fs.readFileSync(resolved, "utf8")).version ?? "unknown";
      }
      while (dir && dir !== path.dirname(dir)) {
        const p = path.join(dir, "package.json");
        if (fs.existsSync(p)) {
          const j = JSON.parse(fs.readFileSync(p, "utf8"));
          if (j.name === pkg) return j.version ?? "unknown";
        }
        dir = path.dirname(dir);
      }
    } catch {
      /* 继续尝试下一种 */
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------- recorder

/** 自由字符串：要如实记录实际端点（openai / dashscope / openai-compatible / anthropic …）。 */
export type Provider = string;

export interface RecorderOptions {
  probe: string;
  provider: Provider;
  model?: string;
  /** 探针自身的参数，进 meta，便于复现 */
  params?: Record<string, unknown>;
}

export interface CallResult<T> {
  ok: boolean;
  value?: T;
  error?: Record<string, unknown>;
}

export class Recorder {
  private fd: number | null = null;
  private seq = 0;
  private findings: string[] = [];
  private unanswered: string[] = [];
  readonly file: string;

  constructor(private readonly opts: RecorderOptions) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = path.join(RAW_DIR, `${opts.probe}-${opts.provider}-${stamp}.jsonl`);
    this.fd = fs.openSync(this.file, "a");

    // 首行 meta —— 强制要求
    this.write("meta", {
      probe: opts.probe,
      provider: opts.provider,
      model: opts.model ?? null,
      params: opts.params ?? {},
      dryRun: DRY_RUN,
      recordedAt: new Date().toISOString(),
      node: process.version,
      sdkVersions: {
        "@anthropic-ai/sdk": sdkVersion("@anthropic-ai/sdk"),
        openai: sdkVersion("openai"),
      },
    });
  }

  private write(kind: string, payload: unknown) {
    if (this.fd === null) return;
    const line = JSON.stringify({ seq: this.seq++, kind, at: new Date().toISOString(), payload: scrub(payload) });
    fs.writeSync(this.fd, line + "\n");
  }

  /** 标记一个实验步骤。控制台可见，便于对照日志。 */
  step(label: string) {
    this.write("step", { label });
    console.log(`\n  ▸ ${label}`);
  }

  /** 记录一条观测。 */
  note(label: string, data: unknown) {
    this.write("note", { label, data });
    console.log(`    · ${label}: ${oneLine(data)}`);
  }

  /** 记录一条结论 —— 会汇总进末尾 summary 与控制台。 */
  finding(text: string) {
    this.findings.push(text);
    this.write("finding", { text });
    console.log(`    ✓ ${text}`);
  }

  /** 记录一条未解答项 —— 对应 V03 条款保持【验】标记。 */
  unansweredItem(text: string) {
    this.unanswered.push(text);
    this.write("unanswered", { text });
    console.log(`    ? 未解答: ${text}`);
  }

  /**
   * 执行一次 API 调用并记录。
   * 永不抛出 —— 错误结构本身就是 P6 的观测对象。
   */
  async call<T>(
    label: string,
    requestBody: unknown,
    fn: () => Promise<T>
  ): Promise<CallResult<T>> {
    this.write("request", { label, body: requestBody });

    if (DRY_RUN) {
      console.log(`    [dry-run] ${label} —— 已记录请求体，未发送`);
      this.write("response", { label, dryRun: true });
      return { ok: false, error: { __dryRun: true } };
    }

    const t0 = Date.now();
    try {
      const value = await fn();
      this.write("response", { label, latencyMs: Date.now() - t0, body: value });
      return { ok: true, value };
    } catch (err) {
      const error = serializeError(err);
      this.write("error", { label, latencyMs: Date.now() - t0, error });
      console.log(`    ✗ ${label} 报错: ${error.__errorClass} ${error.status ?? ""} ${String(error.message).slice(0, 160)}`);
      return { ok: false, error };
    }
  }

  /** 记录流式事件（逐条）。 */
  streamEvent(label: string, event: unknown) {
    this.write("stream_event", { label, event });
  }

  async close() {
    this.write("summary", { findings: this.findings, unanswered: this.unanswered });
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    console.log(`\n  证据: ${path.relative(process.cwd(), this.file)}`);
    if (this.unanswered.length) {
      console.log(`  未解答 ${this.unanswered.length} 项 —— 对应 V03 条款保持【验】标记`);
    }
  }
}

export function openRecorder(opts: RecorderOptions): Recorder {
  return new Recorder(opts);
}

/**
 * 检查「推理是否吃光了输出预算」。
 *
 * 实测（qwen3.7-plus）出现过 finish_reason=length + content="" +
 * reasoning_tokens 占满 completion_tokens 的情况：Run 拿到空回复，
 * 却可能以为模型已经回答。这是 §16.1 reservedOutputTokens 的硬约束 ——
 * 预留输出必须同时覆盖推理和正文。
 *
 * 每个会拿到完整响应的探针都应调用它，避免这类事实只能靠人工翻日志发现。
 */
const outputBudgetReported = new WeakSet<Recorder>();

export function checkOutputBudget(rec: Recorder, response: any): void {
  const choice = response?.choices?.[0];
  if (!choice) return;
  // 同一探针内只报一次，避免同一事实刷屏淹没其他结论
  if (outputBudgetReported.has(rec)) return;

  const usage = response.usage ?? {};
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const text = String(choice.message?.content ?? "");

  if (choice.finish_reason === "length" && text.length === 0) {
    outputBudgetReported.add(rec);
    rec.finding(
      `【输出预算被推理吃光】finish_reason=length 且 content 为空；` +
        `reasoning_tokens=${reasoning} / completion_tokens=${completion}。` +
        `§16.1 的 reservedOutputTokens 必须同时覆盖推理与正文，否则 Run 会拿到空回复`
    );
  } else if (reasoning > 0 && completion > 0 && reasoning / completion > 0.7) {
    rec.note("推理占输出比例偏高", { reasoning, completion, ratio: (reasoning / completion).toFixed(2) });
  }
}

// ---------------------------------------------------------------- misc

function oneLine(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(scrub(v));
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

/** 探针入口包装：统一打印标题、捕获顶层异常、保证 close。 */
export async function probe(
  id: string,
  title: string,
  fn: () => Promise<void>
): Promise<void> {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${id}  ${title}`);
  if (DRY_RUN) console.log(`[DRY-RUN] 只记录请求体，不发送真实请求`);
  console.log("=".repeat(72));
  try {
    await fn();
  } catch (err) {
    console.error(`\n探针顶层异常（非 API 错误，说明探针代码本身有问题）:`);
    console.error(serializeError(err));
    process.exitCode = 1;
  }
}

export function requireKey(name: string): boolean {
  if (DRY_RUN) return true;
  if (!process.env[name]) {
    console.log(`\n  跳过：${name} 未设置`);
    return false;
  }
  return true;
}
