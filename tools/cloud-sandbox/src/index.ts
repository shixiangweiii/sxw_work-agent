/**
 * `@workagent/tools-cloud-sandbox` —— 云沙箱执行（ADR-0016）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 研究问题：**当副作用的范围可以被机械地证明为「只有声明过的那几个文件」，
 * EXECUTE 还需要逐次审批吗？**
 *
 * 一台断网 ＋ 没有输入 ＋ 用完即销毁的云 VM，对用户拥有的任何东西，
 * durable effect 与「往 workspace 写那几个文件」等价 —— 而后者按决 3
 * 本来就自动放行。**v1 照常逐次问**；这里只把前提建起来：
 * per-call 让审批面是**完备的** —— 命令能看到什么，inputs 上全列着。
 *
 * ── 三层，各管一件事 ─────────────────────────────────────────────────
 *
 *   Runtime        —— 不认识「云沙箱」，只看见一个 EXECUTE 工具；
 *   本包（TS）     —— 工具定义、入参解析、**全部判定**（读黑名单、路径边界、
 *                     出网回显核对、产物登记）；
 *   沙箱池（HTTP） —— 只供原语（借、执行、传文件、还），并**另外**也核对一次回显。
 *
 * 边界 16 守着第二层不下沉：借用客户端不得进 `packages/` 与 `adapters/`。
 *
 * ── 代价，逐条写在 ADR-0016 里，一条都不许假装没有 ───────────────────────
 *
 *   ① 依赖集合在模板构建时就定死（模型要别的包只能重建模板或开网）；
 *   ② 大输入每次重传（池子上传上限 64MB）；
 *   ③ 没有成本轴 —— 这是 Atlas 第一个按秒计费的工具；
 *   ④ 池子的 commands 不流式，长命令期间模型拿不到任何输出；
 *   ⑤ inputs 非空 = 数据离开本机，**断网也照记**；
 *   ⑥ 「内网不可达」实测分不出是平台拦的还是没路由 —— 不依赖它，自己下发全禁。
 * ══════════════════════════════════════════════════════════════════════
 */

import type {
  PreparedAction,
  ToolHandlerPort,
  ToolSnapshot,
  TrustedEffectResolver,
  VerificationPort,
} from "@workagent/harness-runtime";
import { describeCloudShellForApproval, type CloudShellApprovalView } from "./approval.js";
import { PoolClient } from "./client.js";
import type { CloudSandboxConfig } from "./config.js";
import { CLOUD_SHELL_RESOLVER_ID, cloudShellDefinition, cloudShellSnapshot } from "./definitions.js";
import { CloudShellHandler } from "./handler.js";
import { CloudShellEffectResolver } from "./resolver.js";
import { CloudSandboxVerifier } from "./verifier.js";

export * from "./config.js";
export { PoolClient, PoolError } from "./client.js";
export type { EgressEcho, EgressRequest, ExecResult, Lease, PoolClientOptions } from "./client.js";
export { cloudShellDefinition, cloudShellSnapshot, SANDBOX_WORKDIR } from "./definitions.js";
export { CloudShellHandler, egressRequest, verifyEgress } from "./handler.js";
export { CloudShellEffectResolver, isProvablyContained, CLOUD_SCOPE_PREFIX } from "./resolver.js";
export { CloudSandboxVerifier } from "./verifier.js";
export { parseInput, parseLines, parseNetwork } from "./input.js";
export type { CloudShellInput, NetworkSpec } from "./input.js";
export {
  describeCloudShellForApproval,
  renderCloudShellApproval,
  type CloudShellApprovalView,
} from "./approval.js";

/** 结构与 `McpNotice` / `ComputerNotice` 相同（见那两处的说明）。 */
export interface CloudSandboxNotice {
  text: string;
  detail?: string;
}

