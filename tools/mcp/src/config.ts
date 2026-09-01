/**
 * MCP 配置的解析（`mcp.json`）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 字段形状照抄 opencode 的 `ConfigV2.MCP`
 * （`packages/core/src/config/mcp.ts`）—— `type` / `command` / `cwd` /
 * `environment` / `disabled` / `timeout`。用户已有的 `opencode.json` 里那段
 * 几乎可以原样搬过来，这是"换个 MCP 只改配置"这条要求的一部分。
 *
 * Atlas 独有的只有两个：`required` 与 `tools`。它们不是为了多几个旋钮，
 * 是因为 Atlas 的 `ToolDefinition` 有七个必填声明而 MCP 协议一个都不提供，
 * 那些值必须有个来源 —— 见 `tool-bridge.ts` 的来源表。
 *
 * ── 【定】不读 MCP 的 `annotations`，一行都不读 ────────────────────────
 *
 * MCP 的 `Tool.annotations` 里有 `readOnlyHint` / `destructiveHint` /
 * `idempotentHint`，看起来正好能填上 Atlas 缺的那几个字段。**不许用。**
 *
 * 它们是**服务器自述**的，而 MCP 规范自己就写着这些是 untrusted hint。
 * 拿它决定审批档位，等于让被审计方书写自己的审计规则 —— 与本仓已经拍板过的
 * 两条同源：`shouldUseSandbox` 的「命令名匹配不是安全边界」、
 * 以及「审批界面可被 ANSI 伪造」。
 *
 * 授权的来源只能是**人**：要么是这里的 `tools` 段（人写的），
 * 要么是默认的最保守档（人没写，那就按最坏的算）。
 * 这段注释是刻意留的 —— 没有它，下一个人会觉得"annotations 现成的为什么不用"。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * 一个 MCP 工具的档位。**一个词说三件事**（见 `tool-bridge.ts`）。
 *
 * 【定】用 `read` / `execute` 而不是 opencode 的 `allow` / `ask`。
 *
 * `allow` 表达的是**偏好**（"别问我"），`read` 表达的是**属性**（"它只读"）。
 * Atlas 的同一个声明还要决定另外两件事：§18.2 走哪条恢复分支、
 * 以及工具报错时 `sideEffectState` 填 `NO_EFFECT` 还是 `UNKNOWN`。
 * 从"别问我"推出"所以它只读"是一次不成立的合并 —— 一个人完全可能
 * 想给某个写工具免审批，那时 Atlas 会跟着把它记成"没有副作用"，
 * 而那是在事实表里写假话。
 */
export type ToolTier = "read" | "execute";

export interface McpTimeout {
  /** 建连 ＋ initialize ＋ tools/list 的总上限。 */
  startup?: number;
  /** 建连之后每次请求的上限。 */
  request?: number;
}

