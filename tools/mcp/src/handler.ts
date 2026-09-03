/**
 * MCP 工具的 `ToolHandlerPort` 实现。
 *
 * 它接进 `CompositeToolHandler`（`apps/cli/src/composite.ts`），
 * 按工具名路由 —— 那一跳就是用户口中的"路由到这个 mcp"，
 * 纯查表、零智能。**工具选哪个是模型的事**，与 opencode 一致。
 */

import type {
  PreparedAction,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolHandlerPort,
} from "@workagent/harness-runtime";
import { makeError } from "@workagent/harness-runtime";
import { callTool, type McpConnection } from "./client.js";
import type { BridgedTool } from "./tool-bridge.js";

export interface McpRoute {
  tool: BridgedTool;
  conn: McpConnection;
}

export class McpToolHandler implements ToolHandlerPort {
  constructor(private readonly routes: ReadonlyMap<string, McpRoute>) {}

  handles(toolName: string): boolean {
    return this.routes.has(toolName);
  }

  async execute(action: PreparedAction, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const route = this.routes.get(action.toolName);
    if (!route) {
      /**
       * 组合器按 `handles()` 路由，理论上到不了这里。但一旦路由表与工具清单
       * 不同步，这条分支是唯一会喊出来的地方 —— 与 `CommonToolHandler`
       * 的 default 分支同一条纪律：不认识的工具名必须如实报，不能默默成功。
       */
      return fail(
        "TOOL_NOT_FOUND",
        "NOT_FOUND",
        "AFTER_MODEL_CORRECTION",
        "NOT_STARTED",
        `@workagent/tools-mcp 里没有名为 "${action.toolName}" 的工具`,
      );
    }

    const { tool, conn } = route;
    const args = (action.normalizedInput ?? {}) as Record<string, unknown>;

    /**
     * 【定】档位决定失败时的 `sideEffectState`，这不是审批偏好的副产品。
     *
     *   read    → NO_EFFECT：一次失败的只读调用确实没有改变外部世界
     *   execute → UNKNOWN  ：Atlas 不理解这个工具做了什么，也没有办法观察
     *
     * `UNKNOWN` 的去向已回源码确认：`settle-batch.ts` push 一个 RecoveryItem →
     * `settle-outcome.ts` 把 kind 降成 `COMPLETED_WITH_LIMITS`。
     * 也就是说 **execute 档的工具每报错一次，这个 Run 就再也拿不到 SUCCESS**。
     * 这是刻意的：Atlas 真的不知道那次点击发生了没有。
     * 用户觉得降级太频繁时，正确的处置是把只读工具标成 `"read"`，
     * 而不是在这里改成 NO_EFFECT —— 那是在事实表里写假话。
     */
    const failedState = tool.tier === "read" ? ("NO_EFFECT" as const) : ("UNKNOWN" as const);

    try {
      const r = await callTool(conn, tool.mcpToolName, args, {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        timeoutMs: tool.timeoutMs,
        onProgress: (note) => ctx.onProgress(note),
      });

      if (r.isError) {
        /**
         * 【定】`isError: true` 是**工具自己报告的失败**，不是传输故障。
         *
         * opencode 在这里直接 `throw` —— 它没有 `sideEffectState` 这一维。
         * Atlas 要把它落成结构化失败：错误文本进 safeMessage，
         * 副作用状态按档位填。`AFTER_MODEL_CORRECTION` 是对的重试性 ——
         * 元素没找到、选择器写错这类，模型换个参数确实可能成功。
         *
         * 【定】category 是 `UNKNOWN`，**不是**新造一个 `EXECUTION`。
         *
         * MCP 的 `isError` 只有**一个 bit** ——「失败了」，外加一段自由文本。
         * 协议本身不带任何分类信息，所以 Atlas 真的不知道这是超时、
         * 权限、还是元素找不到。`UNKNOWN` 是这里唯一诚实的值。
         * （顺带：`EXECUTION` 不在 `ACTIVE_ERROR_CATEGORIES` 里，
         * 写它会被 `assertActiveErrorDomain()` 当场抛成"错误值域越界" ——
         * 而那正是 D-22 那份声明存在的意义。）
         */
        return {
          ok: false,
          /**
           * ── 【定】服务器原文放 `output`，**不放 `safeMessage`** ──────────────
           *
           * `safeMessage` 的契约是「**已脱敏**，可以展示给用户」
           * （`types/error.ts`），而这里的 `r.text` 是**任意外部内容** ——
           * 一个页面的报错文本里可能有 session token、Cookie、内网主机名，
           * 一个恶意 MCP 更可以主动把敏感数据塞进错误文本。
           *
           * 把它写进 `safeMessage` 就绕过了 `settle-batch` 第 ⑥ 步的脱敏
           * （那一步只处理 `output`），未脱敏原文会直接落 transcript 与下一轮
           * 上下文 —— 违反不变量 13。放 `output` 之后它走正常脱敏管道，
           * 而 `settle-batch` 的失败分支会把脱敏后的正文一并交给模型，
           * 所以模型该看到的细节一个字都不少。
           */
          output: r.text,
          ...(r.resources.length > 0 ? { resources: r.resources } : {}),
          sideEffectState: failedState,
          error: makeError({
            code: "MCP_TOOL_ERROR",
            source: "TOOL_HANDLER",
            category: "UNKNOWN",
            retryability: "AFTER_MODEL_CORRECTION",
            sideEffectState: failedState,
            // 只写 Atlas 自己生成的话：服务器名、工具名、以及去哪看原文。
            safeMessage:
              `MCP 工具 ${tool.serverName}/${tool.mcpToolName} 报告失败` +
              (r.text.trim() ? "，服务器给出的说明在结果正文里。" : "，服务器没有给出说明。"),
          }),
        };
      }

      return {
        ok: true,
        output: r.text,
        ...(r.resources.length > 0 ? { resources: r.resources } : {}),
        /**
         * 【定】成功时也**不能**一律报 NO_EFFECT。
         *
         * `read` 档是人声明过只读的，报 NO_EFFECT 是如实；
         * `execute` 档做了什么 Atlas 不知道，但它**成功了** ——
         * 所以是 `APPLIED`（副作用已发生），不是 UNKNOWN。
         * 把成功也报成 UNKNOWN 会让每一次正常调用都 push 一个 RecoveryItem，
         * 那个降级信号立刻变成一盏永远亮着的灯。
         */
        sideEffectState: tool.tier === "read" ? "NO_EFFECT" : "APPLIED",
      };
    } catch (err) {
      return classify(err, tool);
    }
  }
}

