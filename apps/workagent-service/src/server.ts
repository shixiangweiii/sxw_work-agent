/**
 * Layer 1 ↔ Layer 2 的 HTTP / SSE 面（V05 §5.4）。
 *
 * §5.4 原文：HTTP Command / Query；SSE 推 Assistant Delta、Run 状态、
 * ActionBatch/Tool 状态、Approval、Artifact；WebSocket 只用于终端与浏览器
 * 人工接管；所有命令携带 idempotency key；SSE/WS 重连使用 transcript sequence
 * 作为游标。
 *
 * ── 与原文的两处偏差，都有理由 ────────────────────────────────────────
 *
 * 1. **没有 WebSocket。** 它在原文里的唯一用途是「终端与浏览器人工接管」，
 *    而本批的接管是一次「读一段说明 → 按一个按钮」，不需要双向流。
 *    等真的要在界面里嵌一个终端时再加 —— 那时它会有一个具体的形状，
 *    现在加就是凭空猜一个协议（§2.3「当前明确不做」的同一条纪律）。
 * 2. **idempotency key 只在「等人的应答」上有。** `pendingId` 就是那个 key
 *    （见 `PendingHub.answer` 的【定】）。start / resume / cancel 三个命令
 *    没有 key —— 它们各自有天然的幂等保护：并发 Run 被 §6.4 挡掉，
 *    resume 被生命周期闸门挡掉，cancel 本身幂等。
 *    **凭空加一个 key 会让人以为这三条命令的重放是安全的，而那要靠上面那些闸门。**
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "@workagent/harness-runtime";
import { DEFAULT_BUDGETS, applyBudgetOverrides } from "@workagent/harness-runtime";
import { join } from "node:path";
import {
  parseApprovalMode,
  workspaceStorage,
  type ApprovalMode,
} from "../../cli/src/compose.js";
import { RunHost, type RunHostOptions } from "./run-host.js";
import { WorkspaceHosts } from "./workspace-hosts.js";
import { LocalGuard, SECURITY_HEADERS } from "./security.js";
import type { UiStateResponse } from "./api-types.js";

/**
 * 界面资源的位置。
 *
 * 【定】这是**文件路径**依赖，不是模块依赖 —— 服务把 `apps/workagent-ui/public/`
 * 下的文件当静态资源发出去，UI 一行 JS 都不 import 后端。
 * 边界 grep 第 8 条（`grep -rn "@workagent/" apps/workagent-ui`）抓的就是这件事：
 * 那条 grep 现在成立靠的是「UI 是浏览器资源」这个物理事实，
 * 而这个事实随时可以被一次「给 UI 加个构建步骤」的改动破坏。
 */
const UI_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../workagent-ui/public",
);

export interface ServiceOptions extends Omit<RunHostOptions, "dbPath" | "traceDir" | "modelAuditDir"> {
  /**
   * 覆盖 bootstrap workspace 的存储位置。**只给验收脚本用。**
   *
   * 【定】生产路径没有这个入口：存储位置由 `workspaceStorage(workspaceRoot)`
   * 唯一推出，CLI 与界面同一条规则。此前它是**生产行为**（服务启动时
   * 把注册表的默认值覆盖回 CLI 的旧路径，为的是让旧库里的 Run 还能显示），
   * 那是为历史数据保留的第二套规则，已经删掉。
   *
   * 留给脚本是因为它们要 `:memory:` 与临时目录 —— 与 `ComposeOptions.dbPath`
   * 同一个性质：**旋钮长在测量装置这边**。
   */
  storageOverride?: { dbPath: string; traceDir: string; modelAuditDir?: string };
  /** 0 = 随机端口（§22.6 的「随机端口」）。 */
  port?: number;
  /** 固定 Token。**只给验收脚本用** —— 生产一律随机。 */
  token?: string;
  /**
   * workspace 注册表的位置（Layer 2 产品状态）。
   *
   * 【定】它是**默认路径的覆盖**，不是功能开关 —— 多 workspace 一直是开着的。
   * 此前这里写着「不传则不启用多 workspace」，而 `startService` 无论传不传
   * 都会建 `WorkspaceHosts`，只是缺省时落在 `<workspace>/.workagent/`。
   * 验收脚本传它是为了把注册表关进临时目录，不是为了关掉这个功能。
   */
  registryFile?: string;
}

