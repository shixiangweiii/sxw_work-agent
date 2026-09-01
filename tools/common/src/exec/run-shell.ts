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
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type {
  ProducedArtifact,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";
import { artifactKindOf } from "../artifact-checks/index.js";
import { isInsideWorkspace, resolveToolPath } from "../fs/fs-common.js";
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
  /**
   * 1.1.0：新增 `artifact_path` / `artifact_role`，并改变了执行后的行为
   * （读回字节登记产物、执行前拍快照）—— 入参与语义都变了，版本必须动。
   *
   * ⚠️ 【定】升它是**卫生**，不是修好了什么：`ToolSnapshot.contentHash`
   * （= `name@version`）在 Runtime 里**零消费者**，全仓只有类型声明那一处。
   * 也就是说今天没有任何东西会因为版本不变而漏报漂移 ——
   * 二次评审说「旧 Run Resume/Replay 无法检测语义漂移」时假设了一个
   * 并不存在的检测器。**真正的缺口是那个字段没接线**（S3-1 同族），
   * 登记在 S5-8；在它接上之前，版本号只对读代码的人有意义。
   */
  version: "1.1.0",
  name: "run_shell",
  /**
   * ── 【定】① 这一条是**承诺**，必须与 `sandbox.ts` 放行的范围逐字对齐 ──
   *
   * 它原本写的是「只能写 workspace 目录和**系统临时目录**」，而 R-8
   * （阶段 3.5 收口）把 tmp 收窄成了 per-call 的 `mkdtemp` 目录并把
   * `TMPDIR` 指过去 —— **这句话没有跟着改**。真实端点实跑撞出来的
   * （Run `run_75f0d6afafa6` 第 7 轮）：模型照着这句话写
   *
   *     curl -s … -o /tmp/bili_article.html ; wc -c /tmp/bili_article.html
   *
   * 沙箱拒了写，`curl -s` 把错误吞掉，模型只看到「文件不存在」，
   * 白花一轮才换到 workspace。**模型是按文档办事的，错的是文档。**
   *
   * 这是本仓反复猎杀的「声明与实现不符」的又一个形态：上一次藏在
   * `MAX_TIMEOUT_MS` 与 `timeoutPolicy` 两个常量之间，这次藏在一次
   * 正确的收窄修复留下的一句旧承诺里 —— 收窄的人不会想到去改文案，
   * 而模型是这句话唯一的读者。
   *
   * 判据在 `verify:shell` B7，**双侧**：`$TMPDIR` 写得进、`/tmp` 写不进。
   * 只验一侧不行 —— 见 `sandbox.ts` 文件头那条（一个拒绝一切的沙箱与一个
   * 正确的沙箱，在「越界写被拦」那条判据下不可区分）。
   *
   * ── 「批量操作请让它能失败」那两句：**故意没有机械判据** ────────────────
   *
   * 它补的是同一次实测里的另一半（Run `run_75f0d6afafa6` 第 12 轮）：
   * 11 张图的下载循环用 `curl -s -L`，没有 `--fail`、没有 `set -euo pipefail`、
   * 没有「恰好 11 项」的断言。那次 11 个 URL 恰好全有效，**是侥幸不是机制**。
   * 同一条轨迹里已经有判别样本：第 6 轮 `grep -P` 报错，末端的 `sort` 把
   * 管道退出码变成 0，工具如实报了 `exitCode:0`。
   *
   * 【定】不要为这两句加「description 里必须出现某个词」的判据。
   * 摸底考试 B 组已经拒绝过那类判据：它测的是措辞在不在，而**要改变的是
   * 模型的行为**，两者之间没有机械关系。这两句只能靠 live 复跑验证
   * （同一道题跑几次，看下载循环里有没有 `--fail` / `pipefail`）。
   *
   * 也不要把它挪到 Runtime 里去「替模型加上 set -e」—— 那是替用户改写他
   * 已经审批过的命令，审批看到的与真正执行的从此不是同一条。
   *
   * ── `artifact_path` 的措辞：**不要把「像」说成「能」**（二次评审 codex P1-5）──
   *
   * 它第一版写的是「按类型做结构检查（**zip 能不能解开**、…）」，而
   * `artifact-checks` 自己的【定】写着「只做**结构**判定，不真的解压」——
   * 实际只判 `PK` 魔数与末尾 66KiB 内的 EOCD。
   *
   * 【定】这是上面 M1 那一类（声明与实现不符）**在同一批里被我自己复制了一遍**，
   * 而读者同样是模型。检查器的强度是什么，这里就写什么：
   * 头尾结构完整、能解析、文件头相符 —— 一条都不等于「内容是对的」。
   */
  description:
    "在受限沙箱里执行一条 shell 命令（bash -c）。用它来打包/解包（zip、tar）、" +
    "创建或删除文件与目录、跑构建与测试、以及任何没有专用工具的操作。" +
    /**
     * ── 【定】这一句是 ADR-0012 的必需品，不是客套（M1 / R2 的同族）─────────
     *
     * 下面四条沙箱规则在 UNRESTRICTED 档下**全部不成立**。而 description 是
     * 模块级常量、档位是随 Run 冻结的值 —— 静态文本没有办法只在某一档出现。
     *
     * 两条路：让工具面按档位产两份 snapshot（要动 `commonTools` 那个常量数组，
     * 且工具 version 得跟着档位变，牵动 §18.2 的分支判定前提），
     * 或者**在这里留一个指针**、由受信事实去更正它（`compile.ts` 的
     * `UNRESTRICTED_FACT`）。选后者，代价如实记：这句话从"我保证"降级成
     * "默认如此，以系统事实为准"。
     *
     * 不留这个指针的后果是 M1 原样重演：模型照着一句已经不成立的承诺规划命令。
     */
    "沙箱规则（默认档位下由内核强制、绕不过去，请照着规划命令；" +
    "若上下文里有系统事实声明本次为 UNRESTRICTED 档，则以那条事实为准）：" +
    "① 只能写两个地方：workspace 目录，以及本次调用私有的临时目录 —— " +
    "要用临时目录就写 $TMPDIR（它已指向那个目录），**不要写 /tmp 或 /var/tmp**，" +
    "那里写不进去，而 curl -o、tee 这类程序失败时往往不出声；" +
    "临时目录每次调用都是新的，不跨调用保留，要跨步骤留东西就写在 workspace 里；" +
    "② 读不到凭证文件（.env、.ssh、.aws 等）；" +
    "③ 默认禁止联网，需要联网必须显式传 allow_network=true；" +
    "④ 工作目录固定是 workspace 根，且不跨调用保留 —— 上一次的 cd 对这一次无效，" +
    "要换目录就在同一条命令里写 cd。" +
    "批量操作（下载/转换/打包一组文件）请让它**能失败**：开头写 set -euo pipefail，" +
    "curl 加 --fail，结尾断言产出数量与预期一致。" +
    "管道的退出码只取决于**最后**一条命令，前面的失败会被吞掉 —— " +
    "不这么写的话，某一项失败时命令照样退出 0，你会把一个不完整的结果当成完成。" +
    '返回 JSON：{"exitCode","stdout","stderr","truncated","durationMs","note"}。' +
    "命令返回非零退出码不算工具故障，看 exitCode 字段判断。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
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
      artifact_path: {
        type: "string",
        description:
          "这条命令要产出的交付物路径（相对 workspace 根）。声明了它，命令成功后系统会" +
          "登记这个文件并按类型做结构检查（zip 的头尾结构完整、JSON 能解析、" +
          "图片等二进制的文件头与扩展名相符、登记内容与磁盘一致），" +
          "检查通过才会计入本次任务的交付物。**打包、导出、生成文件这类任务请填它** —— " +
          "不填的话系统无法证明你交付的东西是好的，只能相信你的自述。" +
          "注意这些是**结构**检查，不解压也不解码 —— 内容对不对仍然由你负责。",
      },
      // 【定】取值写进 description，不写 `enum` —— `JsonSchemaProperty` 里没有那个字段，
      // 与 write_file 的 artifact_role 保持同一种写法（两处措辞是成对的）。
      artifact_role: {
        type: "string",
        description:
          'artifact_path 的角色："DELIVERABLE"（用户要的最终交付物，检查不通过会判任务失败）' +
          '或 "INTERMEDIATE"（中间产物）。不填按 DELIVERABLE 处理',
      },
    },
    required: ["command"],
  },
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
  /**
   * 【定】HEARTBEAT 是**承诺**，实现里必须真有周期性的 `ctx.onProgress(`。
   *
   * `read_file` / `search` 曾经声明 HEARTBEAT 而一次都不报，收口批改掉了。
   * `verify:tools` B 段会扫源码里的调用点，缺一即红 —— 所以下面那个
   * `setInterval` 不是可有可无的装饰。
   */
  progressReporting: { mode: "HEARTBEAT" },
  /**
   * 【定】NONE，不是 INLINE_RESULT。
   *
   * 退出码与 stdout 已经在 output 里了，再包一层 Verification 不产生任何
   * 新事实 —— 那正是「声明与实现不符」的另一种形态：声明了一个观察，
   * 实际只是把已有字段抄一遍，而结算时它会被当成独立证据。
   */
  verification: { mode: "NONE", requiredForSuccess: false },
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
  recoveryObservation: { requiresPreFingerprint: true },
};

