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
import { parseEndpointArg, REPO_ROOT, DEFAULT_STATE_DIR } from "../../cli/src/compose.js";
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

  const svc = await startService({
    workspaceRoot,
    endpoint,
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
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err) => {
  console.error(`\n启动失败：${(err as Error).message}`);
  process.exit(1);
});
