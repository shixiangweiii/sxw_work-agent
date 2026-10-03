/**
 * Spike 1 探针框架。刻意粗糙，跑完即弃，阶段 1 不得 import 本目录任何代码。
 *
 * 沿用 Spike 0 的三条硬性要求：
 *   1. API Key 永不落盘；图片 base64 也不落进 jsonl（换成 sha256 ＋ 字节数，PNG 另存）；
 *   2. 每个 raw 文件首行是 meta（SDK 版本 / 模型 / 日期 / 探针参数）—— 没有版本号的证据等于没有证据；
 *   3. 异常记录进同一个 jsonl，不中断探针。
 *
 * 调用走 `stream: true` ＋ 自己组装事件，与 Atlas 的形状适配器同一条路径
 * （不用 SDK 的 MessageStream —— 第三方端点的事件流有任何出入，它会先替我们抛错）。
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, SPIKE_ROOT, type EndpointConfig } from "./env.js";

export const RAW_DIR = join(SPIKE_ROOT, "raw");
export const IMG_DIR = join(RAW_DIR, "images");
mkdirSync(IMG_DIR, { recursive: true });

const SDK_VERSION = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, "node_modules/@anthropic-ai/sdk/package.json"), "utf8"),
  ) as { version: string }
).version;

export function client(ep: EndpointConfig): Anthropic {
  return new Anthropic({
    apiKey: ep.apiKey,
    // 显式置空：SDK 默认读 ANTHROPIC_AUTH_TOKEN 并作为 Bearer 头一起发出。
    authToken: null,
    baseURL: ep.baseURL,
    timeout: 300_000,
    maxRetries: 0,
  });
}

// ───────────────────────────────────────────────────────────── 证据

export class Evidence {
  readonly file: string;
  constructor(probe: string, ep: EndpointConfig, params: Record<string, unknown>) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(RAW_DIR, `${probe}-${ep.name}-${ts}.jsonl`);
    this.write({
      kind: "meta",
      probe,
      endpoint: ep.name,
      model: ep.model,
      host: ep.host,
      sdkVersion: SDK_VERSION,
      node: process.version,
      date: new Date().toISOString(),
      params,
    });
  }
  write(record: Record<string, unknown>): void {
    appendFileSync(this.file, JSON.stringify(record) + "\n");
  }
}

/** 落盘前的深拷贝：图片 base64 换成哈希，疑似凭证的键剥掉。 */
export function scrub(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(scrub);
  const obj = value as Record<string, unknown>;
  if (obj["type"] === "base64" && typeof obj["data"] === "string") {
    const buf = Buffer.from(obj["data"] as string, "base64");
    return { type: "base64", media_type: obj["media_type"], data: `<sha256:${sha256(buf)} ${buf.length}B>` };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = /^(api[-_]?key|authorization|x-api-key|auth[-_]?token)$/i.test(k) ? "[REDACTED]" : scrub(v);
  }
  return out;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 存 PNG 并返回 Anthropic image 块。同一张图只存一份。
 * **只给合成图用** —— `raw/images/` 不在忽略名单里，归档的意义就是让合成夹具随证据一起进仓库。
 */
export function imageBlock(png: Buffer): Anthropic.ImageBlockParam {
  const file = join(IMG_DIR, `${sha256(png).slice(0, 16)}.png`);
  if (!existsSync(file)) writeFileSync(file, png);
  return ephemeralImageBlock(png);
}

/**
 * 只编码、不归档。**真实屏幕的截图一律走这里**（P-6）。
 * 拆成两个函数而不是给 imageBlock 加一个「要不要存」的参数：漏传参数的默认值必须是「不存」，
 * 而合成图探针有五个调用点都依赖「存」—— 两个名字让调用点自己说出它要的是哪一种。
 * 此前 P-6 走 imageBlock，把用户桌面（含桌面上的文件名）存进了 raw/images/，
 * 文件头那句「截图不进仓库」因此是假的（2026-10-03 代码评审 CU-R11）。
 */
export function ephemeralImageBlock(png: Buffer): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
}

// ───────────────────────────────────────────────────────────── 调用

export interface AssembledBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  inputJson?: string;
}

export interface CallResult {
  ok: boolean;
  status?: number;
  error?: { cls: string; message: string; body?: unknown };
  blocks: AssembledBlock[];
  text: string;
  thinkingChars: number;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  usage: Record<string, number>;
  stopReason?: string | null;
  latencyMs: number;
}

