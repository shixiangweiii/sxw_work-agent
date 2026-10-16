/**
 * `cloud_shell` 的工具声明（ADR-0016）。
 *
 * ── 【定】它与 `run_shell` 的 description 是**成对**的 ──────────────────
 *
 * ADR-0008 的教训：`request_handoff` 与 `ask_user` 只改一边，模型就会在两者
 * 之间随机选。这里的分水岭**不是**「本机还是云上」—— 那对模型没有操作意义 ——
 * 而是 **两者看不到同一个文件系统**：
 *
 *   run_shell    直接看 workspace，不用声明就能读写里面的任何东西；
 *   cloud_shell  只看得到你在 inputs 里声明过的东西，只带得回 outputs 里声明过的。
 *
 * 这句话两边都要写死。改任一边都要回头看另一边。
 */

import type { JsonSchemaProperty, ToolDefinition, ToolSnapshot } from "@workagent/harness-runtime";
import { asId } from "@workagent/harness-runtime";

export const CLOUD_SHELL_RESOLVER_ID = "cloud_shell_effect";

/** 实现版本。入参或执行语义变化就升 —— 它是冻结工具快照的显式身份之一。 */
/**
 * 1.0.1：inputs / outputs 的 description 改写 —— 真实端点实跑（run_dec51574f08f）里
 * 模型第一反应是传**数组**，错了两次才改成换行分隔，白花两轮。现在显式写「不是数组」
 * 并给例子，同时说明「文件必须已经存在」（那次还撞了 ENOENT）。
 *
 * 【定】description 变了就升版本 —— 它进工具快照的身份，resume 时要能看出工具面变过。
 */
const IMPL_VERSION = "1.0.1";

/** 命令在沙箱里的工作目录；inputs / outputs 的相对路径都相对它。 */
export const SANDBOX_WORKDIR = "/home/user/workspace";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/**
 * 步级超时 = 工具上限 ＋ 余量，理由与 `run_shell` 一字不差：
 * 取相等的话两个 timer 同刻到期，谁先触发是竞态，而输给 Runtime 那一侧
 * 会把一次超时报成「被取消」。
 */
export const STEP_TIMEOUT_MS = MAX_TIMEOUT_MS + 60_000;

/**
 * 【定】自家工具的 schema 必须留在**标量**子集里（`verify:tools` B4：
 * 只许 string / number / boolean，属性上只许 type 与 description）。
 * 所以 inputs / outputs 是**按行分隔的字符串**，不是数组 ——
 * 与 `ask_user` 的 `options` 同一种写法。
 */
