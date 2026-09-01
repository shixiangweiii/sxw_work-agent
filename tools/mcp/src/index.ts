/**
 * `@workagent/tools-mcp` —— 通用 MCP 客户端能力。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 研究问题：**外部工具面能不能在不放弃 Atlas 声明纪律的前提下接进来？**
 *
 * 起因是一次真实的内网实测失败：「访问内网网页 → 归档」第一步就断，
 * 因为它同时撞上 `fetch_url` 两条已拍板的【定】——护栏 2 拒私网、
 * 以及"不做登录态、不做 Cookie、不做浏览器"。
 *
 * 这个包的价值不在"能开浏览器"，在**凭证从头到尾不进 Atlas**：
 * 人在浏览器里登录，Atlas 只拿渲染后的内容。给 `fetch_url` 加 cookie 参数
 * 则要求一整套凭证解析、脱敏与 Trace 隔离机制，而全仓没有那个东西。
 *
 * ── 硬要求：换个 MCP 只改配置 ─────────────────────────────────────────
 *
 * 本包一个字都不认识 Playwright。工具名、工具数量、参数形状全部来自运行时的
 * `tools/list`。这条要求也是 `JsonSchema` 那次放宽的唯一理由 ——
 * 见 `packages/harness-runtime/src/types/tool.ts` 的文件注释。
 *
 * ── 四条代价，逐条写在 ADR-0011 里，这里只列 ────────────────────────────
 *
 *   ① 沙箱不在（`run_shell` 有 seatbelt，MCP 子进程没有）
 *   ② 护栏 2 被绕过 —— **而这正是它有用的原因**
 *   ③ 登录态是 transcript 之外的隐藏状态
 *   ④ Atlas 的 workspace 边界对 MCP 子进程**不成立**（不是弱，是不存在）
 * ══════════════════════════════════════════════════════════════════════
 */

import type { ToolHandlerPort, ToolSnapshot, TrustedEffectResolver } from "@workagent/harness-runtime";
import { closeConnection, connectServer, type McpConnection } from "./client.js";
import { loadMcpConfig, type McpConfig } from "./config.js";
import { McpToolHandler, type McpRoute } from "./handler.js";
import { bridgeTools } from "./tool-bridge.js";

export * from "./config.js";
export { atlasToolName, sanitize, McpEffectResolver } from "./tool-bridge.js";
export { McpToolHandler } from "./handler.js";
export type { McpConnection, McpToolDef } from "./client.js";

/**
 * 装配好的 MCP 运行时。由**入口**（`main.ts`）持有，跨 Run 存活。
 *
 * 【定】进程生命周期绑 Atlas 会话，不随 Run 起停 ——
 * 登录态在浏览器进程里，随 Run 收掉等于每个 Run 重登一次。
 * 代价：CLI（`npm run dev`，单次命令）跑浏览器任务时每次都要重新登录，
 * 而 `npm run ui`（service 常驻）不用。这条要写进用户文档。
 */
/**
 * 一条给入口显示的诊断。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】`text` 与 `detail` **分成两个字段**，不许把长清单塞进 `text` 让界面
 * 自己按 `\n` 切开。
 *
 * `renderService()` 里已经有一条同源的【定】：「读 `approvalModeId` 这两个
 * **机器字段**，不解析 `approvalMode` 那句人话 —— 那句话为了读着顺改一个字，
 * 徽章就会静默停在错误的位置上」。让 Layer 1 去切一条散文串是同一个错误，
 * 只是换了个方向：这里的文案会为了读着顺而增删换行，而界面上的表现是
 * **该常驻的那句话被折进去了**，或者反过来。
 *
 * 分界线是「用户什么时候需要它」：
 *   text   —— 随时该看见的（几个工具、几个自动放行、输出目录在哪）；
 *   detail —— 用到时才展开的（工具原名清单，写 `tools` 段时照着填）。
 *
 * 【定】这个形状在 `apps/cli/src/compose.ts`（`Notice`）与
 * `apps/workagent-service/src/api-types.ts`（`UiNotice`）各有一份**结构相同**的
 * 声明。不是疏忽：依赖方向是 `apps → tools`，反过来 import 会破坏分层，
 * 而三个字段的形状用结构类型对齐已经足够。改任一处要三处一起改。
 * ══════════════════════════════════════════════════════════════════════
 */
export interface McpNotice {
  text: string;
  detail?: string;
}

export interface McpRuntime {
  snapshots: ToolSnapshot[];
  handler: ToolHandlerPort & { handles(name: string): boolean };
  /** 逐工具一条，注入 `DeclarativeEffectResolver` 的受信任 Resolver 表。 */
  resolvers: Map<string, TrustedEffectResolver>;
  /** 给入口打印的一行行诊断。 */
  notices: McpNotice[];
  close(): Promise<void>;
}

export const EMPTY_MCP_RUNTIME: McpRuntime = {
  snapshots: [],
  handler: new McpToolHandler(new Map()),
  resolvers: new Map(),
  notices: [],
  close: async () => {},
};

