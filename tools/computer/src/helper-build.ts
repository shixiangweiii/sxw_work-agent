/**
 * 构建 Atlas GUI Helper.app（ADR-0013）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】只在源码变了时重建。
 *
 * 这不是省编译时间：助手是 ad-hoc 签名的，TCC 认的是代码签名 —— **每重建一次，
 * 系统都把它当成一个新程序**，之前授予的「辅助功能」「录屏」随之失效，
 * 用户得再去系统设置里勾一遍。所以源码 hash 写进 bundle，hash 不变就不动它。
 *
 * 【定】这是 Atlas 第一次有一个需要编译的组件（此前一律 tsx 直接跑、零构建步骤）。
 * 代价写在 ADR-0013：需要本机有 Swift 工具链（Xcode Command Line Tools）。
 * 没有时给出明确的安装指引，不静默降级成「没有 GUI 工具」。
 * ══════════════════════════════════════════════════════════════════════
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "helper");
const SOURCE = join(HELPER_DIR, "AtlasGUIHelper.swift");
const PLIST = join(HELPER_DIR, "Info.plist");
export const HELPER_BUNDLE_ID = "com.workagent.atlas.gui-helper";

export interface HelperBuildResult {
  appPath: string;
  rebuilt: boolean;
  sourceHash: string;
}

/** 助手 .app 放在跨 workspace 的状态目录里（与 mcp.json 同理：它不属于任何一个 workspace）。 */
export function helperAppPath(stateDir: string): string {
  return join(stateDir, "computer", "AtlasGUIHelper.app");
}

export function ensureHelperBuilt(opts: {
  stateDir: string;
  force?: boolean;
  log?: (line: string) => void;
}): HelperBuildResult {
  if (process.platform !== "darwin") {
    throw new Error("computer use 第一阶段只支持 macOS（ADR-0013）。");
  }
  const appPath = helperAppPath(opts.stateDir);
  const sourceHash = createHash("sha256")
    .update(readFileSync(SOURCE))
    .update(readFileSync(PLIST))
    .digest("hex");
  const stamp = join(appPath, "Contents", "Resources", "source.sha256");
  if (!opts.force && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === sourceHash) {
    return { appPath, rebuilt: false, sourceHash };
  }

  try {
    execFileSync("swiftc", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "构建 Atlas GUI Helper 需要 Swift 工具链，但找不到 swiftc。请先安装 Xcode Command Line Tools：\n" +
        "  xcode-select --install",
    );
  }

  opts.log?.("正在构建 Atlas GUI Helper（首次或源码有变化；约半分钟）…");
  rmSync(appPath, { recursive: true, force: true });
  const macos = join(appPath, "Contents", "MacOS");
  const resources = join(appPath, "Contents", "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  execFileSync(
    "swiftc",
    ["-O", "-swift-version", "5", "-target", `${arch}-apple-macosx14.0`, SOURCE, "-o", join(macos, "AtlasGUIHelper")],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  copyFileSync(PLIST, join(appPath, "Contents", "Info.plist"));
  writeFileSync(stamp, sourceHash + "\n");
  // ad-hoc 签名：TCC 需要一个签名身份才能记住授权（见文件头的代价）。
  execFileSync("codesign", ["--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID, appPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  opts.log?.(
    "Atlas GUI Helper 已构建。重新构建后系统会把它当成新程序，之前的「辅助功能 / 录屏」授权需要重新授予。",
  );
  return { appPath, rebuilt: true, sourceHash };
}
