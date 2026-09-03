/**
 * 假 MCP 服务器 —— `verify:mcp` 的夹具。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】判据**不许依赖 Playwright**。
 *
 * 三条理由，每条都不是洁癖：
 *   ① 装了 Playwright 才能跑的判据，在没装的机器上等于不存在；
 *   ② 它要下浏览器内核、要联网、会弹窗口 —— 判据不得在被测系统之外留痕
 *      （阶段 3.5 那个把 `$HOME` 探针文件永久留下的坑）；
 *   ③ **最要紧的**：拿 Playwright 当夹具，测的就成了"Atlas 能不能接
 *      Playwright"，而这一批要答的是"Atlas 能不能接**任意** MCP"。
 *      用一个真实服务器校准，正是本仓反复清理的过拟合形态。
 *
 * 所以这里手写一个协议层的最小实现，并**刻意造出真实服务器的那些难处**：
 * 分页、数组参数、嵌套对象、isError、image 块、运行中的 list_changed 通知。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用法：`node_modules/.bin/tsx <本文件>`，读 stdin 的 newline-delimited
 * JSON-RPC，写 stdout。诊断信息一律走 stderr（写 stdout 会污染协议流）。
 */

import { writeFileSync } from "node:fs";

const pidFile = process.env["FAKE_MCP_PID_FILE"];
if (pidFile) writeFileSync(pidFile, String(process.pid), "utf8");

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/** 工具面分三页返回 —— 逼出客户端的分页实现（细节 ①）。 */
const PAGES: Array<Array<Record<string, unknown>>> = [
  [
    {
      name: "echo_text",
      description: "把 message 原样回显",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "要回显的文本" } },
        required: ["message"],
      },
    },
    {
      /**
       * **判据 D 的载体**：`values` 是数组，`count` 是整数。
       *
       * 放宽 `JsonSchema` 之前，`typeof [] !== "array"` 会让
       * `validateAndNormalize` 直接报 schema 错 —— 工具装得上、模型看得见、
       * 每次调用都被 Runtime 挡在门口，而它无从改对。
       */
      name: "wants_array",
      description: "收一个字符串数组和一个整数，原样回显收到的入参",
      inputSchema: {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "string" }, description: "字符串数组" },
          count: { type: "integer", description: "一个整数" },
        },
        required: ["values"],
      },
    },
  ],
  [
    {
      /** 嵌套对象 ＋ enum ＋ 一个**没有 type** 的属性（oneOf 形态的常见残留）。 */
      name: "wants_object",
      description: "收一个嵌套对象，原样回显",
      inputSchema: {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: { host: { type: "string" }, port: { type: "number" } },
            description: "嵌套配置",
          },
          mode: { type: "string", enum: ["fast", "slow"], description: "带 enum 的字段" },
          anything: { description: "**没有 type** —— 真实服务器里 oneOf/$ref 会留下这种" },
        },
      },
    },
    {
      name: "always_errors",
      description: "总是返回 isError:true",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  [
    {
      name: "returns_image",
      description: "返回一个 image 块 ＋ 一段文本",
      inputSchema: { type: "object", properties: {} },
    },
    {
      /** 第三页存在本身就是判据：漏了分页就看不到它。 */
      name: "page3_marker",
      description: "只在第三页出现 —— 分页没做对就装不上它",
      inputSchema: { type: "object", properties: {} },
    },
    {
      /**
       * **判据 A2 的载体之一**：参数**不在**根 `properties` 里。
       *
       * 这一组四个工具（open_additional / open_pattern / open_ref / open_oneof）
       * 打的是同一个洞：Atlas 曾经在翻译时伪造 `properties: {}`，
       * 然后按那份伪造把模型入参**整个裁掉** —— 校验通过、下游收到 `{}`、
       * 零报错。用了这几种构造的服务器，接上就是坏的，而"换个 MCP 只改配置"
       * 正是这一批的全部卖点。
       */
      name: "open_additional",
      description: "参数是动态键（additionalProperties），根 properties 是空的",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: { type: "string" },
      },
    },
    {
      name: "open_pattern",
      description: "参数由 patternProperties 表达，根 properties 缺席",
      inputSchema: {
        type: "object",
        patternProperties: { "^opt_": { type: "string" } },
      },
    },
    {
      name: "open_ref",
      description: "根级 $ref —— 参数在 $defs 里，根上没有 properties",
      inputSchema: {
        type: "object",
        $ref: "#/$defs/Params",
        $defs: {
          Params: { type: "object", properties: { url: { type: "string" } } },
        },
      },
    },
    {
      name: "open_oneof",
      description: "根级 oneOf —— 参数在分支里，根上没有 properties",
      inputSchema: {
        type: "object",
        oneOf: [
          { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        ],
      },
    },
    {
      /**
       * **判据 B1 的载体**：返回一个 SDK 还不认识的 content 块类型。
       *
       * 严格 `CallToolResultSchema` 会在 parse 阶段就抛，于是这个工具整个废掉，
       * 而 `handler.classify()` 把它报成「没有收到服务器回话」—— 那是假话。
       */
      name: "returns_unknown_block",
      description: "返回一个未知类型的 content 块 ＋ 一段文本",
      inputSchema: { type: "object", properties: {} },
    },
  ],
];

