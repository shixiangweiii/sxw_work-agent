/**
 * EffectResolver（V05 §12.4）。
 *
 * 【定】EffectScope 使用规范化语义对象，**不以自由文本作为授权边界**。
 *
 * 这条不是洁癖：模型给的 path 是自由文本，可能是 "../../etc/passwd"，
 * 也可能是 "notes/../../../secrets"。Policy 不该去 parse 字符串猜意图，
 * 它应该拿到一个已经规范化、已经确定落在哪个 Mount 内的语义对象。
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  DeclarativeScopeRule,
  EffectResolutionDescriptor,
  ResolvedEffect,
} from "../types/tool.js";
import type { JsonValue } from "../types/ids.js";
import type { EffectResolverPort } from "../ports/index.js";

export class DeclarativeEffectResolver implements EffectResolverPort {
  resolve(
    descriptor: EffectResolutionDescriptor,
    normalizedInput: JsonValue,
    workspaceRoot: string,
  ): ResolvedEffect {
    if (descriptor.kind !== "DECLARATIVE") {
      // 【定】文件路径、Shell、Browser、批量操作必须使用受信任 Resolver。
      // 阶段 1 只实现声明式；RESOLVER 分支留到阶段 3（Browser Capability）。
      throw new Error(
        `阶段 1 只实现 DECLARATIVE effect resolution。收到 kind=${descriptor.kind}，` +
          `受信任 Resolver 的 SDK 是阶段 3 的范围。`,
      );
    }

    const rule = descriptor.rules[0];
    if (!rule) {
      return noEffect(descriptor.version);
    }

    const raw = readPointer(normalizedInput, rule.pointer);
    const scopeValue = normalizeScope(rule, raw, workspaceRoot);

    const effect: ResolvedEffect = {
      effectType: rule.effectType,
      operation: rule.operation,
      scope: { kind: rule.scopeKind, value: scopeValue },
      reversibility: rule.reversibility,
      targetFingerprints: [{ target: scopeValue }],
      riskFacts: riskFactsFor(rule, scopeValue, workspaceRoot),
      resolverVersion: descriptor.version,
      digest: "",
    };
    effect.digest = digestOf(effect);
    return effect;
  }
}

/** JSON Pointer 的极简子集：只支持 /key 形式。够阶段 1 用。 */
function readPointer(input: JsonValue, pointer: string): string {
  const key = pointer.replace(/^\//, "");
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "";
  const v = (input as Record<string, JsonValue>)[key];
  return v === undefined || v === null ? "" : String(v);
}

/**
 * 规范化：把模型给的自由文本变成绝对路径。
 *
 * 这一步之后，"../../etc/passwd" 和 "notes/../../../etc/passwd" 会变成同一个字符串，
 * Policy 只需要判断它是不是落在 workspaceRoot 内 —— 不需要理解路径语法。
 */
function normalizeScope(
  rule: DeclarativeScopeRule,
  raw: string,
  workspaceRoot: string,
): string {
  if (rule.scopeKind === "FILE" || rule.scopeKind === "DIRECTORY") {
    return resolve(workspaceRoot, raw || ".");
  }
  return raw;
}

/**
 * 风险事实。Policy 消费它做判定，而不是自己去看 scope 字符串。
 *
 * 【定】ResolvedEffect 必须是 Grant Scope 的子集（V05 §22.1）。
 * 越界在这里被标记为事实，由 Policy 决定处置。
 */
function riskFactsFor(
  rule: DeclarativeScopeRule,
  scopeValue: string,
  workspaceRoot: string,
): string[] {
  const facts: string[] = [];
  const root = resolve(workspaceRoot);

  if (rule.scopeKind === "FILE" || rule.scopeKind === "DIRECTORY") {
    if (scopeValue !== root && !scopeValue.startsWith(root + "/")) {
      facts.push("OUTSIDE_WORKSPACE");
    }
  }
  if (rule.effectType === "WRITE" || rule.effectType === "DELETE") {
    facts.push("MUTATES_EXTERNAL_STATE");
  }
  if (rule.reversibility === "IRREVERSIBLE") {
    facts.push("IRREVERSIBLE");
  }
  return facts;
}

function noEffect(version: string): ResolvedEffect {
  const e: ResolvedEffect = {
    effectType: "NONE",
    operation: "none",
    scope: { kind: "NONE", value: "" },
    reversibility: "REVERSIBLE",
    targetFingerprints: [],
    riskFacts: [],
    resolverVersion: version,
    digest: "",
  };
  e.digest = digestOf(e);
  return e;
}

function digestOf(e: ResolvedEffect): string {
  return createHash("sha256")
    .update([e.effectType, e.operation, e.scope.kind, e.scope.value, e.reversibility].join("|"))
    .digest("hex")
    .slice(0, 32);
}
