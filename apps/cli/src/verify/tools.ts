/**
 * verify:tools —— 批 1 验收（阶段 3）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：**一个 Case 无关的通用能力面立起来了吗，而且它没有被某个任务反向定义？**
 *
 * 「不做定制」这句话必须有机械判据，否则半年后没人能复核。本脚本是那三道
 * 机械闸门里的前两道（第三道是 S13 的跨场景 smoke，它在批 4）：
 *
 *   A 段  七条边界 grep —— 通用工具不得依赖任何 Case 包
 *   B 段  两类声明     —— 场景工具写三场景用例，机制工具写它服务哪条机制
 *
 * 其余各段验的是「工具本身的形态约束」：
 *
 *   C 段  ToolDefinition 三个必填项齐全
 *   D 段  分页 ≠ 截断 —— 不存在静默截断
 *   D2 段 `edit_file` 的结构化诊断，以及「正确行为不得被误报」
 *   E 段  组合器**三个**方法都路由（不得绕过 #10）
 *   F 段  读黑名单同时覆盖 read_file 与 search（不得绕过 #13）
 *   G 段  固定开销基线 —— 工具数膨胀的免费警报
 *   H 段  大结果外置（**批 1 的已知红，批 2 S6 之后已转绿**）
 *
 * ── H 段曾经是红的，这是刻意的 ──────────────────────────────────────
 *
 * `read_file`（批 1 S3）就能产大结果，而 Blob 外置在批 2 S6 ——
 * 也就是说批 1 结束时存在一个已知空窗：**能读大文件但没有外置机制**，
 * 大内容会直接灌进 Context 撞上下文墙。
 *
 * 用一条「已知红」把这个欠账标出来，比推到下一批再说更诚实：
 * **缺口应当在它被引入的那一批就可见。**（形态照抄阶段 2 verify:persistence F 段）
 * 批 2 接上 Materialization 之后它转绿，**判据保留** —— 它现在是防回归的那道线。
 * ══════════════════════════════════════════════════════════════════════
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CollectingTraceSink,
  DEFAULT_CONTEXT_POLICY,
  ToolRegistry,
  type ContextMessage,
  type RunId,
} from "@workagent/harness-runtime";
import { commonMechanismTools, commonSceneTools, commonTools, renderText } from "@workagent/tools-common";
import { runSegment } from "@workagent/testkit";
import { DEFAULT_TOOLS, REPO_ROOT, compose } from "../compose.js";
import { BOUNDARIES, grepBoundary } from "./boundaries.js";
import { ScriptedModelPort, banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

const WORKER = resolve(fileURLToPath(new URL(".", import.meta.url)), "workers/run-segment.ts");

// ══════════════════════════════════════════════════════ 边界 grep

/**
 * 【定】表本身住在 `boundaries.ts`，这里只负责跑。
 *
 * 阶段 4 起有第二个消费者（`verify:ui` 的判别力实测），抄成两份的后果是
 * 「加了一条规则、只有一个脚本认识它」，而两个脚本都是绿的。
 */

// ══════════════════════════════════════════════════ 两类声明扫描

interface Declaration {
  file: string;
  toolName: string;
  kind: "场景工具" | "机制工具" | "未声明";
  ok: boolean;
  why: string;
}

/** 列出所有工具定义文件（两个包）。 */
function toolSourceFiles(dirs: string[]): string[] {
  return execFileSync(
    "grep",
    ["-rl", "--include=*.ts", "export const .*Definition: ToolDefinition", ...dirs],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
}

/**
 * 扫描 `tools/common/src/**` 下每个工具文件的头注释。
 *
 * 场景工具：必须写出三场景用例（或写明为什么不适用）。
 * 机制工具：必须指出它服务哪条 Harness 机制、以及不做它会怎样。
 */
function scanDeclarations(): Declaration[] {
  const out: Declaration[] = [];
  const files = toolSourceFiles(["tools/common/src"]);

  for (const f of files) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    // 头注释 = 文件开头到第一个 import 之前的部分。
    const header = src.slice(0, Math.max(0, src.indexOf("\nimport ")));
    const name = /name:\s*"([^"]+)"/.exec(src)?.[1] ?? "(未知)";

    if (header.includes("【场景工具】")) {
      const hasThree =
        header.includes("三场景") &&
        header.includes("办公：") &&
        header.includes("代码：") &&
        header.includes("聊天：");
      out.push({
        file: f,
        toolName: name,
        kind: "场景工具",
        ok: hasThree,
        why: hasThree ? "三场景用例齐全" : "缺三场景用例（办公 / 代码 / 聊天各要写一条）",
      });
    } else if (header.includes("【机制工具】")) {
      const hasMech = header.includes("服务的机制") && header.includes("不做它会怎样");
      out.push({
        file: f,
        toolName: name,
        kind: "机制工具",
        ok: hasMech,
        why: hasMech ? "指明了所服务的机制与不做的后果" : "缺「服务的机制」或「不做它会怎样」",
      });
    } else {
      out.push({
        file: f,
        toolName: name,
        kind: "未声明",
        ok: false,
        why: "文件头没有【场景工具】或【机制工具】标记 —— 决 2 要求两类各有各的声明义务",
      });
    }
  }
  return out;
}

interface ProgressDeclaration {
  file: string;
  mode: string;
  hasProducer: boolean;
}

