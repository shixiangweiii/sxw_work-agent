/**
 * P9　assistant 回合的最小合法形态【计划外，第三轮加测】
 *
 * 起因：P2 负向 A（删除推理块，保留 text + tool_use）在 DeepSeek 上**被接受**，
 * 但 P3 / P4 里只含 tool_use 的 assistant 消息**被 400 拒绝**，报错都是
 *   `The content[].thinking in the thinking mode must be passed back to the API.`
 *
 * 两条观测直接冲突，而 P2 的结论（推理块可删 ⟹ Compact 可以丢弃它）是
 * §11.5 / §11.6 的直接输入。不解决这个冲突，就会把一条错误结论写进 Facts。
 *
 * 本探针把两个变量拆开做 2×3 矩阵：
 *   变量 1：请求里 thinking 参数 —— 缺省 / 显式 enabled
 *   变量 2：assistant content 形态 —— [tool_use] / [text, tool_use] / [thinking, tool_use]
 *
 * 喂给：§11.5 REQUIRED_VERBATIM 的真实边界、§11.6 Compact 的硬约束
 */

import { probe, openRecorder, requireKey, DRY_RUN } from "../harness.js";
import {
  anthropicClient,
  ANTHROPIC_THINKING_MODEL,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_API_KEY_NAME,
} from "../clients/anthropic.js";
import { anthropicTools, fakeToolResult } from "../tools.js";

const PROMPT = "先查北京的天气。";
const CALL_ID = "call_fixed_p9_0001";

const THINKING_BLOCK = {
  type: "thinking",
  thinking: "The user wants Beijing weather. I should call get_weather.",
  signature: "",
};
const TEXT_BLOCK = { type: "text", text: "好的，我先查询北京的天气。" };
const TOOL_USE_BLOCK = {
  type: "tool_use",
  id: CALL_ID,
  name: "get_weather",
  input: { city: "北京" },
};
const TOOL_RESULT_MSG = {
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: CALL_ID,
      content: fakeToolResult("get_weather", { city: "北京" }),
    },
  ],
};

const SHAPES: Array<[string, any[]]> = [
  ["仅 tool_use", [TOOL_USE_BLOCK]],
  ["text + tool_use", [TEXT_BLOCK, TOOL_USE_BLOCK]],
  ["thinking + tool_use", [THINKING_BLOCK, TOOL_USE_BLOCK]],
];

const THINKING_PARAMS: Array<[string, Record<string, unknown>]> = [
  ["thinking 参数缺省", {}],
  ["thinking 显式 enabled", { thinking: { type: "enabled", budget_tokens: 2048 } }],
];

