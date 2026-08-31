/**
 * CLI 入口（V05 §5）。
 *
 * 阶段 1 没有图形界面 —— 那是阶段 4。
 * 但「不是不能交互」：Approval / Interject / Cancel 都在阶段 1 范围内，
 * 所以终端必须能停下来问、能中途插话、能 Ctrl+C。
 *
 * 阶段 2 补上了跨进程的那一半 —— 三条恢复分支（§18.2）在此之前
 * **在真实使用里一条都走不到**，因为没有任何入口能触发 resume：
 *
 *   npm run dev -- --task "统计 ./notes 下有几个文件，写一份 summary.txt"
 *   npm run dev -- --list-runs
 *   npm run dev -- --resume run_xxx
 *   npm run dev -- --resume run_xxx --recovery-decision CONTINUE --recovery-note "已人工确认"
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  ApprovalDecider,
  ApprovalDecision,
  PreparedAction,
  RunEvent,
  RunId,
  TraceSinkPort,
  TranscriptEntry,
} from "@workagent/harness-runtime";
import { NullTraceSink, asId, readRunFacts } from "@workagent/harness-runtime";
import { SqliteRunStore, openDb } from "@workagent/store-sqlite";
import type { HandoffChannel, QuestionChannel } from "@workagent/tools-common";
import {
  autoGrantVerdict,
  compose,
  gitProvenance,
  hostOf,
  parseEndpointArg,
  REPO_ROOT,
  resolveDbPath,
  stripUnsafeDisplayChars,
  workspaceStorage,
  type AutoGrantVerdict,
  type EndpointChoice,
} from "./compose.js";
import { FileTraceSink } from "./trace/file-sink.js";
import { finishRendering, renderEvent } from "./render.js";
import { StdinChannel } from "./stdin-channel.js";

type Mode = "start" | "resume" | "list";

interface Args {
  mode: Mode;
  task: string;
  workspace: string;
  /**
   * 每一个需要审批的操作都停下来问。
   *
   * ── 【定】没有 `--yes` ────────────────────────────────────────────────
   *
   * 决 3 起「workspace 内的可逆写自动放行」是**默认行为**，于是 `--yes`
   * 变成了一个「显式写出默认值」的开关。而 `parseArgs` **从来没有解析过它** ——
   * 字段是 `yes: !argv.includes("--confirm")`，两个字段编码同一个 bit，
   * 打 `--yes` 之所以「能用」纯粹是因为默认本来就是它。
   * 一个文档里承诺、实现里不存在的开关，正是本仓反复猎杀的形态。
   *
   * 理由（决 3）：不接 Capability 授权层时，每写一个文件就停下来问一次，
   * 在「读一批文档 → 汇总 → 产出」这种任务里会问十几次 —— 那不是安全，
   * 是把闸门变成噪音，用户会开始无脑回车（而无脑回车比自动放行更糟：
   * 它看起来像是有人在把关）。边界仍在，只是位置不同：越界写由 Policy
   * **直接拒绝**（不给审批机会），不可逆与 EXECUTE 仍然逐次问。
   */
  confirm: boolean;
  /** 显式的「批准一切」。见 interactiveApproval 里 E-3 那段说明。 */
  yesAll: boolean;
  /** undefined = --no-trace；string = 显式 --trace 路径；"auto" = 按 runId 定名 */
  trace: string | undefined;
  dbPath: string;
  runId: string;
  recoveryDecision: "CONTINUE" | "ABORT" | undefined;
  recoveryNote: string | undefined;
  /**
   * P1-1：官方入口终于能选端点了。
   *
   * `compose()` 从阶段 2 起就支持 `endpoint`，但**只有验收脚本传得进去** ——
   * `npm run dev` 没有任何办法换端点。这是「装配完成 ≠ 可达」的第三次显形
   * （前两次是 `interject` 与 `resume`）：能力在，入口不在。
   *
   * 开发期要频繁换端点验证工具行为，所以它是批 1 的第一步。
   */
  endpoint: EndpointChoice;
}

