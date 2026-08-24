/**
 * Tool Runtime（V05 §12）。
 *
 * 【定·实测】inputSchema 的校验 100% 是 Runtime 责任。
 *
 * 四个端点全部放行不合 schema 的入参 —— 这是三轮实测里唯一一条四格全等的负向结论。
 * 诱导模型产出 {cityName}（schema 要求 city），四个端点均未报错。
 * 所以这里的校验不是「双保险」，是唯一的一道。
 */

import type { JsonSchema, ToolDefinition, ToolSnapshot } from "../types/tool.js";
import type { JsonValue } from "../types/ids.js";
import { makeError, type RuntimeErrorRecord } from "../types/error.js";

export class ToolRegistry {
  private readonly byName = new Map<string, ToolSnapshot>();

  constructor(snapshots: ToolSnapshot[]) {
    for (const s of snapshots) this.byName.set(s.definition.name, s);
  }

  get(name: string): ToolSnapshot | undefined {
    return this.byName.get(name);
  }

  all(): ToolSnapshot[] {
    return [...this.byName.values()];
  }

  /**
   * tool 定义的固定开销。实测 2 个单参数工具 = 360 token（四端点一致，
   * 百炼 OpenAI 测得 361），折合每工具约 180。
   *
   * 这里用实测系数而不是重新计算 —— 它是端点无关的模型共性。
   */
  fixedOverheadTokens(): number {
    return this.byName.size * 180;
  }
}

export interface SchemaValidation {
  ok: boolean;
  normalized?: JsonValue;
  error?: RuntimeErrorRecord;
}

/**
 * 极简 schema 校验。够阶段 1 的两个工具用，不引入 schema 库（D-25 精神）。
 *
 * 返回 AFTER_MODEL_CORRECTION 而不是 NEVER：入参错了是模型可以自己改对的，
 * 把结构化的错误信息回灌给它就行 —— 这正是 §24.4 那条
 * 「Tool Schema 错误与自动修正」Micro Case 的路径。
 */
export function validateAndNormalize(
  raw: unknown,
  schema: JsonSchema,
  toolName: string,
): SchemaValidation {
  const fail = (msg: string): SchemaValidation => ({
    ok: false,
    error: makeError({
      code: "TOOL_INPUT_SCHEMA",
      source: "TOOL_INPUT",
      category: "VALIDATION",
      retryability: "AFTER_MODEL_CORRECTION",
      sideEffectState: "NOT_STARTED",
      safeMessage: `${toolName} 的入参不符合 schema：${msg}`,
    }),
  });

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(`期望一个对象，收到 ${Array.isArray(raw) ? "数组" : typeof raw}`);
  }

  const input = raw as Record<string, unknown>;
  const out: Record<string, JsonValue> = {};

  for (const key of schema.required ?? []) {
    if (input[key] === undefined) {
      const got = Object.keys(input);
      return fail(
        `缺少必需字段 "${key}"。收到的字段：${got.length > 0 ? got.join(", ") : "（无）"}`,
      );
    }
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== prop.type) {
      return fail(`字段 "${key}" 期望 ${prop.type}，收到 ${typeof v}`);
    }
    out[key] = v as JsonValue;
  }

  // 未声明的字段丢弃而不是报错：模型多给了东西不影响执行，
  // 但不让它进入 normalizedInput，以免污染 inputDigest。
  return { ok: true, normalized: out };
}

/**
 * 【定】redaction 必填。不声明的 Tool 走默认最严格 profile，而不是默认放行。
 * 这个函数是那条规则的兜底 —— 类型层面已经必填，这里防的是运行时构造的 definition。
 */
export function effectiveRedaction(def: ToolDefinition): ToolDefinition["redaction"] {
  return def.redaction ?? { profile: "STRICTEST" };
}