export interface McpServerConfig {
  /** 【定】v1 只有 `"local"`（stdio）。字段先留着，加 remote 时不是破坏性变更。 */
  type: "local";
  command: string[];
  /**
   * MCP 子进程的工作目录。相对路径按**建连时**的 workspace 解析。
   *
   * ⚠️ 【定】"建连时"这三个字是硬的：MCP 进程绑 Atlas 会话、**跨 workspace 复用**
   * （登录态在浏览器进程里，切一次目录就重连等于重新登录一次）。
   * 所以它的 cwd 在服务启动那一刻就固化了，**此后不随活跃 workspace 变**。
   *
   * 后果是真实的、也必须写在这里：MCP 服务器写出的相对路径文件
   * （Playwright 的 `.playwright-mcp/`、`browser_evaluate` 的结果文件…）
   * 永远落在**启动时**那个 workspace 里。在界面上切到另一个 workspace 之后，
   * 那个 Run 的 `read_file` 按**它自己的** workspaceRoot 解析，两者不再重合。
   */
  cwd?: string;
  environment?: Record<string, string>;
  disabled?: boolean;
  /**
   * 连不上时是抛还是只警告。**默认 true（抛）**。
   *
   * 【定】默认在"炸掉"那一侧，与 `DeclarativeEffectResolver` 的 RESOLVER
   * 分支同一条纪律：装配漏了必须在第一时间说出来。降级的失败形态特别难查 ——
   * 同一句任务昨天能开浏览器今天不能，而 Run 照常跑到底，
   * 最后告诉你「我访问不了那个页面」。
   */
  required?: boolean;
  timeout?: McpTimeout;
  /**
   * 逐工具档位。**不写 = 全部 `execute`**（最保守）。
   *
   * 值得写下来的是：跑几次之后你**应该**把只读工具标出来，
   * 而理由不是"审批问得烦"—— 是 `execute` 档报错时记 `UNKNOWN`，
   * 那会 push 一个 RecoveryItem，让这个 Run 永远结算不成 `SUCCESS`
   * （`settle-outcome.ts` 第 77 行那一支）。浏览器自动化里报错很常见，
   * 于是那个降级信号会变成一盏**永远亮着的灯**，也就等于没有灯。
   */
  tools?: Record<string, ToolTier>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export const EMPTY_MCP_CONFIG: McpConfig = { servers: {} };

const SERVER_KEYS = new Set([
  "type",
  "command",
  "cwd",
  "environment",
  "disabled",
  "required",
  "timeout",
  "tools",
]);

/**
 * 读一份 `mcp.json`。**文件不存在不是错误**（绝大多数用户没有 MCP）。
 *
 * 【定】除此之外一律**报错，不静默忽略**：拼错的字段、不认识的档位、
 * 空的 command。M-5 那条教训说的就是这个形态 ——
 * 一个被静默吞掉的配置项与一个不支持的配置项，在用户那里完全不可区分。
 */
export function loadMcpConfig(path: string): McpConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return EMPTY_MCP_CONFIG;
    throw new Error(`读取 MCP 配置 ${path} 失败：${(err as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`MCP 配置 ${path} 不是合法 JSON：${(err as Error).message}`);
  }

  return parseMcpConfig(raw, path);
}

/** 【定】export 是为了让 `verify:mcp` 能直接喂各种坏配置，不必每次落盘。 */
export function parseMcpConfig(raw: unknown, source: string): McpConfig {
  const at = (what: string) => `${source} 的 ${what}`;
  if (!isPlainObject(raw)) throw new Error(`${source} 顶层必须是一个对象`);

  const unknownTop = Object.keys(raw).filter((k) => k !== "servers" && k !== "$schema" && !isComment(k));
  if (unknownTop.length > 0) {
    throw new Error(`${source} 顶层有不认识的字段：${unknownTop.join(", ")}（只支持 servers）`);
  }

  const serversRaw = raw["servers"];
  if (serversRaw === undefined) return EMPTY_MCP_CONFIG;
  if (!isPlainObject(serversRaw)) throw new Error(`${at("servers")} 必须是一个对象`);

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, sRaw] of Object.entries(serversRaw)) {
    servers[name] = parseServer(name, sRaw, at);
  }
  return { servers };
}

function parseServer(
  name: string,
  raw: unknown,
  at: (what: string) => string,
): McpServerConfig {
  const where = at(`servers.${name}`);
  if (!isPlainObject(raw)) throw new Error(`${where} 必须是一个对象`);

  /**
   * 【定】`type` 必须**先于**未知字段检查。
   *
   * 顺序反过来的话，一份 remote 配置会被 `url` 这个字段先拦下，报
   * 「有不认识的字段：url」—— 于是用户以为是自己写错了字段名，去把 url 删掉，
   * 而真正的事实是**远程传输还没实现**。报错指向错误的地方比不报错更费时间。
   */
  const type = raw["type"] ?? "local";
  if (type !== "local") {
    throw new Error(
      `${where}.type = "${String(type)}"，而当前只支持 "local"（stdio）。\n` +
        `远程传输（SSE / streamable-http）**尚未实现** —— 不是配置写错了，是这个能力还没做。\n` +
        `（配置结构已经为它留好了 \`type\` 这一档，加的时候不是破坏性变更。）`,
    );
  }

  const unknown = Object.keys(raw).filter((k) => !SERVER_KEYS.has(k) && !isComment(k));
  if (unknown.length > 0) {
    throw new Error(
      `${where} 有不认识的字段：${unknown.join(", ")}。` +
        `支持的字段：${[...SERVER_KEYS].join(", ")}`,
    );
  }

  const command = raw["command"];
  if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string")) {
    throw new Error(`${where}.command 必须是非空的字符串数组，例如 ["npx","-y","@playwright/mcp@latest"]`);
  }

  const environment = raw["environment"];
  if (environment !== undefined) {
    if (!isPlainObject(environment) || !Object.values(environment).every((v) => typeof v === "string")) {
      throw new Error(`${where}.environment 必须是 string → string 的对象`);
    }
  }

  const timeoutRaw = raw["timeout"];
  let timeout: McpTimeout | undefined;
  if (timeoutRaw !== undefined) {
    if (!isPlainObject(timeoutRaw)) throw new Error(`${where}.timeout 必须是一个对象`);
    const bad = Object.keys(timeoutRaw).filter((k) => k !== "startup" && k !== "request");
    if (bad.length > 0) {
      throw new Error(`${where}.timeout 有不认识的字段：${bad.join(", ")}（只支持 startup / request）`);
    }
    timeout = {};
    for (const k of ["startup", "request"] as const) {
      const v = timeoutRaw[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        throw new Error(`${where}.timeout.${k} 必须是正数毫秒`);
      }
      timeout[k] = v;
    }
  }

  const toolsRaw = raw["tools"];
  let tools: Record<string, ToolTier> | undefined;
  if (toolsRaw !== undefined) {
    if (!isPlainObject(toolsRaw)) throw new Error(`${where}.tools 必须是一个对象`);
    tools = {};
    for (const [toolName, tier] of Object.entries(toolsRaw)) {
      if (tier !== "read" && tier !== "execute") {
        throw new Error(
          `${where}.tools["${toolName}"] = ${JSON.stringify(tier)}，而档位只有 "read" 与 "execute"。\n` +
            `  read    ：只读 ＋ 幂等 ＋ 自动放行 ＋ 报错时记「没有副作用」\n` +
            `  execute ：非只读 ＋ 非幂等 ＋ 逐次审批 ＋ 报错时记「副作用未知」（默认）`,
        );
      }
      tools[toolName] = tier;
    }
  }

  const disabled = boolField(raw["disabled"], `${where}.disabled`);
  const required = boolField(raw["required"], `${where}.required`);
  const cwd = raw["cwd"];
  if (cwd !== undefined && typeof cwd !== "string") throw new Error(`${where}.cwd 必须是字符串`);

  return {
    type: "local",
    command: command as string[],
    ...(cwd === undefined ? {} : { cwd }),
    ...(environment === undefined ? {} : { environment: environment as Record<string, string> }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(required === undefined ? {} : { required }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(tools === undefined ? {} : { tools }),
  };
}

function boolField(v: unknown, where: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new Error(`${where} 必须是 true 或 false`);
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * `_` 开头的键当注释，忽略。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它**不削弱**「未知字段一律报错」那条。
 *
 * 那条规则防的是**拼写错误**（`enviroment`），而一个拼错的字段名不会
 * 恰好以 `_` 开头 —— 两者不重叠。
 *
 * 为什么值得为它破一个口子：JSON 没有注释，而这份配置是**人手写**的，
 * 里面有几条不写在跟前就一定会被踩的坑 —— 尤其
 * 「`browser_evaluate` 不是只读工具，标成 read 会让审批 / 幂等 / 副作用
 * 三件事一起错且零提示」。把这种警告放进 ADR 而不是放进用户正在编辑的
 * 那个文件，等于知道有坑却不在坑边立牌子。
 * ══════════════════════════════════════════════════════════════════════
 */
function isComment(key: string): boolean {
  return key.startsWith("_");
}

/**
 * 相对 cwd 按 workspace 解析（与 opencode 同一条规则）。
 *
 * ⚠️ 这里的 `workspaceRoot` 是**建连那一刻**的那个，不是"当前活跃的那个" ——
 * 调用点只有一处（服务/CLI 启动时），此后不再重算。见 `McpServerConfig.cwd`。
 */
export function resolveServerCwd(cfg: McpServerConfig, workspaceRoot: string): string {
  if (!cfg.cwd) return workspaceRoot;
  return isAbsolute(cfg.cwd) ? cfg.cwd : resolve(workspaceRoot, cfg.cwd);
}

/** 这个工具的档位。**没写就是 `execute`** —— 默认落最保守那一侧。 */
export function tierOf(cfg: McpServerConfig, mcpToolName: string): ToolTier {
  return cfg.tools?.[mcpToolName] ?? "execute";
}