export async function call(ep: EndpointConfig, body: Record<string, unknown>): Promise<CallResult> {
  const t0 = Date.now();
  const blocks: AssembledBlock[] = [];
  const usage: Record<string, number> = {};
  let stopReason: string | null | undefined;
  const mergeUsage = (u: unknown) => {
    if (!u || typeof u !== "object") return;
    for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
      if (typeof v === "number") usage[k] = v;
    }
  };
  try {
    const stream = (await client(ep).messages.create({
      ...(body as object),
      stream: true,
    } as unknown as Anthropic.MessageCreateParamsStreaming)) as AsyncIterable<Record<string, any>>;
    for await (const ev of stream) {
      switch (ev["type"]) {
        case "message_start":
          mergeUsage(ev["message"]?.["usage"]);
          break;
        case "content_block_start": {
          const cb = ev["content_block"] ?? {};
          blocks[ev["index"]] = {
            type: cb.type,
            ...(cb.type === "text" ? { text: cb.text ?? "" } : {}),
            ...(cb.type === "thinking" ? { thinking: cb.thinking ?? "", signature: cb.signature ?? "" } : {}),
            ...(cb.type === "tool_use" ? { id: cb.id, name: cb.name, inputJson: "" } : {}),
          };
          break;
        }
        case "content_block_delta": {
          const b = blocks[ev["index"]];
          const d = ev["delta"] ?? {};
          if (!b) break;
          if (d.type === "text_delta") b.text = (b.text ?? "") + (d.text ?? "");
          else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + (d.thinking ?? "");
          else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + (d.signature ?? "");
          else if (d.type === "input_json_delta") b.inputJson = (b.inputJson ?? "") + (d.partial_json ?? "");
          break;
        }
        case "message_delta":
          stopReason = ev["delta"]?.["stop_reason"] ?? stopReason;
          mergeUsage(ev["usage"]);
          break;
        default:
          break;
      }
    }
    const toolUses: CallResult["toolUses"] = [];
    for (const b of blocks) {
      if (b?.type === "tool_use") {
        try {
          b.input = b.inputJson ? JSON.parse(b.inputJson) : {};
        } catch {
          b.input = { __unparsed: b.inputJson };
        }
        toolUses.push({ id: b.id!, name: b.name!, input: b.input });
      }
    }
    const present = blocks.filter(Boolean);
    return {
      ok: true,
      blocks: present,
      text: present.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      thinkingChars: present.filter((b) => b.type === "thinking").reduce((n, b) => n + (b.thinking?.length ?? 0), 0),
      toolUses,
      usage,
      stopReason,
      latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: typeof e?.status === "number" ? e.status : undefined,
      error: { cls: e?.constructor?.name ?? typeof e, message: String(e?.message ?? e), body: e?.error },
      blocks: blocks.filter(Boolean),
      text: "",
      thinkingChars: 0,
      toolUses: [],
      usage,
      stopReason,
      latencyMs: Date.now() - t0,
    };
  }
}

/** 计费输入 = input ＋ 两项缓存（与 Atlas 的 billedInputTokens 同口径）。 */
export function billedInput(u: Record<string, number>): number {
  return (u["input_tokens"] ?? 0) + (u["cache_creation_input_tokens"] ?? 0) + (u["cache_read_input_tokens"] ?? 0);
}

/** 把组装出的块原样转回请求格式（DeepSeek 要求推理块逐字回传）。 */
export function toRequestBlocks(blocks: AssembledBlock[]): unknown[] {
  return blocks.map((b) => {
    if (b.type === "thinking") return { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" };
    if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
    if (b.type === "text") return { type: "text", text: b.text ?? "" };
    return b;
  });
}

// ───────────────────────────────────────────────────────────── 工具函数

/** 带种子的伪随机数（mulberry32）。种子写进 meta，场景可原样重建。 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 去掉易混字形（0/O、1/I/L、2/Z、5/S、6/G、8/B）的编码字母表。 */
const CODE_ALPHABET = "ACDEFHJKMNPRTUVWXY3479";

export function randomCode(rand: () => number, groups: number[]): string {
  return groups
    .map((n) => Array.from({ length: n }, () => CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)]).join(""))
    .join("-");
}

export function normCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function shuffle<T>(rand: () => number, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 有界并发。探针之间互不依赖，但端点的限流未知，别一次全打出去。 */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** 从模型文本里抠出第一个 JSON 对象（思考型模型常在 JSON 前后多说几句）。 */
export function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export const MAX_TOKENS = 8192;
