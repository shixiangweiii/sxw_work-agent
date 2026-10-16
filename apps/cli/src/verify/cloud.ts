/**
 * ADR-0016 验收：云沙箱执行（verify:cloud）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 要答的问题：**把执行挪到一台用完即销毁的云 VM 上之后，
 * 「这次执行的副作用是什么」能不能变成一句可以证明的话？**
 *
 * 全程用手写的假池子（`fixtures/fake-sandbox-pool.ts`）：不花钱、不联网、
 * 不建沙箱。真实云端那一侧由 `sxw_fc-sandbox` 的
 * `scripts/probe_phase1_cloud.py` 答（六条，已过）。
 *
 * 【定】**每条判据配一个反向**。本仓栽过四次「判据落在守卫重叠区」，
 * 形态都一样：一个恒真的实现也能让判据全绿。这里的配对分别排除：
 *
 *   「从不核对回显」      ← B2 让回显说谎，必须拒绝执行
 *   「一律拒绝执行」      ← B1 要求回显正确时必须跑完
 *   「恒落分支三」        ← E2 要求断网档必须给得出指纹
 *   「恒给指纹」          ← E1 要求开网档必须给不出
 *   「一律 UNKNOWN」      ← D1/D2 把 429 与 502 分开钉
 *   「读黑名单没接上」    ← C1/C2 成对（.env 拒、普通文件放行）
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreparedAction, RunId, ToolExecutionContext } from "@workagent/harness-runtime";
import { asId, evaluatePolicy, TRUSTED_PERSONAL, validateAndNormalize } from "@workagent/harness-runtime";
import {
  CloudSandboxVerifier,
  CloudShellEffectResolver,
  CloudShellHandler,
  PoolClient,
  cloudShellDefinition,
  describeCloudShellForApproval,
  egressRequest,
  parseCloudSandboxConfig,
  isProvablyContained,
  parseNetwork,
  renderCloudShellApproval,
  verifyEgress,
} from "@workagent/tools-cloud-sandbox";
import { autoGrantVerdict } from "../compose.js";
import { banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";
import { makeFakePool, type FakePool, type FakePoolOptions } from "./fixtures/fake-sandbox-pool.js";

let ws: { root: string; cleanup: () => void } | undefined;

function ctxFor(root: string): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: root,
    onProgress: () => {},
    timezone: "Asia/Shanghai",
    executionPrivilege: "SANDBOXED",
  };
}

/**
 * 造一个 PreparedAction。
 *
 * 【定】入参必须经 `validateAndNormalize` —— 直接手搓 `normalizedInput`
 * 会让判据跨过校验器那一跳，而 `verify:mcp` D 段第一版就栽在这里
 * （把 array 分支改成无条件报错，判据照样绿）。
 */
function actionFor(raw: Record<string, unknown>): PreparedAction {
  const v = validateAndNormalize(raw, cloudShellDefinition.inputSchema, cloudShellDefinition.name);
  if (!v.ok) throw new Error(`夹具自己的入参就没过校验：${JSON.stringify(v)}`);
  return {
    id: asId("act_cloud_1"),
    runId: asId("run_cloud") as RunId,
    toolName: "cloud_shell",
    toolVersion: cloudShellDefinition.version,
    normalizedInput: v.normalized ?? {},
    resolvedEffect: new CloudShellEffectResolver().resolve(v.normalized ?? {}, "/tmp"),
    stage: "PREPARED",
  } as unknown as PreparedAction;
}

function handlerFor(pool: FakePool): CloudShellHandler {
  return new CloudShellHandler({
    client: new PoolClient({
      baseUrl: "http://pool.invalid",
      waitTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      fetchImpl: pool.fetchImpl,
    }),
  });
}

async function run(raw: Record<string, unknown>, root: string, opts: FakePoolOptions = {}) {
  const pool = makeFakePool(opts);
  const outcome = await handlerFor(pool).execute(actionFor(raw), ctxFor(root));
  return { pool, outcome };
}