/**
 * `progressReporting` 的声明与实现必须对得上（阶段 3 收口批新增）。
 *
 * 【定】判据：`mode !== "NONE"` ⇒ 该文件里必须存在 `ctx.onProgress(` 调用点。
 *
 * 反过来不查：声明 NONE 却报了一两次是「少做多」，不构成失真
 * （见 `ProgressReportingDescriptor` 的语义定义）。
 *
 * 这条规则**在本批之前是红的**：`read_file` 与 `search` 都声明了
 * `HEARTBEAT 30s`，而两个文件里一次 `ctx.onProgress` 都没有 ——
 * 方案 S9 承诺的「大文件读取周期性回报」从来没实现过，
 * 而读代码的人会以为那两个工具是被监控的。判别力不用另造：它刚抓到两个。
 *
 * 扫描范围是**两个包** —— `slow_write` 在 cases/ 里，而它恰恰是
 * 全仓唯一的 HEARTBEAT 生产者，漏掉它这条规则就只查了没有生产者的那一半。
 */
function scanProgressDeclarations(): ProgressDeclaration[] {
  const out: ProgressDeclaration[] = [];
  for (const f of toolSourceFiles(["tools/common/src", "cases/micro-cases/src"])) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    const mode = /progressReporting:\s*\{\s*mode:\s*"([A-Z_]+)"/.exec(src)?.[1];
    if (!mode) continue;
    out.push({ file: f, mode, hasProducer: src.includes("ctx.onProgress(") });
  }
  return out;
}

// ══════════════════════════════════════════════════════════ 跑一次 Run

interface ToolCall {
  toolCallId: string;
  name: string;
  input: unknown;
}

/** 跑一段脚本化 Run，把每个 tool_result 的正文按 toolCallId 收回来。 */
async function runTools(
  workspaceRoot: string,
  calls: ToolCall[],
): Promise<Map<string, { content: string; isError: boolean }>> {
  const trace = new CollectingTraceSink();
  const composed = compose({
    dbPath: ":memory:",
    workspaceRoot,
    approvalDecider: async () => ({ approved: true }),
    trace,
    modelPortOverride: new ScriptedModelPort([
      { text: "开工", toolCalls: calls },
      { text: "做完了。", toolCalls: [] },
    ]),
  });

  const gen = composed.runtime.start(composed.makeRunSpec("verify:tools 夹具"));
  let runId = "";
  let r = await gen.next();
  while (!r.done) {
    if (!runId) runId = String(r.value.runId);
    r = await gen.next();
  }

  const messages: ContextMessage[] = await composed.ports.transcript.rebuildMessages(
    runId as RunId,
  );
  composed.db.close();

  const out = new Map<string, { content: string; isError: boolean }>();
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "tool_result") out.set(c.toolCallId, { content: c.content, isError: c.isError });
    }
  }
  return out;
}

function parseResult(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _unparsed: raw };
  }
}

// ══════════════════════════════════════════════════════════════ main

