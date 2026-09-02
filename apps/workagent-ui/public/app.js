/*
 * Layer 1（V05 §5）。原生 JS，没有构建步骤，没有依赖（阶段 4 决 2）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】两条硬约束，改这个文件前先读：
 *
 * 1. **一行 import 都不许有**（边界 grep 第 8 条）。界面只能拿到 HTTP 给它的
 *    东西 —— §5.5 保留的那条约束（UI 通过 RunEvent 流驱动、不直接读 Runtime
 *    内部状态）靠这条物理成立。
 *
 * 2. **不许用 innerHTML**（边界 grep 第 10 条）。这个界面上几乎所有文本都来自
 *    模型：工具入参、命令原文、总结、接管说明。审批面板是 EXECUTE 唯一的
 *    人工边界，而一条命令完全可以在自己的 description 里塞一段 HTML 把上面
 *    几行盖掉 —— 用户看到的是 `ls -la`，真正批准的是别的东西。
 *    CLI 那边同一件事的形态是剥 ANSI 与零宽字符（main.ts 的 forTerminal）。
 *    **一个可以被展示内容伪造的边界不再是边界。**
 * ══════════════════════════════════════════════════════════════════════
 */

"use strict";

// ═══════════════════════════════════════════════════════════ 会话 Token

/**
 * Token 从 URL 拿一次就从地址栏抹掉，转存 sessionStorage。
 *
 * 抹掉是因为地址栏会进浏览器历史、会被截图、会被贴进 issue；
 * 用 sessionStorage 而不是 localStorage 是因为它是**会话级**的
 * （§22.6 的原话），关掉标签页就没了，与服务端「进程重启换一个」对齐。
 */
const TOKEN = (() => {
  const u = new URL(location.href);
  const fromUrl = u.searchParams.get("t");
  if (fromUrl) {
    sessionStorage.setItem("atlas_token", fromUrl);
    u.searchParams.delete("t");
    history.replaceState(null, "", u.pathname + u.search);
    return fromUrl;
  }
  return sessionStorage.getItem("atlas_token") || "";
})();

const S = {
  service: null,
  workspaces: [],
  activeWorkspaceId: "",
  runs: [],
  runId: "",
  detail: null,
  pending: [],
  tab: "timeline",
  /** 展开状态按投影项 id 记 —— 全量重取后据此复原（见 projection.ts 结尾）。 */
  expanded: new Set(),
  stream: "",
  sse: null,
  refreshTimer: 0,
  /** Trace Inspector 的交互状态。换 Run 时重置，同一 Run 刷新时保留。 */
  traceUi: createTraceUi(""),
};

function createTraceUi(runId) {
  return {
    runId,
    mode: "turns",
    filter: "all",
    query: "",
    showStream: false,
    expanded: new Set(),
    touched: new Set(),
    presentation: null,
    dom: null,
    loadRevision: 0,
    paintRevision: 0,
    searchTimer: 0,
    composing: false,
  };
}

/**
 * 离开 Trace 或切换 Run 时只释放瞬时资源，保留同一 Run 的筛选与展开选择。
 * revision 同时作废仍在飞行的请求，避免旧响应落到之后重新挂载的外壳上。
 */
function disposeTraceInspector() {
  const ui = S.traceUi;
  clearTimeout(ui.searchTimer);
  ui.searchTimer = 0;
  ui.composing = false;
  ui.loadRevision += 1;
  ui.paintRevision += 1;
  ui.dom = null;
}

// ═══════════════════════════════════════════════════════════════ DOM

function el(tag, props, children) {
  const n = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = String(v); // 【定】只走 textContent
      /**
       * 【定】样式走 **CSSOM**，不走 `style="..."` 属性。
       *
       * 我们自己的 CSP 是 `style-src 'self'`（不含 `unsafe-inline`），
       * 而它同时管着**内联 style 属性**。实测：属性字符串老老实实进了 DOM
       * （`getAttribute("style") === "width:95%"`），但 `el.style.length === 0`
       * —— 声明被丢掉了。八条预算轴因此**全部渲染成满格**（`<i>` 是
       * display:block，没有宽度约束就占满父元素），一个说假话的白盒。
       *
       * CSSOM 赋值不受 CSP 约束（实测 `el.style.width = "42%"` 后 length 变 1）。
       * 边界 grep 第 11 条钉住这件事：`public/` 里不得再出现 style 属性写法。
       */
      else if (k === "css") Object.assign(n.style, v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children || []) {
    if (c === null || c === undefined || c === false) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function toast(msg, bad) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = bad ? "toast bad" : "toast";
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 4200);
}

// ═══════════════════════════════════════════════════════════════ API