/**
 * 认识的参数。**带值的与开关分开列**，因为拒绝未知参数要跳过被消费的那个值。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】未知参数**必须让命令失败**，不能静默忽略。
 *
 * 这条是 `--yes` 那件事的收尾：那个开关从来没有被解析过，
 * 打上去之所以「能用」纯粹因为默认档位本来就是它。一个被静默吞掉的
 * 参数与一个生效的参数，在用户那里完全不可区分 ——
 * 而这正是本仓反复记的「静默忽略用户配置比不支持更糟」（M-5 的形态）。
 * ══════════════════════════════════════════════════════════════════════
 */
const VALUE_FLAGS = ["task", "workspace", "trace", "db", "resume", "recovery-decision", "recovery-note", "endpoint"];
const BOOL_FLAGS = ["confirm", "yes-all", "no-trace", "list-runs"];

function assertKnownArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) continue;
    const name = raw.slice(2);
    if (BOOL_FLAGS.includes(name)) continue;
    if (VALUE_FLAGS.includes(name)) {
      i += 1; // 跳过它的值，免得值本身被当成参数
      continue;
    }
    throw new Error(
      `不认识的参数 ${raw}。\n` +
        `可用：${[...BOOL_FLAGS, ...VALUE_FLAGS].map((f) => `--${f}`).join(" ")}\n` +
        (name === "yes"
          ? `（\`--yes\` 已删除：workspace 内的可逆写自动放行本来就是**默认档位**，` +
            `而这个开关从来没有被解析过。要逐次询问用 --confirm，要批准一切用 --yes-all。）`
          : ""),
    );
  }
}

function parseArgs(argv: string[]): Args {
  assertKnownArgs(argv);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const workspace = resolve(get("workspace") ?? resolve(REPO_ROOT, ".workagent-workspace"));
  const resumeId = get("resume");
  const mode: Mode = argv.includes("--list-runs") ? "list" : resumeId ? "resume" : "start";

  const decision = get("recovery-decision");
  if (decision !== undefined && decision !== "CONTINUE" && decision !== "ABORT") {
    throw new Error(`--recovery-decision 只能是 CONTINUE 或 ABORT，收到：${decision}`);
  }

  /**
   * 【定】`--endpoint` 受**枚举约束**，拼错立刻失败。
   *
   * 校验在 `compose.ts` 里（那是全仓唯一写死端点名的地方），`eval/suite`
   * 调的是同一个函数 —— 抄一份的话，两个入口的枚举迟早会不一致。
   */
  const endpoint = parseEndpointArg(argv);

  return {
    mode,
    task: get("task") ?? "看看 workspace 根目录里有什么，然后写一份 summary.txt 说明你看到了什么。",
    workspace,
    // 决 3：默认放行（有限 auto-grant）。`--confirm` 显式恢复逐次询问。
    confirm: argv.includes("--confirm"),
    yesAll: argv.includes("--yes-all"),
    /**
     * 【定】默认开着。
     *
     * 评测报告的原话是「若外部评测器没有像本次这样主动捕获 stdout，轨迹会丢失」——
     * 默认关闭等于把「记不记录」这个决定推给每一个使用者，而忘记开的那次
     * 恰恰是最想回看的那次。要关就显式 --no-trace。
     */
    trace: argv.includes("--no-trace") ? undefined : (get("trace") ?? "auto"),
    dbPath: resolveDbPath(workspace, get("db")),
    runId: resumeId ?? "",
    recoveryDecision: decision as Args["recoveryDecision"],
    recoveryNote: get("recovery-note"),
    endpoint,
  };
}

/**
 * 交互式审批。
 *
 * 与验收脚本注入的 scripted decider 是同一个接口 —— 这正是把它做成
 * 注入点而不是 Runtime 内建的理由（V05 §14.3）：
 * 验收脚本必须能无人值守跑完。
 */
