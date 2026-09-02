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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CollectingTraceSink,
  DEFAULT_BUDGETS,
  asId,
  type ModelInvocationObserver,
  type ModelInvocationResult,
  type ModelPort,
  type ModelRequest,
  type ModelStreamEvent,
  type RunEvent,
  type RunId,
  type RunSpec,
  type ToolSnapshot,
  type TranscriptEntry,
} from "@workagent/harness-runtime";
import { compose, DEFAULT_TOOLS, REPO_ROOT, loadEnv, type Composed } from "../compose.js";
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

/** 只给 Trace 隔离验收：同时产生请求事实、Provider metadata/event 与规范化结果。 */
class AuditedFixtureModelPort implements ModelPort {
  constructor(private readonly providerCanary: string) {}

  async *invoke(
    _request: ModelRequest,
    _signal: AbortSignal,
    observer: ModelInvocationObserver,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult> {
    observer.responseMetadata({ status: 200, requestId: "req-ui-trace-isolation" });
    observer.providerEvent({ type: "message_start", providerCanary: this.providerCanary });
    yield { type: "text_delta", text: "什么都不做。" };
    return {
      content: [{ type: "text", text: "什么都不做。" }],
      toolCalls: [],
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        billedInputTokens: 100,
      },
      interrupted: false,
    };
  }

  async countTokens(_request: ModelRequest): Promise<number | undefined> {
    return 100;
  }
}