/**
 * 传输层 / 超时 / 取消的分类。
 *
 * 【定】这里**一律** `UNKNOWN`（含 read 档）。
 *
 * 与上面 `isError` 那条的差别是关键：`isError` 是服务器**回话了**说自己失败了，
 * 而走到这里意味着我们**没有收到回话** —— 请求可能已经打到浏览器上并生效了，
 * 只是结果没回来。`fetch_url` 在重定向终点被拒时把 `sideEffectState` 从
 * `NO_EFFECT` 改成 `UNKNOWN`，理由一字不差：请求已经发出去过了。
 */
function classify(err: unknown, tool: BridgedTool): ToolExecutionOutcome {
  const e = err as { name?: string; message?: string; code?: number };
  /**
   * 【定】异常正文同样走 `output`，不进 `safeMessage`。
   *
   * 理由与上面 `isError` 那条完全相同：一个 JSON-RPC 错误的 message 是
   * **服务器写的**，它可以装任何东西。「它是异常不是返回值」不改变
   * 「它是外部内容」这个事实。
   */
  const detail = String(e?.message ?? err).slice(0, 2000);
  const where = `${tool.serverName}/${tool.mcpToolName}`;

  if (e?.name === "AbortError") {
    return fail(
      "MCP_CALL_ABORTED",
      "CANCELLED",
      "SAME_INPUT_IMMEDIATE",
      "UNKNOWN",
      `调用 ${where} 被取消。**请求可能已经在外部生效** —— 副作用状态无法判定。`,
      detail,
    );
  }
  return fail(
    "MCP_CALL_FAILED",
    "UNAVAILABLE",
    "SAME_INPUT_BACKOFF",
    "UNKNOWN",
    `调用 ${where} 失败，详情在结果正文里。没有收到服务器回话，**副作用是否已发生无从判断**。`,
    detail,
  );
}

function fail(
  code: string,
  category: "NOT_FOUND" | "CANCELLED" | "UNAVAILABLE",
  retryability: "AFTER_MODEL_CORRECTION" | "SAME_INPUT_IMMEDIATE" | "SAME_INPUT_BACKOFF",
  sideEffectState: "NOT_STARTED" | "UNKNOWN",
  safeMessage: string,
  /** 外部来的正文。走 `output` 是为了让它过脱敏管道，见文件里 A1 那几段。 */
  output = "",
): ToolExecutionOutcome {
  return {
    ok: false,
    output,
    sideEffectState,
    error: makeError({
      code,
      source: "TOOL_HANDLER",
      category,
      retryability,
      sideEffectState,
      safeMessage,
    }),
  };
}
