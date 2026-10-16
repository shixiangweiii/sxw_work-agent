/**
 * `cloud_shell` 的审批展示（ADR-0016）。CLI 与 Web **共用这一份**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】不复用 `PROCESS` 那一支的展示。它是 `run_shell` 专属的，会打印
 * 「沙箱：只能写 workspace 与本次调用的 $TMPDIR」—— 对一台云上的 microVM
 * 来说那是一句**方向相反**的保证。MCP 那批踩过同一个坑（`EffectScope.kind`
 * 的注释里记着：展示按 scope 泛化，内容却按工具特化）。
 *
 * 【定】人在这一刻最需要知道的四件事，一件都不能省：
 *   ① 哪些本地文件会**离开本机**（inputs）—— 这是唯一不可撤销的那部分；
 *   ② 跑什么（命令原文）；
 *   ③ 哪些文件会落回 workspace（outputs），会覆盖什么；
 *   ④ 有没有网、能到哪儿。
 * 只打 scope.value 的话人看到的是 `cloud:net=none;in=2;out=1` —— 那是盲批。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { PreparedAction } from "@workagent/harness-runtime";
import { parseInput } from "./input.js";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, SANDBOX_WORKDIR } from "./definitions.js";

export interface CloudShellApprovalView {
  /** 一行摘要，用于列表与标题。 */
  summary: string;
  /** 命令原文（**不截断** —— 批准的就是这一条）。 */
  command: string;
  description?: string;
  /** 会离开本机的文件。 */
  uploads: string[];
  /** 会落回 workspace 的文件。 */
  downloads: string[];
  /** 出网档位的人话。 */
  network: string;
  /** 这次执行的边界，逐条说清楚。 */
  boundaries: string[];
  timeoutMs: number;
  artifactPath?: string;
}

export function describeCloudShellForApproval(action: PreparedAction): CloudShellApprovalView | undefined {
  if (action.toolName !== "cloud_shell") return undefined;
  const input = parseInput((action.normalizedInput ?? {}) as Record<string, unknown>, {
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
  });

  const network =
    input.network.kind === "none"
      ? "完全断网（连 DNS 都不通）"
      : input.network.kind === "open"
        ? "⚠️ 整个公网 —— 无法排除任意数据外发"
        : `只放行：${input.network.allow.join("、")}`;

  const boundaries = [
    "一次性的云端 Linux 沙箱，命令跑完立刻销毁；它看不到你的 workspace。",
    `出网：${network}。`,
    input.outputs.length > 0
      ? `取回后会写进 workspace：${input.outputs.join("、")}（同名文件会被覆盖）。`
      : "没有声明 outputs —— 这次执行不会有任何文件落回本机。",
  ].filter((s): s is string => Boolean(s));

  if (input.inputs.length > 0) {
    boundaries.splice(
      1,
      0,
      `⚠️ 这些文件会**离开本机**上传到云沙箱：${input.inputs.join("、")}。` +
        `即使命令断网，文件本身也已经到了云上。`,
    );
  }

  return {
    summary:
      `在云沙箱里执行${input.description ? `：${input.description}` : ""}` +
      `（${input.network.kind === "none" ? "断网" : input.network.kind === "open" ? "全网" : "白名单"}` +
      `，上传 ${input.inputs.length} 个、取回 ${input.outputs.length} 个）`,
    command: input.command,
    ...(input.description ? { description: input.description } : {}),
    uploads: input.inputs,
    downloads: input.outputs,
    network,
    boundaries,
    timeoutMs: input.timeoutMs,
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
  };
}

/** CLI 用的纯文本渲染。Web 卡片读上面那个结构化对象。 */
export function renderCloudShellApproval(v: CloudShellApprovalView): string {
  const lines = [
    `  工作目录：${SANDBOX_WORKDIR}（云沙箱内）`,
    `  命令：${v.command}`,
  ];
  if (v.uploads.length) lines.push(`  上传（离开本机）：${v.uploads.join("、")}`);
  if (v.downloads.length) lines.push(`  取回（写进 workspace）：${v.downloads.join("、")}`);
  lines.push(`  出网：${v.network}`);
  if (v.artifactPath) lines.push(`  声明的交付物：${v.artifactPath}`);
  lines.push(`  超时：${v.timeoutMs}ms`);
  return lines.join("\n");
}
