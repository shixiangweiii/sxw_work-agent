/**
 * ADR-0016 的**真实**端到端探针：Atlas 的客户端 × 真实沙箱池 × 真实云沙箱。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ **会花钱、会建真实云沙箱、不在 `verify:all` 里。**
 *
 * `verify:cloud` 用的是手写的假池子 —— 它答的是「Atlas 这一侧的判定对不对」。
 * 它**答不了**的那件事只有真跑才知道：**两个仓库之间的 HTTP 契约对不对得上。**
 * 字段名拼错、语义理解偏一格、超时单位差一千倍，这类问题在假池子上永远是绿的
 * （因为假池子是照着我自己的理解写的）。
 *
 * 这正是本仓反复记的那个形态：「判据测的不是它声称在测的东西」。
 *
 * 前置：先把池子跑起来（在 sxw_fc-sandbox 仓库）
 *   set -a; . ./.env; set +a
 *   export POOL_TEMPLATE=<预装模板> POOL_TARGET_SIZE=1 POOL_API_KEYS="atlas:<key>"
 *   .venv/bin/python -m sandbox_pool --host 127.0.0.1 --port 8099
 *
 * 跑：
 *   CLOUD_POOL_URL=http://127.0.0.1:8099 CLOUD_POOL_KEY=<key> npm run probe:cloud-live
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreparedAction, RunId, ToolExecutionContext } from "@workagent/harness-runtime";
import { asId, validateAndNormalize } from "@workagent/harness-runtime";
import {
  CloudShellEffectResolver,
  CloudShellHandler,
  PoolClient,
  cloudShellDefinition,
} from "@workagent/tools-cloud-sandbox";
import { banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

let ws: { root: string; cleanup: () => void } | undefined;

function actionFor(raw: Record<string, unknown>): PreparedAction {
  const v = validateAndNormalize(raw, cloudShellDefinition.inputSchema, cloudShellDefinition.name);
  if (!v.ok) throw new Error(`入参没过校验：${JSON.stringify(v)}`);
  return {
    id: asId("act_live"),
    runId: asId("run_live") as RunId,
    toolName: "cloud_shell",
    toolVersion: cloudShellDefinition.version,
    normalizedInput: v.normalized ?? {},
    resolvedEffect: new CloudShellEffectResolver().resolve(v.normalized ?? {}, "/tmp"),
    stage: "PREPARED",
  } as unknown as PreparedAction;
}

async function main(): Promise<void> {
  const baseUrl = process.env.CLOUD_POOL_URL;
  if (!baseUrl) {
    console.error("需要 CLOUD_POOL_URL（例如 http://127.0.0.1:8099）。见文件头的前置步骤。");
    verdict(false, "没有池子地址，这条探针跑不了");
    return;
  }
  banner(
    "probe:cloud-live —— Atlas × 真实沙箱池 × 真实云沙箱（ADR-0016）",
    "两个仓库之间的 HTTP 契约对不对得上？（假池子答不了这个 —— 它是照我自己的理解写的）",
  );
  ws = tempWorkspace();
  const root = ws.root;
  const ctx: ToolExecutionContext = {
    signal: new AbortController().signal,
    workspaceRoot: root,
    onProgress: (n) => console.log(`      · ${n}`),
    timezone: "Asia/Shanghai",
    executionPrivilege: "SANDBOXED",
  };
  const handler = new CloudShellHandler({
    client: new PoolClient({
      baseUrl,
      ...(process.env.CLOUD_POOL_KEY ? { apiKey: process.env.CLOUD_POOL_KEY } : {}),
      waitTimeoutMs: 180_000,
      requestTimeoutMs: 120_000,
    }),
  });

  // ── A. 断网档：上传 → 执行 → 取回 ────────────────────────────────────
  section("A. 断网档走完整条链：上传 → 执行 → 取回 → 登记产物");
  writeFileSync(join(root, "data.csv"), "a,b\n1,2\n3,4\n");
  const t0 = Date.now();
  const a = await handler.execute(
    actionFor({
      command: "python3 -c \"import pandas as pd,json;d=pd.read_csv('data.csv');open('report.json','w').write(json.dumps({'rows':len(d),'sum':int(d.sum().sum())}))\"",
      description: "用预装的 pandas 统计一下",
      inputs: "data.csv",
      outputs: "report.json",
      artifact_path: "report.json",
    }),
    ctx,
  );
  const aOut = JSON.parse(a.output || "{}");
  fact("耗时", `${Date.now() - t0}ms`);
  fact("结果", `ok=${a.ok} state=${a.sideEffectState} exit=${aOut.exitCode}`);
  fact("stderr", String(aOut.stderr ?? "").slice(0, 300));
  fact("取回的文件", aOut.outputs);
  const report = (() => {
    try {
      return readFileSync(join(root, "report.json"), "utf8");
    } catch {
      return "(没有)";
    }
  })();
  fact("report.json", report);
  fact("登记的产物", `${a.artifact?.role} kind=${a.artifact?.kind} bytes=${(a.artifact?.content as Uint8Array)?.byteLength}`);
  verdict(
    a.ok &&
      a.sideEffectState === "APPLIED" &&
      report.includes('"rows": 2') &&
      a.artifact?.role === "DELIVERABLE" &&
      a.artifact?.kind === "json",
    "真实云沙箱里：上传的文件读到了、**预装的 pandas 在断网下直接可用**、产出取回了 workspace、产物按真实字节登记",
  );

  // ── B. 断网是真的断 ───────────────────────────────────────────────────
  section("B. 断网档是真的断 —— 这是「副作用可证明」的全部依据");
  const b = await handler.execute(
    actionFor({
      command: "curl -s -o /dev/null -w '%{http_code}' -m 8 https://pypi.org/simple/ || echo blocked",
    }),
    ctx,
  );
  const bOut = JSON.parse(b.output || "{}");
  fact("沙箱里 curl pypi", JSON.stringify(String(bOut.stdout ?? "").trim()));
  verdict(
    b.ok && !["200", "301", "302"].includes(String(bOut.stdout ?? "").trim()),
    "默认档位下沙箱连不上公网。注意这不是 Atlas 自己说的 —— 它下发了策略、**读回平台回显核对过**才执行",
  );

  // ── C. 白名单档 ──────────────────────────────────────────────────────
  section("C. 白名单：放行的通、没放行的不通");
  const c = await handler.execute(
    actionFor({
      command:
        "echo allowed=$(curl -s -o /dev/null -w '%{http_code}' -m 15 https://pypi.org/simple/); " +
        "echo other=$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://www.baidu.com)",
      network: "pypi.org",
    }),
    ctx,
  );
  const cOut = JSON.parse(c.output || "{}");
  fact("输出", String(cOut.stdout ?? "").trim());
  const text = String(cOut.stdout ?? "");
  verdict(
    c.ok && !text.includes("allowed=000") && text.includes("other=000"),
    "白名单里的域名通、不在白名单的 000。这条走的是真实平台的 SNI 过滤，假池子验不了",
  );

  // ── D. 护栏在真实链路上也拦得住 ────────────────────────────────────────
  section("D. 护栏：inputs 过读黑名单（拦下的调用一台沙箱都不该借）");
  writeFileSync(join(root, ".env"), "SECRET=hunter2\n");
  const d = await handler.execute(actionFor({ command: "cat .env", inputs: ".env" }), ctx);
  fact("结果", `ok=${d.ok} code=${d.error?.code}`);
  verdict(!d.ok && d.error?.code === "TOOL_READ_DENIED", "`.env` 被读黑名单挡下，没有上云");

  // ── E. 归还 ──────────────────────────────────────────────────────────
  section("E. 借用必须都归还了（归还即销毁）");
  const stats = await fetch(`${baseUrl}/v1/pool/stats`, {
    headers: process.env.CLOUD_POOL_KEY ? { authorization: `Bearer ${process.env.CLOUD_POOL_KEY}` } : {},
  }).then((r) => r.json() as Promise<Record<string, unknown>>);
  fact("池子状态", JSON.stringify(stats.states ?? stats));
  const leased = Number((stats.states as Record<string, number> | undefined)?.LEASED ?? 0);
  verdict(leased === 0, "没有借出中的沙箱残留 —— 每次调用都归还了（归还即销毁）");
}

void runVerify(main, () => ws?.cleanup());
