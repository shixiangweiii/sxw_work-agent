/**
 * verify:ui —— 阶段 4 验收（白盒界面）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：**前三阶段的执行事实，能不能只靠既有的事件流、transcript 与三个 Port
 * 注入点，投影出一个完整的白盒界面 —— 而 Runtime Core 一行不改？**
 *
 *   A 段  三条新边界的**判别力实测**（注入即翻红）
 *   B 段  投影的确定性与 id 稳定性
 *   C 段  白盒完整性：来源可追溯、两条轨道缺一不可、数字不自己算
 *   D 段  三条「等人」通道走 HTTP 真跑一遍（决 4 的判别力所在）
 *   E 段  §22.6 的本地通信边界 ＋ 凭证不外泄
 *   F 段  SSE 重连游标不重不漏
 *
 * ── 这个脚本为什么必须真的起 HTTP 服务 ────────────────────────────────
 *
 * 因为 D 段要证明的正是「浏览器那一侧的人能不能把 Run 推下去」。
 * 直接调 `PendingHub` 的方法测，测的是我自己写的那个类；
 * 而真实链路上还夹着路由、鉴权、JSON 编解码与 `pendingId` 的往返 ——
 * E-3 那条教训（一条闸门排在另一条后面等于没有闸门）说的就是
 * 中间那几层里任何一层出错，前面的绿灯都不作数。
 * ══════════════════════════════════════════════════════════════════════
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asId, type RunId, type ToolSnapshot, type TranscriptEntry } from "@workagent/harness-runtime";
import { compose, DEFAULT_TOOLS, REPO_ROOT, loadEnv } from "../compose.js";
import {
  projectTimeline,
  projectTurns,
} from "../../../workagent-service/src/projection.js";
import { startService, type RunningService } from "../../../workagent-service/src/server.js";
import { BOUNDARIES, grepBoundary, type Boundary } from "./boundaries.js";
import { ScriptedModelPort, banner, fact, runVerify, section, verdict } from "./harness.js";

const TOKEN = "verify-ui-fixed-token-0123456789abcdef";

/** 只装 D 段真正要用的工具。少一个工具就少 180 token，也少一堆无关噪声。 */
function toolsFor(names: string[]): ToolSnapshot[] {
  return DEFAULT_TOOLS.filter((t) => names.includes(t.definition.name));
}

// ══════════════════════════════════════════════════ A 段：判别力实测

/**
 * 往被守的目录里注入一行违规，断言对应的边界当场翻红。
 *
 * 【定】A 段的每一条都要说清楚**注入的是什么形态**。
 * 阶段 3.5 的教训：`kills` 自陈「改坏这里会翻红」，而判别力实测显示
 * 有几条根本不会红（第二道闸门先挡住了）——
 * **一条不准的自陈比没有更糟，它让人以为某处改坏会被抓住。**
 */
function injectionTest(
  boundaryId: string,
  relPath: string,
  content: string,
): { hit: string | undefined; cleaned: boolean } {
  const abs = resolve(REPO_ROOT, relPath);
  const b = BOUNDARIES.find((x) => x.id === boundaryId) as Boundary;
  writeFileSync(abs, content, "utf8");
  try {
    const hits = grepBoundary(b);
    return { hit: hits.find((h) => h.includes(relPath)), cleaned: false };
  } finally {
    unlinkSync(abs);
  }
}

// ══════════════════════════════════════════════════════ HTTP 小工具

async function call(
  svc: RunningService,
  path: string,
  init?: { method?: string; body?: unknown; token?: string | null; origin?: string; host?: string },
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const headers: Record<string, string> = {};
  const tok = init?.token === undefined ? TOKEN : init.token;
  if (tok !== null) headers["Authorization"] = `Bearer ${tok}`;
  if (init?.body) headers["Content-Type"] = "application/json";
  if (init?.origin) headers["Origin"] = init.origin;
  if (init?.host) headers["Host"] = init.host;
  const res = await fetch(`http://127.0.0.1:${svc.port}${path}`, {
    method: init?.method ?? "GET",
    headers,
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    body = { _raw: raw };
  }
  return { status: res.status, body, raw };
}

/**
 * 手写一个 HTTP 请求发过去，绕开 `fetch`。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ── 为什么非得走裸 socket：`fetch` **不让你设 `Host` 头** ────────────────
 *
 * 它是 fetch 规范里的 forbidden header，Node 的实现会**静默丢掉**它并按
 * URL 重新填一个。于是用 `fetch` 写的那条「非 loopback Host 应当被拒」的判据
 * 是**永远绿**的：它根本没能把错误的值送出去。
 *
 * 第一次跑就是这样 —— 判据打了 200，而同一个服务用 curl 打 `Host: evil.example`
 * 是 403。**代码是对的，仪器是坏的。**
 *
 * 这正是摸底考试那条纪律的形态：**新增判据前先问「这条判据要区分的两个值，
 * 在夹具里相等吗」**。这里比相等更糟 —— 夹具连那个错误的值都造不出来。
 * ══════════════════════════════════════════════════════════════════════
 */
function rawRequest(port: number, hostHeader: string, token: string): Promise<number> {
  return new Promise((ok) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        `GET /api/state HTTP/1.1\r\nHost: ${hostHeader}\r\n` +
          `Authorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = "";
    sock.on("data", (d) => (buf += d.toString("utf8")));
    sock.on("close", () => ok(Number(/^HTTP\/1\.\d (\d{3})/.exec(buf)?.[1] ?? 0)));
    sock.on("error", () => ok(0));
  });
}

/** 等一个条件成立。超时返回 undefined —— 判据自己去判它是不是该有值。 */
async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 8000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 60));
  }
  return undefined;
}

interface PendingItem {
  pendingId: string;
  kind: string;
  approval?: { toolName: string; effectType: string; why: string };
  question?: { question: string; options: string[] };
  handoff?: { instructions: string; expectedCompletion: string };
}

async function nextPending(svc: RunningService, kind: string): Promise<PendingItem | undefined> {
  return waitFor(async () => {
    const r = await call(svc, "/api/state");
    const list = (r.body["pending"] as PendingItem[] | undefined) ?? [];
    return list.find((p) => p.kind === kind);
  });
}

/** 读 SSE，收满 `want` 条或超时就断开。返回收到的 sequence 序列。 */
async function readSse(svc: RunningService, runId: string, since: number): Promise<number[]> {
  const res = await fetch(
    `http://127.0.0.1:${svc.port}/api/runs/${runId}/events?since=${since}&t=${TOKEN}`,
  );
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const seqs: number[] = [];
  const deadline = Date.now() + 1500;
  let buf = "";
  while (Date.now() < deadline) {
    const timeout = new Promise<{ done: true; value: undefined }>((r) =>
      setTimeout(() => r({ done: true, value: undefined }), 400),
    );
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk.done) break;
    buf += decoder.decode(chunk.value as Uint8Array, { stream: true });
    for (const line of buf.split("\n")) {
      if (line.startsWith("id: ")) seqs.push(Number(line.slice(4)));
    }
    buf = "";
  }
  await reader.cancel().catch(() => {});
  return seqs;
}