async function api(path, opts) {
  const res = await fetch(path, {
    method: (opts && opts.method) || "GET",
    headers: Object.assign(
      { Authorization: "Bearer " + TOKEN },
      opts && opts.body ? { "Content-Type": "application/json" } : {},
    ),
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data.error || res.status + " " + res.statusText);
  return data;
}

// ═══════════════════════════════════════════════════════════ 顶栏与列表

function renderService() {
  const box = document.getElementById("svcinfo");
  clear(box);
  const s = S.service;
  if (!s) return;
  const item = (label, value, cls) =>
    el("span", { class: cls || "" }, [label + " ", el("b", { text: value })]);
  box.appendChild(item("端点", s.endpoint + "（" + s.endpointHost + "）"));
  box.appendChild(item("模型", s.modelId));
  box.appendChild(item("声明", s.profileId));
  // 工具数 × 180 是 §16.1【定·实测】的固定开销。摆在顶栏是刻意的：
  // 它是随时可读的过拟合警报 ——「一个 Case 一套工具」会直接反映在这个数字上。
  box.appendChild(item("工具", s.toolNames.length + " 个 / 起步价 ≈ " + s.fixedOverheadTokens + " token"));
  box.appendChild(item("workspace", s.workspaceRoot));
  /**
   * ── 两条档位轴的常驻徽章（ADR-0012）────────────────────────────────────
   *
   * 【定】档位必须**一直看得见**，不是提交任务时看一眼就算了。
   *
   * AUTO 档最危险的形态不是"批准了不该批准的"，是**忘了自己开着它** ——
   * 一个昨天为了打包图片开的 AUTO，今天跑一句"清理一下这个目录"。
   * 徽章是这件事唯一会说话的地方。
   *
   * 【定】读 `approvalModeId` / `executionPrivilege` 这两个机器字段，
   * **不解析** `approvalMode` 那句人话 —— 那句话为了读着顺改一个字，
   * 徽章就会静默停在错误的位置上。
   */
  box.appendChild(
    item(
      "审批",
      s.approvalModeId === "AUTO"
        ? "AUTO（不会停下来问）"
        : s.approvalModeId === "CONFIRM"
          ? "逐次确认"
          : "默认",
      s.approvalModeId === "AUTO" ? "warn" : "",
    ),
  );
  box.appendChild(
    item(
      "执行",
      s.executionPrivilege === "UNRESTRICTED" ? "UNRESTRICTED（无沙箱）" : "沙箱内",
      s.executionPrivilege === "UNRESTRICTED" ? "warn" : "",
    ),
  );
  /**
   * 【定】它排在 notices 之前，而且**不是** notices 的一条。
   * notices 是装配期的提示流水，会被划过去；这一条描述的是
   * 「此刻这台机器上没有闸门」，那不是一次性通知。
   */
  if (s.fullAccessWarning) box.appendChild(item("⚠️", s.fullAccessWarning, "warn"));
  /**
   * ── notice 的两层：`text` 常驻，`detail` 折叠 ──────────────────────────
   *
   * 【定】切分由**服务端的字段**决定，界面**不解析** `text` 里的换行。
   * 这与几行之上那条「读 `approvalModeId` 这个机器字段、不解析
   * `approvalMode` 那句人话」是同一条纪律，只是换了个方向：
   * 那边怕的是徽章停在错误档位，这边怕的是**该常驻的那句话被折进去**。
   *
   * 具体到 MCP 那条 notice：折进去的会是「⚠️ 输出目录固定在 …」，
   * 而 Run `run_6c3fec671ceb` 就是踩它翻的 —— `browser_evaluate` 把 32 张图的
   * base64 写进了 MCP 自己的输出目录，下一轮 `run_shell` 在 Run 的 workspace 里
   * `cat` 同一个相对路径，`No such file or directory`。
   */
  for (const n of s.notices || []) {
    box.appendChild(item("⚠️", n.text, "warn"));
    if (!n.detail) continue;
    box.appendChild(
      el("details", {}, [
        el("summary", { text: "工具原名清单（写 mcp.json 的 tools 段时展开）" }),
        el("div", { class: "body", text: n.detail }),
      ]),
    );
  }

  // 提交栏那个选择器要跟着服务端的真实档位走 —— 它是同一个开关的第二个入口，
  // 显示成别的值就等于界面上有两个互相矛盾的"当前档位"。
  const picker = document.getElementById("approvalmode");
  if (picker && s.approvalModeId) picker.value = s.approvalModeId;
  renderBudgetFields();
}

/**
 * 「新任务」栏里的逐 Run 预算覆盖。
 *
 * 【定】输入框由服务端的 `budgetDefaults` 生成，**不在这里硬编码一份轴表**。
 * 那份默认值一路来自 Runtime 的 `readBudgetAxes`（唯一的表）——
 * 自己列一份的后果是「表单说默认 20，实际在 30 撞墙」，
 * 而那种不一致在绿灯下完全看不出来。
 */
function renderBudgetFields() {
  const box = document.getElementById("budgetfields");
  if (!box) return;
  clear(box);
  const axes = (S.service && S.service.budgetDefaults) || [];
  for (const a of axes) {
    const label = (AXIS_LABEL[a.axis] || a.axis) + (a.unit === "ms" ? "（秒）" : "");
    // 【定】占位值走 `fmt` —— 与「预算」那一页显示的是同一个函数，
    // 于是"表单里写的数"与"页面上看到的数"不可能是两个单位。
    const dflt = a.limit === undefined ? "默认未设上限" : "默认 " + fmt(a.limit, a.unit);
    box.appendChild(
      el("div", {}, [
        el("label", { for: "bud_" + a.axis, text: label }),
        el("input", {
          id: "bud_" + a.axis,
          type: "number",
          min: "1",
          step: "1",
          "data-axis": a.axis,
          "data-unit": a.unit,
          placeholder: dflt,
        }),
      ]),
    );
  }
  if (axes.length > 0) {
    box.appendChild(
      el("p", {
        class: "hint",
        text: "只对这一次提交生效，随 Run 冻结；resume 用的仍是当初冻结的那一份。",
      }),
    );
  }
}

/**
 * 读表单里填了值的那几条，转成 `POST /api/runs` 的 `budgets`（按 axis id）。
 *
 * 单位换算走 `unfmt()`（`fmt` 的逆，就写在 `fmt` 旁边）。
 */
function readBudgetInputs() {
  const box = document.getElementById("budgetfields");
  if (!box) return undefined;
  const out = {};
  for (const input of box.querySelectorAll("input[data-axis]")) {
    const raw = input.value.trim();
    if (raw === "") continue; // 【定】空 = 没说 = 用默认值，不是 0
    out[input.getAttribute("data-axis")] = unfmt(Number(raw), input.getAttribute("data-unit"));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 工作空间选择器。
 *
 * 【定】把 **dbPath** 也显示出来。它是「这个 workspace 的 Run 存在哪」的唯一
 * 事实，而阶段 4 收口批刚因为「`--db` 与 `--workspace` 分开、同一个库里躺着
 * 不同目录的 Run」吃过一次亏（S4-5）。摆在眼前，那种错配一眼就能看见。
 */
function renderWorkspaces() {
  const picker = document.getElementById("wspicker");
  const pathLine = document.getElementById("wspath");
  clear(picker);
  for (const w of S.workspaces) {
    const opt = el("option", { value: w.id, text: w.name + "　" + w.realPath });
    if (w.id === S.activeWorkspaceId) opt.selected = true;
    picker.appendChild(opt);
  }
  if (S.workspaces.length === 0) {
    picker.appendChild(el("option", { text: "（还没有登记任何工作空间）" }));
  }
  const active = S.workspaces.find((w) => w.id === S.activeWorkspaceId);
  clear(pathLine);
  if (active) {
    pathLine.appendChild(el("div", { text: active.realPath }));
    pathLine.appendChild(el("div", { class: "muted", text: "库 " + active.dbPath }));
  }
}

async function switchWorkspace(id) {
  if (!id || id === S.activeWorkspaceId) return;
  try {
    const r = await api("/api/workspaces/" + encodeURIComponent(id) + "/activate", { method: "POST" });
    // 【定】切换之后必须把当前选中的 Run 清掉 —— 另一个 workspace 有它自己的库，
    // 旧 runId 在那边根本不存在，留着会让详情区停在一个查不到的 Run 上。
    S.runId = "";
    S.detail = null;
    if (S.sse) S.sse.close();
    document.getElementById("runview").hidden = true;
    document.getElementById("empty").hidden = false;
    await refresh();
    /**
     * 【定】warning 要用**错误样式**显示，虽然切换是成功的。
     *
     * 它说的是「MCP 的工作目录没有跟着切」——一个不说出来就完全看不见、
     * 只会表现为「文件莫名其妙读不到」的事实。用普通 toast 一闪而过，
     * 等于没说。
     */
    if (r && r.warning) toast(r.warning, true);
    else toast("已切换工作空间");
  } catch (err) {
    // 有 Run 在跑时服务端回 409 —— 那是一个用户能自己解决的冲突，如实转述。
    toast(err.message, true);
    renderWorkspaces(); // 把下拉框拨回真正激活的那个
  }
}

function renderRuns() {
  const list = document.getElementById("runlist");
  clear(list);
  for (const r of S.runs) {
    const li = el(
      "li",
      { class: r.runId === S.runId ? "active" : "", onclick: () => selectRun(r.runId) },
      [
        el("div", {}, [
          el("span", { class: "rid", text: r.runId }),
          " ",
          el("span", { class: "status " + r.status, text: r.status }),
          r.liveInThisProcess ? el("span", { class: "chip ok", text: "在跑" }) : null,
        ]),
        el("div", { class: "rtask", text: r.task }),
      ],
    );
    list.appendChild(li);
  }
  if (S.runs.length === 0) list.appendChild(el("li", { class: "muted", text: "（库里还没有 Run）" }));
}

// ═══════════════════════════════════════════════════════════ Run 视图

/**
 * 哪些状态可以 resume。
 *
 * 【定】与 Runtime 的生命周期闸门口径一致（facade 拒绝 COMPLETED / FAILED）。
 * 【定】UI **不拥有**这个判断（§5.2「合法状态迁移不由 UI 拥有」）——
 * 它只是不去点一个必错的按钮；真正的裁决仍然在 Runtime，点了照样会被拒。
 */
const RESUMABLE = ["RUNNING", "CANCELLED", "RECOVERY_REQUIRED",
  "WAITING_FOR_APPROVAL", "WAITING_FOR_INTERACTION"];

const TABS = [
  ["timeline", "时间线"],
  ["turns", "逐轮解剖"],
  ["budget", "预算"],
  ["artifacts", "产物"],
  ["trace", "Trace"],
  ["recovery", "恢复"],
];

function renderRunbar() {
  const bar = document.getElementById("runbar");
  clear(bar);
  const d = S.detail;
  if (!d) return;

  bar.appendChild(el("span", { class: "rid", text: d.runId }));
  bar.appendChild(el("span", { class: "status " + d.status, text: d.status }));
  /**
   * 【定】「盘上的状态」与「本进程里有没有人在跑」是**两个事实**，分开显示。
   *
   * 决 6：Layer 2 不得把看起来不对的状态「修正」成 FAILED —— 那会让它成为
   * 第二个状态推进者。所以这里如实说两句，让人自己得出「上次崩了」。
   */
  if (!d.liveInThisProcess && d.status === "RUNNING") {
    bar.appendChild(
      el("span", { class: "chip warn", text: "本进程没有在跑它（上次可能崩了，可以 resume）" }),
    );
  }
  bar.appendChild(el("span", { class: "task", text: d.task }));

  const actions = el("div", { class: "actions" }, []);
  // 【定】命令带上**渲染这一刻**的 runId，不读全局 S.runId。
  // `selectRun()` 先改全局再异步刷新，中间那一小段时间里按钮显示的还是上一个
  // Run，点下去却会发给新的那个 —— 取消 / 插话 / resume 都是有副作用的命令。
  const rid = d.runId;
  if (d.liveInThisProcess) {
    actions.appendChild(
      el("button", { class: "danger", text: "取消", onclick: () => cmd(rid, "/cancel") }, []),
    );
    actions.appendChild(
      el("button", {
        text: "插话",
        onclick: async () => {
          const text = prompt("插一句话（下一轮编帧时进入上下文）：");
          if (text) await cmd(rid, "/interject", { text });
        },
      }),
    );
  } else if (RESUMABLE.includes(d.status)) {
    /**
     * 【定】只对**可恢复**的状态显示 resume。
     *
     * 界面原本对所有非 live 的 Run 都显示它，包括 COMPLETED / FAILED ——
     * 而 Runtime 的生命周期闸门对终态一律抛错（重跑终态 Run 会重复已经结算过的
     * 副作用）。于是这个按钮的语义是「点了必错」，还曾经把服务卡死过。
     * 值域抄 `RunStatus`，与 `--list-runs` 打印的那句提示保持一致。
     */
    actions.appendChild(el("button", { text: "resume", onclick: () => cmd(rid, "/resume") }, []));
  } else {
    actions.appendChild(
      el("span", { class: "chip", text: "终态，不可 resume（重跑会重复已结算的副作用）" }),
    );
  }
  bar.appendChild(actions);
  bar.appendChild(
    el("span", {
      class: "kv",
      text:
        "轨道：transcript " + d.tracks.transcriptEntries + " 条 / 事件 " + d.tracks.events + " 条",
    }),
  );
  bar.appendChild(renderRunSummary(d));

  /**
   * 服务侧驱动这个 Run 时抛出的错误（多半来自 `resume()` 的闸门：端点不一致、
   * 终态 Run、缺恢复决策）。
   *
   * 【定】它必须显示出来。那些错误发生在 HTTP 响应**之后**（Run 在后台跑），
   * 所以点 resume 的那次 POST 是 200 —— 不显示的话，用户看到的是
   * 「点了没反应」，而错误只存在于服务端一个没人读的字段里。
   */
  if (d.serviceError) {
    bar.appendChild(el("div", { class: "err-banner", text: "服务侧错误：" + d.serviceError }));
  }
}

/**
 * 顶部摘要只解释已有事实，不重新结算 Outcome。
 *
 * 【定】原始枚举必须保留：中文是给人读的，枚举是白盒追溯 Runtime 判定的锚点。
 * `COMPLETED_WITH_LIMITS` 也不能笼统翻译成「预算受限」—— 它最常见的来源是
 * recoveryItems / 未完成验证，而真正的预算终止有独立的 `BUDGET_EXHAUSTED`。
 */
function outcomePresentation(outcome) {
  if (!outcome) return undefined;
  const present = (value) => ({ ...value, code: outcome.kind });
  const recovery = outcome.recoveryItems || [];
  const incomplete = outcome.incompleteItems || [];
  const firstRecovery = recovery[0];
  const firstIncomplete = incomplete[0];

  switch (outcome.kind) {
    case "SUCCESS":
      return present({
        title: "任务已完成",
        tone: "ok",
        detail: "Runtime 已按现有交付与验证事实完成结算。",
      });
    case "COMPLETED_WITH_LIMITS":
      if (firstRecovery) {
        return present({
          title: "任务已完成，但有待确认项",
          tone: "warn",
          detail:
            "有 " + recovery.length + " 个操作的副作用状态待确认：" +
            firstRecovery.what + "（" + firstRecovery.sideEffectState + "）" +
            (recovery.length > 1 ? "，另有 " + (recovery.length - 1) + " 项" : ""),
          note: "此结果不表示达到轮次或模型调用上限。",
        });
      }
      return present({
        title: "任务已完成，但仍有未达成项",
        tone: "warn",
        detail: firstIncomplete
          ? "仍有 " + incomplete.length + " 项未完全达成或验证：" +
            firstIncomplete.what + "（" + firstIncomplete.why + "）"
          : "Runtime 完成了任务，但没有将本次结算判定为完全成功。",
        note: "此结果不表示达到轮次或模型调用上限。",
      });
    case "USER_REJECTED":
      return present({
        title: "部分操作被用户拒绝",
        tone: "warn",
        detail: firstIncomplete ? firstIncomplete.what + "（" + firstIncomplete.why + "）" : "任务未完全执行。",
      });
    case "BUDGET_EXHAUSTED":
      return present({
        title: "执行因预算或资源保护停止",
        tone: "warn",
        detail: "请结合下方冻结预算和时间线中的终止事件确认具体原因。",
      });
    case "CONTEXT_EXHAUSTED":
      return present({ title: "模型上下文容量已用尽", tone: "warn", detail: "任务未能继续执行。" });
    case "QUOTA_EXHAUSTED":
      return present({ title: "模型调用配额已用尽", tone: "warn", detail: "任务未能继续执行。" });
    case "CANCELLED":
      return present({ title: "任务已取消", tone: "neutral", detail: "本 Run 已停止，不会继续执行。" });
    case "FAILED":
      return present({
        title: "任务执行失败",
        tone: "bad",
        detail: firstIncomplete ? firstIncomplete.what + "（" + firstIncomplete.why + "）" : "请查看时间线与 Trace 定位原因。",
      });
    default:
      return present({ title: "任务已结算", tone: "neutral", detail: "请结合原始 Outcome 枚举查看结果。" });
  }
}

/**
 * 核心预算卡的纯展示模型。
 *
 * 【定】只读 detail.budgetAxes，不从 turn 表、timeline 或模型消息重新求和。
 * `budgetAxes` 的 used 来自 inspect，limit 来自这个 Run 冻结的 RunSpec；重新算一份
 * 会把白盒界面变成第二个预算事实源。
 */
function coreBudgetPresentation(budgetAxes) {
  const core = ["turns", "modelCalls", "toolCalls", "activeWallClockMs"];
  const byAxis = new Map((budgetAxes || []).map((a) => [a.axis, a]));
  return core.map((axis) => {
    const a = byAxis.get(axis);
    if (!a) return { axis, label: AXIS_LABEL[axis] || axis, missing: true };
    const limited = a.limit !== undefined;
    const ratio = limited && a.limit > 0 ? a.used / a.limit : undefined;
    return {
      axis,
      label: AXIS_LABEL[axis] || axis,
      used: a.used,
      limit: a.limit,
      unit: a.unit,
      value: fmt(a.used, a.unit) + " / " + (limited ? fmt(a.limit, a.unit) : "未设上限"),
      percent: ratio === undefined ? "未设上限" : Math.round(ratio * 100) + "%",
      ratio: ratio === undefined ? 0 : Math.min(1, ratio),
      tone: ratio === undefined ? "unset" : ratio >= 1 ? "hard" : ratio >= 0.8 ? "soft" : "normal",
    };
  });
}

function renderRunSummary(d) {
  const presentation = outcomePresentation(d.outcome);
  const result = presentation
    ? el("div", { class: "result-summary " + presentation.tone }, [
        el("div", { class: "summary-heading" }, [
          el("strong", { text: presentation.title }),
          el("span", { class: "chip " + presentation.tone, text: presentation.code }),
        ]),
        el("div", { class: "summary-detail", text: presentation.detail }),
        presentation.note ? el("div", { class: "summary-note", text: presentation.note }) : null,
      ])
    : el("div", { class: "result-summary neutral" }, [
        el("div", { class: "summary-heading" }, [
          el("strong", { text: d.liveInThisProcess ? "任务正在执行" : "任务尚未结算" }),
          el("span", { class: "chip", text: d.status }),
        ]),
        el("div", { class: "summary-detail", text: "预算用量会随 Run 事实实时更新。" }),
      ]);

  const budget = el("div", { class: "budget-summary" }, []);
  budget.appendChild(
    el("div", { class: "budget-summary-head" }, [
      el("span", {}, [
        el("strong", { text: "本 Run 冻结预算" }),
        " ",
        el("span", { class: "mono muted", text: d.spec.runSpecId }),
      ]),
      el("button", {
        class: "link",
        type: "button",
        text: "查看全部预算",
        onclick: () => {
          S.tab = "budget";
          renderTabs();
          renderView();
        },
      }),
    ]),
  );
  budget.appendChild(
    el(
      "div",
      { class: "core-budget-grid" },
      coreBudgetPresentation(d.budgetAxes).map((m) =>
        el("div", { class: "budget-metric " + (m.tone || "unset") }, [
          el("span", { class: "metric-label", text: m.label }),
          el("strong", { class: "mono metric-value", text: m.missing ? "暂无读数" : m.value }),
          el("span", {
            class: "metric-meta",
            text: m.missing ? "budgetAxes 未返回该轴" : "已用 / 上限 · " + m.percent,
          }),
          el("div", { class: "bar" }, [
            el("i", { class: m.tone || "unset", css: { width: (m.ratio || 0) * 100 + "%" } }),
          ]),
        ]),
      ),
    ),
  );

  return el("section", { class: "run-summary" }, [result, budget]);
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  clear(nav);
  for (const [key, label] of TABS) {
    nav.appendChild(
      el("button", {
        class: S.tab === key ? "active" : "",
        text: label,
        onclick: () => {
          if (S.tab === key) return;
          if (S.tab === "trace") disposeTraceInspector();
          S.tab = key;
          renderTabs();
          renderView();
        },
      }),
    );
  }
}

function renderView() {
  const view = document.getElementById("view");
  // 完整渲染只发生在进入 Tab、切换 Run 等场景；后台 Trace 刷新走局部更新。
  if (S.traceUi.dom) disposeTraceInspector();
  clear(view);
  const d = S.detail;
  if (!d) return;
  if (S.tab === "timeline") renderTimeline(view, d);
  else if (S.tab === "turns") renderTurns(view, d);
  else if (S.tab === "budget") renderBudget(view, d);
  else if (S.tab === "artifacts") renderArtifacts(view, d);
  else if (S.tab === "trace") renderTrace(view, d);
  else if (S.tab === "recovery") renderRecovery(view, d);
}

// ── 时间线

function renderTimeline(view, d) {
  if (S.stream) {
    view.appendChild(el("div", { class: "entry ASSISTANT_MESSAGE" }, [
      el("div", { class: "head" }, [el("span", { class: "tag", text: "正在输出" })]),
      el("div", { class: "body stream", text: S.stream }),
    ]));
  }
  for (const e of d.timeline) {
    view.appendChild(renderEntry(e));
  }
  if (d.timeline.length === 0) {
    view.appendChild(el("p", { class: "muted", text: "（还没有可投影的内容）" }));
  }
}

function renderEntry(e) {
  const head = el("div", { class: "head" }, [
    // 【定】序号必须露出来。它是两条轨道的共同游标（D-2），
    // 也是任何一条界面内容「从哪来的」的唯一凭据。
    el("span", { class: "seq", text: "#" + e.source.sequence }),
    el("span", { class: "tag", text: e.source.track === "TRANSCRIPT" ? "transcript" : "event" }),
    e.turn !== undefined ? el("span", { class: "tag", text: "T" + e.turn }) : null,
  ]);
  const box = el("div", { class: "entry " + e.kind + (e.severity ? " " + e.severity : "") }, [head]);

  if (e.kind === "USER_MESSAGE") {
    head.appendChild(
      el("span", {
        class: "tag",
        text: e.origin === "TASK" ? "任务" : e.origin === "INTERJECTION" ? "插话" : "系统提示",
      }),
    );
    box.appendChild(el("div", { class: "body", text: e.text }));
  } else if (e.kind === "ASSISTANT_MESSAGE") {
    head.appendChild(el("span", { class: "tag", text: "模型" }));
    if (e.reasoningChars > 0) {
      // D-3：推理块被回传、被计费，却不出现在 count_tokens 里。
      // 不显示原文（那是草稿），但长度必须可见 —— 否则那笔账继续隐形。
      head.appendChild(el("span", { class: "chip", text: "推理 " + e.reasoningChars + " 字" }));
    }
    box.appendChild(el("div", { class: "body", text: e.text }));
  } else if (e.kind === "TOOL_ACTIVITY") {
    renderToolActivity(box, head, e);
  } else if (e.kind === "APPROVAL") {
    head.appendChild(el("span", { class: "tag", text: "审批" }));
    head.appendChild(
      e.approved === undefined
        ? el("span", { class: "chip warn", text: "等待中" })
        : el("span", { class: "chip " + (e.approved ? "ok" : "bad"), text: e.approved ? "已批准" : "已拒绝" }),
    );
    /**
     * 【定】**谁**做的这个决定（ADR-0012）。
     *
     * 少了它，一条 AUTO 档跑完的 Run 与一条被你逐步审视过的 Run 在这条
     * 时间线上完全一样 —— 而白盒界面的全部意义就是不让这种事发生。
     *
     * 【定】`UNDECLARED` 要如实显示成「未声明」，不许美化成「已批准」。
     * 那是 decider 没说，不是有人说过。
     */
    if (e.decidedBy !== undefined) {
      head.appendChild(
        el("span", {
          class: "chip " + (e.decidedBy === "HUMAN" ? "ok" : "warn"),
          text:
            e.decidedBy === "HUMAN"
              ? "你本人"
              : e.decidedBy === "AUTO"
                ? "自动（AUTO 档 / 不再问）"
                : e.decidedBy === "AUTO_GRANT"
                  ? "自动（默认档位放行）"
                  : "来源未声明",
        }),
      );
    }
    box.appendChild(el("div", { class: "body", text: e.effect + "｜" + e.reason }));
    if (e.decisionReason) box.appendChild(el("div", { class: "kv", text: e.decisionReason }));
  } else if (e.kind === "INTERACTION") {
    head.appendChild(el("span", { class: "tag", text: "人工接管" }));
    head.appendChild(el("span", { class: "toolname", text: e.toolName }));
    if (e.answered !== undefined) {
      // 【定】措辞跟着 §20.3 走：`answered` 说的是「人应答了没有」，
      // **不是**「任务成功了没有」。写成「已完成」会把这条纪律教反。
      head.appendChild(
        el("span", {
          class: "chip " + (e.answered ? "ok" : "bad"),
          text: e.answered ? "人已应答（系统仍会重新核实）" : "没有人应答",
        }),
      );
    }
    box.appendChild(el("div", { class: "body", text: e.detail }));
  } else if (e.kind === "ARTIFACT") {
    head.appendChild(el("span", { class: "tag", text: "产物" }));
    head.appendChild(el("span", { class: "toolname", text: e.logicalId + " v" + e.version }));
    head.appendChild(el("span", { class: "chip", text: e.role }));
    if (e.verified) {
      head.appendChild(
        el("span", {
          class: "chip " + (e.verified.ok ? "ok" : "bad"),
          // 【定】`checksRun` 为空 ≠ 通过。这里必须说出来，
          // 否则「我们验过了」会被一个空集合背书。
          text: e.verified.checksRun.length === 0
            ? "没有适用的检查器"
            : (e.verified.ok ? "通过" : "未通过") + "：" + e.verified.checksRun.join(", "),
        }),
      );
      box.appendChild(el("div", { class: "kv", text: e.verified.detail }));
    } else {
      head.appendChild(el("span", { class: "chip", text: "还没验过" }));
    }
  } else if (e.kind === "SYSTEM_NOTICE") {
    head.appendChild(el("span", { class: "tag", text: e.eventType }));
    box.appendChild(el("div", { class: "body", text: e.text }));
  }
  return box;
}

function renderToolActivity(box, head, e) {
  head.appendChild(el("span", { class: "toolname", text: e.toolName }));
  if (e.effect) head.appendChild(el("span", { class: "chip", text: e.effect }));
  if (e.status) {
    head.appendChild(
      el("span", { class: "chip " + (e.status === "SUCCEEDED" ? "ok" : "bad"), text: e.status }),
    );
  }
  if (e.sideEffectState) head.appendChild(el("span", { class: "chip", text: "副作用 " + e.sideEffectState }));
  if (e.durationMs !== undefined) head.appendChild(el("span", { class: "chip", text: e.durationMs + "ms" }));
  if (e.approval) {
    head.appendChild(
      el("span", {
        class: "chip " + (e.approval.approved ? "ok" : e.approval.approved === false ? "bad" : "warn"),
        text: e.approval.approved === undefined ? "等审批" : e.approval.approved ? "已批准" : "被拒绝",
      }),
    );
  }
  if (e.externalized) {
    // 【定】外置必须显式说出来。transcript 上它长得像「工具只返回了这么点」，
    // 而实际有几百 KB 躺在 blob 里 —— 两者在界面上不能长一样。
    head.appendChild(
      el("span", {
        class: "chip warn",
        text: "已外置 " + e.externalized.ref + "（" + e.externalized.sizeBytes + " 字节 ≈ " +
          e.externalized.approxTokens + " token）",
      }),
    );
  }
  if (e.resumeBranch) {
    head.appendChild(
      el("span", {
        class: "chip warn",
        text: "恢复分支 " + e.resumeBranch.branch +
          (e.resumeBranch.hasPreFingerprint ? "（有执行前指纹）" : "（无执行前指纹）"),
      }),
    );
  }
  /**
   * 护栏 3：这次调用带了哪些风险事实、把数据发去了哪里。
   *
   * 【定】它必须显示。`policy.ts` 把「让外发在 Trace 上可审计」列为
   * 「越界读放行」的三条护栏之一，而在此之前 riskFacts / dataMovement
   * 从来没有离开过 Resolver 的返回值 —— 一条撑着已生效决定的依据，
   * 在盘上和界面上都查不到。
   */
  if (e.riskFacts && e.riskFacts.length) {
    box.appendChild(el("div", { class: "kv", text: "风险事实：" + e.riskFacts.join("、") }));
  }
  if (e.dataMovement) {
    box.appendChild(
      el("div", { class: "kv warn", text:
        "数据外发 → " + e.dataMovement.destination + "（" + e.dataMovement.scope + "）" }),
    );
  }
  if (e.rejected) {
    box.appendChild(el("div", { class: "body", text: "被拒绝（" + e.rejected.stage + "）：" + e.rejected.reason }));
  }
  if (e.verification) {
    box.appendChild(
      el("div", { class: "kv" }, [
        el("b", {
          text: "验证 " + e.verification.status + (e.verification.required ? "（必需）" : "（可选）"),
        }),
        " " + e.verification.detail,
      ]),
    );
  }
  for (const p of e.progress) box.appendChild(el("div", { class: "kv", text: "进展：" + p }));

  const open = S.expanded.has(e.id);
  const details = el("details", open ? { open: true } : {}, [
    el("summary", { text: "入参与结果" }),
  ]);
  details.addEventListener("toggle", () => {
    if (details.open) S.expanded.add(e.id);
    else S.expanded.delete(e.id);
  });
  details.appendChild(
    el("pre", { text: e.input === undefined ? "（事件流里没有入参 —— 这条 Run 缺 transcript？）" : JSON.stringify(e.input, null, 2) }),
  );
  if (e.result !== undefined) {
    details.appendChild(
      el("pre", { class: e.resultIsError ? "bad" : "", text: truncate(e.result, 8000) }),
    );
  }
  box.appendChild(details);
}

// ── 逐轮解剖

function renderTurns(view, d) {
  const table = el("table", {}, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "轮" }),
        el("th", { text: "帧（条目 / token / 固定开销）" }),
        el("th", { text: "不可信" }),
        el("th", { text: "usage（in / billed / out）" }),
        el("th", { text: "stop" }),
        el("th", { text: "耗时" }),
        el("th", { text: "工具" }),
        el("th", { text: "迁移" }),
        el("th", { text: "轮末累计（billed / 工具 / active）" }),
      ]),
    ]),
  ]);
  const tb = el("tbody", {}, []);
  for (const t of d.turns) {
    const f = t.frame;
    const calls = t.modelCalls || [];
    // 【定】一轮可能有多次模型调用（输出预算恢复 / 模型错误重试）。
    // 表格行显示最后一次，多出来的在下面单独列 —— 否则这一行的 usage
    // 与「轮末累计」对不上，而那正是白盒要解释的东西。
    const m = calls.length > 0 ? calls[calls.length - 1] : null;
    const b = t.budgetAfter;
    tb.appendChild(
      el("tr", {}, [
        el("td", { class: "num", text: t.turn }),
        el("td", { class: "num", text: f ? f.items + " / " + f.totalTokens + " / " + f.fixedOverheadTokens : "—" }),
        // 【定】不可信内容流入是审计事实（事件类型的注释原话）。
        // 它是 fetch_url 之后审计外泄链路的起点，必须在界面上有一列。
        el("td", { text: f ? (f.hasExternalUntrusted ? "是（" + f.untrustedItems + " 条）" : "否") : "—" }),
        el("td", { class: "num", text: m ? m.inputTokens + " / " + m.billedInputTokens + " / " + m.outputTokens : "—" }),
        el("td", { text: m ? m.stopReason : "—" }),
        el("td", { class: "num", text: m ? m.durationMs + "ms" : "—" }),
        el("td", { text: t.toolNames.join(", ") || "—" }),
        el("td", { text: t.transition || "—" }),
        el("td", { class: "num", text: b ? b.billedInputTokens + " / " + b.toolCalls + " / " + Math.round(b.activeWallClockMs / 1000) + "s" : "—" }),
      ]),
    );
    if (calls.length > 1) {
      tb.appendChild(
        el("tr", {}, [
          el("td", {}),
          el("td", {
            colspan: 8,
            class: "muted",
            text:
              "本轮共 " + calls.length + " 次模型调用（输出预算恢复 / 重试）：" +
              calls
                .map((c, i) => "#" + (i + 1) + " " + c.billedInputTokens + "→" + c.outputTokens + " " + c.stopReason)
                .join("；"),
          }),
        ]),
      );
    }
    for (const c of t.compaction) {
      tb.appendChild(
        el("tr", {}, [
          el("td", {}),
          el("td", { colspan: 8, class: "muted", text: "压缩：释放 " + c.freedTokens + " token（" + c.reason + "）" }),
        ]),
      );
    }
  }
  table.appendChild(tb);
  view.appendChild(table);
  if (d.turns.length === 0) {
    view.appendChild(
      el("p", { class: "muted", text: "（没有事件轨道 —— 逐轮解剖完全来自事件流，这个 Run 大概是 --no-trace 跑的）" }),
    );
  }
  view.appendChild(el("h4", { text: "冻结的 system prompt" }));
  view.appendChild(el("pre", { text: d.spec.systemPrompt }));
}

