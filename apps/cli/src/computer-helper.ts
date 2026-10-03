/**
 * computer use 的本机准备与诊断（ADR-0013）。
 *
 *   npm run computer:build                       构建 Atlas GUI Helper.app（源码不变就跳过）
 *   npm run computer:doctor                      查授权状态（**不弹任何系统对话框**）
 *   npm run computer:doctor -- --request         触发「辅助功能 / 录屏」授权提示
 *   npm run computer:doctor -- --apps TextEdit   看白名单解析成了什么
 *   npm run computer:doctor -- --apps TextEdit --screenshot /tmp/a.png
 *                                                实截一张白名单应用的图（会读屏幕内容）
 *
 * 【定】默认只读：查授权用的是不弹框的 preflight。弹授权框、读屏幕内容这两件事
 * 都要用户在命令行上显式要求 —— 一个诊断命令不该替用户做这两个决定。
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HelperDriver,
  ensureHelperBuilt,
  hardDeniedReason,
  parseComputerFlags,
} from "@workagent/tools-computer";
import { DEFAULT_STATE_DIR, REPO_ROOT } from "./compose.js";

const argv = process.argv.slice(2);
const mode = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const stateDir = resolve(REPO_ROOT, DEFAULT_STATE_DIR);

async function main(): Promise<void> {
  if (mode !== "build" && mode !== "doctor") {
    console.error("用法：computer-helper.ts build | doctor [--request] [--apps A,B] [--screenshot path]");
    process.exit(2);
  }
  const built = ensureHelperBuilt({
    stateDir,
    force: argv.includes("--force"),
    log: (l) => console.log(l),
  });
  console.log(`Atlas GUI Helper：${built.appPath}${built.rebuilt ? "（刚构建）" : "（已是最新）"}`);
  if (mode === "build") return;

  const driver = new HelperDriver({ appPath: built.appPath });
  try {
    let perms = await driver.permissions();
    if (argv.includes("--request") && (!perms.screenRecording || !perms.accessibility)) {
      console.log("正在请求系统授权（会弹出系统对话框）…");
      perms = await driver.requestPermissions();
    }
    console.log(`录屏与系统录音：${perms.screenRecording ? "✓ 已授权" : "✗ 未授权"}`);
    console.log(`辅助功能：      ${perms.accessibility ? "✓ 已授权" : "✗ 未授权"}`);
    if (!perms.screenRecording || !perms.accessibility) {
      console.log(
        "\n授权对象是「Atlas GUI Helper」（不是终端）。在「系统设置 → 隐私与安全性」的" +
          "「录屏与系统录音」「辅助功能」里打开它。授权在已运行的助手上不一定生效 —— " +
          "Atlas 发现缺授权时会关掉助手，下一次调用会重新拉起它并读到新授权。" +
          "\n也可以运行 npm run computer:doctor -- --request 触发系统提示。" +
          "\n注意：助手源码改动后会被重新构建，系统会把它当成新程序，需要重新授权。",
      );
    }

    const apps = flag("--apps");
    if (apps !== undefined) {
      const allowBrowsers = argv.includes("--allow-browsers");
      const config = parseComputerFlags("view", apps, allowBrowsers);
      const resolved = await driver.resolveApps(config.apps.map((a) => a.raw));
      console.log("\n白名单解析：");
      for (const r of resolved) {
        const denied = r.bundleId ? hardDeniedReason({ bundleId: r.bundleId, name: r.name ?? "" }, { allowBrowsers }) : undefined;
        console.log(
          `  ${r.query} → ${r.bundleId ?? "（找不到）"}${r.name ? `（${r.name}）` : ""}` +
            `${r.running ? " · 运行中" : ""}${denied ? ` · ✗ 硬拒绝：${denied}` : ""}`,
        );
      }
      const shotPath = flag("--screenshot");
      if (shotPath !== undefined) {
        if (!perms.screenRecording) {
          console.log("\n截图需要「录屏与系统录音」授权，已跳过。");
        } else {
          const allow = resolved
            .filter((r) => r.bundleId && !hardDeniedReason({ bundleId: r.bundleId, name: r.name ?? "" }, { allowBrowsers }))
            .map((r) => r.bundleId!);
          const shot = await driver.capture({ allowBundleIds: allow, maxLongEdgePx: 1792 });
          writeFileSync(shotPath, shot.png);
          console.log(
            `\n截图已写到 ${shotPath}：${shot.width}×${shot.height}，` +
              `显示器 ${shot.display.widthPt}×${shot.display.heightPt} pt @${shot.display.scale}x，` +
              `截进图里的应用：${shot.capturedApps.map((a) => a.name).join("、") || "（无）"}`,
          );
        }
      }
    }
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
});
