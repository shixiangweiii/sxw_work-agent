/**
 * `cloud_shell` 的执行器。**全部判定都在这里**（ADR-0016）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 判定清单，顺序就是下面代码的顺序：
 *
 *   ① inputs 过**读黑名单那一份**     —— 否则 `inputs=".env"` 一行绕过决 3 护栏①
 *   ② inputs / outputs 不得逃出 workspace
 *   ③ 借沙箱，下发出网策略
 *   ④ **读回平台回显核对** ← 第二道闸门，对不上就不执行
 *   ⑤ 上传 → 执行 → 取回
 *   ⑥ 产物按真实字节登记（ADR-0010）
 *   ⑦ 无论如何归还（归还即销毁）
 *
 * 【定】判定不进池子：写在那边的话，验收脚本只能拿假池子去模仿它，
 * 判据测的就成了假池子 —— 与 ADR-0013「判定不进 Swift 助手」一字不差。
 * 池子那边**另外**也有一道（它自己也核对回显）—— 与 `run_shell` 的两道闸门同构：
 * 合并成一层的必然写法是「既然池子核对过了，Atlas 就不用核对了」，
 * 那正好把最后一道拆掉。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  PreparedAction,
  ProducedArtifact,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolHandlerPort,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";
import { artifactKindOf, checkReadAllowed, isInsideWorkspace, resolveToolPath } from "@workagent/tools-common";
import { PoolClient, PoolError, type EgressEcho, type EgressRequest, type Lease } from "./client.js";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, SANDBOX_WORKDIR } from "./definitions.js";
import { parseInput, type CloudShellInput, type NetworkSpec } from "./input.js";

/** 单个上传文件的大小上限（池子那边是 64MiB，这里留余量并提前说清楚）。 */
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;
/** 一次登记最多读多大的产物进内存（与 run_shell 同口径）。 */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const HEARTBEAT_MS = 5_000;

export interface CloudShellHandlerOptions {
  client: PoolClient;
  /** 借用期限。比命令超时长一截，留出上传与取回的时间。 */
  leaseTtlMs?: number;
}

export class CloudShellHandler implements ToolHandlerPort {
  constructor(private readonly opts: CloudShellHandlerOptions) {}

  handles(name: string): boolean {
    return name === "cloud_shell";
  }