async function main(): Promise<void> {
  banner(
    "verify:cloud —— 云沙箱执行（ADR-0016）",
    "把执行挪到用完即销毁的云 VM 上之后，「这次执行的副作用是什么」能不能变成一句可以证明的话？",
  );
  ws = tempWorkspace();
  const root = ws.root;
  writeFileSync(join(root, "data.csv"), "a,b\n1,2\n");
  writeFileSync(join(root, ".env"), "SECRET=hunter2\n");

  // ════════════════════════════════ A. 入参与作用域
  section("A. 入参解析与 Effect —— 断网是默认，认不出的档位按断网处理");
  for (const [raw] of [
    [undefined, "none"],
    ["", "none"],
    ["none", "none"],
    ["NoNe", "none"],
    ["open", "open"],
    ["pypi.org, files.pythonhosted.org", "files.pythonhosted.org,pypi.org"],
    ["随便写的东西", "随便写的东西"],
  ] as const) {
    fact(`network=${JSON.stringify(raw)}`, parseNetwork(raw as never).label);
  }
  const offEffect = new CloudShellEffectResolver().resolve({ command: "ls" } as never, root);
  const netEffect = new CloudShellEffectResolver().resolve(
    { command: "pip download x", network: "pypi.org" } as never,
    root,
  );
  const upEffect = new CloudShellEffectResolver().resolve(
    { command: "wc -l data.csv", inputs: "data.csv" } as never,
    root,
  );
  fact("断网 ＋ 无上传", `${offEffect.scope.kind} ${offEffect.scope.value} risk=${offEffect.riskFacts.join(",")}`);
  fact("开了白名单", `risk=${netEffect.riskFacts.join(",")} dest=${netEffect.dataMovement?.destination}`);
  fact("断网但有上传", `risk=${upEffect.riskFacts.join(",")} scope=${upEffect.dataMovement?.scope}`);
  verdict(
    offEffect.scope.kind === "REMOTE_SANDBOX" &&
      !offEffect.riskFacts.includes("DATA_LEAVES_HOST") &&
      netEffect.riskFacts.includes("DATA_LEAVES_HOST") &&
      netEffect.riskFacts.includes("IRREVERSIBLE") &&
      upEffect.riskFacts.includes("DATA_LEAVES_HOST"),
    "scope 用 REMOTE_SANDBOX（不复用 PROCESS）；**上传即数据外发，断网也照记**；只有开了网才标 IRREVERSIBLE。" +
      "注入：把 uploads 那一支去掉 → 红",
  );

  const aDigest = offEffect.digest;
  const bDigest = new CloudShellEffectResolver().resolve(
    { command: "ls", inputs: "data.csv" } as never,
    root,
  ).digest;
  verdict(
    aDigest !== bDigest,
    "同一条命令换了 inputs 就是不同的 digest —— 否则 Progress Guard 会把两次不同的尝试当成原地打转",
  );

  // ════════════════════════════════ B. 第二道闸门：出网回显核对
  section("B. 出网回显核对（第二道闸门）—— 对不上就不执行");
  const b1 = await run({ command: "echo hi" }, root);
  fact("acquire 收到的 egress", JSON.stringify(b1.pool.lastEgressRequest ?? null));
  fact("结果", `ok=${b1.outcome.ok} state=${b1.outcome.sideEffectState}`);
  verdict(
    b1.outcome.ok &&
      b1.outcome.sideEffectState === "APPLIED" &&
      b1.pool.lastEgressRequest === undefined &&
      b1.pool.openLeases.size === 0,
    "断网档：**不传 egress**（池子默认即断网，传一份等价策略会让「要求断网」与「没说」不可区分）；" +
      "回显对得上就正常执行；借用已归还。这条是 B2 的配对 —— 少了它，「一律拒绝」也能让 B2 绿",
  );

  const b2 = await run({ command: "echo hi" }, root, {
    echoOverride: { allow_out: ["0.0.0.0/0"], deny_out: [], allow_public_traffic: false },
  });
  fact("平台谎称全放行时", `ok=${b2.outcome.ok} code=${b2.outcome.error?.code}`);
  fact("借用是否已归还", b2.pool.openLeases.size === 0);
  fact("有没有发过命令", b2.pool.calls.some((c) => c.path.endsWith("/commands")));
  verdict(
    !b2.outcome.ok &&
      b2.outcome.error?.code === "TOOL_CLOUD_EGRESS_UNVERIFIED" &&
      !b2.pool.calls.some((c) => c.path.endsWith("/commands")) &&
      b2.pool.openLeases.size === 0,
    "回显与要求不符 → **一条命令都不发**，且沙箱照样归还。" +
      "「池子说它下发了」不构成证据 —— 一条放行了却没验过的闸门，与「验过并通过」事后不可区分",
  );

  verdict(
    verifyEgress(parseNetwork("none" as never), undefined) !== undefined,
    "读不到回显 = **不匹配**。「我无法核对」不等于「通过」",
  );

  const b4 = await run({ command: "pip download x", network: "pypi.org" }, root, {
    echoOverride: { allow_out: ["pypi.org", "evil.example"], deny_out: ["0.0.0.0/0"] },
  });
  verdict(
    !b4.outcome.ok && b4.outcome.error?.code === "TOOL_CLOUD_EGRESS_UNVERIFIED",
    "白名单**多放行**了一个域名也算对不上 —— 只比「我要的在不在里面」会漏掉平台多开的口子",
  );
  fact("白名单档发出的 egress", JSON.stringify(egressRequest(parseNetwork("pypi.org" as never))));

  // ════════════════════════════════ C. 护栏复用
  section("C. inputs 过读黑名单、outputs 不得逃出 workspace —— 用既有的那一份");
  const c1 = await run({ command: "cat .env", inputs: ".env" }, root);
  fact("inputs=.env", `ok=${c1.outcome.ok} code=${c1.outcome.error?.code}`);
  fact("有没有借过沙箱", c1.pool.calls.length);
  verdict(
    !c1.outcome.ok && c1.outcome.error?.code === "TOOL_READ_DENIED" && c1.pool.calls.length === 0,
    "`.env` 命中读黑名单 → 拒绝，而且**一台沙箱都没借** —— 被护栏挡下的调用不该先占一台按秒计费的机器",
  );

  const c2 = await run({ command: "wc -l data.csv", inputs: "data.csv" }, root);
  const uploaded = c2.pool.files.get("/home/user/workspace/data.csv");
  fact("普通文件上传", uploaded ? new TextDecoder().decode(uploaded) : "(没上传)");
  verdict(
    c2.outcome.ok && uploaded !== undefined,
    "C1 的配对：普通文件必须传得上去。少了它，「拒绝一切 inputs」的实现也能让 C1 绿",
  );

  const cMissing = await run({ command: "x", inputs: "nope.csv" }, root);
  fact("inputs 指向不存在的文件", `state=${cMissing.outcome.sideEffectState} code=${cMissing.outcome.error?.code}`);
  fact("有没有借过沙箱", cMissing.pool.calls.length);
  verdict(
    !cMissing.outcome.ok &&
      cMissing.outcome.error?.code === "TOOL_CLOUD_INPUT_NOT_FOUND" &&
      cMissing.outcome.sideEffectState === "NO_EFFECT" &&
      cMissing.pool.calls.length === 0,
    "⚠️ 这一条是**真实端点实跑**抓到的（run_dec51574f08f）。原来在借到沙箱之后才 readFile，" +
      "于是模型声明一个不存在的 inputs 时 ENOENT 穿出 execute()，被记成 `UNKNOWN` → " +
      "push RecoveryItem → **整个 Run 降级成 COMPLETED_WITH_LIMITS**。一次笔误让这个 Run 再也拿不到 SUCCESS。" +
      "现在是具名拒绝 ＋ NO_EFFECT ＋ 一台沙箱都不借",
  );

  const c3 = await run({ command: "x", outputs: "../escape.txt" }, root);
  verdict(
    !c3.outcome.ok && c3.outcome.error?.code === "TOOL_PATH_ESCAPE" && c3.pool.calls.length === 0,
    "outputs 用 `../` 逃出 workspace → 拒绝，同样一台沙箱都不借",
  );

  // ════════════════════════════════ D. 失败分类 → 事实表
  section("D. 池子的失败分类必须逐条落到 sideEffectState 上");
  const d1 = await run({ command: "x" }, root, { acquireStatus: 429 });
  fact("429 队列满", `state=${d1.outcome.sideEffectState} code=${d1.outcome.error?.code}`);
  const d1b = await run({ command: "x" }, root, { acquireStatus: 504 });
  fact("504 等待超时", `state=${d1b.outcome.sideEffectState}`);
  // ⚠️ 上面两条走的是**借用**路径，而那里兜底本来就是 NOT_STARTED ——
  //    分支与兜底互相遮蔽，单测它们摘掉整个分类逻辑也不会红（注入实测确认过）。
  //    承重的是下面这条：429 落在**命令**路径上，那里兜底是 UNKNOWN，
  //    只有 NOT_ACQUIRED 这一支能把它拉回 NOT_STARTED。
  const d1cmd = await run({ command: "x" }, root, { commandStatus: 429 });
  fact("命令路径上的 429", `state=${d1cmd.outcome.sideEffectState}`);
  verdict(
    d1.outcome.sideEffectState === "NOT_STARTED" &&
      d1b.outcome.sideEffectState === "NOT_STARTED" &&
      d1.outcome.error?.retryability === "SAME_INPUT_BACKOFF" &&
      d1cmd.outcome.sideEffectState === "NOT_STARTED",
    "池子**真的回了一个 HTTP 响应**说「没有沙箱给你」(429/503/504) = 命令确定没跑 = NOT_STARTED，可退避重试。" +
      "判别力由命令路径上那一条承担（见上面的注释）",
  );

  const d1c = await run({ command: "x" }, root, { commandUnreachable: true });
  fact("命令路径上连不上", `state=${d1c.outcome.sideEffectState}`);
  verdict(
    d1c.outcome.sideEffectState === "UNKNOWN",
    "⚠️ 这一条是注入实测逼出来的。`fetch` 抛错里混着两件事：请求没发出去（命令没跑）" +
      "与请求发出去了、响应没回来（**命令可能正在跑**）—— 客户端分不开，所以命令阶段必须记 UNKNOWN。" +
      "它与 D1 成对：D1 走借用路径（兜底本来就是 NOT_STARTED），单测它的话摘掉整个分类逻辑判据照样绿",
  );

  const d2 = await run({ command: "x" }, root, { commandStatus: 502 });
  fact("502 沙箱侧出错", `state=${d2.outcome.sideEffectState} code=${d2.outcome.error?.code}`);
  verdict(
    d2.outcome.sideEffectState === "UNKNOWN" && d2.outcome.error?.retryability === "NEVER",
    "命令发出去之后失败 = 跑没跑说不清 = UNKNOWN，不许自动重试。" +
      "这是 D1 的配对 —— 合并成一类的话，「池子忙」会被记成「副作用未知」，" +
      "一次本该直接重试的请求会变成要人销账的恢复项",
  );

  const d3 = await run({ command: "slow" }, root, {
    exec: { exit_code: -1, error: "TimeoutError: command exceeded 1s", stdout: "step1 ok\ncompiling...\n" },
  });
  const d3out = JSON.parse(d3.outcome.output || "{}");
  fact("超时", `state=${d3.outcome.sideEffectState} stdout=${JSON.stringify(d3out.stdout)}`);
  verdict(
    d3.outcome.sideEffectState === "UNKNOWN" &&
      !d3.outcome.ok &&
      String(d3out.stdout).includes("compiling") &&
      d3.pool.openLeases.size === 0,
    "超时 → UNKNOWN，但**已经产出的输出要交回去**（原因通常就在那些行里），沙箱照样归还",
  );

  const d4 = await run({ command: "big" }, root, {
    exec: { stdout: "x".repeat(50), truncated: true, stdout_bytes: 999_999 },
  });
  const d4out = JSON.parse(d4.outcome.output || "{}");
  verdict(
    d4out.truncated === true && String(d4out.note).includes("999999"),
    "截断必须说出来，并报**截断前的真实字节数** —— 调用方没有别的办法发现自己拿到的是半截输出",
  );

  // ════════════════════════════════ E. 恢复分支按调用区分
  section("E. 恢复分支是 Action 级事实：断网能观察（分支二），开网不能（分支三）");
  const ver = new CloudSandboxVerifier();
  writeFileSync(join(root, "out.txt"), "before\n");
  const offPre = await ver.observePre(actionFor({ command: "x", outputs: "out.txt" }), ctxFor(root));
  const netPre = await ver.observePre(
    actionFor({ command: "x", outputs: "out.txt", network: "pypi.org" }),
    ctxFor(root),
  );
  const noOutPre = await ver.observePre(actionFor({ command: "x" }), ctxFor(root));
  fact("断网 ＋ 有 outputs", offPre ? "给得出指纹 → 分支二" : "给不出");
  fact("开了网", netPre ? "给得出" : "给不出 → 分支三");
  fact("断网但没声明 outputs", noOutPre ? "给得出" : "给不出 → 分支三");
  verdict(
    offPre !== undefined && netPre === undefined && noOutPre === undefined,
    "三种情形各自不同。**成对**：少了「开网必须给不出」，一个恒给指纹的实现也能让第一条绿；" +
      "少了「断网必须给得出」，恒落分支三的实现同样全绿",
  );

  writeFileSync(join(root, "out.txt"), "after-the-run\n");
  const post = await ver.observePost(
    actionFor({ command: "x", outputs: "out.txt" }),
    ctxFor(root),
    offPre?.fingerprint,
  );
  verdict(
    post?.applied === true,
    "崩溃后比对：outputs 变了 → 那次执行确实把文件带回来了（§18.2 分支二的全部意义）",
  );

  const vres = await ver.verify(actionFor({ command: "x" }), { ok: true, output: "", sideEffectState: "APPLIED" }, ctxFor(root));
  verdict(
    vres.status === "SKIPPED",
    "verify 一律 SKIPPED，不冒充核实过 —— 沙箱已销毁，再跑一条命令去「确认」上一条是模型的观察，不是独立证据",
  );

  // ════════════════════════════════ F. 产物
  section("F. 产物按真实字节登记，写错的 role 不提升为 DELIVERABLE");
  const pool = makeFakePool();
  pool.files.set("/home/user/workspace/report.json", new TextEncoder().encode('{"ok":true}'));
  const f = await handlerFor(pool).execute(
    actionFor({ command: "make", outputs: "report.json", artifact_path: "report.json" }),
    ctxFor(root),
  );
  fact("artifact", `${f.artifact?.role} kind=${f.artifact?.kind} bytes=${(f.artifact?.content as Uint8Array)?.byteLength}`);
  fact("落回 workspace", readFileSync(join(root, "report.json"), "utf8"));
  verdict(
    f.artifact?.role === "DELIVERABLE" &&
      f.artifact?.kind === "json" &&
      (f.artifact?.content as Uint8Array)?.byteLength === 11 &&
      readFileSync(join(root, "report.json"), "utf8") === '{"ok":true}',
    "声明的 artifact_path 按**真实字节**登记（ADR-0010），kind 由共享的 artifactKindOf 推出，文件确实落回了 workspace",
  );

  const pool2 = makeFakePool();
  pool2.files.set("/home/user/workspace/a.json", new TextEncoder().encode("{}"));
  const f2 = await handlerFor(pool2).execute(
    actionFor({ command: "m", outputs: "a.json", artifact_path: "a.json", artifact_role: "typo" }),
    ctxFor(root),
  );
  const f3 = await handlerFor(makeFakePool()).execute(
    actionFor({ command: "m", outputs: "nope.json", artifact_path: "nope.json" }),
    ctxFor(root),
  );
  fact("role 拼错", f2.artifact?.role);
  fact("outputs 取不回来时", `artifact=${f3.artifact === undefined ? "不登记" : "登记了"} note=${JSON.parse(f3.output || "{}").note}`);
  verdict(
    f2.artifact?.role === "DELIVERABLE" && f3.artifact === undefined && String(JSON.parse(f3.output || "{}").note).includes("没能取回"),
    "写错的 role 按 DELIVERABLE 处理（run_shell 1.1.1 的同款）；取不回来的 outputs **不登记**，并如实说出来",
  );

  // ════════════════════════════════ G. 审批面
  section("G. 审批面：人要看见哪些文件离开本机、跑什么、有没有网");
  const view = describeCloudShellForApproval(
    actionFor({
      command: "python3 analyze.py data.csv > report.json",
      description: "分析数据",
      inputs: "data.csv\nanalyze.py",
      outputs: "report.json",
      network: "none",
    }),
  );
  const text = view ? renderCloudShellApproval(view) : "";
  fact("摘要", view?.summary);
  fact("渲染", `\n${text}`);
  verdict(
    view !== undefined &&
      view.uploads.length === 2 &&
      text.includes("python3 analyze.py") &&
      text.includes("data.csv") &&
      view.network.includes("断网") &&
      view.boundaries.some((b) => b.includes("离开本机")),
    "审批面给出命令**全文**、上传清单、取回清单与出网档位。只打 scope.value 的话人看到的是 " +
      "`cloud:net=none;in=2;out=1` —— 那是盲批",
  );
  verdict(
    describeCloudShellForApproval(actionFor({ command: "x" })) !== undefined &&
      renderCloudShellApproval(describeCloudShellForApproval(actionFor({ command: "x" }))!).includes("完全断网"),
    "没声明 network 时，审批面要明说「完全断网」—— 默认值也是人要批的内容",
  );

  // ════════════════════════════════ H. Policy 与配置
  section("H. EXECUTE 照旧走审批；配置拼错必须失败");
  const pv = evaluatePolicy({
    action: actionFor({ command: "rm -rf /" }),
    approvalPolicy: TRUSTED_PERSONAL,
    executionPrivilege: "SANDBOXED",
  } as never);
  fact("policy", pv.decision);
  verdict(
    pv.decision === "REQUIRE_APPROVAL",
    "v1 **照常逐次问**（ADR-0016 决定 5）。auto-grant 是研究问题，要单独的 ADR —— 不在这一批里悄悄放开",
  );

  // ════════════════════════════════ I. 自动放行（ADR-0017）
  section("I. 可证明无外部副作用的云沙箱执行，自动放行（ADR-0017）");
  const grant = (raw: Record<string, unknown>) => autoGrantVerdict(actionFor(raw), root);
  // AutoGrantVerdict 是联合类型（ok:true 那支没有 why），展示时统一取一次
  const why = (v: { ok: boolean }) => (v as { why?: string }).why ?? "";
  const offlineNoInput = grant({ command: "python3 x.py", outputs: "r.json" });
  const withNetwork = grant({ command: "pip download x", network: "pypi.org", outputs: "r.json" });
  const withInputs = grant({ command: "wc -l data.csv", inputs: "data.csv", outputs: "r.json" });
  const openNet = grant({ command: "curl x", network: "open" });
  fact("断网 ＋ 无上传", `${offlineNoInput.ok} ${why(offlineNoInput)}`);
  fact("开了白名单", `${withNetwork.ok} ${why(withNetwork)}`);
  fact("有 inputs", `${withInputs.ok} ${why(withInputs)}`);
  fact("开了全网", `${openNet.ok} ${why(openNet)}`);
  verdict(
    offlineNoInput.ok && !withNetwork.ok && !withInputs.ok && !openNet.ok,
    "断网 ＋ 无上传才放行；开了网不放行；有 inputs 不放行。" +
      "⚠️ 如实写明：它测的是**合取**。`isProvablyContained` 里「net=none」与" +
      "「没有 DATA_LEAVES_HOST」互相遮蔽（resolver 一开网就必然标后者），" +
      "单摘任一道这条判据都不红 —— 判别力由注入实测里「两道同摘」那条承担。" +
      "这与 verify:budget I 段②、P2-3 的处置同形态",
  );

  // 配对：这一支**只**开给 cloud_shell，别的 EXECUTE 一律照旧
  const shellLike = autoGrantVerdict(
    {
      ...actionFor({ command: "rm -rf /" }),
      resolvedEffect: {
        effectType: "EXECUTE",
        operation: "shell.exec",
        scope: { kind: "PROCESS", value: "programs:rm" },
        reversibility: "IRREVERSIBLE",
        riskFacts: ["MUTATES_EXTERNAL_STATE", "IRREVERSIBLE"],
        digest: "x",
      },
    } as never,
    root,
  );
  fact("run_shell 形态的 EXECUTE", `${shellLike.ok} ${why(shellLike)}`);
  verdict(
    !shellLike.ok && String(why(shellLike)).includes("EXECUTE"),
    "本机 shell 的 EXECUTE **仍然不放行** —— ADR-0017 只开给 cloud_shell 那一支。" +
      "⚠️ 如实写明射程：这条被三层挡着（compose 的 scope 分支、resolver 的两道 scope 检查、" +
      "net 检查），单摘任一层都不会红；它能抓住的是「有人把自动放行开给所有 EXECUTE」" +
      "这种整支改写，注入实测打的就是那个靶子",
  );
  verdict(
    isProvablyContained(offEffect) && !isProvablyContained(netEffect) && !isProvablyContained(upEffect),
    "判定收敛在 `isProvablyContained` 一份里（与产出这些事实的 resolver 在一起），" +
      "compose 只是调用它 —— 第二份解析分叉时，「审批面说断网、实际开着网」不会有任何征兆",
  );

  let configRejected = "";
  try {
    parseCloudSandboxConfig({ baseUrl: "http://x", apikey: "typo" }, "test");
  } catch (e) {
    configRejected = (e as Error).message;
  }
  fact("拼错的键", configRejected.slice(0, 80));
  verdict(
    configRejected.includes("apikey"),
    "配置里不认识的键必须报错并点名。静默忽略的后果：那行配置看起来生效了、实际什么都没变（M-5 那条教训）",
  );
}

void runVerify(main, () => ws?.cleanup());
