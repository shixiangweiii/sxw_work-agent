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

  const declared = schema.properties;
  for (const [key, prop] of Object.entries(declared ?? {})) {
    const v = input[key];
    if (v === undefined) continue;
    const mismatch = typeMismatch(prop.type, v);
    if (mismatch) return fail(`字段 "${key}" ${mismatch}`);
    out[key] = v as JsonValue;
  }

  /**
   * ── 【定】`properties` 之外的键，按 **JSON Schema 的标准语义**处置 ────────
   *
   * 标准里 `additionalProperties` 缺省是**允许**。所以：
   *
   *   additionalProperties === false  → 丢弃（schema 明确说了"就这些"）
   *   其余一切（含缺省、含 properties 整个缺席）→ **原样保留**
   *
   * ── 这条改过一次，原来的写法是"一律丢弃"，而那是一个真实缺陷 ──────────
   *
   * 原注释写着：「发给模型的就是服务器给的那份原 schema，所以『未声明』
   * 在两种工具上是同一个意思：模型编出来的字段」。
   *
   * **那句话只有在 `properties` 完整覆盖所有参数时才成立**，而这恰恰是一个
   * 需要**解析过 schema** 才能下的判断。根级 `$ref` / `oneOf` /
   * `additionalProperties` / `patternProperties` 形态的 schema 把参数表达在
   * 别处，此时"未声明"的意思是"Atlas 看不懂它声明在哪"，不是"模型编的"。
   * 一律丢弃的后果：模型传 `{region:"cn"}`，下游收到 `{}`，
   * **校验通过、无任何报错、模型无从发现自己的意图被改写了**。
   *
   * 【定】用标准关键字而不是给外部工具开分支：两类工具走**同一条规则**，
   * Runtime 因此不需要知道"有 MCP 这回事"。自家工具想要严格，就在自己的
   * schema 里显式写 `additionalProperties: false`（`verify:tools` B4 段钉着）——
   * 把"我要严格"说出来，比让它做一个隐式默认要诚实。
   */
  if (schema["additionalProperties"] === false) return { ok: true, normalized: out };

  for (const [key, v] of Object.entries(input)) {
    if (declared && Object.prototype.hasOwnProperty.call(declared, key)) continue;
    if (v === undefined) continue;
    out[key] = v as JsonValue;
  }
  return { ok: true, normalized: out };
}

/**
 * 声明的类型与实际值对不对得上。对不上返回一句人话，对得上返回 undefined。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】**说不清的一律放行**，不是一律拒绝。
 *
 * 这个函数同时服务两类工具，而失败方向必须按外部工具来定：
 * Atlas 自家工具的 schema 全在标量子集内（有判据钉着），走不到宽的那几支；
 * 而对一个 MCP 工具，"我不认识这个构造所以拒绝"的后果是**整个工具废掉** ——
 * 模型看得到它、调得动它，每次都被 Runtime 挡在门口，且它无从改对。
 *
 * 放行的代价是真实的、也有限：Atlas 少校验一个参数，而下游那个 MCP 服务器
 * 自己会校验（它才是那份 schema 的作者）。两害相权，废掉工具是更大的那个。
 * ══════════════════════════════════════════════════════════════════════
 */
function typeMismatch(declared: unknown, v: unknown): string | undefined {
  // 缺失（oneOf / $ref 形态）或数组形态（["string","null"]）—— 都不校验。
  if (typeof declared !== "string") return undefined;

  switch (declared) {
    case "string":
    case "boolean":
      return typeof v === declared ? undefined : `期望 ${declared}，收到 ${jsonTypeOf(v)}`;
    case "number":
      return typeof v === "number" ? undefined : `期望 number，收到 ${jsonTypeOf(v)}`;
    case "integer":
      return typeof v === "number" && Number.isInteger(v)
        ? undefined
        : `期望整数，收到 ${jsonTypeOf(v)}`;
    case "array":
      return Array.isArray(v) ? undefined : `期望数组，收到 ${jsonTypeOf(v)}`;
    case "object":
      // 【定】只判"是不是个普通对象"，**不递归校验里面**。
      // 递归就等于开始理解那份 schema —— 而这正是上面那条【定】要避免的。
      return v !== null && typeof v === "object" && !Array.isArray(v)
        ? undefined
        : `期望对象，收到 ${jsonTypeOf(v)}`;
    default:
      // "null" 以及任何将来出现的 type：不校验，原样保留。
      return undefined;
  }
}

/** `typeof` 分不出 array 与 null，而报错信息里这两者最需要被分开。 */
function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

/**
 * 【定】redaction 必填。不声明的 Tool 走默认最严格 profile，而不是默认放行。
 * 这个函数是那条规则的兜底 —— 类型层面已经必填，这里防的是运行时构造的 definition。
 */
export function effectiveRedaction(def: ToolDefinition): ToolDefinition["redaction"] {
  return def.redaction ?? { profile: "STRICTEST" };
}