export interface RunningService {
  port: number;
  token: string;
  url: string;
  /**
   * **当前** workspace 的 RunHost。
   *
   * 【定】是 getter 不是字段 —— 切换 workspace 会换掉它。写成字段的话，
   * 验收脚本与任何长期持有它的地方都会拿着一个已经关掉的库。
   */
  readonly host: RunHost;
  workspaces: WorkspaceHosts;
  close(): Promise<void>;
}

export async function startService(opts: ServiceOptions): Promise<RunningService> {
  const workspaces = new WorkspaceHosts({
    registryFile: opts.registryFile ?? join(opts.workspaceRoot, ".workagent", "workspaces.json"),
    endpoint: opts.endpoint,
    ...(opts.approvalMode ? { approvalMode: opts.approvalMode } : {}),
    ...(opts.executionPrivilege ? { executionPrivilege: opts.executionPrivilege } : {}),
    ...(opts.composeOverrides ? { composeOverrides: opts.composeOverrides } : {}),
    bootstrap: {
      path: opts.workspaceRoot,
      ...(opts.storageOverride ? { storage: opts.storageOverride } : {}),
    },
  });
  const host = (): RunHost => workspaces.host();
  let boundPort = 0;
  const guard = new LocalGuard(() => boundPort, opts.token);

  const server = createServer((req, res) => {
    void handle(req, res, workspaces, guard).catch((err) => {
      /**
       * 【定】响应头已经发出去之后不能再写头。
       *
       * SSE 那条路径一进来就 `writeHead`，之后任何抛出都会让这里的 `sendJson`
       * 再写一次头 → `ERR_HTTP_HEADERS_SENT` 在 `.catch()` 里抛出 →
       * 未处理的 rejection → Node 默认**崩进程**。一个诊断界面不该有
       * 「看某个 Run 把服务看死了」这种路径。
       */
      if (res.headersSent) {
        res.end();
        return;
      }
      // 【定】错误原文交给界面，不翻译成某个状态码之外的语义（决 6）。
      sendJson(res, 500, { error: (err as Error).message });
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    // 【定】只监听 127.0.0.1。绑 0.0.0.0 会让同一个局域网里的任何人
    // 拿到一个能读你磁盘、能跑 shell 的 Agent。
    server.listen(opts.port ?? 0, "127.0.0.1", () => ok());
  });
  const addr = server.address();
  boundPort = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port: boundPort,
    token: guard.token,
    url: `http://127.0.0.1:${boundPort}/?t=${guard.token}`,
    get host(): RunHost {
      return host();
    },
    workspaces,
    close: async () => {
      await closeServer(server);
      // 【定】await —— host.close() 现在要等后台把终态写完再关库（codex P1-6）。
      await workspaces.close();
    },
  };
}

// ══════════════════════════════════════════════════════════════ 路由

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  workspaces: WorkspaceHosts,
  guard: LocalGuard,
): Promise<void> {
  /** 当前 workspace 的 host。每次请求现取 —— 切换之后不能还拿着旧的。 */
  const host = (): RunHost => workspaces.host();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;

  const isApi = path.startsWith("/api/");
  /**
   * ── 鉴权分两层，是实测逼出来的 ─────────────────────────────────────────
   *
   * `Host` / `Origin` 校验对**所有**请求生效（DNS rebinding 与外部网页调用
   * 都要在这里挡住）；**Token 只校验 `/api/`**。
   *
   * 这里原本写的是「首屏也要鉴权」，理由是「没有 Token 的人应该什么都拿不到」。
   * 一跑就翻车：浏览器拿着带 `?t=` 的 URL 打开首页之后，`<link href="/app.css">`
   * 与 `<script src="/app.js">` 是**不带任何凭据**发出去的 —— 两个 401，
   * 页面变成一张没有样式、没有脚本的白纸。
   *
   * 补救只有两条路，都比现在这条差：
   *   · 发 Cookie —— 它会被浏览器自动附带，那正是 CSRF 的载体，
   *     而我们上面刚把跨源挡掉，没必要再开一扇自动填钥匙的门；
   *   · 把 Token 注进 HTML —— 等于把它从 URL 搬进页面源码，一样会被截图、
   *     被贴进 issue，还多了一份动态改写静态文件的代码。
   *
   * 【定】所以让静态壳公开：`index.html` / `app.css` / `app.js` 里**没有任何
   * 运行数据**，它们就是磁盘上那三个文件。数据全在 `/api/` 后面，
   * §22.6 要保护的东西一个都没漏出去。
   */
  const verdict = guard.check(req, url, { requireToken: isApi });
  if (!verdict.ok) {
    sendText(res, verdict.status ?? 401, `${verdict.message}\n`);
    return;
  }

  // ── 静态资源
  if (req.method === "GET" && !isApi) {
    serveStatic(res, path);
    return;
  }

  // ── Query
  if (req.method === "GET" && path === "/api/state") {
    const activeId = workspaces.activeEntry()?.id ?? "";
    const body: UiStateResponse = {
      service: host().info(),
      runs: await host().listRuns(),
      pending: host().pending(),
      workspaces: workspaces.list().map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        realPath: w.realPath,
        // 【定】现算，与注册表无关 —— 派生值不落盘（见 WorkspaceEntry）。
        ...workspaceStorage(w.realPath),
        createdAt: w.createdAt,
        lastUsedAt: w.lastUsedAt,
        active: w.id === activeId,
      })),
      activeWorkspaceId: activeId,
    };
    sendJson(res, 200, body);
    return;
  }

  // ── Workspace（Layer 2 的产品状态，不推进任何执行语义）
  if (req.method === "POST" && path === "/api/workspaces") {
    const body = await readJsonBody(req);
    const raw = String(body["path"] ?? "").trim();
    const name = typeof body["name"] === "string" ? body["name"] : undefined;
    const r = workspaces.create(raw, name);
    if (!r.ok) {
      sendJson(res, 400, { error: r.error, warnings: r.warnings });
      return;
    }
    // 【定】warnings 要跟着 200 一起回去。它不是错误（用户有权把仓库根当
    // workspace），但「这个目录根下有 .git / .env，而 Agent 在里面有写权限」
    // 是他做决定时应该看见的事实 —— 静默吞掉等于替他做了决定。
    sendJson(res, 200, { workspace: r.entry, warnings: r.warnings });
    return;
  }

  const wsMatch = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(path);
  if (wsMatch) {
    const wsId = decodeURIComponent(wsMatch[1]!);
    const rest = wsMatch[2] ?? "";
    if (!isSafeId(wsId)) {
      sendJson(res, 400, { error: `workspace id 形状不合法：${wsId.slice(0, 40)}` });
      return;
    }
    if (req.method === "POST" && rest === "/activate") {
      const r = await workspaces.switchTo(wsId);
      // 【定】「有 Run 在跑」返回 **409**，不是 500。它是一个用户能自己解决的
      // 冲突（先取消或等它跑完），而 500 的措辞是留给「不该发生的事」的。
      sendJson(
        res,
        r.ok ? 200 : 409,
        // 【定】warning 不阻断切换，但必须送到界面上。见 WorkspaceHosts.switchTo。
        r.ok ? { workspace: r.entry, ...(r.warning ? { warning: r.warning } : {}) } : { error: r.error },
      );
      return;
    }
    if (req.method === "DELETE" && rest === "") {
      const r = workspaces.remove(wsId);
      sendJson(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { error: r.error });
      return;
    }
  }

  const runMatch = /^\/api\/runs\/([^/]+)(\/.*)?$/.exec(path);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]!);
    const rest = runMatch[2] ?? "";

    /**
     * 【定】runId 必须先过形状校验，再往下走。
     *
     * `[^/]+` 拦不住 **percent-encoded** 的斜杠：`new URL()` 不解码 pathname，
     * 于是 `..%2f..%2fx` 整段被当成一个 runId 捕获，随后 `decodeURIComponent`
     * 把它变成 `../../x`，再拼进 `traceFileFor()` —— 实测
     * `..%2f.workagent-runs%2frun_9610d44d3a62/trace` **返回了 367 行**，
     * 逃出 traceDir 又绕了回来。也就是说盘上任意 `*.jsonl` 都读得到。
     *
     * 校验放在这里而不是各个 handler 里：路由是唯一的收口点，
     * 分散到 handler 就会有下一个忘了加的（这正是「一条闸门排在另一条
     * 后面」的反面 —— 闸门要在分叉之前）。
     */
    if (!isSafeId(runId)) {
      sendJson(res, 400, { error: `runId 形状不合法：${runId.slice(0, 40)}` });
      return;
    }

    if (req.method === "GET" && rest === "") {
      const detail = await host().detail(runId);
      if (!detail) {
        sendJson(res, 404, { error: `找不到 Run ${runId}` });
        return;
      }
      sendJson(res, 200, { ...detail, pending: host().pending(runId) });
      return;
    }

    if (req.method === "GET" && rest === "/events") {
      streamEvents(req, res, host(), runId, readCursor(req, url));
      return;
    }

    if (req.method === "GET" && rest === "/trace") {
      sendJson(res, 200, { lines: host().traceLines(runId) });
      return;
    }

    const modelInvocationMatch = /^\/model-invocations\/([^/]+)$/.exec(rest);
    if (req.method === "GET" && modelInvocationMatch) {
      const invocationId = decodeURIComponent(modelInvocationMatch[1]!);
      // sidecar writer 的文件名白名单比通用资源 id 更窄；读取必须使用同一规则。
      if (!isSafeModelAuditId(invocationId)) {
        sendJson(res, 400, { error: `invocationId 形状不合法：${invocationId.slice(0, 40)}` });
        return;
      }
      const audit = await host().modelInvocationAudit(runId, invocationId);
      if (!audit) {
        sendJson(res, 404, { error: `调用 ${invocationId} 不属于 Run ${runId}` });
        return;
      }
      // 未脱敏的上下文与 Provider 事件不得进入浏览器缓存。
      sendJson(res, 200, audit, { "Cache-Control": "no-store" });
      return;
    }

    if (req.method === "POST" && rest === "/resume") {
      const body = await readJsonBody(req);
      const decision = body["recoveryDecision"];
      const note = body["recoveryNote"];
      const r = await host().resumeRun(
        runId,
        decision === "CONTINUE" || decision === "ABORT" ? decision : undefined,
        typeof note === "string" && note.length > 0 ? note : undefined,
      );
      sendJson(res, 200, r);
      return;
    }

    if (req.method === "POST" && rest === "/cancel") {
      host().cancel(runId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && rest === "/interject") {
      const body = await readJsonBody(req);
      const text = String(body["text"] ?? "").trim();
      if (!text) {
        sendJson(res, 400, { error: "插话内容为空" });
        return;
      }
      host().interject(runId, text);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === "POST" && path === "/api/runs") {
    const body = await readJsonBody(req);
    const task = String(body["task"] ?? "").trim();
    if (!task) {
      sendJson(res, 400, { error: "任务为空" });
      return;
    }
    /**
     * ── 「提交任务时选档位」（ADR-0012）─────────────────────────────────────
     *
     * 【定】它**拨的就是那一个开关**，不是一个逐 Run 的第二字段。
     *
     * 做成逐 Run 字段的话，界面上会同时存在两个都自称当前档位的东西
     * （顶部开关 ＋ 这次提交选的），而它们对"下一个 Run 用哪一档"给出
     * 不同答案 —— 那正是本仓反复清理的「一个事实两个出处」。
     * 所以提交栏那个选择器是同一个开关的第二个入口，选完它就留在那一档。
     */
    /**
     * ── 【定】顺序：**先校验值 → 再起 Run → 最后才拨档位**（二次评审 P1-2）─
     *
     * 第一版写的是「先 `setApprovalMode()` 再 `startRun()`」，而 `startRun()`
     * 会在已有前台 Run 时抛（§6.4 同时只允许一个前台 Run）。后果具体而危险：
     *
     *   Run A 正在 DEFAULT 下跑 → 另一个标签页提交 Run B 并选 AUTO →
     *   B 启动失败返回 500，**而 A 已经静默变成 AUTO**，
     *   它后续所有需要审批的副作用从此自动放行。
     *
     * **一个失败的请求改变了另一个 Run 的安全边界。** 这条与
     * 「应答一个已经不在等的请求返回 409 而不是 200」是同一条纪律：
     * 失败的请求不得留下任何状态变化。
     *
     * 【定】值的校验仍然排在最前 —— 拼错的档位应该 400，而不是先起一个
     * Run 再告诉你参数不对（那时 Run 已经在跑了，回滚不掉）。
     */
    const rawMode = body["approvalMode"];
    let requested: ApprovalMode | undefined;
    if (rawMode !== undefined) {
      try {
        requested = parseApprovalMode(String(rawMode));
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message });
        return;
      }
    }
    /**
     * ── 逐 Run 的预算覆盖（`{ budgets: { turns: 40 } }`，按 axis id）────────
     *
     * 【定】校验**必须在 `startRun()` 之前跑完**，与上面档位那条同一条纪律：
     * `startRun()` 会 `claimForeground()`，在它之后才发现值不合法的话，
     * 一个失败的请求就留下了一个被占住的前台槽位。
     *
     * 【定】这里只**试算**、不使用结果 —— 真正生效的那次合并在
     * `makeRunSpec()` 里（那是唯一的出处）。试算的目的只有一个：
     * 让非法值以 400 返回，而不是以一个已经跑起来的 Run ＋ 500 返回。
     * 用的是同一个 `applyBudgetOverrides`，所以两次判定不可能分叉。
     */
    let budgets: Record<string, unknown> | undefined;
    const rawBudgets = body["budgets"];
    if (rawBudgets !== undefined) {
      if (typeof rawBudgets !== "object" || rawBudgets === null || Array.isArray(rawBudgets)) {
        sendJson(res, 400, { error: "budgets 必须是一个对象，按预算轴名索引（例如 {\"turns\": 40}）" });
        return;
      }
      budgets = rawBudgets as Record<string, unknown>;
      try {
        applyBudgetOverrides(DEFAULT_BUDGETS, budgets);
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message });
        return;
      }
    }
    const r = await host().startRun(task, budgets);
    if (requested !== undefined) host().setApprovalMode(requested);
    sendJson(res, 200, r);
    return;
  }

  /**
   * 拨审批档位（ADR-0012）。**运行中随时可拨**，下一次审批起生效。
   *
   * 【定】没有对应的"拨执行特权"路由，而那是刻意的：`ExecutionPrivilege`
   * 随 RunSpec 冻结（见那个类型的说明）。给它一个 HTTP 入口的话，
   * 界面上会出现一个点了之后"看起来生效了、实际对正在跑的 Run 什么都没变"
   * 的开关 —— 而那正是 M-5 那条教训的形状。要换它得重启服务。
   */
  if (req.method === "POST" && path === "/api/approval-mode") {
    const body = await readJsonBody(req);
    try {
      const mode = parseApprovalMode(String(body["mode"] ?? ""));
      host().setApprovalMode(mode);
      sendJson(res, 200, { ok: true, mode });
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
    }
    return;
  }

  const pendingMatch = /^\/api\/pending\/([^/]+)$/.exec(path);
  if (req.method === "POST" && pendingMatch) {
    const body = await readJsonBody(req);
    const kind = String(body["kind"] ?? "");
    const ok =
      kind === "APPROVAL"
        ? (() => {
            /**
             * 「批准，且本次 Run 不再问」（ADR-0012）。
             *
             * 【定】提升**先于**应答。反过来写的话，被放行的这一次会先
             * 落进 `ApprovalDecided`，而那一瞬间 Run 可能已经走到了下一个
             * 需要审批的 Action —— 于是它照样弹一次，用户会以为按钮没生效。
             *
             * 【定】这一次仍然记 `HUMAN`（人确实看了这一条），
             * 之后那些记 `AUTO`。见 `human-channels` 里 `a` 键那段。
             */
            /**
             * 【定】提升前必须**先确认这张卡片真的是一个 APPROVAL**
             * （二次评审 P2-3）。
             *
             * 第一版按 pendingId 找到任意 kind 就 elevate，之后才由
             * `answerPending()` 去校验 kind —— 于是向一张 HANDOFF / QUESTION
             * 卡片发一个伪造的 APPROVAL 应答，会拿到 409，
             * **而那个 Run 已经进入了后续审批自动放行的状态**。
             * 又一次「失败的请求留下了状态变化」，与上面 P1-2 同源。
             */
            const p = host().pending().find((x) => x.pendingId === pendingMatch[1]);
            const elevate =
              body["alwaysForRun"] === true && body["approved"] === true && p?.kind === "APPROVAL";
            /**
             * 【定】提升仍然**先于**应答（这一条第一版是对的，保留）：
             * 反过来写的话，被放行的这一次会先落进 `ApprovalDecided`，
             * 而那一瞬间 Run 可能已经走到了下一个需要审批的 Action ——
             * 于是它照样弹一次，用户会以为按钮没生效。
             */
            if (elevate) host().elevateRun(p!.runId);
            const answered = host().answerPending(pendingMatch[1]!, {
              kind: "APPROVAL",
              approved: body["approved"] === true,
              ...(typeof body["reason"] === "string" ? { reason: body["reason"] } : {}),
            });
            /**
             * 【定】应答失败要把提升**收回**。走到这里说明 waiter 在这两步
             * 之间被取消了（Run 被 cancel）—— 留着一个没有人要过的提升，
             * 会让这个 Run 之后所有审批静默自动放行。
             */
            if (elevate && !answered) host().revokeRunElevation(p!.runId);
            return answered;
          })()
        : kind === "HANDOFF"
          ? host().answerPending(pendingMatch[1]!, {
              kind: "HANDOFF",
              ...(typeof body["note"] === "string" && body["note"] ? { note: body["note"] } : {}),
            })
          : kind === "QUESTION"
            ? host().answerPending(pendingMatch[1]!, {
                kind: "QUESTION",
                choice: String(body["choice"] ?? ""),
              })
            : false;
    // 【定】应答一个已经不在等的请求返回 409，不是 200。
    // 返回 200 会让界面以为「批准成功了」，而实际上那次执行早就按
    // 「等待被中断」处置掉了 —— 那是一个看起来有闸门、实际没有的界面。
    sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: "这个请求已经不在等待中" });
    return;
  }

  /**
   * 产物预览。
   *
   * 【定】按 **runId ＋ artifactId** 取，不收 `?path=`。
   * 原实现收任意 workspace 相对路径，实测能通过一个 workspace 内的 symlink
   * 把仓库根的 `.env`（含真实 `dashscope_api_key`）送进浏览器 ——
   * 详见 `RunHost.artifactPreview()` 的说明。
   */
  if (req.method === "GET" && path === "/api/artifact") {
    const runId = url.searchParams.get("runId") ?? "";
    const artifactId = url.searchParams.get("artifactId") ?? "";
    if (!isSafeId(runId) || !isSafeId(artifactId)) {
      sendJson(res, 400, { error: "runId / artifactId 形状不合法" });
      return;
    }
    const preview = await host().artifactPreview(runId, artifactId);
    if (!preview.ok) {
      sendJson(res, 404, { error: preview.why });
      return;
    }
    // 【定】截断要说出来。一个静默截断的预览会让人以为产物就是这么长。
    sendJson(res, 200, preview);
    return;
  }

  sendJson(res, 404, { error: `没有这个接口：${req.method} ${path}` });
}