function interactiveApproval(
  /** 默认档位：workspace 内、非 IRREVERSIBLE 的写事先同意（决 3）。 */
  limitedAutoGrant: boolean,
  yesAll: boolean,
  workspaceRoot: string,
  signal: AbortSignal,
  /**
   * 【定】审批走**共用**的 stdin 通道，不再自建 readline。
   *
   * 阶段 3 加了运行期插话之后，两个各自 `createInterface` 的消费者会抢同一行
   * —— 恰好在等审批时敲了一句插话，那一行会被谁吃掉是不确定的。
   * 见 stdin-channel.ts 的文件头。
   */
  stdin: StdinChannel,
): ApprovalDecider {
  /**
   * ── E-3：默认档位不再是「批准一切」────────────────────────────────────
   *
   * 原实现对模型后续提出的**任何** PreparedAction 一律放行。复评报告的
   * 措辞是「应增加基于 effect、路径和 operation 的有限 auto-grant，
   * 并在执行前用 realpath/lstat 重新校验」。
   *
   * 现在的语义是「**workspace 内、找得回来的写，我事先同意**」——
   * 三条都要满足才自动放行：
   *   ① 作用域落在 workspace 内（realpath 之后，与 R-5 同一道判定）；
   *   ② 不是 IRREVERSIBLE（覆盖写算「找得回来」，追加与删除不算）；
   *   ③ 不是 EXECUTE。
   *
   * 不满足的仍然停下来问。真要「批准一切」，得显式写 `--yes-all` ——
   * 让那个决定有名字，而不是藏在一个看起来很无害的开关后面。
   *
   * 【定】决 3 起这是**默认档位**，`--confirm` 才回到「每一步都问」。
   */
  if (yesAll) {
    return async (a: PreparedAction) => {
      console.log(`  \x1b[33m(--yes-all) 无条件批准\x1b[0m ${a.toolName} → ${a.resolvedEffect.effectType}`);
      return { approved: true };
    };
  }

  /**
   * 【定】档位判定住在 Composition Root（`compose.ts` 的 `autoGrantVerdict`），
   * 终端与 Web 两个入口**共用同一份**。
   *
   * 阶段 4 之前它是这里的一个闭包 —— 只有终端能用。Web 入口再抄一份的直接后果是
   * 两个入口的闸门档位迟早不一致，而那种不一致在绿灯下看不出来：两边都会问，
   * 只是问的东西不一样。理由与判定内容都搬到了 `autoGrantVerdict` 的注释里。
   */
  const autoGrant = (a: PreparedAction): AutoGrantVerdict => autoGrantVerdict(a, workspaceRoot);

  /**
   * 停下来问一句。
   *
   * U-2 / R-2 的一半：等待接上 signal —— 在此之前 Ctrl+C 打不断审批等待，
   * 用户得再敲一次回车才轮得到取消生效。
   *
   * 【定】无 TTY 时按**拒绝**处置，不是按批准。没人应答不能当作默许
   * （与 ApprovalPolicySnapshot.approvalTimeoutMs 同一个口径）——
   * 那会让「写操作要人确认」这条闸门在无人值守时自动敞开，
   * 而无人值守恰恰是最不该敞开的场景。
   */
  const ask = async (a: PreparedAction, prefix: string): Promise<ApprovalDecision> => {
    const e = a.resolvedEffect;
    finishRendering();
    /**
     * ── PROCESS scope 必须把命令原文打出来（阶段 3.5）─────────────────────
     *
     * 【定】`scope.value` 对一条 shell 命令是**程序名集合**（`programs:zip,mkdir`），
     * 因为 §12.4 要求「不以自由文本作为授权边界」。这条规则是对的，
     * 但它有一个必须补上的代价：只打 `scope.value` 的话，人看到的是
     *
     *     是否允许 run_shell 执行 EXECUTE → programs:rm ？[y/N]
     *
     * —— 而 `rm -rf build` 与 `rm -rf /` 在这一行里长得**一模一样**。
     * 那不是审批，那是盲批：一个看起来有闸门、实际什么都没拦住的闸门，
     * 比没有闸门更糟，因为它还会让人以为自己确认过了。
     *
     * 按 `scope.kind` 判而不是按工具名判 —— 将来任何一个 PROCESS scope 的
     * 工具都自动获得同样的展示，而这里一行都不用改。
     */
    if (e.scope.kind === "PROCESS") {
      const input = a.normalizedInput as Record<string, unknown>;
      const cmd = typeof input["command"] === "string" ? input["command"] : "(读不到命令原文)";
      const desc = typeof input["description"] === "string" ? input["description"] : "";
      console.log(`\n  \x1b[33m即将执行的命令\x1b[0m${desc ? `（${forTerminal(desc)}）` : ""}：`);
      for (const l of forTerminal(cmd).split("\n")) console.log(`    \x1b[1m${l}\x1b[0m`);
      // 【定】这一行与 `run_shell` 的 description ①、Web 审批卡是**同一句话的三处**，
      // 必须一起改。分叉过一次：description 承诺「系统临时目录」而实现只放行
      // per-call 的 $TMPDIR，模型照着写 /tmp 白花一轮（见 run-shell.ts 的说明）。
      console.log(`  沙箱：只能写 workspace 与本次调用的 $TMPDIR；${
        input["allow_network"] === true ? "\x1b[31m本次允许联网\x1b[0m" : "禁止联网"
      }`);
      // 这条命令自称要交付什么（ADR-0010）。与 Web 审批卡同一份内容 ——
      // 人批准的不只是「跑这条命令」，还有「它自称要交付这个文件」。
      if (typeof input["artifact_path"] === "string" && input["artifact_path"] !== "") {
        const role = input["artifact_role"] === "INTERMEDIATE" ? "INTERMEDIATE" : "DELIVERABLE";
        console.log(`  声明的交付物：${forTerminal(String(input["artifact_path"]))}（${role}）`);
      }
    }
    stdin.setMode("WAITING_FOR_APPROVAL");
    try {
      /**
       * 【定】`scope.value` 也要剥（二次评审 codex P2-5）。
       *
       * 上面的命令原文与描述早就走了 `forTerminal()`，而**真正等输入的这一行**
       * 一直在直接插原始 `e.scope.value` —— 而它同样含模型给的内容：
       * PROCESS scope 是切出来的程序名、FILE / DIRECTORY scope 是模型给的路径。
       * 一个 ANSI 清屏或双向覆盖序列可以把上面刚打印的、剥过的命令整段盖掉，
       * 于是「剥了三处、漏了最后一处」等于没剥 —— 人最后看到的就是这一行。
       *
       * Web 侧 `scopeValue` 从阶段 4 收口起就是剥过的；两个入口的安全语义
       * 必须一致，否则「CLI 更不安全」这件事没有任何地方会说出来。
       */
      const line = await stdin.askLine(
        `${prefix}  是否允许 ${a.toolName} 执行 ${e.effectType} → ${forTerminal(e.scope.value)} ？[y/N] `,
        signal,
      );
      if (line === undefined) {
        return {
          approved: false,
          reason: stdin.isInteractive ? "等待被中断" : "非交互环境下无人应答，按拒绝处置",
        };
      }
      const ans = line.toLowerCase();
      return ans === "y" || ans === "yes"
        ? { approved: true }
        : { approved: false, reason: "用户在终端拒绝" };
    } finally {
      stdin.setMode("RUNNING");
    }
  };

  if (limitedAutoGrant) {
    return async (a: PreparedAction) => {
      const grant = autoGrant(a);
      const e = a.resolvedEffect;
      if (grant.ok) {
        console.log(`  \x1b[2m(默认档位) 自动批准\x1b[0m ${a.toolName} → ${e.effectType} ${e.scope.value}`);
        return { approved: true };
      }
      finishRendering();
      console.log(`  \x1b[33m默认档位不覆盖这一步\x1b[0m：${grant.why}`);
      return ask(a, "");
    };
  }
  return async (a: PreparedAction) => ask(a, "\n");
}

