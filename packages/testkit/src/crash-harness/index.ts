/**
 * 跨进程 / 崩溃注入装置（阶段 2 新增，§24.2 的 fault-injector 一族）。
 *
 * 它只做一件事：**在一个真的子进程里跑一段 Run，并能在指定事件到达时
 * 把那个进程 SIGKILL 掉**。
 *
 * 为什么这件事值得单独一个包：阶段 1 的崩溃是往 transcript 注入形态模拟的，
 * 那验的是「三条分支的处置逻辑对不对」。而阶段 2 的研究问题是
 * 「消息级恢复**够不够用**」—— 够不够用只能由真崩溃回答，因为构造的崩溃
 * 天然只会出现在你想得到的那些位置上。
 */

import { spawnSync } from "node:child_process";

export interface RunSegmentOptions {
  /** worker 脚本路径（tsx 直接跑 TS）。 */
  workerPath: string;
  dbPath: string;
  workspace: string;
  mode: "start" | "resume";
  runId?: string;
  /** 脚本化模型的轮次序列，会 base64 后经 argv 传给子进程。 */
  script: unknown;
  tracePath?: string;
  /** `"ToolAttemptStarted#2"`：第 2 个该类型事件到达时 SIGKILL。 */
  killAt?: string;
  recoveryDecision?: "CONTINUE" | "ABORT";
  /** 脚本化模型从第几轮开始。恢复段必须传，见 ScriptedModelPort 的说明。 */
  scriptOffset?: number;
  /** 关掉执行前指纹（决 6 的旋钮）。同一个工具会因此掉进第三条分支。 */
  disableObservation?: boolean;
  /**
   * 把 `CompositeVerifier` 的路由改成**只路由 `verify`**（阶段 3 §2.4 的判别力旋钮）。
   *
   * 它模拟的是一个具体的、写组合器时极容易犯的错：只想着「验证要按工具名分派」，
   * 忘了 `observePre` / `observePost` 也要。后果不是「少一个观察」，而是
   * **§18.2 分支二的工具全部静默退化成分支三** —— 没有报错，盘上也看不出来。
   *
   * 【定】与 `disableObservation` 不是同一件事：那个关的是 Verifier 内部的
   * 拍摄开关（决 6 的旋钮，测的是「拍不到指纹会怎样」），
   * 这个断的是**组合器到 Verifier 的那条线**（测的是「线没接会不会被发现」）。
   */
  breakVerifierRouting?: boolean;
  /**
   * 脚本化接管通道的形态（阶段 3 S10）：
   *   `"answer"`（默认）立刻应答 / `"hang"` 永不应答 / `"none"` 不注入通道。
   *
   * `"hang"` 是「正在等人时进程被打死」这个崩溃窗口的唯一造法 ——
   * 而那正是 `WAITING_FOR_INTERACTION` 此前作为**未定义崩溃窗口**存在的地方。
   */
  handoffMode?: "answer" | "hang" | "none";
  timeoutMs?: number;
}

export interface SegmentResult {
  /** 子进程是否被自己 kill 掉（对应 killAt 生效）。 */
  killed: boolean;
  runId: string;
  terminal?: string;
  outcome?: string | null;
  turnsConsumed?: number;
  killedAt?: { at: string; sequence: number };
  error?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

/**
 * 同步跑一个子进程段。
 *
 * 用 `spawnSync` 而不是异步：验收脚本是线性叙事，段与段之间本来就必须
 * 严格有序 —— 「进程 A 死了之后进程 B 才开始」是被验的对象本身，
 * 不该由调用方用 await 的写法去保证。
 */
export function runSegment(opts: RunSegmentOptions): SegmentResult {
  const args = [
    opts.workerPath,
    "--db",
    opts.dbPath,
    "--workspace",
    opts.workspace,
    "--mode",
    opts.mode,
    "--script",
    Buffer.from(JSON.stringify(opts.script), "utf8").toString("base64"),
  ];
  if (opts.runId) args.push("--run-id", opts.runId);
  if (opts.tracePath) args.push("--trace", opts.tracePath);
  if (opts.killAt) args.push("--kill-at", opts.killAt);
  if (opts.recoveryDecision) args.push("--recovery-decision", opts.recoveryDecision);
  if (opts.scriptOffset !== undefined) args.push("--script-offset", String(opts.scriptOffset));
  if (opts.disableObservation) args.push("--disable-observation");
  if (opts.breakVerifierRouting) args.push("--break-verifier-routing");
  if (opts.handoffMode) args.push("--handoff-mode", opts.handoffMode);

  const proc = spawnSync("npx", ["tsx", ...args], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
    env: process.env,
  });

  const stdout = proc.stdout ?? "";
  const killedLine = pick(stdout, "@@KILLED@@");
  const resultLine0 = pick(stdout, "@@RESULT@@");

  /**
   * 「被 kill 了」怎么判。
   *
   * 不能只看 `proc.signal === "SIGKILL"` —— 中间隔着 `npx` 与 `tsx` 两层
   * 包装进程，内层被 SIGKILL 之后外层是**正常退出**的，只是把 128+9=137
   * 写进 exit code。第一次跑这条脚本时它就表现成了「kill 没触发」。
   *
   * 权威判据是我们自己打的 `@@KILLED@@` 标记 ＋ 没有 `@@RESULT@@`：
   * 前者说明 kill 路径真的走到了，后者说明进程确实没能跑到收尾。
   */
  const out: SegmentResult = {
    killed: (killedLine !== undefined && resultLine0 === undefined) || proc.signal === "SIGKILL",
    runId: opts.runId ?? "",
    exitCode: proc.status,
    signal: proc.signal,
    stdout,
  };

  if (killedLine) {
    const k = JSON.parse(killedLine) as { runId: string; at: string; sequence: number };
    out.runId = k.runId;
    out.killedAt = { at: k.at, sequence: k.sequence };
  }

  const resultLine = resultLine0;
  if (resultLine) {
    const r = JSON.parse(resultLine) as {
      runId: string;
      terminal: string;
      outcome: string | null;
      turnsConsumed: number;
    };
    out.runId = r.runId;
    out.terminal = r.terminal;
    out.outcome = r.outcome;
    out.turnsConsumed = r.turnsConsumed;
  }

  const errLine = pick(stdout, "@@ERROR@@");
  if (errLine) out.error = (JSON.parse(errLine) as { message: string }).message;
  // 子进程连 @@ERROR@@ 都没来得及打的情况（比如编译期就炸）：把 stderr 带出来，
  // 否则验收脚本只会报一个「拿不到 runId」，查不到根因。
  if (!resultLine && !killedLine && !errLine) {
    out.error = (proc.stderr ?? "").trim().split("\n").slice(-6).join("\n") || "子进程无输出";
  }

  return out;
}

function pick(stdout: string, marker: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (line.startsWith(marker)) return line.slice(marker.length);
  }
  return undefined;
}