// ═════════════════════════════════════════════════════════════════ SSE

/**
 * 事件流。**游标是 transcript sequence**（§5.4 原文），不是「第几条消息」。
 *
 * 这也是 D-2 的又一处消费点：事件与 transcript 共用一条序列，所以
 * 「我收到第 N 号了」这一个数字同时定位了两条轨道 —— 客户端重连时
 * 带一个 `since` 就够，不需要为两条轨道各带一个游标。
 */
function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  host: RunHost,
  runId: string,
  since: number,
): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const write = (e: RunEvent): void => {
    // SSE 的 id 用 sequence —— 浏览器断线重连会把它放进 Last-Event-ID，
    // 于是「重连游标」这件事连代码都不用写。
    res.write(`id: ${e.sequence}\ndata: ${JSON.stringify(e)}\n\n`);
  };

  const unsubscribe = host.subscribe(runId, since, write);
  const unsubPending = host.onPendingChange(() => {
    // 等人的请求变化不是 RunEvent（它不进事实轨道），用一条自定义事件通知界面。
    res.write(`event: pending\ndata: ${JSON.stringify(host.pending(runId))}\n\n`);
  });
  // 立刻推一次当前的等待，否则刷新页面时正在等的审批要等到下一次变化才出现。
  res.write(`event: pending\ndata: ${JSON.stringify(host.pending(runId))}\n\n`);

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  const cleanup = (): void => {
    clearInterval(keepAlive);
    unsubscribe();
    unsubPending();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

// ═══════════════════════════════════════════════════════════════ 静态

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(res: ServerResponse, path: string): void {
  const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
  const target = resolve(UI_DIR, rel);
  // 【定】不许爬出 UI 目录。`/../../.env` 是这个接口最容易被玩的一招。
  if (target !== UI_DIR && !target.startsWith(`${UI_DIR}/`)) {
    sendText(res, 403, "越界\n");
    return;
  }
  if (!existsSync(target)) {
    sendText(res, 404, "没有这个文件\n");
    return;
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
  });
  res.end(readFileSync(target));
}