export interface CloudSandboxRuntime {
  snapshots: ToolSnapshot[];
  handler: ToolHandlerPort & { handles(name: string): boolean };
  verifier: VerificationPort & { handles(name: string): boolean };
  resolvers: Map<string, TrustedEffectResolver>;
  notices: CloudSandboxNotice[];
  /** 审批面用。非 cloud_shell 返回 undefined。 */
  describeForApproval(action: PreparedAction): CloudShellApprovalView | undefined;
  /*
   * 【定】这里**没有** `close()`，与 `ComputerRuntime` 同一条理由：
   * 没有需要关的长生命周期资源。借用是 per-call 的，归还在 handler 的
   * `finally` 里 —— 那是结构性强制的，比一个要记得调用的 close() 可靠。
   */
}

export interface CreateCloudSandboxOptions {
  config: CloudSandboxConfig;
  /** 验收脚本注入假池子用。不传就用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 借用期限（毫秒）。不传按「命令超时 ＋ 5 分钟」算。 */
  leaseTtlMs?: number;
}

export function createCloudSandbox(opts: CreateCloudSandboxOptions): CloudSandboxRuntime {
  const client = new PoolClient({
    baseUrl: opts.config.baseUrl,
    ...(opts.config.apiKey ? { apiKey: opts.config.apiKey } : {}),
    waitTimeoutMs: opts.config.waitTimeoutMs,
    requestTimeoutMs: opts.config.requestTimeoutMs,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const handler = new CloudShellHandler({
    client,
    ...(opts.leaseTtlMs === undefined ? {} : { leaseTtlMs: opts.leaseTtlMs }),
  });
  const resolvers = new Map<string, TrustedEffectResolver>([
    [`${CLOUD_SHELL_RESOLVER_ID}@${cloudShellDefinition.version}`, new CloudShellEffectResolver()],
  ]);

  /**
   * 【定】这条提示放 `text`（常驻），不放 `detail`：它是**每个**用到云沙箱的
   * Run 都会撞上的事实，不是一次性配置信息（「分界线是用户什么时候需要它」）。
   *
   * 两件事必须常驻说出口：钱，以及「断网是默认」。后者如果只写在工具
   * description 里，人在审批那一刻看不到它 —— 而他要批的正是「这次要不要开网」。
   */
  const notices: CloudSandboxNotice[] = [
    {
      text:
        `☁️ 云沙箱已接入（${opts.config.baseUrl}）：cloud_shell 每次调用借一台一次性 Linux 沙箱，` +
        `跑完立刻销毁。**默认完全断网**，要联网必须在调用里显式声明域名。` +
        `⚠️ 它按秒计费，而 Atlas 没有成本预算轴 —— 轮次与工具调用数是仅有的两道闸。`,
      detail:
        `· 沙箱看不到 workspace：要用的文件写进 inputs（**会离开本机**），要带回的写进 outputs。\n` +
        `· 出网策略由池子下发，Atlas 会读回平台回显核对，对不上就拒绝执行。\n` +
        `· 常用 Python 包已预装在模板镜像里，断网也能直接 import。\n` +
        `· 池子的 commands 不流式：长命令期间只报「还在等」，报不出它打印了什么。`,
    },
  ];

  /**
   * 【定】开了信任声明就**常驻**说出来（ADR-0018）。它让 workspace 里的文件
   * 在无人过问下上传到云上 —— 一次对用户可见的边界让渡而不打印，等于没通知。
   */
  if (opts.config.trustUploadsToPool) {
    notices.push({
      text:
        `⚠️ 已声明信任这个池子（trustUploadsToPool）：断网的 cloud_shell 即使上传 workspace 文件` +
        `也**不再逐次询问**。读黑名单仍会挡住凭证类文件，但业务数据它不认识。` +
        `开了网的调用照旧要问。`,
    });
  }

  return {
    snapshots: [cloudShellSnapshot],
    handler,
    verifier: new CloudSandboxVerifier(),
    resolvers,
    notices,
    describeForApproval: describeCloudShellForApproval,
  };
}
