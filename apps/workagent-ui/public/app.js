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
};

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
  for (const n of s.notices || []) box.appendChild(item("⚠️", n, "warn"));
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
    await api("/api/workspaces/" + encodeURIComponent(id) + "/activate", { method: "POST" });
    // 【定】切换之后必须把当前选中的 Run 清掉 —— 另一个 workspace 有它自己的库，
    // 旧 runId 在那边根本不存在，留着会让详情区停在一个查不到的 Run 上。
    S.runId = "";
    S.detail = null;
    if (S.sse) S.sse.close();
    document.getElementById("runview").hidden = true;
    document.getElementById("empty").hidden = false;
    await refresh();
    toast("已切换工作空间");
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

  if (d.outcome) {
    bar.appendChild(
      el("span", { class: "chip " + (d.outcome.kind === "SUCCESS" ? "ok" : "bad"), text: d.outcome.kind }),
    );
  }
  bar.appendChild(
    el("span", {
      class: "kv",
      text:
        "轨道：transcript " + d.tracks.transcriptEntries + " 条 / 事件 " + d.tracks.events + " 条",
    }),
  );

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

function renderTabs() {
  const nav = document.getElementById("tabs");
  clear(nav);
  for (const [key, label] of TABS) {
    nav.appendChild(
      el("button", {
        class: S.tab === key ? "active" : "",
        text: label,
        onclick: () => {
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

async function renderTrace(view, d) {
  view.appendChild(
    el("p", { class: "kv", text: d.tracks.traceFile ? "文件：" + d.tracks.traceFile : "（没有 trace 文件）" }),
  );
  const body = el("div", {}, [el("p", { class: "muted", text: "读取中……" })]);
  view.appendChild(body);
  let lines = [];
  try {
    lines = (await api("/api/runs/" + encodeURIComponent(d.runId) + "/trace")).lines || [];
  } catch (err) {
    clear(body);
    body.appendChild(el("p", { class: "muted", text: "读不到：" + err.message }));
    return;
  }
  clear(body);
  const counts = {};
  for (const l of lines) if (l.kind === "event") counts[l.type] = (counts[l.type] || 0) + 1;
  body.appendChild(
    el("p", { class: "kv", text: "共 " + lines.length + " 行；事件类型：" +
      Object.keys(counts).sort().map((k) => k + " × " + counts[k]).join("、") }),
  );
  for (const l of lines) {
    if (l.kind === "header") {
      // header 的段号是 N-1 的落点：一个 Run 跨三个进程仍是同一个文件，
      // 三段 header 并排着看才知道每段用的是哪个 commit / 工作树是否 dirty。
      body.appendChild(
        el("div", { class: "entry SYSTEM_NOTICE" }, [
          el("div", { class: "head" }, [
            el("span", { class: "tag", text: "段 " + (l.segmentIndex ?? 0) }),
            el("span", { class: "chip", text: "commit " + String(l.commit).slice(0, 10) }),
            el("span", { class: "chip " + (l.gitDirty === true ? "warn" : ""), text: "gitDirty " + l.gitDirty }),
            el("span", { class: "chip", text: l.modelId }),
          ]),
          el("div", { class: "kv", text: l.startedAt + "｜" + l.endpointProfile }),
        ]),
      );
    } else if (l.kind === "footer") {
      body.appendChild(
        el("div", { class: "entry SYSTEM_NOTICE WARN" }, [
          el("div", { class: "head" }, [el("span", { class: "tag", text: "段尾" })]),
          el("pre", { text: JSON.stringify(l, null, 2) }),
        ]),
      );
    } else {
      body.appendChild(
        el("div", { class: "entry" }, [
          el("div", { class: "head" }, [
            el("span", { class: "seq", text: "#" + l.sequence }),
            el("span", { class: "tag", text: l.type }),
          ]),
          el("pre", { text: JSON.stringify(l.payload) }),
        ]),
      );
    }
  }
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
        text:
          "沙箱：只能写 workspace 与本次调用的 $TMPDIR；" +
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
  card.appendChild(
    el("div", { class: "row" }, [
      el("button", {
        class: "primary",
        text: "批准",
        onclick: () => answer(p.pendingId, { kind: "APPROVAL", approved: true }),
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
    renderView();
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
  S.runId = runId;
  S.detail = null;
  S.stream = "";
  S.expanded.clear();
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
    const r = await api("/api/runs", { method: "POST", body: { task } });
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
