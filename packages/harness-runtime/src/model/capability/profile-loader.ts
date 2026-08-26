/**
 * 端点能力声明的加载与冻结（V05 §8.6）。
 *
 * 声明是数据，从 adapters/endpoint-profiles/*.json 读取，不编译进代码。
 * Run 启动时冻结进 RunSpec —— Replay 使用冻结版本，不使用当前配置。
 */

import { readFileSync } from "node:fs";
import type {
  EndpointCapabilityProfile,
  EndpointCapabilityProfileSnapshot,
} from "../../types/endpoint.js";
import { asId } from "../../types/ids.js";

/** JSON 里以 _comment_ 开头的键是给人读的证据说明，加载时丢弃。 */
function stripComments(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_comment")) continue;
    out[k] = v;
  }
  return out;
}

export function loadProfileFromFile(path: string): EndpointCapabilityProfile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return parseProfile(stripComments(raw));
}

export function parseProfile(raw: Record<string, unknown>): EndpointCapabilityProfile {
  const missing = (["id", "endpointId", "shape", "modelId", "protocol", "context", "tokens"] as const)
    .filter((k) => raw[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`端点能力声明缺少必需字段：${missing.join(", ")}`);
  }

  const p = raw as unknown as EndpointCapabilityProfile;
  return {
    ...p,
    id: asId(String(raw["id"])),
    endpointId: asId(String(raw["endpointId"])),
    observedAt: Number(raw["observedAt"] ?? 0),
    probeSuiteVersion: String(raw["probeSuiteVersion"] ?? "unknown"),
    sourceEvidenceRefs: (raw["sourceEvidenceRefs"] as string[] | undefined) ?? [],
    confidence: (raw["confidence"] as EndpointCapabilityProfile["confidence"]) ?? "ASSUMED",
  };
}

/**
 * 递归深冻结（M-4，阶段 2）。
 *
 * `Object.freeze` 是**浅**的 —— 冻住 `p` 不妨碍任何人改 `p.tokens.usageFieldMap.x`
 * 或往 `p.sourceEvidenceRefs` 里 push。上一版只冻了第一层 ＋ 三个直接子对象，
 * `errors` 整个没冻，两个数组也没冻。
 *
 * 为什么阶段 2 必须补上（理由和阶段 1 不同）：
 * RunSpec 现在要**落库**。盘上那份是快照，内存那份若还能改，两者就会分叉，
 * 而 §18.3【定】要求 resume 时校验「端点能力声明是否仍与 RunSpec 冻结的一致」——
 * 拿一份能被改的对象去做这个校验，校验本身没有意义。
 */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  // 循环引用保护：profile 目前是纯 JSON 树，但这个函数会被 RunSpec 复用，
  // 而 RunSpec 将来长出反向引用只是时间问题。
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

/**
 * Run 启动时冻结。冻结后的对象进 RunSpec，执行期间不得替换。
 *
 * 先浅拷贝再深冻：直接冻 `p` 会把调用方手里那个可复用的 profile 一并冻死，
 * 而 `compose()` 会把同一个 profile 交给 protocol 适配器长期持有。
 */
export function freezeProfile(
  p: EndpointCapabilityProfile,
): EndpointCapabilityProfileSnapshot {
  return deepFreeze(structuredClone(p)) as EndpointCapabilityProfileSnapshot;
}

/**
 * 冻结整个 RunSpec（阶段 2）。
 *
 * 【定】§18.4：Replay 与 resume 使用**冻结的那一份**。这条在阶段 1 只对
 * `endpointProfile` 兑现了一半，`toolSnapshots` / 各 policy / `budgets`
 * 全都还是活对象 —— 而 §18.2 的三条恢复分支判定读的正是 `toolSnapshots`。
 *
 * 返回浅拷贝的深冻结版本：调用方传进来的对象不受影响。
 */
export function freezeRunSpec<T>(spec: T): T {
  return deepFreeze(structuredClone(spec));
}

/**
 * confidence = ASSUMED 的字段在被依赖时应产生 SYSTEM_NOTICE（V05 §8.6 不变量 3）。
 * 阶段 1 只做提示，不阻断。
 */
export function warnIfAssumed(p: EndpointCapabilityProfile): string[] {
  if (p.confidence === "PROBED") return [];
  return [
    `端点能力声明 ${p.id} 的 confidence=${p.confidence}，` +
      `其字段未经实测。依赖它做出的判定（协议校验强度、推理块档位、token 口径）都可能是错的。`,
  ];
}

/** 声明的粒度是端点 × 模型，不是平台也不是形状（V05 §8.6 不变量 5）。 */
export function profileMatches(
  p: EndpointCapabilityProfile,
  endpointId: string,
  modelId: string,
): boolean {
  return p.endpointId === endpointId && p.modelId === modelId;
}

/**
 * 启动前断言：配置的 baseUrl 与加载的端点声明指向同一个端点（U-6）。
 *
 * ── 为什么必须是断言而不是警告 ────────────────────────────────────────
 *
 * 声明错配不会报错，只会**悄悄跑错**：Runtime 拿一份「不校验配对、
 * 推理块可丢、count_tokens 精确」的声明去驱动一个恰恰相反的端点，
 * 表现出来是零星的 400 与莫名其妙的 token 偏差，而根因在启动那一刻就定了。
 *
 * 这与 `credential-guard` 是同一类保护：**在事发前断言，不是事后记录**。
 * 阶段 2 接 DeepSeek 对照端点时，它是第一道闸门。
 */
export function assertProfileMatchesEndpoint(
  p: EndpointCapabilityProfile,
  baseUrl: string,
): void {
  if (!p.expectedBaseUrlHost) return; // 声明没写就没法判，不制造假保护
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error(`baseUrl 不是合法 URL：${baseUrl}`);
  }
  if (host.includes(p.expectedBaseUrlHost)) return;
  throw new Error(
    `端点声明与 baseUrl 不匹配：\n` +
      `  声明 ${p.id}（endpointId=${p.endpointId}）期望主机包含 "${p.expectedBaseUrlHost}"\n` +
      `  实际 baseUrl 的主机是 "${host}"\n` +
      `声明的粒度是端点 × 模型（§8.6 不变量 5）。拿一份别的端点的声明去驱动这个端点，` +
      `协议校验强度、推理块档位、token 口径三组判定全部会错，而且不会报错，只会悄悄跑错。`,
  );
}