// ── 预算

const AXIS_LABEL = {
  turns: "轮次",
  activeWallClockMs: "活跃墙钟",
  totalWallClockMs: "总墙钟（含停机）",
  modelCalls: "模型调用",
  toolCalls: "工具调用",
  billedInputTokens: "输入 token（含缓存）",
  outputTokens: "输出 token",
  consecutiveFailures: "连续失败",
};

function renderBudget(view, d) {
  for (const a of d.budgetAxes) {
    const ratio = a.limit ? Math.min(1, a.used / a.limit) : 0;
    const cls = ratio >= 1 ? "hard" : ratio >= 0.8 ? "soft" : "";
    view.appendChild(
      el("div", { class: "axis" + (a.limit === undefined ? " unset" : "") }, [
        el("div", { class: "label" }, [
          el("span", { text: (AXIS_LABEL[a.axis] || a.axis) + "（" + a.axis + "）" }),
          el("span", {
            class: "mono",
            text: a.limit === undefined
              // 【定】「没设上限」不是「无限」，也不是 0。maxTotalWallClockMs 默认为空
              // 是刻意的（给它默认值 = 隔夜 resume 第一次迭代就撞墙）。
              ? fmt(a.used, a.unit) + " / 未设上限"
              : fmt(a.used, a.unit) + " / " + fmt(a.limit, a.unit),
          }),
        ]),
        el("div", { class: "bar" }, [el("i", { class: cls, css: { width: ratio * 100 + "%" } })]),
      ]),
    );
  }
  view.appendChild(el("h4", { text: "未达成的必需项（按成因）" }));
  const causes = Object.keys(d.snapshot.unmetCauseCounts);
  view.appendChild(
    el("p", {
      class: causes.length ? "" : "muted",
      text: causes.length
        ? causes.map((k) => k + " × " + d.snapshot.unmetCauseCounts[k]).join("、")
        : "（无）",
    }),
  );
  view.appendChild(el("h4", { text: "审批策略（随 RunSpec 冻结）" }));
  view.appendChild(
    el("p", { class: "mono", text: d.spec.approvalPolicy.requiresApprovalFor.join(", ") || "（无）" }),
  );
  /**
   * ── 执行特权：**这个 Run 当时**的档位（ADR-0012，二次评审 P2-5）─────────
   *
   * 【定】它与顶栏那个「当前服务档位」是**两栏**，且当两者不同时必须说出来。
   *
   * 只显示当前档位的话，重启换过档之后，用它去解释一条历史 Run 的答案是错的
   * —— 而那个错看起来完全正常（一个合理的值，只是属于另一个时刻）。
   * 这与 `liveInThisProcess` 那条同源：**如实显示两个事实，让人自己比对**，
   * 投影不替他合并。
   */
  const frozenPriv = d.spec.executionPrivilege;
  const currentPriv = S.service && S.service.executionPrivilege;
  view.appendChild(el("h4", { text: "执行特权（随 RunSpec 冻结）" }));
  view.appendChild(
    el("p", {
      class: "mono " + (frozenPriv === "UNRESTRICTED" ? "warn" : ""),
      text:
        (frozenPriv === "UNRESTRICTED" ? "UNRESTRICTED（这个 Run 当时没有沙箱）" : "SANDBOXED") +
        (currentPriv && currentPriv !== frozenPriv
          ? "　⚠️ 当前服务是 " + currentPriv + "，与它不同 —— 别拿现在的档位解释这个 Run"
          : ""),
    }),
  );
  /**
   * 入口身份。它在这里不是为了好看 —— `RunSpec.origin` 曾经有一个生产者
   * （写死 CLI）、零消费者，于是「Web 起的 Run 自称 CLI」整整一个阶段
   * 没有任何东西能与它矛盾。**把它显示出来就是给它一个消费者。**
   */
  view.appendChild(el("h4", { text: "入口（RunSpec.origin）" }));
  view.appendChild(el("p", { class: "mono", text: d.spec.origin || "（未知）" }));
}

function fmt(n, unit) {
  if (unit === "ms") return Math.round(n / 1000) + "s";
  return String(n);
}

/**
 * `fmt` 的逆 —— 把用户在「新任务」栏里填的数换回 `RunBudgets` 的原始单位。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它必须紧挨着 `fmt`，两个函数一起改。
 *
 * 「预算」那一页用 `fmt` 把 ms 渲染成秒（600000 → "600s"）。表单如果收原始 ms，
 * 同一条轴在两块屏幕上就差 1000 倍 —— 而**两边都不会报错**：用户照着页面上的
 * "600s" 在表单里填 600，得到一个 600 毫秒的墙钟预算，然后看着 Run 立刻撞墙，
 * 完全不知道发生了什么。
 *
 * 这是本仓反复记的那类失败：一个没有任何征兆的单位错配。
 * `verify:ui` 有一条判据把「填 600 → spec.budgets 里是 600000」钉住。
 * ══════════════════════════════════════════════════════════════════════
 */