  async execute(action: PreparedAction, ctx: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const input = parseInput(
      (action.normalizedInput ?? {}) as Record<string, unknown>,
      { defaultTimeoutMs: DEFAULT_TIMEOUT_MS, maxTimeoutMs: MAX_TIMEOUT_MS },
    );
    if (!input.command.trim()) {
      return refuse("TOOL_INPUT", "TOOL_CLOUD_EMPTY_COMMAND", "command 不能为空。");
    }

    // ── ① / ② 入参判定 ＋ **把文件读出来**：都在借任何资源之前做完 ──
    //    失败的调用不得留下状态变化（P1-2 那条纪律）：一次被护栏挡下的调用
    //    不该先占一台按秒计费的沙箱。
    //
    //    【定】读文件也必须在这一步 —— 真实端点实跑抓到的（run_dec51574f08f）：
    //    原来在借到沙箱**之后**才 `readFile`，于是模型声明一个不存在的 inputs 时
    //    ENOENT 直接穿出 execute()，Runtime 记成工具抛异常 → `sideEffectState:
    //    UNKNOWN` → push RecoveryItem → **整个 Run 降级成 COMPLETED_WITH_LIMITS**。
    //    一次模型笔误就让这个 Run 再也拿不到 SUCCESS，而那是 MCP 那批写过的
    //    「降级信号变成一盏永远亮着的灯」。顺带还白借一台按秒计费的沙箱。
    const prepared = await this.prepareInputs(input, ctx);
    if ("refusal" in prepared) return prepared.refusal;
    const payloads = prepared.files;

    const started = Date.now();
    ctx.onProgress(`借用云沙箱：${input.description ?? truncate(input.command, 60)}`);
    const heartbeat = setInterval(() => {
      // ⚠️ 池子的 commands 不流式，所以这里只报得出「还在等」，报不出命令打印了什么
      ctx.onProgress(`云沙箱仍在执行，已 ${Math.round((Date.now() - started) / 1000)} 秒`);
    }, HEARTBEAT_MS);

    let lease: Lease | undefined;
    try {
      // ── ③ 借沙箱并下发出网策略 ──
      try {
        lease = await this.opts.client.acquire(
          egressRequest(input.network),
          this.opts.leaseTtlMs ?? input.timeoutMs + 300_000,
        );
      } catch (e) {
        return poolFailure(e, "NOT_STARTED");
      }

      // ── ④ 第二道闸门：读回平台回显核对 ──
      const mismatch = verifyEgress(input.network, lease.egressPlatform);
      if (mismatch) {
        return refuse(
          "TOOL_HANDLER",
          "TOOL_CLOUD_EGRESS_UNVERIFIED",
          `拒绝执行：没能确认这台沙箱的出网策略与要求一致。${mismatch}\n` +
            `「断网」是这次执行可以被证明的全部依据，核对不上就不执行 —— ` +
            `一条放行了却没验过的闸门，与「验过并通过」在事后不可区分。`,
          "NO_EFFECT",
        );
      }

      // ── ⑤ 上传 → 执行 → 取回 ──
      for (const [rel, data] of payloads) {
        await this.opts.client.upload(lease.leaseId, `${SANDBOX_WORKDIR}/${rel}`, data);
      }

      let exec;
      try {
        exec = await this.opts.client.command(lease.leaseId, input.command, SANDBOX_WORKDIR, input.timeoutMs);
      } catch (e) {
        // 【定】命令发出去之后的失败一律 UNKNOWN：跑没跑说不清。
        return poolFailure(e, "UNKNOWN");
      }

      const timedOut = (exec.error ?? "").startsWith("TimeoutError");
      const fetched: string[] = [];
      const missing: string[] = [];
      let artifact: ProducedArtifact | undefined;
      // 超时也照取 outputs：命令可能已经把文件写出来了，而沙箱马上就销毁了
      for (const rel of input.outputs) {
        let bytes: Uint8Array;
        try {
          bytes = await this.opts.client.download(lease.leaseId, `${SANDBOX_WORKDIR}/${rel}`);
        } catch {
          missing.push(rel);
          continue;
        }
        const abs = resolveToolPath(ctx.workspaceRoot, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
        fetched.push(rel);
        if (input.artifactPath === rel) {
          if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
            missing.push(`${rel}（${bytes.byteLength} 字节，超过登记上限 ${MAX_ARTIFACT_BYTES}，未登记）`);
          } else {
            artifact = {
              logicalId: rel,
              // 【定】写错的 role 不提升为 DELIVERABLE（run_shell 1.1.1 的同款）
              role: input.artifactRole === "INTERMEDIATE" ? "INTERMEDIATE" : "DELIVERABLE",
              kind: artifactKindOf(rel),
              path: rel,
              content: bytes,
            };
          }
        }
      }
      if (input.artifactPath && !input.outputs.includes(input.artifactPath)) {
        missing.push(`${input.artifactPath}（artifact_path 不在 outputs 里，没有取回、也没有登记）`);
      }

      const note = [
        timedOut ? `命令超时（${input.timeoutMs}ms），以上是超时前已经产出的输出，**不完整**。` : "",
        exec.truncated
          ? `输出被截断：stdout 实际 ${exec.stdoutBytes} 字节、stderr 实际 ${exec.stderrBytes} 字节。`
          : "",
        missing.length > 0 ? `这些 outputs 没能取回：${missing.join("、")}。` : "",
        `沙箱已归还并销毁。`,
      ]
        .filter(Boolean)
        .join(" ");

      const payload = {
        exitCode: exec.exitCode,
        stdout: exec.stdout,
        stderr: exec.stderr,
        truncated: exec.truncated,
        durationMs: Date.now() - started,
        outputs: fetched,
        note,
      };
      return {
        ok: !timedOut,
        output: JSON.stringify(payload),
        // 【定】超时 → UNKNOWN（命令可能跑了一半）；正常结束 → APPLIED。
        sideEffectState: timedOut ? "UNKNOWN" : "APPLIED",
        ...(artifact ? { artifact } : {}),
        ...(timedOut
          ? {
              error: makeError({
                code: "TOOL_CLOUD_TIMEOUT",
                source: "TOOL_HANDLER",
                category: "TIMEOUT",
                retryability: "NEVER",
                sideEffectState: "UNKNOWN",
                safeMessage: `云沙箱里的命令超过 ${input.timeoutMs}ms 未结束，已连同沙箱一并销毁。副作用状态未知。`,
              }),
            }
          : {}),
      };
    } finally {
      clearInterval(heartbeat);
      // ── ⑦ 无论如何归还。归还即销毁 —— 这是「用完即销毁」那条性质的落点。
      //    失败不抛：归还失败不该把一次成功的执行变成失败（沙箱会在 TTL 到期后
      //    被池子自己回收），但要让它在日志里留下痕迹。
      if (lease) {
        try {
          await this.opts.client.release(lease.leaseId);
        } catch {
          /* 池子的维护循环会在借用过期后回收 */
        }
      }
    }
  }

