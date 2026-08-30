/**
 * run_shell —— 在 seatbelt 沙箱里跑一条 shell 命令。【场景工具】
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它补的是 2026-08-30 实测量出来的那个洞（Run `run_9610d44d3a62`）：
 *
 *   任务「把网页归档成含 markdown 与 images 目录的 zip」跑了 19 轮
 *   （预算 20）、6.5 分钟，结算 SUCCESS，而 zip 不存在。8 次 write_file
 *   里 5 次在写模型自己跑不了的打包脚本；模型三次明说「我没有 shell
 *   执行能力」，第 13 轮想清理临时文件也做不到 —— 没有删除工具。
 *
 * 【定】所以这一批**不新增** zip / mkdir / rm / mv 四个专用工具。
 * 研究问题就是「一个通用 EXECUTE 能替掉多少专用工具」，新增专用工具
 * 会把答案提前写死（决 4）。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 三场景：
 *   办公：打包、解包、格式转换 —— 一条命令顶一个专用工具
 *   代码：跑测试、跑构建、看 git 状态
 *   聊天：临时算个东西、看看某个文件到底多大
 *
 * ── 两道闸门，职责必须分清 ────────────────────────────────────────────
 *
 *   command-analysis.ts  判「要不要停下来问人」—— 判错代价是多问一次
 *   sandbox.ts           判「跑起来能碰到什么」—— **这一条才是边界**
 *
 * 【定】不要把这两件事写到一起。合并之后必然出现的写法是
 * 「既然解析说它只读，那就不用沙箱了」—— 而那正好把边界拆掉。
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";
import { SHELL_RESOLVER_REF } from "./shell-effect-resolver.js";
import { SANDBOX_EXEC, buildSandboxProfile, isSandboxAvailable } from "./sandbox.js";

/**
 * 单流输出上限。借 Claude Code 的 `BASH_MAX_OUTPUT_DEFAULT`（30000 字符）。
 *
 * 【定】超出必须**如实上报**截断事实与真实字节数，不静默截断。
 * 静默截断会让模型拿一段被砍掉一半的输出当完整结果用，
 * 而它没有任何办法看出来 —— 与 fetch_url 不把二进制 toString 是同一条理由。
 */
const MAX_STREAM_CHARS = 30_000;

/**
 * 默认超时。比 fetch_url 的 30s 长 —— 构建与打包本来就慢。
 *
 * ── 【定】`MAX` 必须等于 `timeoutPolicy.timeoutMs`（2026-08-30 评审 P1）──
 *
 * 原来 `MAX_TIMEOUT_MS = 600_000` 而 `timeoutPolicy.timeoutMs = 120_000`，
 * 于是 schema 向模型承诺「上限 600000」，实际 Runtime 在 120 秒就
 * `AbortSignal.timeout(stepMs)` 把它掐了 —— 而工具把任何 abort 都记成
 * `killedBy = "cancel"`，模型收到的是 **`TOOL_SHELL_CANCELLED`**。
 *
 * 症状是「跑长构建总在两分钟被取消」，而排查方向被错误码带偏：
 * 它看起来像有人按了取消，实际是一条**文档承诺过、实现里不存在**的上限。
 * 这正是本仓反复猎杀的「声明与实现不符」，只是这次藏在两个常量之间。
 *
 * 【定】改任一个都要改另一个。`timeoutPolicy` 是 Runtime 那一侧的步级超时，
 * 它必须 ≥ 工具自己的上限，否则工具内的 timer 永远轮不到。
 */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/**
 * 步级超时 = 工具允许的最大值 **＋ 余量**。
 *
 * 【定】余量不能省。取相等的话，模型传 `timeout_ms: 600000` 时两个 timer
 * 同刻到期，谁先触发是竞态 —— 而输给 Runtime 那一侧就又报回
 * `TOOL_SHELL_CANCELLED`，正是这次要修掉的那个症状。
 * 让工具内的 timer **必然**先到，`TOOL_SHELL_TIMEOUT` 才是稳定结果；
 * Runtime 那道退化成真正的兜底（工具自己的 timer 也失灵时）。
 */
const STEP_TIMEOUT_MS = MAX_TIMEOUT_MS + 30_000;

/** 心跳间隔。必须与 `progressReporting.intervalMs` 一致。 */
const HEARTBEAT_MS = 5_000;

/**
 * 退出码语义表。形态借自 Claude Code 的 `commandSemantics.ts`。
 *
 * 【定】没有这张表的后果是具体的：`grep` 没匹配时退出 1，被当成失败上报，
 * 模型会认为是自己的调用出了问题并**原样重试同一条命令** —— 而它真正
 * 需要知道的是「没找到，换个词」。与 fetch_url 把 404 当成功取回的事实
 * 上报是同一条理由：工具故障与「世界就是这样」必须分得开。
 */