export interface ConnectOptions {
  /** `mcp.json` 的路径。文件不存在不是错误。 */
  configPath: string;
  workspaceRoot: string;
  /** 直接给配置，跳过读盘。`verify:mcp` 用它喂夹具。 */
  config?: McpConfig;
}

/**
 * 连上所有启用的 MCP 服务器，把它们的工具翻译成 Atlas 的工具面。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它必须在 `compose()` **之前**跑完，而且是 `await` 的。
 *
 * 工具面要冻结进 `RunSpec.agentSpec.toolSnapshots`（`compose.ts` 的
 * `makeRunSpec`），而 §18.2 三条恢复分支的判定读的就是冻结的那一份。
 * 懒加载（模型第一次要用时才连）会让工具面在 Run 中途长出新工具，
 * 那时冻结的快照里没有它们。
 *
 * `compose()` 因此保持**同步** —— 异步的这一段留在入口，
 * 而"启动时硬失败"本来也该发生在入口。
 *
 * 【定】连不上就抛，不静默少几个工具。
 *
 * 与 `DeclarativeEffectResolver` 的 RESOLVER 分支同一条纪律。降级的失败形态
 * 特别难查：同一句任务昨天能开浏览器今天不能，而 Run 照常跑到底，
 * 最后告诉你"我访问不了那个页面"。要放宽就逐服务器写 `"required": false`，
 * 那是一次显式的、写在盘上的决定。
 * ══════════════════════════════════════════════════════════════════════
 */