/** `--list-runs`：只读一张表，不需要模型也不需要凭证。 */
function listRuns(dbPath: string): void {
  // 库还不存在时先把目录建出来 —— 第一次跑就 --list-runs 是个很自然的动作，
  // 而 SQLite 对着一个不存在的目录只会甩一句 "unable to open database file"。
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb({ path: dbPath });
  const store = new SqliteRunStore(db);
  void store.list(50).then((rows) => {
    if (rows.length === 0) {
      console.log(`（库里还没有 Run）\n库：${dbPath}`);
      return;
    }
    console.log(`库：${dbPath}\n`);
    console.log(
      ["RunId".padEnd(22), "状态".padEnd(20), "更新时间".padEnd(20), "任务"].join(" "),
    );
    console.log("─".repeat(100));
    for (const r of rows) {
      console.log(
        [
          String(r.runId).padEnd(22),
          r.status.padEnd(20),
          new Date(r.updatedAt).toLocaleString().padEnd(20),
          r.task.length > 40 ? `${r.task.slice(0, 40)}…` : r.task,
        ].join(" "),
      );
    }
    console.log(
      `\n可恢复的状态：CANCELLED / RECOVERY_REQUIRED / RUNNING（上次崩了）。` +
        `\n  npm run dev -- --resume <RunId>`,
    );
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "list") {
    listRuns(args.dbPath);
    return;
  }

  mkdirSync(args.workspace, { recursive: true });
  console.log(`workspace: ${args.workspace}`);
  console.log(`db       : ${args.dbPath}`);
  /**
   * 【定】把当前的审批档位**打出来**。
   *
   * 决 3 把默认行为从「逐次问」改成了「workspace 内的可逆写自动放行」——
   * 这是一次对用户可见的行为变更，而没打印的行为变更等于没通知。
   */
  console.log(
    `approval : ${
      args.yesAll
        ? "--yes-all，无条件批准一切"
        : args.confirm
          ? "--confirm，每一步都问"
          : "默认：workspace 内的写自动放行；IRREVERSIBLE（追加/删除）与 EXECUTE 仍逐次问；越界写直接拒绝"
    }`,
  );

  // Ctrl+C 的传播源。审批等待也挂在它上面（U-2）。
  const sigint = new AbortController();

  /**
   * S1：运行期插话的入口。
   *
   * 主循环第 ⓪ 步的排空逻辑（`run-loop.ts`）与 `runtime.interject()`
   * （`facade/index.ts`）从阶段 1 就都在，**缺的一直只是调用点** ——
   * 也就是说这条能力写完之后从来没有被任何人触发过。
   * 这与 P1-1（官方入口不能选端点）是同一个形状：装配完成 ≠ 可达。
   */
  let currentRunId = "";
  /**
   * 晚绑定：`compose()` 需要 approvalDecider，而 decider 需要 stdin 通道，
   * 而通道的插话回调需要 runtime —— 三者成环。用一个可变引用打破它，
   * 而不是把通道拆成两半（拆开就又回到「两个 readline 抢一行」）。
   */
  let interjectInto: ((runId: string, text: string) => void) | undefined;
  const stdin = new StdinChannel({
    onInterject: (text) => {
      if (!currentRunId || !interjectInto) {
        console.log(`  \x1b[33m还没有正在跑的 Run，这句话没有去处\x1b[0m：${text}`);
        return;
      }
      interjectInto(currentRunId, text);
      console.log(`  \x1b[36m已排队插话\x1b[0m（下一轮编帧时进入上下文）：${text}`);
    },
  });

  // thunk 只在第一个事件到达时被读，那时下面这两个变量都已赋值。
  let profileRef = "unknown";
  let modelId = "unknown";
  const fileSink = args.trace
    ? new FileTraceSink(
        // N-1：文件名按 runId 定，resume 往同一个文件续写下一段。
        // 显式 --trace 时听用户的，那是「我要这一段单独存一份」的意思。
        (runId) =>
          args.trace === "auto"
            ? resolve(workspaceStorage(args.workspace).traceDir, `${runId}.jsonl`)
            : resolve(args.trace!),
        () => ({
          ...gitProvenance(),
          nodeVersion: process.version,
          endpointProfile: profileRef,
          modelId,
          task: args.task,
          workspaceRoot: args.workspace,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          startedAt: new Date().toISOString(),
        }),
      )
    : undefined;
  const trace: TraceSinkPort = fileSink ?? new NullTraceSink();

  const composed = compose({
    workspaceRoot: args.workspace,
    approvalDecider: interactiveApproval(
      !args.confirm,
      args.yesAll,
      args.workspace,
      sigint.signal,
      stdin,
    ),
    trace,
    dbPath: args.dbPath,
    endpoint: args.endpoint,
    // S10：接管通道是 stdin 三方复用里的第三方（语义在 S1 定死）。
    handoff: terminalHandoff(stdin, sigint.signal),
    question: terminalQuestion(stdin, sigint.signal),
  });
  interjectInto = (runId, text) => composed.runtime.interject(asId<RunId>(runId), text);
  profileRef = `${composed.profile.id}@${composed.profile.observedAt}`;
  modelId = composed.profile.modelId;

  /**
   * S1：把**解析后**的端点如实打出来。
   *
   * 【定】只打 baseUrl 的 host、声明 id 与模型 id，**绝不打印 key**。
   * 打 host 而不是完整 URL 是刻意的：路径里有时带部署标识，而这一行会被
   * 贴进 issue 和评测报告。
   *
   * 为什么必须打：U-6 的教训是「闸门排在另一个闸门后面等于没有闸门」——
   * 而更早一层的问题是**当时根本看不出实际连的是哪个端点**。
   */
  console.log(`endpoint : ${args.endpoint}（${hostOf(composed.endpointBaseUrl)}）`);
  console.log(`profile  : ${composed.profile.id}`);
  console.log(`model    : ${composed.profile.modelId}`);
  if (!stdin.isInteractive) {
    console.log(`stdin    : 非交互环境，插话与审批应答不可用（审批按拒绝处置）`);
  } else {
    console.log(`stdin    : 运行期直接敲一句话回车 = 插话；审批时回车 = 应答`);
  }

  for (const n of composed.notices) console.log(`⚠️  ${n}\n`);

  let runId = args.runId;
  currentRunId = runId;
  let gen: AsyncGenerator<RunEvent, { terminal: unknown; outcome?: unknown }>;

  if (args.mode === "resume") {
    const snapshot = await composed.runtime.inspect(asId<RunId>(runId));
    if (!snapshot) {
      console.error(`\n找不到 Run ${runId}。用 --list-runs 看看库里有什么。`);
      process.exit(1);
    }
    console.log(`resume   : ${runId}（上次状态 ${snapshot.status}，已跑 ${snapshot.turnCount} 轮）\n`);
    gen = composed.runtime.resume(asId<RunId>(runId), {
      ...(args.recoveryDecision ? { recoveryDecision: args.recoveryDecision } : {}),
      ...(args.recoveryNote ? { recoveryNote: args.recoveryNote } : {}),
    }) as typeof gen;
  } else {
    console.log();
    gen = composed.runtime.start(composed.makeRunSpec(args.task)) as typeof gen;
  }

  // Ctrl+C → cancel。单个 AbortController 传播到所有 Port（V05 §9.1）。
  process.on("SIGINT", () => {
    console.log("\n\n收到 Ctrl+C，正在协作式取消……（未启动的工具会合成 SKIPPED result）");
    sigint.abort();
    if (runId) composed.runtime.cancel(asId<RunId>(runId), "SIGINT");
  });

  let r = await gen.next();
  while (!r.done) {
    const e: RunEvent = r.value;
    if (!runId) {
      runId = String(e.runId);
      // 插话要知道往哪个 Run 排队。start() 的 runId 是第一个事件才带出来的。
      currentRunId = runId;
    }
    renderEvent(e);
    r = await gen.next();
  }
  finishRendering();
  // 【定】跑完就交还 stdin，否则进程不会退出（readline 持有 stdin 的引用）。
  stdin.close();

  const { terminal, outcome } = r.value as {
    terminal: { reason: string; recoveryItems?: Array<{ what: string; sideEffectState: string }> };
    outcome?: {
      kind: string;
      summary?: string;
      incompleteItems: Array<{ what: string; why: string }>;
      recoveryItems: Array<{ what: string; sideEffectState: string }>;
    };
  };

  console.log(`\n${"─".repeat(60)}`);
  console.log(`RunId   : ${runId}`);
  console.log(`Terminal: ${terminal.reason}`);
  // outcome 缺席只有一种情况：停在 RECOVERY_REQUIRED 这个非终态上 ——
  // Run 没结束，自然没有结果可结算。
  console.log(`Outcome : ${outcome?.kind ?? "（未结算：Run 停在非终态）"}`);
  // R-7：kind 只说了「算不算成功」，summary 才说了「究竟发生了什么」。
  // 少了这一行，模型明确拒绝任务的那种 Run，用户看到的只有一个 SUCCESS。
  if (outcome?.summary) {
    console.log(`Summary : ${outcome.summary}`);
  }
  if (terminal.reason === "RECOVERY_REQUIRED") {
    console.log("需要人工确认后才能继续：");
    for (const i of terminal.recoveryItems ?? []) console.log(`  - ${i.what}（${i.sideEffectState}）`);
    console.log(
      `\n人工确认外部状态后，带决策继续：\n` +
        `  npm run dev -- --resume ${runId} --recovery-decision CONTINUE --recovery-note "..."\n` +
        `  npm run dev -- --resume ${runId} --recovery-decision ABORT`,
    );
  }
  if (outcome && outcome.incompleteItems.length > 0) {
    console.log("未完成项：");
    for (const i of outcome.incompleteItems) console.log(`  - ${i.what}：${i.why}`);
  }
  if (outcome && outcome.recoveryItems.length > 0) {
    console.log("状态未知项（需人工确认）：");
    for (const i of outcome.recoveryItems) console.log(`  - ${i.what}（${i.sideEffectState}）`);
  }

  const entries = await composed.ports.transcript.readAll(asId<RunId>(runId));
  console.log(`transcript: ${entries.length} 条`);

  /**
   * footer 把「跑完之后的事实」补进 artifact：终止原因、outcome、以及从
   * transcript 的 RUN_META 读回的预算使用。
   *
   * 为什么预算要从 transcript 读而不是从事件流里凑：事件流里的 usage 是逐次的，
   * 累计量的权威副本在 RUN_META 里（A-7 之后就是这样）。凑出来的数和权威副本
   * 万一对不上，事后没人分得清哪个是对的。
   */
  if (fileSink) {
    fileSink.finish({
      terminal,
      outcome: outcome ?? null,
      transcriptEntries: entries.length,
      /**
       * transcript 条目占用的序号（D-2 的可核对形态）。
       *
       * 事件不落 transcript，所以事件流里会有空洞；把 transcript 这一侧的号
       * 也写进 artifact，两条轨道就能只凭这一个文件对齐 ——
       * 空洞应当恰好被这个列表填满，既不重号也不缺号。
       */
      transcriptSequences: entries.map((e) => e.sequence),
      budgetUsage: readLastBudget(entries),
      finishedAt: new Date().toISOString(),
    });
    console.log(`trace     : ${fileSink.filePath}`);
  }

  process.exit(0);
}

/**
 * 终端上的人工接管通道（阶段 3 S10，§20）。
 *
 * 它是 stdin 三方复用里的第三方 —— 语义在 S1 就定死了：
 * `WAITING_FOR_INTERACTION` 状态下的回车 = 接管完成信号。
 *
 * 【定】无 TTY 时返回 undefined，**不得当成「做完了」**。
 * 非交互环境里没有人可以去操作外部世界；假装有人做过，
 * 会让模型在一个它以为已完成、实际没发生的前提上继续往下走 ——
 * 那正是 §20.3「完成信号不等于任务成功」要防的事情的更坏版本。
 */
function terminalHandoff(stdin: StdinChannel, signal: AbortSignal): HandoffChannel {
  return {
    async await(request) {
      finishRendering();
      console.log(`\n${"─".repeat(60)}`);
      console.log(`\x1b[33m需要你接手一步\x1b[0m`);
      console.log(`\n要做什么：\n  ${request.instructions.split("\n").join("\n  ")}`);
      console.log(`\n做完之后应该能看到：\n  ${request.expectedCompletion.split("\n").join("\n  ")}`);
      console.log(
        `\n\x1b[2m（完成后回车继续；也可以先写一句说明再回车。` +
          `系统会重新去核实，不会只凭你说完成就往下走。）\x1b[0m`,
      );
      console.log("─".repeat(60));

      stdin.setMode("WAITING_FOR_INTERACTION");
      try {
        const line = await stdin.askLine("  完成后回车 > ", signal);
        if (line === undefined) {
          console.log(
            stdin.isInteractive
              ? "  \x1b[33m等待被中断\x1b[0m"
              : "  \x1b[33m非交互环境，没有人能接管这一步\x1b[0m",
          );
          return undefined;
        }
        return line.length > 0 ? { note: line } : {};
      } finally {
        stdin.setMode("RUNNING");
      }
    },
  };
}

/**
 * `ask_user` 的终端实现（阶段 3.5）。
 *
 * 【定】与 `terminalHandoff` 共用同一个 `StdinChannel` 与同一个
 * `WAITING_FOR_INTERACTION` 模式 —— **不新建 readline**。
 * 见 stdin-channel.ts 的文件头：各建各的会让同一行被两个消费者抢，
 * 而那类 bug 只在「恰好在等回答时敲了一句插话」时出现，最难复现。
 *
 * ── 【定】没人回答时返回 undefined，由工具处置成 NO_ANSWER ─────────────
 *
 * 这里不打印「失败」字样：没有人可问不是错误，是一个正常的降级路径
 * （阶段 3.5 决 3）。措辞跟着语义走，否则读日志的人会以为出了问题。
 */
function terminalQuestion(stdin: StdinChannel, signal: AbortSignal): QuestionChannel {
  return {
    async ask(request) {
      finishRendering();
      console.log(`\n${"─".repeat(60)}`);
      console.log(`\x1b[36m需要你定一下\x1b[0m`);
      console.log(`\n${request.question.split("\n").join("\n  ")}`);
      console.log();
      request.options.forEach((o, i) => console.log(`  \x1b[1m${i + 1}\x1b[0m) ${o}`));
      console.log(
        `\n\x1b[2m（敲序号回车；也可以直接写别的答案。` +
          `直接回车 = 让它自己定。）\x1b[0m`,
      );
      console.log("─".repeat(60));

      stdin.setMode("WAITING_FOR_INTERACTION");
      try {
        const line = await stdin.askLine(`  选哪个（1-${request.options.length}）> `, signal);
        if (line === undefined || line.length === 0) {
          console.log(
            stdin.isInteractive
              ? "  \x1b[2m没有选择，交给它自己定\x1b[0m"
              : "  \x1b[2m非交互环境，交给它自己定\x1b[0m",
          );
          return undefined;
        }
        /**
         * 序号 → 选项原文。**越界或非数字一律当自由文本**，不报错。
         *
         * 【定】不因为「输入不合法」再问一遍：用户想写一个不在列表里的
         * 答案是完全正当的（选项是模型给的，它未必想全了）。
         * 把自由输入当错误，等于让工具的选项列表变成一道封闭题。
         */
        const n = Number(line);
        const byIndex =
          Number.isInteger(n) && n >= 1 && n <= request.options.length
            ? request.options[n - 1]
            : undefined;
        return byIndex !== undefined
          ? { choice: byIndex }
          : { choice: line, note: "用户没有选列表里的选项，而是自己写了一个答案" };
      } finally {
        stdin.setMode("RUNNING");
      }
    },
  };
}

/**
 * 把**模型产出的文本**变成可以安全打进终端的形式。
 *
 * 【定】判定与字符类都在 `compose.ts` 的 `stripUnsafeDisplayChars()` 里，
 * 终端与浏览器**共用同一份**。阶段 4 收口批提出来的理由是实测：
 * Web 审批面板用 textContent 挡住了 HTML 注入，却原样保留了 Unicode 双向
 * 与零宽字符 —— 一条闸门只覆盖了两个入口中的一个，而没被覆盖的那个
 * 恰好是现在的主入口。
 */
const forTerminal = stripUnsafeDisplayChars;


/**
 * 从 transcript 的最后一条 RUN_META 读回累计预算。
 *
 * 用 readRunFacts() 而不是在这里重新解析 —— 判别键（RUN_FACTS_META_KIND）
 * 是 Runtime 的知识，CLI 复制一份就会在 schema 变化时悄悄读到旧格式。
 */
function readLastBudget(entries: TranscriptEntry[]): unknown {
  return readRunFacts(entries)?.budgetUsage ?? null;
}

main().catch((err) => {
  console.error(`\n启动失败：${(err as Error).message}`);
  process.exit(1);
});
