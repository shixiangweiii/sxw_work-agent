/**
 * P-2b 工具调用形态的定位：Atlas 真实会走的那条路。
 *
 * 与 P-2 的区别：P-2 让模型自由输出 JSON（第一轮 qwen 关思考时常写出不合法 JSON）；
 * 这里坐标是 tool_use 的参数 —— 由端点的函数调用机制产出，Atlas 的 validateAndNormalize 会校验它。
 *
 * 流程（每个 端点 × 思考 × 坐标约定 一组）：
 *   call-1：用户「我会让你点击屏幕上的目标，先截一张图」→ 期望 computer{action:screenshot}
 *   call-2（每个目标一次）：回传 call-1 的 assistant 轮（推理块原样）＋
 *           user[ tool_result[文字, 截图], 文字「请点击：…」]
 *           —— 截图放在 tool_result 里（P-1：两端点都收得到），指令放在其后的文字块
 *           （P-1 V5：两端点都收得到；百炼只丢「其后的图片块」）。
 * 计分：left_click 的 coordinate 按工具描述里声明的坐标系换算，落在目标框内算中。
 */

import { endpoint, endpointsFromArgs, type EndpointConfig } from "../env.js";
import { Evidence, call, imageBlock, pool, prng, scrub, toRequestBlocks, type CallResult } from "../harness.js";
import { LOGICAL_H, LOGICAL_W, appScene, render, specOf } from "../scenes.js";

const SEED = 2101;
const W = 1792;
const H = 1120;
const MAX = 16384;
const THINKINGS = ["default", "disabled"] as const;
const CONVS = ["norm1000", "pixel"] as const;

function tool(conv: (typeof CONVS)[number]) {
  const coordDesc =
    conv === "norm1000"
      ? "coordinate 使用 0–1000 的归一化坐标：[0,0] 是截图左上角，[1000,1000] 是截图右下角，与截图的实际像素尺寸无关。"
      : `coordinate 使用截图上的像素坐标，原点在左上角，x 向右、y 向下。截图尺寸为 ${W}x${H} 像素。`;
  return {
    name: "computer",
    description:
      "操作本机屏幕。action=screenshot 截取当前屏幕；action=left_click 在 coordinate 处单击左键；" +
      "其余动作暂不可用。" + coordDesc,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["screenshot", "left_click", "double_click", "right_click", "type", "key", "scroll", "wait"] },
        coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y]" },
        text: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

const SYSTEM = "你在操作一台电脑。每次只调用一次 computer 工具，不要输出多余的文字。";
const TASK = "我会让你点击屏幕上的一些目标。先截一张图。";

async function group(ep: EndpointConfig, ev: Evidence, thinking: (typeof THINKINGS)[number], conv: (typeof CONVS)[number], png: Buffer) {
  const sc = appScene(prng(SEED));
  const extra = thinking === "disabled" ? { thinking: { type: "disabled" } } : {};
  const tools = [tool(conv)];

  let first: CallResult | undefined;
  for (let attempt = 0; attempt < 3 && !first; attempt++) {
    const body = {
      model: ep.model,
      max_tokens: MAX,
      system: SYSTEM,
      messages: [{ role: "user", content: TASK }],
      tools,
      ...extra,
      ...(attempt > 0 ? { tool_choice: { type: "any" } } : {}),
    };
    const r = await call(ep, body);
    ev.write({ kind: "call", step: "call-1", thinking, conv, attempt, request: scrub(body), ok: r.ok, error: r.error, toolUses: r.toolUses, text: r.text, usage: r.usage });
    if (r.ok && r.toolUses.some((t) => t.name === "computer")) first = r;
  }
  if (!first) return [{ thinking, conv, error: "call-1 没有拿到 computer 调用" }];
  const tu = first.toolUses.find((t) => t.name === "computer")!;

  return pool(sc.targets, 3, async (t) => {
    const body = {
      model: ep.model,
      max_tokens: MAX,
      system: SYSTEM,
      messages: [
        { role: "user", content: TASK },
        { role: "assistant", content: toRequestBlocks(first!.blocks) },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: tu.id, content: [{ type: "text", text: `截图完成（${W}x${H}）。` }, imageBlock(png)] },
            { type: "text", text: `请点击：${t.desc}。只调用一次 computer 工具。` },
          ],
        },
      ],
      tools,
      ...extra,
    };
    const r = await call(ep, body);
    const click = r.toolUses.find((u) => u.name === "computer");
    const input = (click?.input ?? {}) as { action?: unknown; coordinate?: unknown };
    const coord = Array.isArray(input.coordinate) && input.coordinate.length === 2 && input.coordinate.every((v) => typeof v === "number")
      ? (input.coordinate as [number, number])
      : undefined;
    let hit = false;
    let errPt: number | undefined;
    if (coord) {
      const lx = conv === "norm1000" ? (coord[0] * LOGICAL_W) / 1000 : (coord[0] * LOGICAL_W) / W;
      const ly = conv === "norm1000" ? (coord[1] * LOGICAL_H) / 1000 : (coord[1] * LOGICAL_H) / H;
      hit = lx >= t.box.x && lx <= t.box.x + t.box.w && ly >= t.box.y && ly <= t.box.y + t.box.h;
      errPt = Math.hypot(lx - (t.box.x + t.box.w / 2), ly - (t.box.y + t.box.h / 2));
    }
    const row = {
      thinking,
      conv,
      target: t.id,
      category: t.category,
      ok: r.ok,
      status: r.status,
      error: r.error?.message?.slice(0, 120),
      action: input.action,
      coordinateValid: !!coord,
      coordinate: input.coordinate,
      hit,
      errPt: errPt === undefined ? undefined : +errPt.toFixed(1),
      toolCalls: r.toolUses.length,
      outputTokens: r.usage["output_tokens"],
      thinkingChars: r.thinkingChars,
      latencyMs: r.latencyMs,
    };
    ev.write({ kind: "call", step: "click", ...row, desc: t.desc, box: t.box, text: r.text, toolUses: r.toolUses, usage: r.usage, request: scrub(body) });
    return row;
  });
}

async function runEndpoint(ep: EndpointConfig) {
  const ev = new Evidence("p2b", ep, { seed: SEED, size: `${W}x${H}`, thinkings: THINKINGS, conventions: CONVS, maxTokens: MAX });
  const [png] = render([specOf(appScene(prng(SEED)), W, H)]);
  const results = [];
  for (const thinking of THINKINGS) {
    const perConv = await Promise.all(CONVS.map((conv) => group(ep, ev, thinking, conv, png!)));
    results.push(...perConv.flat());
  }
  ev.write({ kind: "summary", rows: results });
  console.log(`\n══ P-2b 工具调用定位 · ${ep.name} · ${ep.model} ══  证据：${ev.file}`);
  for (const thinking of THINKINGS) {
    for (const conv of CONVS) {
      const rs = results.filter((r: any) => r.thinking === thinking && r.conv === conv && "hit" in r) as any[];
      const errs = rs.map((r) => r.errPt).filter((e) => typeof e === "number").sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          thinking,
          conv,
          n: rs.length,
          validLeftClick: rs.filter((r) => r.action === "left_click" && r.coordinateValid).length,
          hits: rs.filter((r) => r.hit).length,
          medianErrPt: errs.length ? errs[Math.floor(errs.length / 2)] : undefined,
          misses: rs.filter((r) => !r.hit).map((r) => `${r.target}:${r.category}:${r.action}:${JSON.stringify(r.coordinate)}`),
        }),
      );
    }
  }
}

const eps = endpointsFromArgs(process.argv).map(endpoint);
await Promise.all(eps.map(runEndpoint));