async function drainEventTypes(
  composed: Composed,
  spec: RunSpec,
): Promise<{ runId: string; types: RunEvent["type"][] }> {
  const events: RunEvent[] = [];
  const gen = composed.runtime.start(spec);
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return {
    runId: String(events.find((event) => event.type === "RunStarted")?.runId ?? ""),
    types: events.map((event) => event.type),
  };
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
  /** D4c 段要按它查逐 Run 提升状态。`UiPending` 一直带着它。 */
  runId: string;
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

  const inj13 = injectionTest(
    "13",
    "apps/workagent-ui/public/__boundary_canary4.css",
    "/* 判别力实测的临时文件，写完立刻删。 */\nmain { height: calc(100vh - 45px); }\n",
  );
  fact("注入后第 13 条命中", inj13.hit ?? "（没命中 —— 这条 grep 没有判别力）");
  verdict(
    inj13.hit !== undefined,
    "注入一句「视口减写死的顶栏高度」，第 13 条当场翻红 —— " +
      "那个常数只在顶栏恰好一行时成立，而顶栏一换行（接一个 MCP 服务器就会）" +
      "整页会多出第二条滚动条，且 CSS 里没有任何东西会报错",
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
    storageOverride: { dbPath: ":memory:", traceDir },
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

    /**
     * ── ADR-0012：这一段人是**亲手点的**，所以必须记 `HUMAN` ────────────────
     *
     * 【定】它与 D4 那条（AUTO 档必须记 `AUTO`）是**一对**，缺任何一半都没有
     * 判别力：只验 AUTO 那条的话，一个恒填 `"AUTO"` 的实现照样全绿；
     * 只验 HUMAN 那条的话，一个恒填 `"HUMAN"` 的实现照样全绿。
     * 而恒填 `"HUMAN"` 正是这条特性最容易被写出来的错 ——
     * 它把「谁批的」这个新字段变回一句永远为真的客套话。
     */
    const humanApprovals = (
      (detail["timeline"] as Array<{ kind: string; decidedBy?: string }> | undefined) ?? []
    ).filter((e) => e.kind === "APPROVAL");
    fact(
      "人亲手点的那次，decidedBy",
      humanApprovals.map((a) => a.decidedBy ?? "(缺)").join(",") || "（没有审批条目）",
    );
    verdict(
      humanApprovals.length > 0 && humanApprovals.every((a) => a.decidedBy === "HUMAN"),
      "浏览器上点「批准」记的是 decidedBy=HUMAN —— 与 D4 段的 AUTO 构成**一对**：" +
        "少任何一半，一个恒填某个值的实现都能全绿",
    );

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
      storageOverride: { dbPath: ":memory:", traceDir: join(tmp, "runs2") },
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

      /**
       * ══════════════════════════════════════════════════════════════════
       * 【定】**跑动中 `liveInThisProcess` 必须为 `true`** —— 这条是配对判据。
       *
       * 本段与下面两处只验 `false`（取消之后、resume 结束之后、对历史 Run
       * 取消之后）。**一个恒返回 false 的实现能让那些全绿。**
       *
       * 它不是补形式：`segmentActive` 此前是一次「名字换了、极性没换」的
       * 改名（六处读写里五处保持旧 `done` 极性），而 163 条判据没有一条
       * 会响 —— 因为极性只在「跑着的时候」才看得出来，而当时没人验那一侧。
       * ══════════════════════════════════════════════════════════════════
       */
      const midFlight = await call(svc2, `/api/runs/${rid2}`);
      fact("停在审批上时 liveInThisProcess", String(midFlight.body["liveInThisProcess"]));
      verdict(
        midFlight.body["liveInThisProcess"] === true,
        "**跑动中** liveInThisProcess 为 true —— 与「跑完 / 取消之后为 false」" +
          "配成一对；少了这一半，一个恒 false 的实现照样全绿",
      );

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
      storageOverride: { dbPath: ":memory:", traceDir: join(tmp, "runs-auto") },
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

    // ══════════════════════ D4. AUTO 档（ADR-0012）
    section("D4. AUTO 档：EXECUTE 也不停下来问，且「谁批的」事后可区分");
    console.log(
      "   D3 验的是**默认档位**覆盖到的那一类（workspace 内的可逆写）。EXECUTE 与\n" +
        "   IRREVERSIBLE 不在它的射程内 —— 而实测里被问十几次的恰恰就是这两类\n" +
        "   （一次「下载网页图片打包成 zip」的真实任务，10 条 shell 命令**每条都含\n" +
        "   元字符**，于是 10 次审批）。AUTO 档就是为这个加的。\n" +
        "\n" +
        "   【定】这一段必须**成对**：只验「没弹卡片」的话，一个「Run 根本没跑到\n" +
        "   那一步」的实现照样全绿 —— 那正是 D3 上一版栽的跤（空数组的 every()\n" +
        "   恒真）。所以配一条「那个 IRREVERSIBLE 的动作真的执行了」。\n",
    );

    const svcAutoMode = await startService({
      workspaceRoot,
      storageOverride: { dbPath: ":memory:", traceDir: join(tmp, "runs-automode") },
      endpoint: "bailian",
      token: TOKEN,
      // 【定】服务以**默认档**起，档位靠 HTTP 拨过去 —— 这样测到的是
      // 「运行中随时切」那条链路（路由 → RunHost → decider 的读函数），
      // 而不只是「启动参数传对了」。少了这一跳，界面上那个开关可以是死的。
      composeOverrides: {
        modelPortOverride: new ScriptedModelPort([
          {
            text: "追加一条日志",
            toolCalls: [
              { toolCallId: "a1", name: "append_log", input: { path: "auto-mode.log", line: "x" } },
            ],
          },
          { text: "好了。", toolCalls: [] },
        ]),
        tools: toolsFor(["append_log"]),
      },
    });
    try {
      const modeResp = await call(svcAutoMode, "/api/approval-mode", {
        method: "POST",
        body: { mode: "auto" },
      });
      const st0 = await call(svcAutoMode, "/api/state");
      const svcInfo = st0.body["service"] as Record<string, unknown>;
      fact("POST /api/approval-mode", `${modeResp.status} ${JSON.stringify(modeResp.body)}`);
      fact("state 里的 approvalModeId", String(svcInfo["approvalModeId"]));

      const started = await call(svcAutoMode, "/api/runs", { method: "POST", body: { task: "AUTO 档" } });
      const rid = String(started.body["runId"] ?? "");
      let sawPending = 0;
      const done = await waitFor(async () => {
        const s0 = await call(svcAutoMode, "/api/state");
        sawPending += ((s0.body["pending"] as unknown[]) ?? []).length;
        const d = await call(svcAutoMode, `/api/runs/${rid}`);
        const st = String(d.body["status"] ?? "");
        return st === "COMPLETED" || st === "FAILED" ? d.body : undefined;
      }, 6000);
      const timeline =
        (done?.["timeline"] as Array<{ kind: string; approved?: boolean; decidedBy?: string }> | undefined) ?? [];
      const approvals = timeline.filter((e) => e.kind === "APPROVAL");
      // 【定】配对项：那条 IRREVERSIBLE 的动作**真的执行了**。
      // 少了它，「Run 挂在第一步」与「AUTO 档放行了」不可区分。
      const logWritten = existsSync(join(workspaceRoot, "auto-mode.log"));
      fact("轮询期间出现过的等人卡片", sawPending);
      fact("审批事件", `${approvals.length} 条，decidedBy=${approvals.map((a) => a.decidedBy).join(",")}`);
      fact("append_log 的产物落盘", logWritten ? "是" : "否 ← Run 没跑到那一步");

      verdict(
        String(svcInfo["approvalModeId"]) === "AUTO" && modeResp.status === 200,
        "档位经 HTTP 拨到 AUTO 之后，/api/state 报的就是 AUTO —— 界面读的是这个机器字段，不是那句人话",
      );
      verdict(
        !!done && sawPending === 0 && logWritten,
        "AUTO 档下 IRREVERSIBLE 的 append_log **一次都没停下来问**，而且那个动作真的执行了 —— " +
          "两条缺一不可：只验前者的话，一个卡在第一步的 Run 照样全绿",
      );
      /**
       * 【定】ADR-0012 的核心判据：**AUTO 批准与人工批准事后可区分**。
       *
       * 在此之前 `--yes-all` 的无条件批准与一个人亲手敲 y，在
       * `ApprovalDecided` 上一个字都不差（都是不带 reason 的 `{approved:true}`）。
       * 这一条钉住的就是那件事：AUTO 档留下的必须是 `AUTO`，
       * 而 D / D2 段里人点按钮留下的必须是 `HUMAN`（下面 D5 验另一半）。
       */
      verdict(
        approvals.length > 0 && approvals.every((a) => a.decidedBy === "AUTO"),
        "自动放行在事实表上记 decidedBy=AUTO —— 一条自动跑完的 Run 与一条被逐步审视过的 Run 事后可区分，" +
          "而这正是加 AUTO 档必须同时付的那笔账",
      );
    } finally {
      await svcAutoMode.close();
    }

    // ══════════ D4b. AUTO 档下 ask_user 不停下来，request_handoff 照样等人
    section("D4b. AUTO 档下 ask_user 不问，而 request_handoff **仍然**等人");
    console.log(
      "   ADR-0008 那张对照表的直接后果，也是二次复核补上的一条：上一版实现了这个\n" +
        "   行为、写进了交付说明，**却一条判据都没有**。而它恰恰是最容易被下一个人\n" +
        "   「统一」掉的地方 —— 两者表面上都是「停下来等人」。\n" +
        "\n" +
        "     ask_user        「你来定」→ 没人回答**不是**失败 → AUTO 下立刻 NO_ANSWER\n" +
        "     request_handoff 「你去做」→ 没人接管**就是**失败 → AUTO 下**照样等人**\n" +
        "\n" +
        "   【定】判据必须**成对**：只验前者的话，一个把两条通道都自动化掉的实现\n" +
        "   照样全绿，而那正是 ADR-0008 要防的那次错误合并。\n",
    );

    const svcAsk = await startService({
      workspaceRoot,
      storageOverride: { dbPath: ":memory:", traceDir: join(tmp, "runs-ask") },
      endpoint: "bailian",
      token: TOKEN,
      approvalMode: "AUTO",
      composeOverrides: {
        modelPortOverride: new ScriptedModelPort([
          {
            text: "我拿不准，问一下",
            toolCalls: [
              {
                toolCallId: "q1",
                name: "ask_user",
                /**
                 * 【定】`options` 是**换行分隔的字符串**，不是数组
                 * （`JsonSchemaProperty` 只支持标量，见 ask-user.ts 那段【定】）。
                 *
                 * ⚠️ 我第一版在这里传了数组，于是 `validateAndNormalize` 丢掉它、
                 * `executeAskUser` 在 options 解析出 0 个候选时就报错返回 ——
                 * **根本没走到 QuestionChannel**。那时把 AUTO 那一支摘掉做注入实测，
                 * 这条判据照样是绿的：夹具跨不过出事的那一跳，
                 * 与 `read_blob.line_offset` 那次一字不差。
                 */
                input: { question: "images/ 放什么？", options: "只放内容图\n全部图片" },
              },
            ],
          },
          {
            text: "那我请你去做一件我做不了的事",
            toolCalls: [
              {
                toolCallId: "h1",
                name: "request_handoff",
                input: {
                  instructions: "去后台把合同号抄过来",
                  expected_completion: "workspace 下出现 contract-id.txt",
                },
              },
            ],
          },
          { text: "好了。", toolCalls: [] },
        ]),
        tools: toolsFor(["ask_user", "request_handoff"]),
      },
    });
    try {
      await call(svcAsk, "/api/runs", { method: "POST", body: { task: "AUTO 下的两条通道" } });
      // AUTO 档下 ask_user 不该弹卡片，而 handoff 该弹 —— 等到 handoff 那张就说明
      // 前面那次提问确实是自己走掉的（否则会先卡在 QUESTION 上等人）。
      const pend = await nextPending(svcAsk, "HANDOFF");
      const seenKinds = svcAsk.host.pending().map((x) => x.kind);
      fact("等到的第一张卡片", pend ? pend.kind : "（没等到）");
      fact("此刻还在等的", seenKinds.join(",") || "（无）");
      verdict(
        !!pend,
        "AUTO 档下 ask_user **没有**停下来（否则会先卡在 QUESTION 上），" +
          "Run 直接走到了下一轮 —— 没人回答不是失败，模型自己定（阶段 3.5 决 3 的正常降级路径）",
      );
      /**
       * 【定】配对的那一半：`request_handoff` 在 AUTO 档下**仍然**等人。
       * 少了它，一个「AUTO 就把三条通道全自动化」的实现照样让上一条绿，
       * 而那会让「去登录一下」这种 Atlas 真做不了的事被静默判成"没人 → 失败"。
       */
      verdict(
        pend?.kind === "HANDOFF" && !!pend.handoff?.expectedCompletion,
        "而 request_handoff **照样**停下来等人，并带着可观察的完成判据 —— " +
          "自动化的是「要不要问你」，不是「要不要有人去做那件事」（ADR-0008）",
      );
      if (pend) {
        await call(svcAsk, `/api/pending/${pend.pendingId}`, {
          method: "POST",
          body: { kind: "HANDOFF", note: "做完了" },
        });
      }
    } finally {
      await svcAsk.close();
    }

    // ══════════ D4c. 失败的请求不得留下安全状态变化（二次评审 P1-2 / P2-3）
    section("D4c. 失败的请求不得改变审批状态");
    console.log(
      "   两条同源的原子性缺陷，都是「一个失败的请求改变了别人的安全边界」：\n" +
        "\n" +
        "     P1-2  POST /api/runs 先 setApprovalMode 再 startRun，而 startRun 会在\n" +
        "           已有前台 Run 时抛 —— Run B 启动失败，**Run A 静默变成 AUTO**；\n" +
        "     P2-3  按 pendingId 找到任意 kind 就 elevate，之后才校验 kind ——\n" +
        "           向 HANDOFF 卡片发伪造的 APPROVAL 拿到 409，**提升已经落下了**。\n" +
        "\n" +
        "   与「应答一个已经不在等的请求返回 409 而不是 200」是同一条纪律。\n",
    );

    const svcAtomic = await startService({
      workspaceRoot,
      storageOverride: { dbPath: ":memory:", traceDir: join(tmp, "runs-atomic") },
      endpoint: "bailian",
      token: TOKEN,
      composeOverrides: {
        modelPortOverride: new ScriptedModelPort([
          {
            text: "问一句",
            toolCalls: [
              {
                toolCallId: "h9",
                name: "request_handoff",
                input: { instructions: "去做一件事", expected_completion: "出现 x.txt" },
              },
            ],
          },
          { text: "好了。", toolCalls: [] },
        ]),
        tools: toolsFor(["request_handoff"]),
      },
    });
    try {
      await call(svcAtomic, "/api/runs", { method: "POST", body: { task: "占住前台" } });
      const held = await nextPending(svcAtomic, "HANDOFF");

      // ── P1-2：前台被占住时提交第二个 Run 并选 AUTO
      const before = String(
        ((await call(svcAtomic, "/api/state")).body["service"] as Record<string, unknown>)[
          "approvalModeId"
        ],
      );
      const rejected = await call(svcAtomic, "/api/runs", {
        method: "POST",
        body: { task: "第二个 Run", approvalMode: "auto" },
      });
      const after = String(
        ((await call(svcAtomic, "/api/state")).body["service"] as Record<string, unknown>)[
          "approvalModeId"
        ],
      );
      fact("前台被占住时提交第二个 Run", `HTTP ${rejected.status}`);
      fact("档位（提交前 → 提交后）", `${before} → ${after}`);
      verdict(
        rejected.status !== 200 && after === before && before !== "AUTO",
        "启动失败时**全局档位不变** —— 一个失败的请求不得把正在跑的那个 Run 切成 AUTO",
      );

      // ── P2-3：向 HANDOFF 卡片发伪造的 APPROVAL
      const fake = held
        ? await call(svcAtomic, `/api/pending/${held.pendingId}`, {
            method: "POST",
            body: { kind: "APPROVAL", approved: true, alwaysForRun: true },
          })
        : undefined;
      const elevated = held ? svcAtomic.host.isRunElevated(held.runId) : true;
      fact("向 HANDOFF 卡片发伪造 APPROVAL", `HTTP ${fake?.status}`);
      fact("那个 Run 被提升了吗", elevated ? "是 ← 失败请求留下了状态" : "否");
      /**
       * ── ⚠️ 【定】这条判据测的是**合取**，不是某一道守卫（M4 那次的形态）──────
       *
       * 实测过三种注入，结果必须原样记在这里，否则下一个人会以为它能单独
       * 打死其中一道：
       *
       *   只摘 kind 校验          → **不红**（被回滚兜住）
       *   只摘失败回滚            → **不红**（被 kind 校验挡住）
       *   两道同时摘             → 翻红 ✅
       *
       * 【定】这**不是冗余，是纵深** —— 两道防的是不同的事：
       *   kind 校验：对着 HANDOFF / QUESTION 卡片发伪造的 APPROVAL；
       *   失败回滚：卡片在 elevate 与 answer 之间被 abort 清掉（Run 被取消）。
       * 第二种 kind 校验挡不住，第一种回滚兜得住 —— 它们只是在
       * 「最终有没有留下提升」这一个可观察量上重合。
       *
       * 所以措辞只声称它测得到的那件事：**失败的应答不留下提升**。
       * 一条不准的 kills 比没有更糟（阶段 3.5 那次的原话）。
       */
      verdict(
        fake?.status === 409 && !elevated,
        "kind 不匹配的应答返回 409，且**没有留下逐 Run 提升** —— 注意这条测的是" +
          "「最终不留状态」这个合取：单摘 kind 校验或单摘失败回滚都不会红，两道同摘才红",
      );

      // ── P1-3：切到 CONFIRM 必须收回已有的提升
      if (held) svcAtomic.host.elevateRun(held.runId);
      const beforeRevoke = svcAtomic.host.isRunElevated(held?.runId ?? "");
      await call(svcAtomic, "/api/approval-mode", { method: "POST", body: { mode: "confirm" } });
      const afterRevoke = svcAtomic.host.isRunElevated(held?.runId ?? "");
      fact("切到 CONFIRM 前后的提升状态", `${beforeRevoke} → ${afterRevoke}`);
      verdict(
        beforeRevoke && !afterRevoke,
        "切到 CONFIRM **收回**逐 Run 提升 —— 判别式是 `AUTO || isElevated`，不收的话" +
          "界面回一句「已切到 CONFIRM」而这个 Run 继续自动放行（安全状态与显示相反）",
      );

      if (held) {
        await call(svcAtomic, `/api/pending/${held.pendingId}`, {
          method: "POST",
          body: { kind: "HANDOFF", note: "收尾" },
        });
      }
    } finally {
      await svcAtomic.close();
    }

    // ══════════════ D5. 「批准，且本次 Run 不再问」（ADR-0012）
    section("D5. 「本次 Run 不再问」：第一次仍是人批的，之后的才是自动");
    console.log(
      "   它是用户那句「太麻烦了」最直接的落点：跑到一半才发现要点十几次，\n" +
        "   而此时改全局档位太重（下一个 Run 也跟着变）。\n" +
        "\n" +
        "   【定】判据的重点不是「后面不问了」，是**第一次与后面留下的事实不同**：\n" +
        "   人只看过第一条命令，后面那些他没看过。把两者都记成 HUMAN，\n" +
        "   等于替他宣称「我逐条批准过全部」—— 而那是一句他没说过的话。\n",
    );

    const svcAlways = await startService({
      workspaceRoot,
      storageOverride: { dbPath: ":memory:", traceDir: join(tmp, "runs-always") },
      endpoint: "bailian",
      token: TOKEN,
      composeOverrides: {
        modelPortOverride: new ScriptedModelPort([
          {
            text: "第一条",
            toolCalls: [
              { toolCallId: "l1", name: "append_log", input: { path: "always.log", line: "one" } },
            ],
          },
          {
            // 【定】第二条必须是**另一次审批**，不能只发一条。
            // 只发一条的话，「不再问生效了」与「Run 结束了」不可区分。
            text: "第二条",
            toolCalls: [
              { toolCallId: "l2", name: "append_log", input: { path: "always.log", line: "two" } },
            ],
          },
          { text: "好了。", toolCalls: [] },
        ]),
        tools: toolsFor(["append_log"]),
      },
    });
    try {
      const st = await call(svcAlways, "/api/runs", { method: "POST", body: { task: "不再问" } });
      const rid = String(st.body["runId"] ?? "");
      const first = await nextPending(svcAlways, "APPROVAL");
      fact("第一次审批弹出来了吗", first ? `是（${first.approval?.toolName}）` : "否");
      const ans = first
        ? await call(svcAlways, `/api/pending/${first.pendingId}`, {
            method: "POST",
            // 这就是界面上那颗「批准，本次 Run 不再问」按钮发的东西。
            body: { kind: "APPROVAL", approved: true, alwaysForRun: true },
          })
        : undefined;

      let sawSecondPending = 0;
      const done = await waitFor(async () => {
        const s0 = await call(svcAlways, "/api/state");
        sawSecondPending += ((s0.body["pending"] as unknown[]) ?? []).length;
        const d = await call(svcAlways, `/api/runs/${rid}`);
        const s1 = String(d.body["status"] ?? "");
        return s1 === "COMPLETED" || s1 === "FAILED" ? d.body : undefined;
      }, 8000);
      const tl =
        (done?.["timeline"] as Array<{ kind: string; decidedBy?: string }> | undefined) ?? [];
      const apps = tl.filter((e) => e.kind === "APPROVAL");
      const decided = apps.map((a) => a.decidedBy ?? "(缺)");
      fact("应答第一次", `${ans?.status}`);
      fact("此后还弹过几张卡片", sawSecondPending);
      fact("两次审批的 decidedBy", decided.join(" → "));

      verdict(
        !!done && !!first && sawSecondPending === 0 && apps.length >= 2,
        "第一次停下来问、人点了「本次 Run 不再问」之后，**第二次没有再弹**，而两次审批都发生了 —— " +
          "「至少两条」这一项不能省：只发一条的话，「不再问生效了」与「Run 结束了」不可区分",
      );
      verdict(
        decided[0] === "HUMAN" && decided.slice(1).every((d) => d === "AUTO"),
        "第一次记 HUMAN、之后记 AUTO —— 人只看过第一条命令，把后面那些也记成 HUMAN " +
          "等于替他宣称「我逐条批准过全部」",
      );
    } finally {
      await svcAlways.close();
    }

    // ══════════════════════════ G. 失败的 resume 不留幻影、不锁死服务
    section("G. 失败的 resume：不留「在跑」幻影，不锁死单前台闸门");
    console.log(
      "   三份评审各自独立报的那一条，我实测复现过完整后果：\n" +
        "   对终态 Run 点一次 resume → 记录卡在 done:false → 列表显示「在跑」→\n" +
        "   若它恰好是 currentRunId，**后续任何 start/resume 全部 500，只能重启进程**；\n" +
        "   而那句报错还在建议「或在界面上取消它」—— 取消并不复位，照做仍然是死的。\n",
    );

    const requestOnlyCanary = "ui-request-body-only-canary";
    const providerOnlyCanary = "ui-provider-event-only-canary";
    const traceIsolationTools = toolsFor(["now"]).map((tool) => ({
      ...tool,
      definition: {
        ...tool.definition,
        description: `${tool.definition.description} ${requestOnlyCanary}`,
      },
    }));
    const svcG = await startService({
      workspaceRoot,
      storageOverride: { dbPath: ":memory:", traceDir: join(tmp, "runs-g") },
      endpoint: "bailian",
      token: TOKEN,
      composeOverrides: {
        modelPortOverride: new AuditedFixtureModelPort(providerOnlyCanary),
        tools: traceIsolationTools,
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
      const traceResponse = await call(svcG, `/api/runs/${gid}/trace`);
      const traceLines = traceResponse.body["lines"] as
        | Array<Record<string, unknown>>
        | undefined;
      const kinds = (traceLines ?? []).map((l) => String(l["kind"]));
      const header = (traceLines ?? []).find((l) => l["kind"] === "header");
      fact("Web 段的 trace 行构成", `header ${kinds.filter((k) => k === "header").length} / event ${kinds.filter((k) => k === "event").length} / footer ${kinds.filter((k) => k === "footer").length}`);
      fact("header 的 provenance", header ? `commit ${String(header["commit"]).slice(0, 10)} · gitDirty ${header["gitDirty"]} · entry ${header["entry"]}` : "（缺）");
      verdict(
        kinds.includes("header") &&
          kinds.includes("footer") &&
          kinds.every((kind) => kind === "header" || kind === "event" || kind === "footer") &&
          !!header?.["commit"],
        "Web 入口跑的段也写 header / event / footer 三种行，且带 commit ＋ gitDirty —— " +
          "「Trace 按段分组、每段可审计」对 Web 段成立；模型调用 sidecar 没有混成未知行",
      );

      /**
       * 模型审计的隔离必须走**真实文件与 HTTP**，不能只查 CollectingTraceSink。
       * 两个 canary 先在 sidecar 里验明正身，再去 `/trace` 查不在场；否则一个从未
       * 被写出的 canary 天生就能让“没有泄漏”永远绿。
       *
       * EVAL 走同一 Runtime、同一协议、同一模型脚本，只关闭模型审计，正好是
       * 事件行数基线。只比较 type 序列，不比较随机 id / 时间戳。
       * 判别力实测：临时把 provider canary 放进 ModelStreamDelta 后，本判据单独翻红。
       */
      const auditDir = join(workspaceRoot, ".workagent", "model-invocations", gid);
      const auditRaw = readdirSync(auditDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFileSync(join(auditDir, name), "utf8"))
        .join("\n");
      const baselineTrace = new CollectingTraceSink();
      const baseline = compose({
        workspaceRoot,
        approvalDecider: async () => ({ approved: true }),
        trace: baselineTrace,
        endpoint: "bailian",
        modelPortOverride: new AuditedFixtureModelPort(providerOnlyCanary),
        tools: traceIsolationTools,
        dbPath: ":memory:",
      });
      const baselineRun = await drainEventTypes(
        baseline,
        baseline.makeRunSpec("G 段夹具", "EVAL"),
      );
      baseline.db.close();
      const httpEventTypes = (traceLines ?? [])
        .filter((line) => line["kind"] === "event")
        .map((line) => String(line["type"]));
      const headerCount = kinds.filter((kind) => kind === "header").length;
      const footerCount = kinds.filter((kind) => kind === "footer").length;
      fact(
        "模型审计 Trace 隔离",
        `sidecar canary=${auditRaw.includes(requestOnlyCanary) && auditRaw.includes(providerOnlyCanary)} · ` +
          `HTTP canary=${traceResponse.raw.includes(requestOnlyCanary) || traceResponse.raw.includes(providerOnlyCanary)} · ` +
          `event ${httpEventTypes.length}/${baselineRun.types.length}`,
      );
      verdict(
        auditRaw.includes(requestOnlyCanary) &&
          auditRaw.includes(providerOnlyCanary) &&
          !traceResponse.raw.includes(requestOnlyCanary) &&
          !traceResponse.raw.includes(providerOnlyCanary) &&
          JSON.stringify(httpEventTypes) === JSON.stringify(baselineRun.types) &&
          headerCount === 1 &&
          footerCount === 1 &&
          (traceLines ?? []).length === baselineRun.types.length + 2 &&
          !httpEventTypes.some((type) => type.startsWith("ModelInvocationAudit")) &&
          !existsSync(join(workspaceRoot, ".workagent", "model-invocations", baselineRun.runId)),
        "Web 默认审计只进入 sidecar；真实 /trace 无请求/Provider canary，事件序列与 EVAL 无审计基线等长",
      );

      /**
       * ══════════════════════════════════════════════════════════════
       * 运行身份：**三条轨道必须说同一件事**（评审 codex P2-3）。
       *
       * 实测过的分叉（Run `run_75f0d6afafa6`，真实端点、Web 入口）：
       *
       *   trace header   entry="web"     task="(未知)"     ← task 错
       *   RunSpec        origin.kind="CLI"                 ← 入口错
       *   SQLite runs    task=真实任务                      ← 对
       *
       * 两个成因各自独立：`makeRunSpec()` 把 `kind:"CLI"` 写死；
       * `taskCache.set()` 排在 `await drive(gen)` 之后，而 header 是
       * **第一个事件**到达时生成的 —— 那时 drive 还没返回。
       *
       * 【定】它不影响任何执行事实，所以只能靠判据守。而它一旦退回去，
       * 影响的是 Replay、归档与**正式评测的归因**（决 4 那批数据读的就是这里），
       * 那时已经没有办法回头判断某个样本到底是从哪个入口跑的。
       * ══════════════════════════════════════════════════════════════
       */
      const detailG = await call(svcG, `/api/runs/${gid}`);
      const specOrigin = String((detailG.body["spec"] as Record<string, unknown>)?.["origin"] ?? "");
      const headerTask = String(header?.["task"] ?? "");
      const headerEntry = String(header?.["entry"] ?? "");
      fact("RunSpec.origin.kind", specOrigin || "（缺）");
      fact("trace header 的 entry / task", `${headerEntry} / ${JSON.stringify(headerTask)}`);
      fact("SQLite 里的 task", JSON.stringify(String(detailG.body["task"] ?? "")));
      const identityOk =
        specOrigin === "WEB" &&
        headerEntry === "web" &&
        headerTask === "G 段夹具" &&
        String(detailG.body["task"] ?? "") === "G 段夹具";
      verdict(
        identityOk,
        identityOk
          ? "运行身份三条轨道一致：RunSpec.origin=WEB、header.entry=web、header.task 与 SQLite 的 task 逐字相同 —— " +
              "此前 origin 写死 CLI（一个生产者、零消费者，没有东西能与它矛盾），" +
              "且 header 在 task 登记之前就生成，永远写「(未知)」"
          : `运行身份分叉：origin=${specOrigin || "(缺)"}、entry=${headerEntry || "(缺)"}、` +
              `header.task=${JSON.stringify(headerTask)}、db.task=${JSON.stringify(String(detailG.body["task"] ?? ""))}`,
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
        storageOverride: { dbPath: recoveryDb, traceDir: recoveryTrace },
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

    // ═════════════ J2. §18.3 第三维：换执行特权档 resume 必须被拒（ADR-0012）
    section("J2. 换执行特权档 resume 必须被拒（§18.3 的第三维）");
    console.log(
      "   端点、workspace 之后的第三维，守的是最硬的那件事：**那些副作用当时有没有边界**。\n" +
        "\n" +
        "   两个方向都很难看 ——\n" +
        "     冻结 UNRESTRICTED → 用 SANDBOXED 接：模型接着一个「没有沙箱」的计划往下写，\n" +
        "       命令突然开始被内核拒，而拒绝理由指向一条它读不到的规则；\n" +
        "     冻结 SANDBOXED → 用 UNRESTRICTED 接：一条**在有沙箱的前提下被批准过**的计划，\n" +
        "       后半段跑在没有沙箱的机器上 —— 人当时批准的不是这件事。\n" +
        "\n" +
        "   它同时是 `ShellEffectResolver` 那个构造期档位的正确性前提：resolver 拿的是\n" +
        "   当前进程的档位、policy 与工具拿的是冻结的那一档，这道闸门保证两者必然相等。\n",
    );
    {
      const wsP = join(tmp, "ws-priv");
      mkdirSync(wsP, { recursive: true });
      const privDb = join(tmp, "priv.db");
      // 夹具用默认档（SANDBOXED）起一个留着未配对 tool_use 的 Run。
      const runIdP = await buildRecoveryFixture(wsP, privDb);

      const resumeWith = async (privilege: "SANDBOXED" | "UNRESTRICTED"): Promise<string | undefined> => {
        const c = compose({
          workspaceRoot: wsP,
          dbPath: privDb,
          executionPrivilege: privilege,
          approvalDecider: async () => ({ approved: true }),
          trace: { emit: () => {} },
          tools: toolsFor(["append_log"]),
          modelPortOverride: new ScriptedModelPort([{ text: "收工。", toolCalls: [] }]),
        });
        let err: string | undefined;
        try {
          const g = c.runtime.resume(asId<RunId>(runIdP));
          let r = await g.next();
          while (!r.done) r = await g.next();
        } catch (e) {
          err = (e as Error).message;
        }
        c.db.close();
        return err;
      };

      const refusedPriv = await resumeWith("UNRESTRICTED");
      fact("Run 冻结的档位", "SANDBOXED（夹具用默认档起的）");
      fact("换成 UNRESTRICTED 恢复", refusedPriv ? `拒绝：${refusedPriv.split("\n")[0]}` : "**放行了 —— 闸门不存在**");
      verdict(
        refusedPriv !== undefined && refusedPriv.includes("执行特权"),
        "在 SANDBOXED 下跑出来的 Run，用 UNRESTRICTED 恢复 → **被拒绝**（§18.3 第三维）",
      );

      /**
       * 【定】配对判据。少了它，「resume 一律拒绝」也能让上面那条绿 ——
       * 这正是 J 段与阶段 3.5 沙箱那次都栽过的同一跤，本段不再栽第三次。
       */
      const allowedPriv = await resumeWith("SANDBOXED");
      fact("用同一档恢复", allowedPriv ? `**也被拒了**：${allowedPriv.split("\n")[0]}` : "放行");
      verdict(
        allowedPriv === undefined,
        "档位相同时照常放行 —— 配对判据，少了它一个「resume 一律拒绝」的实现也能让上一条绿",
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
        storageOverride: {
          dbPath: join(wsC, ".workagent", "runs.db"),
          traceDir: join(wsC, ".workagent", "runs"),
        },
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

    // ══════════════════════════════════════ L. 逐 Run 的预算覆盖走 HTTP
    section("L. 界面上填的预算真的进了 spec（且非法值不留下任何痕迹）");
    console.log(
      "   起因是实测 Run `run_6c3fec671ceb`：八条轴只有 turns 撞墙（18/20），\n" +
        "   而在此之前界面的「预算」页是纯只读投影，POST /api/runs 的请求体只有\n" +
        "   `{ task, approvalMode }` —— 能力在，入口不在。\n" +
        "\n" +
        "   ⚠️ 三条判据**成对**才有意义：少了正分支，一个「一律 400」的实现全绿；\n" +
        "   少了反分支，一个「预算字段根本没接线」的实现也全绿。\n" +
        "   `sandbox.ts` 与 J 段各记过一次同样的教训。\n",
    );
    {
      const wsB = join(tmp, "ws-budget");
      const svcB = await startService({
        workspaceRoot: wsB,
        storageOverride: {
          dbPath: join(wsB, ".workagent", "runs.db"),
          traceDir: join(wsB, ".workagent", "runs"),
        },
        endpoint: "bailian",
        token: TOKEN,
        composeOverrides: {
          // 【定】要一个**不会自己停**的脚本 —— 否则「停在第 2 轮」这件事
          // 分不清是预算拦的还是模型自己收的尾，判据要区分的两个值又相等了。
          modelPortOverride: new ScriptedModelPort(
            Array.from({ length: 12 }, (_, i) => ({
              text: `第 ${i + 1} 轮，继续。`,
              toolCalls: [{ toolCallId: `b${i}`, name: "now", input: {} }],
            })),
          ),
          tools: toolsFor(["now"]),
        },
      });
      try {
        // L1 正分支：填了就真的生效，而且真的在拦。
        const started = await call(svcB, "/api/runs", {
          method: "POST",
          body: { task: "预算覆盖验收", budgets: { turns: 2 } },
        });
        const bRunId = String(started.body["runId"] ?? "");
        await waitFor(async () => {
          const d = await call(svcB, `/api/runs/${bRunId}`);
          const s = String(d.body["status"]);
          return s === "COMPLETED" || s === "FAILED" ? true : undefined;
        });
        const detail = await call(svcB, `/api/runs/${bRunId}`);
        const axes = (detail.body["budgetAxes"] as Array<{ axis: string; used: number; limit?: number }>) ?? [];
        const turnsAxis = axes.find((a) => a.axis === "turns");
        fact("POST 带 budgets:{turns:2}", `HTTP ${started.status}`);
        fact("详情页 turns 轴", `${turnsAxis?.used} / ${turnsAxis?.limit}`);
        const l1 =
          started.status === 200 && turnsAxis?.limit === 2 && turnsAxis?.used === 2;
        verdict(
          l1,
          l1
            ? "界面填的 2 走完 HTTP → RunHost → makeRunSpec → spec.budgets，**并且真的停在第 2 轮**。" +
              "只断言 limit 的话，一个「存下来但不参与判定」的实现也会绿"
            : `没生效：HTTP ${started.status} · turns ${turnsAxis?.used}/${turnsAxis?.limit}（期望 2/2）`,
        );

        /**
         * L2 反分支：非法值 400，**且一个 Run 都没起**。
         *
         * 【定】后半句才是重点。`server.ts` 里那条 P1-2 的纪律是
         * 「失败的请求不得留下任何状态变化」—— 而 `startRun()` 第一件事就是
         * `claimForeground()`。校验排在它后面的话，一个 400 会留下一个
         * 被占住的前台槽位，之后所有 start/resume 全挂（G 段记过这个形态）。
         */
        const before = ((await call(svcB, "/api/state")).body["runs"] as unknown[]).length;
        const badCases = [
          { label: "turns: 0", body: { task: "不该起来", budgets: { turns: 0 } } },
          { label: "未知轴 foo", body: { task: "不该起来", budgets: { foo: 5 } } },
          { label: "budgets 是数组", body: { task: "不该起来", budgets: [1, 2] } },
        ];
        let allBad400 = true;
        for (const c of badCases) {
          const r = await call(svcB, "/api/runs", { method: "POST", body: c.body });
          if (r.status !== 400) allBad400 = false;
          fact(`  ${c.label}`, `HTTP ${r.status} · ${String(r.body["error"] ?? "").slice(0, 60)}`);
        }
        const after = ((await call(svcB, "/api/state")).body["runs"] as unknown[]).length;
        // 前台槽位还活着吗？——三次 400 之后必须还能正常起一个 Run。
        const stillWorks = await call(svcB, "/api/runs", {
          method: "POST",
          body: { task: "400 之后服务还活着吗", budgets: { turns: 1 } },
        });
        fact("非法请求前后的 Run 条数", `${before} → ${after}`);
        fact("三次 400 之后再起一个", `HTTP ${stillWorks.status}`);
        const l2 = allBad400 && after === before && stillWorks.status === 200;
        verdict(
          l2,
          l2
            ? "非法预算一律 400，**一个 Run 都没起、前台槽位没被占住**（P1-2：失败的请求不得留下状态变化）"
            : !allBad400
              ? "有非法值被接受了 —— 校验没接上，或者排在了 startRun 后面"
              : after !== before
                ? `一个 400 却起了 Run（${before} → ${after}）—— 校验排在 startRun 之后了`
                : "400 之后再也起不了 Run —— 前台槽位被一个失败的请求占死了",
        );

        /**
         * L3：界面上的「秒」与 `RunBudgets` 的毫秒之间那次换算。
         *
         * 【定】直接从 `app.js` 里把 `fmt` / `unfmt` 抠出来跑，不重写一份 ——
         * 重写一份测的就是这条判据自己，而不是界面上真正在跑的那两个函数。
         *
         * 要防的失败没有任何征兆：「预算」页用 `fmt` 把 600000 显示成 "600s"，
         * 用户照着在表单里填 600，如果 `unfmt` 少了 ×1000 就会得到一个
         * **600 毫秒**的墙钟预算 —— Run 立刻撞墙，而两边都不报错。
         */
        const uiSrc = readFileSync(resolve(REPO_ROOT, "apps/workagent-ui/public/app.js"), "utf8");
        const grab = (name: string): string => {
          const m = uiSrc.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
          if (!m) throw new Error(`app.js 里找不到 ${name}()`);
          return m[0];
        };
        const pair = new Function(
          `${grab("fmt")}\n${grab("unfmt")}\nreturn { fmt: fmt, unfmt: unfmt };`,
        )() as { fmt(n: number, u: string): string; unfmt(n: number, u: string): number };
        // 页面上看到什么，就往表单里填什么 —— 填回去必须还是原值。
        const shown = pair.fmt(600_000, "ms");
        const typedBack = pair.unfmt(Number(shown.replace(/[^0-9.]/g, "")), "ms");
        const shownCount = pair.fmt(40, "count");
        const typedBackCount = pair.unfmt(Number(shownCount), "count");
        fact("ms 轴：页面显示 → 填回去", `600000 → "${shown}" → ${typedBack}`);
        fact("count 轴：页面显示 → 填回去", `40 → "${shownCount}" → ${typedBackCount}`);
        const l3 = typedBack === 600_000 && typedBackCount === 40;
        verdict(
          l3,
          l3
            ? "`unfmt` 是 `fmt` 的逆：照着「预算」页上的数字填表单，拿回来的是同一个值。" +
              "少了 ×1000 的话，一个 600 秒的墙钟会变成 600 毫秒，而两边都不会报错"
            : `换算对不上：ms ${typedBack}（期望 600000）、count ${typedBackCount}（期望 40）`,
        );

        // L4：默认值从哪来 —— 界面的输入框占位值必须与真正会撞的墙同源。
        const info = (await call(svcB, "/api/state")).body["service"] as {
          budgetDefaults?: Array<{ axis: string; field: string; limit?: number }>;
        };
        const defaults = info.budgetDefaults ?? [];
        const dTurns = defaults.find((d) => d.axis === "turns");
        const dTotal = defaults.find((d) => d.axis === "totalWallClockMs");
        fact("service.budgetDefaults", `${defaults.length} 条 · turns=${dTurns?.limit}`);
        const l4 =
          defaults.length === axes.length &&
          dTurns?.limit === DEFAULT_BUDGETS.maxTurns &&
          dTurns?.field === "maxTurns" &&
          dTotal !== undefined &&
          dTotal.limit === undefined;
        verdict(
          l4,
          l4
            ? `八条轴的默认值走 Runtime 的 readBudgetLimits（与 budgetAxes 同一张表），` +
              `且「没设上限」的那条如实缺席 limit —— 不是 0，也不是 Infinity`
            : `默认值对不上：${defaults.length} 条（轴有 ${axes.length} 条）、` +
              `turns=${dTurns?.limit}（期望 ${DEFAULT_BUDGETS.maxTurns}）、` +
              `totalWallClockMs.limit=${dTotal?.limit}（期望 undefined）`,
        );
      } finally {
        await svcB.close();
      }
    }

    // ══════════════════════════════════════ M. Run 顶部结果与核心预算摘要
    section("M. Run 顶部摘要：中文解释不改写 Outcome，预算只读冻结轴");
    {
      /**
       * 与 L3 一样，直接执行 app.js 里的真实纯函数，而不是在验收里抄一份映射。
       * 两个锚点把 DOM 渲染函数排除在外，测试只需要 AXIS_LABEL 与 fmt 两个依赖。
       */
      const uiSrc = readFileSync(resolve(REPO_ROOT, "apps/workagent-ui/public/app.js"), "utf8");
      const helperStart = uiSrc.indexOf("\nfunction outcomePresentation(");
      const helperEnd = uiSrc.indexOf("\nfunction renderRunSummary(", helperStart);
      const fmtMatch = uiSrc.match(/\nfunction fmt\([^)]*\) \{[\s\S]*?\n\}/);
      if (helperStart < 0 || helperEnd <= helperStart || !fmtMatch) {
        throw new Error("app.js 里找不到顶部摘要的纯展示 helper");
      }
      const helperSrc = uiSrc.slice(helperStart, helperEnd);
      const presentation = new Function(
        "AXIS_LABEL",
        `${fmtMatch[0]}\n${helperSrc}\nreturn { outcomePresentation, coreBudgetPresentation };`,
      )({
        turns: "轮次",
        modelCalls: "模型调用",
        toolCalls: "工具调用",
        activeWallClockMs: "活跃墙钟",
      }) as {
        outcomePresentation(outcome: Record<string, unknown>): {
          title: string;
          tone: string;
          detail: string;
          note?: string;
          code: string;
        };
        coreBudgetPresentation(axes: Array<Record<string, unknown>>): Array<{
          axis: string;
          value: string;
          percent: string;
          tone: string;
        }>;
      };

      const core = presentation.coreBudgetPresentation([
        { axis: "turns", used: 20, limit: 40, unit: "count" },
        { axis: "modelCalls", used: 20, limit: 80, unit: "count" },
        { axis: "toolCalls", used: 19, limit: 100, unit: "count" },
        { axis: "activeWallClockMs", used: 397_858, limit: 600_000, unit: "ms" },
        // 核心摘要不应该因为完整八轴里还有别的项目就改变顺序或读错字段。
        { axis: "billedInputTokens", used: 651_631, limit: 1_500_000, unit: "token" },
      ]);
      const turns = core.find((m) => m.axis === "turns");
      const models = core.find((m) => m.axis === "modelCalls");
      fact("轮次摘要", `${turns?.value} · ${turns?.percent}`);
      fact("模型调用摘要", `${models?.value} · ${models?.percent}`);
      const m1 =
        core.length === 4 &&
        turns?.value === "20 / 40" &&
        turns.percent === "50%" &&
        models?.value === "20 / 80" &&
        models.percent === "25%";
      verdict(
        m1,
        m1
          ? "顶部四项从 `budgetAxes` 读取真实 used / 冻结 limit，20/40 与 20/80 的百分比正确"
          : `摘要读数错误：${JSON.stringify(core)}`,
      );

      const unset = presentation
        .coreBudgetPresentation([
          { axis: "turns", used: 1, limit: 40, unit: "count" },
          { axis: "modelCalls", used: 1, limit: 80, unit: "count" },
          { axis: "toolCalls", used: 0, limit: 100, unit: "count" },
          { axis: "activeWallClockMs", used: 12_000, unit: "ms" },
        ])
        .find((m) => m.axis === "activeWallClockMs");
      fact("未设上限", `${unset?.value} · ${unset?.percent} · ${unset?.tone}`);
      const m2 =
        unset?.value === "12s / 未设上限" && unset.percent === "未设上限" && unset.tone === "unset";
      verdict(
        m2,
        m2
          ? "limit 缺席时如实显示「未设上限」，不伪造成 0、Infinity 或满格"
          : `未设上限渲染错误：${JSON.stringify(unset)}`,
      );

      const withRecovery = presentation.outcomePresentation({
        kind: "COMPLETED_WITH_LIMITS",
        recoveryItems: [{ what: "run_shell → programs:find,head", sideEffectState: "UNKNOWN" }],
        incompleteItems: [],
      });
      const withIncomplete = presentation.outcomePresentation({
        kind: "COMPLETED_WITH_LIMITS",
        recoveryItems: [],
        incompleteItems: [{ what: "中间产物", why: "校验未通过" }],
      });
      const success = presentation.outcomePresentation({ kind: "SUCCESS", recoveryItems: [], incompleteItems: [] });
      const failed = presentation.outcomePresentation({ kind: "FAILED", recoveryItems: [], incompleteItems: [] });
      const budget = presentation.outcomePresentation({
        kind: "BUDGET_EXHAUSTED",
        recoveryItems: [],
        incompleteItems: [],
      });
      fact("带恢复项的结论", `${withRecovery.title} / ${withRecovery.code} / ${withRecovery.tone}`);
      fact("其他严重级别", `SUCCESS=${success.tone} FAILED=${failed.tone} BUDGET=${budget.tone}`);
      const m3 =
        withRecovery.title === "任务已完成，但有待确认项" &&
        withRecovery.code === "COMPLETED_WITH_LIMITS" &&
        withRecovery.tone === "warn" &&
        withRecovery.detail.includes("run_shell → programs:find,head") &&
        withRecovery.detail.includes("UNKNOWN") &&
        withRecovery.note?.includes("不表示达到轮次或模型调用上限") === true &&
        withIncomplete.title === "任务已完成，但仍有未达成项" &&
        withIncomplete.detail.includes("中间产物") &&
        success.title === "任务已完成" &&
        success.tone === "ok" &&
        failed.title === "任务执行失败" &&
        failed.tone === "bad" &&
        budget.title === "执行因预算或资源保护停止" &&
        budget.tone === "warn";
      verdict(
        m3,
        m3
          ? "中文主结论、直接原因与严重级别正确，原始 Outcome 枚举仍作为白盒锚点保留"
          : "Outcome 展示映射与约定不一致",
      );

      // 第二组故意换成互质数字：只测 20/40、20/80 的话，四个常量也能全绿。
      const shifted = presentation.coreBudgetPresentation([
        { axis: "turns", used: 7, limit: 11, unit: "count" },
        { axis: "modelCalls", used: 9, limit: 13, unit: "count" },
        { axis: "toolCalls", used: 5, limit: 17, unit: "count" },
        { axis: "activeWallClockMs", used: 19_000, limit: 23_000, unit: "ms" },
      ]);
      const shiftedTurns = shifted.find((m) => m.axis === "turns");
      const shiftedModels = shifted.find((m) => m.axis === "modelCalls");
      const m4 =
        shiftedTurns?.value === "7 / 11" &&
        shiftedTurns.percent === "64%" &&
        shiftedModels?.value === "9 / 13" &&
        shiftedModels.percent === "69%";
      verdict(
        m4,
        m4
          ? "换一组 budgetAxes，四项摘要逐项跟着变化 —— 不是为 20/40、20/80 硬编码的展示"
          : `第二组 budgetAxes 没有驱动摘要变化：${JSON.stringify(shifted)}`,
      );

      const uiHtml = readFileSync(resolve(REPO_ROOT, "apps/workagent-ui/public/index.html"), "utf8");
      const uiCss = readFileSync(resolve(REPO_ROOT, "apps/workagent-ui/public/app.css"), "utf8");
      const topbarStart = uiCss.indexOf("#topbar {");
      const topbarEnd = uiCss.indexOf("\n}", topbarStart);
      const svcStart = uiCss.indexOf(".svcinfo {");
      const svcEnd = uiCss.indexOf("\n}", svcStart);
      const topbarCss = uiCss.slice(topbarStart, topbarEnd);
      const svcCss = uiCss.slice(svcStart, svcEnd);
      const m5 =
        !uiHtml.includes('class="brand"') &&
        !uiHtml.includes("白盒界面 · Layer 1") &&
        topbarCss.includes("justify-content: flex-start") &&
        svcCss.includes("width: 100%") &&
        svcCss.includes("justify-content: flex-start");
      fact("顶栏左侧", m5 ? "品牌文案已移除，服务事实占满并左对齐" : "仍有品牌占位或对齐样式不正确");
      verdict(
        m5,
        m5
          ? "顶栏不再为品牌文案预留水平空间；端点、模型、工作空间等服务事实从左侧开始排列"
          : "顶栏仍存在品牌占位，或 svcinfo 没有占满并左对齐",
      );
    }

    // ══════════════════════════════════════ N. Trace Inspector 的只读展示投影
    section("N. Trace Inspector：逐轮聚合不改写原始 Trace");
    {
      /**
       * 与预算摘要同一条验法：直接执行浏览器真正使用的纯 helper。
       * 如果测试自己再写一份分轮/关联逻辑，两份代码一起错时仍会全绿。
       */
      const uiSrc = readFileSync(resolve(REPO_ROOT, "apps/workagent-ui/public/app.js"), "utf8");
      const helperStart = uiSrc.indexOf("\nconst TRACE_EVENT_META =");
      const helperEnd = uiSrc.indexOf("\nasync function copyTraceJson(", helperStart);
      if (helperStart < 0 || helperEnd <= helperStart) {
        throw new Error("app.js 里找不到 Trace Inspector 的纯展示 helper");
      }
      const helperSrc = uiSrc.slice(helperStart, helperEnd);
      const traceHelpers = new Function(
        `${helperSrc}\nreturn { buildTracePresentation, traceEventPresentation, traceEventMatches, ` +
          `traceTurnMatches, traceUnknownLineMatches, traceStatsEquation, traceRefreshInPlaceAllowed, ` +
          `traceResponseCanCommit, traceScrollAfterRefresh };`,
      )() as {
        buildTracePresentation(lines: Array<Record<string, unknown>>): {
          stats: Record<string, number>;
          segments: Array<{
            prelude: Array<Record<string, unknown>>;
            turns: Array<Record<string, unknown>>;
            footer?: Record<string, unknown>;
            unknownLines: Array<Record<string, unknown>>;
          }>;
          turns: Array<{
            id: string;
            number: number;
            actions: Array<{ id: string; events: Array<{ type: string }> }>;
            artifacts: Array<{ id: string; events: Array<{ type: string }> }>;
            events: Array<Record<string, unknown>>;
            abnormal: boolean;
            important: boolean;
            isLast?: boolean;
            isLongest?: boolean;
          }>;
          events: Array<Record<string, unknown>>;
        };
        traceEventPresentation(line: Record<string, unknown>): Record<string, unknown>;
        traceEventMatches(event: Record<string, unknown>, options: Record<string, unknown>): boolean;
        traceTurnMatches(turn: Record<string, unknown>, options: Record<string, unknown>): boolean;
        traceUnknownLineMatches(line: Record<string, unknown>, options: Record<string, unknown>): boolean;
        traceStatsEquation(stats: Record<string, number>): string;
        traceRefreshInPlaceAllowed(
          tab: string,
          selectedRunId: string,
          traceRunId: string,
          rootConnected: boolean,
        ): boolean;
        traceResponseCanCommit(
          requestRevision: number,
          currentRevision: number,
          requestedRunId: string,
          selectedRunId: string,
          tab: string,
          rootConnected: boolean,
        ): boolean;
        traceScrollAfterRefresh(
          scrollTop: number,
          clientHeight: number,
          previousScrollHeight: number,
          nextScrollHeight: number,
        ): number;
      };

      let sequence = 1;
      let occurredAt = 1_000;
      const event = (type: string, payload: Record<string, unknown>): Record<string, unknown> => ({
        kind: "event",
        runId: "run_trace_fixture",
        sequence: sequence++,
        occurredAt: occurredAt += 10,
        type,
        payload,
      });
      const lines: Array<Record<string, unknown>> = [{
        kind: "header",
        segmentIndex: 0,
        entry: "web",
        commit: "0123456789abcdef",
        modelId: "fixture-model",
        executionPrivilege: "SANDBOXED",
        startedAt: "2026-09-02T00:00:00.000Z",
      }];
      lines.push(event("RunStarted", {
        endpointId: "fixture",
        modelId: "fixture-model",
        executionPrivilege: "SANDBOXED",
      }));
      for (let turn = 1; turn <= 10; turn += 1) {
        lines.push(event("TurnStarted", { turn }));
        lines.push(event("ContextFrameCompiled", {
          items: turn,
          totalTokens: 1_000 + turn,
          fixedOverheadTokens: 100,
          compacted: false,
          trust: { hasExternalUntrusted: false, untrustedItems: 0 },
        }));
        if (turn === 1) {
          lines.push(event("ActionProposed", {
            actionId: "act_one",
            toolCallId: "call_one",
            toolName: "read_file",
            effect: "READ fixture.txt",
            riskFacts: [],
          }));
          lines.push(event("ApprovalRequested", { actionId: "act_one", effect: "READ fixture.txt", reason: "fixture" }));
          lines.push(event("ApprovalDecided", { actionId: "act_one", approved: true, decidedBy: "AUTO" }));
          lines.push(event("AttemptStarted", { actionId: "act_one", toolName: "read_file" }));
          lines.push(event("AttemptCompleted", {
            actionId: "act_one",
            status: "SUCCEEDED",
            sideEffectState: "NO_EFFECT",
            durationMs: 4,
          }));
          lines.push(event("VerificationCompleted", {
            actionId: "act_one",
            status: "PASSED",
            required: true,
            detail: "fixture passed",
          }));
          lines.push(event("ActionProposed", {
            actionId: "act_two",
            toolCallId: "call_two",
            toolName: "run_shell",
            effect: "EXECUTE fixture",
            riskFacts: [],
          }));
          lines.push(event("AttemptCompleted", {
            actionId: "act_two",
            status: "FAILED",
            sideEffectState: "UNKNOWN",
            durationMs: 5,
          }));
          lines.push(event("ArtifactRegistered", {
            artifactId: "art_one",
            logicalId: "fixture",
            version: 1,
            role: "DELIVERABLE",
            kind: "FILE",
          }));
          lines.push(event("ArtifactVerified", {
            artifactId: "art_one",
            role: "DELIVERABLE",
            ok: true,
            checksRun: ["fixture"],
            detail: "ok",
          }));
        }
        if (turn === 2) {
          lines.push(event("FutureEvent", { text: "<img src=x onerror=alert(1)>", toolName: "future_tool" }));
        }
        if (turn < 10) lines.push(event("LoopContinued", { transition: { reason: "NEXT_TURN" } }));
      }
      // 先补到 115 条业务事件，最后一条 LoopTerminated 让口径精确落在 116。
      const businessCount = () => lines.filter((line) =>
        line.kind === "event" && line.type !== "ModelStreamDelta").length;
      while (businessCount() < 115) {
        lines.push(event("InterjectionAccepted", { content: "fixture filler " + businessCount() }));
      }
      for (let i = 0; i < 91; i += 1) {
        lines.push(event("ModelStreamDelta", { text: i === 0 ? "stream-only-canary" : "x" }));
      }
      lines.push(event("LoopTerminated", {
        terminal: { reason: "COMPLETED" },
        outcome: { kind: "SUCCESS", incompleteItems: [], recoveryItems: [] },
      }));
      lines.push({
        kind: "footer",
        segmentIndex: 0,
        eventCount: 207,
        terminal: { reason: "COMPLETED" },
        outcome: { kind: "SUCCESS" },
        finishedAt: "2026-09-02T00:01:00.000Z",
      });

      const projected = traceHelpers.buildTracePresentation(lines);
      fact(
        "209 行口径",
        `${projected.stats.businessEvents} 业务事件 + ${projected.stats.streamEvents} 流式增量 + ` +
          `${projected.stats.boundaryLines} 段边界 + ${projected.stats.unknownLines} 未知行 = ` +
          `${projected.stats.rawLines} 行`,
      );
      const n1 =
        projected.stats.rawLines === 209 &&
        projected.stats.businessEvents === 116 &&
        projected.stats.streamEvents === 91 &&
        projected.stats.boundaryLines === 2 &&
        projected.stats.unknownLines === 0 &&
        traceHelpers.traceStatsEquation(projected.stats) ===
          "原始行 209 = 业务事件 116 + 流式增量 91 + 段边界 2 + 未知行 0" &&
        projected.stats.turns === 10;
      verdict(
        n1,
        n1
          ? "业务事件、流式增量、轮次与 JSONL 行数分开统计，解释了 116 与 209 为什么同时成立"
          : `Trace 统计口径错误：${JSON.stringify(projected.stats)}`,
      );

      const turnOne = projected.turns.find((turn) => turn.number === 1)!;
      const actionOne = turnOne.actions.find((action) => action.id === "act_one");
      const actionTwo = turnOne.actions.find((action) => action.id === "act_two");
      const artifact = turnOne.artifacts.find((item) => item.id === "art_one");
      const n2 =
        actionOne?.events.map((item) => item.type).join(",") ===
          "ActionProposed,ApprovalRequested,ApprovalDecided,AttemptStarted,AttemptCompleted,VerificationCompleted" &&
        actionTwo?.events.map((item) => item.type).join(",") === "ActionProposed,AttemptCompleted" &&
        artifact?.events.map((item) => item.type).join(",") === "ArtifactRegistered,ArtifactVerified" &&
        !actionOne?.events.some((item) => item.type.startsWith("Artifact"));
      fact("act_one 生命周期", actionOne?.events.map((item) => item.type).join(" → ") ?? "缺失");
      fact("art_one 生命周期", artifact?.events.map((item) => item.type).join(" → ") ?? "缺失");
      verdict(
        n2,
        n2
          ? "actionId 只聚合自己的审批/执行/验证；artifactId 独立聚合，没有臆造 action → artifact 关系"
          : "actionId 或 artifactId 的展示关联发生串线",
      );

      const unknown = projected.events.find((item) => item.type === "FutureEvent")!;
      const hiddenStream = projected.turns.flatMap((turn) => turn.events).filter((item) =>
        traceHelpers.traceEventMatches(item, { filter: "all", query: "", showStream: false })).length;
      const shownStream = projected.turns.flatMap((turn) => turn.events).filter((item) =>
        traceHelpers.traceEventMatches(item, { filter: "all", query: "", showStream: true })).length;
      const n3 =
        unknown.label === "未识别事件" &&
        String(unknown.searchText).includes("<img src=x onerror=alert(1)>") &&
        shownStream - hiddenStream === 91 &&
        !traceHelpers.traceTurnMatches(projected.turns[9]!, {
          filter: "important",
          query: "stream-only-canary",
          showStream: false,
        }) &&
        traceHelpers.traceTurnMatches(projected.turns[9]!, {
          filter: "important",
          query: "stream-only-canary",
          showStream: true,
        });
      fact("未来事件回退", `${unknown.label} / ${unknown.type}`);
      fact("流式开关前后", `${hiddenStream} → ${shownStream}`);
      verdict(
        n3,
        n3
          ? "未来事件与风险文本按原文保留；ModelStreamDelta 默认隐藏、打开后 91 条全部可见"
          : "未知事件被丢弃、改写，或流式开关没有控制完整集合",
      );

      const searchHit = projected.turns.filter((turn) => traceHelpers.traceTurnMatches(turn, {
        filter: "all",
        query: "read_file",
        showStream: false,
      }));
      const abnormal = projected.turns.filter((turn) => traceHelpers.traceTurnMatches(turn, {
        filter: "abnormal",
        query: "",
        showStream: false,
      }));
      const diagnostic = projected.turns.filter((turn) => traceHelpers.traceTurnMatches(turn, {
        filter: "diagnostic",
        query: "",
        showStream: false,
      }));
      const last = projected.turns[projected.turns.length - 1];
      const n4 =
        searchHit.length === 1 && searchHit[0]?.number === 1 &&
        abnormal.length === 1 && abnormal[0]?.number === 1 &&
        diagnostic.length === 1 && diagnostic[0]?.number === 1 &&
        turnOne.important && turnOne.abnormal && last?.isLast === true && last?.isLongest === true && last.important;
      fact("搜索 read_file", searchHit.map((turn) => `T${turn.number}`).join(", "));
      fact("重点轮", projected.turns.filter((turn) => turn.important).map((turn) => `T${turn.number}`).join(", "));
      verdict(
        n4,
        n4
          ? "搜索、异常筛选与默认重点轮规则可区分：异常 T1，最后且最长的 T10"
          : "搜索、异常分类或重点轮规则没有按真实事件工作",
      );

      const multi = traceHelpers.buildTracePresentation([
        { kind: "header", segmentIndex: 0, modelId: "m1" },
        { kind: "event", sequence: 1, occurredAt: 1, type: "RunStarted", payload: {} },
        { kind: "footer", segmentIndex: 0, terminal: null },
        { kind: "header", segmentIndex: 1, modelId: "m2", resumedFrom: 1 },
        { kind: "event", sequence: 2, occurredAt: 2, type: "ResumeStarted", payload: { fromSequence: 1, rebuiltMessages: 1 } },
        { kind: "event", sequence: 3, occurredAt: 3, type: "TurnStarted", payload: { turn: 2 } },
      ]);
      const headerOnly = traceHelpers.buildTracePresentation([{ kind: "header", segmentIndex: 0 }]);
      const n5 =
        multi.stats.segments === 2 &&
        multi.segments[1]?.prelude.some((item) => item.type === "ResumeStarted") === true &&
        multi.segments[1]?.turns.length === 1 &&
        multi.segments[1]?.footer === undefined &&
        headerOnly.stats.segments === 1 && headerOnly.stats.turns === 0;
      verdict(
        n5,
        n5
          ? "多执行段、resume 段首事件、缺 footer 与只有 header 的运行中形态都能投影"
          : "执行段边界或不完整 Trace 被误删",
      );

      const unknownLine = {
        kind: "future-trace-row",
        payload: { marker: "unknown-payload-canary", html: "<svg onload=alert(1)>" },
      };
      const withUnknown = traceHelpers.buildTracePresentation([
        ...lines.slice(0, -1),
        unknownLine,
        lines[lines.length - 1]!,
      ]);
      const unknownOnly = traceHelpers.buildTracePresentation([unknownLine]);
      const mixedWithoutFooter = traceHelpers.buildTracePresentation([
        { kind: "header", segmentIndex: 0 },
        event("TurnStarted", { turn: 99 }),
        unknownLine,
      ]);
      const unknownAll = traceHelpers.traceUnknownLineMatches(unknownLine, {
        filter: "all",
        query: "unknown-payload-canary",
      });
      const unknownOtherFilter = traceHelpers.traceUnknownLineMatches(unknownLine, {
        filter: "diagnostic",
        query: "unknown-payload-canary",
      });
      const unknownMiss = traceHelpers.traceUnknownLineMatches(unknownLine, {
        filter: "all",
        query: "does-not-exist",
      });
      const n6 =
        withUnknown.stats.rawLines === 210 &&
        withUnknown.stats.businessEvents === 116 &&
        withUnknown.stats.streamEvents === 91 &&
        withUnknown.stats.boundaryLines === 2 &&
        withUnknown.stats.unknownLines === 1 &&
        traceHelpers.traceStatsEquation(withUnknown.stats) ===
          "原始行 210 = 业务事件 116 + 流式增量 91 + 段边界 2 + 未知行 1" &&
        unknownAll && !unknownOtherFilter && !unknownMiss &&
        unknownOnly.stats.rawLines === 1 && unknownOnly.stats.unknownLines === 1 &&
        unknownOnly.segments[0]?.unknownLines.length === 1 &&
        mixedWithoutFooter.segments[0]?.unknownLines.length === 1 &&
        mixedWithoutFooter.segments[0]?.footer === undefined;
      fact("未知行口径", traceHelpers.traceStatsEquation(withUnknown.stats));
      verdict(
        n6,
        n6
          ? "未知 kind 行计入等式，只在“全部”分类按完整原始 JSON 搜索；独立、混合和缺 footer 形态都不丢失"
          : "未知 kind 行的统计、搜索或不完整 Trace 投影不自洽",
      );

      const localRefresh = traceHelpers.traceRefreshInPlaceAllowed("trace", "run_a", "run_a", true);
      const switchedRun = traceHelpers.traceRefreshInPlaceAllowed("trace", "run_b", "run_a", true);
      const switchedTab = traceHelpers.traceRefreshInPlaceAllowed("budget", "run_a", "run_a", true);
      const detachedRoot = traceHelpers.traceRefreshInPlaceAllowed("trace", "run_a", "run_a", false);
      const newestCanCommit = traceHelpers.traceResponseCanCommit(4, 4, "run_a", "run_a", "trace", true);
      const staleCannotCommit = traceHelpers.traceResponseCanCommit(3, 4, "run_a", "run_a", "trace", true);
      const n7 = localRefresh && !switchedRun && !switchedTab && !detachedRoot &&
        newestCanCommit && !staleCannotCommit;
      verdict(
        n7,
        n7
          ? "仅同 Run、Trace Tab、已连接外壳走局部刷新，且只有最新 revision 可以落页面"
          : "局部刷新资格或并发响应 revision guard 失效",
      );

      const followsBottom = traceHelpers.traceScrollAfterRefresh(452, 500, 1_000, 2_000);
      const keepsHistory = traceHelpers.traceScrollAfterRefresh(451, 500, 1_000, 2_000);
      const clampsHistory = traceHelpers.traceScrollAfterRefresh(1_000, 500, 2_000, 800);
      const n8 = followsBottom === 1_500 && keepsHistory === 451 && clampsHistory === 300;
      fact("实时刷新滚动", `底部附近 → ${followsBottom}；历史位置 → ${keepsHistory}；缩短后 → ${clampsHistory}`);
      verdict(
        n8,
        n8
          ? "距底部 48px 内跟随新内容，历史位置保持并在内容缩短时裁到合法范围"
          : "Trace 实时刷新滚动策略的阈值或裁剪行为错误",
      );

      const uiCss = readFileSync(resolve(REPO_ROOT, "apps/workagent-ui/public/app.css"), "utf8");
      const traceCss = uiCss
        .slice(uiCss.indexOf("/* ── Trace Inspector */"), uiCss.indexOf("/* ── 时间线 */"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const n9 =
        uiSrc.includes("逐轮检查器") &&
        uiSrc.includes("原始事件") &&
        uiSrc.includes("显示流式增量") &&
        uiSrc.includes("refreshTraceInspector(d, { preserveScroll: true })") &&
        uiSrc.includes("compositionstart") &&
        uiSrc.includes("compositionend") &&
        uiSrc.includes("}, 150)") &&
        uiSrc.includes("document.createDocumentFragment()") &&
        uiSrc.includes("刷新失败，保留上次结果") &&
        uiSrc.includes("未识别 Trace 行 × ") &&
        uiSrc.includes("ui.dom.content.replaceChildren(fragment)") &&
        uiCss.includes(".trace-toolbar") &&
        uiCss.includes("position: sticky") &&
        uiCss.includes(".trace-unknown-lines") &&
        !traceCss.includes("overflow-y");
      verdict(
        n9,
        n9
          ? "稳定外壳、IME 防抖、DocumentFragment、失败保留与唯一纵向滚动容器均有机械锚点"
          : "Trace 实时交互连续性、未知行入口或滚动边界缺失",
      );
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
    const billedAxis = axes.find((a) => a.axis === "billedInputTokens");
    fact("八条轴", axes.map((a) => `${a.axis}=${a.used}/${a.limit ?? "—"}`).join(" "));
    verdict(
      axes.length === 8 && billedAxis?.used === snapshot.budgetUsage["billedInputTokens"],
      "八条轴走 Runtime 的 readBudgetAxes，且**轴名与读数同名**（billedInputTokens）—— " +
        "此前轴叫 inputTokens 而读的是 billed，靠一行注释维持；缓存命中时两者差 5 倍以上，" +
        "照字面配置的人会把 42 万的墙当成 3 万",
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
