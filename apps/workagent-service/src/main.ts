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
  parseEndpointArg,
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const workspaceRoot = resolve(arg(argv, "workspace") ?? resolve(REPO_ROOT, ".workagent-workspace"));
  const endpoint = parseEndpointArg(argv);
  const portArg = arg(argv, "port");

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
    composeOverrides: { mcp },
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
  for (const n of info.notices) console.log(`⚠️  ${n}`);
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