const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const ok = (id: Rpc["id"], result: unknown): void => send({ jsonrpc: "2.0", id, result });

function handle(req: Rpc): void {
  switch (req.method) {
    case "initialize": {
      /**
       * **判据 C1 的载体**：起得来、但永远不回话。
       *
       * 「spawn 失败」（命令不存在）测不出进程泄漏 —— 那种情况下压根没有进程。
       * 要测的是握手卡住那一档：`npx` 首次拉包慢是最常见的现实场景，
       * 而 `withTimeout` 拒绝之后，那个已经 spawn 的子进程如果没人收，
       * 就变成孤儿（用户重试一次多一个，里面常挂着一个浏览器窗口）。
       */
      if (process.env["FAKE_MCP_HANG"] === "1") return;

      // 【定】回客户端请求的那个版本。硬编一个版本会让夹具随 SDK 升级而失效，
      // 而失效的样子是"所有 MCP 判据一起红"，看不出是仪器坏了。
      const asked = (req.params?.["protocolVersion"] as string) ?? "2025-06-18";
      ok(req.id, {
        protocolVersion: asked,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake-mcp-server", version: "9.9.9" },
      });
      return;
    }

    case "notifications/initialized":
      return; // 通知没有响应

    case "tools/list": {
      const cursor = req.params?.["cursor"] as string | undefined;
      const page = cursor === undefined ? 0 : Number(cursor);
      const tools = PAGES[page] ?? [];
      const hasNext = page + 1 < PAGES.length;
      ok(req.id, { tools, ...(hasNext ? { nextCursor: String(page + 1) } : {}) });
      return;
    }

    case "tools/call": {
      const name = req.params?.["name"] as string;
      const args = (req.params?.["arguments"] ?? {}) as Record<string, unknown>;

      if (name === "always_errors") {
        ok(req.id, { content: [{ type: "text", text: "这个工具按设计总是失败" }], isError: true });
        return;
      }
      if (name === "returns_image") {
        ok(req.id, {
          content: [
            { type: "text", text: "这是说明文字" },
            // 1×1 透明 PNG。判据只关心"它被如实报告为丢弃"，不关心内容。
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
            },
          ],
        });
        return;
      }
      if (name === "page3_marker") {
        ok(req.id, { content: [{ type: "text", text: "third page tool reachable" }] });
        return;
      }
      if (name === "returns_unknown_block") {
        ok(req.id, {
          content: [
            // SDK 的 ContentBlockSchema 只认 text/image/audio/resource/resource_link。
            // 协议在演进，这一块模拟"下一个还没被 SDK 认识的类型"。
            { type: "widget_v2", payload: { rows: 3 }, label: "未来的块类型" },
            { type: "text", text: "未知块旁边的正常文本" },
          ],
        });
        return;
      }

      /**
       * 其余一律把**收到的入参**原样回显。
       *
       * 判据 D 靠它：Atlas 声称"参数逐字送达"，而唯一能证明这件事的
       * 就是让服务器把它实际收到的东西说回来 —— 在 Atlas 这一侧断言
       * "我发出去了"只是自比，测不出中间那一跳。
       */
      ok(req.id, { content: [{ type: "text", text: JSON.stringify({ tool: name, received: args }) }] });

      // 回完之后立刻宣布"工具面变了"——判据 H 要看 Atlas 忽略它。
      if (name === "echo_text" && args["message"] === "trigger-list-changed") {
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
      return;
    }

    default:
      if (req.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `fake server 不支持 ${req.method}` },
        });
      }
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  // MCP 的 stdio 传输是 newline-delimited JSON，消息体内不得含换行。
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line) as Rpc);
      } catch (err) {
        process.stderr.write(`fake-mcp-server 解析失败：${String(err)}\n`);
      }
    }
    nl = buf.indexOf("\n");
  }
});