function unfmt(n, unit) {
  return unit === "ms" ? n * 1000 : n;
}

// ── 产物

function renderArtifacts(view, d) {
  /**
   * 【定】「登记过的产物」与「Runtime 判定交付了的产物」是两件事，必须分开显示。
   *
   * 此前界面只有前者，于是 `deliveredArtifactIds`（§17 的结论本身）
   * 在白盒界面上**根本看不到** —— 而这个界面存在的理由就是把结论摆出来。
   * 一个 INTERMEDIATE 产物和一个真正的交付物，在旧界面上长得一模一样。
   */
  const delivered = new Set((d.outcome && d.outcome.deliveredArtifactIds) || []);
  view.appendChild(el("h4", { text: "Runtime 判定的交付集合（deliveredArtifactIds）" }));
  view.appendChild(
    el("p", {
      class: delivered.size ? "mono" : "muted",
      text: delivered.size
        ? [...delivered].join("、")
        : d.outcome
          ? "（空 —— 这个 Run 没有任何通过检查的 DELIVERABLE）"
          : "（还没结算）",
    }),
  );
  if (d.artifacts.length === 0) {
    view.appendChild(el("p", { class: "muted", text: "（这个 Run 没有登记过产物）" }));
    return;
  }
  for (const a of d.artifacts) {
    const head = el("div", { class: "head" }, [
      el("span", { class: "toolname", text: a.logicalId }),
      el("span", { class: "chip", text: "v" + a.version }),
      el("span", { class: "chip", text: a.role }),
      delivered.has(a.artifactId) ? el("span", { class: "chip ok", text: "已交付" }) : null,
      el("span", { class: "chip", text: a.kind }),
      el("span", { class: "chip", text: a.sizeBytes + " 字节" }),
      // 【定】三态：没验过 / 验过通过 / 验过没通过。undefined 不得显示成「否」。
      a.verified === undefined
        ? el("span", { class: "chip", text: "还没验过" })
        : el("span", { class: "chip " + (a.verified ? "ok" : "bad"), text: a.verified ? "已验证" : "未通过" }),
    ]);
    const box = el("div", { class: "entry ARTIFACT" }, [head]);
    if (a.verifyDetail) box.appendChild(el("div", { class: "kv", text: a.verifyDetail }));
    box.appendChild(el("div", { class: "kv mono", text: "hash " + a.contentHash }));
    if (a.path) {
      const pre = el("pre", { text: "（点开看磁盘上那一份）" });
      const drift = el("div", { class: "kv" });
      const det = el("details", {}, [el("summary", { text: a.path }), drift, pre]);
      det.addEventListener("toggle", async () => {
        if (!det.open || det.dataset.loaded) return;
        det.dataset.loaded = "1";
        try {
          /**
           * 【定】按 **runId ＋ artifactId** 取，不传路径。
           *
           * 旧接口收 `?path=` 任意 workspace 相对路径 —— 实测能经一个
           * workspace 内的 symlink 把仓库根的 .env（含真实凭证）读出来。
           */
          const r = await api(
            "/api/artifact?runId=" + encodeURIComponent(S.runId) +
              "&artifactId=" + encodeURIComponent(a.artifactId),
          );
          pre.textContent = r.content + (r.truncated ? "\n…（预览已截断，实际 " + r.sizeBytes + " 字节）" : "");
          /**
           * 【定】把「登记时的 hash」与「此刻磁盘上的 hash」并排说出来。
           *
           * 上面那一行显示的 `verified` 与 `contentHash` 都是**登记时**的事实；
           * 预览读的是**此刻**的字节。产物被后来的工具改过之后，界面会同时
           * 显示「已验证」与新内容 —— 而阶段 4 明确要回答的正是
           * 「hash 与磁盘上那一份对不对得上」。
           */
          drift.textContent = r.hashMatchesRegistration
            ? "磁盘内容与登记 hash 一致"
            : "⚠️ 磁盘内容已与登记 hash 不同（登记后被改过）：磁盘 " + r.diskHash.slice(0, 16) + "…";
          drift.className = r.hashMatchesRegistration ? "kv" : "kv bad";
        } catch (err) {
          pre.textContent = "读不到：" + err.message;
        }
      });
      box.appendChild(det);
    }
    view.appendChild(box);
  }
}

// ── Trace

/**
 * Trace 页的展示词典。
 *
 * 【定】这里只定义「怎么读」，不定义「发生了什么」。事件枚举、payload 与顺序
 * 原样来自 JSONL；遇到未来新增的事件时回退到中性卡片并保留原文，绝不丢行。
 */
const TRACE_EVENT_META = {
  RunStarted: { label: "Run 开始", category: "lifecycle", tone: "neutral", important: true },
  TurnStarted: { label: "轮次开始", category: "lifecycle", tone: "neutral" },
  LoopContinued: { label: "进入下一轮", category: "lifecycle", tone: "flow", important: true },
  LoopTerminated: { label: "循环终止", category: "lifecycle", tone: "flow", important: true },
  ResumeStarted: { label: "恢复执行", category: "lifecycle", tone: "flow", important: true },
  ContextFrameCompiled: { label: "上下文帧已编译", category: "model", tone: "model" },
  ContextCompacted: { label: "上下文已压缩", category: "model", tone: "warn", important: true },
  ModelStreamDelta: { label: "模型流式增量", category: "model", tone: "muted" },
  ModelInvocationCompleted: { label: "模型调用完成", category: "model", tone: "model" },
  ActionBatchPlanned: { label: "操作批次已规划", category: "tool", tone: "tool" },
  ActionProposed: { label: "操作已提议", category: "tool", tone: "tool" },
  ActionRejected: { label: "操作被拒绝", category: "tool", tone: "bad", important: true },
  ApprovalRequested: { label: "请求审批", category: "human", tone: "warn" },
  ApprovalDecided: { label: "审批已决定", category: "human", tone: "warn" },
  AttemptStarted: { label: "工具执行开始", category: "tool", tone: "tool" },
  ToolProgress: { label: "工具执行进度", category: "tool", tone: "tool" },
  AttemptCompleted: { label: "工具执行完成", category: "tool", tone: "ok" },
  InteractionRequested: { label: "请求人工接管", category: "human", tone: "warn", important: true },
  InteractionCompleted: { label: "人工接管结束", category: "human", tone: "warn", important: true },
  InterjectionAccepted: { label: "插话已接收", category: "human", tone: "warn", important: true },
  ToolResultExternalized: { label: "工具结果已外置", category: "tool", tone: "tool", important: true },
  VerificationCompleted: { label: "操作验证完成", category: "verify", tone: "ok" },
  ArtifactRegistered: { label: "产物已登记", category: "verify", tone: "ok", important: true },
  ArtifactVerified: { label: "产物验证完成", category: "verify", tone: "ok", important: true },
  ActionBatchSettled: { label: "操作批次已结算", category: "tool", tone: "tool" },
  BudgetSoftLimitReached: { label: "预算接近上限", category: "diagnostic", tone: "warn", important: true },
  BudgetHardLimitReached: { label: "预算达到上限", category: "diagnostic", tone: "bad", important: true },
  RecoveryRequired: { label: "需要恢复确认", category: "diagnostic", tone: "warn", important: true },
  RecoveryResolved: { label: "恢复项已决定", category: "diagnostic", tone: "flow", important: true },
  NoProgressDetected: { label: "检测到无进展", category: "diagnostic", tone: "warn", important: true },
  RuntimeErrorOccurred: { label: "Runtime 错误", category: "diagnostic", tone: "bad", important: true },
  ModelInvocationAuditFailed: { label: "模型调用审计失败", category: "diagnostic", tone: "bad", important: true },
  EndpointBehaviorDrift: { label: "端点行为漂移", category: "diagnostic", tone: "bad", important: true },
  InteractionResumed: { label: "人工接管已恢复", category: "diagnostic", tone: "flow", important: true },
  ResumeUnpairedToolUse: { label: "恢复时发现未配对工具调用", category: "diagnostic", tone: "warn", important: true },
  ResumeExternalToolsUnverifiable: { label: "外部工具状态无法核对", category: "diagnostic", tone: "warn", important: true },
};

const TRACE_FILTERS = [
  ["all", "全部"],
  ["important", "重点"],
  ["abnormal", "异常"],
  ["model", "模型"],
  ["tool", "工具"],
  ["human", "审批/交互"],
  ["verify", "验证/产物"],
  ["diagnostic", "预算/恢复"],
];

function traceJson(value, pretty) {
  try {
    return JSON.stringify(value, null, pretty ? 2 : 0);
  } catch {
    return String(value);
  }
}

function traceClip(value, max) {
  const text = value === undefined || value === null ? "" : String(value);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function traceDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + "s";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes + "m " + seconds + "s";
}

function traceEventPresentation(line) {
  const type = line && typeof line.type === "string" ? line.type : "UnknownEvent";
  const payload = line && line.payload && typeof line.payload === "object" ? line.payload : {};
  const base = TRACE_EVENT_META[type] || {
    label: "未识别事件",
    category: "other",
    tone: "neutral",
  };
  let tone = base.tone;
  let abnormal = false;
  let important = base.important === true;
  let diagnostic = base.category === "diagnostic";
  let summary = "查看原始 payload";

  switch (type) {
    case "RunStarted":
      summary = [payload.endpointId, payload.modelId, payload.executionPrivilege].filter(Boolean).join(" · ");
      break;
    case "TurnStarted":
      summary = "第 " + (payload.turn ?? "?") + " 轮开始";
      break;
    case "LoopContinued":
      summary = "迁移：" + (payload.transition && payload.transition.reason || "UNKNOWN");
      break;
    case "LoopTerminated": {
      const reason = payload.terminal && payload.terminal.reason || "UNKNOWN";
      const outcome = payload.outcome && payload.outcome.kind;
      summary = "终止：" + reason + (outcome ? " · " + outcome : "");
      if (reason !== "COMPLETED" || (outcome && outcome !== "SUCCESS")) {
        tone = reason === "MODEL_ERROR" ? "bad" : "warn";
        abnormal = true;
        diagnostic = true;
      } else tone = "ok";
      break;
    }
    case "ResumeStarted":
      summary = "从 #" + (payload.fromSequence ?? "?") + " 恢复 · 重建 " +
        (payload.rebuiltMessages ?? "?") + " 条消息";
      break;
    case "ContextFrameCompiled":
      summary = (payload.items ?? "?") + " 项 · " + (payload.totalTokens ?? "?") + " token" +
        (payload.compacted ? " · 已压缩" : "") +
        (payload.trust && payload.trust.hasExternalUntrusted
          ? " · 外部不可信项 " + payload.trust.untrustedItems
          : "");
      break;
    case "ContextCompacted":
      summary = "释放 " + (payload.freedTokens ?? "?") + " token · " + (payload.reason || "未给出原因");
      break;
    case "ModelStreamDelta":
      summary = "流式片段 · " + String(payload.text || "").length + " 字符";
      break;
    case "ModelInvocationCompleted": {
      const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : {};
      summary = (payload.stopReason || "UNKNOWN") + " · tool call " + (payload.toolCallCount ?? "?") +
        " · billed " + (usage.billedInputTokens ?? "?") + " / out " + (usage.outputTokens ?? "?") +
        " · " + traceDuration(Number(payload.durationMs));
      break;
    }
    case "ActionBatchPlanned":
      summary = (payload.callCount ?? "?") + " 个调用 · " + (payload.mode || "UNKNOWN") +
        " · " + (payload.batchId || "无 batchId");
      break;
    case "ActionBatchSettled":
      summary = (payload.resultCount ?? "?") + " / " + (payload.callCount ?? "?") + " 个结果 · " +
        (payload.batchId || "无 batchId");
      break;
    case "ActionProposed":
      summary = (payload.toolName || "未知工具") + " · " + traceClip(payload.effect || "未声明 effect", 180) +
        (Array.isArray(payload.riskFacts) && payload.riskFacts.length ? " · 风险事实 " + payload.riskFacts.length : "");
      break;
    case "ActionRejected":
      summary = (payload.stage || "UNKNOWN") + " · " + traceClip(payload.reason || "未给出原因", 180);
      abnormal = true;
      diagnostic = true;
      break;
    case "ApprovalRequested":
      summary = traceClip(payload.effect || "未声明 effect", 150) + " · " + (payload.reason || "未给出原因");
      break;
    case "ApprovalDecided":
      summary = (payload.approved ? "已批准" : "已拒绝") + " · " + (payload.decidedBy || "UNDECLARED") +
        (payload.reason ? " · " + payload.reason : "");
      if (!payload.approved) {
        abnormal = true;
        important = true;
      }
      break;
    case "AttemptStarted":
      summary = payload.toolName || "未知工具";
      break;
    case "ToolProgress":
      summary = traceClip(payload.note || "（没有进度说明）", 200);
      break;
    case "AttemptCompleted":
      summary = (payload.status || "UNKNOWN") + " · " + (payload.sideEffectState || "UNKNOWN") +
        " · " + traceDuration(Number(payload.durationMs));
      if (payload.status !== "SUCCEEDED") {
        tone = "bad";
        abnormal = true;
        important = true;
        diagnostic = true;
      }
      if (String(payload.sideEffectState || "").startsWith("UNKNOWN")) diagnostic = true;
      break;
    case "InteractionRequested":
      summary = (payload.toolName || "未知工具") + " · " + traceClip(payload.detail || "", 180);
      break;
    case "InteractionCompleted":
      summary = (payload.toolName || "未知工具") + " · " + (payload.answered ? "已应答" : "未应答");
      if (!payload.answered) abnormal = true;
      break;
    case "InterjectionAccepted":
      summary = traceClip(payload.content || "", 180);
      break;
    case "ToolResultExternalized":
      summary = (payload.toolName || "未知工具") + " · " + (payload.sizeBytes ?? "?") + " 字节 ≈ " +
        (payload.approxTokens ?? "?") + " token · " + (payload.ref || "无引用");
      break;
    case "VerificationCompleted":
      summary = (payload.required ? "必需验证" : "可选验证") + " · " + (payload.status || "UNKNOWN") +
        " · " + traceClip(payload.detail || "", 180);
      tone = payload.status === "PASSED" ? "ok" : "warn";
      if (payload.required && payload.status !== "PASSED") {
        abnormal = true;
        important = true;
        diagnostic = true;
      }
      break;
    case "ArtifactRegistered":
      summary = (payload.logicalId || payload.artifactId || "未知产物") + " · v" + (payload.version ?? "?") +
        " · " + (payload.role || "UNKNOWN") + " · " + (payload.kind || "UNKNOWN");
      break;
    case "ArtifactVerified":
      summary = (payload.ok ? "通过" : "未通过") + " · " + (payload.role || "UNKNOWN") + " · " +
        traceClip(payload.detail || "", 180);
      if (!payload.ok) {
        tone = "bad";
        abnormal = true;
        diagnostic = true;
      }
      break;
    case "BudgetSoftLimitReached":
      summary = (payload.axis || "未知预算轴") + " · " + (payload.used ?? "?") + " / " +
        (payload.limit ?? "?") + " · " + Math.round(Number(payload.ratio || 0) * 100) + "%";
      abnormal = true;
      break;
    case "BudgetHardLimitReached":
      summary = (payload.axis || "未知预算轴") + " · " + (payload.used ?? "?") + " / " + (payload.limit ?? "?");
      abnormal = true;
      break;
    case "RecoveryRequired":
      summary = "待确认项 " + (payload.items ?? "?") + " 个";
      abnormal = true;
      break;
    case "RecoveryResolved":
      summary = (payload.decision || "UNKNOWN") + " · " + (payload.items ?? "?") + " 项" +
        (payload.note ? " · " + payload.note : "");
      break;
    case "NoProgressDetected":
      summary = (payload.toolName || "未知工具") + " · 重复 " + (payload.repeats ?? "?") + " 次";
      abnormal = true;
      break;
    case "RuntimeErrorOccurred": {
      const error = payload.error && typeof payload.error === "object" ? payload.error : {};
      summary = traceClip(error.message || error.code || traceJson(error, false), 220);
      abnormal = true;
      break;
    }
    case "ModelInvocationAuditFailed":
      summary = (payload.stage || "UNKNOWN") + " · " +
        traceClip(payload.message || "未给出原因", 220) + " · " +
        (payload.invocationId || "无 invocationId");
      abnormal = true;
      important = true;
      diagnostic = true;
      break;
    case "EndpointBehaviorDrift":
      summary = (payload.field || "未知字段") + " · 声明 " + (payload.declared || "?") +
        " → 实际 " + (payload.observed || "?") + " · " + (payload.disposition || "UNKNOWN");
      abnormal = true;
      break;
    case "InteractionResumed":
      summary = "待接续工具 " + (Array.isArray(payload.pendingToolUses) ? payload.pendingToolUses.length : "?") + " 个";
      break;
    case "ResumeUnpairedToolUse":
      summary = (payload.toolName || "未知工具") + " · " + (payload.branch || "UNKNOWN") +
        " · pre-fingerprint " + Boolean(payload.hasPreFingerprint);
      abnormal = true;
      break;
    case "ResumeExternalToolsUnverifiable":
      summary = "外部工具 " + (Array.isArray(payload.toolNames) ? payload.toolNames.length : "?") +
        " 个 · 漂移 " + (Array.isArray(payload.drifted) ? payload.drifted.length : "?") + " 个";
      abnormal = true;
      break;
  }

  const sequence = Number(line && line.sequence);
  const searchText = [
    type,
    base.label,
    Number.isFinite(sequence) ? "#" + sequence : "",
    summary,
    traceJson(payload, false),
  ].join(" ").toLowerCase();
  return {
    line,
    type,
    payload,
    sequence: Number.isFinite(sequence) ? sequence : undefined,
    occurredAt: Number(line && line.occurredAt),
    label: base.label,
    category: base.category,
    tone,
    summary: summary || "查看原始 payload",
    important,
    abnormal,
    diagnostic,
    searchText,
  };
}

