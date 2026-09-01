/**
 * MCP stdio 客户端 —— 建连、列工具、调工具、收进程。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它住在 `tools/mcp/` 而不是 `packages/harness-runtime/src/ports/`。
 *
 * 诱惑与 `run_shell` 那次一模一样：MCP 看起来像一个"Port"，而 Runtime 里
 * 本来就有一层叫 Port —— 搬进去看着天经地义。搬进去之后 Runtime 就认识了
 * JSON-RPC 与子进程管理，而边界 4 / 6（不许 import 工具包）**一条都抓不到**，
 * 因为它没有 import 任何工具包。边界 12 就是为这条加的。
 *
 * ── 四条从 opencode 生产代码抄来的实战细节 ────────────────────────────
 *
 * 它们都不是读协议能想到的，是踩过才知道的（`packages/opencode/src/mcp/catalog.ts`）：
 *
 *   ① `tools/list` **是分页的** —— cursor 翻页，且要防重复 cursor 死循环
 *   ② `outputSchema` **会解析失败** —— 真实服务器发得出 SDK 解不开的 `$ref`，
 *      处置是把 `outputSchema` 整个 omit 掉重试。**这条是引 SDK 的最好论据**：
 *      手写客户端根本不会预见到它，症状是"某个 server 一接就崩"
 *   ③ `resetTimeoutOnProgress` 要配一个**空的 `onprogress`** —— SDK 只在这个
 *      回调存在时才发 progress token，没有它，长任务会被超时误杀
 *   ④ `structuredContent` 兜底 —— content 空但有结构化结果时要 stringify 回去
 * ══════════════════════════════════════════════════════════════════════
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsResultSchema,
  ResultSchema,
  ToolListChangedNotificationSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";
import { resolveServerCwd } from "./config.js";

/** 一个 MCP 工具的声明（`tools/list` 的一项）。 */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpConnection {
  serverName: string;
  config: McpServerConfig;
  client: Client;
  tools: McpToolDef[];
  serverVersion: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_LIST_PAGES = 1_000;

/**
 * `outputSchema` 解析失败时用的宽容 schema（细节 ②）。
 *
 * 把 `outputSchema` 整个 omit 掉 —— Atlas 本来就不消费它
 * （工具结果按 `content` 处理），丢掉它零损失。
 */
const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
});

/** 判别式照抄 opencode —— SDK 抛出来的是普通 Error，只能按 message 认。 */
function isOutputSchemaValidationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    msg,
  );
}