export async function connectMcpServers(opts: ConnectOptions): Promise<McpRuntime> {
  const config = opts.config ?? loadMcpConfig(opts.configPath);
  const entries = Object.entries(config.servers).filter(([, c]) => c.disabled !== true);
  if (entries.length === 0) return EMPTY_MCP_RUNTIME;

  const conns: McpConnection[] = [];
  const snapshots: ToolSnapshot[] = [];
  const resolvers = new Map<string, TrustedEffectResolver>();
  const routes = new Map<string, McpRoute>();
  const notices: McpNotice[] = [];

  const closeAll = async () => {
    for (const c of conns) await closeConnection(c);
  };

  for (const [name, serverCfg] of entries) {
    let conn: McpConnection;
    try {
      conn = await connectServer(name, serverCfg, opts.workspaceRoot);
    } catch (err) {
      const why = `MCP 服务器 "${name}" 连接失败：${(err as Error).message}`;
      if (serverCfg.required === false) {
        // 【定】即使放行也要**响亮地说**。一条放行了却没连上的服务器如果不说话，
        // 与"连上了但一个工具都没有"在事后完全不可区分。
        notices.push({
          text: `${why}\n  （该服务器标了 required:false，已跳过 —— 它的工具这次不在工具面里）`,
        });
        continue;
      }
      // 已经连上的那几个要收掉，否则子进程留在后台。
      await closeAll();
      throw new Error(
        `${why}\n\n` +
          `这是装配错误，Atlas 不会带着一个残缺的工具面继续跑。二选一：\n` +
          `  · 修好这个服务器（先手动跑一遍 \`${serverCfg.command.join(" ")}\` 看它报什么）；\n` +
          `  · 或在 mcp.json 里给它加 "disabled": true / "required": false。`,
      );
    }

    conns.push(conn);

    /**
     * ── 【定】`tools` 段里的名字必须**真的存在**，拼错要报错 ────────────────
     *
     * 不查的后果：`tierOf()` 查不到就返回默认档 —— 于是一行
     * `"browser_snapshsot": "read"` 会**静默落回 execute**，用户以为自己
     * 已经把它放行了，实际每次照样问，而且报错时记的还是「副作用未知」。
     *
     * 这正是 M-5 那条教训的形态：一个被静默吞掉的配置项与一个不支持的配置项，
     * 在用户那里完全不可区分。而这里比 M-5 更隐蔽 —— 那个配置**看起来生效了**
     * （没有报错），只是行为没变。
     *
     * 报错时把真实工具名列出来：这个列表只有连上服务器之后才拿得到，
     * 让用户自己去翻文档是把最贵的一步推给他。
     */
    const known = new Set(conn.tools.map((t) => t.name));
    const typos = Object.keys(serverCfg.tools ?? {}).filter((n) => !known.has(n));
    if (typos.length > 0) {
      await closeAll();
      throw new Error(
        `mcp.json 里 servers."${name}".tools 提到了这个服务器没有的工具：${typos.join(", ")}\n\n` +
          `它实际提供的是：\n  ${[...known].join("\n  ")}\n\n` +
          `（不静默忽略：查不到就会落回默认的 execute 档，` +
          `于是这行配置看起来生效了、实际什么都没变。）`,
      );
    }

    const bridged = bridgeTools(conn);
    for (const t of bridged) {
      const dup = routes.get(t.snapshot.definition.name);
      if (dup) {
        await closeAll();
        throw new Error(
          `工具名冲突："${t.snapshot.definition.name}" 同时来自 ` +
            `"${dup.tool.serverName}" 与 "${t.serverName}"。\n` +
            `名字是 sanitize 之后拼的，两个服务器名只差非字母数字字符时会撞。改一个名字。`,
        );
      }
      snapshots.push(t.snapshot);
      resolvers.set(t.resolverKey, t.resolver);
      routes.set(t.snapshot.definition.name, { tool: t, conn });
    }

    const readCount = bridged.filter((t) => t.tier === "read").length;
    /**
     * 【定】把**工具原名**列出来，不只报个数量。
     *
     * 写 `tools` 段时要照着填的正是这些名字（配置里用的是 MCP 原名，
     * 不是加了 `mcp__` 前缀的 Atlas 名）。只报数量的话，用户得先去翻
     * MCP 服务器的文档，或者猜 —— 而猜错的表现是**那一行配置静默不生效**
     * （`tierOf` 查不到就落默认档），没有任何东西会说话。
     *
     * ── 但它归 `detail`，不归 `text`（2026-09-01 界面收窄）──────────────────
     *
     * 24 个 Playwright 工具名把顶栏顶成了 4 行，而顶栏上真正**必须一直看得见**
     * 的是下面那条输出目录警告 —— 一屏噪声里的一行警告等于没有警告。
     *
     * 【定】分界线是「用户什么时候需要它」，不是「重不重要」：
     * 这张清单的用途是**写 `tools` 段时照着填**，那是一次性的配置动作，
     * 展开一次即可；输出目录那条是**每个 Run 都可能踩**的事实。
     */
    const listed = bridged
      .map((t) => (t.tier === "read" ? `${t.mcpToolName}(read)` : t.mcpToolName))
      .join(", ");
    notices.push({
      detail: `工具原名（写 mcp.json 的 tools 段时照着填）：${listed}`,
      text:
        `MCP "${name}"：${bridged.length} 个工具已装配` +
        `（${readCount} 个 read 档自动放行，${bridged.length - readCount} 个 execute 档逐次审批）\n` +
        /**
         * 【定】这一行必须打出来，因为它是一条**用户看不见、但会咬人**的事实。
         *
         * MCP 进程跨 workspace 复用（登录态在浏览器里），所以它的 cwd 在这一刻
         * 固化。切到另一个 workspace 之后，MCP 写出的相对路径文件仍落在这里，
         * 而那个 Run 的 `read_file` 按它自己的根解析 —— 两者不再重合。
         * Case B 之所以跑通，只是因为当时活跃 workspace 恰好就是启动根。
         *
         * ⚠️ 2026-09-01 实测把它从「会咬人」升级成「咬过了」：Run
         * `run_6c3fec671ceb` 里 `browser_evaluate` 把 32 张图的 base64 写进了
         * `.playwright-mcp/img_batch1.json`（MCP 自己的输出目录），
         * 下一轮 `run_shell` 在 Run 的 workspace 里 `cat` 同一个相对路径 →
         * `No such file or directory`，一整轮预算白花。
         * **所以它必须留在 `text` 里，不许跟工具清单一起折进 `detail`。**
         */
        `  ⚠️ 输出目录固定在 ${opts.workspaceRoot}（与之后切换的活跃 workspace 无关）` +
        /**
         * ── 没写 `tools` 段时，说出**真正的**理由 ────────────────────────────
         *
         * 实测（Run `run_18c20267c1a1`）：用户的活配置没有 `tools` 段 →
         * 24 个 Playwright 工具全部落 execute → **11 次调用 = 11 次审批**，
         * 连 `browser_snapshot` 也在问。
         *
         * 【定】这条提示不许写成「审批问得烦」。真正的理由要硬得多：
         * execute 档报错时记 `sideEffectState: UNKNOWN` → push RecoveryItem →
         * `settle-outcome` 降成 `COMPLETED_WITH_LIMITS`，**这个 Run 就再也
         * 拿不到 SUCCESS**。浏览器自动化里报错很常见，于是那个降级信号
         * 会变成一盏永远亮着的灯 —— 也就等于没有灯。
         *
         * 那次没出事只因为**零错误**，是侥幸不是机制。
         */
        (serverCfg.tools === undefined
          ? `\n  ⓘ 没有配 tools 段 —— ${bridged.length} 个工具**全部**逐次审批。` +
            `跑几次之后建议把只读的标成 "read"（照抄 mcp.example.json 里那张表）：` +
            `不是嫌问得烦，是 execute 档**报错一次就让这个 Run 永远拿不到 SUCCESS**` +
            `（UNKNOWN → RecoveryItem → COMPLETED_WITH_LIMITS），` +
            `而浏览器自动化里报错很常见。`
          : ""),
    });
  }

  return {
    snapshots,
    handler: new McpToolHandler(routes),
    resolvers,
    notices,
    close: closeAll,
  };
}
