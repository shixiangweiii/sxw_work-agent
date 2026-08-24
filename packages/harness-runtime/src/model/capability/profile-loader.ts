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

/** Run 启动时冻结。冻结后的对象进 RunSpec，执行期间不得替换。 */
export function freezeProfile(
  p: EndpointCapabilityProfile,
): EndpointCapabilityProfileSnapshot {
  return Object.freeze({
    ...p,
    protocol: Object.freeze({ ...p.protocol }),
    context: Object.freeze({ ...p.context }),
    tokens: Object.freeze({ ...p.tokens }),
  });
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