async function main(): Promise<void> {
  banner(
    "批 1 验收：通用能力面（verify:tools）",
    "工具面立起来了吗？它有没有被某个任务反向定义？分页会不会退化成静默截断？",
  );

  // ── A. 全部边界 grep ＋ 第 6b 条的判别力实测
  //    （阶段 4 的第 8 / 9 / 10 条各有自己的判别力实测，在 verify:ui A 段）
  section(
    `A. 边界 grep —— 编号 1…${BOUNDARIES[BOUNDARIES.length - 1]!.id} 共 ${BOUNDARIES.length} 条规则（6b 是第 6 条的同族）`,
  );
  console.log(
    "   判据区分注释与真实依赖 —— 这些文件里到处在引用边界规则本身，\n" +
      "   把注释算成违规，这些 grep 会永远红，然后被人加白名单加到失去意义。\n",
  );

  let boundariesOk = true;
  for (const b of BOUNDARIES) {
    const hits = grepBoundary(b);
    fact(`边界 ${b.id}：${b.desc}`, hits.length === 0 ? "干净" : `${hits.length} 处违规`);
    for (const h of hits) console.log(`     \x1b[31m✗\x1b[0m ${h}`);
    if (hits.length > 0) boundariesOk = false;
  }
  verdict(
    boundariesOk,
    boundariesOk
      ? `编号 1…${BOUNDARIES[BOUNDARIES.length - 1]!.id} 共 ${BOUNDARIES.length} 条边界规则全部守住（真实依赖零命中）`
      : "有边界被突破，见上面的行号",
  );

  // 判别力：往 tools/common 注入一行对 Case 包的 import，第 6b 条必须当场翻红。
  section("A2. 第 6b 条的判别力实测");
  console.log(
    "   前面那条「干净」只证明现在没有违规，不证明**发现得了**违规。\n" +
      "   一个永远返回空的检查器与一个正确的检查器，在上面的断言下分不出来。\n",
  );
  const canary = join(REPO_ROOT, "tools/common/src/__boundary_canary.ts");
  let canaryHits: string[] = [];
  try {
    writeFileSync(
      canary,
      '// 判别力实测的临时文件，写完立刻删。\nimport { microCaseTools } from "@workagent/micro-cases";\nexport const x = microCaseTools;\n',
      "utf8",
    );
    canaryHits = grepBoundary(BOUNDARIES.find((b) => b.id === "6b")!);
  } finally {
    // 【定】必须删干净。留一个 canary 在树里，下次跑 typecheck 会莫名其妙地
    // 多一条跨包依赖，而它看起来像是有人故意加的。
    try {
      unlinkSync(canary);
    } catch {
      /* 已经不在了 */
    }
  }
  const canaryCaught = canaryHits.some((h) => h.includes("__boundary_canary.ts"));
  fact("注入后第 6b 条命中", canaryHits.length === 0 ? "0（没抓到）" : canaryHits.join(" | "));
  fact("注入文件已清理", "是");
  verdict(
    canaryCaught,
    canaryCaught
      ? "往 tools/common 注入一行对 Case 包的 import，第 6b 条当场翻红并指出行号 —— 它有判别力"
      : "注入了违规却没被抓到 —— 第 6b 条是一个永远绿的闸门",
  );

  // ── B. 两类声明
  section("B. 工具声明扫描（决 2 的两类标准）");
  const decls = scanDeclarations();
  for (const d of decls) {
    console.log(
      `   ${d.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${d.toolName.padEnd(16)} ` +
        `${d.kind.padEnd(6)} ${d.why}`,
    );
  }
  const declOk = decls.length > 0 && decls.every((d) => d.ok);
  verdict(
    declOk,
    declOk
      ? `${decls.length} 个工具的文件头声明齐全（场景工具 ${decls.filter((d) => d.kind === "场景工具").length}、` +
        `机制工具 ${decls.filter((d) => d.kind === "机制工具").length}）`
      : "有工具的文件头缺声明 —— 决 2 要求两类各有各的声明义务",
  );

  // ── B2. 声明与实现必须对得上：progressReporting
  section("B2. progressReporting 的声明与实现对得上（阶段 3 收口批新增）");
  console.log(
    "   【定】mode !== NONE ⇒ 源码里必须有 `ctx.onProgress(` 调用点。\n" +
      "   反过来不查：声明 NONE 却报了一两次是「少做多」，不构成失真。\n\n" +
      "   **这条规则在本批之前是红的**：read_file 与 search 都声明了\n" +
      "   HEARTBEAT 30s，而两个文件里一次 onProgress 都没有 —— 方案 S9 承诺的\n" +
      "   「大文件读取周期性回报」从来没实现过，读代码的人会以为它们被监控着。\n" +
      "   判别力不用另造：它刚抓到两个真实案例。\n",
  );
  const progs = scanProgressDeclarations();
  for (const p of progs) {
    const ok = p.mode === "NONE" || p.hasProducer;
    console.log(
      `   ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${p.file.padEnd(44)} ` +
        `${p.mode.padEnd(19)} ${p.hasProducer ? "有 onProgress 调用点" : "无调用点"}`,
    );
  }
  const liars = progs.filter((p) => p.mode !== "NONE" && !p.hasProducer);
  verdict(
    progs.length > 0 && liars.length === 0,
    liars.length === 0
      ? `${progs.length} 个工具的进展声明与实现一致；其中 ` +
        `${progs.filter((p) => p.mode !== "NONE").length} 个承诺回报的都真的有生产点`
      : `这些工具承诺了回报却没有生产点：${liars.map((l) => l.file).join(", ")}`,
  );

  // ── B3. inputSchema 的每个参数，handler 都必须透传
  section("B3. inputSchema 声明的参数，handler 必须逐个透传");
  console.log(
    "   【定】声明了却不透传 = **这个参数在运行期不存在**，而模型完全看得到它：\n" +
      "   schema 里写着、description 教它怎么用，传了却像没传一样。\n" +
      "   模型没有任何办法发现这件事，只能反复试。\n\n" +
      "   这一段是 B2「progressReporting 声明与实现一致」的同族推广。\n" +
      "   B2 当初抓到两个真案例（read_file / search 的 HEARTBEAT 死声明），\n" +
      "   但它只查了**一种**声明；`read_blob.line_offset` 是同一个形态的第三例，\n" +
      "   而它躲过了整整一个阶段的 86 条判据。\n\n" +
      "   代价是 2026-08-28 摸底考试题 1 的 3/3 全灭：模型照 description 教的\n" +
      "   把 nextLineOffset 传回来，每次都拿到逐字节相同的第 1 页 ——\n" +
      "   53,000 字符的流水它永远只看得到前 12,000 个。\n",
  );

  const handlerSources: Array<{ label: string; file: string; src: string }> = [
    { label: "CommonToolHandler", file: "tools/common/src/index.ts", src: "" },
    { label: "MicroCaseToolHandler", file: "cases/micro-cases/src/index.ts", src: "" },
  ].map((h) => ({ ...h, src: readFileSync(join(REPO_ROOT, h.file), "utf8") }));

  /**
   * 从 handler 源码里切出某个工具的 `case "<name>":` 到下一个 `case "` 之间。
   *
   * 用源码扫描而不是运行时反射，理由与 B2 一致：透传发生在一个 switch 分支里，
   * 运行期无法枚举「它读了哪些 key」——除非给每个工具造一次调用，
   * 而那需要每个工具都有合法夹具（fetch_url 就没有）。
   */
  const caseSegment = (src: string, name: string): string | undefined => {
    const start = src.indexOf(`case "${name}":`);
    if (start < 0) return undefined;
    const next = src.indexOf('case "', start + 8);
    return src.slice(start, next < 0 ? src.length : next);
  };

  const untransmitted: string[] = [];
  let scanned = 0;
  for (const snap of DEFAULT_TOOLS) {
    const name = snap.definition.name;
    const props = Object.keys(
      (snap.definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    const owner = handlerSources.find((h) => caseSegment(h.src, name) !== undefined);
    if (!owner) {
      untransmitted.push(`${name}（没有任何 handler 认领它）`);
      continue;
    }
    scanned += 1;
    const seg = caseSegment(owner.src, name)!;
    const missing = props.filter((p) => !seg.includes(`"${p}"`));
    console.log(
      `   ${missing.length === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name.padEnd(18)} ` +
        `schema=[${props.join(", ") || "（无参数）"}]` +
        (missing.length > 0 ? `   \x1b[31m未透传: ${missing.join(", ")}\x1b[0m` : ""),
    );
    if (missing.length > 0) untransmitted.push(`${name}.${missing.join("/")}`);
  }

  verdict(
    scanned === DEFAULT_TOOLS.length && untransmitted.length === 0,
    untransmitted.length === 0
      ? `${scanned} 个工具的 inputSchema 参数全部被 handler 透传 —— ` +
        `没有「声明了但运行期不存在」的参数`
      : `这些参数声明了却没被 handler 透传：${untransmitted.join("，")}`,
  );

  // ── C. ToolDefinition 三个必填项
  section("C. ToolDefinition 三个必填项（不得绕过 #3）");
  console.log(
    "   redaction / idempotency / recoveryObservation。\n" +
      "   `recoveryObservation` 阶段 3 起已在类型上必填 —— 这一段是对**运行期构造的\n" +
      "   definition** 的兜底：类型管不到从 JSON 反序列化回来的那些。\n",
  );
  const missing: string[] = [];
  for (const t of DEFAULT_TOOLS) {
    const d = t.definition;
    if (!d.redaction?.profile) missing.push(`${d.name}.redaction`);
    if (!d.idempotency) missing.push(`${d.name}.idempotency`);
    if (!d.recoveryObservation) missing.push(`${d.name}.recoveryObservation`);
    if (!d.description || d.description.length < 20) missing.push(`${d.name}.description（过短）`);
  }
  fact("检查的工具数", DEFAULT_TOOLS.length);
  fact("缺失项", missing.length === 0 ? "无" : missing.join(", "));
  verdict(missing.length === 0, missing.length === 0 ? "三个必填项全部齐全" : "有必填项缺失");

  // ── D. 分页与截断
  section("D. 分页 ≠ 截断：不存在静默截断（不得绕过 #6）");
  console.log(
    "   分页是**模型可控**的（它知道还有多少、可以再取），截断是**模型不可见**的。\n" +
      "   阶段 1 的血泪：list_dir 曾 slice(0,200) 静默截断而 output 写「共 350 项」——\n" +
      "   模型会以为自己盘点完了。\n",
  );
  const dws = tempWorkspace();
  let paginationOk = false;
  try {
    // 超限目录：250 个文件，单页上限 200
    const big = join(dws.root, "many");
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 250; i++) writeFileSync(join(big, `f${String(i).padStart(4, "0")}.txt`), "x");
    // 超长文件：5000 行
    writeFileSync(
      join(dws.root, "long.txt"),
      Array.from({ length: 5000 }, (_, i) => `第 ${i + 1} 行`).join("\n"),
      "utf8",
    );
    // 超长单行：20000 字符在一行里
    writeFileSync(join(dws.root, "oneline.txt"), `${"A".repeat(20_000)}\n第二行`, "utf8");

    const res = await runTools(dws.root, [
      { toolCallId: "d1", name: "list_dir", input: { path: "many" } },
      { toolCallId: "d2", name: "read_file", input: { path: "long.txt", limit: 100 } },
      { toolCallId: "d3", name: "read_file", input: { path: "oneline.txt" } },
    ]);

    const dir = parseResult(res.get("d1")?.content);
    const file = parseResult(res.get("d2")?.content);
    const oneline = parseResult(res.get("d3")?.content);

    fact("list_dir total / returned / truncated", `${dir["total"]} / ${dir["returned"]} / ${dir["truncated"]}`);
    fact("list_dir nextCursor", String(dir["nextCursor"] ?? "（无）"));
    fact(
      "read_file startLine–endLine / totalLines",
      `${file["startLine"]}–${file["endLine"]} / ${file["totalLines"]}`,
    );
    fact("read_file truncated / nextStartLine", `${file["truncated"]} / ${file["nextStartLine"]}`);
    fact("超长单行 truncatedLines", JSON.stringify(oneline["truncatedLines"] ?? null));

    const dirOk =
      dir["total"] === 250 && dir["returned"] === 200 && dir["truncated"] === true && dir["nextCursor"] === 200;
    const fileOk =
      file["totalLines"] === 5000 &&
      file["startLine"] === 1 &&
      file["endLine"] === 100 &&
      file["truncated"] === true &&
      file["nextStartLine"] === 101;
    // 超长单行是唯一允许截断的地方，而且必须在返回值里说出来。
    const lineOk =
      Array.isArray(oneline["truncatedLines"]) &&
      (oneline["truncatedLines"] as number[]).includes(1) &&
      String(oneline["content"]).includes("已截断");

    paginationOk = dirOk && fileOk && lineOk;
    verdict(
      paginationOk,
      paginationOk
        ? "目录分页、文件按行分页、超长单行截断三者的 total/returned/truncated 都自洽，" +
          "且截断被显式标了出来 —— 没有任何一处是静默的"
        : `分页字段不自洽：${!dirOk ? "目录 " : ""}${!fileOk ? "文件 " : ""}${!lineOk ? "超长单行" : ""}`,
    );
  } finally {
    dws.cleanup();
  }

  // ── D2. edit_file 的结构化诊断与验证
  await sectionEditDiagnostics();

  // ── E. 组合器三方法路由
  await sectionCompositeRouting();

  // ── F. 读黑名单
  section("F. 读黑名单：read_file 与 search **各**试一次（不得绕过 #13）");
  console.log(
    "   决 3 放开了 workspace 外的读，原论证是「读错文件是信息问题」。\n" +
      "   引入 fetch_url 之后这条不成立：读是信息问题 ⇒ 信息可以被外发 ⇒ 读 ＋ 外发 ＝ 损失。\n" +
      "   而 search(kind:\"content\") 一次能扫遍整棵目录树，**只挡 read_file 等于没挡**。\n",
  );
  const fws = tempWorkspace();
  let guardOk = false;
  try {
    // 在 workspace 内放一个假的 .env —— 黑名单按**文件名**判，不按位置判。
    writeFileSync(join(fws.root, ".env"), "dashscope_api_key=sk-FAKE-CANARY-VALUE-0123456789\n", "utf8");
    /**
     * `.envrc` 是 direnv 的配置，正文常常就是一排 `export SECRET=…`。
     *
     * 【定】它此前**漏网**：前缀规则判的是「等于 `.env`」或「以 `.env.` 开头」，
     * 两条都不中，而 `readGuardRules()` 打印的却是 `basename .env*` ——
     * 看上去像挡住了（阶段 3 收口批补上）。
     */
    writeFileSync(join(fws.root, ".envrc"), "export AWS_SECRET=CANARY-DIRENV-VALUE\n", "utf8");
    writeFileSync(join(fws.root, "normal.txt"), "这是一份正常文件，可以读\n", "utf8");

    const res = await runTools(fws.root, [
      { toolCallId: "f1", name: "read_file", input: { path: ".env" } },
      { toolCallId: "f2", name: "search", input: { pattern: "CANARY", path: ".", kind: "content" } },
      { toolCallId: "f3", name: "read_file", input: { path: "normal.txt" } },
      { toolCallId: "f4", name: "read_file", input: { path: ".envrc" } },
    ]);

    const readDenied = res.get("f1");
    const searchOut = parseResult(res.get("f2")?.content);
    const normal = parseResult(res.get("f3")?.content);
    const envrcDenied = res.get("f4");

    const readBlocked = readDenied?.isError === true && readDenied.content.includes("TOOL_READ_DENIED");
    // 两个 canary 文件都该被 search 跳过（.env 与 .envrc 各一）。
    const searchBlocked =
      Number(searchOut["total"] ?? -1) === 0 && Number(searchOut["skippedByReadGuard"] ?? 0) >= 2;
    // 反向：正常文件必须仍然读得到，否则「黑名单」退化成「什么都不让读」。
    const normalStillReadable = String(normal["content"] ?? "").includes("正常文件");
    const envrcBlocked = envrcDenied?.isError === true && envrcDenied.content.includes("TOOL_READ_DENIED");

    fact("read_file(.env)", readBlocked ? "被拒（TOOL_READ_DENIED）" : `未被拒：${readDenied?.content.slice(0, 80)}`);
    fact("read_file(.envrc)", envrcBlocked ? "被拒（TOOL_READ_DENIED）" : `未被拒：${envrcDenied?.content.slice(0, 80)}`);
    fact("search(content) 命中数", `${searchOut["total"]}（黑名单跳过 ${searchOut["skippedByReadGuard"] ?? 0} 项）`);
    fact("反向：normal.txt 仍可读", normalStillReadable ? "是" : "否");

    guardOk = readBlocked && envrcBlocked && searchBlocked && normalStillReadable;
    verdict(
      guardOk,
      guardOk
        ? "两个工具各自被挡住（.env 与 .envrc 各一次），两个 canary 值一次都没进上下文；" +
          "同时正常文件仍然读得到 —— 黑名单有判别力，不是「一律拒绝」"
        : `护栏有缺口：${!readBlocked ? "read_file(.env) 没挡住 " : ""}` +
          `${!envrcBlocked ? "read_file(.envrc) 没挡住 " : ""}` +
          `${!searchBlocked ? "search 没全挡住 " : ""}${!normalStillReadable ? "正常文件被误伤" : ""}`,
    );
  } finally {
    fws.cleanup();
  }

  // ── G. 固定开销基线
  section("G. 固定开销基线（工具数膨胀的免费警报）");
  console.log(
    "   §16.1【定·实测】每工具约 180 token，与任务内容无关。\n" +
      "   「一个 Case 一套工具」会直接反映在每次请求的起步价上 —— 这是随时可读的过拟合警报。\n",
  );
  const sceneOverhead = new ToolRegistry(commonSceneTools).fixedOverheadTokens();
  const allOverhead = new ToolRegistry(DEFAULT_TOOLS).fixedOverheadTokens();
  fact("场景工具", `${commonSceneTools.length} 个 → ${sceneOverhead} tokens`);
  fact(
    "机制工具",
    `${commonMechanismTools.length} 个：${commonMechanismTools.map((t) => t.definition.name).join(", ") || "（无）"}`,
  );
  fact("tools/common 合计", `${commonTools.length} 个`);
  fact("默认装配合计（含 micro-cases 测量工具）", `${DEFAULT_TOOLS.length} 个 → ${allOverhead} tokens`);
  fact("方案预估（10 个通用工具）", "约 1800 tokens");
  // 【定】这一段只打印读数，**不设阈值**。设一个「不许超过 N」的门槛，
  // 等于在没有证据的情况下先给能力面画一条线；真正的判据是评测阶段的收益比。
  verdict(
    allOverhead > 0 && commonSceneTools.length >= 7,
    `批 1 结束时 ${commonSceneTools.length} 个场景工具、起步价 ${allOverhead} tokens（读数已记录，本段不设阈值）`,
  );

  // ── H. 大结果外置（批 1 的已知红，现已转绿；保留为防回归）
  await sectionKnownRedBlob();
}

/**
 * D2 段：`edit_file` 失败时必须给**结构化诊断**，成功时不得误报。
 *
 * 【定】没有诊断线索，模型只能反复重试同一个错误 —— 那正是 S9 的
 * Progress Guard 要检测的无进展形态。与其让守卫去收尸，不如一开始
 * 就把线索给够：模型输出的 `old_string` 极易因空格 / CRLF vs LF 的
 * 微小差异匹配失败，而那些差异**在原样比较下完全看不出来**。
 */
async function sectionEditDiagnostics(): Promise<void> {
  section("D2. edit_file 的结构化诊断，以及「正确行为不得被误报」");

  const ws = tempWorkspace();
  try {
    writeFileSync(
      join(ws.root, "doc.md"),
      ["# 标题", "", "    缩进过的那一行", "普通一行", "重复行", "重复行", ""].join("\n"),
      "utf8",
    );

    const res = await runTools(ws.root, [
      /**
       * ① 零匹配：**行内多了一个空格**。
       *
       * 这是模型最常犯的那种错，也是最难自己看出来的 —— 原样打印时
       * 两个串看起来一模一样。所以诊断必须做**去空白**的近似匹配，
       * 而不是「没找到，请重试」。
       *
       * 注意不能用「少了前导缩进」来造这个用例：`includes` 是子串匹配，
       * 少写缩进照样匹配得上（第一版就是这么写的，结果它匹配成功了）。
       */
      {
        toolCallId: "e1",
        name: "edit_file",
        input: { path: "doc.md", old_string: "缩进过的  那一行", new_string: "改过了" },
      },
      // ② 多重匹配：必须给出**全部**命中行号。
      {
        toolCallId: "e2",
        name: "edit_file",
        input: { path: "doc.md", old_string: "重复行", new_string: "唯一行" },
      },
      /**
       * ③ 锚点插入：`new_string` **包含** `old_string`。
       *
       * 这是回归守卫。此前 `verifyEditFile` 要求「原内容必须消失」，
       * 而这种编辑之后原内容当然还在（它就在新内容里面）—— 于是一次
       * **完全正确**的编辑被判成验证失败，整个 Run 从 SUCCESS 掉成
       * COMPLETED_WITH_LIMITS。S13 的代码场景第一次跑就撞上了它。
       *
       * 一个在正确行为上报警的验证器比没有验证器更糟：它会训练人忽略它。
       */
      {
        toolCallId: "e3",
        name: "edit_file",
        input: { path: "doc.md", old_string: "# 标题", new_string: "# 标题\n\n（补充说明）" },
      },
    ]);

    const zero = res.get("e1");
    const multi = res.get("e2");
    const anchor = res.get("e3");

    const zeroOk =
      zero?.isError === true &&
      zero.content.includes("TOOL_EDIT_NO_MATCH") &&
      // 【定】必须指出**最接近的候选行号**，不能只说「没找到」。
      zero.content.includes("第 3 行");
    const multiOk =
      multi?.isError === true &&
      multi.content.includes("TOOL_EDIT_AMBIGUOUS") &&
      // 【定】必须给**全部**命中行号，只给数量的话模型不知道该扩哪一处的上下文。
      multi.content.includes("5") &&
      multi.content.includes("6");
    const anchorOk = anchor?.isError === false;

    fact("零匹配 → 诊断", zeroOk ? "给出了最接近的候选行号" : zero?.content.slice(0, 120) ?? "（无）");
    fact("多重匹配 → 诊断", multiOk ? "给出了全部命中行号" : multi?.content.slice(0, 120) ?? "（无）");
    fact("锚点插入（new 含 old）", anchorOk ? "验证通过（正确）" : anchor?.content.slice(0, 160) ?? "（无）");

    verdict(
      zeroOk && multiOk && anchorOk,
      zeroOk && multiOk && anchorOk
        ? "零匹配给出最接近的候选行、多重匹配给出全部命中行号；" +
          "而「在锚点后插入」这种 new_string 包含 old_string 的正确编辑**不会**被误判失败"
        : !zeroOk
          ? "零匹配没有给出候选行号 —— 模型只能盲猜，然后反复重试同一个错误"
          : !multiOk
            ? "多重匹配没有给出全部命中行号"
            : "锚点插入被误判成验证失败 —— 验证器在正确行为上报警了",
    );
  } finally {
    ws.cleanup();
  }
}

/**
 * E 段：组合器必须路由 `verify` / `observePre` / `observePost` 三个方法。
 *
 * 用真 kill -9，不用 transcript 注入 —— 注入的崩溃会顺手把 ACTION_FACT
 * 也写对，而这一段要验的恰恰是「那条 ACTION_FACT 到底是不是组合器写出来的」。
 */
async function sectionCompositeRouting(): Promise<void> {
  section("E. 组合器三方法路由（不得绕过 #10）");
  console.log(
    "   只路由 verify、让 observePre 返回 undefined，后果不是「少一个观察」：\n" +
      "   前置指纹拍不到 → 崩溃后一律判「观察不了」→ §18.2 分支二的工具**全部\n" +
      "   静默退化成分支三**。没有任何报错，盘上也看不出来。\n" +
      "   edit_file 是批 1 唯一天然落在分支二的场景工具，所以这条第一次真正生效。\n",
  );

  const tmp = mkdtempSync(join(tmpdir(), "workagent-tools-e-"));
  try {
    /** 跑一次「edit_file 执行前崩溃 → resume」，返回落到了哪条分支。 */
    const runCase = (label: string, breakRouting: boolean): { branch: string; fp: string } => {
      const dir = join(tmp, label);
      const ws = join(dir, "ws");
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, "doc.md"), "第一行\n要被替换的那一段\n第三行\n", "utf8");
      const dbPath = join(dir, "runs.db");

      const script = [
        {
          text: "改一处",
          toolCalls: [
            {
              toolCallId: "e1",
              name: "edit_file",
              input: { path: "doc.md", old_string: "要被替换的那一段", new_string: "换好了" },
            },
          ],
        },
        { text: "做完了。", toolCalls: [] },
      ];

      const seg1 = runSegment({
        workerPath: WORKER,
        dbPath,
        workspace: ws,
        mode: "start",
        script,
        killAt: "AttemptStarted#1",
        ...(breakRouting ? { breakVerifierRouting: true } : {}),
      });
      if (!seg1.killed) throw new Error(`${label}：第一段没有被 kill（${seg1.error ?? "?"}）`);

      const seg2 = runSegment({
        workerPath: WORKER,
        dbPath,
        workspace: ws,
        mode: "resume",
        runId: seg1.runId,
        script,
        scriptOffset: 1,
        recoveryDecision: "CONTINUE",
        ...(breakRouting ? { breakVerifierRouting: true } : {}),
      });

      const line = seg2.stdout.split("\n").find((l) => l.startsWith("@@BRANCH@@")) ?? "";
      const m = /@@BRANCH@@(\S+) fp=(\S+)/.exec(line);
      return { branch: m?.[1] ?? "(没有 ResumeUnpairedToolUse)", fp: m?.[2] ?? "?" };
    };

    const good = runCase("good", false);
    fact("生产组合器：edit_file 的恢复分支", `${good.branch}（拍到指纹 ${good.fp}）`);

    const broken = runCase("broken", true);
    fact("只路由 verify 时：同一个 edit_file", `${broken.branch}（拍到指纹 ${broken.fp}）`);

    const routedOk = good.branch === "OBSERVE_FIRST" && good.fp === "true";
    verdict(
      routedOk,
      routedOk
        ? "生产组合器下 edit_file 落 §18.2 分支二，且执行前指纹真的拍到了 —— " +
          "observePre 与 observePost 都被路由到了 CommonVerifier"
        : `期望 OBSERVE_FIRST ＋ 有指纹，实际 ${good.branch} / fp=${good.fp}`,
    );

    const discriminating = broken.branch === "RECOVERY_REQUIRED" && broken.fp === "false";
    verdict(
      discriminating,
      discriminating
        ? "把 observePre / observePost 的路由拿掉之后，同一个 edit_file 从分支二退化到分支三 —— " +
          "上面那条断言因此是有判别力的，而且这正是「盘上看不出来」的那个 bug 的形状"
        : `改坏路由后没有翻红：分支 ${broken.branch} / fp=${broken.fp}（说明这条判据测不到路由）`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * H 段：**批 1 结束时预期为红**，批 2 S6（Blob 外置）之后转绿。
 *
 * 【定】它不是回归，是**欠账的可见形态**。
 * `read_file` 在批 1 就能产大结果，而外置机制在批 2 —— 缺口应当在它被
 * 引入的那一批就可见，而不是等到下一批才第一次被提起。
 */
async function sectionKnownRedBlob(): Promise<void> {
  section("H. 大结果外置（批 1 的已知红，批 2 S6 之后已转绿）");
  console.log(
    `   inlineToolResultLimitTokens 默认 ${DEFAULT_CONTEXT_POLICY.inlineToolResultLimitTokens}。\n` +
      "   批 1 结束时它有默认值、有定义、**零消费点**，而 read_file 已经能产出\n" +
      "   远超它的结果 —— 这条判据当时是红的，记录的是那一批的**已知欠账**。\n" +
      "   批 2 S6 接上 Materialization 之后转绿。\n" +
      "   【定】保留这条判据而不是删掉：它现在是防回归的那道线。\n",
  );

  const ws = tempWorkspace();
  try {
    // 约 60000 字符 ≈ 24000 token，远超 8000 的阈值。
    const big = Array.from({ length: 3_000 }, (_, i) => `这是第 ${i + 1} 行内容，用来把结果撑大。`).join("\n");
    writeFileSync(join(ws.root, "huge.txt"), big, "utf8");

    const res = await runTools(ws.root, [
      { toolCallId: "h1", name: "read_file", input: { path: "huge.txt" } },
    ]);
    const raw = res.get("h1")?.content ?? "";
    const approxTokens = Math.ceil(raw.length / 2.5);
    const limit = DEFAULT_CONTEXT_POLICY.inlineToolResultLimitTokens;

    // 外置发生的标志：帧里留下的是结构合法的 stub（带 blobRef / ref），而不是全文。
    const parsed = parseResult(raw);
    const externalized =
      approxTokens <= limit && (parsed["blobRef"] !== undefined || parsed["ref"] !== undefined);

    fact("tool_result 正文长度", `${raw.length} 字符 ≈ ${approxTokens} tokens`);
    fact("inlineToolResultLimitTokens", limit);
    fact("是否外置成 Blob 引用", externalized ? "是" : "否 —— 全文直接进了帧");

    verdict(
      externalized,
      externalized
        ? "大结果已被外置成 stub，全文没有进帧（批 2 S6 已接线）"
        : `【已知红】超阈值结果（${approxTokens} > ${limit}）原样灌进了 Context —— ` +
          `BlobStorePort 与 §11.4 的 Materialization 在批 2 S6 才接线。` +
          `这条红是批 1 的已知欠账，不是回归。`,
    );
  } finally {
    ws.cleanup();
  }

  // ══════════════════════════════════════════════════════ I 段（阶段 3.5）
  section("I. fetch_url 的 as 参数：结构转换 ≠ 正文挑选（ADR-0007）");
  console.log(
    "   【定】这一段的重心不是「转换成功了」，是**它有没有越过 ADR-0007 那条线**。\n\n" +
      "   决 1 说 fetch_url「不得内置任何正文提取逻辑」。ADR-0007 划的是它内部\n" +
      "   的一条线：结构转换（标签 → 语法）可以，语义挑选（哪块是正文）不可以。\n" +
      "   判据是「换个 Case 结论会不会变」——\n" +
      "     <h1> 该变成 #     三个场景里都一样      → 转换\n" +
      "     导航栏要不要留   归档要丢、盘点站点要留 → 业务判断\n\n" +
      "   所以下面那条**导航文本必须仍然在**是本段的核心判据：\n" +
      "   它红了说明有人加了 readability 那类规则，从内部把决 1 绕过去了。\n",
  );

  /**
   * 夹具刻意做成「导航 ＋ 正文 ＋ 页脚 ＋ script/style」的真实网页形状。
   * 不联网 —— `url-guard` 拒绝私网，本地起服务器也测不了（见 renderText 的注释）。
   */
  const FIXTURE = [
    "<!DOCTYPE html><html><head><title>标题</title>",
    "<style>.a{color:red;font-size:12px;background:#fff;padding:0}</style>",
    "<script>window.__DATA__={a:1,b:2,c:3};function boot(){console.log('x')}</script>",
    "</head><body>",
    '<nav><a href="/docs">Documentation</a><a href="/pricing">Pricing</a></nav>',
    "<main><h1>发布说明</h1><p>这是<strong>正文</strong>第一段，含一个<a href=\"/x\">链接</a>。</p>",
    "<ul><li>第一条</li><li>第二条</li></ul>",
    "<pre><code>npm install</code></pre></main>",
    "<footer>Earendil Inc. 版权所有</footer>",
    "</body></html>",
  ].join("");

  const md = renderText(FIXTURE, "text/html; charset=utf-8", undefined);
  const rawOut = renderText(FIXTURE, "text/html", "raw");
  const json = renderText('{"a":1}', "application/json", undefined);

  fact("默认 format", md.format);
  fact("as=raw 时 format", rawOut.format);
  fact("application/json 的 format", json.format);
  fact("转换后长度", `${FIXTURE.length} → ${md.content.length} 字符`);

  // ① 默认就转（不依赖模型主动传参）
  const defaultConverts = md.format === "markdown" && md.content.includes("# 发布说明");
  // ② 导航与页脚**仍然在** —— 结构转换的判据
  const navKept = md.content.includes("Documentation") && md.content.includes("Earendil");
  // ③ script / style 的正文不进上下文
  const noiseDropped = !md.content.includes("__DATA__") && !md.content.includes("font-size");
  // ④ 结构真的转出来了
  const structural =
    md.content.includes("[链接](/x)") &&
    md.content.includes("**正文**") &&
    // 【定】列表标记后的空格数不写死 —— turndown 输出的是 `-   第一条`（3 个空格）。
    // 断言一个自己想当然的格式，红的是判据不是代码；第一次跑就撞到了。
    /^-\s+第一条$/m.test(md.content);
  // ⑤ as=raw 原样返回
  const rawWorks = rawOut.format === "html" && rawOut.content === FIXTURE;
  // ⑥ 非 HTML 不受影响
  const jsonUntouched = json.format === "text" && json.content === '{"a":1}';

  console.log(
    `\n   ① 默认转换            ${defaultConverts ? "✓" : "✗"}\n` +
      `   ② 导航/页脚仍在        ${navKept ? "✓" : "✗"}   ← 越过 ADR-0007 这条会红\n` +
      `   ③ script/style 被丢弃  ${noiseDropped ? "✓" : "✗"}\n` +
      `   ④ 标题/链接/强调/列表  ${structural ? "✓" : "✗"}\n` +
      `   ⑤ as="raw" 原样返回    ${rawWorks ? "✓" : "✗"}\n` +
      `   ⑥ JSON 不被当 HTML 转  ${jsonUntouched ? "✓" : "✗"}`,
  );

  verdict(
    defaultConverts && navKept && noiseDropped && structural && rawWorks && jsonUntouched,
    defaultConverts && navKept && noiseDropped && structural && rawWorks && jsonUntouched
      ? "六项全部成立：默认转 Markdown、**导航与页脚仍在**（做的是结构转换不是正文挑选）、" +
        "script/style 不进上下文、as=\"raw\" 有退路、非 HTML 不受影响"
      : `ADR-0007 的边界或转换本身有问题：默认转=${defaultConverts} 导航仍在=${navKept} ` +
        `噪音丢弃=${noiseDropped} 结构=${structural} raw=${rawWorks} JSON=${jsonUntouched}`,
  );

  /**
   * ⑦ 真实规模下的削减幅度。
   *
   * 【定】这条不做阈值断言，只**打印事实**。
   * 削减比例取决于页面本身（一个纯文本页面转完可能一点都不小），
   * 卡一个数字会得到一条随夹具漂移的假判据。真实测量记在这里：
   * pi.dev/news/releases/0.84.3 实测 38280 → 13023 字符（**66%**），
   * ≈15312 → ≈5210 token。
   */
  const bulky = FIXTURE.repeat(40);
  const bulkyMd = renderText(bulky, "text/html", undefined);
  fact(
    "放大 40 倍后的削减",
    `${bulky.length} → ${bulkyMd.content.length} 字符` +
      `（${(100 - (bulkyMd.content.length / bulky.length) * 100).toFixed(1)}%）`,
  );
  fact("真实页面实测（记录用）", "pi.dev 0.84.3：38280 → 13023 字符，66%，≈15312 → ≈5210 token");
}

void runVerify(main);
