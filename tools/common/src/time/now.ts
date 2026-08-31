/**
 * now —— 取当前日期与时间。【场景工具】
 *
 * 三场景：
 *   办公：给产出的文档写一个准确的时间戳
 *   代码：给变更记录写日期
 *   聊天：给纪要写「整理于 …」
 *
 * 形态：只读、幂等、零副作用 → §18.2 分支一。
 *
 * ── 它是补充机制，不是主机制（阶段 2 决 3）────────────────────────────
 *
 * `context/compile.ts` 里那条注入的受信时间事实才是主机制，理由写在那儿：
 * **工具要模型记得调，而它上次就没调，直接编了一个日期。**
 * 这个工具的存在不改变那个结论，也**不允许**被用来替代那条注入。
 *
 * 那它为什么还要存在：段级冻结之后，注入的那条事实最多过时「本执行段
 * 已经跑了多久」。绝大多数办公产物只要日期，这点偏差无所谓；但确实有
 * 需要精确到分钟的场景（写时间戳、算耗时），给模型一条能自己取准的路，
 * 比让它拿一个可能过时几十分钟的值去算要好。
 */

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId } from "@workagent/harness-runtime";

export const nowDefinition: ToolDefinition = {
  id: asId("tool_now"),
  version: "1.1.0",
  name: "now",
  description:
    "取当前日期与时间。只读，不修改任何内容，无需参数。" +
    '返回 JSON：{"iso","local","timezone","epochMs"}。' +
    "上下文里的「[系统事实] 当前时间」是本次执行开始时的时刻；" +
    "只有在需要精确到分钟、或本次运行已持续较久时才需要调用本工具。",
  inputSchema: { type: "object", properties: {}, required: [] },
  effectResolution: {
    kind: "DECLARATIVE",
    /**
     * 没有任何入参可解析，但仍要有一条规则 —— 不变量 9 要求每次执行前
     * 都具有 ResolvedEffect，「无副作用」也得是显式声明出来的，
     * 不能靠「规则为空所以没有 effect」这种默认推断。
     */
    rule: {
      pointer: "",
      effectType: "READ",
      scopeKind: "NONE",
      reversibility: "REVERSIBLE",
      operation: "read_clock",
    },
  },
  redaction: { profile: "NONE" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  timeoutPolicy: { timeoutMs: 5_000 },
  progressReporting: { mode: "NONE" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
};

/**
 * 时区从哪来。
 *
 * 【定】不读宿主时区 —— 它必须与注入的时间事实用**同一个**时区，
 * 否则模型会拿到两个时区不同的时间，而它没有任何办法发现这件事。
 * 那个时区随 AgentSpec 冻结，这里经 ctx 拿。
 */
export async function executeNow(
  _input: Record<string, never>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const tz = ctx.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const d = new Date();
  const local = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  }).format(d);

  return {
    ok: true,
    output: JSON.stringify({ iso: d.toISOString(), local, timezone: tz, epochMs: d.getTime() }),
    // 【定】NO_EFFECT 而不是 APPLIED：它没有改变外部世界的任何东西。
    sideEffectState: "NO_EFFECT",
  };
}

export const nowSnapshot: ToolSnapshot = {
  toolId: nowDefinition.id,
  version: nowDefinition.version,
  definition: nowDefinition,
};