/**
 * 造一个停在「有未配对 tool_use」的 Run，供 I 段 resume 它。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 做法与 `verify:resume` 的硬崩注入同构：**往 transcript 里追加一个
 * 带 tool_call 而没有 result 的 assistant 回合**。那正是进程硬崩在工具执行
 * 中途时盘上留下的样子（优雅 cancel 不会留下未配对 —— `finalize()` 补齐了，
 * 这是阶段 1 跑出来才发现的事实）。
 *
 * 选 `append_log` 是因为它**非幂等**，而这里**不落 ACTION_FACT 前置指纹** ——
 * 于是 §18.2 的判定走到第三条分支（既不幂等也观察不了）→ `RECOVERY_REQUIRED`。
 * 决 6 的旋钮在这里生效：分支由 Action 级事实决定，不由工具的静态声明决定。
 *
 * 【定】用**独立的一次 compose**（同一个 db 文件）造夹具，不给 RunHost 开
 * 「写 transcript」的后门。测量装置不得长在被测对象身上。
 * ══════════════════════════════════════════════════════════════════════
 */
async function buildRecoveryFixture(workspaceRoot: string, dbPath: string): Promise<string> {
  const composed = compose({
    workspaceRoot,
    dbPath,
    approvalDecider: async () => ({ approved: true }),
    trace: { emit: () => {} },
    tools: toolsFor(["append_log"]),
    // 一轮就收尾：我们只需要一个**存在且可 resume**的 Run 骨架。
    modelPortOverride: new ScriptedModelPort([{ text: "先到这里。", toolCalls: [] }]),
  });

  const gen = composed.runtime.start(composed.makeRunSpec("I 段夹具：制造未配对 tool_use"));
  let runId = "";
  let r = await gen.next();
  while (!r.done) {
    if (!runId) runId = String(r.value.runId);
    r = await gen.next();
  }

  // 注入未配对的 tool_call（没有 result，也没有 ACTION_FACT 指纹）
  await composed.ports.transcript.append({
    runId: asId<RunId>(runId),
    schemaVersion: 1,
    kind: "MESSAGE",
    message: {
      role: "assistant",
      turn: 9,
      content: [
        {
          type: "tool_call",
          toolCallId: "tc_ui_recovery",
          name: "append_log",
          input: { path: "recovery-probe.log", line: "一条追加" },
        },
      ],
    },
    createdAt: Date.now(),
  });
  /**
   * 【定】状态要落成**可恢复**的那一档。
   *
   * 这里直接写 `CANCELLED` 是**夹具**在模拟「上次崩了/被取消了」，
   * 不是 Layer 2 在推进状态 —— 边界 9 扫的是 `apps/workagent-service/src`，
   * 而这段代码住在验收脚本里。两者的区别是本质的：
   * 测量装置可以摆布被测系统的初始状态，产品代码不可以。
   */
  await composed.ports.runs.setStatus(asId<RunId>(runId), "CANCELLED", Date.now());
  composed.db.close();
  return runId;
}

// ══════════════════════════════════════════════════════════════ main