const properties: Record<string, JsonSchemaProperty> = {
  command: { type: "string", description: "要在云沙箱里执行的 shell 命令（bash -c）" },
  description: { type: "string", description: "用一句话说明这条命令做什么（会展示给用户审批）" },
  inputs: {
    type: "string",
    description:
      "这条命令需要的本地文件。**类型是字符串、不是数组**：多个文件用换行分隔，" +
      '例如 "data.csv\nscript.py"；一个文件就直接写 "data.csv"。' +
      "路径相对 workspace 根，会上传到沙箱里同样的相对位置。" +
      "不声明就上传不了 —— 云沙箱看不见你的 workspace；**文件必须已经存在**，不存在会被直接拒绝。" +
      "注意：上传意味着这些文件离开本机（即使命令断网），会被记为数据外发。",
  },
  outputs: {
    type: "string",
    description:
      "命令产出、需要带回本地的文件。**类型是字符串、不是数组**：多个用换行分隔，" +
      '例如 "report.json\nchart.png"。路径相对沙箱工作目录，会写进 workspace 同样的相对位置。' +
      "不声明的话，沙箱一销毁它们就永远没了。",
  },
  network: {
    type: "string",
    description:
      '出网档位。默认 "none" —— **完全断网，连 DNS 都不通**（装包、下载、调 API 全都不行）。' +
      '要联网就填逗号分隔的域名白名单（如 "pypi.org,files.pythonhosted.org"），只有这些域名通。' +
      '整个公网填 "open"。' +
      "⚠️ 断网这一档是最便宜的：它让这次执行的副作用可以被证明，审批也最容易通过。" +
      "常用的 Python 包已经预装在镜像里，先直接用，不要先想着装。",
  },
  timeout_ms: {
    type: "number",
    description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`,
  },
  artifact_path: {
    type: "string",
    description:
      "outputs 里哪一个是本次任务的交付物（相对沙箱工作目录，必须也出现在 outputs 里）。" +
      "声明了它，取回之后系统会按类型做结构检查（zip 的头尾结构完整、JSON 能解析、" +
      "图片等二进制的文件头与扩展名相符），检查通过才计入交付物。" +
      "**打包、导出、生成文件这类任务请填它** —— 不填的话系统无法证明你交付的东西是好的。" +
      "注意这些是**结构**检查，不解压也不解码，内容对不对仍然由你负责。",
  },
  artifact_role: {
    type: "string",
    description:
      'artifact_path 的角色："DELIVERABLE"（用户要的最终交付物，检查不通过会判任务失败）' +
      '或 "INTERMEDIATE"（中间产物）。不填按 DELIVERABLE 处理',
  },
};

export const cloudShellDefinition: ToolDefinition = {
  id: asId("tool_cloud_shell"),
  version: IMPL_VERSION,
  name: "cloud_shell",
  description:
    "在一台**一次性的云端 Linux 沙箱**里执行一条 shell 命令。" +
    "每次调用都是一台全新的机器，命令跑完**立刻销毁** —— 装的东西、改的文件、起的进程全没了。" +
    // ── 与 run_shell 的分水岭，成对写死 ──
    "它与 run_shell 的区别**不是**本机还是云上，是：run_shell 直接看得到你的 workspace，" +
    "而 cloud_shell **只看得到你在 inputs 里声明过的文件**，也只带得回 outputs 里声明过的文件。" +
    "所以：改 workspace 里的东西、看看目录里有什么 → 用 run_shell；" +
    "跑 Linux 专有的工具链、跑不信任的代码、以及本机做不了的事 → 用 cloud_shell。" +
    `沙箱里命令的工作目录固定是 ${SANDBOX_WORKDIR}。` +
    "默认**完全断网**（见 network 参数）；常用 Python 包已预装，直接 import 即可。" +
    '返回 JSON：{"exitCode","stdout","stderr","truncated","durationMs","outputs","note"}。' +
    "命令返回非零退出码不算工具故障，看 exitCode 字段判断。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃（B4b 要求自家工具必须写这一行）
    additionalProperties: false,
    properties,
    required: ["command"],
  },
  /**
   * 【定】RESOLVER —— 与 `run_shell` 同理：一条命令的作用域读不出任何单个字段，
   * 而这里还要把 inputs / outputs / network 一起算进去（它们决定了这次执行
   * 有没有数据外发、能不能观察）。
   */
  effectResolution: { kind: "RESOLVER", resolverRef: { id: CLOUD_SHELL_RESOLVER_ID, version: IMPL_VERSION } },
  redaction: { profile: "STANDARD" },
  /** 【定】说实话：既不幂等也不只读。标成幂等会让恢复看起来更干净，但那是假的。 */
  idempotency: { isIdempotent: false, isReadOnly: false },
  timeoutPolicy: { timeoutMs: STEP_TIMEOUT_MS },
  /**
   * 【定】HEARTBEAT 是承诺，实现里必须真有周期性的 `ctx.onProgress(`。
   *
   * ⚠️ 代价如实记（ADR-0016 代价④）：池子的 `commands` **不流式**，所以这里的
   * 心跳只报得出「还在等」，报不出命令打印了什么。一条十分钟的构建，模型在
   * 结束前拿不到任何输出。这与 `run_shell` 的心跳不是一回事。
   */
  progressReporting: { mode: "HEARTBEAT" },
  /** 【定】NONE：退出码与 stdout 已经在 output 里，再包一层不产生新事实。 */
  verification: { mode: "NONE", requiredForSuccess: false },
  /**
   * 【定】要求前置指纹，而**能不能观察按调用定**（决 6：分支判据是 Action 级事实）。
   *
   * 归还即销毁，所以断网时 durable effect 恰好就是取回来的那几个 outputs，
   * 而那是可观察的 → 分支二。开了网就不是了（对外发过什么无从判断）→ 分支三。
   * 判定在 `CloudSandboxVerifier.observePre`。
   */
  recoveryObservation: { requiresPreFingerprint: true },
};

export const cloudShellSnapshot: ToolSnapshot = {
  toolId: cloudShellDefinition.id,
  version: IMPL_VERSION,
  definition: cloudShellDefinition,
};