export async function connectServer(
  serverName: string,
  config: McpServerConfig,
  workspaceRoot: string,
): Promise<McpConnection> {
  const [command, ...args] = config.command;
  if (!command) throw new Error(`MCP 服务器 "${serverName}" 的 command 为空`);

  /**
   * ── 【定】`environment` 必须与 `getDefaultEnvironment()` **合并**，不能替换 ──
   *
   * SDK 的语义是「传了 env 就只用 env」。照配置直接传的话，
   * 一个只写了 `{"PLAYWRIGHT_HEADLESS":"false"}` 的服务器会**拿不到 PATH**，
   * 于是 `npx` 直接找不到 —— 而报错长得像"命令不存在"，
   * 没人会想到是自己多写了一行环境变量。
   *
   * 另一半同样要紧：`getDefaultEnvironment()` 是一份**白名单**
   * （POSIX 上只有 HOME / LOGNAME / PATH / SHELL / TERM / USER），
   * 所以 `.env` 里的 `dashscope_api_key` 不会进子进程。
   * 这与阶段 3.5 给 `run_shell` 修的那条（子进程继承全部 env 含真实端点凭证）
   * 是同一件事，只是这次是 SDK 默认就做对了 —— **别把它改成 `process.env`**。
   */
  const env = { ...getDefaultEnvironment(), ...(config.environment ?? {}) };

  const transport = new StdioClientTransport({
    command,
    args,
    env,
    cwd: resolveServerCwd(config, workspaceRoot),
    // 【定】stderr 继承到 Atlas 的终端。MCP 服务器的启动失败信息几乎全在 stderr，
    // 吞掉它等于把"为什么连不上"变成一个查不出来的问题。
    stderr: "inherit",
  });

  const client = new Client(
    { name: "atlas-workagent", version: "0.1.0" },
    {
      /**
       * 【定】如实声明我们**不支持**什么。
       *
       * `resources` / `prompts` / `sampling` / `roots` v1 都不做，
       * 那就一个都不声明 —— 声明了不实现是本仓明令禁止的形态
       * （"未接线比不写更糟"）。服务器据此不会给我们发那些请求。
       */
      capabilities: {},
    },
  );

  const startup = config.timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT_MS;

  /**
   * `tools/list_changed`：**登记 handler，但只记一句日志，不重新 list。**
   *
   * 【定】这是 Atlas 与 opencode 的一处硬分叉。opencode 收到通知后会重新
   * `tools/list` 并发一个 ToolsChanged 事件 —— 它的工具面本来就是动态的。
   * 而 Atlas 的工具面在 Run 启动时**冻结进 `RunSpec.agentSpec.toolSnapshots`**，
   * §18.2 三条恢复分支的判定读的就是冻结的那一份。
   *
   * 跟着服务器改工具面的后果：一条 transcript 上的同一次 tool_use，
   * resume 时会因为"今天的工具声明"不同而走进**另一条恢复分支**，
   * 而盘上看不出来。CLAUDE.md 里那条【定】说的就是这个
   * （"读不到就抛，不回退到当前配置"）。
   *
   * 登记 handler 而不是不管：不登记的话 SDK 会把未处理的通知当协议错误。
   */
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    console.warn(
      `  [mcp] 服务器 "${serverName}" 宣布工具面已变化 —— Atlas 忽略它。\n` +
        `        工具面在 Run 启动时冻结（§18.2 的恢复分支判定依赖它）。` +
        `要用新工具请重启 Atlas。`,
    );
  });

  /**
   * ══════════════════════════════════════════════════════════════════════
   * 【定】握手失败必须**自己收掉子进程**，不能只是把异常抛出去。
   *
   * `new StdioClientTransport(...)` 之后进程已经 spawn 了。上游
   * （`connectMcpServers`）的 `closeAll()` 只遍历**已经完整连上**的那些 ——
   * 正在失败的这一个从来没进过那份名单，于是它变成孤儿：
   * `npx` 首次拉包超时是很常见的场景，用户重试一次就多一个残留进程，
   * 而 MCP 子进程里常常挂着一个浏览器窗口。
   *
   * 【定】`startup` 要包住 **connect ＋ tools/list 全程**。
   * 它此前只包住 `connect()`，而 `config.ts` 那句「建连 ＋ initialize ＋
   * tools/list 的总上限」照旧写着 —— 又一处声明与实现不符。
   * 一个每页都刚好不超时的分页服务器，可以用 1000 页把启动拖到天荒地老，
   * 而那条"总上限"一次都不会生效。
   * ══════════════════════════════════════════════════════════════════════
   */
  const deadline = Date.now() + startup;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    await withTimeout(
      client.connect(transport),
      remaining(),
      `连接 MCP 服务器 "${serverName}" 超时（startup 预算 ${startup}ms）`,
    );

    const tools = await withTimeout(
      listAllTools(client, config.timeout?.request ?? DEFAULT_REQUEST_TIMEOUT_MS),
      remaining(),
      `列举 MCP 服务器 "${serverName}" 的工具超时（startup 预算 ${startup}ms 已用尽）`,
    );
    const info = client.getServerVersion();

    return {
      serverName,
      config,
      client,
      tools,
      serverVersion: typeof info?.version === "string" ? info.version : "0.0.0",
    };
  } catch (err) {
    // 【定】先收进程，再把原因抛出去 —— 收进程失败不得盖住真正的失败原因。
    try {
      await transport.close();
    } catch {
      /* 已经死掉的 transport 关不上是正常的 */
    }
    throw err;
  }
}