// ═══════════════════════════════════════════════════════════════ 工具

/**
 * id 的形状：只允许 `run_xxx` / `art_xxx` 这类字面量。
 *
 * 【定】白名单而不是黑名单。黑名单要枚举 `..`、`/`、`%2f`、`%252f`、
 * 反斜杠、NUL…… 而白名单只需要说清楚合法的样子。本仓的 id 由
 * `RandomIdGenerator` 产出，形状是 `<prefix>_<hex>`，这个集合足够宽。
 */
function isSafeId(raw: string): boolean {
  return raw.length > 0 && raw.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(raw);
}

function isSafeModelAuditId(raw: string): boolean {
  return raw.length > 0 && raw.length <= 128 && /^[A-Za-z0-9_-]+$/.test(raw);
}

/**
 * SSE 的重连游标。
 *
 * 【定】**`Last-Event-ID` 优先于 query 里的 `since`。**
 *
 * 浏览器原生重连复用的是**建连时那个 URL**，`since` 停在当时的值；
 * 真正新鲜的游标在 `Last-Event-ID` 请求头里（我们每条事件都写了 `id:`）。
 * 服务原本从不读它 —— 也就是说 `server.ts` 里那句「重连游标这件事连代码
 * 都不用写」是假的，每次自动重连都会从旧游标整段重放。
 * 现在没炸只是因为客户端把重复事件消化成了一次全量重取。
 *
 * 顺带 NaN 防护：`?since=abc` 会让 `e.sequence > NaN` 恒假 —— 连上了，
 * 一条都不补发，而且**没有任何提示**。
 */
function readCursor(req: IncomingMessage, url: URL): number {
  const header = req.headers["last-event-id"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("since") ?? "0";
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    // 【定】上限。一个没有上限的 JSON 读取是本进程唯一一个可以被一句
    // curl 打爆内存的地方。
    // 语义上这是 413，但这条链路上外层只认 Error → 500。
    // 一个本地单人服务上 500 与 413 的差别不值得为它加一套错误类型体系，
    // 这里如实把上限写进消息里，让读到 500 的人知道发生了什么。
    if (total > 1_000_000) throw new Error("请求体过大（上限 1MB，语义上应为 413）");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((ok) => {
    server.closeAllConnections?.();
    server.close(() => ok());
  });
}