async function main(): Promise<void> {
  banner(
    "阶段 4 验收：白盒界面（verify:ui）",
    "执行事实能不能只靠既有的事件流与注入点投影成界面，而 Runtime 一行不改？",
  );

  // ════════════════════════════════════════════════ A. 三条新边界的判别力
  section("A. 阶段 4 新增边界的判别力实测（注入即翻红）");
  console.log(
    "   前面 verify:tools 里那句「干净」只证明现在没有违规，不证明**发现得了**违规。\n" +
      "   阶段 3.5 的教训：几条 kills 自陈过判别力，实测才发现根本不会红。\n",
  );

  const inj8 = injectionTest(
    "8",
    "apps/workagent-ui/public/__boundary_canary.js",
    '// 判别力实测的临时文件，写完立刻删。\nimport { HarnessRuntime } from "@workagent/harness-runtime";\nexport const x = HarnessRuntime;\n',
  );
  fact("注入后第 8 条命中", inj8.hit ?? "（没命中 —— 这条 grep 没有判别力）");
  verdict(
    inj8.hit !== undefined,
    "往 UI 目录注入一行对 Runtime 的 import，第 8 条当场翻红并指出行号",
  );

  const inj9 = injectionTest(
    "9",
    "apps/workagent-service/src/__boundary_canary.ts",
    "// 判别力实测的临时文件，写完立刻删。\n" +
      "export function fix(ports: { runs: { setStatus: (a: string, b: string) => void } }): void {\n" +
      '  ports.runs.setStatus("run_x", "FAILED");\n' +
      "}\n",
  );
  fact("注入后第 9 条命中", inj9.hit ?? "（没命中 —— 这条 grep 没有判别力）");
  verdict(
    inj9.hit !== undefined,
    "往 Layer 2 注入一句 setStatus（「顺手把状态修正一下」那种写法），第 9 条当场翻红",
  );

  const inj10 = injectionTest(
    "10",
    "apps/workagent-ui/public/__boundary_canary2.js",
    "// 判别力实测的临时文件，写完立刻删。\n" +
      "export function render(node, modelText) {\n  node.innerHTML = modelText;\n}\n",
  );
  fact("注入后第 10 条命中", inj10.hit ?? "（没命中 —— 这条 grep 没有判别力）");
  verdict(
    inj10.hit !== undefined,
    "往界面注入一句把模型文本塞进 innerHTML 的渲染，第 10 条当场翻红",
  );

  const inj11 = injectionTest(
    "11",
    "apps/workagent-ui/public/__boundary_canary3.js",
    "// 判别力实测的临时文件，写完立刻删。\n" +
      'export const bar = el("i", { style: "width:80%" });\n',
  );
  fact("注入后第 11 条命中", inj11.hit ?? "（没命中 —— 这条 grep 没有判别力）");
  verdict(
    inj11.hit !== undefined,
    "往界面注入一句内联 style 写法，第 11 条当场翻红 —— 它挡的是「被自己的 CSP 静默丢弃」那类改动",
  );

  // ════════════════════════════════════════════════════ 起一个真服务
  const tmp = mkdtempSync(join(tmpdir(), "workagent-ui-"));
  const workspaceRoot = join(tmp, "ws");
  const traceDir = join(tmp, "runs");
  rmSync(workspaceRoot, { recursive: true, force: true });
  writeFileSync(join(tmp, ".keep"), "", "utf8");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(traceDir, { recursive: true });

  /**
   * 脚本化的四轮，每一轮打一条等人的通道。
   *
   * 【定】选 `append_log` 而不是 `write_file` 来触发审批：决 3 的默认档位
   * **放行 workspace 内的可逆写**，`write_file` 根本不会停下来问 ——
   * 用它当夹具会让 D 段的审批判据永远绿，而它压根没经过审批。
   * 这正是「这条判据要区分的两个值，在夹具里相等吗」那条纪律。
   */
  const script = new ScriptedModelPort([
    {
      text: "先追加一行日志（不可逆，应当停下来问）。",
      toolCalls: [
        { toolCallId: "c1", name: "append_log", input: { path: "log.txt", line: "hello" } },
      ],
    },
    {
      text: "任务有歧义，问一句。",
      toolCalls: [
        {
          toolCallId: "c2",
          name: "ask_user",
          input: { question: "产物放哪个目录？", options: "放 out/\n放根目录" },
        },
      ],
    },
    {
      text: "有一步我做不了，请人接手。",
      toolCalls: [
        {
          toolCallId: "c3",
          name: "request_handoff",
          input: {
            instructions: "去审批系统里把合同编号查出来",
            expected_completion: "workspace 下出现 contract-id.txt",
          },
        },
      ],
    },
    { text: "做完了。", toolCalls: [] },
  ]);

  const svc = await startService({
    workspaceRoot,
    dbPath: ":memory:",
    traceDir,
    endpoint: "bailian",
    token: TOKEN,
    composeOverrides: {
      modelPortOverride: script,
      tools: toolsFor(["append_log", "ask_user", "request_handoff", "list_dir"]),
      timezone: "Asia/Shanghai",
    },
  });

  try {
    // ══════════════════════════════════ D. 三条等人的通道（先跑，后面几段要用它的数据）
    section("D. 三条「等人」通道走 HTTP 真跑一遍（决 4）");
    console.log(
      "   `compose.ts` 里那句「只有这一层知道人在哪（终端、GUI、还是一个没有人的 CI）」\n" +
        "   写了一个阶段，而在此之前**只有终端这一种人**。这一段是它的第一次兑现。\n",
    );

    const started = await call(svc, "/api/runs", { method: "POST", body: { task: "阶段 4 夹具" } });
    const runId = String(started.body["runId"] ?? "");
    fact("POST /api/runs", `${started.status} → ${runId || "（没拿到 runId）"}`);

    const p1 = await nextPending(svc, "APPROVAL");
    fact(
      "① 审批请求送达界面",
      p1 ? `${p1.approval?.toolName} / ${p1.approval?.effectType} / ${p1.approval?.why}` : "（没等到）",
    );
    const a1 = p1
      ? await call(svc, `/api/pending/${p1.pendingId}`, {
          method: "POST",
          body: { kind: "APPROVAL", approved: true },
        })
      : undefined;
    verdict(
      !!p1 && a1?.status === 200,
      "审批：IRREVERSIBLE 的写停下来问，浏览器点「批准」后 Run 继续（走的是与 CLI 同一个 ApprovalDecider）",
    );

    // 幂等：同一个 pendingId 再答一次必须 409，不能假装成功。
    const again = p1
      ? await call(svc, `/api/pending/${p1.pendingId}`, {
          method: "POST",
          body: { kind: "APPROVAL", approved: true },
        })
      : undefined;
    fact("重复应答同一个 pendingId", `${again?.status}`);
    verdict(
      again?.status === 409,
      "重复应答返回 409 而不是 200 —— 返回 200 会让界面以为「又批准了一次」，而那次执行早已按别的路径处置",
    );

    const p2 = await nextPending(svc, "QUESTION");
    fact("② 提问送达界面", p2 ? `${p2.question?.question}｜${p2.question?.options.join(" / ")}` : "（没等到）");
    const a2 = p2
      ? await call(svc, `/api/pending/${p2.pendingId}`, {
          method: "POST",
          body: { kind: "QUESTION", choice: p2.question?.options[0] },
        })
      : undefined;
    verdict(
      !!p2 && a2?.status === 200 && (p2.question?.options.length ?? 0) === 2,
      "提问：ask_user 的选项原样送到界面，选一个之后 Run 继续（QuestionChannel）",
    );

    const p3 = await nextPending(svc, "HANDOFF");
    fact("③ 接管请求送达界面", p3 ? p3.handoff?.instructions : "（没等到）");
    // 【定】expectedCompletion 必须送到界面。它是 §20.3「完成信号 ≠ 任务成功」
    // 的载体 —— 界面上看不到「做完之后应该能看到什么」，人就只能凭感觉点完成。
    fact("接管带着可观察的完成判据", p3?.handoff?.expectedCompletion ?? "（缺）");
    const a3 = p3
      ? await call(svc, `/api/pending/${p3.pendingId}`, {
          method: "POST",
          body: { kind: "HANDOFF", note: "我查到了，已写进 contract-id.txt" },
        })
      : undefined;
    verdict(
      !!p3 && a3?.status === 200 && !!p3.handoff?.expectedCompletion,
      "接管：request_handoff 的说明与**可观察的完成判据**都送到界面（HandoffChannel）",
    );

    const finished = await waitFor(async () => {
      const d = await call(svc, `/api/runs/${runId}`);
      const status = String(d.body["status"] ?? "");
      return status === "COMPLETED" || status === "FAILED" ? d.body : undefined;
    });
    fact("Run 结算", finished ? `${finished["status"]} / ${(finished["outcome"] as { kind?: string } | undefined)?.kind}` : "（没跑完）");
    verdict(
      !!finished,
      "三条通道全部由浏览器应答之后，Run 跑到终态 —— Runtime 侧一行代码都没有为 Web 改过",
    );

    const detail = finished ?? (await call(svc, `/api/runs/${runId}`)).body;

    // ══════════════════════════════ D2. 取消之后 resume，审批还能不能等到人
    section("D2. 第二段的审批：取消 → resume 之后，闸门必须还活着");
    console.log(
      "   这一段是为一个**真实写出来过的 bug** 加的：`aborterFor()` 对同一个 runId\n" +
        "   返回同一个 AbortController，而上一段收尾时刚 abort 过它 —— 于是 resume 起来的\n" +
        "   第二段里，审批等待一进去就看到 aborted，立刻按「等待被中断」处置，\n" +
        "   **结算 USER_REJECTED 而全程没有任何人拒绝过任何东西**（E-3 那个坑换了层壳）。\n" +
        "   它只在第二段出现，第一段全绿 —— 所以必须单独有一条判据。\n",
    );

    const svc2 = await startService({
      workspaceRoot,
      dbPath: ":memory:",
      traceDir: join(tmp, "runs2"),
      endpoint: "bailian",
      token: TOKEN,
      composeOverrides: {
        // 两次 append_log：第一次在第一段被取消，第二次在 resume 之后。
        modelPortOverride: new ScriptedModelPort([
          {
            text: "第一段",
            toolCalls: [{ toolCallId: "d1", name: "append_log", input: { path: "a.txt", line: "1" } }],
          },
          {
            text: "第二段",
            toolCalls: [{ toolCallId: "d2", name: "append_log", input: { path: "a.txt", line: "2" } }],
          },
          { text: "收工。", toolCalls: [] },
        ]),
        tools: toolsFor(["append_log"]),
      },
    });
    try {
      const r2 = await call(svc2, "/api/runs", { method: "POST", body: { task: "第二段审批夹具" } });
      const rid2 = String(r2.body["runId"] ?? "");
      const firstPending = await nextPending(svc2, "APPROVAL");
      fact("第一段的审批出现", firstPending ? "是" : "否");

      // 【定】用取消而不是拒绝 —— 拒绝走的是「人给了决定」那条路，
      // 而这里要造的恰恰是「等待被外力打断」，那才会 abort 掉 controller。
      await call(svc2, `/api/runs/${rid2}/cancel`, { method: "POST" });
      await waitFor(async () => {
        const d = await call(svc2, `/api/runs/${rid2}`);
        return d.body["liveInThisProcess"] === false ? true : undefined;
      });
      fact("取消后 Run 状态", String((await call(svc2, `/api/runs/${rid2}`)).body["status"]));

      await call(svc2, `/api/runs/${rid2}/resume`, { method: "POST", body: {} });
      const secondPending = await nextPending(svc2, "APPROVAL");
      fact("resume 之后的审批出现", secondPending ? "是" : "**否 —— 闸门在第二段死了**");
      verdict(
        !!firstPending && !!secondPending,
        "取消再 resume 之后，审批闸门仍然停下来等人（每段换一个新的 AbortController）",
      );

      if (secondPending) {
        await call(svc2, `/api/pending/${secondPending.pendingId}`, {
          method: "POST",
          body: { kind: "APPROVAL", approved: true },
        });
      }
      const done2 = await waitFor(async () => {
        const d = await call(svc2, `/api/runs/${rid2}`);
        const st = String(d.body["status"] ?? "");
        return st === "COMPLETED" || st === "FAILED" ? d.body : undefined;
      });
      const kind2 = (done2?.["outcome"] as { kind?: string } | undefined)?.kind;
      fact("第二段结算", `${done2?.["status"]} / ${kind2}`);
      /**
       * ── 这里**故意只是一条 fact，不是判据** ────────────────────────────
       *
       * 我先把它写成了 `verdict(kind2 !== "USER_REJECTED", …)`，措辞是
       * 「结算不是 USER_REJECTED —— 那个值只能来自真的有人拒绝过」。
       * 然后按惯例做判别力实测（把 `beginSegment` 里换 controller 那一行注掉）：
       *
       *   · 上面那条判据**当场翻红**（审批再也不出现）；
       *   · **这一条照样绿** —— 结算仍然是 SUCCESS。
       *
       * 原因是这个夹具里 `append_log` 被拒之后没有留下**未达成的必需
       * Verification**，而 `USER_REJECTED` 是从事实表里那类记录聚合出来的
       * （见 `settle-outcome.ts`）。也就是说这条断言在本夹具下**不可能为假**。
       *
       * 【定】一条不会红的断言不是判据，是装饰。阶段 3.5 记过同一条教训
       * （几条 `kills` 自陈过判别力，实测才发现根本不会红），而**这次是我自己
       * 又写了一条** —— 所以降级成 fact，并把这段过程留在这里：
       * 装饰如果不当场拆掉，会被抄到第二处去。
       */
      fact(
        "（上面这个数只作记录，不作判据）",
        "判别力实测显示：把 beginSegment 改坏之后它照样是 SUCCESS —— 本夹具下它不可能为假",
      );
    } finally {
      await svc2.close();
    }

    // ══════════════════════════ D3. 自动放行的**正分支**（E-3 的防回归）
    section("D3. 自动放行的正分支：workspace 内的覆盖写不该停下来问");
    console.log(
      "   评审（codex 5.5.1）指出的空白：D 段刻意用 append_log（IRREVERSIBLE）触发审批，\n" +
        "   验的全是**拒绝**那一侧。而 E-3 那个真实事故是**放行**那一侧坏了 ——\n" +
        "   `write_file` 声明 PARTIALLY_REVERSIBLE，而规则写成 `!== \"REVERSIBLE\"` 就拒，\n" +
        "   于是自动放行**从来没覆盖过它唯一为之而写的工具**：真实端点上模型做完了全部工作，\n" +
        "   两次写入被「无人应答」挡掉，结算 USER_REJECTED，而没有任何人拒绝过任何东西。\n" +
        "   改回那个写法，本脚本此前**照样全绿** —— 所以这一段必须存在。\n",
    );

    const svcAuto = await startService({
      workspaceRoot,
      dbPath: ":memory:",
      traceDir: join(tmp, "runs-auto"),
      endpoint: "bailian",
      token: TOKEN,
      composeOverrides: {
        modelPortOverride: new ScriptedModelPort([
          {
            text: "写一个文件",
            toolCalls: [
              { toolCallId: "w1", name: "write_file", input: { path: "auto.txt", content: "hi" } },
            ],
          },
          { text: "好了。", toolCalls: [] },
        ]),
        tools: toolsFor(["write_file"]),
      },
    });
    try {
      const started = await call(svcAuto, "/api/runs", { method: "POST", body: { task: "自动放行正分支" } });
      const rid = String(started.body["runId"] ?? "");
      /**
       * 【定】判据是「**从来没有人被问过**」，不是「没有审批事件」。
       *
       * 第一版我写成了「时间线上 APPROVAL 条目数 == 0」，一跑就红 ——
       * 因为 `ApprovalRequested` / `ApprovalDecided` 这对事件**无论如何都会发**
       * （WRITE 在 `requiresApprovalFor` 里），自动放行发生在 decider **内部**。
       * 也就是说那条判据区分不了「自动放行」与「有人点了同意」。
       *
       * 真正的判别式是 `PendingHub` 里有没有出现过一张卡片：
       * 档位坏掉（回到 `!== "REVERSIBLE"` 就拒）时，这个脚本没有人去应答，
       * Run 会**挂在那里**直到超时 —— 下面两条判据一起翻红。
       */
      let sawPending = 0;
      const done = await waitFor(async () => {
        const st0 = await call(svcAuto, "/api/state");
        sawPending += ((st0.body["pending"] as unknown[]) ?? []).length;
        const d = await call(svcAuto, `/api/runs/${rid}`);
        const st = String(d.body["status"] ?? "");
        return st === "COMPLETED" || st === "FAILED" ? d.body : undefined;
      }, 6000);
      const timeline = (done?.["timeline"] as Array<{ kind: string; approved?: boolean }> | undefined) ?? [];
      const approvals = timeline.filter((e) => e.kind === "APPROVAL");
      const kind = (done?.["outcome"] as { kind?: string } | undefined)?.kind;
      fact("轮询期间出现过的等人卡片", sawPending);
      fact("审批事件（自动放行也会发这一对）", `${approvals.length} 条，approved=${approvals.map((a) => a.approved).join(",")}`);
      fact("结算", `${done?.["status"]} / ${kind}`);
      verdict(
        !!done && sawPending === 0,
        "workspace 内的 write_file（PARTIALLY_REVERSIBLE）走自动放行：**一次都没有停下来问人**，Run 自己跑完",
      );
      /**
       * 【定】`approvals.length > 0` 这一项不能省 —— 它让这条判据**非恒真**。
       *
       * 第一版写的是 `kind !== "USER_REJECTED" && approvals.every(...)`。
       * 注入实测（把档位改回 `!== "REVERSIBLE"` 就拒）时：第一条如期翻红，
       * **这一条照样绿** —— 因为那时 Run 挂住了，一个审批事件都没有，
       * 空数组的 `every()` 恒真、`kind` 是 undefined 也 `!== "USER_REJECTED"`。
       * 又一条不会红的装饰。加上「至少有一次审批事件」之后它才真的在判事。
       */
      verdict(
        approvals.length > 0 &&
          approvals.every((a) => a.approved === true) &&
          kind === "SUCCESS",
        "审批事件对上记的是「已批准」且结算为 SUCCESS —— 而不是 E-3 那种「结算 USER_REJECTED 却没有人拒绝过」",
      );
    } finally {
      await svcAuto.close();
    }

    // ══════════════════════════ G. 失败的 resume 不留幻影、不锁死服务
    section("G. 失败的 resume：不留「在跑」幻影，不锁死单前台闸门");
    console.log(
      "   三份评审各自独立报的那一条，我实测复现过完整后果：\n" +
        "   对终态 Run 点一次 resume → 记录卡在 done:false → 列表显示「在跑」→\n" +
        "   若它恰好是 currentRunId，**后续任何 start/resume 全部 500，只能重启进程**；\n" +
        "   而那句报错还在建议「或在界面上取消它」—— 取消并不复位，照做仍然是死的。\n",
    );

    const svcG = await startService({
      workspaceRoot,
      dbPath: ":memory:",
      traceDir: join(tmp, "runs-g"),
      endpoint: "bailian",
      token: TOKEN,
      composeOverrides: {
        modelPortOverride: new ScriptedModelPort([{ text: "什么都不做。", toolCalls: [] }]),
        tools: toolsFor(["now"]),
      },
    });
    try {
      const first = await call(svcG, "/api/runs", { method: "POST", body: { task: "G 段夹具" } });
      const gid = String(first.body["runId"] ?? "");
      await waitFor(async () => {
        const d = await call(svcG, `/api/runs/${gid}`);
        return String(d.body["status"]) === "COMPLETED" ? true : undefined;
      });

      /**
       * 顺带验 Web 段的 trace 契约（评审 zcode P2-2 / pi-glm P3 / codex P1-8B）。
       *
       * 原实现只追加 `{kind:"event"}` 行，注释写着「header / footer 由 CLI 写」——
       * 而纯 Web 起跑、纯 Web 跑完的 Run **没有任何人写这两种行**。后果：
       * 服务重启后 outcome 蒸发（`loadTraceOutcome` 读的就是 footer），
       * Trace 视图的「段 N ＋ commit ＋ gitDirty」对 Web 段永远缺失 ——
       * 而那正是 Roadmap §6.1 声明过的东西。
       */
      const traceLines = (await call(svcG, `/api/runs/${gid}/trace`)).body["lines"] as
        | Array<Record<string, unknown>>
        | undefined;
      const kinds = (traceLines ?? []).map((l) => String(l["kind"]));
      const header = (traceLines ?? []).find((l) => l["kind"] === "header");
      fact("Web 段的 trace 行构成", `header ${kinds.filter((k) => k === "header").length} / event ${kinds.filter((k) => k === "event").length} / footer ${kinds.filter((k) => k === "footer").length}`);
      fact("header 的 provenance", header ? `commit ${String(header["commit"]).slice(0, 10)} · gitDirty ${header["gitDirty"]} · entry ${header["entry"]}` : "（缺）");
      verdict(
        kinds.includes("header") && kinds.includes("footer") && !!header?.["commit"],
        "Web 入口跑的段也写 header / event / footer 三种行，且带 commit ＋ gitDirty —— " +
          "「Trace 按段分组、每段可审计」对 Web 段成立",
      );

      const rejected = await call(svcG, `/api/runs/${gid}/resume`, { method: "POST", body: {} });
      const after = await call(svcG, `/api/runs/${gid}`);
      fact("对终态 Run 点 resume", `HTTP ${rejected.status}`);
      fact("resume 之后 liveInThisProcess", String(after.body["liveInThisProcess"]));
      fact("serviceError 是否在场", after.body["serviceError"] ? "是" : "否");
      verdict(
        rejected.status === 500 &&
          after.body["liveInThisProcess"] === false &&
          typeof after.body["serviceError"] === "string",
        "被闸门拒掉的 resume：不留「在跑」幻影，且错误原文经 serviceError 到得了界面",
      );

      const nextRun = await call(svcG, "/api/runs", { method: "POST", body: { task: "闸门没被锁死吧" } });
      fact("失败 resume 之后再起一个 Run", `HTTP ${nextRun.status}`);
      verdict(
        nextRun.status === 200,
        "单前台闸门没有被那次失败的 resume 锁死 —— 一次误操作不该变成服务级不可用",
      );

      // 顺带：对一个本进程从未跑过的 Run 调 cancel，不得凭空造出「在跑」
      const listBefore = await call(svcG, "/api/state");
      const other = ((listBefore.body["runs"] as Array<{ runId: string }>) ?? []).find(
        (r) => r.runId !== gid,
      );
      if (other) {
        await call(svcG, `/api/runs/${other.runId}/cancel`, { method: "POST" });
        const listAfter = await call(svcG, "/api/state");
        const row = ((listAfter.body["runs"] as Array<{ runId: string; liveInThisProcess: boolean }>) ?? [])
          .find((r) => r.runId === other.runId);
        fact("cancel 一个未在本进程跑过的 Run 之后", `live=${row?.liveInThisProcess}`);
        verdict(
          row?.liveInThisProcess === false,
          "cancel 不再凭空创建「在跑」记录（决 6：投影不得断言一个假事实）",
        );
      }
    } finally {
      await svcG.close();
    }

    // ══════════════════════════ H. 产物预览：登记绑定 ＋ realpath ＋ hash 漂移
    section("H. 产物预览不是任意文件读（§22.1 / §22.3）");
    console.log(
      "   实测复现过的那条：旧接口收 `?path=` 任意相对路径、只做词法前缀判定，\n" +
        "   于是 workspace 里一个指向仓库根 .env 的 symlink 能把**真实凭证**送进浏览器。\n" +
        "   它直接推翻了本阶段自己写的「凭证不出现在任何 API 响应体」——\n" +
        "   而 E 段只扫了 state / detail / trace，恰恰漏了唯一返回文件正文的这个接口。\n",
    );
    {
      // ① 非登记路径：新接口连参数都不收
      const byPath = await call(svc, "/api/artifact?path=" + encodeURIComponent("../../.env"));
      fact("旧的 ?path= 调法", `HTTP ${byPath.status}`);
      // ② 伪造 artifactId
      const bogus = await call(svc, `/api/artifact?runId=${runId}&artifactId=art_does_not_exist`);
      fact("不存在的 artifactId", `HTTP ${bogus.status}`);
      // ③ 路径穿越形状
      const traversal = await call(svc, "/api/runs/..%2f..%2fetc%2fpasswd/trace");
      fact("trace 路由的 %2f 穿越", `HTTP ${traversal.status}`);
      verdict(
        byPath.status === 400 &&
          bogus.status === 404 &&
          traversal.status === 400,
        "预览必须按 runId ＋ artifactId 取；伪造 id 与 %2f 穿越都被挡在路由层",
      );
    }

    // ══════════════════════════ I. RECOVERY_REQUIRED 的项必须看得见
    section("I. 停在 RECOVERY_REQUIRED 时，要确认哪几件事必须显示出来");
    console.log(
      "   评审（codex P1-1）里最危险的一条：`RECOVERY_REQUIRED` 按 §10.4 是**非终态**，\n" +
        "   因此没有 outcome —— 而 detail() 原本只从 outcome.recoveryItems 取恢复项。\n" +
        "   后果是界面显示「状态未知的副作用：（无）」，同时照常给出 CONTINUE / ABORT 按钮：\n" +
        "   人被要求做一个决定，却看不到自己要确认什么。而仓里有【定】说「只有显式决策\n" +
        "   能销账」—— 一个盲着做出的决策不是决策。\n",
    );
    {
      const recoveryDb = join(tmp, "recovery.db");
      const recoveryTrace = join(tmp, "runs-recovery");
      const runIdR = await buildRecoveryFixture(workspaceRoot, recoveryDb);
      const svcR = await startService({
        workspaceRoot,
        dbPath: recoveryDb,
        traceDir: recoveryTrace,
        endpoint: "bailian",
        token: TOKEN,
        composeOverrides: {
          modelPortOverride: new ScriptedModelPort([{ text: "不该走到这里。", toolCalls: [] }]),
          tools: toolsFor(["append_log"]),
        },
      });
      try {
        await call(svcR, `/api/runs/${runIdR}/resume`, { method: "POST", body: {} });
        const d = await waitFor(async () => {
          const r = await call(svcR, `/api/runs/${runIdR}`);
          return String(r.body["status"]) === "RECOVERY_REQUIRED" ? r.body : undefined;
        });
        const items =
          ((d?.["recovery"] as { items?: Array<{ what: string; sideEffectState: string }> } | undefined)
            ?.items) ?? [];
        fact("状态", String(d?.["status"]));
        fact("恢复项条数", items.length);
        for (const i of items) fact("  · ", `${i.what}（${i.sideEffectState}）`);
        verdict(
          items.length > 0 && items.some((i) => i.what.includes("append_log")),
          "停在 RECOVERY_REQUIRED 时，界面拿得到「要确认哪几件事」（点名到工具），而不是一个空列表",
        );
      } finally {
        await svcR.close();
      }
    }

    // ══════════════════════════ J. workspace：身份闸门（S4-5）
    section("J. 跨 workspace resume 必须被拒（S4-5 的安全前提）");
    console.log(
      "   「选目录 → 切换 workspace」这个功能的**前提**，不是它本身。\n" +
        "   `--db` 与 `--workspace` 是分开的两个参数，同一个库里可以躺着来自不同目录的 Run；\n" +
        "   而 resume 用的 workspaceRoot 一直来自**当前 compose**（`RunSpec.workspace`\n" +
        "   从阶段 1 起就在类型里、一直是 undefined）。于是在 /A 起的 Run 用 /B 恢复，\n" +
        "   未配对工具的观察、幂等重试、后续所有相对路径的读写、以及自动放行的\n" +
        "   workspace 判定，**全部以 /B 为根** —— 旧 Run 在错误的地方产生副作用，盘上看不出来。\n" +
        "   界面把它从「要手打 runId」变成「列表里一个按钮」，所以闸门必须先在。\n",
    );
    {
      const wsA = join(tmp, "ws-a");
      const wsB = join(tmp, "ws-b");
      mkdirSync(wsA, { recursive: true });
      mkdirSync(wsB, { recursive: true });
      const sharedDb = join(tmp, "shared.db");

      // 在 A 下起一个 Run 并留一个未配对 tool_use（形态同 I 段）
      const runIdA = await buildRecoveryFixture(wsA, sharedDb);

      // 用**指向 B**的 compose 去 resume 同一个库里的这个 Run
      const composedB = compose({
        workspaceRoot: wsB,
        dbPath: sharedDb,
        approvalDecider: async () => ({ approved: true }),
        trace: { emit: () => {} },
        tools: toolsFor(["append_log"]),
        modelPortOverride: new ScriptedModelPort([{ text: "不该走到这里。", toolCalls: [] }]),
      });
      let refused: string | undefined;
      try {
        const g = composedB.runtime.resume(asId<RunId>(runIdA));
        let r = await g.next();
        while (!r.done) r = await g.next();
      } catch (err) {
        refused = (err as Error).message;
      }
      composedB.db.close();

      fact("Run 冻结的 workspace", wsA);
      fact("resume 时服务指向的", wsB);
      fact("结果", refused ? `拒绝：${refused.split("\n")[0]}` : "**放行了 —— 闸门不存在**");
      verdict(
        refused !== undefined && refused.includes("workspace"),
        "同一个库里、在 A 下起的 Run，用指向 B 的 compose 恢复 → **被拒绝**（§18.3 的第二维）",
      );

      // 反向：指回 A 必须放行 —— 少了这一条，「一律拒绝」也能让上面那条绿
      const composedA = compose({
        workspaceRoot: wsA,
        dbPath: sharedDb,
        approvalDecider: async () => ({ approved: true }),
        trace: { emit: () => {} },
        tools: toolsFor(["append_log"]),
        modelPortOverride: new ScriptedModelPort([{ text: "收工。", toolCalls: [] }]),
      });
      let allowed = false;
      try {
        const g = composedA.runtime.resume(asId<RunId>(runIdA));
        let r = await g.next();
        while (!r.done) r = await g.next();
        allowed = true;
      } catch {
        allowed = false;
      }
      composedA.db.close();
      fact("指回 A 再 resume", allowed ? "放行" : "**也被拒了**");
      verdict(
        allowed,
        "指回原 workspace 时照常放行 —— 配对判据，少了它「一律拒绝」也能让上一条绿" +
          "（阶段 3.5 沙箱那次栽的就是这一跤）",
      );
    }

    // ══════════════════════════ K. workspace 注册表：隔离、切换、拒绝
    section("K. 选目录 / 新建 / 切换 workspace");
    {
      const wsC = join(tmp, "ws-c");
      const wsD = join(tmp, "ws-d");
      const registry = join(tmp, "workspaces.json");
      const svcW = await startService({
        workspaceRoot: wsC,
        dbPath: join(wsC, ".workagent", "runs.db"),
        traceDir: join(wsC, ".workagent", "runs"),
        registryFile: registry,
        endpoint: "bailian",
        token: TOKEN,
        composeOverrides: {
          modelPortOverride: new ScriptedModelPort([{ text: "什么都不做。", toolCalls: [] }]),
          tools: toolsFor(["now"]),
        },
      });
      try {
        // ① 新建一个目录（不存在 → 建出来）
        const created = await call(svcW, "/api/workspaces", {
          method: "POST",
          body: { path: wsD, name: "D" },
        });
        const wsDId = (created.body["workspace"] as { id: string } | undefined)?.id ?? "";
        fact("新建 workspace", `HTTP ${created.status} · id=${wsDId} · 目录已建=${existsSync(wsD)}`);
        verdict(
          created.status === 200 && !!wsDId && existsSync(wsD),
          "POST /api/workspaces 能指定一个**尚不存在**的目录：登记 ＋ 建出来",
        );

        // ② 在 C 里起一个 Run
        const runC = await call(svcW, "/api/runs", { method: "POST", body: { task: "C 的任务" } });
        const runCId = String(runC.body["runId"] ?? "");
        await waitFor(async () => {
          const d = await call(svcW, `/api/runs/${runCId}`);
          return String(d.body["status"]) === "COMPLETED" ? true : undefined;
        });

        // ③ 切到 D，断言看不见 C 的 Run（存储隔离）
        const act = await call(svcW, `/api/workspaces/${wsDId}/activate`, { method: "POST" });
        const stateD = await call(svcW, "/api/state");
        const runsInD = (stateD.body["runs"] as Array<{ runId: string }>) ?? [];
        fact("切到 D", `HTTP ${act.status}`);
        fact("D 的 Run 列表", `${runsInD.length} 条`);
        verdict(
          act.status === 200 &&
            stateD.body["activeWorkspaceId"] === wsDId &&
            !runsInD.some((r) => r.runId === runCId),
          "切到 D 之后，C 的 Run **看不见** —— 一个 workspace 一套存储，跨目录的 Run 照不见面",
        );

        // ④ 切回 C，Run 还在
        await call(svcW, `/api/workspaces/${(stateD.body["workspaces"] as Array<{ id: string; name: string }>).find((w) => w.name !== "D")!.id}/activate`, { method: "POST" });
        const stateC = await call(svcW, "/api/state");
        const runsInC = (stateC.body["runs"] as Array<{ runId: string }>) ?? [];
        fact("切回 C 后的 Run 列表", `${runsInC.length} 条`);
        verdict(
          runsInC.some((r) => r.runId === runCId),
          "切回 C，它自己的 Run 还在 —— 隔离不是丢失",
        );

        // ⑤ 注册表落盘：两个都在
        const persisted = JSON.parse(readFileSync(registry, "utf8")) as {
          workspaces: Array<{ realPath: string }>;
        };
        fact("注册表里的 workspace", persisted.workspaces.length);
        verdict(
          persisted.workspaces.length === 2,
          "注册表落盘（Layer 2 产品状态，独立于 Layer 3 的库）—— 重启服务后选择还在",
        );

        // ⑥ 越界拒绝
        const rootWs = await call(svcW, "/api/workspaces", { method: "POST", body: { path: "/" } });
        fact("把 / 当 workspace", `HTTP ${rootWs.status}`);
        verdict(
          rootWs.status === 400,
          "拒绝把根目录当 workspace —— Agent 在 workspace 内有写权限，以 / 为根等于没有边界",
        );
      } finally {
        await svcW.close();
      }
    }

    // ══════════════════════════════════════════════ B. 投影的确定性与 id 稳定
    section("B. 投影：确定性、id 稳定、前缀一致（§23.2 幂等）");

    const host = svc.host;
    const entries: TranscriptEntry[] = await host.transcriptEntries(runId);
    const events = host.eventsSince(runId, 0);
    fact("两条轨道", `transcript ${entries.length} 条 / 事件 ${events.length} 条`);

    const t1 = projectTimeline({ entries, events });
    const t2 = projectTimeline({ entries, events });
    verdict(
      JSON.stringify(t1) === JSON.stringify(t2),
      "同一份输入投影两次，结果**逐字一致**（纯函数，没有时间戳、没有自增计数混进去）",
    );

    // 前缀一致：投影一个前缀，共有条目的 id 必须与全量的一致。
    const half = Math.floor(entries.length / 2);
    const cut = entries[half]?.sequence ?? 0;
    const prefix = projectTimeline({
      entries: entries.filter((e) => e.sequence <= cut),
      events: events.filter((e) => e.sequence <= cut),
    });
    const fullIds = new Map(t1.map((e) => [e.id, e.source.sequence]));
    const prefixIdsStable = prefix.every((e) => fullIds.get(e.id) === e.source.sequence);
    fact("前缀投影条目数", `${prefix.length} / 全量 ${t1.length}`);
    verdict(
      prefix.length > 0 && prefixIdsStable,
      "投影一个前缀，共有条目的 id 与锚点序号与全量投影完全一致 —— " +
        "界面靠它记住「哪几张卡片是展开的」，id 不稳每次刷新都会塌回去",
    );

    // ══════════════════════════════════════════════ C. 白盒完整性
    section("C. 白盒完整性：来源可追溯、两条轨道缺一不可、数字不自己算");

    const timeline = detail["timeline"] as Array<{
      id: string;
      kind: string;
      source: { track: string; sequence: number };
      input?: unknown;
      result?: string;
    }>;
    const seqs = new Set<number>([
      ...entries.map((e) => e.sequence),
      ...events.map((e) => e.sequence),
    ]);
    const traceable = timeline.every((e) => seqs.has(e.source.sequence));
    fact("时间线条目数", timeline.length);
    fact("每条都带真实来源序号", traceable ? "是" : "否");
    verdict(
      timeline.length > 0 && traceable,
      "每个投影项都带 `source`，且序号真的存在于某条轨道上 —— " +
        "界面上任何一句话都能指回它是从哪来的",
    );

    const tools = timeline.filter((e) => e.kind === "TOOL_ACTIVITY");
    const withInput = tools.filter((t) => t.input !== undefined).length;
    const withResult = tools.filter((t) => t.result !== undefined).length;
    fact("工具活动", `${tools.length} 条，有入参 ${withInput}，有结果 ${withResult}`);
    verdict(
      tools.length > 0 && withInput === tools.length && withResult === tools.length,
      "合并两条轨道之后，每一次工具调用都有入参与结果原文",
    );

    /**
     * 决 5 的机械记录：**事件流单独给不出工具入参**。
     *
     * 【定】这是一条**事实**不是判据 —— 将来真给 `ActionProposed` 加上入参，
     * 这行数字会变，而那时该做的是更新这条记录，不是绕过它。
     * （阶段 3.5 的教训：一条不准的 `kills` 比没有更糟。）
     */
    const eventsOnly = projectTimeline({ entries: [], events });
    const eoTools = eventsOnly.filter((e) => e.kind === "TOOL_ACTIVITY");
    fact(
      "只喂事件流时的工具入参",
      `${eoTools.length} 条工具活动，有入参 ${eoTools.filter((t) => (t as { input?: unknown }).input !== undefined).length} 条`,
    );
    const transcriptOnly = projectTurns({ entries, events: [] });
    fact("只喂 transcript 时的逐轮解剖", `${transcriptOnly.length} 轮`);
    console.log(
      "   → 两条轨道各缺一半，能把它们对齐的只有 D-2 那条统一序列（阶段 2 的开工前置，\n" +
        "     当时写的理由是「§23.2 的 Layer 2 投影游标没法收拾」—— 这里就是那个投影）。\n",
    );

    const snapshot = detail["snapshot"] as { budgetUsage: Record<string, number> };
    const inspected = await host.inspectFor(runId);
    verdict(
      JSON.stringify(snapshot.budgetUsage) === JSON.stringify(inspected?.budgetUsage),
      "界面拿到的预算数字与 `runtime.inspect()` **逐字一致** —— 服务不重算（不得绕过 #6）",
    );

    const axes = detail["budgetAxes"] as Array<{ axis: string; used: number; limit?: number }>;
    const inputAxis = axes.find((a) => a.axis === "inputTokens");
    fact("八条轴", axes.map((a) => `${a.axis}=${a.used}/${a.limit ?? "—"}`).join(" "));
    verdict(
      axes.length === 8 && inputAxis?.used === snapshot.budgetUsage["billedInputTokens"],
      "八条轴走 Runtime 的 readBudgetAxes：inputTokens 读的是 **billed**，不是 inputTokens —— " +
        "自己拼这张表的人一定会拼错这一行，而错了不会有任何征兆",
    );

    const turns = detail["turns"] as Array<{ turn: number; transition?: string; frame?: unknown }>;
    fact("逐轮解剖", `${turns.length} 轮，迁移：${turns.map((t) => t.transition ?? "—").join(" → ")}`);
    verdict(
      turns.length >= 3 && turns.every((t) => t.frame !== undefined),
      "每一轮都能读出帧构成与具名迁移（循环纪律第 2 条在界面上的落点）",
    );

    // ══════════════════════════════════════════════ E. 本地通信边界
    section("E. §22.6 本地通信边界 ＋ 凭证不外泄");

    const noToken = await call(svc, "/api/state", { token: null });
    const badToken = await call(svc, "/api/state", { token: "deadbeef" });
    const crossOrigin = await call(svc, "/api/state", { origin: "http://evil.example" });
    // Host 那条必须走裸 socket —— 见 rawRequest 的文件头注释（fetch 会丢掉它）。
    const badHost = await rawRequest(svc.port, "evil.example", TOKEN);
    const goodHost = await rawRequest(svc.port, `127.0.0.1:${svc.port}`, TOKEN);
    fact(
      "四道闸门",
      `无 token ${noToken.status} / 错 token ${badToken.status} / 跨 Origin ${crossOrigin.status} / 非 loopback Host ${badHost}`,
    );
    fact("同一条裸 socket 路径上的正常请求", `Host 正确时 ${goodHost}`);
    verdict(
      noToken.status === 401 &&
        badToken.status === 401 &&
        crossOrigin.status === 403 &&
        badHost === 403 &&
        // 【定】配一条「正确的 Host 必须 200」。少了它，一个拒绝一切的服务
        // 与一个正确的服务在上面那条判据下**不可区分** —— 阶段 3.5 的沙箱
        // 就是这么一度把 workspace 内的写也拒了而判据全绿。
        goodHost === 200,
      "无 / 错 Token → 401；跨 Origin → 403；非 loopback Host → 403（后者挡的是 DNS rebinding，只查 Origin 挡不住）",
    );

    /**
     * 凭证扫描。
     *
     * 【定】拿**真实 .env 里的那把 key** 去扫，不是拿一个自造的哨兵。
     * 自造哨兵只能证明「我没有把这个哨兵写进响应」——
     * 而真正的风险是 `RunSpec` / `profile` / 错误信息里**顺带**带出了真凭证，
     * 那把 key 只有一份，就在 compose 里。
     */
    loadEnv();
    const secrets = [process.env["dashscope_api_key"], process.env["deepseek_api_key"]].filter(
      (s): s is string => typeof s === "string" && s.length >= 12,
    );
    const bodies = [
      (await call(svc, "/api/state")).raw,
      (await call(svc, `/api/runs/${runId}`)).raw,
      (await call(svc, `/api/runs/${runId}/trace`)).raw,
    ];
    const leaked = secrets.filter((s) => bodies.some((b) => b.includes(s)));
    fact("扫描的响应体", `${bodies.length} 个，共 ${bodies.reduce((n, b) => n + b.length, 0)} 字节`);
    fact("参与扫描的真实凭证", secrets.length > 0 ? `${secrets.length} 把（长度 ${secrets.map((s) => s.length).join("/")}）` : "0 —— .env 里没有配，这条判据这次是弱的");
    verdict(
      leaked.length === 0,
      secrets.length > 0
        ? "所有 API 响应体里都不含 .env 里的真实凭证（§22.3）"
        : "响应体里没有凭证 —— 但 .env 没配 key，这次扫的是空集合，判据强度不足",
    );

    // ══════════════════════════════════════════════ F. SSE 重连游标
    section("F. SSE 重连游标：不重不漏（§5.4）");

    const all = await readSse(svc, runId, 0);
    const mid = all[Math.floor(all.length / 2)] ?? 0;
    const tail = await readSse(svc, runId, mid);
    const expected = all.filter((s) => s > mid);
    fact("since=0 收到", `${all.length} 条，序号 ${all[0]}…${all[all.length - 1]}`);
    fact("since=" + mid + " 收到", `${tail.length} 条`);
    verdict(
      all.length > 0 && JSON.stringify(tail) === JSON.stringify(expected),
      "带 `since` 重连收到的事件集合，与不断开时该收到的那一段**逐条相同** —— 不重不漏",
    );
    verdict(
      tail.every((s) => s > mid),
      "重连游标是 transcript sequence（D-2 那条统一序列）—— 一个数字同时定位两条轨道",
    );
  } finally {
    await svc.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

void runVerify(main);
