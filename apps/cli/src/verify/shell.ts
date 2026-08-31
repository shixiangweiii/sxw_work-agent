/**
 * verify:shell —— `run_shell` 的验收（阶段 3.5）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 研究问题：**既有的 Effect → Policy → 审批三段式，能不能吸收一个
 * 「本质上不可静态分析」的工具？**
 *
 * 它与其他验收脚本的不同点：这里的判据分成截然不同的两类，
 * 混起来看会得出错误结论 ——
 *
 *   A 段（只读判定）判错的代价是**多问一次**，不是安全洞；
 *   B 段（沙箱）判错的代价是**真的没有边界**。
 *
 * 所以 B 段的每一条都必须是「命令真的跑了、内核真的拒了」的实测，
 * 不能是「我们生成的 profile 字符串里有那一行」——
 * 后者是典型的「夹具让正确值与错误值相等」：profile 拼对了但没生效，
 * 字符串判据照样全绿。
 * ══════════════════════════════════════════════════════════════════════
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  type PreparedAction,
  type RunId,
  NullTraceSink,
  ToolRegistry,
  TRUSTED_PERSONAL,
  evaluatePolicy,
  findUnpairedToolUses,
} from "@workagent/harness-runtime";
import {
  ShellEffectResolver,
  analyzeCommand,
  buildSandboxProfile,
  executeRunShell,
  SANDBOX_EXEC,
  isReadDeniedPath,
  isSandboxAvailable,
  readGuardEntryCount,
  runShellDefinition,
  toSandboxDenyRules,
} from "@workagent/tools-common";
import { compose } from "../compose.js";
import {
  ScriptedModelPort,
  banner,
  fact,
  runVerify,
  section,
  tempWorkspace,
  verdict,
} from "./harness.js";

const resolver = new ShellEffectResolver();

function ctxFor(workspaceRoot: string, signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    workspaceRoot,
    onProgress: () => {},
    timezone: "Asia/Shanghai",
  };
}

/** 走**真实**的 Resolver ＋ Policy，不复述判定逻辑。 */
function policyFor(command: string, allowNetwork = false) {
  const input = { command, allow_network: allowNetwork };
  const effect = resolver.resolve(input as never, "/tmp/ws");
  const action = {
    id: "act_x",
    runId: "run_x",
    batchId: "b_x",
    batchIndex: 0,
    toolCallId: "tc_x",
    toolName: "run_shell",
    rawInput: input,
    stage: "PREPARED",
    createdAt: 0,
    normalizedInput: input,
    inputDigest: "d",
    resolvedEffect: effect,
    actionDigest: "a",
    preparedAt: 0,
  } as unknown as PreparedAction;
  return {
    effect,
    verdict: evaluatePolicy({
      action,
      approvalPolicy: TRUSTED_PERSONAL,
    }).decision,
  };
}

