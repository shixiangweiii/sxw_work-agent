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
      // 护栏 3（阶段 3 决 3 修订 2）：这次调用把数据发去了哪里。
      ...(dataMovementFor(rule, scopeValue) ?? {}),
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

  /**
   * ── 护栏 3（阶段 3 决 3 修订 2）：URL scope 的风险判定 ──────────────────
   *
   * 【定】`EffectScope.kind` 从阶段 1 起就有 `"URL"`（types/tool.ts），
   * 但这个函数**只对 FILE / DIRECTORY 判过风险** —— URL scope 拿不到
   * 任何 riskFact。也就是说：一次把 workspace 内容当 query 参数发出去的
   * GET，在 Policy 眼里和一次本地读文件长得一模一样，Trace 上也看不出差别。
   *
   * 评审把这条记成「scopeKind 枚举缺 URL」，那不准 —— **缺的不是枚举，
   * 是这里的判定**。所以护栏很便宜：加这一段就够了。
   *
   * 决 3 之下审批全部放行，所以这几条 fact 当前**不阻断任何东西**。
   * 它们的价值是让「这次调用把数据发去了哪里」在 Trace 上可审计 ——
   * 单人本地开发期接受残余风险，但不接受「发生了也查不出来」。
   */
  if (rule.scopeKind === "URL") {
    facts.push("EXTERNAL_ENDPOINT");
    const q = queryOf(scopeValue);
    if (q.length > 0) {
      // query 参数就是外发通道。带参数的请求与不带参数的请求，
      // 在数据流出这件事上不是同一个量级。
      facts.push("URL_CARRIES_QUERY");
    }
  }

  if (rule.effectType === "WRITE" || rule.effectType === "DELETE") {
    facts.push("MUTATES_EXTERNAL_STATE");
  }
  if (rule.effectType === "NETWORK") {
    facts.push("DATA_LEAVES_HOST");
  }
  if (rule.reversibility === "IRREVERSIBLE") {
    facts.push("IRREVERSIBLE");
  }
  return facts;
}

/**
 * 数据去了哪里（护栏 3 的另一半）。
 *
 * `DataMovementDescriptor` 从阶段 1 起就在类型里，**从未被任何 Resolver 填过**。
 * 一个永远为 undefined 的字段与一个不存在的字段是分不出来的 ——
 * 而这正是「未接线比不写更糟」的形状：读代码的人会以为数据流向是被记录的。
 *
 * 【定】destination 只记 **host**，不记完整 URL。
 * 完整 URL 的 query 里可能就装着被外发的内容 —— 把它原样写进 Trace，
 * 等于让这条审计记录自己变成第二个泄漏点。
 */
function dataMovementFor(
  rule: DeclarativeScopeRule,
  scopeValue: string,
): { dataMovement: ResolvedEffect["dataMovement"] } | undefined {
  if (rule.scopeKind !== "URL" || !scopeValue) return undefined;
  let host = "(无法解析)";
  let queryKeys: string[] = [];
  try {
    const u = new URL(scopeValue);
    host = u.host;
    queryKeys = [...u.searchParams.keys()];
  } catch {
    /* 解析不了就如实写「无法解析」，不要猜 */
  }
  return {
    dataMovement: {
      destination: host,
      // 记参数**名**不记参数值：名字足够回答「这次带了东西出去吗」，
      // 值则会把要防的东西抄进日志。
      scope:
        queryKeys.length > 0
          ? `${rule.operation}；query 参数：${queryKeys.join(", ")}`
          : `${rule.operation}；无 query 参数`,
    },
  };
}

function queryOf(scopeValue: string): string {
  try {
    return new URL(scopeValue).search;
  } catch {
    return "";
  }
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