/** 分页拉完整个工具面（细节 ①）。 */
async function listAllTools(client: Client, timeout: number): Promise<McpToolDef[]> {
  const out: McpToolDef[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params = cursor === undefined ? undefined : { cursor };
    let result: { tools: unknown[]; nextCursor?: string };
    try {
      result = (await client.listTools(params, { timeout })) as typeof result;
    } catch (err) {
      if (!isOutputSchemaValidationError(err)) throw err;
      // 细节 ②：把 outputSchema 摘掉再来一次。
      result = (await client.request(
        { method: "tools/list", params: params ?? {} },
        TolerantListToolsResultSchema,
        { timeout },
      )) as typeof result;
    }

    for (const t of result.tools) out.push(t as McpToolDef);
    if (result.nextCursor === undefined) return out;
    /**
     * 【定】重复 cursor 必须抛，不能"就当到头了"。
     *
     * 一个发回同一个 cursor 的服务器会让上面这个循环跑满 1000 页，
     * 每页都把同一批工具 push 一遍 —— 而"到头了"这个善意的处置会把
     * 一个服务器 bug 变成"工具面莫名其妙少了一半"。
     */
    if (seen.has(result.nextCursor)) {
      throw new Error(`MCP tools/list 返回了重复的 cursor："${result.nextCursor}"`);
    }
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`MCP tools/list 超过 ${MAX_LIST_PAGES} 页，判定为分页没有终点`);
}

export interface CallResult {
  /** 拼好的文本。image / resource 块会在这里留下一句说明，见 `renderContent`。 */
  text: string;
  isError: boolean;
  /** 有没有 Atlas 送不进上下文的块（image / resource）。 */
  droppedBlocks: string[];
}

export async function callTool(
  conn: McpConnection,
  mcpToolName: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs: number; onProgress: (note: string) => void },
): Promise<CallResult> {
  /**
   * ══════════════════════════════════════════════════════════════════════
   * 【定】走 `request` ＋ **宽松的 `ResultSchema`**，不用 `callTool` 的
   * 严格 `CallToolResultSchema`。与 `tools/list` 的 tolerant 回退是**同一条纪律**。
   *
   * 实测（`ResultSchema` 是 passthrough，严格 schema 不是）：
   *
   *   严格 CallToolResultSchema 接受未知块?  false
   *   ResultSchema 接受?                     true（且字段原样保留）
   *
   * `CallToolResultSchema.content` 是**五种已知块类型的 union**。服务器返回一个
   * SDK 还不认识的块类型（协议在演进，这与细节 ② 的 `outputSchema` 同族）
   * → 整个 parse 失败 → 抛异常 → `handler.classify()` 把它报成
   * **「没有收到服务器回话」**。那是**假话**：服务器回话了，只是形状 SDK 不认识，
   * 而 `sideEffectState: UNKNOWN` 的理由（"请求可能已生效但结果没回来"）
   * 在这种情形下根本不成立。
   *
   * 后果比归因失真更重：那个工具**整个废掉** —— 模型看得见它、调得动它、
   * 每次被挡在门口、且无从改对。这正是放宽 `JsonSchema` 时要避免的失败形态，
   * 当时只在入参那一侧做到了，返回值这一侧漏了。
   *
   * `renderContent` 本来就是按开放对象读 `block.type` 的 ——
   * **严格 schema 是唯一逼死它的东西。**
   * ══════════════════════════════════════════════════════════════════════
   */
  const result = await conn.client.request(
    { method: "tools/call", params: { name: mcpToolName, arguments: args } },
    ResultSchema,
    {
      ...(opts.signal ? { signal: opts.signal } : {}),
      timeout: opts.timeoutMs,
      /**
       * 细节 ③：这两行是**成对**的。
       *
       * `onprogress` 存在，SDK 才会在请求里带 progressToken，服务器才会发
       * 进度通知，`resetTimeoutOnProgress` 才有东西可重置。少写 `onprogress`
       * 的话另一行静默失效 —— 一个开着但永远不生效的开关。
       *
       * 顺带把进度转给 Atlas 的 `ctx.onProgress`。注意工具声明的是
       * `progressReporting: NONE`（"允许偶尔报，不承诺节奏"）——
       * 因为**服务器发不发进度通知完全由它自己决定**，
       * 声明 HEARTBEAT 就是承诺一个可能不存在的节奏。
       */
      resetTimeoutOnProgress: true,
      onprogress: (p) => {
        const pct =
          typeof p.total === "number" && p.total > 0
            ? `${Math.round((p.progress / p.total) * 100)}%`
            : `${p.progress}`;
        opts.onProgress(`${mcpToolName}：${p.message ?? pct}`);
      },
    },
  );

  // `ResultSchema` 是 passthrough，字段原样保留 —— 按开放对象读。
  const open = result as Record<string, unknown>;
  const rendered = renderContent(open);
  return { ...rendered, isError: open["isError"] === true };
}