async function main(): Promise<void> {
  banner(
    "验收：run_shell —— 通用 EXECUTE 能力面",
    "两道闸门各自成立吗？静态判定只负责档位、沙箱才是边界，这个分工在实测下站得住吗？",
  );

  if (!isSandboxAvailable()) {
    verdict(false, `本机没有可用的 seatbelt 沙箱（platform=${process.platform}），无法验收`);
    return;
  }

  // ════════════════════════════════════════════════════ A 段：只读判定
  section("A. 只读判定 —— 判错的代价是多问一次，所以失败方向必须固定在保守侧");

  interface Case {
    cmd: string;
    expectReadOnly: boolean;
    /** 改坏哪里会让这条翻红 —— 判别力的自陈。 */
    kills: string;
  }
  const cases: Case[] = [
    { cmd: "ls -la", expectReadOnly: true, kills: "把 ls 从只读白名单删掉" },
    { cmd: "cat notes.txt", expectReadOnly: true, kills: "把 cat 从只读白名单删掉" },
    { cmd: "grep -rn pat .", expectReadOnly: true, kills: "把 grep 从只读白名单删掉" },
    { cmd: "ls && rm -rf /tmp/x", expectReadOnly: false, kills: "从元字符表删掉 &" },
    { cmd: "cat a.txt > /etc/hosts", expectReadOnly: false, kills: "从元字符表删掉 >" },
    { cmd: "cat `echo /etc/passwd`", expectReadOnly: false, kills: "从元字符表删掉反引号" },
    { cmd: "cat $(echo x)", expectReadOnly: false, kills: "从元字符表删掉 $" },
    { cmd: "cat ~/.ssh/id_rsa", expectReadOnly: false, kills: "从元字符表删掉 ~" },
    { cmd: "FOO=bar ls", expectReadOnly: false, kills: "删掉前置环境变量赋值检查" },
    { cmd: "/bin/ls", expectReadOnly: false, kills: "允许带路径的程序名" },
    /**
     * ── 2026-08-30 评审实测漏网的那一批（三份评审各自独立复现）──────────
     *
     * 共同形态：**只看 argv[0] 判不出写操作**。原白名单收了 find / sort /
     * uniq / tree / rg / git，而它们每一个都留着一个不带元字符的写出口。
     * 元字符表挡住 `find -exec` 是**偶然**（要写 `\;` 或 `{}`），
     * 不是设计 —— `rg --pre` 什么特殊字符都不带，是本批里最锋利的一条。
     */
    /**
     * ── 【定】每条 `kills` 必须点名**真正**守住它的那一道 ──────────────────
     *
     * 这一批用例我第一次写的时候把 `kills` 全写成了「把 X 加回白名单」，
     * 而实测（自查的判别力实测）**没翻红** —— 因为 `find . -delete` /
     * `sort -o` / `rg --pre` 都带写出口参数，第二道就把它们挡住了，
     * 放宽白名单根本不影响结论。
     *
     * 一条不准的 `kills` 比没有更糟：它让人以为某处改坏会被抓住，
     * 而真去改的时候不会。所以下面按**真正的守卫**分成两组：
     *
     *   ① 白名单守的：程序整体不该出现，且命令本身不带写出口参数；
     *   ② 写出口守的：程序在白名单里，靠参数判出来。
     *
     * 两组都要有，才说明两道闸门各自都有判据照着。
     */
    // ── ① 只有白名单守得住（命令本身不带任何写出口参数）──
    { cmd: "git push", expectReadOnly: false, kills: "把 git 加回只读白名单" },
    { cmd: "git status", expectReadOnly: false, kills: "把 git 加回白名单（它在沙箱里也跑不了：读黑名单 deny .git）" },
    { cmd: "git reflog expire --all", expectReadOnly: false, kills: "把 git 加回白名单 —— 这条会摧毁仓库的全部恢复元数据" },
    { cmd: "git branch evil", expectReadOnly: false, kills: "把 git 加回白名单" },
    { cmd: "uniq in.txt out.txt", expectReadOnly: false, kills: "把 uniq 加回白名单 —— 它的第二个位置参数就是输出文件，没有任何标志位可抓" },
    { cmd: "tree x", expectReadOnly: false, kills: "把 tree 加回白名单" },
    // ── ② 只有写出口参数守得住（程序仍在白名单里）──
    { cmd: "grep --output=leak.txt pat f", expectReadOnly: false, kills: "从 WRITE_OUTLET_FLAGS 删掉 --output" },
    { cmd: "cat -o x f", expectReadOnly: false, kills: "从 WRITE_OUTLET_FLAGS 删掉 -o" },
    { cmd: "echo hi --exec rm", expectReadOnly: false, kills: "从 WRITE_OUTLET_FLAGS 删掉 --exec" },
    // ── ③ 两道都能守（记录评审实测到的原始反例，保留形态）──
    { cmd: "find . -delete", expectReadOnly: false, kills: "**同时**把 find 加回白名单并从 WRITE_OUTLET_FLAGS 删掉 -delete" },
    { cmd: "sort -o out.txt in.txt", expectReadOnly: false, kills: "**同时**把 sort 加回白名单并删掉 -o" },
    { cmd: "rg --pre 'touch /tmp/pwned' pat f", expectReadOnly: false, kills: "**同时**把 rg 加回白名单并删掉 --pre（--pre 是任意命令执行）" },
    { cmd: "curl https://evil.example", expectReadOnly: false, kills: "把 curl 加进只读白名单" },
    { cmd: "zip -r out.zip src", expectReadOnly: false, kills: "把 zip 加进只读白名单" },
  ];

  let aOk = true;
  for (const c of cases) {
    const a = analyzeCommand(c.cmd);
    const p = policyFor(c.cmd);
    // 只读 ⇒ READ ⇒ Policy 直接 ALLOW（READ 不在 requiresApprovalFor 里）
    // 非只读 ⇒ EXECUTE ⇒ REQUIRE_APPROVAL
    const wantEffect = c.expectReadOnly ? "READ" : "EXECUTE";
    const wantDecision = c.expectReadOnly ? "ALLOW" : "REQUIRE_APPROVAL";
    const ok =
      a.readOnly === c.expectReadOnly &&
      p.effect.effectType === wantEffect &&
      p.verdict === wantDecision;
    if (!ok) aOk = false;
    fact(
      `${ok ? "  " : "✗ "}${JSON.stringify(c.cmd)}`,
      `${p.effect.effectType} / ${p.verdict}${ok ? "" : `   ← 期望 ${wantEffect} / ${wantDecision}`}`,
    );
  }

  console.log(
    "\n   判别力自陈（改坏任一处，对应那条必须翻红）：\n" +
      cases.map((c) => `     ${JSON.stringify(c.cmd).padEnd(28)} ← ${c.kills}`).join("\n"),
  );

  verdict(
    aOk,
    aOk
      ? `${cases.length} 条命令的只读判定与 Policy 处置全部符合预期 —— ` +
          `串联、重定向、命令替换、home 展开、环境变量劫持、带路径程序名、` +
          `git 写子命令、网络程序**逐条**落到 EXECUTE`
      : "存在命令的只读判定或 Policy 处置与预期不符（见上面带 ✗ 的行）",
  );

  /**
   * 【定】这一条单独立判据：它测的不是「某条命令判对了」，
   * 而是**只读那一档真的能自动放行**。
   *
   * 如果 READ 也要审批，A 段全绿也没有意义 —— 决 3「判定为只读的命令
   * 自动放行」就没落地，而没有任何一条上面的判据会因此翻红。
   */
  const readAutoAllowed = policyFor("ls -la").verdict === "ALLOW";
  const execNeedsApproval = policyFor("zip -r a.zip b").verdict === "REQUIRE_APPROVAL";
  verdict(
    readAutoAllowed && execNeedsApproval,
    readAutoAllowed && execNeedsApproval
      ? "决 3 落地：READ 走 ALLOW（不惊动人），EXECUTE 走 REQUIRE_APPROVAL —— 且这是既有 Policy 的原生行为，policy.ts 一行没改"
      : `决 3 未落地：READ→${policyFor("ls -la").verdict}，EXECUTE→${policyFor("zip -r a.zip b").verdict}`,
  );

  // ── allow_network 必须把只读命令拉回 EXECUTE ──
  const netRead = policyFor("ls -la", true);
  verdict(
    netRead.effect.effectType === "EXECUTE" &&
      netRead.effect.riskFacts.includes("DATA_LEAVES_HOST") &&
      netRead.effect.dataMovement !== undefined,
    netRead.effect.effectType === "EXECUTE"
      ? "allow_network=true 把一条只读命令拉回 EXECUTE，并留下 DATA_LEAVES_HOST ＋ dataMovement —— 外发在 Trace 上可审计（护栏 3 同口径）"
      : `allow_network=true 时仍判 ${netRead.effect.effectType}：联网命令会被自动放行`,
  );

  // ── digest 必须区分「同程序、不同参数」──
  const d1 = resolver.resolve({ command: "git log" } as never, "/tmp/ws").digest;
  const d2 = resolver.resolve({ command: "git log --all --graph" } as never, "/tmp/ws").digest;
  fact("git log 的 digest", d1);
  fact("git log --all 的 digest", d2);
  verdict(
    d1 !== d2,
    d1 !== d2
      ? "两条程序名集合相同、参数不同的命令 digest 不同 —— " +
        "digest 参与 actionDigest 构造并喂给 Progress Guard 的打转检测；" +
        "相同会让「模型换着参数试」被误判成原地打转，而真的打转反而混在里面看不出来"
      : "两条不同命令的 digest 相同：Progress Guard 分不出「换参数重试」与「原地打转」",
  );

  /**
   * ── effect 的 scope.value 不得把命令内容抄进去 ────────────────────────
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】判据是「不出现 `://`」，测的是一条**已经发生过**的泄漏路径。
   *
   * 实测（Run `run_75f0d6afafa6`，真实端点）：一条下载 11 张图的命令，
   * `extractPrograms` 把 **11 个完整 CDN URL** 当成程序名，原样进了
   * `scope.value` → `ActionProposed` / `ApprovalRequested` → JSONL。
   *
   * 而同一个 resolver 的 `dataMovement` 处有一条【定】写着「只记去向类别，
   * 不记命令原文 —— 抄进 Trace 等于让审计记录自己变成第二个泄漏点」。
   * **同一个文件里两条规则打架**，URL 从另一个口子全进去了。
   *
   * 今天泄的是公开 URL，代价只是审批串没法看；等 URL 带上签名或 token，
   * 代价变成凭证被持久化 —— 而那时不会有任何征兆，因为这条路径「一直是这样的」。
   * ══════════════════════════════════════════════════════════════════════
   */
  /**
   * ── 【定】用例必须**逐道过滤各一条**，这是注入实测逼出来的 ──────────────
   *
   * ══════════════════════════════════════════════════════════════════════
   * 这条判据我写错过**两次**，两次都是注入实测当场拆掉的，值得原样记下来。
   *
   * 第一版：只写了真实运行里那条命令的形态（带引号的 URL 独占一行）。
   *   摘掉 `://` 过滤 → **不红**；摘掉引号抹除 → **也不红**。
   *   两道过滤对那一个形态互相遮蔽，任一道单独就够，于是判据对**两道**都无感知。
   *
   * 第二版：加了「裸 URL 数组」，以为能隔离 `://` 过滤。仍然不红 ——
   *   那条 URL 里带 `?sig=`，而 `extractPrograms` 早就有一句
   *   「跳过前置环境变量赋值」（`t.includes("=")`），它先把整个 token 吃掉了。
   *   **判据实际被一条与本次修复无关的老逻辑挡绿了。**
   *
   * 共同形态还是那一条：判据测的不是它声称在测的东西。
   * 而这次两次都不是因为断言写错，是因为**用例落在了守卫的重叠区**。
   *
   * 下面两条是实测出来的、各自只被一道过滤挡住的形态：
   *   裸 URL 且**不含 `=`**        → 只有 `://` 过滤能挡（老的 `=` 跳过够不着）
   *   引号内含 `;` 与 `()`          → 只有引号抹除能挡（内容里没有 `://`）
   * 真实运行里那条（引号 URL 独占行）两道都挡得住，所以它**不适合做判据**。
   * ══════════════════════════════════════════════════════════════════════
   */
  const bareUrlLeak =
    "urls=(\nhttps://cdn.example.com/a-SECRET456.jpg\n)\ncurl -s -o out.jpg";
  const quotedLeak = 'curl -s -H "User-Agent: Mozilla (X; SECRET123)" -o out.jpg';
  const scopeOf = (c: string): string =>
    resolver.resolve({ command: c, allow_network: true } as never, "/tmp/ws").scope.value;
  const bareScope = scopeOf(bareUrlLeak);
  const quotedScope = scopeOf(quotedLeak);
  fact("裸 URL（无 =，只有 :// 过滤挡得住）→ scope.value", bareScope);
  fact("引号内含 ; 与 ()（只有引号抹除挡得住）→ scope.value", quotedScope);
  const clean = (s: string): boolean => !s.includes("://") && !/SECRET\d/.test(s);
  const noLeak = clean(bareScope) && clean(quotedScope);
  // 顺带钉住「不是靠把它清空来通过的」—— 真程序名必须还在，否则审批串没了意义。
  const stillUseful = bareScope.includes("curl") && quotedScope.includes("curl");
  verdict(
    noLeak && stillUseful,
    noLeak && stillUseful
      ? "两种形态的 scope.value 里都没有 URL、也没有引号内的内容，而真程序名（curl）都还在 —— " +
          "两条用例**各自只被一道过滤挡住**（实测确认过），单写一条时两道会互相遮蔽；" +
          "「真程序名仍在」那一半同样不能省：一个恒空的 scope.value 也能通过前半条"
      : !noLeak
        ? `scope.value 抄进了命令内容：裸 URL 形态=${bareScope}｜引号形态=${quotedScope}`
        : `scope.value 把真程序名也一起丢了（${bareScope}｜${quotedScope}）—— 审批与审计那一行会变成空壳`,
  );

  // ══════════════════════════════════════════════════ B 段：沙箱是真的
  section("B. 沙箱 —— 这一段的每条都必须是「真的跑了、内核真的拒了」");

  const ws = tempWorkspace();
  const ctx = ctxFor(ws.root);

  // B1 workspace 内可写
  const inside = await executeRunShell(
    { command: "echo hello > inside.txt && cat inside.txt" },
    ctx,
  );
  const insideBody = inside.ok ? JSON.parse(inside.output) : {};
  const insideOk =
    inside.ok && insideBody.exitCode === 0 && String(insideBody.stdout).includes("hello");
  fact("workspace 内写 + 读回", `exit=${insideBody.exitCode} stdout=${JSON.stringify(insideBody.stdout)}`);

  /**
   * B2 越界写必须失败，且文件真的不存在。
   *
   * ── 【定】目标名必须每次唯一，且事前断言它不存在 ──────────────────────
   *
   * 实测踩到的（就在本批的判别力实测里）：故障注入把 `deny file-write*`
   * 去掉跑了一次，那次**真的在 $HOME 建出了这个文件**。文件名写死的话，
   * 它会永久留在盘上 —— 之后每一次 `existsSync` 都为真，
   * 这条判据从此**永远红**，而沙箱其实是好的。
   *
   * 反过来更危险：如果判据写的是「文件存在 ⇒ 通过」那一侧，
   * 一个残留文件会让它**永远绿**。仪器留下的持久痕迹会污染后续所有测量，
   * 这与「夹具让正确值与错误值相等」是同一类问题，只是跨了运行。
   */
  const outsideTarget = resolve(homedir(), `wa-verify-SHOULD-NOT-EXIST-${process.pid}-${Date.now()}`);
  if (existsSync(outsideTarget)) {
    verdict(false, `探针目标 ${outsideTarget} 事前就存在，这次测量无效`);
    // 【定】早退也要清 workspace —— 这条 return 原来漏了 cleanup，
    // 而本段的全部主题就是「仪器不得留痕」（2026-08-30 评审）。
    ws.cleanup();
    return;
  }
  const outside = await executeRunShell({ command: `touch ${outsideTarget}` }, ctx);
  const outsideBody = outside.ok ? JSON.parse(outside.output) : {};
  const outsideBlocked = outsideBody.exitCode !== 0 && !existsSync(outsideTarget);
  fact("越界写 exitCode", outsideBody.exitCode);
  fact("越界写 stderr", String(outsideBody.stderr ?? "").trim().slice(0, 80));
  fact("目标文件是否存在", existsSync(outsideTarget) ? "存在 ← 沙箱没拦住" : "不存在");
  verdict(
    insideOk && outsideBlocked,
    insideOk && outsideBlocked
      ? `沙箱的写边界成立：workspace 内成功、$HOME 下被内核拒绝且文件未生成 —— ` +
          `判别力在于**同时**验两侧，只验越界会与「沙箱把一切都拒了」不可区分`
      : `写边界不成立：workspace 内 ok=${insideOk}，越界被拦=${outsideBlocked}`,
  );
  // 【定】万一真的建出来了（沙箱失效或故障注入），当场清掉。
  // 仪器不能在被测系统之外留下痕迹 —— 见上面 outsideTarget 那段。
  rmSync(outsideTarget, { force: true });

  // B3 读黑名单：真的读不到凭证
  writeFileSync(resolve(ws.root, ".env.local"), "SECRET=abc\n", "utf8");
  const readEnv = await executeRunShell({ command: "cat .env.local" }, ctx);
  const readEnvBody = readEnv.ok ? JSON.parse(readEnv.output) : {};
  const envBlocked =
    readEnvBody.exitCode !== 0 && !String(readEnvBody.stdout ?? "").includes("SECRET");
  fact(".env.local 读取", `exit=${readEnvBody.exitCode} stdout=${JSON.stringify(readEnvBody.stdout)}`);
  verdict(
    envBlocked,
    envBlocked
      ? "沙箱内读不到 .env.local —— 决 3 护栏 1 的第三个落点补上了（read_file / search 之外，run_shell 会从旁边绕过去）"
      : "沙箱内读到了 .env.local：run_shell 是读黑名单的一个缺口",
  );

  /**
   * B4 读黑名单：**条数相等 ＋ 双侧语义对拍**。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】条数相等**不够**（2026-08-30 评审 F4，内核级对拍抓到的）。
   *
   * 条数只能证明「每张表的每一项都生成了一条规则」，证明不了那条规则
   * 与 `read-guard.ts` 判的是同一件事。评审实测到**双向**分叉：
   *
   *   `.environment.md`  read-guard 放行 / 沙箱拒绝  ← 沙箱更严（误伤）
   *   `.git`（作为文件）  read-guard 拒绝 / 沙箱放行  ← **沙箱更松**
   *
   * 后者出现在安全边界那一侧，而「条数相等」对两个方向都无感知。
   * 更要命的是：沙箱那条 `/\.env` 正是 `read-guard.ts` 里被【定】
   * **明确否决**过的 `startsWith(".env")` 形态（原文理由：「误伤会让人
   * 去绕过护栏」）——「唯一事实源」的声明在两个实现里各说各话。
   *
   * 所以判据改成：对一组抽样路径，两侧**必须给出同一个结论**。
   * ══════════════════════════════════════════════════════════════════════
   */
  const rules = toSandboxDenyRules();
  const entries = readGuardEntryCount();
  fact("读黑名单条目数", entries);
  fact("生成的 sbpl deny 规则数", rules.length);

  const probeDir = resolve(ws.root, "guard-probe");
  const parity: Array<{ path: string; js: boolean; kernel: boolean }> = [];
  {
    /**
     * 【定】`.git` 的两种形态要分在**不同子目录**下造。
     *
     * 同一个目录里没法同时有「文件 .git」和「目录 .git」——
     * 第一次跑就撞了 EEXIST。而两种形态都必须验：
     * 终段的 `.git` 文件正是评审抓到「沙箱更松」的那一条。
     */
    const rel = [
      "a/.ssh/id_rsa",      // 段匹配，中间段
      "b/.git",             // 段匹配，**终段**（worktree 里 .git 是文件）
      "c/.git/config",      // 段匹配，中间段
      "d/.env",             // 前缀，精确
      "d/.env.local",       // 前缀 + 后缀
      "d/.environment.md",  // 前缀的**误伤反例** —— read-guard 明确要放行
      "e/id_rsa",           // basename 精确
      "e/normal.txt",       // 普通文件，两侧都该放行
    ];
    for (const r of rel) {
      const abs = resolve(probeDir, r);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "probe\n", "utf8");
    }
    const profile = buildSandboxProfile({
      workspaceRoot: ws.root,
      tmpDir: ws.root,
      allowNetwork: false,
    });
    for (const r of rel) {
      const abs = resolve(probeDir, r);
      // JS 侧：read_file / search 走的那条判定
      const js = isReadDeniedPath(abs);
      // 内核侧：沙箱真的拒不拒
      let kernel = false;
      try {
        execFileSync(SANDBOX_EXEC, ["-p", profile, "/bin/cat", abs], { stdio: "ignore" });
      } catch {
        kernel = true;
      }
      parity.push({ path: r, js, kernel });
    }
  }
  for (const p of parity) {
    const same = p.js === p.kernel;
    fact(
      `${same ? "  " : "✗ "}${p.path}`,
      `read-guard=${p.js ? "拒" : "放"}  沙箱=${p.kernel ? "拒" : "放"}${same ? "" : "   ← 语义分叉"}`,
    );
  }
  const parityOk = parity.every((p) => p.js === p.kernel);
  verdict(
    rules.length === entries && parityOk,
    rules.length === entries && parityOk
      ? `读黑名单只有一份语义：${entries} 条表项 → ${rules.length} 条 sbpl 规则，` +
        `且 ${parity.length} 条抽样路径上 read-guard 与**内核**给出同一结论 —— ` +
        `包含两个曾经分叉的形态：终段的 .git（沙箱曾更松）与 .environment.md（沙箱曾误伤）`
      : rules.length !== entries
        ? `条目数 ${entries} 与规则数 ${rules.length} 不等：读黑名单在沙箱里有遗漏`
        : `语义分叉：${parity.filter((p) => p.js !== p.kernel).map((p) => p.path).join("、")}`,
  );

  // B5 默认禁网
  const noNet = await executeRunShell(
    { command: "curl -sS -m 5 -o /dev/null https://pi.dev/", timeout_ms: 20_000 },
    ctx,
  );
  const noNetBody = noNet.ok ? JSON.parse(noNet.output) : {};
  /**
   * 【定】必须先证明这台机器**本来能上网**（2026-08-30 评审 F5）。
   *
   * 只断言「沙箱内 curl 失败」的话，在一台离线机器 / CI 上它会**空洞变绿** ——
   * 沙箱拦住了和根本没网，在那条断言下不可区分。这正是本仓自己反复讲的
   * 「夹具让正确值与错误值相等」。
   */
  let reachable = false;
  try {
    execFileSync("curl", ["-sS", "-m", "8", "-o", "/dev/null", "https://pi.dev/"], { stdio: "ignore" });
    reachable = true;
  } catch {
    reachable = false;
  }
  fact("沙箱外可达性预探测", reachable ? "可达（本条判据有效）" : "不可达 ← 本条无判别力");
  fact("默认档位下 curl", `exit=${noNetBody.exitCode}`);
  verdict(
    reachable && noNetBody.exitCode !== 0,
    !reachable
      ? "本机当前上不了网，「沙箱禁网」这条**测不出来**（拦住了与没网不可区分）—— 判为红，不给假绿"
      : noNetBody.exitCode !== 0
        ? "默认禁网成立：沙箱外同一目标可达、沙箱内 curl 连不出去 —— 两侧对照过，不是空洞变绿"
        : "默认档位下 curl 成功了：allow_network 这个开关没有生效",
  );

  // B6 profile 里带引号的路径必须抛，不能静默截断成更宽的授权
  let quoteRejected = false;
  try {
    buildSandboxProfile({ workspaceRoot: '/tmp/a"b', tmpDir: "/tmp/t", allowNetwork: false });
  } catch {
    quoteRejected = true;
  }
  verdict(
    quoteRejected,
    quoteRejected
      ? '含引号的 workspace 路径被拒绝而不是静默转义 —— 猜错一次转义会把 subpath 截短成更宽的授权范围'
      : "含引号的路径被静默接受：sandbox profile 可能被截断成更宽的授权范围",
  );

  /**
   * B7 临时目录：**description ① 承诺的那一条，双侧实测**。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 【定】这条判据是为一个真实端点上撞出来的缺陷加的（Run `run_75f0d6afafa6`）。
   *
   * description ① 曾经写着「只能写 workspace 目录和**系统临时目录**」，
   * 而 R-8 把 tmp 收窄成了 per-call `mkdtemp` ＋ `TMPDIR` 指过去。模型照着
   * 那句话写 `/tmp/xxx`，沙箱拒了，`curl -s` 把错误吞掉，模型只看到
   * 「文件不存在」—— 白花一轮。**没有任何判据会说话**：B1 验的是 workspace
   * 内可写、B2 验的是 $HOME 下不可写，`/tmp` 这一档两边都不覆盖。
   *
   * 所以这里必须是**双侧**，理由与 sandbox.ts 文件头那条一模一样：
   *   只验 `/tmp` 被拒 → 与「沙箱把临时目录整个拒了」不可区分（能力其实没了）；
   *   只验 `$TMPDIR` 可写 → 与「沙箱根本没收窄」不可区分（承诺其实是真的）。
   * 两条都在，才能把「收窄了，且收窄的边界与文案一致」这件事钉住。
   * ══════════════════════════════════════════════════════════════════════
   */
  const tmpProbeName = `wa-verify-SHOULD-NOT-EXIST-${process.pid}-${Date.now()}`;
  const tmpProbeAbs = `/tmp/${tmpProbeName}`;
  if (existsSync(tmpProbeAbs)) {
    verdict(false, `探针目标 ${tmpProbeAbs} 事前就存在，这次测量无效`);
    ws.cleanup();
    return;
  }
  // 左侧：$TMPDIR 必须真的写得进（它是 description 给模型的唯一临时目录出口）
  const tmpdirWrite = await executeRunShell(
    { command: 'echo tmpok > "$TMPDIR/probe.txt" && cat "$TMPDIR/probe.txt"' },
    ctx,
  );
  const tmpdirBody = tmpdirWrite.ok ? JSON.parse(tmpdirWrite.output) : {};
  const tmpdirOk =
    tmpdirWrite.ok && tmpdirBody.exitCode === 0 && String(tmpdirBody.stdout).includes("tmpok");
  // 右侧：/tmp 必须写不进，且文件真的没生成
  const slashTmpWrite = await executeRunShell({ command: `touch ${tmpProbeAbs}` }, ctx);
  const slashTmpBody = slashTmpWrite.ok ? JSON.parse(slashTmpWrite.output) : {};
  const slashTmpBlocked = slashTmpBody.exitCode !== 0 && !existsSync(tmpProbeAbs);
  fact("$TMPDIR 写 + 读回", `exit=${tmpdirBody.exitCode} stdout=${JSON.stringify(tmpdirBody.stdout)}`);
  fact("/tmp 写", `exit=${slashTmpBody.exitCode} 文件存在=${existsSync(tmpProbeAbs) ? "是 ← 没拦住" : "否"}`);
  verdict(
    tmpdirOk && slashTmpBlocked,
    tmpdirOk && slashTmpBlocked
      ? "临时目录的边界与 description ① 一致：$TMPDIR 写得进、/tmp 写不进 —— " +
          "两侧都验了，单侧与「整个拒掉」或「根本没收窄」不可区分"
      : `临时目录边界与文案不一致：$TMPDIR 可写=${tmpdirOk}，/tmp 被拦=${slashTmpBlocked}`,
  );
  // 仪器不得在被测系统之外留痕（见 B2）——万一真建出来了，当场清掉。
  rmSync(tmpProbeAbs, { force: true });

  /**
   * B8 description 必须点名 `$TMPDIR`。
   *
   * 【定】这不是「description 里必须出现某个词」那类装饰判据（摸底考试 B 组
   * 明确拒绝过的那种）。区别在于它钉的**不是引导措辞，是一个事实**：
   * per-call 临时目录的路径**只**经由 `$TMPDIR` 暴露，模型没有第二种办法
   * 知道它在哪。这个词从 description 里消失，`run_shell` 的临时目录能力
   * 对模型就等于不存在，而沙箱那一侧不会有任何提示。
   */
  const mentionsTmpdir = runShellDefinition.description.includes("$TMPDIR");
  verdict(
    mentionsTmpdir,
    mentionsTmpdir
      ? "description 点名了 $TMPDIR —— 那是 per-call 临时目录**唯一**的对外出口，不写出来等于这个能力不存在"
      : "description 没提 $TMPDIR：模型无从知道可写的临时目录在哪，只会去试 /tmp 并静默失败",
  );

  // ══════════════════════════════════════════════════ C 段：执行语义
  section("C. 执行语义 —— 工具故障与「世界就是这样」必须分得开");

  // C1 grep 无命中 exit 1 不算错误
  const grepMiss = await executeRunShell({ command: "grep zzzznotfound inside.txt" }, ctx);
  const grepBody = grepMiss.ok ? JSON.parse(grepMiss.output) : {};
  const grepOk = grepMiss.ok && grepBody.exitCode === 1 && typeof grepBody.note === "string";
  fact("grep 无命中", `ok=${grepMiss.ok} exit=${grepBody.exitCode} note=${grepBody.note ?? "(无)"}`);
  verdict(
    grepOk,
    grepOk
      ? "grep 退出 1 被如实上报为「没有匹配（不是错误）」而不是工具故障 —— 没有这张表，模型会原样重试同一条命令"
      : `grep 无命中的处置不对：ok=${grepMiss.ok} exit=${grepBody.exitCode} note=${grepBody.note}`,
  );

  // C2 非零退出码不报 ok:false
  const failCmd = await executeRunShell({ command: "cat definitely-missing-file.txt" }, ctx);
  const failBody = failCmd.ok ? JSON.parse(failCmd.output) : {};
  verdict(
    failCmd.ok && failBody.exitCode !== 0 && String(failBody.stderr).length > 0,
    failCmd.ok
      ? "命令失败（非零退出码）仍按成功取回的事实上报，stderr 原样给模型 —— 与 fetch_url 把 404 当事实同口径"
      : "非零退出码被报成了工具故障：模型会以为是自己的调用出了问题",
  );

  // C3 超时：进程组被杀，没有孤儿
  /**
   * 【定】marker 必须进**被杀的那条命令行**，pgrep 才认得出是不是我们的孤儿。
   *
   * 原来 pgrep 找的是 `"sleep 30"` —— 机器上任何一个命令行含这个串的
   * 无关进程都会让这条判据假红（评审指出的环境性风险）。
   */
  const marker = `wa-orphan-${process.pid}-${Date.now()}`;
  const t0 = Date.now();
  const timedOut = await executeRunShell(
    { command: `bash -c 'sleep 30 # ${marker}' & sleep 30 # ${marker}`, timeout_ms: 2_000 },
    ctx,
  );
  const elapsed = Date.now() - t0;
  // 给内核一点时间收尸
  await new Promise((r) => setTimeout(r, 300));
  let orphans = "";
  try {
    orphans = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim();
  } catch {
    orphans = "";
  }
  fact("超时耗时", `${elapsed}ms（上限 2000）`);
  fact("工具结果", `ok=${timedOut.ok} code=${timedOut.error?.code ?? "-"}`);
  fact("sideEffectState", timedOut.error?.sideEffectState ?? "-");
  fact("残留 sleep 进程", orphans === "" ? "无" : orphans.split("\n").length + " 个 ← 进程组没杀干净");
  const timeoutOk =
    !timedOut.ok &&
    timedOut.error?.code === "TOOL_SHELL_TIMEOUT" &&
    // 【定】必须是 UNKNOWN。命令跑了一半被 SIGKILL，报 NO_EFFECT 是撒谎，
    // 而这个字段正是 recoveryItems 与 §18.2 的依据。
    timedOut.error?.sideEffectState === "UNKNOWN" &&
    elapsed < 10_000 &&
    orphans === "";
  verdict(
    timeoutOk,
    timeoutOk
      ? "超时把**整个进程组**杀掉（无孤儿 sleep 残留），且 sideEffectState 报 UNKNOWN 而不是 NO_EFFECT —— " +
          "只杀直接子进程的话，Run 结算完了编译器还在后台写文件"
      : `超时处置不成立：ok=${timedOut.ok} code=${timedOut.error?.code} ` +
          `sideEffect=${timedOut.error?.sideEffectState} 耗时=${elapsed}ms 孤儿=${orphans === "" ? 0 : "有"}`,
  );

  // C4 取消
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 800);
  const cancelled = await executeRunShell(
    { command: "sleep 20", timeout_ms: 60_000 },
    ctxFor(ws.root, ac.signal),
  );
  verdict(
    !cancelled.ok && cancelled.error?.code === "TOOL_SHELL_CANCELLED",
    !cancelled.ok && cancelled.error?.code === "TOOL_SHELL_CANCELLED"
      ? "ctx.signal 取消能真的打断在途命令（cooperative: true 是兑现了的声明）"
      : `取消未生效：ok=${cancelled.ok} code=${cancelled.error?.code}`,
  );

  // C5 超长输出：截断且如实上报
  const big = await executeRunShell(
    { command: "for i in $(seq 1 20000); do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done" },
    ctx,
  );
  const bigBody = big.ok ? JSON.parse(big.output) : {};
  fact("stdout 长度", String(bigBody.stdout ?? "").length);
  fact("truncated 标记", bigBody.truncated);
  verdict(
    bigBody.truncated === true && typeof bigBody.truncatedNote === "string",
    bigBody.truncated === true
      ? "超长输出被截断，且 truncated ＋ truncatedNote 如实告知 —— 静默截断会让模型拿半截输出当完整结果，而它看不出来"
      : "超长输出没有被如实标记为截断",
  );

  // C6 心跳声明必须有实现（与 verify:tools B 段同一条纪律，这里就地再钉一次）
  const src = readFileSync(
    resolve(import.meta.dirname, "../../../../tools/common/src/exec/run-shell.ts"),
    "utf8",
  );
  const hasHeartbeat = /setInterval\(/.test(src) && /ctx\.onProgress\(/.test(src);
  verdict(
    runShellDefinition.progressReporting.mode === "HEARTBEAT" && hasHeartbeat,
    hasHeartbeat
      ? "声明了 HEARTBEAT 且源码里真有周期性 ctx.onProgress —— read_file / search 曾经声明了却一次都不报"
      : "声明了 HEARTBEAT 但源码里没有周期性回报：又一条死声明",
  );

  ws.cleanup();

  // ══════════════════════════════════════════════ D 段：§18.2 恢复分支
  section("D. 恢复分支 —— run_shell 是第一个天然落分支三的场景工具");

  const dWs = tempWorkspace();
  let branch = "(未观测到)";
  let modelCallsAfterResume = 0;
  try {
    const composed = compose({
      dbPath: ":memory:",
      workspaceRoot: dWs.root,
      approvalDecider: async () => ({ approved: true }),
      trace: new NullTraceSink(),
      // 【定】恢复后模型**不应该被调用到** —— 分支三必须先把 Run 停住。
      modelPortOverride: new ScriptedModelPort([{ text: "了解", toolCalls: [] }]),
    });

    const spec = composed.makeRunSpec("被中断的 shell 任务");
    const gen = composed.runtime.start(spec);
    let runId = "";
    let r = await gen.next();
    while (!r.done) {
      if (!runId) {
        runId = String(r.value.runId);
        composed.runtime.cancel(runId as RunId, "模拟进程硬崩");
      }
      r = await gen.next();
    }

    // 注入一个未配对的 run_shell tool_use —— 硬崩在 transcript 上留下的形态。
    await composed.ports.transcript.append({
      runId: runId as RunId,
      kind: "MESSAGE",
      message: {
        role: "assistant",
        turn: 3,
        content: [
          {
            type: "tool_call",
            toolCallId: "tc_shell_crash",
            name: "run_shell",
            input: { command: "zip -r out.zip src" },
          },
        ],
      },
      createdAt: Date.now(),
    });

    const before = await composed.ports.transcript.rebuildMessages(runId as RunId);
    if (findUnpairedToolUses(before).length !== 1) {
      throw new Error("注入失败：期望恰好 1 个未配对 tool_use");
    }

    const gen2 = composed.runtime.resume(runId as RunId);
    let r2 = await gen2.next();
    while (!r2.done) {
      const e = r2.value;
      if (e.type === "ResumeUnpairedToolUse") branch = e.payload.branch;
      if (e.type === "ModelInvocationCompleted") modelCallsAfterResume += 1;
      r2 = await gen2.next();
    }
  } finally {
    dWs.cleanup();
  }

  fact("run_shell 的恢复分支", branch);
  fact("停住后又调了几次模型", modelCallsAfterResume);
  fact("依据 idempotency", JSON.stringify(runShellDefinition.idempotency));
  fact("依据 recoveryObservation", JSON.stringify(runShellDefinition.recoveryObservation));
  verdict(
    branch === "RECOVERY_REQUIRED" && modelCallsAfterResume === 0,
    branch === "RECOVERY_REQUIRED" && modelCallsAfterResume === 0
      ? "崩在 run_shell 中途 → 落 §18.2 分支三 RECOVERY_REQUIRED，且停住之后不再调模型 —— " +
          "这是诚实结果：半个 zip 与没有 zip 在磁盘上都可能像成功。" +
          "它同时给分支三补上了第一个**场景工具**载体（此前只有测量工具 append_log）"
      : `分支落在 ${branch}（期望 RECOVERY_REQUIRED），恢复后模型调用 ${modelCallsAfterResume} 次（期望 0）`,
  );

  // ══════════════════════════════════════════════ E 段：装配与边界
  section("E. 装配 —— 未接线的闸门比没有闸门更糟");

  /**
   * E1 RESOLVER 查不到注册项必须抛，不得回退 noEffect。
   *
   * 【定】这里原本还有一段「compose 一个会抛的 effects override 然后
   * `void bare` 丢掉」的代码 —— **它不产生任何断言**，是纯噪音
   * （2026-08-30 评审指出）。删掉。一个看起来在测什么、实际什么都不测的
   * 代码块，比没有它更糟：读的人会以为这条路径被覆盖了。
   */
  let threw = false;
  let fellBackToNone = false;
  try {
    // 直接问一次没有注册表的 resolver
    const { DeclarativeEffectResolver } = await import("@workagent/harness-runtime");
    const empty = new DeclarativeEffectResolver();
    const e = empty.resolve(
      { kind: "RESOLVER", resolverRef: { id: "shell-command", version: "1.0.0" } },
      { command: "rm -rf /" } as never,
      "/tmp/ws",
    );
    fellBackToNone = e.effectType === "NONE";
  } catch {
    threw = true;
  }
  fact("空注册表下 resolve", threw ? "抛错" : fellBackToNone ? "回退成 NONE ← 危险" : "返回了别的东西");
  verdict(
    threw,
    threw
      ? "未注册的受信任 Resolver 会**抛错**而不是回退成「无副作用」—— " +
          "回退的后果是 effectType=NONE 让 Policy 的 mutates 判定为假，`rm -rf /` 会一路畅通，而 Trace 上写着无副作用"
      : "空注册表下没有抛错：一个漏装配的工具会绕过 Policy",
  );

  // E2 工具真的进了默认工具面，且起步价口径同步
  const composed = compose({
    dbPath: ":memory:",
    workspaceRoot: "/tmp",
    approvalDecider: async () => ({ approved: true }),
    trace: new NullTraceSink(),
    modelPortOverride: new ScriptedModelPort([{ toolCalls: [] }]),
  });
  // 【定】读**冻结进 RunSpec 的那一份**工具清单，不是 import DEFAULT_TOOLS。
  // 后者证明的是「数组里有这一项」，而这里要证明的是「装配之后模型真的看得见它」。
  const spec = composed.makeRunSpec("装配自检");
  const names = spec.agentSpec.toolSnapshots.map((t) => t.definition.name);
  /**
   * ── 【定】不写死工具数，**而且要调真实的** `fixedOverheadTokens()` ────────
   *
   * 这一条我连着犯过两次，值得都记下来：
   *
   * 第一次：写成 `names.length === 13 && overhead === 2340`。同一批后面加了
   * `ask_user`，它立刻假红 —— 而装配完全正常。写死的期望值不会随被测对象
   * 增长，它只会在下一次**正当的增长**时假红。
   *
   * 第二次（2026-08-30 评审 F2 抓到）：改成了
   * `const overhead = names.length * 180; ... overhead === names.length * 180`
   * —— **恒真式**。没有任何代码改动能让它翻红。而这个「修复」还被当成教训
   * 记进了实施记录 §十一。**一个不可能失败的绿勾是装饰，不是判据**，
   * 而记在教训里的装饰会被抄到第二处去。
   *
   * 现在断言的是两个**独立来源**：Runtime 侧 `ToolRegistry` 真算出来的读数，
   * 与本地按 §16.1 系数算的期望值。改 `fixedOverheadTokens()` 的实现会翻红。
   *
   * 基线读数本身的家在 `verify:tools` G 段（那段明写「只打印读数、不设阈值」），
   * 这里不重复它，只验一致性。
   */
  const declared = new ToolRegistry(spec.agentSpec.toolSnapshots).fixedOverheadTokens();
  const arithmeticOk = declared === names.length * 180;
  fact("默认装配工具数", names.length);
  fact("固定开销起步价", `${declared} token（ToolRegistry 实调）`);
  fact("按 180/工具的期望值", names.length * 180);
  fact("工具清单", names.join(" "));
  verdict(
    names.includes("run_shell") && arithmeticOk,
    names.includes("run_shell") && arithmeticOk
      ? `run_shell 在默认工具面里；共 ${names.length} 个工具 / 起步价 ${declared} token ` +
          `（ToolRegistry.fixedOverheadTokens() 实调，与 ${names.length} × 180 对得上）—— ` +
          `决 4 用它一个替掉了 zip / mkdir / rm / mv 四个专用工具（那会是 +720 token）`
      : `装配不符：工具数 ${names.length}，含 run_shell=${names.includes("run_shell")}，` +
          `起步价 ${declared}（期望 ${names.length * 180}）`,
  );

  // E3 边界 7
  let hits: string[] = [];
  try {
    hits = execFileSync(
      "grep",
      ["-rnE", "--exclude-dir=node_modules", "sandbox-exec|analyzeCommand|sbpl", "packages", "adapters"],
      { cwd: resolve(import.meta.dirname, "../../../.."), encoding: "utf8" },
    )
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .filter((l) => {
        const body = l.split(":").slice(2).join(":").trim();
        return !(body.startsWith("*") || body.startsWith("//") || body.startsWith("/*"));
      });
  } catch (err) {
    const e = err as { status?: number };
    if (e.status !== 1) throw err;
  }
  fact("边界 7 命中（去注释后）", hits.length === 0 ? "0" : hits.join("\n                                   "));
  verdict(
    hits.length === 0,
    hits.length === 0
      ? "边界 7 守住：沙箱与命令解析没有进 Runtime / 适配器 —— " +
          "这条抓的是第 4 / 6 条抓不到的形态：把解析搬进 action/ 不需要 import 任何工具包"
      : `边界 7 被破：Runtime 或适配器里出现了沙箱 / 命令解析代码`,
  );
}

await runVerify(main);