function traceGroupBy(events, key) {
  const groups = [];
  const byId = new Map();
  for (const event of events) {
    const id = event.payload && event.payload[key];
    if (id === undefined || id === null || id === "") continue;
    const sid = String(id);
    let group = byId.get(sid);
    if (!group) {
      group = { id: sid, events: [] };
      byId.set(sid, group);
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
}

function finalizeTraceTurn(turn) {
  const events = turn.events;
  const sequences = events.map((e) => e.sequence).filter(Number.isFinite);
  const times = events.map((e) => e.occurredAt).filter(Number.isFinite);
  const models = events.filter((e) => e.type === "ModelInvocationCompleted");
  turn.firstSequence = sequences.length ? Math.min(...sequences) : undefined;
  turn.lastSequence = sequences.length ? Math.max(...sequences) : undefined;
  turn.spanMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  turn.modelCalls = models.length;
  turn.modelDurationMs = models.reduce((n, e) => n + (Number(e.payload.durationMs) || 0), 0);
  turn.streamCount = events.filter((e) => e.type === "ModelStreamDelta").length;
  turn.streamChars = events
    .filter((e) => e.type === "ModelStreamDelta")
    .reduce((n, e) => n + String(e.payload.text || "").length, 0);
  turn.actions = traceGroupBy(events, "actionId");
  turn.batches = traceGroupBy(events, "batchId");
  turn.artifacts = traceGroupBy(events, "artifactId");
  const grouped = new Set([
    ...turn.actions.flatMap((g) => g.events),
    ...turn.batches.flatMap((g) => g.events),
    ...turn.artifacts.flatMap((g) => g.events),
  ]);
  turn.ungrouped = events.filter((e) => !grouped.has(e));
  turn.toolNames = [...new Set(turn.actions.flatMap((g) =>
    g.events.map((e) => e.payload.toolName).filter(Boolean)))];
  turn.abnormal = events.some((e) => e.abnormal);
  turn.completed = events.some((e) => e.type === "LoopContinued" || e.type === "LoopTerminated");
  const transition = [...events].reverse().find((e) => e.type === "LoopContinued" || e.type === "LoopTerminated");
  turn.transition = transition
    ? transition.type === "LoopContinued"
      ? transition.payload.transition && transition.payload.transition.reason
      : transition.payload.terminal && transition.payload.terminal.reason
    : undefined;
  turn.searchText = events.map((e) => e.searchText).join(" ");
  return turn;
}

function buildTracePresentation(rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  const segments = [];
  const events = [];
  let segment;
  let turn;
  let synthetic = 0;
  const stats = {
    rawLines: lines.length,
    eventLines: 0,
    businessEvents: 0,
    streamEvents: 0,
    streamChars: 0,
    boundaryLines: 0,
    unknownLines: 0,
    segments: 0,
    turns: 0,
  };

  const startSegment = (header) => {
    const ordinal = segments.length;
    const declared = header && Number(header.segmentIndex);
    const index = Number.isFinite(declared) ? declared : ordinal;
    const created = {
      id: "trace-segment-" + index + "-" + ordinal,
      index,
      header,
      footer: undefined,
      rawLines: [],
      events: [],
      prelude: [],
      turns: [],
      unknownLines: [],
      synthetic: !header,
    };
    segments.push(created);
    return created;
  };

  for (const raw of lines) {
    const line = raw && typeof raw === "object" ? raw : { kind: "unknown", value: raw };
    if (line.kind === "header") {
      segment = startSegment(line);
      segment.rawLines.push(line);
      stats.boundaryLines += 1;
      turn = undefined;
      continue;
    }
    if (!segment) segment = startSegment(undefined);
    segment.rawLines.push(line);
    if (line.kind === "footer") {
      segment.footer = line;
      stats.boundaryLines += 1;
      turn = undefined;
      continue;
    }
    if (line.kind !== "event") {
      segment.unknownLines.push(line);
      stats.unknownLines += 1;
      continue;
    }

    const event = traceEventPresentation(line);
    events.push(event);
    segment.events.push(event);
    stats.eventLines += 1;
    if (event.type === "ModelStreamDelta") {
      stats.streamEvents += 1;
      stats.streamChars += String(event.payload.text || "").length;
    } else stats.businessEvents += 1;

    if (event.type === "TurnStarted") {
      const number = Number(event.payload.turn);
      turn = {
        id: "trace-turn-" + segment.index + "-" + (Number.isFinite(number) ? number : "unknown") + "-" +
          (event.sequence ?? "synthetic-" + synthetic++),
        number: Number.isFinite(number) ? number : undefined,
        segmentId: segment.id,
        events: [],
      };
      segment.turns.push(turn);
    }
    if (turn) turn.events.push(event);
    else segment.prelude.push(event);
  }

  const turns = segments.flatMap((s) => s.turns.map(finalizeTraceTurn));
  if (turns.length) {
    turns[turns.length - 1].isLast = true;
    const completed = turns.filter((t) => t.completed);
    if (completed.length) {
      completed.reduce((a, b) => b.spanMs > a.spanMs ? b : a).isLongest = true;
    }
    for (const item of turns) item.important = item.abnormal || item.isLast === true || item.isLongest === true;
  }
  stats.segments = segments.length;
  stats.turns = turns.length;
  return { lines, segments, turns, events, stats };
}

function traceEventMatches(event, options) {
  if (!event) return false;
  const filter = options && options.filter || "all";
  const query = String(options && options.query || "").trim().toLowerCase();
  if (event.type === "ModelStreamDelta" && !(options && options.showStream)) return false;
  if (query && !event.searchText.includes(query)) return false;
  if (filter === "all") return true;
  if (filter === "important") return event.important;
  if (filter === "abnormal") return event.abnormal;
  if (filter === "diagnostic") return event.diagnostic;
  return event.category === filter;
}

function traceTurnMatches(turn, options) {
  const filter = options && options.filter || "all";
  const query = String(options && options.query || "").trim().toLowerCase();
  if (filter === "important") {
    if (!turn.important) return false;
    if (!query) return true;
    return turn.events.some((e) => traceEventMatches(e, { ...options, filter: "all" }));
  }
  if (filter === "abnormal" && !turn.abnormal) return false;
  return turn.events.some((e) => traceEventMatches(e, options));
}

/** 未知 kind 不冒充业务事件，只在「全部」里按完整原始 JSON 参与搜索。 */
function traceUnknownLineMatches(line, options) {
  const filter = options && options.filter || "all";
  if (filter !== "all") return false;
  const query = String(options && options.query || "").trim().toLowerCase();
  return !query || traceJson(line, false).toLowerCase().includes(query);
}

function traceStatsEquation(stats) {
  return "原始行 " + stats.rawLines + " = 业务事件 " + stats.businessEvents +
    " + 流式增量 " + stats.streamEvents + " + 段边界 " + stats.boundaryLines +
    " + 未知行 " + stats.unknownLines;
}

/** 这个纯判断被 refresh() 与验收共同使用，避免“看似局部、实际重建”的回归。 */
function traceRefreshInPlaceAllowed(tab, selectedRunId, traceRunId, rootConnected) {
  return tab === "trace" && Boolean(selectedRunId) && selectedRunId === traceRunId && rootConnected === true;
}

function traceResponseCanCommit(requestRevision, currentRevision, requestedRunId, selectedRunId, tab, rootConnected) {
  return requestRevision === currentRevision &&
    traceRefreshInPlaceAllowed(tab, selectedRunId, requestedRunId, rootConnected);
}

/**
 * 后台刷新前在底部附近就继续跟随；查看历史时保持原位置并裁到新的合法范围。
 * 返回值只用于实时数据更新，搜索、筛选等主动操作不调用它。
 */
function traceScrollAfterRefresh(scrollTop, clientHeight, previousScrollHeight, nextScrollHeight) {
  const previousMax = Math.max(0, Number(previousScrollHeight) - Number(clientHeight));
  const nextMax = Math.max(0, Number(nextScrollHeight) - Number(clientHeight));
  const previousTop = Math.max(0, Math.min(Number(scrollTop) || 0, previousMax));
  return previousMax - previousTop <= 48 ? nextMax : Math.min(previousTop, nextMax);
}

function traceGroupMatches(group, turn, options) {
  if (options.filter === "important" && turn.important && !options.query) return true;
  return group.events.some((e) => traceEventMatches(e, options));
}

function traceBoundarySummary(line, prefix) {
  const parts = [prefix];
  if (line.entry) parts.push(String(line.entry));
  if (line.modelId) parts.push(String(line.modelId));
  if (line.executionPrivilege) parts.push(String(line.executionPrivilege));
  if (line.terminal && line.terminal.reason) parts.push(String(line.terminal.reason));
  if (line.outcome && line.outcome.kind) parts.push(String(line.outcome.kind));
  return parts.join(" · ");
}

async function copyTraceJson(value) {
  const text = traceJson(value, true);
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    toast("已复制 JSON");
  } catch {
    toast("浏览器未允许复制，请在原始 JSON 中手动选择", true);
  }
}

function renderTraceJsonDetails(label, value) {
  return el("details", { class: "trace-json" }, [
    el("summary", { text: label }),
    el("div", { class: "trace-json-actions" }, [
      el("button", { class: "link", type: "button", text: "复制 JSON", onclick: () => void copyTraceJson(value) }),
    ]),
    el("pre", { text: traceJson(value, true) }),
  ]);
}

function renderTraceEvent(event) {
  return el("article", { class: "trace-event trace-tone-" + event.tone }, [
    el("div", { class: "trace-event-head" }, [
      el("span", { class: "seq", text: event.sequence === undefined ? "#?" : "#" + event.sequence }),
      el("strong", { text: event.label }),
      el("span", { class: "tag mono", text: event.type }),
      el("span", { class: "trace-event-summary", text: event.summary }),
    ]),
    renderTraceJsonDetails("原始 payload", event.payload),
  ]);
}

function renderTraceBoundary(line, kind) {
  const isHeader = kind === "header";
  const index = Number.isFinite(Number(line.segmentIndex)) ? Number(line.segmentIndex) : "?";
  return el("article", { class: "trace-boundary " + kind }, [
    el("div", { class: "trace-event-head" }, [
      el("strong", { text: isHeader ? "执行段 " + index + " 开始" : "执行段 " + index + " 结束" }),
      line.entry ? el("span", { class: "chip", text: line.entry }) : null,
      line.modelId ? el("span", { class: "chip", text: line.modelId }) : null,
      line.executionPrivilege
        ? el("span", { class: "chip " + (line.executionPrivilege === "UNRESTRICTED" ? "warn" : ""), text: line.executionPrivilege })
        : null,
      line.commit ? el("span", { class: "chip mono", text: "commit " + String(line.commit).slice(0, 10) }) : null,
      line.gitDirty === true ? el("span", { class: "chip warn", text: "gitDirty true" }) : null,
      line.terminal && line.terminal.reason ? el("span", { class: "chip", text: line.terminal.reason }) : null,
      line.outcome && line.outcome.kind ? el("span", { class: "chip", text: line.outcome.kind }) : null,
    ]),
    el("div", {
      class: "kv",
      text: [line.startedAt || line.finishedAt, line.endpointProfile].filter(Boolean).join(" · "),
    }),
    renderTraceJsonDetails(isHeader ? "原始 header" : "原始 footer", line),
  ]);
}

function traceTurnTone(turn) {
  if (turn.events.some((e) => e.abnormal && e.tone === "bad")) return "bad";
  if (turn.abnormal) return "warn";
  return "neutral";
}

function tracePhaseBar(turn) {
  const phases = [];
  const has = (fn) => turn.events.some(fn);
  if (has((e) => e.type === "ContextFrameCompiled" || e.type === "ContextCompacted")) phases.push(["上下文", "model"]);
  if (has((e) => e.type === "ModelInvocationCompleted" || e.type === "ModelStreamDelta")) phases.push(["模型", "model"]);
  if (has((e) => e.category === "human")) phases.push(["审批/交互", "warn"]);
  if (turn.actions.length || turn.batches.length) phases.push(["工具执行", "tool"]);
  if (has((e) => e.type === "VerificationCompleted")) phases.push(["验证", "ok"]);
  if (turn.artifacts.length) phases.push(["产物", "ok"]);
  if (has((e) => e.category === "diagnostic")) phases.push(["预算/恢复", turn.abnormal ? "warn" : "flow"]);
  if (turn.transition) phases.push([turn.transition, "flow"]);
  return el("div", { class: "trace-phase-bar" }, phases.flatMap((phase, index) => [
    index ? el("span", { class: "trace-phase-arrow", text: "→" }) : null,
    el("span", { class: "trace-phase trace-tone-" + phase[1], text: phase[0] }),
  ]));
}

function renderTraceEventGroup(title, subtitle, events, cls, expandProgress) {
  const box = el("section", { class: "trace-event-group " + (cls || "") }, [
    el("div", { class: "trace-group-head" }, [
      el("strong", { text: title }),
      subtitle ? el("span", { class: "mono muted", text: subtitle }) : null,
      el("span", { class: "chip", text: events.length + " 条" }),
    ]),
  ]);
  for (let index = 0; index < events.length;) {
    if (events[index].type !== "ToolProgress") {
      box.appendChild(renderTraceEvent(events[index]));
      index += 1;
      continue;
    }
    const progress = [];
    while (index < events.length && events[index].type === "ToolProgress") {
      progress.push(events[index]);
      index += 1;
    }
    if (progress.length < 3) {
      for (const event of progress) box.appendChild(renderTraceEvent(event));
      continue;
    }
    const first = progress[0].summary;
    const last = progress[progress.length - 1].summary;
    box.appendChild(
      el("details", { class: "trace-progress", open: expandProgress === true }, [
        el("summary", {
          text: "工具进度 × " + progress.length + " · " + traceClip(first, 90) +
            (last !== first ? " → " + traceClip(last, 90) : ""),
        }),
        ...progress.map(renderTraceEvent),
      ]),
    );
  }
  return box;
}

function renderTraceTurnBody(turn, options) {
  const body = el("div", { class: "trace-turn-body" }, [tracePhaseBar(turn)]);
  const importantWholeTurn = options.filter === "important" && turn.important && !options.query;
  const eventMatches = (event) => importantWholeTurn
    ? event.type !== "ModelStreamDelta" || options.showStream
    : traceEventMatches(event, options);
  const groupMatches = (group) => importantWholeTurn || traceGroupMatches(group, turn, options);
  const grouped = new Set([
    ...turn.actions.flatMap((g) => g.events),
    ...turn.batches.flatMap((g) => g.events),
    ...turn.artifacts.flatMap((g) => g.events),
  ]);
  const plain = turn.events.filter((e) => !grouped.has(e) && e.type !== "TurnStarted");
  const appendPlainPhases = (phaseDefs) => {
    for (const [label, cls, categories] of phaseDefs) {
      const matched = plain.filter((e) => categories.includes(e.category) && eventMatches(e));
      if (matched.length) body.appendChild(renderTraceEventGroup(label, "", matched, cls));
    }
  };

  appendPlainPhases([
    ["上下文与模型", "model", ["model"]],
    ["审批与人工交互", "human", ["human"]],
  ]);
  for (const batch of turn.batches) {
    if (!groupMatches(batch)) continue;
    body.appendChild(renderTraceEventGroup("操作批次", batch.id, batch.events.filter((e) =>
      e.type !== "ModelStreamDelta" || options.showStream), "tool"));
  }
  for (const action of turn.actions) {
    if (!groupMatches(action)) continue;
    const tool = action.events.map((e) => e.payload.toolName).find(Boolean) || "未知工具";
    body.appendChild(renderTraceEventGroup("操作生命周期 · " + tool, action.id, action.events.filter((e) =>
      e.type !== "ModelStreamDelta" || options.showStream), "action", Boolean(options.query)));
  }
  for (const artifact of turn.artifacts) {
    if (!groupMatches(artifact)) continue;
    body.appendChild(renderTraceEventGroup("产物生命周期", artifact.id, artifact.events, "verify"));
  }
  appendPlainPhases([
    ["预算、恢复与诊断", "diagnostic", ["diagnostic"]],
    ["循环迁移", "lifecycle", ["lifecycle"]],
    ["其他事件", "other", ["other"]],
  ]);
  if (turn.streamCount && !options.showStream && (options.filter === "all" || options.filter === "model" || importantWholeTurn)) {
    body.appendChild(
      el("div", {
        class: "trace-stream-summary",
        text: "已折叠 ModelStreamDelta × " + turn.streamCount + "（" + turn.streamChars + " 字符）；可在顶部打开“显示流式增量”。",
      }),
    );
  }
  if (body.childNodes.length === 1) {
    body.appendChild(el("p", { class: "muted", text: "（本轮没有符合当前筛选条件的阶段）" }));
  }
  return body;
}

function renderTraceTurn(turn, options, ui) {
  const isOpen = ui.expanded.has(turn.id);
  const badges = [
    el("span", { class: "chip", text: "模型 " + turn.modelCalls + " 次 / " + traceDuration(turn.modelDurationMs) }),
    el("span", { class: "chip", text: "工具 " + turn.actions.length + " 次" }),
    turn.streamCount ? el("span", { class: "chip", text: "流式 " + turn.streamCount + " 条" }) : null,
    turn.abnormal ? el("span", { class: "chip " + traceTurnTone(turn), text: "需关注" }) : null,
    turn.isLongest ? el("span", { class: "chip", text: "最长已完成轮" }) : null,
    turn.transition ? el("span", { class: "chip", text: turn.transition }) : null,
  ];
  const details = el("details", { class: "trace-turn trace-turn-" + traceTurnTone(turn), id: turn.id, open: isOpen }, [
    el("summary", {}, [
      el("div", { class: "trace-turn-title" }, [
        el("strong", { text: turn.number === undefined ? "未知轮次" : "T" + turn.number }),
        el("span", {
          class: "mono muted",
          text: "#" + (turn.firstSequence ?? "?") + "–#" + (turn.lastSequence ?? "?") +
            " · 事件跨度 " + traceDuration(turn.spanMs),
        }),
        turn.toolNames.length ? el("span", { class: "toolname", text: turn.toolNames.join("、") }) : null,
      ]),
      el("div", { class: "trace-turn-badges" }, badges),
    ]),
    renderTraceTurnBody(turn, options),
  ]);
  details.addEventListener("toggle", () => {
    ui.touched.add(turn.id);
    if (details.open) ui.expanded.add(turn.id);
    else ui.expanded.delete(turn.id);
  });
  return details;
}

function renderTraceSegmentHeader(segment) {
  if (!segment.header) {
    return el("div", { class: "trace-segment-head warn", text: "执行段信息缺失（Trace 中没有 header，事件仍按原顺序保留）" });
  }
  const h = segment.header;
  return el("div", { class: "trace-segment-head" }, [
    el("strong", { text: "执行段 " + segment.index }),
    h.entry ? el("span", { class: "chip", text: h.entry }) : null,
    h.modelId ? el("span", { class: "chip", text: h.modelId }) : null,
    h.executionPrivilege
      ? el("span", { class: "chip " + (h.executionPrivilege === "UNRESTRICTED" ? "warn" : ""), text: h.executionPrivilege })
      : null,
    h.commit ? el("span", { class: "chip mono", text: "commit " + String(h.commit).slice(0, 10) }) : null,
    h.gitDirty === true ? el("span", { class: "chip warn", text: "gitDirty true" }) : null,
    el("span", { class: "muted", text: [h.startedAt, h.endpointProfile].filter(Boolean).join(" · ") }),
  ]);
}

function renderTraceUnknownLines(lines) {
  return el("details", { class: "trace-unknown-lines" }, [
    el("summary", { text: "未识别 Trace 行 × " + lines.length }),
    ...lines.map((line) =>
      el("article", { class: "trace-unknown-line" }, [
        el("div", { class: "trace-event-head" }, [
          el("strong", { text: "未知 kind" }),
          line && line.kind !== undefined
            ? el("span", { class: "tag mono", text: String(line.kind) })
            : null,
        ]),
        renderTraceJsonDetails("原始行", line),
      ])),
  ]);
}

function renderTraceTurns(container, presentation, options, ui) {
  let visibleItems = 0;
  for (const segment of presentation.segments) {
    const turns = segment.turns.filter((turn) => traceTurnMatches(turn, options));
    const prelude = segment.prelude.filter((event) => traceEventMatches(event, options));
    const unknownLines = segment.unknownLines.filter((line) => traceUnknownLineMatches(line, options));
    const boundaryOnly = options.filter === "all" && !options.query &&
      Boolean(segment.header || segment.footer) && !segment.events.length && !segment.unknownLines.length;
    if (!turns.length && !prelude.length && !unknownLines.length && !boundaryOnly) continue;
    const section = el("section", { class: "trace-segment" }, [renderTraceSegmentHeader(segment)]);
    if (prelude.length) {
      section.appendChild(renderTraceEventGroup("段首事件", "首轮开始之前", prelude, "lifecycle"));
      visibleItems += prelude.length;
    }
    if (unknownLines.length) {
      section.appendChild(renderTraceUnknownLines(unknownLines));
      visibleItems += unknownLines.length;
    }
    for (const turn of turns) {
      section.appendChild(renderTraceTurn(turn, options, ui));
      visibleItems += 1;
    }
    if (segment.footer) {
      section.appendChild(
        el("div", {
          class: "trace-segment-foot",
          text: traceBoundarySummary(segment.footer, "段尾") +
            (segment.footer.finishedAt ? " · " + segment.footer.finishedAt : ""),
        }),
      );
    }
    section.appendChild(renderTraceJsonDetails("执行段原始信息", {
      header: segment.header || null,
      footer: segment.footer || null,
    }));
    container.appendChild(section);
    if (boundaryOnly) visibleItems += 1;
  }
  if (!visibleItems) {
    container.appendChild(
      el("div", { class: "trace-empty", text: presentation.stats.turns ? "没有符合当前条件的轮次。" : "Trace 中还没有 TurnStarted 事件。" }),
    );
  }
}

function renderTraceRaw(container, presentation, options) {
  const byLine = new Map(presentation.events.map((event) => [event.line, event]));
  let visible = 0;
  for (const segment of presentation.segments) {
    const matched = segment.events.filter((event) => traceEventMatches(event, options));
    const unknownMatched = segment.unknownLines.filter((line) => traceUnknownLineMatches(line, options));
    if (!matched.length && !unknownMatched.length && !(options.filter === "all" && !options.query && !segment.events.length)) continue;
    const matchedSet = new Set(matched.map((event) => event.line));
    const unknownSet = new Set(unknownMatched);
    const section = el("section", { class: "trace-raw-segment" }, []);
    for (const line of segment.rawLines) {
      if (line.kind === "header") {
        section.appendChild(renderTraceBoundary(line, "header"));
        visible += 1;
      } else if (line.kind === "footer") {
        section.appendChild(renderTraceBoundary(line, "footer"));
        visible += 1;
      } else if (line.kind === "event" && matchedSet.has(line)) {
        section.appendChild(renderTraceEvent(byLine.get(line)));
        visible += 1;
      } else if (line.kind !== "event" && unknownSet.has(line)) {
        section.appendChild(el("article", { class: "trace-event trace-unknown-line" }, [
          el("div", { class: "trace-event-head" }, [
            el("strong", { text: "未识别 Trace 行" }),
            line && line.kind !== undefined ? el("span", { class: "tag mono", text: String(line.kind) }) : null,
          ]),
          renderTraceJsonDetails("原始行", line),
        ]));
        visible += 1;
      }
    }
    container.appendChild(section);
  }
  if (!visible && presentation.stats.rawLines) {
    container.appendChild(el("div", { class: "trace-empty", text: "没有符合当前条件的原始事件。" }));
  }
}

function traceInspectorRootConnected(ui) {
  const root = ui && ui.dom && ui.dom.root;
  const view = document.getElementById("view");
  return Boolean(root && root.isConnected && view && view.contains(root));
}

function canRefreshTraceInspectorInPlace() {
  return traceRefreshInPlaceAllowed(
    S.tab,
    S.runId,
    S.traceUi.runId,
    traceInspectorRootConnected(S.traceUi),
  );
}

function traceOptions(ui) {
  return { filter: ui.filter, query: ui.query, showStream: ui.showStream };
}

function updateTraceControls(ui) {
  const dom = ui.dom;
  if (!dom) return;
  dom.modeTurns.className = ui.mode === "turns" ? "active" : "";
  dom.modeRaw.className = ui.mode === "raw" ? "active" : "";
  for (const [key, button] of dom.filterButtons) button.className = ui.filter === key ? "active" : "";
  dom.showStream.checked = ui.showStream;
  dom.jump.hidden = ui.mode !== "turns";
  dom.expandAll.hidden = ui.mode !== "turns";
  dom.collapseAll.hidden = ui.mode !== "turns";
}

function updateTraceFacts(ui, d, presentation) {
  const dom = ui.dom;
  if (!dom) return;
  dom.sourceSummary.textContent = d.tracks.traceFile ? "Trace 来源与统计口径" : "没有 trace 文件";
  dom.sourcePath.textContent = d.tracks.traceFile || "（该 Run 没有可读取的 Trace 文件）";
  dom.sourceFormula.textContent = traceStatsEquation(presentation.stats);
  dom.businessStat.textContent = "业务事件 " + presentation.stats.businessEvents;
  dom.streamStat.textContent = "流式增量 " + presentation.stats.streamEvents;
  dom.turnStat.textContent = "轮次 " + presentation.stats.turns;
  dom.segmentStat.textContent = "执行段 " + presentation.stats.segments;
  dom.rawStat.textContent = "原始行 " + presentation.stats.rawLines;
  dom.unknownStat.textContent = "未知行 " + presentation.stats.unknownLines;
  dom.unknownStat.hidden = presentation.stats.unknownLines === 0;

  const jumpOptions = document.createDocumentFragment();
  jumpOptions.appendChild(el("option", { value: "", text: "跳到轮次…" }));
  for (const turn of presentation.turns) {
    jumpOptions.appendChild(el("option", {
      value: turn.id,
      text: (turn.number === undefined ? "未知轮次" : "T" + turn.number) +
        (turn.abnormal ? " · 需关注" : turn.isLongest ? " · 最长" : ""),
    }));
  }
  dom.jump.replaceChildren(jumpOptions);
}

function setTraceRefreshStatus(ui, text, bad) {
  if (!ui.dom) return;
  ui.dom.status.textContent = text || "";
  ui.dom.status.className = "trace-refresh-status" + (bad ? " bad" : "");
  ui.dom.status.hidden = !text;
}

function paintTraceInspector(ui, previousScroll) {
  const dom = ui.dom;
  const presentation = ui.presentation;
  if (!dom || !presentation) return;
  updateTraceControls(ui);

  const view = document.getElementById("view");
  const fragment = document.createDocumentFragment();
  if (!presentation.stats.rawLines) {
    fragment.appendChild(el("div", { class: "trace-empty", text: "（没有可展示的 Trace 行）" }));
  } else if (ui.mode === "raw") {
    renderTraceRaw(fragment, presentation, traceOptions(ui));
  } else {
    renderTraceTurns(fragment, presentation, traceOptions(ui), ui);
  }
  dom.content.replaceChildren(fragment);

  const paintRevision = ++ui.paintRevision;
  if (previousScroll && view) {
    requestAnimationFrame(() => {
      if (S.traceUi !== ui || paintRevision !== ui.paintRevision || !traceInspectorRootConnected(ui)) return;
      view.scrollTop = traceScrollAfterRefresh(
        previousScroll.top,
        previousScroll.height,
        previousScroll.scrollHeight,
        view.scrollHeight,
      );
    });
  }
}

async function refreshTraceInspector(d, options) {
  const ui = S.traceUi;
  if (!canRefreshTraceInspectorInPlace() || ui.runId !== d.runId) return false;
  const revision = ++ui.loadRevision;
  const hadPresentation = Boolean(ui.presentation);
  ui.dom.root.setAttribute("aria-busy", "true");
  if (!hadPresentation) setTraceRefreshStatus(ui, "正在读取 Trace……", false);

  let lines;
  try {
    lines = (await api("/api/runs/" + encodeURIComponent(d.runId) + "/trace")).lines || [];
  } catch (err) {
    const canCommit = S.traceUi === ui && ui.runId === d.runId && traceResponseCanCommit(
      revision,
      ui.loadRevision,
      d.runId,
      S.runId,
      S.tab,
      traceInspectorRootConnected(ui),
    );
    if (!canCommit) return false;
    ui.dom.root.setAttribute("aria-busy", "false");
    const message = err && err.message ? err.message : String(err);
    if (hadPresentation) {
      setTraceRefreshStatus(ui, "刷新失败，保留上次结果：" + message, true);
    } else {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(el("div", { class: "trace-empty bad", text: "Trace 初次读取失败：" + message }));
      ui.dom.content.replaceChildren(fragment);
      setTraceRefreshStatus(ui, "Trace 初次读取失败", true);
    }
    return false;
  }

  const canCommit = S.traceUi === ui && ui.runId === d.runId && traceResponseCanCommit(
    revision,
    ui.loadRevision,
    d.runId,
    S.runId,
    S.tab,
    traceInspectorRootConnected(ui),
  );
  if (!canCommit) return false;

  // 统计 chip 也可能在窄屏换行，因此必须在更新任何 Trace DOM 前记录位置。
  const view = document.getElementById("view");
  const previousScroll = options && options.preserveScroll && view
    ? { top: view.scrollTop, height: view.clientHeight, scrollHeight: view.scrollHeight }
    : null;
  const presentation = buildTracePresentation(lines);
  ui.presentation = presentation;
  for (const turn of presentation.turns) {
    if (turn.important && !ui.touched.has(turn.id)) ui.expanded.add(turn.id);
  }
  updateTraceFacts(ui, d, presentation);
  setTraceRefreshStatus(ui, "", false);
  ui.dom.root.setAttribute("aria-busy", "false");
  paintTraceInspector(ui, previousScroll);
  return true;
}

function renderTrace(view, d) {
  if (S.traceUi.runId !== d.runId) {
    disposeTraceInspector();
    S.traceUi = createTraceUi(d.runId);
  }
  const ui = S.traceUi;
  const sourceSummary = el("summary", { text: d.tracks.traceFile ? "Trace 来源与统计口径" : "没有 trace 文件" });
  const sourcePath = el("div", { class: "mono", text: d.tracks.traceFile || "（该 Run 没有可读取的 Trace 文件）" });
  const sourceFormula = el("p", { class: "hint", text: "等待 Trace 统计……" });
  const source = el("details", { class: "trace-source" }, [sourceSummary, sourcePath, sourceFormula]);

  const modeTurns = el("button", { type: "button", text: "逐轮检查器" });
  const modeRaw = el("button", { type: "button", text: "原始事件" });
  const businessStat = el("span", { class: "chip", text: "业务事件 —" });
  const streamStat = el("span", { class: "chip", text: "流式增量 —" });
  const turnStat = el("span", { class: "chip", text: "轮次 —" });
  const segmentStat = el("span", { class: "chip", text: "执行段 —" });
  const rawStat = el("span", { class: "chip", text: "原始行 —" });
  const unknownStat = el("span", { class: "chip warn", text: "未知行 —", hidden: true });
  const stats = el("div", { class: "trace-stats" }, [
    businessStat, streamStat, turnStat, segmentStat, rawStat, unknownStat,
  ]);
  const search = el("input", {
    class: "trace-search",
    type: "text",
    value: ui.query,
    placeholder: "搜索事件、工具、序号或 ID…",
    "aria-label": "搜索 Trace",
  });
  const showStream = el("input", { type: "checkbox" });
  showStream.checked = ui.showStream;
  const jump = el("select", { class: "trace-jump", "aria-label": "跳到轮次" }, [
    el("option", { value: "", text: "跳到轮次…" }),
  ]);
  const expandAll = el("button", { type: "button", text: "全部展开" });
  const collapseAll = el("button", { type: "button", text: "全部折叠" });
  const filterButtons = new Map();
  const filters = el("div", { class: "trace-filters", "aria-label": "Trace 分类筛选" },
    TRACE_FILTERS.map(([key, label]) => {
      const button = el("button", { type: "button", text: label });
      filterButtons.set(key, button);
      return button;
    }));
  const toolbar = el("div", { class: "trace-toolbar" }, [
    el("div", { class: "trace-toolbar-main" }, [
      el("div", { class: "trace-mode-group" }, [modeTurns, modeRaw]),
      stats,
      search,
    ]),
    el("div", { class: "trace-toolbar-actions" }, [
      filters,
      el("label", { class: "trace-check" }, [showStream, "显示流式增量"]),
      jump,
      expandAll,
      collapseAll,
    ]),
  ]);
  const status = el("p", { class: "trace-refresh-status", text: "正在读取 Trace……" });
  const content = el("div", { class: "trace-content" }, []);
  const root = el("section", { class: "trace-inspector", "aria-busy": "true" }, [
    source, toolbar, status, content,
  ]);
  ui.dom = {
    root,
    sourceSummary,
    sourcePath,
    sourceFormula,
    modeTurns,
    modeRaw,
    businessStat,
    streamStat,
    turnStat,
    segmentStat,
    rawStat,
    unknownStat,
    search,
    showStream,
    jump,
    expandAll,
    collapseAll,
    filterButtons,
    status,
    content,
  };
  view.appendChild(root);

  const paintNow = () => {
    clearTimeout(ui.searchTimer);
    ui.searchTimer = 0;
    paintTraceInspector(ui, false);
  };
  modeTurns.addEventListener("click", () => { ui.mode = "turns"; paintNow(); });
  modeRaw.addEventListener("click", () => { ui.mode = "raw"; paintNow(); });
  for (const [key, button] of filterButtons) {
    button.addEventListener("click", () => { ui.filter = key; paintNow(); });
  }
  search.addEventListener("compositionstart", () => {
    ui.composing = true;
    clearTimeout(ui.searchTimer);
    ui.searchTimer = 0;
  });
  search.addEventListener("input", () => {
    ui.query = search.value;
    if (ui.composing) return;
    clearTimeout(ui.searchTimer);
    ui.searchTimer = setTimeout(() => {
      ui.searchTimer = 0;
      if (S.traceUi === ui && traceInspectorRootConnected(ui)) paintTraceInspector(ui, false);
    }, 150);
  });
  search.addEventListener("compositionend", () => {
    ui.composing = false;
    ui.query = search.value;
    paintNow();
  });
  showStream.addEventListener("change", () => { ui.showStream = showStream.checked; paintNow(); });
  jump.addEventListener("change", () => {
    if (!jump.value) return;
    const target = document.getElementById(jump.value);
    if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
    jump.value = "";
  });
  expandAll.addEventListener("click", () => {
    if (!ui.presentation) return;
    for (const turn of ui.presentation.turns) {
      ui.touched.add(turn.id);
      ui.expanded.add(turn.id);
    }
    paintNow();
  });
  collapseAll.addEventListener("click", () => {
    if (!ui.presentation) return;
    for (const turn of ui.presentation.turns) ui.touched.add(turn.id);
    ui.expanded.clear();
    paintNow();
  });

  updateTraceControls(ui);
  if (ui.presentation) {
    updateTraceFacts(ui, d, ui.presentation);
    setTraceRefreshStatus(ui, "正在刷新 Trace……", false);
    paintTraceInspector(ui, false);
  }
  void refreshTraceInspector(d, { preserveScroll: false });
}

// ── 恢复

function renderRecovery(view, d) {
  view.appendChild(el("h4", { text: "§18.2 三条分支的命中次数" }));
  const keys = Object.keys(d.recovery.branchCounts);
  view.appendChild(
    el("p", {
      class: keys.length ? "mono" : "muted",
      text: keys.length
        ? keys.map((k) => k + " × " + d.recovery.branchCounts[k]).join("、")
        : "（这个 Run 没有发生过 resume）",
    }),
  );
  view.appendChild(
    el("p", {
      class: "muted",
      text: "IDEMPOTENT_RETRY = 直接重跑；OBSERVE_FIRST = 先观察外部世界再定；" +
        "RECOVERY_REQUIRED = 非幂等且不可观察，只能交人。第三条的占比就是阶段 2 那个研究问题。",
    }),
  );

  view.appendChild(el("h4", { text: "状态未知、等人确认的副作用" }));
  if (d.recovery.items.length === 0) {
    view.appendChild(el("p", { class: "muted", text: "（无）" }));
  } else {
    for (const i of d.recovery.items) {
      view.appendChild(el("p", { text: "· " + i.what + "（" + i.sideEffectState + "）" }));
    }
  }

  if (d.status === "RECOVERY_REQUIRED") {
    const note = el("input", { type: "text", placeholder: "写一句你确认了什么（会进 Trace）" });
    view.appendChild(el("h4", { text: "带决策继续" }));
    view.appendChild(note);
    view.appendChild(
      el("div", { class: "row" }, [
        el("button", {
          class: "primary",
          text: "CONTINUE（我已人工确认外部状态）",
          onclick: () => cmd(d.runId, "/resume", { recoveryDecision: "CONTINUE", recoveryNote: note.value }),
        }),
        " ",
        el("button", {
          class: "danger",
          text: "ABORT（不继续，收在 CANCELLED）",
          onclick: () => cmd(d.runId, "/resume", { recoveryDecision: "ABORT", recoveryNote: note.value }),
        }),
      ]),
    );
    view.appendChild(
      el("p", {
        class: "muted",
        text: "【定】停在 RECOVERY_REQUIRED 之后必须带一个显式决策才能走 —— " +
          "否则「交用户决定」会退化成「停一次，下次自动放行」。",
      }),
    );
  }

  if (d.outcome && d.outcome.incompleteItems.length) {
    view.appendChild(el("h4", { text: "未完成项" }));
    for (const i of d.outcome.incompleteItems) {
      view.appendChild(el("p", { text: "· " + i.what + "：" + i.why }));
    }
  }
  if (d.outcome && d.outcome.summary) {
    view.appendChild(el("h4", { text: "模型最后说了什么（outcome.summary）" }));
    view.appendChild(el("pre", { text: d.outcome.summary }));
  }
}

// ═══════════════════════════════════════════════════════════ 等人面板

function renderPending() {
  const box = document.getElementById("pending");
  clear(box);
  const items = S.pending;
  box.hidden = items.length === 0;
  for (const p of items) {
    box.appendChild(
      p.kind === "APPROVAL"
        ? approvalCard(p)
        : p.kind === "HANDOFF"
          ? handoffCard(p)
          : questionCard(p),
    );
  }
}

function approvalCard(p) {
  const a = p.approval;
  const card = el("div", { class: "card" }, [
    el("h3", { text: "要不要批准这一步？" }),
    el("div", {}, [
      el("span", { class: "toolname", text: a.toolName }),
      " ",
      el("span", { class: "chip", text: a.effectType }),
      " ",
      el("span", { class: "chip", text: a.reversibility }),
    ]),
    el("div", { class: "kv", text: a.scopeKind + "：" + a.scopeValue }),
    el("div", { class: "kv", text: "自动放行没覆盖它：" + a.why }),
  ]);
  /**
   * 【定】PROCESS scope 必须把命令原文打出来。
   *
   * `scope.value` 对一条 shell 命令是**程序名集合**（§12.4 不以自由文本作为
   * 授权边界），于是 `rm -rf build` 与 `rm -rf /` 在那一行里长得一模一样。
   * 那不是审批，那是盲批 —— 一个看起来有闸门、实际什么都没拦住的闸门，
   * 比没有闸门更糟，因为它还会让人以为自己确认过了。
   */
  if (a.command !== undefined) {
    if (a.description) card.appendChild(el("div", { class: "kv", text: a.description }));
    card.appendChild(el("pre", { text: a.command }));
    card.appendChild(
      el("div", {
        class: a.allowNetwork ? "kv bad" : "kv",
        // 与 CLI 的 main.ts、run_shell 的 description ① 是同一句话的三处；
        // 分叉过一次（description 承诺「系统临时目录」而实现只放行 per-call $TMPDIR）。
        /**
         * 【定】这句话必须跟着**执行特权档位**变（ADR-0012）。
         *
         * 它此前是一句写死的保证。UNRESTRICTED 档下那句话是假的 ——
         * 而这里是 EXECUTE 唯一的人工边界，一个在批准的那一刻给出
         * 方向相反的保证的界面，比不给保证更糟。
         * 与 CLI 的 main.ts、run_shell 的 description ① 是同一句话的三处；
         * 分叉过一次（description 承诺「系统临时目录」而实现只放行
         * per-call $TMPDIR），所以这三处必须一起改。
         */
        text:
          S.service && S.service.executionPrivilege === "UNRESTRICTED"
            ? "⚠️ 本次运行无沙箱（UNRESTRICTED）：这条命令可写任意路径、可联网，" +
              "直接作用在这台机器上"
            : "沙箱：只能写 workspace 与本次调用的 $TMPDIR；" +
              (a.allowNetwork ? "本次允许联网" : "禁止联网"),
      }),
    );
    /**
     * 这条命令自称要交付什么（ADR-0010）。人批准的不只是「跑这条命令」，
     * 还有「它自称要交付这个文件」—— 那是选「执行前声明」而不是
     * 「执行后扫 workspace」的一半理由，不显示等于没兑现。
     */
    if (a.artifactPath) {
      card.appendChild(
        el("div", { class: "kv", text: "声明的交付物：" + a.artifactPath + "（" + a.artifactRole + "）" }),
      );
    }
  }
  /**
   * 【定】外部 MCP 工具（ADR-0011）。**与 CLI 的 main.ts 是同一份内容的两处。**
   *
   * 它是独立的一支，不能并进上面 `a.command` 那一支 —— 那支会打出
   * 「沙箱：只能写 workspace 与 $TMPDIR」，而 MCP 工具**没有沙箱**。
   * 在审批的那一刻给出一句方向相反的保证，比不给保证更糟。
   *
   * 整份入参打出来、不挑字段：Atlas 不解析 MCP 的参数（那正是"换个 MCP
   * 只改配置"的代价），所以没有哪个字段能被认定为"关键字段"。
   */
  if (a.externalArgs !== undefined) {
    card.appendChild(el("pre", { text: a.externalArgs }));
    card.appendChild(
      el("div", {
        class: "kv bad",
        text:
          "此工具由外部 MCP 服务器执行，不在沙箱内 —— " +
          "Atlas 不解析它的参数，也不约束它能读写什么。",
      }),
    );
  }
  card.appendChild(
    el("div", { class: "row" }, [
      el("button", {
        class: "primary",
        text: "批准",
        onclick: () => answer(p.pendingId, { kind: "APPROVAL", approved: true }),
      }),
      /**
       * 「批准，且本次 Run 不再问」（ADR-0012）。
       *
       * 【定】它与「批准」是**两个**按钮，不是一个带勾选框的。
       * 两者留下的事实不同（这一次记 HUMAN，之后那些记 AUTO），
       * 而一个默认勾上的复选框会让人在没注意的情况下把后者也选了 ——
       * 那等于替他宣称"我逐条批准过全部"。
       *
       * 【定】它只提升**这一个 Run**，不动全局档位。全局档位有它自己的
       * 开关，两个入口做同一件事迟早出现说不清的状态。
       */
      el("button", {
        text: "批准，本次 Run 不再问",
        title:
          "只对这个 Run 生效、不落盘。之后的放行会记为 decidedBy=AUTO —— " +
          "与你亲手批准的那些在时间线上可以区分。",
        onclick: () =>
          answer(p.pendingId, { kind: "APPROVAL", approved: true, alwaysForRun: true }),
      }),
      el("button", {
        class: "danger",
        text: "拒绝",
        onclick: () => answer(p.pendingId, { kind: "APPROVAL", approved: false, reason: "用户在界面上拒绝" }),
      }),
    ]),
  );
  return card;
}

function handoffCard(p) {
  const h = p.handoff;
  const note = el("input", { type: "text", placeholder: "可以先写一句说明（可留空）" });
  return el("div", { class: "card" }, [
    el("h3", { text: "需要你接手一步" }),
    el("div", { class: "kv", text: "要做什么：" }),
    el("pre", { text: h.instructions }),
    el("div", { class: "kv", text: "做完之后应该能看到：" }),
    el("pre", { text: h.expectedCompletion }),
    note,
    el("div", { class: "row" }, [
      el("button", {
        class: "primary",
        text: "我做完了",
        onclick: () => answer(p.pendingId, { kind: "HANDOFF", note: note.value }),
      }),
    ]),
    // §20.3【定】：完成信号 ≠ 任务成功，系统会重新 Observation。
    // 这句话必须在界面上，否则「点一下就算做完」会变成用户的心智模型。
    el("p", { class: "muted", text: "系统会重新去核实，不会只凭你说完成就往下走。" }),
  ]);
}

function questionCard(p) {
  const q = p.question;
  const card = el("div", { class: "card" }, [
    el("h3", { text: "需要你定一下" }),
    el("div", { class: "body", text: q.question }),
  ]);
  for (const o of q.options) {
    card.appendChild(
      el("button", {
        class: "opt",
        text: o,
        onclick: () => answer(p.pendingId, { kind: "QUESTION", choice: o }),
      }),
    );
  }
  const free = el("input", { type: "text", placeholder: "或者自己写一个答案" });
  card.appendChild(free);
  card.appendChild(
    el("div", { class: "row" }, [
      el("button", {
        text: "用我写的",
        onclick: () => answer(p.pendingId, { kind: "QUESTION", choice: free.value }),
      }),
      // 【定】「你自己定」是一条**正常的降级路径**，不是错误（阶段 3.5 决 3）。
      // 措辞跟着语义走，不要写成「跳过」。
      el("button", {
        text: "你自己定",
        onclick: () => answer(p.pendingId, { kind: "QUESTION", choice: "" }),
      }),
    ]),
  );
  return card;
}

async function answer(pendingId, payload) {
  try {
    await api("/api/pending/" + encodeURIComponent(pendingId), { method: "POST", body: payload });
    S.pending = S.pending.filter((p) => p.pendingId !== pendingId);
    renderPending();
  } catch (err) {
    toast(err.message, true);
    void refresh();
  }
}

// ═══════════════════════════════════════════════════════════ 命令与刷新

async function cmd(runId, suffix, body) {
  try {
    await api("/api/runs/" + encodeURIComponent(runId) + suffix, {
      method: "POST",
      body: body || {},
    });
    toast("已提交");
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function refresh() {
  const state = await api("/api/state");
  S.service = state.service;
  S.runs = state.runs;
  S.workspaces = state.workspaces || [];
  S.activeWorkspaceId = state.activeWorkspaceId || "";
  renderService();
  renderWorkspaces();
  renderRuns();
  if (S.runId) {
    /**
     * 【定】记下发起这次请求时选的是哪个 Run，回来之后**再核对一次**。
     *
     * 没有这道 guard 的话，切到 B 之后 A 的慢响应回来会把 `S.detail` 覆盖成 A ——
     * 界面上标题是 B、内容是 A。这类竞态在本地服务上窗口很小，但它一旦发生，
     * 人是看不出来的（两个 Run 长得像）。
     */
    const askedFor = S.runId;
    const d = await api("/api/runs/" + encodeURIComponent(askedFor));
    if (S.runId !== askedFor) return;
    S.detail = d;
    S.pending = d.pending || [];
    document.getElementById("empty").hidden = true;
    document.getElementById("runview").hidden = false;
    renderRunbar();
    renderTabs();
    if (canRefreshTraceInspectorInPlace()) {
      await refreshTraceInspector(d, { preserveScroll: true });
    } else {
      renderView();
    }
    renderPending();
  }
}

/**
 * 收到事件 → 去抖 → **全量重取**。
 *
 * 不做客户端增量合并，理由见 `projection.ts` 结尾那段：跨窗口的工具活动
 * （调用在前一窗口、结果在后一窗口）按 id 覆盖会把入参擦掉，
 * 要做就得做字段级合并 —— 那是一个有真实 bug 空间的设计，
 * 而全量重取的成本是几毫秒。
 */
function scheduleRefresh() {
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(() => void refresh().catch(() => {}), 350);
}

function selectRun(runId) {
  disposeTraceInspector();
  S.runId = runId;
  S.detail = null;
  S.stream = "";
  S.expanded.clear();
  S.traceUi = createTraceUi(runId);
  renderRuns();
  void refresh();
  connectSSE(runId);
}

/**
 * 事件流。游标是 transcript sequence（D-2 那条统一序列）——
 * 一个数字同时定位两条轨道，所以重连只带一个 `since` 就够。
 */
function connectSSE(runId) {
  if (S.sse) S.sse.close();
  const since = S.detail ? S.detail.cursor : 0;
  const es = new EventSource(
    "/api/runs/" + encodeURIComponent(runId) + "/events?since=" + since + "&t=" + encodeURIComponent(TOKEN),
  );
  S.sse = es;
  es.onmessage = (m) => {
    let e;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    if (e.type === "ModelStreamDelta") {
      S.stream += e.payload.text;
      if (S.tab === "timeline") renderView();
      return;
    }
    S.stream = "";
    scheduleRefresh();
  };
  es.addEventListener("pending", (m) => {
    try {
      S.pending = JSON.parse(m.data);
      renderPending();
    } catch {
      /* 忽略 */
    }
  });
  /**
   * 【定】重连失败要说出来。
   *
   * EventSource 自己会重连，并把 `Last-Event-ID` 带上（服务端现在真的读它了，
   * 见 `readCursor`）。但有一种失败它永远退不出来：**服务重启后 Token 轮换**，
   * 旧 Token 的连接会一直 401 重试。原本这里什么都不做，页面上没有任何提示，
   * 用户只会看到「不再更新了」。
   */
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      toast("事件流已断开（服务可能重启过 —— 用终端新打印的 URL 重开）", true);
    }
  };
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "\n…（预览截断，共 " + s.length + " 字符）" : s;
}

// ═══════════════════════════════════════════════════════════════ 启动

document.getElementById("newrun").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const task = document.getElementById("task").value.trim();
  if (!task) return;
  const btn = document.getElementById("startbtn");
  const state = document.getElementById("startstate");
  btn.disabled = true;
  state.textContent = "正在启动……";
  try {
    const mode = document.getElementById("approvalmode").value;
    // 预算：只送填了值的那几条。一条都没填就整个字段不送 ——
    // 送一个空对象与不送在服务端等价，但少一个字段就少一次"它到底改没改"的疑问。
    const budgets = readBudgetInputs();
    const r = await api("/api/runs", {
      method: "POST",
      body: { task, approvalMode: mode, ...(budgets ? { budgets } : {}) },
    });
    state.textContent = "";
    document.getElementById("task").value = "";
    await refresh();
    selectRun(r.runId);
  } catch (err) {
    state.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("refresh").addEventListener("click", () => void refresh());

document.getElementById("wspicker").addEventListener("change", (ev) => {
  void switchWorkspace(ev.target.value);
});

/**
 * 运行中随时拨审批档位（ADR-0012）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】提交栏那个选择器**同时**是运行中的开关，只有这一个控件。
 *
 * 做成两个（一个"这次用什么档"、一个"现在改成什么档"）的直接后果是界面上
 * 出现两个都自称当前档位的东西，而它们对"下一次审批会不会弹"给出不同答案。
 * 一个控件、一个事实来源：改它就立刻生效，不管有没有 Run 在跑。
 *
 * 【定】它不会让**已经弹出来**的那个审批请求消失（服务端那侧同一条【定】）。
 * 那一条已经问出口了、人看得见它，让它凭空消失比多问一次更糟。
 * 档位管的是「下一次要不要问」。
 * ══════════════════════════════════════════════════════════════════════
 */
document.getElementById("approvalmode").addEventListener("change", async (ev) => {
  const mode = ev.target.value;
  const state = document.getElementById("startstate");
  try {
    await api("/api/approval-mode", { method: "POST", body: { mode } });
    state.textContent =
      mode === "AUTO"
        ? "已切到 AUTO：从下一次起不再询问（正在等的那一条仍需你处理）"
        : "审批档位已切到 " + mode;
    await refresh();
  } catch (err) {
    state.textContent = err.message;
    // 【定】失败要把选择器**拨回去**。留在用户选的那个值上，界面就会显示
    // 一个服务端并不认可的档位 —— 而他会据此以为自己不会再被打扰。
    await refresh();
  }
});

const wsForm = document.getElementById("wsform");
document.getElementById("wsnew").addEventListener("click", () => {
  wsForm.hidden = !wsForm.hidden;
  if (!wsForm.hidden) document.getElementById("wsinput").focus();
});
document.getElementById("wscancel").addEventListener("click", () => {
  wsForm.hidden = true;
});
wsForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = document.getElementById("wsinput");
  const path = input.value.trim();
  if (!path) return;
  try {
    const r = await api("/api/workspaces", { method: "POST", body: { path } });
    /**
     * 【定】warnings 要**显示出来**，而且不能一闪而过。
     *
     * 服务端对「目录根下有 .git / .env」只提醒不拒绝 —— 用户有权把仓库根当
     * workspace。但 Agent 在 workspace 内**有写权限**（读有黑名单挡着，写没有），
     * 那是他做决定时应该看见的事实。吞掉它等于替他做了决定。
     */
    clear(wsWarn);
    for (const w of r.warnings || []) wsWarn.appendChild(el("div", { text: "⚠️ " + w }));
    input.value = "";
    wsForm.hidden = true;
    await switchWorkspace(r.workspace.id);
  } catch (err) {
    clear(wsWarn);
    wsWarn.appendChild(el("div", { class: "bad", text: err.message }));
  }
});
const wsWarn = el("div", { class: "ws-warn" });
document.getElementById("wsbox").appendChild(wsWarn);

void refresh().catch((err) => {
  document.getElementById("empty").textContent =
    "连不上服务：" + err.message + "（Token 过期了？重新用终端打印的那个 URL 打开）";
});