/**
 * 一次登记最多读多大的文件进内存（ADR-0010 接受的代价）。
 *
 * 【定】超过就**不登记 ＋ 显式说明**，不是静默跳过。
 * 静默跳过的后果 S3-27 已经写过一次：「未登记时 trace 里没有任何
 * 『跳过了检查』的信号 —— 静默 = 通过」。
 *
 * 这个数字是拍的，没有证据。要支持更大的产物得改成从磁盘流式算 hash，
 * 而那要先解决「存储层不认识 workspaceRoot」（ADR-0010 方案 C）。
 */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export async function executeRunShell(
  input: {
    command: string;
    description?: string;
    timeout_ms?: number;
    allow_network?: boolean;
    artifact_path?: string;
    artifact_role?: string;
  },
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
  /**
   * ── ADR-0012：UNRESTRICTED 是**唯一**允许不进沙箱的路径 ─────────────────
   *
   * 【定】它与「沙箱不可用就降级」有本质区别，这个区别就是这一段存在的理由：
   *
   *   降级   ＝ 环境决定的、无声的、调用方看不出来的边界消失；
   *   本档位 ＝ 人在启动参数里显式选择的、冻结进 RunSpec 的、
   *            出现在受信事实 / 审批面 / Trace / 界面徽章上的边界让渡。
   *
   * 所以上面那条【定】（不降级为无沙箱执行）**一个字没改**：SANDBOXED 档
   * 拿不到沙箱仍然是硬失败。改的只是"有没有第二种被允许的情形"。
   */
  /**
   * ── 【定】两档**都**要走 seatbelt，这条闸门一个字没改（ADR-0012）───────
   *
   * UNRESTRICTED 不是"不套沙箱"，是一份只剩凭证读禁的窄 profile
   * （见 `SandboxProfileOptions.executionPrivilege` 那段被判据 B10 逼出来的
   * 记录）。所以「没有沙箱就拒绝执行」在两档下同样成立 ——
   * 少了它，UNRESTRICTED 会在非 darwin 上悄悄退化成"连凭证读禁也没有"。
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
          `【定】不降级为无沙箱执行 —— 那会让边界在某些环境下悄悄消失。` +
          `UNRESTRICTED 档也一样：那一档仍然要靠 seatbelt 挡住凭证文件的读取。`,
      }),
    };
  }

  const timeoutMs = clampTimeout(input.timeout_ms);
  const allowNetwork = input.allow_network === true;

  /**
   * ── 【定】声明了产物就先拍一张**执行前**的快照（二次评审 codex P1-2）────
   *
   * 没有它的话，`collectDeclaredArtifact` 只能看到「命令跑完之后那个路径上
   * 有个文件」，而分不出两件完全不同的事：
   *
   *   这次生成的        ← 真交付物
   *   本来就在那，命令根本没碰它  ← **冒认**
   *
   * 后者不是假想：workspace 里留着上一次任务的 `images.zip`，这次的命令
   * 前半段失败而整体退出码是 0（管道 / 无 `set -e`，正是 M5 那条），
   * 旧 zip 就会被登记、验证、并作为本 Run 的交付物交出去 —— 而它连
   * 结构检查都能过，因为它本来就是个好 zip。
   *
   * 【定】指纹用 `mtimeMs + size`，**不是**仓里 `FileFingerprint` 那个内容 hash。
   * 这里不是偷懒：要答的是「命令碰没碰它」，而内容 hash 会把
   * 「重新生成出逐字节相同的产物」误判成「没生成」—— 那是错的方向。
   * 顺带也避免了为拍快照去读一个可能很大的旧文件。
   */
  const preSnapshot = await snapshotForArtifact(input.artifact_path, ctx.workspaceRoot);

  // per-run 临时目录：zip / tar / git 这类工具不能写 tmp 就直接失败。
  //
  // 【定】UNRESTRICTED 档也照建、`$TMPDIR` 也照指过去。它此时不再是一道边界
  // （哪儿都能写），但它仍然是一条**约定**：模型按同一套规则规划命令，
  // 两个档位下 `$TMPDIR` 的含义不变。少了它，同一句任务在两档下要写两种命令，
  // 而那个差别没有任何地方会讲给模型听。
  const tmpDir = mkdtempSync(join(tmpdir(), "wa-shell-"));
  const profile = buildSandboxProfile({
    workspaceRoot: ctx.workspaceRoot,
    tmpDir,
    allowNetwork,
    executionPrivilege: ctx.executionPrivilege,
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
      void (async () => {
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

      /**
       * ── 声明的交付物：读回字节交给 Runtime 登记（ADR-0010）────────────
       *
       * 【定】路径是**执行前**声明的（在命令入参里，人在审批时就看得见），
       * Runtime 仍然不扫 workspace、不从 output 里猜 —— §17 语义 1 不松动。
       *
       * 【定】拿不到产物的四种情形**都要说话**，一条都不能静默跳过。
       * S3-27 已经记过一次这个形态：「未登记时 trace 里没有任何『跳过了检查』
       * 的信号 —— 静默 = 通过」。所以下面每条分支都产出 `artifactNote`。
       */
      const declared = await collectDeclaredArtifact(input, ctx, exitCode, preSnapshot);

      const body = {
        exitCode,
        ...(signal ? { signal } : {}),
        stdout,
        stderr,
        truncated,
        ...(truncated ? { truncatedNote: `单流输出超过 ${MAX_STREAM_CHARS} 字符，已截断。` } : {}),
        durationMs,
        ...(semantics.note ? { note: semantics.note } : {}),
        ...(declared.note ? { artifactNote: declared.note } : {}),
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
        ...(declared.artifact ? { artifact: declared.artifact } : {}),
      });
      })();
    });
  });
}