/**
 * `CallToolResult.content` 是一个**块数组**，而 Atlas 的
 * `ToolExecutionOutcome.output` 是一个 string。这里做那次收敛。
 *
 * 【定】image / resource 块**不假装成功**，而是在文本里留下一句点名的说明。
 *
 * 与 `fetch_url` 对二进制的处置同一条纪律：把一段 base64 图片
 * `toString()` 塞进上下文，得到的是几十万个无意义 token，而模型
 * **没有任何办法看出那是解码垃圾**。反过来，静默丢掉它同样糟 ——
 * 模型会以为自己看到了截图的全部内容。所以：丢掉正文，但说出来丢了什么。
 *
 * 这是 ADR-0010 那个洞的同族（二进制在类型层进不去），登记待办，v1 不补。
 */
function renderContent(result: Record<string, unknown>): {
  text: string;
  droppedBlocks: string[];
} {
  const blocks = Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
  const texts: string[] = [];
  const dropped: string[] = [];

  for (const b of blocks) {
    const block = b as { type?: string; text?: string; mimeType?: string };
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      continue;
    }
    dropped.push(block.type ?? "(未声明类型)");
  }

  // 细节 ④：没有任何 content 块但有结构化结果时，把它 stringify 回去。
  if (texts.length === 0 && dropped.length === 0 && result["structuredContent"] !== undefined) {
    texts.push(JSON.stringify(result["structuredContent"]));
  }

  if (dropped.length > 0) {
    const counted = [...new Set(dropped)].map((k) => `${k}×${dropped.filter((d) => d === k).length}`);
    texts.push(
      `\n[Atlas] 这次返回里还有 ${dropped.length} 个非文本块（${counted.join("、")}），` +
        `它们**没有进入上下文** —— Atlas 的工具结果通道当前只装得下文本。` +
        `不要假设你看到了它们的内容。`,
    );
  }

  /**
   * 【定】什么都没有时要**说出来**，不能返回一个空成功。
   *
   * 一个 `ok:true` ＋ 空 output，在模型那里读起来像"执行了，没什么可说的"；
   * 而实际情况是"服务器什么都没回"。两者该引出的下一步动作不同
   * （前者继续走，后者应该怀疑这次调用）。与 `read_blob` 那条
   * 「分页不是截断，得让它看得出还有下一页」同一条纪律。
   */
  if (texts.length === 0) {
    texts.push("[Atlas] 这次调用成功了，但服务器没有返回任何内容块。");
  }

  return { text: texts.join("\n"), droppedBlocks: dropped };
}

export async function closeConnection(conn: McpConnection): Promise<void> {
  try {
    await conn.client.close();
  } catch {
    /* 收进程失败不该盖住真正的退出原因 */
  }
}

/**
 * `client.connect()` 自己不带超时，而一个卡在启动的 MCP 服务器
 * 会让 Atlas **永远起不来**且没有任何输出 —— 那是最难排查的一种失败。
 */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const REQUEST_TIMEOUT_FALLBACK_MS = DEFAULT_REQUEST_TIMEOUT_MS;
