/**
 * Web 入口（阶段 4）。
 *
 *   npm run ui
 *   npm run ui -- --port 7788 --endpoint deepseek
 *   npm run ui -- --workspace ./somewhere
 *
 * 【定】它与 `npm run dev` 是**同一套装配**（同一个 `compose()`、同一份工具集、
 * 同一个自动放行档位、同一个库、同一个 trace 目录）。两个入口的差别只有一个：
 * 「人在哪」。见 `human-channels.ts` 的文件头。
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUDGET_VALUE_FLAGS,
  budgetFlagHelp,
  parseApprovalMode,
  parseBudgetFlags,
  parseEndpointArg,
  parseSandboxArg,
  REPO_ROOT,
  DEFAULT_STATE_DIR,
  defaultMcpConfigPath,
} from "../../cli/src/compose.js";
import { connectMcpServers } from "@workagent/tools-mcp";
import { startService } from "./server.js";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * 这个入口认识的参数。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】未知参数**必须让命令失败** —— 与 CLI 那条是同一条纪律，
 * 而这里此前**没有**：`arg()` 就是一个裸 `indexOf`，认不出来的参数
 * 悄悄什么都不做。
 *
 * ADR-0012 之前它的代价还只是「`--protx 7788` 起在随机端口上」（看得见，
 * URL 就打在屏幕上）。加了 `--sandbox` 之后代价变了性质：
 * `--sandbx off` 会静默地让服务**带着沙箱**起来，而用户以为自己关掉了；
 * 或者反过来 —— 一个拼错的 `--sandbox of` 会被下面的枚举挡下，
 * 但一个拼错的**参数名**在此前会一路绿灯。
 * 这正是 M-5 那条「静默忽略用户配置比不支持更糟」，而这次被忽略的
 * 那个开关关的是边界。
 * ══════════════════════════════════════════════════════════════════════
 */
const VALUE_FLAGS = [
  "workspace", "port", "endpoint", "mcp-config", "approval", "sandbox",
  // 【定】名字表只从 compose 来 —— 这个文件与 `apps/cli/src/main.ts` 各有一份
  // VALUE_FLAGS（既有的重复）。手打的后果是一个入口认得、另一个报"不认识的参数"。
  ...BUDGET_VALUE_FLAGS,
];

function assertKnownArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) continue;
    const name = raw.slice(2);
    if (VALUE_FLAGS.includes(name)) {
      /**
       * ── 【定】带值参数**必须真的带一个值**（二次评审 P2-4）────────────────
       *
       * 此前是无条件 `i += 1`：参数写在末尾（或后面紧跟另一个 `--flag`）时，
       * `get()` 拿到 undefined，于是**静默回落到默认档**。
       *
       *   npm run … --approval        → 悄悄跑 DEFAULT（用户以为是 auto）
       *   npm run … --sandbox         → 悄悄**带着沙箱**跑（用户以为关掉了）
       *
       * 这正是 M-5 那条「一个被静默吞掉的参数与一个生效的参数不可区分」，
       * 而这次被吞掉的那个开关关的是边界。旧参数（--endpoint / --workspace）
       * 一直有同一个洞，一并堵上。
       */
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(
          `参数 ${raw} 需要一个值，但${value === undefined ? "它是最后一个参数" : `后面紧跟着 ${value}`}。`,
        );
      }
      i += 1; // 跳过它的值，免得值本身被当成参数
      continue;
    }
    throw new Error(
      `不认识的参数 ${raw}。\n` +
        `可用：${VALUE_FLAGS.map((f) => `--${f}`).join(" ")}\n` +
        `  --approval confirm|default|auto   审批档位（默认 default，界面上可随时改）\n` +
        `  --sandbox  on|off                 执行特权（默认 on，**运行中不可改**）\n` +
        // 【定】由表推出，不手写 —— 与 CLI 那一处同源。
        `${budgetFlagHelp()}\n` +
        `  （预算轴也可以在界面「新任务」栏里逐 Run 覆盖）` +
        (name === "yes-all"
          ? `\n\n（\`--yes-all\` 已改成 \`--approval auto\`，ADR-0012。它现在两个入口都有。）`
          : ""),
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownArgs(argv);
  const workspaceRoot = resolve(arg(argv, "workspace") ?? resolve(REPO_ROOT, ".workagent-workspace"));
  const endpoint = parseEndpointArg(argv);
  const portArg = arg(argv, "port");
  // ADR-0012：两条轴，与 CLI 同一份解析函数（抄一份就会分叉）。
  const approvalMode = parseApprovalMode(arg(argv, "approval"));
  const executionPrivilege = parseSandboxArg(arg(argv, "sandbox"));

  // 【定】没有 `--db` / `--trace-dir`：存储位置由 workspace 唯一推出
  // （`workspaceStorage()`），CLI 与界面同一条规则。
  mkdirSync(workspaceRoot, { recursive: true });

  /**
   * ── 【定】MCP 连一次，跨 workspace 切换**复用同一个连接** ────────────────
   *
   * `WorkspaceHosts` 每次切换会关掉旧 `RunHost`、开一个新的（也就是重新
   * `compose()`）。如果 MCP 跟着 RunHost 走，切一次目录就等于**关掉浏览器、
   * 丢掉登录态** —— 而用户完全不会把这两件事联系起来。
   *
   * 这也是 `mcp.json` 放在 `.workagent-state/` 而不是 `<ws>/.workagent/`
   * 的原因：那个浏览器窗口不属于任何一个 workspace。
   *
   * 【定】连不上就抛，Atlas 起不来（ADR-0011）。降级成"少几个工具"的失败
   * 形态特别难查：同一句任务昨天能开浏览器今天不能，而 Run 照常跑到底。
   */
  const mcp = await connectMcpServers({
    configPath: arg(argv, "mcp-config") ?? defaultMcpConfigPath(),
    workspaceRoot,
  });

  const svc = await startService({
    workspaceRoot,
    endpoint,
    approvalMode,
    executionPrivilege,
    // `--max-turns` 等八条轴：这是**启动档**（每个新 Run 的默认预算）。
    // 界面「新任务」栏里的输入框压在它之上，逐 Run 生效。
    composeOverrides: { mcp, budgetOverrides: parseBudgetFlags(argv) },
    /**
     * 【定】注册表放在 `.workagent-state/` 而不是某个 workspace 里面。
     *
     * 它记的是「有哪些 workspace」—— 一份**跨 workspace** 的产品状态。
     * 放进其中一个 workspace 的话，切到别的目录之后就找不着这张表了
     * （而那正是「切换」这个功能要解决的问题）。
     */
    registryFile: resolve(REPO_ROOT, DEFAULT_STATE_DIR, "workspaces.json"),
    // 【定】默认随机端口（§22.6）。`--port` 是给「我要把它固定在书签里」的人用的，
    // 代价是端口可预测 —— 但 Token 与 Origin/Host 校验仍然在，那才是边界。
    ...(portArg ? { port: Number(portArg) } : {}),
  });

  const info = svc.host.info();
  const wsList = svc.workspaces.list();
  console.log(`workspace : ${info.workspaceRoot}`);
  console.log(`  （已登记 ${wsList.length} 个，可在界面左上角切换 / 新建）`);
  console.log(`db        : ${info.dbPath}`);
  console.log(`trace     : ${info.traceDir}`);
  console.log(`endpoint  : ${info.endpoint}（${info.endpointHost}）`);
  console.log(`profile   : ${info.profileId}`);
  console.log(`model     : ${info.modelId}`);
  console.log(`工具      : ${info.toolNames.length} 个，固定开销起步价 ≈ ${info.fixedOverheadTokens} token`);
  // 【定】档位与 CLI 一样要打出来，且用同一个 `describeModes()`。
  // 一次对用户可见的边界让渡而不打印，等于没通知。
  console.log(`modes     : ${info.approvalMode}`);
  if (info.fullAccessWarning) console.log(`\x1b[31m⚠️  ${info.fullAccessWarning}\x1b[0m`);
  if (executionPrivilege === "UNRESTRICTED") {
    // 【定】把「这一档不能在界面上改」说出来。界面上审批那个开关是活的，
    // 用户很容易以为旁边那条也是 —— 而它不是（随 RunSpec 冻结）。
    console.log(`            执行特权随 Run 冻结，界面上改不了；要换请重启并调整 --sandbox。`);
  }
  /**
   * 预算：只打**被覆盖的**轴，与 CLI 同一条口径。
   * 默认值不打（界面「预算」页与每个 Run 冻结的 spec 上都查得到）。
   */
  const budgetLine = info.budgetDefaults
    .filter((a) => a.axis in parseBudgetFlags(argv))
    .map((a) => `${a.field} ${a.limit}`)
    .join("，");
  if (budgetLine) console.log(`budget    : ${budgetLine}（启动档，界面上可逐 Run 再改）`);
  for (const n of info.notices) {
    console.log(`⚠️  ${n.text}`);
    // 终端照旧全打。折叠是**界面**的处置 —— 顶栏只有几行高，scrollback 没有上限。
    if (n.detail) console.log(`  ${n.detail}`);
  }
  console.log(`\n白盒界面已启动，用浏览器打开（**这个 URL 带着会话 Token，别贴出去**）：\n`);
  console.log(`  \x1b[36m${svc.url}\x1b[0m\n`);
  console.log(`Ctrl+C 停止。停止时正在跑的 Run 会被取消（等人的请求一并中断）。`);

  const stop = async (): Promise<void> => {
    console.log("\n正在停止……");
    await svc.close();
    // MCP 子进程（浏览器）也要收掉 —— 不收的话它会留在后台，
    // 而下次启动会再开一个，用户只会看到「浏览器窗口越来越多」。
    await mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err) => {
  console.error(`\n启动失败：${(err as Error).message}`);
  process.exit(1);
});