  /**
   * ① 读黑名单 ＋ ② 路径边界 ＋ **把 inputs 读进内存**。三件事都在借沙箱之前。
   *
   * 返回 `{ refusal }` 表示这次调用不该继续（而且一台沙箱都还没借）；
   * 返回 `{ files }` 表示可以往下走，字节已经在手里。
   */
  private async prepareInputs(
    input: CloudShellInput,
    ctx: ToolExecutionContext,
  ): Promise<{ refusal: ToolExecutionOutcome } | { files: [string, Uint8Array][] }> {
    const files: [string, Uint8Array][] = [];
    for (const rel of input.inputs) {
      const abs = resolveToolPath(ctx.workspaceRoot, rel);
      /**
       * 【定】**两档都要判**，不走 `writeBoundaryRefusal`（它在 UNRESTRICTED 下放行）。
       *
       * 这不是和 ADR-0012 唱反调：那一档放开的是「写到 workspace 之外」，
       * 而这里的路径是**相对路径 ＋ 上传到别人的机器**。这个工具的契约里
       * 根本没有「指定一个绝对目的地」这回事，所以没有什么好放开的，
       * 而逃出去的后果是把 workspace 之外的文件传上云。
       */
      if (!isInsideWorkspace(ctx.workspaceRoot, abs)) {
        return {
          refusal: refuse(
            "TOOL_INPUT",
            "TOOL_PATH_ESCAPE",
            `inputs 里的 "${rel}" 落在 workspace 之外。cloud_shell 只能上传 workspace 内的文件。`,
          ),
        };
      }
      /**
       * 【定】过**读黑名单那一份**（`tools/common/src/fs/read-guard.ts`）。
       *
       * 少了它，一行 `inputs=".env"` 就绕过了决 3 的护栏①，而且比 `read_file`
       * 更糟：文件直接离开本机。护栏的唯一事实源只有那一份，这里是它的第三个消费者。
       */
      const denial = checkReadAllowed(abs);
      if (denial) {
        return {
          refusal: refuse(
            "TOOL_INPUT",
            "TOOL_READ_DENIED",
            `inputs 里的 "${rel}" 命中读黑名单（${denial.rule}），拒绝上传到云沙箱。`,
          ),
        };
      }
      // 【定】读不出来是**模型声明错了**，不是副作用未知：具名拒绝，让它能改对
      let data: Buffer;
      try {
        data = await readFile(abs);
      } catch (e) {
        const enoent = (e as NodeJS.ErrnoException).code === "ENOENT";
        return {
          refusal: refuse(
            "TOOL_INPUT",
            enoent ? "TOOL_CLOUD_INPUT_NOT_FOUND" : "TOOL_CLOUD_INPUT_UNREADABLE",
            enoent
              ? `inputs 里的 "${rel}" 在 workspace 里不存在。先确认路径（相对 workspace 根），` +
                `或者先把它生成出来再调用。`
              : `inputs 里的 "${rel}" 读不出来：${(e as Error).message.slice(0, 160)}`,
          ),
        };
      }
      if (data.byteLength > MAX_UPLOAD_BYTES) {
        return {
          refusal: refuse(
            "TOOL_INPUT",
            "TOOL_CLOUD_UPLOAD_TOO_LARGE",
            `inputs 里的 "${rel}" 有 ${data.byteLength} 字节，超过单文件上限 ${MAX_UPLOAD_BYTES}。`,
          ),
        };
      }
      files.push([rel, new Uint8Array(data)]);
    }
    for (const rel of input.outputs) {
      const abs = resolveToolPath(ctx.workspaceRoot, rel);
      if (!isInsideWorkspace(ctx.workspaceRoot, abs)) {
        return {
          refusal: refuse(
            "TOOL_INPUT",
            "TOOL_PATH_ESCAPE",
            `outputs 里的 "${rel}" 会写到 workspace 之外。cloud_shell 只把文件带回 workspace 内。`,
          ),
        };
      }
    }
    return { files };
  }
}

/** 本次要向池子请求的出网策略。`none` 档**不传** —— 让池子的默认（断网）生效。 */
export function egressRequest(net: NetworkSpec): EgressRequest | undefined {
  if (net.kind === "none") return undefined;
  if (net.kind === "open") return { mode: "open", allow_out: [], deny_out: [] };
  return { mode: "allowlist", allow_out: [...net.allow], deny_out: [] };
}

/**
 * 第二道闸门的判定：平台回显与我们要的那一档对不对得上。
 *
 * 【定】读不到回显一律算**不匹配**。「我无法核对」不等于「通过」——
 * 这正是 §18.3 workspace 闸门那条 `UNKNOWN_LEGACY` 要说出口的事，
 * 只是这里没有「存量数据」这个理由，所以直接拒。
 *
 * 返回 undefined 表示通过；否则返回一句说清哪里对不上的话。
 */
