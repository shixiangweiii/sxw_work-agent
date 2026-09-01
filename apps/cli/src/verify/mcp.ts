/**
 * ADR-0011 验收：通用 MCP 客户端能力（verify:mcp）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 要答的问题：**外部工具面能不能接进来，而不放弃 Atlas 的声明纪律？**
 *
 * 全程用手写的假 MCP 服务器（`fixtures/fake-mcp-server.ts`），
 * **不依赖 Playwright、不联网、不弹窗口** —— 理由见那个文件的文件头：
 * 拿一个真实服务器当夹具，测的就成了"能不能接 Playwright"，
 * 而这一批要答的是"能不能接**任意** MCP"。
 *
 * 【定】每条判据都要有一次注入实测（改坏对应实现必须当场翻红）。
 * 本仓连续两批出现"判据测的不是它声称在测的东西"，两次都是写完之后
 * 才发现的 —— 靠记是记不住的，只能靠每加一条就injection 一次。
 * A 段的注入在脚本里就地做了；其余六条各做过一次**外部注入实测**
 * （把实现改坏 → 跑本脚本 → 退出码必须非 0 → 改回）。
 *
 * ⚠️ 那一轮抓到了 D 段第一版的真实缺陷：它直接调 `handler.execute`，
 * 而 `actionFor` 自己造好了 `normalizedInput` —— **校验器根本不在那条路径上**。
 * 把 array 分支改成无条件报错，那条判据照样是绿的。
 * 与摸底考试 `read_blob.line_offset` 一字不差：判据打在下游，跨不过出事那一跳。
 * ══════════════════════════════════════════════════════════════════════
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { evaluatePolicy, TRUSTED_PERSONAL, validateAndNormalize } from "@workagent/harness-runtime";
import type {
  PreparedAction,
  RunId,
  ToolExecutionContext,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import {
  connectMcpServers,
  loadMcpConfig,
  parseMcpConfig,
  type McpConfig,
  type McpRuntime,
} from "@workagent/tools-mcp";
import { REPO_ROOT, compose } from "../compose.js";
import { BOUNDARIES, grepBoundary } from "./boundaries.js";
import {
  ScriptedModelPort,
  banner,
  fact,
  runVerify,
  section,
  tempWorkspace,
  verdict,
} from "./harness.js";

const FIXTURE = resolve(REPO_ROOT, "apps/cli/src/verify/fixtures/fake-mcp-server.ts");
const TSX = resolve(REPO_ROOT, "node_modules/.bin/tsx");

function configFor(tools?: Record<string, "read" | "execute">): McpConfig {
  return parseMcpConfig(
    {
      servers: {
        fake: {
          type: "local",
          command: [TSX, FIXTURE],
          ...(tools ? { tools } : {}),
          timeout: { startup: 30_000, request: 20_000 },
        },
      },
    },
    "(夹具)",
  );
}

/** 造一个够 handler 用的 PreparedAction。Runtime 只读这几个字段。 */
function actionFor(toolName: string, input: Record<string, unknown>): PreparedAction {
  return {
    toolName,
    normalizedInput: input,
  } as unknown as PreparedAction;
}

function ctxFor(root: string): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: root,
    onProgress: () => {},
    timezone: "Asia/Shanghai",
    executionPrivilege: "SANDBOXED",
  };
}