async function run() {
  if (!requireKey(ANTHROPIC_API_KEY_NAME)) return;
  const client = anthropicClient();
  const rec = openRecorder({
    probe: "p9",
    provider: ANTHROPIC_PROVIDER_LABEL,
    model: ANTHROPIC_THINKING_MODEL,
  });

  const matrix: Array<Record<string, unknown>> = [];

  for (const [thinkLabel, thinkParam] of THINKING_PARAMS) {
    for (const [shapeLabel, content] of SHAPES) {
      const label = `${thinkLabel} × ${shapeLabel}`;
      rec.step(label);
      const body = {
        model: ANTHROPIC_THINKING_MODEL,
        max_tokens: 512,
        tools: anthropicTools,
        ...thinkParam,
        messages: [
          { role: "user", content: PROMPT },
          { role: "assistant", content },
          TOOL_RESULT_MSG,
        ],
      };
      const r = await rec.call(label, body, () => client.messages.create(body as any));
      if (DRY_RUN) continue;
      const status = r.ok ? 200 : (r.error?.status as number | undefined);
      const message = r.ok ? "" : String((r.error as any)?.message ?? "").slice(0, 200);
      matrix.push({ thinking: thinkLabel, shape: shapeLabel, status, message });
      rec.note("结果", { status, message });
    }
  }

  if (DRY_RUN) {
    await rec.close();
    return;
  }

  rec.note("2×3 矩阵", matrix);

  const accepted = matrix.filter((m) => m.status === 200);
  const rejected = matrix.filter((m) => m.status !== 200);

  // 判据一：thinking 参数本身是否是决定因素
  const byThinkParam = THINKING_PARAMS.map(([l]) => ({
    thinking: l,
    accepted: matrix.filter((m) => m.thinking === l && m.status === 200).length,
  }));
  // 判据二：assistant content 形态是否是决定因素
  const byShape = SHAPES.map(([l]) => ({
    shape: l,
    accepted: matrix.filter((m) => m.shape === l && m.status === 200).length,
  }));
  rec.note("按 thinking 参数分组的通过数", byThinkParam);
  rec.note("按 assistant 形态分组的通过数", byShape);

  if (rejected.length === 0) {
    rec.finding(
      "6/6 全部被接受 —— 未能复现 P3/P4 的 400，冲突另有成因，需回看 P3/P4 请求体"
    );
  } else if (byShape.every((s) => s.accepted === 0 || s.accepted === THINKING_PARAMS.length)) {
    const bad = byShape.filter((s) => s.accepted === 0).map((s) => s.shape);
    rec.finding(
      `【决定因素是 assistant content 形态，不是 thinking 参数】被拒绝的形态：${bad.join(" / ")}；` +
        `其余形态在两种 thinking 参数下都通过。` +
        `即：报错文案说的是「thinking 必须回传」，实际约束是「assistant 回合不能只有 tool_use」`
    );
  } else {
    rec.finding(
      `拒绝分布与形态不完全对应，thinking 参数也参与判定：${JSON.stringify(byThinkParam)}`
    );
  }

  rec.finding(
    `矩阵结果：接受 ${accepted.length}/6，拒绝 ${rejected.length}/6。逐格见日志的「2×3 矩阵」`
  );

  // ------------------------------------------------------------------ 阶段 2
  //
  // 阶段 1 判定「text + tool_use」必被拒。但 P2 负向 A 正是这个形态，却过了。
  // 两者唯一的区别：P2 回传的是**上一轮真实响应里的 id 与文本**，阶段 1 用的是伪造 id。
  //
  // 假设：该实现按 id 在服务端保留推理内容，能自己补回 thinking —— 若成立，
  // 「推理块可删」就不是协议宽松，而是**服务端有状态**。这对 §11.5 是完全不同的结论：
  // 前者可以放心 Compact，后者一旦跨会话/跨端点重放就会失效。
  rec.step("阶段 2：换成上一轮真实响应的 id 与内容，再删推理块");

  const seedBody = {
    model: ANTHROPIC_THINKING_MODEL,
    max_tokens: 1024,
    tools: anthropicTools,
    messages: [{ role: "user", content: PROMPT }],
  };
  const seed = await rec.call("阶段 2 · 取真实第 1 轮", seedBody, () =>
    client.messages.create(seedBody as any)
  );
  if (!seed.ok) {
    rec.unansweredItem("阶段 2 取种子响应失败，id 复原假设未验证");
    await rec.close();
    return;
  }

  const realContent: any[] = (seed.value as any).content ?? [];
  const realToolUse = realContent.find((b) => b.type === "tool_use");
  if (!realToolUse) {
    rec.unansweredItem("阶段 2 种子响应无 tool_use，无法验证 id 复原假设");
    await rec.close();
    return;
  }
  rec.note("真实第 1 轮块序列", realContent.map((b) => b.type));

  const realResultMsg = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: realToolUse.id,
        content: fakeToolResult(realToolUse.name, realToolUse.input),
      },
    ],
  };

  /** 真实 content 去掉 thinking 后的形态（= P2 负向 A）。 */
  const realStripped = realContent.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
  /** 同样去掉 thinking，但把 tool_use 的 id 换成伪造的（tool_result 同步换）。 */
  const fakeIdStripped = realStripped.map((b: any) =>
    b.type === "tool_use" ? { ...b, id: CALL_ID } : b
  );

  const phase2: Array<[string, any[], any]> = [
    ["真实 id + 删 thinking（= P2 负向 A）", realStripped, realResultMsg],
    ["伪造 id + 删 thinking", fakeIdStripped, TOOL_RESULT_MSG],
  ];

  const phase2Results: Array<Record<string, unknown>> = [];
  for (const [label, content, resultMsg] of phase2) {
    const body = {
      model: ANTHROPIC_THINKING_MODEL,
      max_tokens: 512,
      tools: anthropicTools,
      messages: [{ role: "user", content: PROMPT }, { role: "assistant", content }, resultMsg],
    };
    const r = await rec.call(`阶段 2 · ${label}`, body, () => client.messages.create(body as any));
    const status = r.ok ? 200 : (r.error?.status as number | undefined);
    phase2Results.push({ label, status });
    rec.note(`阶段 2 结果 · ${label}`, { status });
  }

  const realOk = phase2Results[0]?.status === 200;
  const fakeOk = phase2Results[1]?.status === 200;

  if (realOk && !fakeOk) {
    rec.finding(
      "【服务端按 id 保留推理内容】同样是「删掉 thinking 的 text + tool_use」，" +
        "用上一轮真实 id 通过、用伪造 id 被 400。" +
        "所以「推理块可删」在该实现上不是协议宽松，而是服务端有状态 —— " +
        "§11.5 不能据此认为推理块可自由丢弃：一旦重放的 id 不是本端点生成的（跨会话/换端点/Compact 后重构），约束就会重新出现"
    );
  } else if (realOk && fakeOk) {
    rec.finding(
      "阶段 2 两格都通过 —— id 不是决定因素，阶段 1 的拒绝另有成因（疑为伪造的 text/内容），需再拆变量"
    );
  } else if (!realOk) {
    rec.finding(
      `阶段 2 中真实 id 一格也被拒（status=${phase2Results[0]?.status}）—— ` +
        "与 P2 负向 A 的观测不一致，说明该行为不稳定（非确定性），P2 的结论不能采信"
    );
    rec.unansweredItem("「删除推理块」在该实现上的行为不稳定，需多次采样后才能下结论");
  }

  await rec.close();
}

await probe("P9", "assistant 回合的最小合法形态（thinking 参数 × content 形态 2×3）", run);