/**
 * 把声明的交付物读回成字节。
 *
 * 【定】读的是**磁盘上那一份**，而第二层检查会再独立读一次去比 hash
 * （`artifact-checks` 第 ① 项）。两次取数之间文件被改过就会红 ——
 * 这道闸门的判别力全部来自「两次独立取数」，不要改成让工具自报 hash。
 */
async function collectDeclaredArtifact(
  input: { artifact_path?: string; artifact_role?: string },
  ctx: ToolExecutionContext,
  exitCode: number,
  pre: PreSnapshot | undefined,
): Promise<{ artifact?: ProducedArtifact; note?: string }> {
  const rel = normalizeArtifactPath(input.artifact_path);
  if (rel === "") return {};

  // 【定】只认 DELIVERABLE / INTERMEDIATE，与 write_file 同一条纪律。
  // 不填按 DELIVERABLE —— 会专门去声明产物路径的人要的就是交付物，
  // 而把它降级成 INTERMEDIATE 会顺带把「检查失败判 FAILED」这条强制力也降掉。
  const role = input.artifact_role === "INTERMEDIATE" ? "INTERMEDIATE" : "DELIVERABLE";

  if (exitCode !== 0) {
    return { note: `声明了交付物 ${rel}，但命令以 exitCode=${exitCode} 结束，未登记。` };
  }

  const abs = resolveToolPath(ctx.workspaceRoot, rel);
  if (!isInsideWorkspace(ctx.workspaceRoot, abs)) {
    return { note: `声明的交付物 ${rel} 不在 workspace 内，未登记。` };
  }

  let bytes: Buffer;
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { note: `声明的交付物 ${rel} 不是一个普通文件，未登记。` };
    /**
     * 【定】命令没碰过它 ⇒ **不登记**（二次评审 codex P1-2）。
     *
     * 判据是执行前后的 `mtimeMs + size` 完全没变，而它执行前就存在 ——
     * 那说明这个文件不是本次产出的，登记它等于把上一次任务留下的旧产物
     * 冒认成本 Run 的交付物。它甚至能通过全部结构检查，**因为它本来就是好的**。
     *
     * 失败方向定在「拒绝 ＋ 说清楚」这一侧：模型看到这句话可以去重新生成，
     * 或者承认自己那条命令什么都没做。反过来（默默登记）没有任何东西会说话。
     */
    if (pre?.existed === true && pre.size === info.size && pre.mtimeMs === info.mtimeMs) {
      return {
        note:
          `声明的交付物 ${rel} 在命令执行前就存在，且执行前后大小与修改时间完全没变 —— ` +
          `这条命令没有产出它，未登记。要交付它就先真的生成一次；` +
          `如果它确实是上一步产出的，请在产出它的那条命令上声明。`,
      };
    }
    if (info.size > MAX_ARTIFACT_BYTES) {
      return {
        note:
          `声明的交付物 ${rel} 有 ${info.size} 字节，超过登记上限 ${MAX_ARTIFACT_BYTES}，未登记。` +
          `文件本身还在，只是这次没有产物级检查。`,
      };
    }
    bytes = await readFile(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "未知错误";
    /**
     * 【定】这一条最值得说清楚：命令**成功了**，而它声称要产出的东西不在。
     * 那多半意味着命令做的事和它自己描述的不是一回事 —— 模型需要看到这句话，
     * 而不是看到一个干干净净的成功。
     */
    return { note: `命令成功了，但声明的交付物 ${rel} 读不到（${code}），未登记。` };
  }

  return {
    // 覆盖掉一个已存在的文件是合法的（重新打包），但它值得在审计里留一句 ——
    // 「产物是新建的」与「产物盖掉了别人的东西」对事后追查不是一回事。
    ...(pre?.existed === true
      ? { note: `交付物 ${rel} 覆盖了执行前就存在的同名文件（${pre.size} 字节 → ${bytes.byteLength} 字节）。` }
      : {}),
    artifact: {
      // logicalId 用相对路径：同一个文件被改两次形成版本链（与 write_file 同口径）。
      logicalId: rel,
      role,
      kind: artifactKindOf(rel),
      path: rel,
      content: bytes,
      /**
       * 【定】与上面那句 note **同一个事实的两个读者**：note 给模型看，
       * 这个字段给人和 Trace 看。
       *
       * 在此之前它只有前者 —— 实测 Run `run_18c20267c1a1` 里，模型确实
       * 靠那句话发现了 `zip` 追加旧归档的问题，但事后要在盘上回答
       * 「这个交付物是新建的还是改出来的」，一个字都查不到。
       */
      ...(pre?.existed === true ? { replacedBytes: pre.size } : {}),
    },
  };
}