async function main(): Promise<void> {
  banner(
    "ADR-0011 验收：通用 MCP 客户端能力（verify:mcp）",
    "外部工具面能不能接进来，而不放弃 Atlas 的声明纪律？换个 MCP 是不是只改配置？",
  );

  const ws = tempWorkspace();
  cleanupWs = ws.cleanup;

  // ════════════════════════════════════════════════════ A. 边界 12
  section("A. 边界 12：MCP 客户端不得进 Runtime / 适配器");
  console.log(
    "   它与边界 7（沙箱与命令解析）同源，但更隐蔽：MCP 的诱惑**不需要 import\n" +
      "   任何工具包** —— 把 StdioClientTransport 搬进 `packages/harness-runtime/src/ports/`\n" +
      "   就行，那里本来就叫 Port。搬进去之后边界 4 / 6 / 7 一条都不会响。",
  );
  const b12 = BOUNDARIES.find((b) => b.id === "12");
  if (!b12) {
    verdict(false, "边界表里找不到编号 12 —— 它是不是被删了？");
    return;
  }
  fact("边界 12 当前命中", grepBoundary(b12).length === 0 ? "干净" : grepBoundary(b12).join(" | "));

  /**
   * 判别力实测：往 Runtime 里注入一行真实的 SDK import。
   *
   * 【定】"现在干净"不等于"发现得了违规" —— 一个永远返回空的检查器
   * 与一个正确的检查器，在上面那条断言下完全不可区分。阶段 4 的边界 8
   * 就是靠这一步才证明自己不是恒真式的。
   */
  const canary = resolve(REPO_ROOT, "packages/harness-runtime/src/__mcp_canary.ts");
  let injectedHit: string[] = [];
  try {
    writeFileSync(
      canary,
      'import { Client } from "@modelcontextprotocol/sdk/client/index.js";\nexport const x = Client;\n',
      "utf8",
    );
    injectedHit = grepBoundary(b12);
  } finally {
    rmSync(canary, { force: true });
  }
  fact("注入后边界 12 命中", injectedHit[0] ?? "（没命中 —— 说明这条 grep 是瞎的）");
  fact("注入文件已清理", "是");
  verdict(
    injectedHit.length > 0 && injectedHit[0]!.includes("__mcp_canary"),
    injectedHit.length > 0
      ? "往 Runtime 注入一行 MCP SDK import，边界 12 当场翻红并指出行号 —— 它有判别力"
      : "注入了违规却没被抓到 —— 边界 12 是一条永远为绿的装饰",
  );

  // ══════════════════════════════════════════ B. 默认档位 = 最保守
  section("B. 不写 tools 段 → 全部落最保守档");
  console.log(
    "   【定】声明的来源只能是**人**：要么是配置里的 tools 段（人写的），\n" +
      "   要么是最保守的默认档（人没写，那就按最坏的算）。\n" +
      "   **不读 MCP 的 annotations** —— 那是服务器自述的，拿它决定审批档位\n" +
      "   等于让被审计方书写自己的审计规则（与「命令名匹配不是安全边界」同源）。\n\n" +
      "   注意夹具服务器的工具**没有声明任何 annotations**，所以这一段真正\n" +
      "   证明的是「默认档是保守的」；「不读 annotations」由代码里那条注释\n" +
      "   与 config.ts 的零解析点保证。",
  );

  const plain = await connectMcpServers({ configPath: "(不读盘)", workspaceRoot: ws.root, config: configFor() });
  mcpToClose.push(plain);

  const names = plain.snapshots.map((s) => s.definition.name);
  fact("装配的工具", names.join(", "));
  const allExecute = plain.snapshots.every(
    (s) =>
      !s.definition.idempotency.isReadOnly &&
      !s.definition.idempotency.isIdempotent &&
      s.definition.recoveryObservation.requiresPreFingerprint,
  );
  verdict(
    allExecute && plain.snapshots.length > 0,
    allExecute
      ? `${plain.snapshots.length} 个工具全部落 execute 档（非只读 / 非幂等 / 需前置指纹）—— 默认在最坏的那一侧`
      : "有工具没落最保守档 —— 默认值偏向了放行",
  );

  /**
   * ── 【定】默认最保守是对的，但**不能不说** ────────────────────────────
   *
   * 实测（Run `run_18c20267c1a1`）：用户的活配置没有 `tools` 段 →
   * 24 个 Playwright 工具全部落 execute → **11 次调用 = 11 次审批**。
   *
   * 那次没出事只因为**零错误**，是侥幸不是机制：execute 档一旦报错就记
   * `UNKNOWN` → RecoveryItem → `COMPLETED_WITH_LIMITS`，**这个 Run 就再也
   * 拿不到 SUCCESS**，而浏览器自动化里报错很常见。
   *
   * 【定】提示里必须出现那个**真正的**理由，不能写成「审批问得烦」——
   * 后者会让用户为了少按几次回车去标 read，那正是「从偏好推出属性」的
   * 那次不成立的合并（见 config.ts 里 ToolTier 的说明）。
   */
  const hint = plain.notices.join("\n");
  fact("没配 tools 段时的提示", hint.includes("tools 段") ? "有" : "（没有 —— 用户不会知道这件事）");
  verdict(
    hint.includes("tools 段") && hint.includes("SUCCESS"),
    hint.includes("tools 段") && hint.includes("SUCCESS")
      ? "没配 tools 段时会提示，且说的是真正的理由（execute 档报错一次就让 Run 永远拿不到 SUCCESS），不是「问得烦」"
      : `提示缺失或没说清理由：${hint.slice(0, 120)}`,
  );

  // ══════════════════════════════════════ G. 分页（放在这里因为要用 plain）
  section("G. tools/list 分页：三页的工具必须全部装上");
  console.log(
    "   抄自 opencode 的实战细节 —— `tools/list` 是 cursor 分页的。\n" +
      "   漏了分页的症状不是报错，是**工具面莫名其妙少了一截**，\n" +
      "   而少掉的那些模型根本不知道存在过。夹具刻意分了三页。",
  );
  /**
   * 【定】判据是**每页一个哨兵**，不是一个工具总数。
   *
   * 这里原来写的是 `=== 6`。那个数字与判据要证明的东西无关 ——
   * 给夹具加一个工具（本轮 D2 / I2 两段各加了几个）它就翻红，
   * 而下一个人会顺手把 6 改成 11、不去想它到底在测什么。
   * 一条**因为被测对象变大而报错**的判据不是判据，是维护负担。
   *
   * 分页要证明的只有一件事：**没有提前停下**。三个哨兵各在一页，
   * 而 cursor 语义保证跳不过中间页 —— 第三页的在场就是那个判别力。
   */
  const sentinels = [
    ["第 1 页", "echo_text"],
    ["第 2 页", "wants_object"],
    ["第 3 页", "page3_marker"],
  ] as const;
  fact("工具总数（记录用）", plain.snapshots.length);
  const missing = sentinels.filter(([, t]) => !names.some((n) => n.endsWith(t)));
  for (const [page, tool] of sentinels) {
    fact(`${page} 哨兵 ${tool}`, names.some((n) => n.endsWith(tool)) ? "在场" : "缺席");
  }
  verdict(
    missing.length === 0,
    missing.length === 0
      ? "三页的哨兵工具全部在场 —— 分页翻到了最后一页"
      : `分页提前停了：${missing.map(([p, t]) => `${p}(${t})`).join("、")} 缺席`,
  );

  // ══════════════════════════════════════════════ C. read 档
  section("C. read 档 → READ ＋ 幂等 ＋ Policy 不要审批（两侧都验）");
  console.log(
    "   【定】正反两侧都要验。只验「execute 要审批」的话，一个把所有工具\n" +
      "   都判成要审批的实现照样全绿 —— 那正是阶段 3.5 沙箱栽过的跤\n" +
      "   （一个拒绝一切的沙箱与一个正确的沙箱，在单侧判据下不可区分）。",
  );
  const tiered = await connectMcpServers({
    configPath: "(不读盘)",
    workspaceRoot: ws.root,
    config: configFor({ echo_text: "read" }),
  });
  mcpToClose.push(tiered);

  const readTool = tiered.snapshots.find((s) => s.definition.name.endsWith("echo_text"))!;
  const execTool = tiered.snapshots.find((s) => s.definition.name.endsWith("wants_array"))!;
  const resolverOf = (name: string, version: string) => tiered.resolvers.get(`mcp:${name}@${version}`)!;

  const readEffect = resolverOf(readTool.definition.name, readTool.version).resolve({}, ws.root);
  const execEffect = resolverOf(execTool.definition.name, execTool.version).resolve({}, ws.root);

  fact("read 档 effectType / scope", `${readEffect.effectType} / ${readEffect.scope.kind}`);
  fact("execute 档 effectType / scope", `${execEffect.effectType} / ${execEffect.scope.kind}`);

  const readVerdict = evaluatePolicy({
    action: { resolvedEffect: readEffect } as unknown as PreparedAction,
    approvalPolicy: TRUSTED_PERSONAL,
    executionPrivilege: "SANDBOXED",
  });
  const execVerdict = evaluatePolicy({
    action: { resolvedEffect: execEffect } as unknown as PreparedAction,
    approvalPolicy: TRUSTED_PERSONAL,
    executionPrivilege: "SANDBOXED",
  });
  fact("read 档 Policy 判定", readVerdict.decision);
  fact("execute 档 Policy 判定", execVerdict.decision);

  verdict(
    readVerdict.decision === "ALLOW" &&
      readTool.definition.idempotency.isReadOnly &&
      execVerdict.decision === "REQUIRE_APPROVAL",
    readVerdict.decision === "ALLOW" && execVerdict.decision === "REQUIRE_APPROVAL"
      ? "read 档直接放行且声明只读；execute 档要审批 —— 两侧都成立"
      : `档位没起作用：read=${readVerdict.decision}，execute=${execVerdict.decision}`,
  );

  // ══════════════════════════════ J. 审批面不得复用 run_shell 的沙箱说辞
  section("J. scope.kind 必须是 EXTERNAL_TOOL，不得是 PROCESS");
  console.log(
    "   **本批最要紧的一条判据。** 审批展示按 `scope.kind` 分派，而 PROCESS\n" +
      "   那一支是 run_shell 专属的：它读 input[\"command\"]，并打印\n" +
      "   「沙箱：只能写 workspace 与本次调用的 $TMPDIR」。\n\n" +
      "   **MCP 工具没有任何沙箱。** 复用 PROCESS 的后果是人在批准的那一刻\n" +
      "   看到一句方向相反的保证，而命令原文那栏是「(读不到命令原文)」——\n" +
      "   一个看起来有闸门、实际在说假话的闸门，比没有闸门更糟。\n\n" +
      "   注入实测（手动）：把 tool-bridge.ts 的 scope.kind 改回 \"PROCESS\"，本条必须翻红。",
  );
  fact("execute 档 scope.kind", execEffect.scope.kind);
  fact("execute 档 scope.value", execEffect.scope.value);
  fact("riskFacts", execEffect.riskFacts.join(", "));
  verdict(
    execEffect.scope.kind === "EXTERNAL_TOOL" &&
      execEffect.riskFacts.includes("NO_SANDBOX") &&
      execEffect.scope.value.includes("/"),
    execEffect.scope.kind === "EXTERNAL_TOOL" && execEffect.riskFacts.includes("NO_SANDBOX")
      ? "scope.kind 是 EXTERNAL_TOOL（不会落进 run_shell 的展示分支），且 riskFacts 里记着 NO_SANDBOX"
      : `scope.kind=${execEffect.scope.kind}，riskFacts=${execEffect.riskFacts.join(",")} —— 审批面会说假话`,
  );

  // ═══════════════════════════════════ J2. 外发必须留下审计事实
  section("J2. dataMovement 必须存在，哪怕值只能是「无法解析」");
  console.log(
    "   V05 §22.3：向外发送本地数据时，ResolvedEffect 要记录 data movement、\n" +
      "   目的地与数据范围。Atlas 不解析 MCP 的参数（那是「换个 MCP 只改配置」\n" +
      "   的代价），所以给不出真实 destination。\n\n" +
      "   【定】但**「解析不了」不等于「可以不记」**：一个不存在的 dataMovement\n" +
      "   与「查过、这次没有外发」在事后完全不可区分，而后者是假话。\n" +
      "   先例在 effect-resolver.ts —— URL 解析失败时写 \"(无法解析)\"，\n" +
      "   注释是「解析不了就如实写，不要猜」。",
  );
  fact("execute 档 dataMovement", JSON.stringify(execEffect.dataMovement));
  fact("read 档 dataMovement", JSON.stringify(readEffect.dataMovement));
  fact("read 档 riskFacts", readEffect.riskFacts.join(", "));
  verdict(
    execEffect.dataMovement !== undefined &&
      readEffect.dataMovement !== undefined &&
      execEffect.riskFacts.includes("DATA_LEAVES_HOST") &&
      readEffect.riskFacts.includes("DATA_LEAVES_HOST"),
    execEffect.dataMovement !== undefined && readEffect.dataMovement !== undefined
      ? "两个档位都留下了 dataMovement ＋ DATA_LEAVES_HOST —— read 档说的是「不改外部状态」，不是「不往外送数据」"
      : "dataMovement 缺席 —— 在事实表上等于宣称「这次调用没有数据外发」",
  );

  // ═════════════════════════════════════ D. 数组 / 嵌套对象逐字送达
  section("D. array / 嵌套 object 参数必须装得上、调得通、逐字送达");
  console.log(
    "   放宽 JsonSchema 之前，`typeof [] !== \"array\"` 会让 validateAndNormalize\n" +
      "   直接报 schema 错 —— 工具装得上、模型看得见、每次调用都被 Runtime 挡在\n" +
      "   门口，而它无从改对。这正是「换个 MCP 只改配置」最容易破功的地方。\n\n" +
      "   【定】判据必须让**服务器**把它实际收到的东西说回来。在 Atlas 这一侧\n" +
      "   断言「我发出去了」是内存自比 —— 测不出中间那一跳，而那一跳正是出事的地方。",
  );

  const arrayTool = tiered.snapshots.find((s) => s.definition.name.endsWith("wants_array"))!;
  const props = arrayTool.definition.inputSchema.properties as Record<string, { type?: unknown }>;
  fact("values 的 type（原样保留？）", JSON.stringify(props["values"]?.type));
  fact("values 的 items 是否保留", JSON.stringify((props["values"] as Record<string, unknown>)["items"]));

  /**
   * ── 【定】必须**先过 `validateAndNormalize`**，再把它的产出喂给 handler ──
   *
   * 这一条是本段第一版的真实缺陷，而且是注入实测抓出来的：
   * 第一版直接 `handler.execute(actionFor(name, args))`，而 `actionFor` 自己
   * 造好了 `normalizedInput` —— **校验器根本不在那条路径上**
   * （它由 `settle-batch` / `facade` 调用）。于是我把 array 分支改坏、
   * 让它无条件报错，这条判据**照样是绿的**。
   *
   * 与摸底考试 `read_blob.line_offset` 那次一字不差：判据打在下游的 Port 上，
   * 跨不过真正出事的那一跳。所以这里显式走两步，两步都断言。
   */
  const sentArgs = { values: ["a", "b", "c"], count: 3 };
  const validated = validateAndNormalize(sentArgs, arrayTool.definition.inputSchema, arrayTool.definition.name);
  fact("校验器是否放行 array 入参", validated.ok ? "放行" : `拒绝：${validated.error?.safeMessage}`);
  verdict(
    validated.ok,
    validated.ok
      ? "`validateAndNormalize` 放行了 array ＋ integer 入参 —— 放宽真的接在生产路径上"
      : `校验器把合法的 MCP 入参挡了下来：${validated.error?.safeMessage}`,
  );

  const out = await tiered.handler.execute(
    actionFor(arrayTool.definition.name, (validated.normalized ?? {}) as Record<string, unknown>),
    ctxFor(ws.root),
  );
  const echoed = out.ok ? (JSON.parse(out.output) as { received?: unknown }) : undefined;
  fact("服务器实际收到", JSON.stringify(echoed?.received));
  verdict(
    out.ok && JSON.stringify(echoed?.received) === JSON.stringify(sentArgs),
    out.ok && JSON.stringify(echoed?.received) === JSON.stringify(sentArgs)
      ? "数组与整数参数**逐字**送到了服务器 —— 校验器没有丢也没有改"
      : `参数没能原样送达：${out.ok ? JSON.stringify(echoed?.received) : out.error?.safeMessage}`,
  );

  const objTool = tiered.snapshots.find((s) => s.definition.name.endsWith("wants_object"))!;
  const objArgs = { config: { host: "h", port: 1 }, mode: "fast", anything: "任意" };
  const objValidated = validateAndNormalize(objArgs, objTool.definition.inputSchema, objTool.definition.name);
  const objOut = await tiered.handler.execute(
    actionFor(objTool.definition.name, (objValidated.normalized ?? {}) as Record<string, unknown>),
    ctxFor(ws.root),
  );
  const objEcho = objOut.ok ? (JSON.parse(objOut.output) as { received?: unknown }) : undefined;
  fact("校验器是否放行嵌套对象", objValidated.ok ? "放行" : `拒绝：${objValidated.error?.safeMessage}`);
  fact("嵌套对象实际收到", JSON.stringify(objEcho?.received));
  verdict(
    objValidated.ok && objOut.ok && JSON.stringify(objEcho?.received) === JSON.stringify(objArgs),
    objValidated.ok && objOut.ok && JSON.stringify(objEcho?.received) === JSON.stringify(objArgs)
      ? "嵌套对象、enum 字段、以及一个**没有 type** 的属性，过了校验器又原样送达"
      : `嵌套对象没能走通：${!objValidated.ok ? objValidated.error?.safeMessage : objOut.ok ? JSON.stringify(objEcho?.received) : objOut.error?.safeMessage}`,
  );

  // ══════════════════════ D2. 参数不在根 properties 里的四种开放 schema
  section("D2. 根 properties 之外的参数必须原样送达（四种开放 JSON Schema）");
  console.log(
    "   这是**二次评审抓到的最严重一条**，也是本批最重要的通用性判据。\n\n" +
      "   `normalizeSchemaShell` 曾经在翻译时伪造 `properties: {}`，然后\n" +
      "   `validateAndNormalize` 按那份**自己伪造的** schema 把模型入参整个裁掉 ——\n" +
      "   校验通过、下游收到 `{}`、零报错、模型无从发现意图被改写。\n\n" +
      "   【定】它的成因值得记：我一边写着「从不试图理解那个 schema」，一边用了\n" +
      "   一个**只有理解过才成立的假设**（properties 覆盖全部参数）去裁参数。\n" +
      "   凡是 Atlas 对 MCP 说出的话，都要先问「这句需要理解参数才能成立吗」。",
  );

  const openCases: Array<{ tool: string; args: Record<string, unknown>; why: string }> = [
    { tool: "open_additional", args: { region: "cn", lang: "zh" }, why: "additionalProperties 动态键" },
    { tool: "open_pattern", args: { opt_a: "1", opt_b: "2" }, why: "patternProperties" },
    { tool: "open_ref", args: { url: "https://example.com/x" }, why: "根级 $ref" },
    { tool: "open_oneof", args: { url: "https://example.com/y" }, why: "根级 oneOf" },
  ];

  let openOk = 0;
  for (const c of openCases) {
    const snap = tiered.snapshots.find((s) => s.definition.name.endsWith(c.tool));
    if (!snap) {
      fact(`${c.why}（${c.tool}）`, "工具没装上");
      continue;
    }
    const v = validateAndNormalize(c.args, snap.definition.inputSchema, snap.definition.name);
    const r = await tiered.handler.execute(
      actionFor(snap.definition.name, (v.normalized ?? {}) as Record<string, unknown>),
      ctxFor(ws.root),
    );
    const got = r.ok ? (JSON.parse(r.output) as { received?: unknown }).received : undefined;
    const same = JSON.stringify(got) === JSON.stringify(c.args);
    if (same) openOk += 1;
    fact(`${c.why}（${c.tool}）`, `发出 ${JSON.stringify(c.args)} → 服务器收到 ${JSON.stringify(got)}`);
  }
  verdict(
    openOk === openCases.length,
    openOk === openCases.length
      ? `四种开放 schema 的参数**逐字**送达服务器 —— 根 properties 缺席时不再裁剪`
      : `${openCases.length - openOk}/${openCases.length} 种开放 schema 的参数在半路被裁掉了`,
  );

  // 【定】反向的一半：显式 additionalProperties:false 时**必须**照旧丢弃。
  // 少了它，一个「什么都保留」的实现同样能让上面那条绿 —— 而那会让
  // Atlas 自家工具的 inputDigest 被模型幻觉污染。
  const strictSchema = {
    type: "object" as const,
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  const strict = validateAndNormalize({ a: "x", hallucinated: "y" }, strictSchema, "strict_probe");
  fact("显式 additionalProperties:false 时", JSON.stringify(strict.normalized));
  verdict(
    strict.ok && JSON.stringify(strict.normalized) === JSON.stringify({ a: "x" }),
    strict.ok && JSON.stringify(strict.normalized) === JSON.stringify({ a: "x" })
      ? "schema 说了「就这些」就照旧丢弃 —— 保留不是无条件的，是按 JSON Schema 的标准语义判的"
      : `严格档位失效了：${JSON.stringify(strict.normalized)}`,
  );

  // ════════════════════════════════════════ F. isError 按档位分流
  section("F. isError 的副作用分流：read → NO_EFFECT，execute → UNKNOWN（两侧都验）");
  console.log(
    "   已回源码确认：`sideEffectState === \"UNKNOWN\"` → settle-batch push 一个\n" +
      "   RecoveryItem → settle-outcome 把 kind 降成 COMPLETED_WITH_LIMITS。\n" +
      "   也就是说 **execute 档每报错一次，这个 Run 就再也拿不到 SUCCESS**。\n" +
      "   这是刻意的（Atlas 真的不知道那次点击发生了没有），也正因如此\n" +
      "   read 档必须真的走另一条路 —— 否则那个降级信号会变成一盏永远亮着的灯。",
  );

  const errAsExec = await tiered.handler.execute(
    actionFor(tiered.snapshots.find((s) => s.definition.name.endsWith("always_errors"))!.definition.name, {}),
    ctxFor(ws.root),
  );
  const readErrRt = await connectMcpServers({
    configPath: "(不读盘)",
    workspaceRoot: ws.root,
    config: configFor({ always_errors: "read" }),
  });
  mcpToClose.push(readErrRt);
  const errAsRead = await readErrRt.handler.execute(
    actionFor(
      readErrRt.snapshots.find((s) => s.definition.name.endsWith("always_errors"))!.definition.name,
      {},
    ),
    ctxFor(ws.root),
  );

  fact("execute 档报错 → sideEffectState", errAsExec.sideEffectState);
  fact("read 档报错 → sideEffectState", errAsRead.sideEffectState);

  /**
   * ── 【定】服务器原文**不得**出现在 `safeMessage`（二次评审 codex P1-1）─────
   *
   * 这一行原来是 `fact("错误里带上了服务器原文", …)` —— 把一条**泄漏路径
   * 当成正向事实打印**，等于反向固化了错误实现。
   *
   * `safeMessage` 的类型注释写着「**已脱敏**，可以展示给用户」，而
   * `settle-batch` 的脱敏只处理 `outcome.output`；失败分支走
   * `renderError()`，它只读 `safeMessage`。两件事凑起来，服务器原文
   * （可能带 session token、Cookie、内网主机名）会**未经脱敏**落进
   * transcript 与下一轮上下文 —— 违反不变量 13。
   *
   * 正确形态是：原文放 `output` 走脱敏管道，`safeMessage` 只写 Atlas
   * 自己生成的话。**两侧都要验** —— 只验「不在 safeMessage」的话，
   * 一个把原文整个丢掉的实现照样绿，而那会让模型失去纠错依据。
   */
  const leaked = errAsExec.error?.safeMessage.includes("按设计总是失败") === true;
  const carried = errAsExec.output.includes("按设计总是失败");
  fact("服务器原文在 safeMessage 里（应为否）", leaked ? "是 —— 绕过脱敏！" : "否");
  fact("服务器原文在 output 里（应为是）", carried ? "是" : "否 —— 模型拿不到细节");
  verdict(
    !leaked && carried,
    !leaked && carried
      ? "服务器原文走 output（过脱敏管道），safeMessage 只有 Atlas 自己生成的话"
      : leaked
        ? "服务器原文进了 safeMessage —— 它绕过 settle-batch 的脱敏直达 transcript"
        : "服务器原文两边都没有 —— 模型失去了纠错依据",
  );

  verdict(
    errAsExec.sideEffectState === "UNKNOWN" &&
      errAsRead.sideEffectState === "NO_EFFECT" &&
      !errAsExec.ok &&
      !errAsRead.ok,
    errAsExec.sideEffectState === "UNKNOWN" && errAsRead.sideEffectState === "NO_EFFECT"
      ? "两侧分流成立：execute 档记「副作用未知」（会降级 Run），read 档记「没有副作用」"
      : `分流没生效：execute=${errAsExec.sideEffectState}，read=${errAsRead.sideEffectState}`,
  );

  // 成功路径也要验 —— 否则一个恒返回 UNKNOWN 的实现在上面那条下照样绿。
  fact("execute 档成功 → sideEffectState", out.sideEffectState);
  verdict(
    out.sideEffectState === "APPLIED",
    out.sideEffectState === "APPLIED"
      ? "execute 档**成功**时记 APPLIED，不是 UNKNOWN —— 正常调用不会 push RecoveryItem"
      : `成功时记成了 ${out.sideEffectState}，每次正常调用都会让 Run 降级`,
  );

  // ═══════════════════════════════════════════════ I. image 块
  section("I. image 块：不假装成功，也不静默丢弃");
  console.log(
    "   与 fetch_url 对二进制的处置同一条纪律：把 base64 图片塞进上下文，\n" +
      "   得到的是几十万个无意义 token，而模型没有办法看出那是解码垃圾；\n" +
      "   静默丢掉同样糟 —— 模型会以为自己看到了截图的全部内容。\n" +
      "   所以：丢掉正文，但**说出来丢了什么**。（ADR-0010 同族的洞，v1 不补通道。）",
  );
  const imgOut = await tiered.handler.execute(
    actionFor(tiered.snapshots.find((s) => s.definition.name.endsWith("returns_image"))!.definition.name, {}),
    ctxFor(ws.root),
  );
  fact("返回文本", imgOut.output.replace(/\n/g, " ⏎ ").slice(0, 160));
  const saidSo = imgOut.output.includes("没有进入上下文") && imgOut.output.includes("image");
  verdict(
    imgOut.ok && saidSo && !imgOut.output.includes("iVBORw0KGgo"),
    saidSo
      ? "image 块的正文没有进上下文，而且**点名说了**丢了什么（不是静默丢弃）"
      : "image 块要么被塞进了上下文，要么被静默丢掉了 —— 两种都会让模型误判",
  );

  // ═══════════════════════════════ I2. 未知 content 块不得让工具整个废掉
  section("I2. 服务器返回未知类型的 content 块 → 工具仍然可用");
  console.log(
    "   二次评审（zcode P1-2）抓到的一条，与 outputSchema 那个坑同族。\n\n" +
      "   SDK 的 `CallToolResultSchema.content` 是**五种已知块类型的 union**。\n" +
      "   协议在演进，服务器早晚会发一个 SDK 还不认识的块 —— 严格 schema 会在\n" +
      "   parse 阶段就抛，于是那个工具**整个废掉**（模型看得见、调得动、每次被\n" +
      "   挡在门口、无从改对），而 classify() 还把它报成「没有收到服务器回话」。\n\n" +
      "   **那是假话**：服务器回话了，只是形状 SDK 不认识 —— 而 sideEffectState\n" +
      "   写 UNKNOWN 的理由（「请求可能已生效但结果没回来」）在这种情形下不成立。\n" +
      "   处置：call 结果改走宽松的 ResultSchema（passthrough），与 tools/list 的\n" +
      "   tolerant 回退对称。注入实测：换回 CallToolResultSchema，本条必须翻红。",
  );
  const unknownOut = await tiered.handler.execute(
    actionFor(
      tiered.snapshots.find((s) => s.definition.name.endsWith("returns_unknown_block"))!.definition.name,
      {},
    ),
    ctxFor(ws.root),
  );
  fact("调用结果", unknownOut.ok ? "ok" : `失败：${unknownOut.error?.code}`);
  fact("返回文本", unknownOut.output.replace(/\n/g, " ⏎ ").slice(0, 170));
  const keptText = unknownOut.output.includes("未知块旁边的正常文本");
  const namedIt = unknownOut.output.includes("widget_v2");
  verdict(
    unknownOut.ok && keptText && namedIt,
    unknownOut.ok && keptText && namedIt
      ? "未知块没有让工具废掉：同一次返回里的文本照常拿到，未知块被**点名**报告为未进上下文"
      : unknownOut.ok
        ? `工具没废但报告不完整（保住文本=${keptText}，点名未知块=${namedIt}）`
        : `未知 content 块让整个工具废掉了：${unknownOut.error?.safeMessage}`,
  );

  // ══════════════════════════════════ H. tools/list_changed 必须被忽略
  section("H. 运行中收到 tools/list_changed → 工具面必须不变");
  console.log(
    "   这是 Atlas 与 opencode 的一处**硬分叉**：opencode 收到通知会重新 list\n" +
      "   并发事件（它的工具面本来就是动态的），而 Atlas 的工具面在 Run 启动时\n" +
      "   冻结进 RunSpec.agentSpec.toolSnapshots —— §18.2 三条恢复分支的判定\n" +
      "   读的就是冻结的那一份。跟着服务器改工具面的后果：同一条 transcript 上的\n" +
      "   同一次 tool_use，resume 时会走进**另一条分支**，而盘上看不出来。",
  );
  const before = tiered.snapshots.length;
  const echoName = readTool.definition.name;
  await tiered.handler.execute(actionFor(echoName, { message: "trigger-list-changed" }), ctxFor(ws.root));
  await new Promise((r) => setTimeout(r, 300)); // 给通知一点到达时间
  fact("通知前工具数", before);
  fact("通知后工具数", tiered.snapshots.length);
  verdict(
    tiered.snapshots.length === before,
    tiered.snapshots.length === before
      ? "服务器宣布工具面变化之后，Atlas 的工具面一个字没动 —— 冻结前提守住了"
      : "工具面跟着服务器变了 —— §18.2 的分支判定前提被破坏",
  );

  // ═══════════════════════════════════════ E. 连不上 = 硬失败
  section("E. 服务器起不来 → 抛，不是静默少几个工具");
  console.log(
    "   与 DeclarativeEffectResolver 的 RESOLVER 分支同一条纪律：装配漏了\n" +
      "   必须在第一时间炸掉。降级的失败形态特别难查 —— 同一句任务昨天能开\n" +
      "   浏览器今天不能，而 Run 照常跑到底，最后告诉你「我访问不了那个页面」。",
  );
  const badConfig = parseMcpConfig(
    { servers: { broken: { type: "local", command: ["/definitely/not/a/real/binary"] } } },
    "(夹具)",
  );
  let threw = "";
  try {
    const r = await connectMcpServers({ configPath: "(不读盘)", workspaceRoot: ws.root, config: badConfig });
    mcpToClose.push(r);
  } catch (err) {
    threw = (err as Error).message;
  }
  fact("抛出的信息（首行）", threw.split("\n")[0] ?? "（没抛 —— 它静默跳过了）");
  verdict(threw.length > 0 && threw.includes("装配错误"), threw ? "连不上就抛，并给出了两条可执行的出路" : "连不上却没抛");

  // ═════════════════ E1/E2. resume 必须说出「外部工具核对不了」
  section("E1/E2. 用过 MCP 的 Run，resume 时必须说出「我无法核对」");
  console.log(
    "   V05 §18.3 要求 resume 检查 Browser Session 是否仍然有效。Atlas **做不到** ——\n" +
      "   登录态活在 MCP 子进程里，是 transcript 之外的隐藏状态，而协议不提供\n" +
      "   任何会话身份。跨进程 resume 之后，那可能已经是另一个窗口、另一个账号。\n\n" +
      "   【定】做不到就**说出来**，不硬拒。理由与 workspace 闸门的 UNKNOWN_LEGACY\n" +
      "   一字同源：一条放行了却没验过的闸门如果不说话，与「验过并通过」在事后\n" +
      "   完全不可区分。硬拒则会让一个只用过一次 browser_snapshot 的长任务整个\n" +
      "   恢复不了，而那次调用可能无关紧要。\n\n" +
      "   E2 的另一半：工具身份要覆盖 schema / description / 档位。配 `@latest` 时\n" +
      "   「版本号没变而 schema 变了」是每次重启都可能走到的常规路径。",
  );
  {
    const rws = tempWorkspace();
    try {
      const mcpForRun = await connectMcpServers({
        configPath: "(不读盘)",
        workspaceRoot: rws.root,
        config: configFor(),
      });
      mcpToClose.push(mcpForRun);
      const composed = compose({
        dbPath: ":memory:",
        workspaceRoot: rws.root,
        approvalDecider: async () => ({ approved: true }),
        trace: { async emit() {} },
        mcp: mcpForRun,
        modelPortOverride: new ScriptedModelPort([{ text: "收尾。", toolCalls: [] }]),
      });

      // 起一个 Run 再立刻 cancel —— CANCELLED 是可 resume 的（§10：没有 PAUSED）。
      const spec = composed.makeRunSpec("用得到 MCP 的任务");
      const gen = composed.runtime.start(spec);
      let runId = "";
      let step = await gen.next();
      while (!step.done) {
        if (!runId) {
          runId = String(step.value.runId);
          composed.runtime.cancel(runId as RunId, "模拟进程崩掉");
        }
        step = await gen.next();
      }

      const events: string[] = [];
      let payload: { toolNames?: string[]; drifted?: string[] } | undefined;
      const rgen = composed.runtime.resume(runId as RunId, {});
      let rs = await rgen.next();
      while (!rs.done) {
        events.push(rs.value.type);
        if (rs.value.type === "ResumeExternalToolsUnverifiable") {
          payload = rs.value.payload as typeof payload;
        }
        rs = await rgen.next();
      }

      const frozenMcp = spec.agentSpec.toolSnapshots.filter((t: ToolSnapshot) =>
        t.definition.name.startsWith("mcp__"),
      );
      fact("冻结快照里的 MCP 工具数", frozenMcp.length);
      fact("工具 version 形态（含身份 digest？）", frozenMcp[0]?.version ?? "（无）");
      fact("resume 事件里有没有那条", payload ? `有，列了 ${payload.toolNames?.length} 个` : "没有");
      fact("其中判定为漂移的", JSON.stringify(payload?.drifted ?? []));

      const versionHasIdentity = /^mcp-[^-]+-[0-9a-f]{12}$/.test(frozenMcp[0]?.version ?? "");
      verdict(
        payload !== undefined && (payload.toolNames?.length ?? 0) === frozenMcp.length,
        payload !== undefined
          ? "resume 说出了「这些外部工具的世界我核对不了」，并列全了冻结快照里的每一个"
          : "resume 对外部工具默不作声 —— 与「验过并通过」事后不可区分",
      );
      verdict(
        versionHasIdentity && (payload?.drifted?.length ?? 1) === 0,
        versionHasIdentity
          ? (payload?.drifted?.length ?? 1) === 0
            ? "工具 version 带上了身份 digest（schema/description/档位），且同一份实现下判定为「没有漂移」"
            : `同一份实现却被判成漂移了：${JSON.stringify(payload?.drifted)}`
          : `version 里没有身份 digest（${frozenMcp[0]?.version}）—— schema 变了而版本不变时会静默错配`,
      );
    } finally {
      rws.cleanup();
    }
  }

  // ═══════════════════════ K2. 示例配置必须真的能用
  section("K2. mcp.example.json 必须能被解析器接受");
  console.log(
    "   一份**示例配置解析不了**是最尴尬的一种缺陷：用户照抄 → 报错 →\n" +
      "   以为是自己抄错了。而它极容易发生 —— 示例里塞了几条给人看的说明，\n" +
      "   而解析器有一条「未知字段一律报错」的规则（那条规则本身是对的，\n" +
      "   它防的是 `enviroment` 这种拼写错误）。\n\n" +
      "   处置是 `_` 开头的键当注释：拼错的字段名不会恰好以 `_` 开头，\n" +
      "   两者不重叠。这条判据钉住示例与解析器**不会各走各的**。",
  );
  const examplePath = resolve(REPO_ROOT, "mcp.example.json");
  let exampleErr = "";
  let exampleServers = 0;
  let exampleReadTools = 0;
  try {
    const parsed = loadMcpConfig(examplePath);
    exampleServers = Object.keys(parsed.servers).length;
    exampleReadTools = Object.values(parsed.servers).reduce(
      (n, s) => n + Object.values(s.tools ?? {}).filter((t) => t === "read").length,
      0,
    );
  } catch (err) {
    exampleErr = (err as Error).message;
  }
  fact("解析结果", exampleErr || `${exampleServers} 个服务器，${exampleReadTools} 个 read 档工具`);
  /**
   * 【定】顺带钉住 `browser_evaluate` **不在** read 档里。
   *
   * 它在页面上下文执行任意 JS —— 可以发请求、点按钮、改 DOM。示例配置是
   * 用户最可能照抄的东西，一旦那里把它标成 read，抄的人不会去想为什么。
   * 而标错的后果是三件事一起错且零提示：跳过审批、按幂等重跑、报错记「无副作用」。
   */
  const evaluateMarkedRead = (() => {
    try {
      const parsed = loadMcpConfig(examplePath);
      return Object.values(parsed.servers).some((s) => s.tools?.["browser_evaluate"] === "read");
    } catch {
      return false;
    }
  })();
  fact("browser_evaluate 被标成 read 了吗", evaluateMarkedRead ? "是 —— 危险！" : "否");
  verdict(
    exampleErr === "" && exampleServers > 0 && !evaluateMarkedRead,
    exampleErr === ""
      ? evaluateMarkedRead
        ? "示例把 browser_evaluate 标成了 read —— 它能执行任意 JS，不是只读工具"
        : "示例配置能被解析器接受，且没有把能执行任意 JS 的工具标成只读"
      : `示例配置解析失败：${exampleErr.split("\n")[0]}`,
  );

  // ═══════════════════════ C1. 握手失败不得留下孤儿子进程
  section("C1. 握手卡住 → 抛错，且**不留残留子进程**");
  console.log(
    "   二次评审两份都点了这条（zcode P1-1 / codex P1-5）。\n\n" +
      "   注意 E 段那个 `/definitely/not/a/real/binary` **测不出它** —— spawn 就失败了，\n" +
      "   压根没有进程可泄漏。真正的现实场景是「起得来但握手卡住」（npx 首次拉包），\n" +
      "   此时 `withTimeout` 拒绝、函数抛出，而已经 spawn 的那个进程**没有人收**：\n" +
      "   上游 closeAll() 只遍历「已经完整连上」的连接，失败中的这个从没进过名单。\n\n" +
      "   用户重试一次多一个孤儿，而 MCP 子进程里常常挂着一个浏览器窗口。",
  );
  const countFixtures = (): number => {
    try {
      const out = execFileSync("pgrep", ["-f", "fake-mcp-server"], { encoding: "utf8" });
      return out.trim().split("\n").filter(Boolean).length;
    } catch {
      return 0; // pgrep 无命中时退出码非 0
    }
  };
  const beforeProcs = countFixtures();
  const hangConfig = parseMcpConfig(
    {
      servers: {
        hang: {
          type: "local",
          command: [TSX, FIXTURE],
          environment: { FAKE_MCP_HANG: "1" },
          // 【定】短 startup，否则这条判据要跑 30 秒。
          timeout: { startup: 2_000, request: 2_000 },
        },
      },
    },
    "(夹具)",
  );
  let hangThrew = "";
  try {
    const r = await connectMcpServers({ configPath: "(不读盘)", workspaceRoot: ws.root, config: hangConfig });
    mcpToClose.push(r);
  } catch (err) {
    hangThrew = (err as Error).message;
  }
  // 给被 close 的进程一点退出时间 —— 立刻数会把"正在退"当成"没退"。
  await new Promise((r) => setTimeout(r, 1200));
  const afterProcs = countFixtures();
  fact("握手超时是否抛出", hangThrew ? "抛了" : "没抛");
  fact("夹具进程数（前 → 后）", `${beforeProcs} → ${afterProcs}`);
  verdict(
    hangThrew.length > 0 && afterProcs <= beforeProcs,
    hangThrew.length > 0 && afterProcs <= beforeProcs
      ? "握手卡住时抛错，且子进程被收干净 —— 没有孤儿留下"
      : hangThrew
        ? `抛了，但留下了 ${afterProcs - beforeProcs} 个孤儿进程 —— connectServer 的失败路径没收 transport`
        : "握手卡住却没抛 —— startup 预算没有生效",
  );

  // required:false 的另一侧 —— 否则一个"永远抛"的实现在上面那条下也是绿的。
  const optionalConfig = parseMcpConfig(
    {
      servers: {
        broken: { type: "local", command: ["/definitely/not/a/real/binary"], required: false },
      },
    },
    "(夹具)",
  );
  const optional = await connectMcpServers({
    configPath: "(不读盘)",
    workspaceRoot: ws.root,
    config: optionalConfig,
  });
  mcpToClose.push(optional);
  fact("required:false 时的 notices", optional.notices[0]?.split("\n")[0] ?? "（一句话都没说）");
  verdict(
    optional.snapshots.length === 0 && optional.notices.length > 0,
    optional.notices.length > 0
      ? "标了 required:false 就放行，但**响亮地说出来** —— 放行而不说话，与「连上了但没有工具」事后不可区分"
      : "required:false 静默跳过了 —— 没有任何东西告诉用户工具面少了一截",
  );

  // ═══════════════════════════════════════ K. 配置解析不静默吞
  section("K. 配置里的错必须报出来，不静默忽略");
  console.log(
    "   M-5 那条教训的形态：一个被静默吞掉的配置项与一个不支持的配置项，\n" +
      "   在用户那里完全不可区分。`--yes` 那个开关活了整整一个阶段就是这么来的。",
  );
  /**
   * 【定】第三列是**必须出现在报错里的词**，不能只判「它抛了」。
   *
   * 这一条是本段第一版的真实缺陷：remote 那例当时被「有不认识的字段：url」
   * 拦下 —— 抛是抛了，但理由指向了错的地方，用户会去删 url 而不是知道
   * 「远程传输还没做」。**一条只判「抛没抛」的判据，对报错说错话是盲的。**
   */
  const badCases: Array<[string, unknown, string]> = [
    ["拼错的字段名", { servers: { a: { type: "local", command: ["x"], enviroment: {} } } }, "enviroment"],
    [
      "不认识的档位",
      { servers: { a: { type: "local", command: ["x"], tools: { t: "allow" } } } },
      '只有 "read" 与 "execute"',
    ],
    ["空 command", { servers: { a: { type: "local", command: [] } } }, "非空的字符串数组"],
    ["remote（尚未实现）", { servers: { a: { type: "remote", url: "https://x" } } }, "尚未实现"],
  ];
  const rejected: string[] = [];
  for (const [label, raw, mustSay] of badCases) {
    try {
      parseMcpConfig(raw, "(夹具)");
      console.log(`   \x1b[31m✗\x1b[0m ${label.padEnd(20)} 被静默接受了`);
    } catch (err) {
      const msg = (err as Error).message;
      const right = msg.includes(mustSay);
      if (right) rejected.push(label);
      console.log(
        `   ${right ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label.padEnd(20)} ` +
          `${msg.split("\n")[0]!.slice(0, 62)}` +
          (right ? "" : `   \x1b[31m← 理由不对，应提到「${mustSay}」\x1b[0m`),
      );
    }
  }
  verdict(
    rejected.length === badCases.length,
    rejected.length === badCases.length
      ? `${badCases.length} 种坏配置全部报错，**且每条都指向了正确的原因**`
      : `这些配置没被拦下、或报错指向了错的地方：${badCases
          .filter((c) => !rejected.includes(c[0]))
          .map((c) => c[0])
          .join("，")}`,
  );

  // tools 段里的工具名拼错必须报错 —— 它比上面几种更隐蔽：
  // 那行配置**看起来生效了**（没有报错），只是行为没变。
  let typoErr = "";
  try {
    const r = await connectMcpServers({
      configPath: "(不读盘)",
      workspaceRoot: ws.root,
      config: configFor({ echo_txet: "read" }),
    });
    mcpToClose.push(r);
  } catch (err) {
    typoErr = (err as Error).message;
  }
  fact("tools 段拼错工具名", typoErr.split("\n")[0] ?? "（被静默吞掉了）");
  verdict(
    typoErr.includes("echo_txet") && typoErr.includes("echo_text"),
    typoErr.includes("echo_txet")
      ? "tools 段里不存在的工具名会报错，**并列出服务器真实提供的工具** —— 不静默落回默认档"
      : "拼错的工具名被静默忽略了：那行配置看起来生效了，实际每次照样问",
  );

  // 正侧：文件不存在**不是**错误（绝大多数用户没有 MCP）。
  const empty = await connectMcpServers({
    configPath: resolve(ws.root, "没有这个文件.json"),
    workspaceRoot: ws.root,
  });
  fact("配置文件不存在时", `${empty.snapshots.length} 个工具，${empty.notices.length} 条提示`);
  verdict(
    empty.snapshots.length === 0,
    "配置文件不存在时安静地什么都不装 —— 没有 MCP 是绝大多数用户的常态，不该是一条警告",
  );

  // ══════════════════════════════════════ L. 起步价（记录用，不判定）
  section("L. 工具面与固定开销（记录用）");
  console.log(
    "   §16.1【定·实测】每工具约 180 token。这个数是随时可读的过拟合警报 ——\n" +
      "   但注意它落在**缓存前缀**里（protocol.ts 实测 cacheRead 恒为 tools＋system\n" +
      "   那一段），所以增量按 cache-read 计价，不是全价。",
  );
  fact("Atlas 自家工具", `14 个 ≈ 2520 token`);
  fact("夹具 MCP 带来", `${plain.snapshots.length} 个 ≈ ${plain.snapshots.length * 180} token`);
  fact("Playwright 实测（待填）", "跑一次真实任务后回填这里");
}

let cleanupWs: (() => void) | undefined;
const mcpToClose: McpRuntime[] = [];

void runVerify(main, () => {
  // 【定】子进程必须收掉。仪器不得在被测系统之外留痕 —— 阶段 3.5 那次
  // 故障注入在 $HOME 留下探针文件，之后每次 existsSync 都为真，判据被永久毒化。
  for (const m of mcpToClose) void m.close();
  cleanupWs?.();
  try {
    execFileSync("pkill", ["-f", "fake-mcp-server"], { stdio: "ignore" });
  } catch {
    /* 没有残留进程时 pkill 退出码非 0，那是好事 */
  }
});