const EXIT_SEMANTICS: Record<string, (code: number) => { isError: boolean; note?: string }> = {
  grep: (c) => ({ isError: c >= 2, note: c === 1 ? "没有匹配到任何内容（不是错误）" : undefined }),
  rg: (c) => ({ isError: c >= 2, note: c === 1 ? "没有匹配到任何内容（不是错误）" : undefined }),
  diff: (c) => ({ isError: c >= 2, note: c === 1 ? "两边有差异（不是错误）" : undefined }),
  find: (c) => ({ isError: c >= 2, note: c === 1 ? "部分目录不可访问（不是错误）" : undefined }),
  test: (c) => ({ isError: c >= 2, note: c === 1 ? "条件为假（不是错误）" : undefined }),
};

export const runShellDefinition: ToolDefinition = {
  id: asId("tool_run_shell"),
  version: "1.0.0",
  name: "run_shell",
  description:
    "在受限沙箱里执行一条 shell 命令（bash -c）。用它来打包/解包（zip、tar）、" +
    "创建或删除文件与目录、跑构建与测试、以及任何没有专用工具的操作。" +
    "沙箱规则（都由内核强制，绕不过去，请照着规划命令）：" +
    "① 只能写 workspace 目录和系统临时目录，往别处写会失败；" +
    "② 读不到凭证文件（.env、.ssh、.aws 等）；" +
    "③ 默认禁止联网，需要联网必须显式传 allow_network=true；" +
    "④ 工作目录固定是 workspace 根，且不跨调用保留 —— 上一次的 cd 对这一次无效，" +
    "要换目录就在同一条命令里写 cd。" +
    '返回 JSON：{"exitCode","stdout","stderr","truncated","durationMs","note"}。' +
    "命令返回非零退出码不算工具故障，看 exitCode 字段判断。",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      description: {
        type: "string",
        description: "用一句话说明这条命令做什么（会展示给用户审批）",
      },
      timeout_ms: {
        type: "number",
        description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`,
      },
      allow_network: {
        type: "boolean",
        description: "是否允许这条命令联网。默认 false。开启后本次调用会被记为数据外发",
      },
    },
    required: ["command"],
  },
  // 【定】本字段当前零消费，授权层推到 bugfix 阶段（阶段 3 方案 S12 / 存量 S3-1）。
  requiredCapabilities: ["process.exec"],
  /**
   * 【定】RESOLVER 而不是 DECLARATIVE —— 这是这一档**第一次被真正需要**。
   *
   * DECLARATIVE 靠 JSON Pointer 指向输入里的目标字段，而一条 shell 命令的
   * 作用域读不出任何一个字段：`zip -r out.zip src` 的作用域既不是
   * `/command` 这个字符串，也不在任何单独参数里 —— 它要靠解析才得得出来。
   */
  effectResolution: { kind: "RESOLVER", resolverRef: SHELL_RESOLVER_REF },
  redaction: { profile: "STANDARD" },
  /**
   * 【定】maxAttempts: 1 —— 不重试。
   *
   * 其他工具重试是安全的，因为它们幂等。一条 shell 命令不是：
   * 自动重试一次 `rm -rf build && make install` 意味着那条命令真的跑了两遍。
   * 重试与否交给模型，它至少知道自己刚才想干什么。
   */
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  /**
   * 【定】说实话：既不幂等也不只读。
   *
   * 这是 `write_file` 那条教训的反面应用 —— 它曾经声明 `isIdempotent: false`
   * 只为了「让分支二有通用工具可测」，把 §18.2 的分支分布系统性带偏。
   * 这里的诱惑是反过来的：标成幂等能让恢复看起来更干净。不能标。
   *
   * 后果是真实的：崩在一条 shell 命令中途，§18.2 会落到分支二/三。
   * 而 `recoveryObservation` 那边决定了它其实落分支三 —— 见下。
   */
  idempotency: { isIdempotent: false, isReadOnly: false },
  timeoutPolicy: { timeoutMs: STEP_TIMEOUT_MS },
  cancellation: { cooperative: true },
  /**
   * 【定】HEARTBEAT 是**承诺**，实现里必须真有周期性的 `ctx.onProgress(`。
   *
   * `read_file` / `search` 曾经声明 HEARTBEAT 而一次都不报，收口批改掉了。
   * `verify:tools` B 段会扫源码里的调用点，缺一即红 —— 所以下面那个
   * `setInterval` 不是可有可无的装饰。
   */
  progressReporting: { mode: "HEARTBEAT", intervalMs: HEARTBEAT_MS },
  /**
   * 【定】NONE，不是 INLINE_RESULT。
   *
   * 退出码与 stdout 已经在 output 里了，再包一层 Verification 不产生任何
   * 新事实 —— 那正是「声明与实现不符」的另一种形态：声明了一个观察，
   * 实际只是把已有字段抄一遍，而结算时它会被当成独立证据。
   */
  verification: { mode: "NONE", requiredForSuccess: false, observationCost: "LOW" },
  /**
   * 【定】要求前置指纹，而 Verifier 对本工具**给不出**指纹 —— 于是
   * `canObserve` 恒假，§18.2 落**分支三 RECOVERY_REQUIRED**。
   *
   * 这不是把字段填错，这是诚实：崩在 `zip -r` 中途，外部世界的状态
   * 真的观察不出来（半个 zip 与没有 zip 在磁盘上都可能长得像成功）。
   *
   * 副产品：`verify:crash` 的第三条分支第一次有了**场景工具**载体 ——
   * 此前只有 `append_log` 这个测量工具，而用测量工具去测分支分布，
   * 正是阶段 2 决 6 要防的「旋钮长在被测对象身上」。
   */
  recoveryObservation: { kind: "TARGET_EXISTS", requiresPreFingerprint: true },
};

export async function executeRunShell(
  input: { command: string; description?: string; timeout_ms?: number; allow_network?: boolean },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  /**
   * 【定】执行期再查一次沙箱可用性。
   *
   * 装配期已经查过（没有沙箱就不进工具面），这里是第二道 —— 理由与
   * `main.ts` 的 autoGrant「执行前用 realpath 重新校验一次」相同：
   * 授权是在决定的那一刻给的，而环境可以在那之后变。
   * 一条闸门排在另一条后面等于没有闸门，两道都要能单独触发。
   */
  if (!isSandboxAvailable()) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NOT_STARTED",
      error: makeError({
        code: "TOOL_SANDBOX_UNAVAILABLE",
        source: "TOOL_HANDLER",
        category: "UNAVAILABLE",
        retryability: "NEVER",
        sideEffectState: "NOT_STARTED",
        safeMessage:
          `这台机器上没有可用的 seatbelt 沙箱（${SANDBOX_EXEC}），run_shell 拒绝执行。` +
          `【定】不降级为无沙箱执行 —— 那会让边界在某些环境下悄悄消失。`,
      }),
    };
  }

  const timeoutMs = clampTimeout(input.timeout_ms);
  const allowNetwork = input.allow_network === true;

  // per-run 临时目录：zip / tar / git 这类工具不能写 tmp 就直接失败。
  const tmpDir = mkdtempSync(join(tmpdir(), "wa-shell-"));
  const profile = buildSandboxProfile({
    workspaceRoot: ctx.workspaceRoot,
    tmpDir,
    allowNetwork,
  });

  /**
   * `shopt -u extglob` 借自 Claude Code 的 `bashProvider.ts`：
   * 扩展 glob 的展开发生在我们判定之后，而文件名本身是攻击者可控的。
   * 这里判定已经很保守，留着它是纵深防御，代价是一条几乎不出错的语句。
   */
  const script = `shopt -u extglob 2>/dev/null || true\n${input.command}`;

  const started = Date.now();
  ctx.onProgress(`开始执行：${input.description ?? truncate(input.command, 60)}`);

  return await new Promise<ToolExecutionOutcome>((resolveOutcome) => {
    const child = spawn(SANDBOX_EXEC, ["-p", profile, "/bin/bash", "-c", script], {
      cwd: ctx.workspaceRoot,
      /**
       * ── 【定】环境**白名单**，不是全量继承（2026-08-30 评审 P1）─────────
       *
       * 原来这里没有 `env` 字段，于是子进程继承 `process.env` 的全部内容 ——
       * 而 `compose.ts` 的 `loadEnv()` 会把 `.env` 里的**真实端点凭证**
       * 注入进来。实测（三份评审各自复现）：
       *
       *     printenv dashscope_api_key   →  sk-ws-H.EYLD…
       *
       * 沙箱拦得住「读凭证**文件**」，拦不住「读已经在自己环境里的凭证」。
       * 一条 `echo $dashscope_api_key > note.txt` 完全合法地落在 workspace 内，
       * 之后进 transcript、进 SQLite。
       *
       * 【定】用白名单不用黑名单。黑名单要求我们**列全所有密钥变量名**，
       * 而 `.env` 里将来会有什么名字我们不知道 —— 失败方向错在那一侧。
       * 白名单漏掉一个变量的代价是某条命令跑不了（看得见），
       * 黑名单漏掉一个的代价是凭证外泄（看不见）。
       */
      env: sanitizedEnv(tmpDir),
      /**
       * 【定】detached 让子进程自成进程组，这样超时/取消时可以
       * `kill(-pid)` 杀掉**整棵树**。
       *
       * 只杀直接子进程的后果：`bash -c "npm run build"` 被杀掉的是 bash，
       * 而 npm 和它拉起的编译器还活着，继续占 CPU、继续写文件 ——
       * Run 已经结算了，副作用还在发生。借自 Claude Code 的 Shell.ts。
       */
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let killedBy: "timeout" | "cancel" | undefined;

    const append = (which: "out" | "err", chunk: string) => {
      const cur = which === "out" ? stdout : stderr;
      if (cur.length >= MAX_STREAM_CHARS) {
        truncated = true;
        return;
      }
      const room = MAX_STREAM_CHARS - cur.length;
      if (chunk.length > room) truncated = true;
      const piece = chunk.slice(0, room);
      if (which === "out") stdout += piece;
      else stderr += piece;
    };

    /**
     * 【定】按 chunk 解码会把多字节字符拆成 U+FFFD（2026-08-30 评审）。
     *
     * `b.toString("utf8")` 在 chunk 边界正好落在一个 CJK 字符中间时，
     * 两半各自解出一个替换字符 —— 而本仓的主要使用场景就是中文输出。
     * `StringDecoder` 会把不完整的尾字节留到下一次，这是它存在的理由。
     */
    child.stdout.on("data", (b: Buffer) => append("out", outDecoder.write(b)));
    child.stderr.on("data", (b: Buffer) => append("err", errDecoder.write(b)));

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        // 负号 = 整个进程组。见上面 detached 的注释。
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已经退出了就没什么可杀的 */
      }
    };

    // ── 心跳（HEARTBEAT 是声明出去的承诺，不是装饰）──
    const heartbeat = setInterval(() => {
      ctx.onProgress(`仍在执行，已 ${Math.round((Date.now() - started) / 1000)} 秒`);
    }, HEARTBEAT_MS);

    const timer = setTimeout(() => {
      killedBy = "timeout";
      killTree();
    }, timeoutMs);

    const onAbort = () => {
      killedBy = "cancel";
      killTree();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      /**
       * 【定】per-run 临时目录必须删掉（2026-08-30 评审）。
       *
       * 原来只清 timer 与 listener，`mkdtempSync` 建的目录**永不回收** ——
       * 每条命令泄漏一个，而它还在沙箱的可写白名单里。
       * 与「仪器不得在被测系统之外留痕」是同一条纪律，只是这次留痕的是工具。
       *
       * 失败不抛：清理失败不该把一次成功的执行变成失败。
       */
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 清不掉就算了，不能让收尾动作改变这次调用的结果 */
      }
    };

    const finish = (o: ToolExecutionOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveOutcome(o);
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        output: "",
        // 【定】spawn 都没成功 = 命令没跑 = NOT_STARTED。
        sideEffectState: "NOT_STARTED",
        error: makeError({
          code: "TOOL_SHELL_SPAWN_FAILED",
          source: "TOOL_HANDLER",
          category: "UNAVAILABLE",
          retryability: "SAME_INPUT_BACKOFF",
          sideEffectState: "NOT_STARTED",
          safeMessage: `启动沙箱进程失败：${String((err as Error).message).slice(0, 200)}`,
        }),
      });
    });

    child.on("close", (code, signal) => {
      const durationMs = Date.now() - started;

      if (killedBy) {
        /**
         * 【定】被杀掉时 sideEffectState 是 `UNKNOWN`，不是 `NO_EFFECT`。
         *
         * 命令跑了一半被 SIGKILL —— 它可能已经写了半个 zip、删了三个文件。
         * 报 NO_EFFECT 是在撒谎，而这个字段正是 §18.2 恢复分支与
         * `recoveryItems` 的依据：报错了会让「有一步状态未知」这件事
         * 从结算里消失，Run 会干干净净地结算成功。
         */
        /**
         * 【定】被杀掉也要把**已经收到的输出**交出去（2026-08-30 评审）。
         *
         * 原来这里是 `output: ""` —— 一条跑了 110 秒才被掐掉的构建，
         * 前 110 秒的编译错误全部蒸发，模型只拿到「副作用未知」，
         * 于是它最可能做的事是原样重跑一遍。
         *
         * 这与文件头「静默截断会让模型拿半截输出当完整结果」是同一条理由的
         * **反面**：那边是「别把不完整的说成完整」，这边是「别把不完整的直接扔掉」。
         * 两边的共同点是**如实**：给出部分输出 ＋ 明说它是部分的。
         */
        const partial = JSON.stringify({
          killedBy,
          partialOutput: true,
          stdout,
          stderr,
          durationMs,
          note: `命令被${killedBy === "timeout" ? "超时" : "取消"}终止，以上是终止前已经收到的输出，**不完整**。`,
        });
        finish({
          ok: false,
          output: partial,
          sideEffectState: "UNKNOWN",
          error: makeError({
            code: killedBy === "timeout" ? "TOOL_SHELL_TIMEOUT" : "TOOL_SHELL_CANCELLED",
            source: "TOOL_HANDLER",
            category: "CANCELLED",
            retryability: "NEVER",
            sideEffectState: "UNKNOWN",
            safeMessage:
              killedBy === "timeout"
                ? `命令超过 ${timeoutMs}ms 未结束，已连同子进程一并终止。已跑了 ${durationMs}ms，副作用状态未知。`
                : `命令被取消，已连同子进程一并终止。副作用状态未知。`,
          }),
        });
        return;
      }

      const exitCode = code ?? -1;
      const semantics = semanticsFor(input.command, exitCode);

      const body = {
        exitCode,
        ...(signal ? { signal } : {}),
        stdout,
        stderr,
        truncated,
        ...(truncated ? { truncatedNote: `单流输出超过 ${MAX_STREAM_CHARS} 字符，已截断。` } : {}),
        durationMs,
        ...(semantics.note ? { note: semantics.note } : {}),
      };

      /**
       * 【定】非零退出码**不报 ok:false**，与 fetch_url 对 4xx/5xx 同口径。
       *
       * 「编译失败」是一个成功取回的事实，不是工具故障。报成失败会让模型
       * 以为是调用出了问题并原样重试，而它真正需要的是去读 stderr。
       * 工具故障留给真正的故障：spawn 不起来、超时、被取消。
       */
      finish({
        ok: true,
        output: JSON.stringify(body),
        /**
         * 【定】只要进程真的跑过，就是 APPLIED —— 哪怕退出码非零。
         *
         * 「命令失败了所以没有副作用」是错的：`rm a b c` 删了 a 才在 b 上失败。
         */
        sideEffectState: "APPLIED",
      });
    });
  });
}

/**
 * 交给子进程的环境变量白名单。见 spawn 处 `env` 的说明。
 *
 * 【定】`TMPDIR` 必须指向我们建的那个目录。
 * 不设的话 zip / tar / git / 编译器用的是**继承的系统 tmp**，
 * 而沙箱只放行了我们新建的那个 —— 于是「放行了一个没人用的目录」，
 * 而真正要写的地方被拒。这是又一个「闸门开在没人走的门上」。
 */
function sanitizedEnv(tmpDir: string): NodeJS.ProcessEnv {
  const KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];
  const out: NodeJS.ProcessEnv = {};
  for (const k of KEEP) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  out["TMPDIR"] = tmpDir;
  /**
   * 【定】显式清掉 `BASH_ENV`。
   *
   * 非交互 bash 会在执行命令**之前** source 它指向的文件 —— 那是一条
   * 绕过我们全部命令判定的任意代码执行通道，而它不在 KEEP 里只是
   * 「碰巧没被带上」。写出来是为了让下一个往 KEEP 里加变量的人看见这条线。
   */
  delete out["BASH_ENV"];
  delete out["ENV"];
  return out;
}

function clampTimeout(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(v), MAX_TIMEOUT_MS);
}

/**
 * 按命令名查退出码语义。
 *
 * 取**最后一段**的程序名 —— 管道与 `&&` 串联时决定退出码的是最后一条。
 * 这是启发式，只用来生成一句给模型看的说明，不参与任何判定。
 */
function semanticsFor(command: string, exitCode: number): { isError: boolean; note?: string } {
  if (exitCode === 0) return { isError: false };
  const segments = command.split(/\|\||&&|[|;\n]/);
  const last = segments[segments.length - 1] ?? command;
  const prog = last.trim().split(/\s+/).find((t) => !t.includes("=")) ?? "";
  const fn = EXIT_SEMANTICS[prog.replace(/^.*\//, "")];
  return fn ? fn(exitCode) : { isError: true };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export const runShellSnapshot: ToolSnapshot = {
  toolId: runShellDefinition.id,
  version: runShellDefinition.version,
  contentHash: `${runShellDefinition.name}@${runShellDefinition.version}`,
  definition: runShellDefinition,
};