/** 执行前那一眼。见 `executeRunShell` 里 `preSnapshot` 那段的【定】。 */
interface PreSnapshot {
  existed: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * 执行**前**给声明的产物路径拍一张快照。
 *
 * 【定】任何失败都返回 `undefined`（＝「没拍到」），不抛也不猜。
 * 拍不到时 `collectDeclaredArtifact` 会退回到「只要文件在就登记」的老行为 ——
 * 那是**放松**的方向，所以这里的失败必须是可解释的：越界路径在下游还会
 * 被 `isInsideWorkspace` 拦一次，其余情形（权限、竞态）拍不到就是拍不到。
 */
async function snapshotForArtifact(
  artifactPath: string | undefined,
  workspaceRoot: string,
): Promise<PreSnapshot | undefined> {
  const rel = normalizeArtifactPath(artifactPath);
  if (rel === "") return undefined;
  try {
    const abs = resolveToolPath(workspaceRoot, rel);
    const info = await stat(abs);
    if (!info.isFile()) return undefined;
    return { existed: true, size: info.size, mtimeMs: info.mtimeMs };
  } catch (err) {
    // 【定】ENOENT 是一个**有效**的起始状态（「本来没有」），与 snapshotFile 同口径。
    // 它正是最常见、也最该被记下来的那一种：产物确实是这次新建的。
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { existed: false, size: 0, mtimeMs: 0 };
    }
    return undefined;
  }
}

/**
 * 归一化声明的产物路径（二次评审 zcode F4）。
 *
 * 【定】`logicalId` 是版本链的身份。不归一化的话，`images.zip`、
 * `./images.zip`、`images/../images.zip` 会形成**三条互不相干的版本链**，
 * 指向同一个文件 —— 而「同一个文件被改了两次」正是版本链存在的理由。
 *
 * 【定】只做无歧义的化简（`./`、`a/../b`、重复斜杠），**不做**把绝对路径
 * 折成相对这种猜测：越界与否交给下游的 `isInsideWorkspace` 用 realpath 判，
 * 这里猜一次等于多一道口径不同的边界判定。
 */
function normalizeArtifactPath(raw: string | undefined): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "") return "";
  if (isAbsolute(s)) return s;
  const normalized = normalize(s);
  // `normalize` 会留下 `./` 前缀之外的形态，这里再削一次开头的 `./`
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
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
  definition: runShellDefinition,
};