export function verifyEgress(net: NetworkSpec, platform: EgressEcho | undefined): string | undefined {
  if (!platform) return "池子没有回传平台的网络配置（可能是旧版本的池子，或者它没核对）。";
  const deny = new Set(platform.deny_out ?? []);
  const allow = new Set(platform.allow_out ?? []);
  if (net.kind === "none") {
    if (!deny.has("0.0.0.0/0") || allow.size > 0) {
      return `要求彻底断网，而平台回显 allow_out=${[...allow].join(",") || "[]"}、deny_out=${[...deny].join(",") || "[]"}。`;
    }
    return undefined;
  }
  if (net.kind === "allowlist") {
    if (!deny.has("0.0.0.0/0")) return `要求只放行白名单，而平台回显的 deny_out 里没有 0.0.0.0/0。`;
    const missing = net.allow.filter((d) => !allow.has(d));
    const extra = [...allow].filter((d) => !net.allow.includes(d));
    if (missing.length || extra.length) {
      return `白名单对不上：少了 [${missing.join(",")}]，多了 [${extra.join(",")}]。`;
    }
    return undefined;
  }
  // open：平台不该把全网 deny 掉
  if (deny.has("0.0.0.0/0")) return "要求放开公网，而平台回显仍然是 deny_out=0.0.0.0/0。";
  return undefined;
}

function refuse(
  source: "TOOL_INPUT" | "TOOL_HANDLER",
  code: string,
  safeMessage: string,
  sideEffectState: "NO_EFFECT" | "NOT_STARTED" = "NO_EFFECT",
): ToolExecutionOutcome {
  return {
    ok: false,
    output: "",
    sideEffectState,
    error: makeError({
      code,
      source,
      category: "AUTHORIZATION",
      retryability: "AFTER_MODEL_CORRECTION",
      sideEffectState,
      safeMessage,
    }),
  };
}

function poolFailure(e: unknown, fallback: "NOT_STARTED" | "UNKNOWN"): ToolExecutionOutcome {
  const pe = e instanceof PoolError ? e : undefined;
  /**
   * ── 【定】只有 `NOT_ACQUIRED` 能无条件判 `NOT_STARTED` ──────────────────
   *
   * 它是池子**真的回了一个 HTTP 响应**说「没有沙箱给你」（429 / 503 / 504）——
   * 那时命令确定没跑。
   *
   * ⚠️ `UNREACHABLE` **不能**一起算进来，尽管它看起来也像「没连上」。
   * 它是 `fetch` 自己抛的，而那里面混着两件完全不同的事：
   *     请求没发出去（连接被拒）        → 命令没跑
   *     请求发出去了、响应没回来（超时）→ **命令可能正在跑**
   * 两者在客户端不可区分，所以它必须**跟着调用点的兜底档走**：
   * 借用阶段是 NOT_STARTED（没借到就没命令），命令阶段是 UNKNOWN。
   *
   * 这个区别是注入实测逼出来的：原来写的是 `NOT_ACQUIRED || UNREACHABLE
   * → NOT_STARTED`，而判据只在借用路径上测（那里兜底本来就是 NOT_STARTED），
   * 于是摘掉整个分类逻辑**判据照样绿** —— 判据落在了守卫的重叠区。
   * 现在 D1 / D1c 一条走借用、一条走命令，各自能单独触发。
   *
   * 合并成一类的后果具体：「池子忙」被记成「副作用状态未知」，
   * 一次本该直接重试的请求会变成要人来销账的恢复项；反过来，
   * 「命令发了但不知道结果」被记成「没开始」，则是在事实表里写假话。
   */
  const state = pe?.kind === "NOT_ACQUIRED" ? "NOT_STARTED" : fallback;
  return {
    ok: false,
    output: "",
    sideEffectState: state,
    error: makeError({
      code: pe?.kind === "NOT_ACQUIRED" ? "TOOL_CLOUD_NO_SANDBOX" : "TOOL_CLOUD_POOL_ERROR",
      source: "TOOL_HANDLER",
      category: pe?.kind === "SANDBOX_ERROR" ? "UNKNOWN" : "UNAVAILABLE",
      retryability: state === "NOT_STARTED" ? "SAME_INPUT_BACKOFF" : "NEVER",
      sideEffectState: state,
      safeMessage: (e as Error).message.slice(0, 400),
    }),
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** 供 `index.ts` 构造工具 id（避免在两处写字符串）。 */
export const CLOUD_SHELL_TOOL_ID = asId("tool_cloud_shell");
export { join as joinSandboxPath };
