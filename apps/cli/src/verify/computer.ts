/**
 * ADR-0013 验收：本机 computer use（verify:computer）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 要答的问题：**在一个所有动作的副作用都无从事先判断、观察只有像素的工具域里，
 * Atlas 的声明纪律与事实表还能不能说真话？**
 *
 * 全程用假驱动（`fixtures/fake-gui-driver.ts`）：**不截真屏、不动鼠标、
 * 不弹授权框**。验收脚本跑在用户正在用的这台电脑上 —— 一条会真的点击的判据
 * 不可接受。真助手（Swift）那一半由 `npm run computer:doctor` 人工核对（ADR-0013）。
 *
 * 【定】判定全在 TS 一侧，假驱动只供数据（见 `driver.ts` 的文件头）——
 * 所以这里测到的每一次拒绝，都是生产代码做出的拒绝。
 *
 * 【定】判据打在**整条链路**上（脚本化模型 → 入参校验 → Resolver → Policy →
 * 审批 → handler → 驱动 → 结算 → 下一帧），不直接调 handler：verify:mcp D 段
 * 第一版直接调 `handler.execute`，校验器根本不在那条路径上 —— 判据打在下游，
 * 跨不过出事的那一跳。
 *
 * 【定】每条「应当拒绝」都与一条「应当放行」成对。一个拒绝一切的实现能让所有
 * 拒绝类判据全绿 —— 阶段 3.5 的沙箱在「越界写被拦」那条判据下栽过同一跤。
 *
 * 注入实测：A 段就地做；其余各段的注入方法写在各自的 verdict 旁边，
 * 交付前逐条做过（改坏实现 → 本脚本退出码非 0 → 改回）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CollectingTraceSink,
  DEFAULT_CONTEXT_POLICY,
  asId,
  estimateImageTokens,
  liveImageWindowStart,
  loadProfileFromFile,
  type ApprovalDecider,
  type ContextFrame,
  type EndpointCapabilityProfile,
  type ModelInvocationObserver,
  type ModelInvocationResult,
  type ModelRequest,
  type ModelStreamEvent,
  type RunEvent,
  type RunId,
  type StartResult,
  type ToolSnapshot,
} from "@workagent/harness-runtime";
import { createAnthropicProtocol } from "@workagent/shape-anthropic-messages";
import { approveExcept } from "@workagent/testkit";
import { HelperDriver, parseComputerFlags, type ComputerApprovalView } from "@workagent/tools-computer";
import { PendingHub } from "../../../workagent-service/src/human-channels.js";
import type { UiPending } from "../../../workagent-service/src/api-types.js";
import { COMPUTER_USE_PROMPT, REPO_ROOT, autoGrantVerdict, compose, type Composed } from "../compose.js";
import { BOUNDARIES, grepBoundary } from "./boundaries.js";
import {
  ScriptedModelPort,
  banner,
  fact,
  runVerify,
  section,
  tempWorkspace,
  verdict,
  type ScriptedTurn,
} from "./harness.js";
import {
  CALCULATOR,
  CHROME,
  FINDER,
  FakeGuiDriver,
  TERMINAL,
  TEXTEDIT,
  refOf,
  solidPng,
  windowOf,
} from "./fixtures/fake-gui-driver.js";

const PROFILES = resolve(REPO_ROOT, "adapters/endpoint-profiles");
const QWEN = loadProfileFromFile(resolve(PROFILES, "bailian-anthropic-qwen38flash.json"));
const DEEPSEEK = loadProfileFromFile(resolve(PROFILES, "deepseek-anthropic-flash.json"));
const FULL: [number, number, number, number] = [0, 0, 1536, 960];

const cleanups: Array<() => void> = [];

// ═══════════════════════════════════════════════════════════ 夹具与驱动

/** 每一轮开始前改一下「屏幕」—— 模型下一批动作执行时看到的就是改过的世界。 */
class HookedModel extends ScriptedModelPort {
  constructor(
    script: ScriptedTurn[],
    private readonly beforeTurn: (turn: number) => void,
  ) {
    super(script);
  }

  override async *invoke(
    request: ModelRequest,
    signal: AbortSignal,
    observer: ModelInvocationObserver,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult> {
    this.beforeTurn(this.turnsConsumed);
    return yield* super.invoke(request, signal, observer);
  }
}

interface Rig {
  composed: Composed;
  model: ScriptedModelPort;
  trace: CollectingTraceSink;
}

function rig(p: {
  ws: string;
  driver: FakeGuiDriver;
  script: ScriptedTurn[];
  beforeTurn?: (turn: number) => void;
  level?: "view" | "control";
  apps?: string;
  allowBrowsers?: boolean;
  profile?: EndpointCapabilityProfile;
  approvalDecider?: ApprovalDecider;
  modelAuditDir?: string;
  dbPath?: string;
  /**
   * 默认把连续失败放宽到 50：本脚本好几段**故意**连着造拒绝，按默认的 3 会在
   * 中途撞墙，测不到后面的判据。默认预算下会发生什么，N 段单独测、单独说。
   */
  budgets?: Record<string, number>;
}): Rig {
  const trace = new CollectingTraceSink();
  const model = p.beforeTurn ? new HookedModel(p.script, p.beforeTurn) : new ScriptedModelPort(p.script);
  const composed = compose({
    workspaceRoot: p.ws,
    dbPath: p.dbPath ?? ":memory:",
    ...(p.modelAuditDir ? { modelAuditDir: p.modelAuditDir } : {}),
    trace,
    modelPortOverride: model,
    profileOverride: p.profile ?? QWEN,
    approvalDecider: p.approvalDecider ?? approveExcept([]),
    timezone: "Asia/Shanghai",
    budgetOverrides: p.budgets ?? { consecutiveFailures: 50 },
    computer: {
      config: parseComputerFlags(p.level ?? "control", p.apps ?? "TextEdit,Calculator", p.allowBrowsers ?? false),
      driver: p.driver,
      handlerOptions: { settleMs: 0 },
    },
  });
  return { composed, model, trace };
}

async function drain(
  gen: AsyncGenerator<RunEvent, StartResult>,
  onEvent?: (e: RunEvent) => void,
): Promise<{ runId: string; result: StartResult }> {
  let runId = "";
  let step = await gen.next();
  while (!step.done) {
    if (!runId) runId = String(step.value.runId);
    onEvent?.(step.value);
    step = await gen.next();
  }
  return { runId, result: step.value };
}

/** 跑完一个 Run，返回每个 toolCallId 的 result（读 transcript —— Runtime 自己的记录）。 */
async function run(r: Rig, task = "GUI 夹具任务"): Promise<{
  runId: string;
  result: StartResult;
  results: Map<string, { content: string; isError: boolean }>;
}> {
  const { runId, result } = await drain(r.composed.runtime.start(r.composed.makeRunSpec(task)));
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const e of await r.composed.ports.transcript.readAll(runId as RunId)) {
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_result") results.set(c.toolCallId, { content: c.content, isError: c.isError });
    }
  }
  return { runId, result, results };
}

/** tool_result 里的 `code`（失败）或 `status`（成功 / SKIPPED）。 */
function codeOf(r: { content: string } | undefined): string {
  if (!r) return "（没有 result）";
  try {
    const j = JSON.parse(r.content) as { code?: string; status?: string };
    return j.code ?? j.status ?? "（无 code）";
  } catch {
    return "（非 JSON）";
  }
}

function messageOf(r: { content: string } | undefined): string {
  try {
    return String((JSON.parse(r?.content ?? "{}") as { message?: string }).message ?? "");
  } catch {
    return "";
  }
}

const shot = (id: string): ScriptedTurn["toolCalls"][number] => ({ toolCallId: id, name: "screenshot", input: {} });
const act = (id: string, input: Record<string, unknown>): ScriptedTurn["toolCalls"][number] => ({
  toolCallId: id,
  name: "computer",
  input,
});
const turn = (...toolCalls: ScriptedTurn["toolCalls"]): ScriptedTurn => ({ toolCalls });
const END: ScriptedTurn = { text: "完成。", toolCalls: [] };

// ─────────────────────────────────────────────────── 请求体里的图像

interface Block {
  type?: string;
  content?: unknown;
  source?: { data?: string };
}

function messagesOf(body: unknown): Array<{ content: unknown }> {
  const m = (body as { messages?: unknown }).messages;
  return Array.isArray(m) ? (m as Array<{ content: unknown }>) : [];
}

/** tool_result **之内**的图像（base64），按出现顺序。 */
function imagesInToolResults(body: unknown): string[] {
  const out: string[] = [];
  for (const m of messagesOf(body)) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      if (b.type !== "tool_result" || !Array.isArray(b.content)) continue;
      for (const x of b.content as Block[]) if (x.type === "image") out.push(String(x.source?.data ?? ""));
    }
  }
  return out;
}

/** tool_result **之外**的图像块。Spike 1 P-1：百炼对它们 HTTP 200 却静默丢图。 */
function strayImages(body: unknown): number {
  let n = 0;
  for (const m of messagesOf(body)) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) if (b.type === "image") n += 1;
  }
  return n;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

function readTreeText(root: string): string {
  if (!existsSync(root)) return "";
  let out = "";
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    out += entry.isDirectory() ? readTreeText(path) : readFileSync(path, "utf8") + "\n";
  }
  return out;
}

const qwenImgTokens = (): number => estimateImageTokens(QWEN.vision!, 1792, 1120);

function withoutVision(p: EndpointCapabilityProfile): EndpointCapabilityProfile {
  const copy: EndpointCapabilityProfile = { ...p };
  delete copy.vision;
  return copy;
}

/** 一个只产出一张图的工具 —— C 段测的是 **Runtime 的图像通道**，与屏幕无关。 */
const IMAGE_FIXTURE: ToolSnapshot = {
  toolId: asId("tool_image_fixture"),
  version: "1.0.0",
  definition: {
    id: asId("tool_image_fixture"),
    version: "1.0.0",
    name: "image_fixture",
    description: "验收夹具：返回一张图。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    effectResolution: {
      kind: "DECLARATIVE",
      rule: { pointer: "", effectType: "READ", scopeKind: "NONE", reversibility: "REVERSIBLE", operation: "fixture" },
    },
    redaction: { profile: "STANDARD" },
    idempotency: { isIdempotent: true, isReadOnly: true },
    timeoutPolicy: { timeoutMs: 10_000 },
    progressReporting: { mode: "NONE" },
    verification: { mode: "NONE", requiredForSuccess: false },
    recoveryObservation: { requiresPreFingerprint: false },
  },
};

async function runImageFixture(
  profile: EndpointCapabilityProfile,
  png: Uint8Array,
): Promise<{ model: ScriptedModelPort; trace: CollectingTraceSink }> {
  const ws = tempWorkspace();
  cleanups.push(ws.cleanup);
  const trace = new CollectingTraceSink();
  const model = new ScriptedModelPort([
    {
      // 带推理块：DeepSeek 的声明是 VERBATIM_REQUIRED（带 tool_call 的回合缺推理块，
      // 帧在发出之前就被协议校验拦下）。真实端点每个回合都会给，夹具照着给。
      reasoning: "先看一眼。",
      text: "看一张图",
      toolCalls: [{ toolCallId: "img_1", name: "image_fixture", input: {} }],
    },
    { text: "看到了。", toolCalls: [] },
  ]);
  const composed = compose({
    workspaceRoot: ws.root,
    dbPath: ":memory:",
    trace,
    modelPortOverride: model,
    profileOverride: profile,
    approvalDecider: approveExcept([]),
    timezone: "Asia/Shanghai",
    tools: [IMAGE_FIXTURE],
    portOverrides: {
      tools: {
        execute: async () => ({
          ok: true,
          output: JSON.stringify({ status: "OK" }),
          sideEffectState: "NO_EFFECT" as const,
          resources: [{ kind: "image" as const, label: "夹具图", mediaType: "image/png", content: png }],
        }),
      },
    },
  });
  try {
    await drain(composed.runtime.start(composed.makeRunSpec("看一张图")));
    return { model, trace };
  } finally {
    composed.db.close();
  }
}

// ═══════════════════════════════════════════════════════════════ 主体

async function main(): Promise<void> {
  banner(
    "ADR-0013 验收：本机 computer use（verify:computer）",
    "观察只有像素、副作用无从事先判断时，Atlas 的声明纪律与事实表还能不能说真话？",
  );

  // ════════════════════════════════════════════════════ A. 边界 15
  section("A. 边界 15：屏幕与输入不得进 Runtime / 适配器");
  const b15 = BOUNDARIES.find((b) => b.id === "15");
  if (!b15) {
    verdict(false, "边界表里找不到编号 15 —— 它是不是被删了？");
    return;
  }
  const cleanNow = grepBoundary(b15);
  fact("边界 15 当前命中", cleanNow.length === 0 ? "干净" : cleanNow.join(" | "));
  /**
   * 判别力实测：两种诱惑各注入一次（见 boundaries.ts 里第 15 条的说明）。
   * 第二种尤其要测 —— 坐标空间就写在端点声明里，「谁读声明谁换算」读起来很顺。
   */
  const canaries = [
    {
      rel: "packages/harness-runtime/src/ports/__computer_canary.ts",
      body: 'import type { ComputerDriver } from "@x/screen";\nexport type ScreenPort = ComputerDriver;\n',
      what: "Runtime 里的「屏幕 Port」",
    },
    {
      rel: "adapters/shape-anthropic-messages/src/__grounding_canary.ts",
      body: "declare function toPoints(p: unknown, d: unknown): unknown;\nexport const at = toPoints({ x: 500, y: 250 }, {});\n",
      what: "形状适配器里的坐标换算",
    },
  ];
  let canaryOk = true;
  for (const c of canaries) {
    const abs = resolve(REPO_ROOT, c.rel);
    const name = c.rel.split("/").pop()!;
    let hits: string[] = [];
    try {
      writeFileSync(abs, `// 判别力实测的临时文件，写完立刻删。\n${c.body}`);
      hits = grepBoundary(b15).filter((h) => h.includes(name));
    } finally {
      rmSync(abs, { force: true });
    }
    const cleaned = !existsSync(abs);
    fact(`注入「${c.what}」后命中`, hits[0] ?? "（没命中 —— 这条 grep 是瞎的）");
    canaryOk = canaryOk && hits.length > 0 && cleaned;
  }
  verdict(
    cleanNow.length === 0 && canaryOk,
    cleanNow.length === 0 && canaryOk
      ? "当前零命中；两种诱惑各注入一次都当场翻红并指出行号，注入文件已清理 —— 它有判别力"
      : `边界 15 失败：当前命中 ${cleanNow.length} 条，判别力 ${canaryOk ? "有" : "无"}`,
  );

  // ════════════════════════════════════════════════════ B. 配置与装配
  section("B. 启用参数 fail-fast ＋ 没有 vision 就不装");
  const bad: Array<[string | undefined, string | undefined, string]> = [
    ["contrl", "TextEdit", "档位拼错"],
    ["view", undefined, "开了却没给白名单"],
    [undefined, "TextEdit", "给了白名单却没开"],
    ["control", "TextEdit,Safari", "浏览器（审批卡就在浏览器里）"],
    ["control", "com.apple.Terminal", "终端（bundle id）"],
    ["control", "com.google.Chrome.canary", "浏览器变体（不能靠换个后缀绕过）"],
    ["control", "com.jetbrains.WebStorm", "IDE（厂商前缀认全家）"],
    ["control", "Code", "IDE（按应用名）"],
    ["view", "1Password", "密码管理器（只截图也不行）"],
  ];
  const leaked: string[] = [];
  for (const [level, apps, why] of bad) {
    try {
      parseComputerFlags(level, apps);
      leaked.push(why);
    } catch {
      // 应当抛
    }
  }
  fact("应当拒绝的配置", `${bad.length} 种，放过了 ${leaked.length} 种${leaked.length ? `：${leaked.join("、")}` : ""}`);
  const good = parseComputerFlags("control", "TextEdit,com.apple.calculator");
  const off = parseComputerFlags(undefined, undefined);
  const goodShape =
    good.level === "control" &&
    good.apps.map((a) => a.kind).join(",") === "NAME,BUNDLE_ID" &&
    off.level === "off";
  fact("合法配置", `${good.level} / ${good.apps.map((a) => `${a.raw}(${a.kind})`).join("、")}；不传 → ${off.level}`);
  verdict(
    leaked.length === 0 && goodShape,
    leaked.length === 0 && goodShape
      ? `${bad.length} 种非法 / 硬拒绝配置在启动时全部被拒，合法配置照常解析（成对）`
      : `配置解析有缺口：放过 [${leaked.join("、")}]，合法配置解析${goodShape ? "正常" : "异常"}`,
  );

  {
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    let noVisionError = "";
    try {
      rig({ ws: ws.root, driver: new FakeGuiDriver(), script: [END], profile: withoutVision(QWEN) }).composed.db.close();
    } catch (err) {
      noVisionError = (err as Error).message;
    }
    const control = rig({ ws: ws.root, driver: new FakeGuiDriver(), script: [END] });
    const view = rig({ ws: ws.root, driver: new FakeGuiDriver(), script: [END], level: "view" });
    const controlTools = control.composed.tools.map((t) => t.definition.name).filter((n) => n === "screenshot" || n === "computer");
    const viewTools = view.composed.tools.map((t) => t.definition.name).filter((n) => n === "screenshot" || n === "computer");
    await run(control);
    const promptIn = JSON.stringify(control.model.requestBodies[0] ?? {}).includes(COMPUTER_USE_PROMPT.split("\n")[1]!);
    control.composed.db.close();
    view.composed.db.close();
    fact("没有 vision 的端点", noVisionError ? noVisionError.split("。")[0]! : "（没拒绝 —— 模型会闭着眼睛点屏幕）");
    fact("control 档装上的 GUI 工具", controlTools.join(" + "));
    fact("view 档装上的 GUI 工具", viewTools.join(" + "));
    verdict(
      noVisionError.includes("vision") &&
        controlTools.join(",") === "screenshot,computer" &&
        viewTools.join(",") === "screenshot" &&
        promptIn,
      "没有 vision 声明就启动失败；有 vision 时 control 装两件、view 只装截图，GUI 那段操作守则进了 system prompt",
    );
  }

  // ════════════════════════════════════════════════════ C. 图像通道
  section("C. 图像通道：图进 tool_result **之内**，端点没有 vision 就一张都不装");
  console.log(
    "   这一段与屏幕无关：用一个只产出一张图的夹具工具，测的是 **Runtime 的图像通道**。\n" +
      "   【定】图放在 tool_result 里面 —— Spike 1 P-1 实测，放在 tool_result 之后的同一条\n" +
      "   user 消息里，百炼 HTTP 200 却静默丢图（4/4），模型回答「看不到」。",
  );
  {
    const png = solidPng(1792, 1120, 77);
    const withV = await runImageFixture(QWEN, png);
    const noV = await runImageFixture(withoutVision(QWEN), png);
    const reqV = withV.model.requestBodies[1];
    const reqN = noV.model.requestBodies[1];
    const imgsV = imagesInToolResults(reqV);
    const stored = withV.trace.byType("ResourceStored").find((e) => e.payload.kind === "image");
    const storedN = noV.trace.byType("ResourceStored").find((e) => e.payload.kind === "image");
    fact("有 vision：tool_result 内的图", `${imgsV.length} 张，字节${imgsV[0] === b64(png) ? "逐字一致" : "不一致"}`);
    fact("有 vision：tool_result 外的图", strayImages(reqV));
    fact("没 vision：请求里的图", imagesInToolResults(reqN).length + strayImages(reqN));
    fact("ResourceStored（图）", stored ? `${stored.payload.kind} / ${stored.payload.redactionDisposition}` : "（没有）");
    verdict(
      imgsV.length === 1 && imgsV[0] === b64(png) && strayImages(reqV) === 0 &&
        imagesInToolResults(withV.model.requestBodies[0]).length === 0,
      "有 vision 的端点：图逐字装进了 tool_result 之内，且只出现在产出它之后的那一帧",
    );
    verdict(
      imagesInToolResults(reqN).length + strayImages(reqN) === 0 &&
        storedN !== undefined &&
        JSON.stringify(reqN).includes(storedN.payload.ref),
      "没有 vision 的端点：一张图都不装，但 tool_result 里仍有那张图的引用 —— 模型知道有过一张图，只是看不到",
    );
    verdict(
      stored?.payload.redactionDisposition === "IMAGE_NOT_REDACTED_SENT_TO_MODEL",
      "图像资源如实登记为「未脱敏、发往模型」—— 没有假装它被脱敏过",
    );

    /**
     * ── 第二道门要有能单独触发它的输入 ────────────────────────────────────
     *
     * 「没有 vision 就一张都不装」有两道门：帧编译时不装（attachLiveImages）、
     * 适配器出请求时不发（buildRequest）。上面那条端到端判据测的是**两道的合取**——
     * 注入实测：只摘适配器那道，它照样绿（第一道已经挡住了），守卫重叠区的老形态。
     * 所以这里直接给适配器一个**已经带着活图**的帧（将来有人在别处往 liveImages
     * 里塞图，第一道就不在路径上了），看它自己拦不拦。成对：有 vision 时照发。
     */
    const img = {
      ref: "res_fixture",
      contentHash: "sha256:fixture",
      mediaType: "image/png" as const,
      data: b64(png),
      width: 1792,
      height: 1120,
      estimatedTokens: qwenImgTokens(),
    };
    const frameWithImage = {
      items: [
        { kind: "USER_MESSAGE", content: { type: "text", text: "看图" } },
        {
          kind: "MODEL_TOOL_CALL",
          content: { type: "tool_call", toolCallId: "tc_img", name: "image_fixture", input: {} },
        },
        {
          kind: "TOOL_RESULT",
          content: {
            type: "tool_result",
            toolCallId: "tc_img",
            content: "{}",
            isError: false,
            resourceRefs: [
              {
                ref: img.ref,
                contentHash: img.contentHash,
                sizeBytes: png.byteLength,
                kind: "image",
                mediaType: "image/png",
                label: "夹具图",
                redactionDisposition: "IMAGE_NOT_REDACTED_SENT_TO_MODEL",
              },
            ],
          },
        },
      ],
      liveImages: { [img.ref]: img },
    } as unknown as ContextFrame;
    const protoFor = (profile: EndpointCapabilityProfile): unknown =>
      createAnthropicProtocol({ profile, tools: [], systemPrompt: "夹具", maxOutputTokens: 1000 })
        .buildRequest(frameWithImage).body;
    const gateOff = imagesInToolResults(protoFor(withoutVision(QWEN))).length;
    const gateOn = imagesInToolResults(protoFor(QWEN)).length;
    fact("适配器单独面对一张活图", `没有 vision：发出 ${gateOff} 张；有 vision：发出 ${gateOn} 张`);
    verdict(
      gateOff === 0 && gateOn === 1,
      "适配器这道门单独成立：帧上就算已经有活图，端点没有 vision 声明也不发（成对：有声明时照发）",
    );

    /**
     * token：本地估算路径（百炼没有 count_tokens）与 count_tokens 路径（DeepSeek）各一条。
     * 两条都用「同一份夹具、只差一个声明字段」的配对，差值必须**恰好**等于公式值 ——
     * 不是「大于零」：多算一倍（两处都加）与少算（一处都没加）都得翻红。
     * 注入：删掉 estimateTokens 里的 liveImageTokens → C4 红；
     *       countTokens 里去掉 `!countTokensIncludesImages` 条件 → C5 的 includes=true 一侧多出 962 → 红。
     */
    const totalAt = (t: CollectingTraceSink, i: number): number =>
      t.byType("ContextFrameCompiled")[i]?.payload.totalTokens ?? NaN;
    const qwenImg = estimateImageTokens(QWEN.vision!, 1792, 1120);
    const diffQ = totalAt(withV.trace, 1) - totalAt(noV.trace, 1);
    fact("百炼（本地估算）：带图帧 − 不带图帧", `${diffQ}（公式 ${qwenImg} = ⌈1792/32⌉×⌈1120/32⌉+2）`);
    verdict(diffQ === qwenImg, "本地估算路径：一张 1792×1120 的图恰好按端点声明的公式计入帧大小");

    const dsIncl = await runImageFixture(DEEPSEEK, png);
    const dsExcl = await runImageFixture(
      { ...DEEPSEEK, vision: { ...DEEPSEEK.vision!, countTokensIncludesImages: false } },
      png,
    );
    const dsImg = estimateImageTokens(DEEPSEEK.vision!, 1792, 1120);
    const diffD = totalAt(dsExcl.trace, 1) - totalAt(dsIncl.trace, 1);
    fact("count_tokens 路径：「不计图」声明 − 「计图」声明", `${diffD}（公式 ${dsImg}，DeepSeek 封顶 962）`);
    verdict(
      diffD === dsImg && imagesInToolResults(dsIncl.model.requestBodies[1]).length === 1,
      "count_tokens 路径：端点说它算图就不重复加，说不算就恰好补上一张图的公式值",
    );
  }

  // ════════════════════════════════════════════════════ D. 活跃图像窗口
  section("D. 活跃图像窗口：成批移出，历史只在跨过步长时改写一次");
  {
    const { liveImageLimit: L, liveImagePruneStep: S } = DEFAULT_CONTEXT_POLICY;
    const expectedStarts = [0, 0, 0, 0, 0, 0, 3, 3, 3, 6, 6];
    const starts = expectedStarts.map((_, n) => liveImageWindowStart(n, 3, 3));
    fact("liveImageWindowStart(n, 3, 3)，n = 0…10", starts.join(" "));
    verdict(
      starts.join(",") === expectedStarts.join(","),
      "窗口起点按步长成批前移（3 张之后每多 3 张才移一次），而不是每来一张挤掉一张",
    );

    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    // 每批带一个不同秒数的 wait：七批完全相同的 [screenshot] 会在第三批被
    // Progress Guard 判为原地打转（N 段专门测那件事）。
    const script: ScriptedTurn[] = [];
    for (let k = 0; k < 7; k++) script.push(turn(act(`dw${k}`, { action: "wait", seconds: 0.001 * (k + 1) }), shot(`ds${k}`)));
    script.push(END);
    const r = rig({ ws: ws.root, driver, script });
    await run(r);
    r.composed.db.close();
    const perRequest = r.model.requestBodies.slice(1, 8).map(imagesInToolResults);
    const counts = perRequest.map((x) => x.length);
    const expectedCounts = [1, 2, 3, 4, 5, 3, 4];
    let rewrites = 0;
    for (let i = 1; i < perRequest.length; i++) {
      const prev = perRequest[i - 1]!;
      const cur = perRequest[i]!;
      if (!prev.every((d, j) => cur[j] === d)) rewrites += 1;
    }
    const last = perRequest[6] ?? [];
    const lastAreNewest = [4, 5, 6, 7].every((seed, j) => last[j] === b64(solidPng(1792, 1120, seed)));
    fact("生产策略", `liveImageLimit ${L} / liveImagePruneStep ${S}`);
    fact("第 1…7 张截图之后请求里的活图数", counts.join(" "));
    fact("历史被改写的次数（前缀缓存失效点）", rewrites);
    fact("第 7 帧里活着的是哪几张", lastAreNewest ? "第 4–7 张（最近的那批）" : "不是最近的那几张");
    verdict(
      L === 3 && S === 3 && counts.join(",") === expectedCounts.join(",") && rewrites === 1 && lastAreNewest,
      L === 3 && S === 3
        ? "端到端：活图数在 [3, 5] 之间摆动，七帧里历史只被改写一次，留下的是最近的截图"
        : `生产策略变了（${L}/${S}），本段的期望值要跟着重算 —— 不许由被测函数推出期望值`,
    );
  }

  // ════════════════════════════════════════════════════ E. 坐标换算
  section("E. 坐标：0–1000 → 显示器逻辑点（三个坐标系两两不等）");
  console.log(
    "   显示器 1536×960 pt（2×）、截图 1792×1120 px、模型坐标 0–1000。\n" +
      "   拿截图像素去乘归一化坐标，会在 (500,250) 上点到 (896,280) 而不是 (768,240) —— 不报错。",
  );
  {
    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const r = rig({
      ws: ws.root,
      driver,
      script: [
        turn(shot("e0")),
        turn(
          act("e1", { action: "left_click", x: 500, y: 250 }),
          act("e2", { action: "double_click", x: 1000, y: 1000 }),
          act("e3", { action: "right_click", x: 0, y: 0 }),
        ),
        turn(
          act("e4", { action: "scroll", x: 250, y: 750, direction: "down", amount: 5 }),
          act("e5", { action: "drag", x: 100, y: 100, to_x: 900, to_y: 900 }),
        ),
        END,
      ],
    });
    const out = await run(r);
    r.composed.db.close();
    const shotInfo = JSON.parse(out.results.get("e0")?.content ?? "{}") as { screenshot?: { width: number; height: number } };
    const p = driver.performed;
    const ok =
      p.length === 5 &&
      p[0]?.kind === "click" && p[0].button === "left" && p[0].count === 1 && near(p[0].x, 768) && near(p[0].y, 240) &&
      p[1]?.kind === "click" && p[1].count === 2 && near(p[1].x, 1535) && near(p[1].y, 959) &&
      p[2]?.kind === "click" && p[2].button === "right" && near(p[2].x, 0) && near(p[2].y, 0) &&
      p[3]?.kind === "scroll" && near(p[3].x, 384) && near(p[3].y, 720) && p[3].dy === -5 && p[3].dx === 0 &&
      p[4]?.kind === "drag" && near(p[4].fromX, 153.6) && near(p[4].fromY, 96) && near(p[4].toX, 1382.4) && near(p[4].toY, 864);
    fact("截图尺寸（= 端点声明的长边）", `${shotInfo.screenshot?.width}×${shotInfo.screenshot?.height}，请求长边 ${driver.captures[0]?.maxLongEdgePx}`);
    fact("投递记录", JSON.stringify(p.map((a) => ("x" in a ? [a.kind, a.x, a.y] : "fromX" in a ? [a.kind, a.fromX, a.fromY, a.toX, a.toY] : [a.kind]))));
    verdict(
      shotInfo.screenshot?.width === QWEN.vision!.preferredScreenshotLongEdgePx && shotInfo.screenshot?.height === 1120,
      "截图长边来自端点声明（1792），宽高比跟显示器走",
    );
    verdict(
      ok,
      ok
        ? "五种指针动作全部按显示器逻辑点投递：(500,250)→(768,240)，(1000,1000) 夹到 (1535,959)，滚动方向与拖拽终点都对"
        : "坐标换算错了 —— 注入：toPoints 改用截图像素尺寸，(500,250) 会变成 (896,280)",
    );

    /**
     * 第一次真桌面运行的那个 bug（ADR-0014）：截图其实只覆盖了白名单窗口的外接矩形，
     * 而换算假设「图 = 整块显示器」—— 每一下都点偏、不报错。现在驱动报回 contentRect，
     * 换算经它。夹具报一个**偏移的**区域：按整块显示器换算会点在 (768,240)，经区域换算是 (868,290)。
     * 注入：toPoints 不加 area.x / area.y（或改回用显示器尺寸）→ 红。
     */
    const d2 = new FakeGuiDriver();
    d2.contentRect = { x: 100, y: 50, width: 1536, height: 960 };
    d2.display = { widthPt: 1792, heightPt: 1120, scale: 2 };
    d2.windows = [windowOf(TEXTEDIT, 11, [0, 0, 1792, 1120])];
    const ws2 = tempWorkspace();
    cleanups.push(ws2.cleanup);
    const r2 = rig({ ws: ws2.root, driver: d2, script: [turn(shot("ec0")), turn(act("ec1", { action: "left_click", x: 500, y: 250 })), END] });
    await run(r2);
    r2.composed.db.close();
    const c2 = d2.performed[0];
    fact("截图区域偏移时 (500,250) 点到", c2 && "x" in c2 ? `(${c2.x}, ${c2.y}) pt` : "（没点）");
    verdict(
      c2?.kind === "click" && near(c2.x, 868) && near(c2.y, 290),
      "换算经驱动报回的截图区域（contentRect），不假设它就是整块显示器 —— 第一次真桌面运行正是栽在这个假设上",
    );

    const proposed = r.trace.byType("ActionProposed");
    const shotP = proposed.find((e) => e.payload.toolName === "screenshot");
    const clickP = proposed.find((e) => e.payload.toolName === "computer");
    fact("screenshot 的 riskFacts / dataMovement", `${shotP?.payload.riskFacts.join(",")} / ${shotP?.payload.dataMovement?.destination ?? "（无）"}`);
    fact("computer 的 riskFacts", clickP?.payload.riskFacts.join(",") ?? "（无）");
    verdict(
      !!shotP?.payload.riskFacts.includes("SCREEN_CONTENT_SENT_TO_MODEL_ENDPOINT") &&
        shotP.payload.dataMovement?.destination === "模型端点" &&
        !!clickP?.payload.riskFacts.includes("GUI_INPUT_NOT_SANDBOXED"),
      "两条审计事实上了事件流：截图会外发到模型端点、GUI 输入不在沙箱内（无论 --sandbox 是哪一档）",
    );
  }

  // ════════════════════════════════════════════════════ F. 执行前复核
  section("F. 执行前复核：白名单 / 硬拒绝 / 窗口身份 / 画面 / 截图失效");
  console.log(
    "   审批一律放行（等同 AUTO 档）—— 这一段要证明的正是：**审批放行之后，复核照样拦**。\n" +
      "   人批准的是「在那张截图上点这里」，执行时那里已经不是那个东西了，就不许点。",
  );
  {
    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const r = rig({
      ws: ws.root,
      driver,
      beforeTurn: (t) => {
        if (t === 2) driver.windows = [windowOf(CALCULATOR, 22, FULL)]; // 换了一个窗口（仍在白名单里）
        if (t === 3) {
          driver.windows = [windowOf(TEXTEDIT, 11, FULL)];
          driver.regionDiff = 40; // 同一个窗口，画面变了
        }
        if (t === 4) {
          driver.regionDiff = 0;
          void driver.close(); // 助手重启：它手里的截图没了
        }
        // t5：截图**之后**冒出来一个 Finder；t6–t7：Finder 在截图时就在那儿（先截图、下一批再点）。
        // 【定】截图与动作分两批：同一批里截的图模型还没看到，动作不以它为依据（CU-R03，P 段）——
        // 写成同批的话，这几条测的就成了「复核依据是哪一张」，而不是「模型瞄错了」。
        if (t === 5) driver.windows = [windowOf(FINDER, 33, FULL), windowOf(TEXTEDIT, 11, FULL)];
        if (t === 8) driver.windows = [windowOf(TERMINAL, 44, FULL), windowOf(TEXTEDIT, 11, FULL)];
        if (t === 10) driver.windows = [windowOf(FINDER, 33, [768, 0, 768, 960]), windowOf(TEXTEDIT, 11, FULL)];
      },
      script: [
        turn(shot("f0")),
        turn(act("f1", { action: "left_click", x: 500, y: 250 })),
        turn(act("f2", { action: "left_click", x: 510, y: 250 })),
        turn(act("f3", { action: "left_click", x: 520, y: 250 })),
        turn(act("f4", { action: "left_click", x: 530, y: 250 })),
        turn(act("f5", { action: "left_click", x: 540, y: 250 })),
        turn(shot("f6s")),
        turn(act("f6", { action: "left_click", x: 550, y: 250 })),
        turn(shot("f7s")),
        turn(act("f7", { action: "left_click", x: 560, y: 250 })),
        turn(shot("f8s")),
        turn(act("f8", { action: "drag", x: 200, y: 250, to_x: 900, to_y: 250 })),
        END,
      ],
    });
    const out = await run(r);
    r.composed.db.close();
    const c = (id: string): string => codeOf(out.results.get(id));
    for (const id of ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"]) fact(id, `${c(id)}  ${messageOf(out.results.get(id)).slice(0, 60)}`);
    fact("投递记录", `${driver.performed.length} 次`);
    verdict(
      c("f1") === "OK" && driver.performed.length === 1,
      "配对：屏幕没变时照常执行；之后七次被拒的动作一次都没有投递（投递记录只有 f1 那一下）",
    );
    verdict(
      c("f2") === "TOOL_GUI_STATE_CHANGED" && messageOf(out.results.get("f2")).includes("窗口"),
      "③ 窗口身份：目标处换成了另一个窗口（哪怕也在白名单里）→ 拒绝。注入：去掉 windowId 比对 → 红",
    );
    verdict(
      c("f3") === "TOOL_GUI_STATE_CHANGED" && messageOf(out.results.get("f3")).includes("灰度差"),
      "④ 画面：同一个窗口、目标处画面变了 → 拒绝。注入：阈值判断改成恒假 → 红",
    );
    verdict(
      c("f4") === "TOOL_GUI_STATE_CHANGED" && messageOf(out.results.get("f4")).includes("失效"),
      "截图失效（助手重启过）→ 拒绝，不拿一个比对不了的旧观察去点。注入：null 当成 0 → 红",
    );
    verdict(
      c("f5") === "TOOL_GUI_STATE_CHANGED" && messageOf(out.results.get("f5")).includes("Finder") &&
        c("f6") === "TOOL_GUI_TARGET_NOT_ALLOWED" && c("f7") === "TOOL_GUI_TARGET_DENIED",
      "先问「变没变」再问「许不许」：截图之后才冒出来的 Finder → STATE_CHANGED（世界变了）；" +
        "截图时就在那儿的 Finder / Terminal → NOT_ALLOWED / DENIED（模型瞄错了）。两种都拒，审批放行救不了",
    );
    verdict(
      c("f8s") === "OK" && c("f8") === "TOOL_GUI_TARGET_NOT_ALLOWED" && messageOf(out.results.get("f8")).includes("拖拽终点"),
      "拖拽终点也要在白名单里 —— 起点合法、终点落在别的应用上同样拒绝（拖过去就是把内容交给了未授权的一方）",
    );
  }

  // ════════════════════════════════════════════════════ G. 失败即中止本批
  section("G. haltsBatchOnFailure：一个 GUI 动作失败，同批后面的一律跳过");
  console.log(
    "   一批 [点击, 输入] 里点击被拒之后，那段文字如果照常打出去，就落进了一个没人看过的窗口。",
  );
  {
    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const r = rig({
      ws: ws.root,
      driver,
      beforeTurn: (t) => {
        if (t === 1) driver.windows = [windowOf(FINDER, 33, FULL), windowOf(TEXTEDIT, 11, FULL)];
        if (t === 2) driver.windows = [windowOf(TEXTEDIT, 11, FULL)];
      },
      script: [
        turn(shot("g0")),
        turn(act("g1", { action: "left_click", x: 500, y: 250 }), act("g2", { action: "type", text: "hello" }), shot("g3")),
        turn(shot("g4")),
        turn(act("g5", { action: "left_click", x: 500, y: 250 }), act("g6", { action: "type", text: "hi" })),
        END,
      ],
    });
    const out = await run(r);
    r.composed.db.close();
    const c = (id: string): string => codeOf(out.results.get(id));
    fact("被拒那一批", `${c("g1")} → ${c("g2")} → ${c("g3")}`);
    fact("正常那一批", `${c("g5")} → ${c("g6")}`);
    fact("截图次数 / 投递记录", `${driver.captures.length} / ${driver.performed.map((a) => a.kind).join(",")}`);
    verdict(
      // g1 被拒是因为截图之后冒出了一个 Finder（STATE_CHANGED）—— 观察过期的拒绝同样中止本批：
      // 后面那几个动作也是照着那张过期截图排的。
      c("g1") === "TOOL_GUI_STATE_CHANGED" && c("g2") === "SKIPPED" && c("g3") === "SKIPPED" &&
        driver.captures.length === 2 && driver.performed.length === 2,
      "点击被拒之后同批的输入与截图都被跳过，且每个调用仍恰好一个 result（不变量 8）。注入：删掉执行失败分支的 haltIfDeclared → 红",
    );
    verdict(
      c("g5") === "OK" && c("g6") === "OK" &&
        driver.performed.map((a) => a.kind).join(",") === "click,type",
      "配对：前一个动作成功时，同批后面的照常执行",
    );
  }

  // ════════════════════════════════════════════════════ H. 观察与授权
  section("H. 没截过图不许点；缺系统授权就如实说，并让下一次能读到新授权");
  {
    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const r = rig({
      ws: ws.root,
      driver,
      script: [
        turn(act("h1", { action: "left_click", x: 500, y: 250 })),
        turn(shot("h2")),
        turn(act("h3", { action: "left_click", x: 500, y: 250 })),
        END,
      ],
    });
    const out = await run(r);
    r.composed.db.close();
    fact("没截图就点", codeOf(out.results.get("h1")));
    fact("截图之后再点", codeOf(out.results.get("h3")));
    verdict(
      codeOf(out.results.get("h1")) === "TOOL_GUI_NO_OBSERVATION" &&
        codeOf(out.results.get("h3")) === "OK" &&
        driver.performed.length === 1,
      "本进程里没截过图 → 拒绝（崩溃或重启后旧截图描述的不一定是现在）；截图之后同一个点照常执行（成对）",
    );

    const d2 = new FakeGuiDriver();
    d2.permissionsState = { screenRecording: false, accessibility: true };
    const r2 = rig({
      ws: ws.root,
      driver: d2,
      beforeTurn: (t) => {
        if (t === 1) d2.permissionsState = { screenRecording: true, accessibility: true };
      },
      script: [turn(shot("p1")), turn(shot("p2")), END],
    });
    const out2 = await run(r2);
    r2.composed.db.close();
    fact("缺录屏授权时截图", `${codeOf(out2.results.get("p1"))}，关掉助手 ${d2.closeCount} 次`);
    fact("授权之后再截图", codeOf(out2.results.get("p2")));
    verdict(
      codeOf(out2.results.get("p1")) === "TOOL_GUI_PERMISSION_REQUIRED" &&
        messageOf(out2.results.get("p1")).includes("Atlas GUI Helper") &&
        d2.closeCount === 1 &&
        codeOf(out2.results.get("p2")) === "OK" &&
        d2.captures.length === 1,
      "缺授权：具名失败、点名授权对象是助手而不是终端、关掉助手；用户授权后同一个 Run 里下一次截图就成功",
    );
  }

  // ════════════════════════════════════════════════════ I. 键盘
  section("I. 键盘：安全输入、前台应用、系统级组合键");
  {
    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const r = rig({
      ws: ws.root,
      driver,
      beforeTurn: (t) => {
        if (t === 1) driver.secureInput = true;
        if (t === 2) {
          driver.secureInput = false;
          driver.frontmost = refOf(FINDER);
        }
        if (t === 3) driver.frontmost = refOf(TERMINAL);
        if (t === 4) driver.frontmost = refOf(TEXTEDIT);
      },
      script: [
        turn(shot("i0")),
        turn(act("i1", { action: "type", text: "hunter2" })),
        turn(act("i2", { action: "type", text: "x" })),
        turn(act("i3", { action: "key", text: "cmd+s" })),
        turn(act("i4", { action: "key", text: "cmd+space" })),
        turn(act("i5", { action: "type", text: "你好，Atlas" }), act("i6", { action: "key", text: "Cmd+S" })),
        END,
      ],
    });
    const out = await run(r);
    r.composed.db.close();
    const c = (id: string): string => codeOf(out.results.get(id));
    for (const id of ["i1", "i2", "i3", "i4", "i5", "i6"]) fact(id, c(id));
    const p = driver.performed;
    verdict(
      c("i1") === "TOOL_GUI_SECURE_INPUT" && !p.some((a) => a.kind === "type" && a.text === "hunter2"),
      "安全输入开着（密码框有焦点）→ 拒绝合成键盘输入，那段文字一个字都没发出去",
    );
    verdict(
      c("i2") === "TOOL_GUI_FOCUS_NOT_ALLOWED" && c("i3") === "TOOL_GUI_TARGET_DENIED" && c("i4") === "TOOL_GUI_INPUT_INVALID",
      "前台不在白名单 / 前台是终端 / 唤起 Spotlight 的组合键 → 三种具名拒绝",
    );
    verdict(
      c("i5") === "OK" && c("i6") === "OK" && p.length === 2 &&
        p[0]?.kind === "type" && p[0].text === "你好，Atlas" && p[0].pid === TEXTEDIT.pid &&
        p[1]?.kind === "key" && p[1].key === "s" && p[1].modifiers.join(",") === "cmd" && p[1].pid === TEXTEDIT.pid,
      "配对：前台是白名单应用时，文字与组合键按原样发给那个进程（大小写不同的 Cmd+S 解析成同一个键）",
    );
  }

  // ════════════════════════════════════════════════════ J. 审批面
  section("J. 审批面（Web 通道端到端）：截图不问，点击要问，而且要说清点的是什么");
  console.log(
    "   走的是生产的 PendingHub.approvalDecider（界面上那张卡片的来源），不是脚本化 decider。\n" +
      "   只打坐标的审批是盲批 ——「点保存」与「点删除」在坐标里长得一样。",
  );
  {
    const driver = new FakeGuiDriver();
    driver.windows = [windowOf(TEXTEDIT, 11, FULL, "报告\u202Etxt.exe")];
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const hub = new PendingHub();
    const aborter = new AbortController();
    let composedRef: Composed | undefined;
    const rawViews: Array<ComputerApprovalView | undefined> = [];
    const decider = hub.approvalDecider(
      (a) => autoGrantVerdict(a, ws.root),
      () => "DEFAULT" as const,
      () => false,
      () => aborter.signal,
      async (a) => {
        const v = await composedRef!.computer!.describeForApproval(a);
        rawViews.push(v);
        return v;
      },
    );
    const seen: UiPending[] = [];
    hub.onChange(() => {
      for (const p of hub.list()) {
        if (p.kind !== "APPROVAL" || seen.some((s) => s.pendingId === p.pendingId)) continue;
        seen.push(p);
        setImmediate(() => hub.answer(p.pendingId, { kind: "APPROVAL", approved: true }));
      }
    });
    const r = rig({
      ws: ws.root,
      driver,
      approvalDecider: decider,
      script: [turn(shot("j0")), turn(act("j1", { action: "left_click", x: 500, y: 250 })), END],
    });
    composedRef = r.composed;
    const out = await run(r);
    r.composed.db.close();
    const requested = r.trace.byType("ApprovalRequested");
    const proposed = r.trace.byType("ActionProposed");
    const toolOf = (actionId: string): string => proposed.find((e) => e.payload.actionId === actionId)?.payload.toolName ?? "?";
    const gui = seen[0]?.approval?.gui;
    fact("请求审批的工具", requested.map((e) => toolOf(String(e.payload.actionId))).join(", ") || "（无）");
    fact("卡片 summary", gui?.summary ?? "（没有 gui 字段）");
    for (const l of gui?.details ?? []) fact("  detail", l);
    verdict(
      requested.length === 1 && toolOf(String(requested[0]!.payload.actionId)) === "computer",
      "DEFAULT 档：截图（READ）不问；点击（EXECUTE＋IRREVERSIBLE）不在有限自动放行范围内，停下来问人",
    );
    verdict(
      !!gui &&
        gui.summary.includes("TextEdit") &&
        gui.details.some((l) => l.includes("AXButton") && l.includes("保存")) &&
        gui.details.some((l) => l.includes("(500, 250)/1000 → (768, 240) pt")),
      "卡片说出了点的是哪个应用、哪个控件、坐标换算成了哪个点 —— 不是一行坐标",
    );
    const rawHasRlo = JSON.stringify(rawViews).includes("\u202E");
    const cardHasRlo = JSON.stringify(gui ?? {}).includes("\u202E");
    fact("窗口标题里的 RLO", `describeForApproval 原样带着：${rawHasRlo ? "是" : "否"}；卡片上：${cardHasRlo ? "还在" : "已剥掉"}`);
    verdict(
      rawHasRlo && !cardHasRlo,
      "窗口标题来自别的应用（可带双向覆盖字符）：卡片上剥掉了，而夹具里确实带着它（成对 —— 否则这条判据恒真）",
    );
    const decided = r.trace.byType("ApprovalDecided")[0];
    verdict(
      codeOf(out.results.get("j1")) === "OK" && driver.performed.length === 1 && decided?.payload.decidedBy === "HUMAN",
      "人在卡片上批准之后动作真的执行了，决定记为 HUMAN —— 审批链路闭合",
    );
    aborter.abort();
  }

  // ════════════════════════════════════════════════════ K. 审计不落图像字节
  section("K. 模型调用审计：图像字节不进审计文件，其余逐字是实际请求（CU-8）");
  {
    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const auditDir = mkdtempSync(join(tmpdir(), "workagent-computer-audit-"));
    cleanups.push(() => rmSync(auditDir, { recursive: true, force: true }));
    const r = rig({ ws: ws.root, driver, modelAuditDir: auditDir, script: [turn(shot("k0")), END] });
    await run(r);
    r.composed.db.close();
    const sent = imagesInToolResults(r.model.requestBodies[1])[0];
    const auditText = readTreeText(auditDir);
    const requests = auditText
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l) as { kind?: string; turn?: number; request?: { body?: unknown } })
      .filter((x) => x.kind === "request");
    const firstAudit = requests.find((x) => x.turn === 1)?.request?.body;
    const stored = r.trace.byType("ResourceStored").find((e) => e.payload.kind === "image");
    fact("实际发出的请求里有图", sent ? `是（base64 ${sent.length} 字符）` : "否");
    fact("审计文件里有那段 base64", sent && auditText.includes(sent) ? "有" : "没有");
    fact("审计里的占位", auditText.includes("图像字节未写入审计") ? "有，带 hash" : "没有");
    verdict(
      !!sent && !auditText.includes(sent) && auditText.includes("图像字节未写入审计") &&
        !!stored && auditText.includes(stored.payload.contentHash),
      "图确实发出去了，审计里却只剩一句指回 ResourceStore 的占位（ref ＋ hash）—— 屏幕内容不在磁盘上多一份副本。注入：run-loop 改回 request.body → 红",
    );
    verdict(
      firstAudit !== undefined && JSON.stringify(firstAudit) === JSON.stringify(r.model.requestBodies[0]),
      "没有图的那一帧，审计记录与实际请求逐字相同 —— 替换只碰图像字节",
    );
  }

  // ════════════════════════════════════════════════════ L / M. resume
  section("L / M. resume：说出「屏幕状态核对不了」；截图重做、点击交人决定");
  console.log(
    "   【定】识别外部状态工具靠**声明**（stateOutsideTranscript），不靠名字前缀：\n" +
      "   旧规则只认 `mcp__`，截图与点击会被当成「没有外部状态」—— 而屏幕正是最典型的那种。",
  );
  {
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const dbPath = join(ws.root, "runs.db");
    const startAndCancel = async (apps: string): Promise<{ runId: string; c: Rig }> => {
      const c = rig({ ws: ws.root, driver: new FakeGuiDriver(), script: [END], dbPath, apps });
      const gen = c.composed.runtime.start(c.composed.makeRunSpec("用得到屏幕的任务"));
      let runId = "";
      let step = await gen.next();
      while (!step.done) {
        if (!runId) {
          runId = String(step.value.runId);
          c.composed.runtime.cancel(runId as RunId, "模拟进程崩掉");
        }
        step = await gen.next();
      }
      return { runId, c };
    };

    // R1：崩在一批 [screenshot, click] 中途 —— 两个 tool_use 都没有 result。
    const r1 = await startAndCancel("TextEdit");
    await r1.c.composed.ports.transcript.append({
      runId: r1.runId as RunId,
      kind: "MESSAGE",
      message: {
        role: "assistant",
        origin: "MODEL",
        turn: 9,
        content: [
          { type: "tool_call", toolCallId: "m_shot", name: "screenshot", input: {} },
          { type: "tool_call", toolCallId: "m_click", name: "computer", input: { action: "left_click", x: 500, y: 250 } },
        ],
      },
      createdAt: Date.now(),
    });
    r1.c.composed.db.close();

    const d2 = new FakeGuiDriver();
    const c2 = rig({ ws: ws.root, driver: d2, script: [END], dbPath, apps: "TextEdit" });
    const ev: RunEvent[] = [];
    const resumed = await drain(c2.composed.runtime.resume(r1.runId as RunId), (e) => ev.push(e));
    c2.composed.db.close();
    const unverifiable = ev.find((e) => e.type === "ResumeExternalToolsUnverifiable");
    const branches = ev.flatMap((e) => (e.type === "ResumeUnpairedToolUse" ? [`${e.payload.toolName}:${e.payload.branch}`] : []));
    const modelCalls = ev.filter((e) => e.type === "ModelInvocationCompleted").length;
    fact("ResumeExternalToolsUnverifiable", unverifiable ? JSON.stringify(unverifiable.payload) : "（没发）");
    fact("未配对调用的分支", branches.join("  "));
    fact("恢复后截图 / 投递 / 调模型", `${d2.captures.length} / ${d2.performed.length} / ${modelCalls}`);
    verdict(
      unverifiable?.type === "ResumeExternalToolsUnverifiable" &&
        unverifiable.payload.toolNames.includes("screenshot") &&
        unverifiable.payload.toolNames.includes("computer") &&
        unverifiable.payload.drifted.length === 0,
      "用过 GUI 工具的 Run，resume 时说出「这些工具的外部状态我核对不了」；同一份配置下判定为没有漂移",
    );
    verdict(
      branches.includes("screenshot:IDEMPOTENT_RETRY") &&
        branches.includes("computer:RECOVERY_REQUIRED") &&
        d2.captures.length === 1 &&
        d2.performed.length === 0 &&
        modelCalls === 0 &&
        resumed.result.terminal.reason === "RECOVERY_REQUIRED",
      "截图（只读幂等）落分支一、真的重截了一张；点击落分支三、没有重放、停下来等人 —— 「点了没点」在屏幕上无从判断",
    );

    // R2：白名单换了再 resume —— 那些工具的身份变了，必须点名。
    const r2 = await startAndCancel("TextEdit");
    r2.c.composed.db.close();
    const c3 = rig({ ws: ws.root, driver: new FakeGuiDriver(), script: [END], dbPath, apps: "Calculator" });
    const ev3: RunEvent[] = [];
    await drain(c3.composed.runtime.resume(r2.runId as RunId), (e) => ev3.push(e));
    c3.composed.db.close();
    const u3 = ev3.find((e) => e.type === "ResumeExternalToolsUnverifiable");
    const drifted = u3?.type === "ResumeExternalToolsUnverifiable" ? u3.payload.drifted : [];
    fact("白名单 TextEdit → Calculator 之后的漂移", JSON.stringify(drifted));
    verdict(
      drifted.includes("screenshot") && drifted.includes("computer"),
      "白名单变了，resume 点名两个工具的身份已变 —— 旧 Run 接着点下去的不再是当初授权的那个应用",
    );
  }

  // ════════════════════════════════════════════════════ N. ADR-0014 的两条规则
  section("N. ADR-0014：观察过期的拒绝不计失败；只读外部状态的批不按入参判打转（各自成对）");
  console.log(
    "   ① 「连续失败」不再计入 AFTER_REOBSERVATION ＋ NOT_STARTED 的拒绝（截图之后屏幕变了）；\n" +
      "     但模型自己的错误照常计入 —— 配对那一半钉着它，否则「什么都不计」也能全绿；\n" +
      "   ② 全部由「只读、读 transcript 之外状态」的调用组成的批，不按入参判打转、并重置计数；\n" +
      "     「动作 ＋ 截图」的批照旧按入参判 —— 那是登记在案的剩余盲区，启动提示如实说。\n" +
      "   每一条都同时核对启动提示：规则改了而提示没改，这里会红。",
  );
  {
    // ── N1：五次「观察过期」的拒绝，默认预算（连续失败上限 3）下 Run 照常走完
    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const stale = new Set([1, 3, 5, 6, 7]);
    const r = rig({
      ws: ws.root,
      driver,
      budgets: {},
      beforeTurn: (t) => {
        // 奇数轮：截图之后冒出一个 Finder（世界变了）；其余轮：恢复成截图时的样子。
        driver.windows = stale.has(t)
          ? [windowOf(FINDER, 33, FULL), windowOf(TEXTEDIT, 11, FULL)]
          : [windowOf(TEXTEDIT, 11, FULL)];
      },
      script: [
        turn(shot("n0")),
        ...[1, 2, 3, 4, 5, 6, 7].map((k) => turn(act(`n${k}`, { action: "left_click", x: 400 + k * 10, y: 250 }))),
        END,
      ],
    });
    const out = await run(r);
    r.composed.db.close();
    const hard = r.trace.byType("BudgetHardLimitReached")[0];
    const staleCodes = [...stale].map((k) => codeOf(out.results.get(`n${k}`)));
    fact("五次过期拒绝的 code", staleCodes.join(" "));
    fact("撞墙", hard ? `${hard.payload.axis} ${hard.payload.used}/${hard.payload.limit}` : "（没撞）");
    fact("结束方式", out.result.terminal.reason);
    verdict(
      staleCodes.every((c) => c === "TOOL_GUI_STATE_CHANGED") && !hard && out.result.terminal.reason === "COMPLETED",
      "五次「截图之后屏幕变了」的拒绝（上限 3）都没把 Run 推到撞墙 —— 观察过期不是谁的失败。注入：run-loop 去掉 AFTER_REOBSERVATION 豁免 → 红",
    );

    // ── N1 配对：模型自己瞄错（Finder 在截图时就在那儿）照常计入，三次撞墙
    const d2 = new FakeGuiDriver();
    d2.windows = [windowOf(FINDER, 33, FULL), windowOf(TEXTEDIT, 11, FULL)];
    const r2 = rig({
      ws: ws.root,
      driver: d2,
      budgets: {},
      script: [
        turn(shot("m0")),
        ...[1, 2, 3, 4].map((k) => turn(act(`m${k}`, { action: "left_click", x: 400 + k * 10, y: 250 }))),
        END,
      ],
    });
    const out2 = await run(r2);
    r2.composed.db.close();
    const hard2 = r2.trace.byType("BudgetHardLimitReached")[0];
    const notice = r2.composed.notices.map((n) => `${n.text}\n${n.detail ?? ""}`).join("\n");
    fact("模型瞄错三次", `${["m1", "m2", "m3"].map((id) => codeOf(out2.results.get(id))).join(" ")} → ${hard2 ? `${hard2.payload.axis} ${hard2.payload.used}/${hard2.payload.limit}` : "（没撞）"}`);
    verdict(
      hard2?.payload.axis === "consecutiveFailures" &&
        codeOf(out2.results.get("m1")) === "TOOL_GUI_TARGET_NOT_ALLOWED" &&
        !out2.results.has("m4") &&
        notice.includes("照常计入") &&
        notice.includes("--max-consecutive-failures"),
      "配对：模型自己瞄错（截图时那里就是白名单外的窗口）照常计入，三次撞墙 —— 启动提示如实说了这一半",
    );
  }
  {
    // ── N2：连截四次（只读外部状态的批）不算打转
    const d3 = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const r3 = rig({ ws: ws.root, driver: d3, script: [turn(shot("q1")), turn(shot("q2")), turn(shot("q3")), turn(shot("q4")), END] });
    const out3 = await run(r3);
    r3.composed.db.close();

    // 观察会**重置**计数：[点 A] [截图] [点 A] [截图] [点 A] 不算打转 —— 每次点之前它都重新看过。
    const d4 = new FakeGuiDriver();
    const A = (id: string): ScriptedTurn => turn(act(id, { action: "left_click", x: 500, y: 250 }));
    const r4 = rig({ ws: ws.root, driver: d4, script: [turn(shot("w0")), A("w1"), turn(shot("w2")), A("w3"), turn(shot("w4")), A("w5"), END] });
    const out4 = await run(r4);
    r4.composed.db.close();

    // 配对（剩余盲区）：「动作 ＋ 截图」完全相同地连做三批，照旧判打转。
    const d5 = new FakeGuiDriver();
    const S = (k: number): ScriptedTurn =>
      turn(act(`s${k}`, { action: "scroll", x: 500, y: 500, direction: "down", amount: 3 }), shot(`ss${k}`));
    const r5 = rig({ ws: ws.root, driver: d5, script: [turn(shot("s0")), S(1), S(2), S(3), S(4), END] });
    const out5 = await run(r5);
    r5.composed.db.close();
    const notice = r5.composed.notices.map((n) => `${n.text}\n${n.detail ?? ""}`).join("\n");

    fact("连截四次", `${d3.captures.length} 次，结束：${out3.result.terminal.reason}`);
    fact("点 A / 截图 交替", `点了 ${d4.performed.length} 次，结束：${out4.result.terminal.reason}`);
    fact("同一处「滚动＋截图」连做", `滚了 ${d5.performed.length} 次，结束：${out5.result.terminal.reason}`);
    verdict(
      out3.result.terminal.reason === "COMPLETED" && d3.captures.length === 4 &&
        out4.result.terminal.reason === "COMPLETED" && d4.performed.length === 3,
      "只截图的批不按入参判打转，而且观察会重置计数（点之前重新看过就不算原地打转）。注入：observeBatch 去掉豁免 → 红",
    );
    verdict(
      out5.result.terminal.reason === "NO_PROGRESS" && d5.performed.length === 3 &&
        notice.includes("NO_PROGRESS") && notice.includes("同一处连滚三次"),
      "配对：「动作 ＋ 截图」完全相同地连做三批仍判打转（豁免只覆盖纯观察的批）—— 剩余盲区在启动提示里如实说了",
    );
  }

  // ════════════════════════════════════════════════════ O. 显式放开浏览器（ADR-0015）
  section("O. --computer-allow-browsers：只解除「浏览器」一类、仍要进白名单、Web 入口不接受");
  {
    let noOptIn = "";
    try {
      parseComputerFlags("control", "com.google.Chrome");
    } catch (err) {
      noOptIn = (err as Error).message;
    }
    const withOptIn = parseComputerFlags("control", "com.google.Chrome", true);
    const stillDenied: string[] = [];
    for (const app of ["com.apple.Terminal", "Code", "1Password", "com.anthropic.claudefordesktop"]) {
      try {
        parseComputerFlags("control", app, true);
      } catch {
        stillDenied.push(app);
      }
    }
    fact("不放开时写 Chrome", noOptIn.split("。")[0] ?? "（没拒绝）");
    fact("放开之后仍被拒的", stillDenied.join("、"));
    verdict(
      noOptIn.includes("--computer-allow-browsers") && withOptIn.allowBrowsers && stillDenied.length === 4,
      "不放开时 Chrome 启动即被拒（并指出出路）；放开之后可以写进白名单，而终端 / IDE / 密码管理器 / Agent 宿主照旧拒绝。" +
        "注入：optIn 判断扩到所有类别 → 红",
    );

    // 执行期：放开 ＋ 在白名单里 → 照常执行，且助手那一层收到了 allowBrowsers
    const d1 = new FakeGuiDriver();
    d1.windows = [windowOf(CHROME, 66, FULL, "哔哩哔哩")];
    d1.frontmost = refOf(CHROME);
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const r1 = rig({
      ws: ws.root,
      driver: d1,
      apps: "com.google.Chrome",
      allowBrowsers: true,
      script: [turn(shot("o0")), turn(act("o1", { action: "left_click", x: 500, y: 100 }), act("o2", { action: "type", text: "agent开发面试" })), END],
    });
    const out1 = await run(r1);
    r1.composed.db.close();
    // 执行期配对：放开了，但 Chrome 不在白名单里 → 照样拒（放开 ≠ 加白名单）
    const d2 = new FakeGuiDriver();
    d2.windows = [windowOf(CHROME, 66, FULL, "哔哩哔哩"), windowOf(TEXTEDIT, 11, FULL)];
    const r2 = rig({
      ws: ws.root,
      driver: d2,
      apps: "TextEdit",
      allowBrowsers: true,
      script: [turn(shot("p0")), turn(act("p1", { action: "left_click", x: 500, y: 100 })), END],
    });
    const out2 = await run(r2);
    r2.composed.db.close();
    fact("放开 ＋ 在白名单：点击 / 输入", `${codeOf(out1.results.get("o1"))} / ${codeOf(out1.results.get("o2"))}，助手收到 allowBrowsers=${d1.guards.map((g) => g.allowBrowsers).join(",")}`);
    fact("放开但不在白名单：点击", codeOf(out2.results.get("p1")));
    verdict(
      codeOf(out1.results.get("o1")) === "OK" && codeOf(out1.results.get("o2")) === "OK" &&
        d1.guards.length === 2 && d1.guards.every((g) => g.allowBrowsers === true) &&
        codeOf(out2.results.get("p1")) === "TOOL_GUI_TARGET_NOT_ALLOWED" && d2.performed.length === 0,
      "放开且在白名单的浏览器照常点击、输入，第二道检查也收到了放开标记；放开但不在白名单的照样拒绝（放开 ≠ 加白名单）。" +
        "注入：handler 不传 allowBrowsers 给驱动 → 红",
    );

    // Web 入口不接受这个开关（那里的审批卡片就在浏览器里）
    const svc = spawnSync(
      resolve(REPO_ROOT, "node_modules/.bin/tsx"),
      [resolve(REPO_ROOT, "apps/workagent-service/src/main.ts"), "--computer-allow-browsers"],
      { encoding: "utf8", timeout: 60_000 },
    );
    const svcOut = `${svc.stdout}${svc.stderr}`;
    fact("Web 入口带上这个开关", svcOut.trim().split("\n").pop()?.slice(0, 80) ?? "");
    verdict(
      svcOut.includes("Web 入口不接受 --computer-allow-browsers") && !svcOut.includes("白盒界面已启动"),
      "Web 入口拒绝 --computer-allow-browsers 且服务没有起来 —— 在那里放开浏览器，等于让模型点得到自己的「批准」按钮",
    );
  }

  // ════════════════════════════════════════════════════ P. 复核依据（CU-R03）
  section("P. 同批截图不替换复核依据（2026-10-03 评审 CU-R03）：动作只认模型已经看过的那张图");
  console.log(
    "   [screenshot, click] 里点击的坐标是照着**上一批**的图定的 —— 新截的这张模型还没看到。\n" +
      "   此前截图一完成就覆盖依据，点击拿新图去和此刻的屏幕比，等于自己和自己比：复核整个失效。",
  );
  {
    const mk = (script: ScriptedTurn[]): { driver: FakeGuiDriver; r: Rig } => {
      const driver = new FakeGuiDriver();
      const ws = tempWorkspace();
      cleanups.push(ws.cleanup);
      const r = rig({
        ws: ws.root,
        driver,
        // 模型看过 TextEdit（窗口 11）之后，屏幕换成了同在白名单里的 Calculator（窗口 22）。
        beforeTurn: (t) => {
          if (t === 1) driver.windows = [windowOf(CALCULATOR, 22, FULL)];
        },
        script,
      });
      return { driver, r };
    };
    const click = (id: string): ScriptedTurn["toolCalls"][number] => act(id, { action: "left_click", x: 100, y: 100 });
    const same = mk([turn(shot("ob0")), turn(shot("ob1s"), click("ob1")), END]);
    const outSame = await run(same.r);
    same.r.composed.db.close();
    const next = mk([turn(shot("ob0")), turn(shot("ob1s")), turn(click("ob1")), END]);
    const outNext = await run(next.r);
    next.r.composed.db.close();
    const first = mk([turn(shot("ob2s"), click("ob2")), END]);
    const outFirst = await run(first.r);
    first.r.composed.db.close();
    const targetApp = (r: { content: string } | undefined): string => {
      try {
        return String((JSON.parse(r?.content ?? "{}") as { target?: { app?: string } }).target?.app ?? "");
      } catch {
        return "";
      }
    };
    fact("同批 [截图, 点击]", `${codeOf(outSame.results.get("ob1"))}，投递 ${same.driver.performed.length} 次`);
    fact("先截图、下一批再点", `${codeOf(outNext.results.get("ob1"))} → ${targetApp(outNext.results.get("ob1"))}，投递 ${next.driver.performed.length} 次`);
    fact("第一批就 [截图, 点击]", `${codeOf(outFirst.results.get("ob2"))}  ${messageOf(outFirst.results.get("ob2")).slice(0, 40)}`);
    verdict(
      codeOf(outSame.results.get("ob1")) === "TOOL_GUI_STATE_CHANGED" && same.driver.performed.length === 0,
      "同批 [截图, 点击]：点击按模型看过的那张（TextEdit）复核，屏幕已换成 Calculator → 拒绝、零投递。" +
        "注入：截图时直接覆盖依据（旧写法）→ 红（点击通过并点在 Calculator 上）",
    );
    verdict(
      codeOf(outNext.results.get("ob1")) === "OK" && next.driver.performed.length === 1 &&
        targetApp(outNext.results.get("ob1")) === "Calculator",
      "配对：模型看过新截图之后（下一批）再点 → 照常执行，点在它看到的 Calculator 上 —— 新截图在下一批升为依据",
    );
    verdict(
      codeOf(outFirst.results.get("ob2")) === "TOOL_GUI_NO_OBSERVATION" &&
        messageOf(outFirst.results.get("ob2")).includes("还没有看到") && first.driver.performed.length === 0,
      "第一批就 [截图, 点击]：那张图模型还没看到 → 拒绝，并说清是「还没看到」而不是「没截过」",
    );
  }

  // ════════════════════════════════════════════════════ Q. 审批绑定目标（CU-R01）
  section("Q. 审批绑定目标（2026-10-03 评审 CU-R01）：人批准的是哪个应用，就只发给哪个应用");
  console.log(
    "   人工审批时焦点必然先给审批界面（终端里敲 y、浏览器里点「批准」），而终端与浏览器都在硬拒绝名单上 ——\n" +
      "   此前 DEFAULT / CONFIRM 档下每一次打字都必然被拒；反过来，焦点若换成了另一个白名单应用，字就打进了它。\n" +
      "   走生产的 PendingHub.approvalDecider（Web 卡片的来源）。",
  );
  {
    /** 人批准时把焦点给了 `stealTo`（审批界面在哪就是哪）。 */
    const approvalRig = (
      stealTo: "terminal" | "calculator",
      script: ScriptedTurn[],
      /** false = 激活请求发出了、应用却没有到前台（慢启动、被别的窗口抢回去 —— CU-R09 的真实情形）。 */
      activationTakes = true,
    ): { driver: FakeGuiDriver; r: Rig; aborter: AbortController } => {
      const driver = new FakeGuiDriver();
      // 截图时的屏幕：TextEdit 在前、整屏；Calculator 在左上角一小块（也在白名单里）。
      const asShot = (): void => {
        driver.frontmost = refOf(TEXTEDIT);
        driver.windows = [windowOf(TEXTEDIT, 11, FULL), windowOf(CALCULATOR, 22, [0, 0, 400, 400])];
      };
      asShot();
      // 世界的反应：激活一个应用 → 它成为前台、它的窗口排到最前（真 macOS 上同样如此）。
      driver.onPerform = (a) => {
        if (a.kind !== "activate" || !activationTakes) return;
        const app = [TEXTEDIT, CALCULATOR, TERMINAL].find((x) => x.bundleId === a.bundleId);
        if (!app) return;
        driver.frontmost = refOf(app);
        driver.windows = [
          ...driver.windows.filter((w) => w.bundleId === a.bundleId),
          ...driver.windows.filter((w) => w.bundleId !== a.bundleId),
        ];
      };
      const ws = tempWorkspace();
      cleanups.push(ws.cleanup);
      const hub = new PendingHub();
      const aborter = new AbortController();
      let composedRef: Composed | undefined;
      const decider = hub.approvalDecider(
        (a) => autoGrantVerdict(a, ws.root),
        () => "DEFAULT" as const,
        () => false,
        () => aborter.signal,
        (a) => composedRef!.computer!.describeForApproval(a),
      );
      const seen = new Set<string>();
      hub.onChange(() => {
        for (const p of hub.list()) {
          if (p.kind !== "APPROVAL" || seen.has(p.pendingId)) continue;
          seen.add(p.pendingId);
          setImmediate(() => {
            if (stealTo === "terminal") {
              // 人去终端（或浏览器）里批准：它成为前台，并且整屏盖住了 TextEdit。
              driver.frontmost = refOf(TERMINAL);
              driver.windows = [windowOf(TERMINAL, 44, FULL), ...driver.windows.filter((w) => w.windowId !== 44)];
            } else {
              // 审批之后焦点被另一个**白名单**应用拿走了（窗口也盖住了目标处）。
              driver.frontmost = refOf(CALCULATOR);
              driver.windows = [windowOf(CALCULATOR, 22, FULL), ...driver.windows.filter((w) => w.windowId !== 22)];
            }
            hub.answer(p.pendingId, { kind: "APPROVAL", approved: true });
          });
        }
      });
      // 每一轮开始时屏幕回到截图时的样子：每个动作的审批描述看到的都是 TextEdit，
      // 「焦点被拿走」只发生在人批准的那一刻 —— 否则上一轮的残留会让审批描述先看到 Calculator，
      // 点击那一半就测不到「被白名单应用拿走时不切回」。
      const r = rig({ ws: ws.root, driver, approvalDecider: decider, script, beforeTurn: asShot });
      composedRef = r.composed;
      return { driver, r, aborter };
    };

    const q1 = approvalRig("terminal", [
      turn(shot("ap0")),
      turn(act("ap1", { action: "type", text: "你好" })),
      turn(act("ap2", { action: "left_click", x: 800, y: 800 })),
      turn(act("ap3", { action: "key", text: "cmd+s" })),
      END,
    ]);
    const out1 = await run(q1.r);
    q1.r.composed.db.close();
    q1.aborter.abort();
    const trail = (d: FakeGuiDriver): string =>
      d.performed
        .map((a) => (a.kind === "activate" ? `activate(${a.bundleId})` : "pid" in a ? `${a.kind}(pid ${a.pid})` : a.kind))
        .join(" → ");
    fact("焦点被审批界面（终端）拿走", ["ap1", "ap2", "ap3"].map((id) => codeOf(out1.results.get(id))).join(" / "));
    fact("投递记录", trail(q1.driver));
    const p1 = q1.driver.performed;
    verdict(
      ["ap1", "ap2", "ap3"].every((id) => codeOf(out1.results.get(id)) === "OK") &&
        p1.length === 6 &&
        p1.filter((a) => a.kind === "activate").every((a) => a.kind === "activate" && a.bundleId === TEXTEDIT.bundleId) &&
        p1[1]?.kind === "type" && p1[1].pid === TEXTEDIT.pid &&
        p1[3]?.kind === "click" &&
        p1[5]?.kind === "key" && p1[5].pid === TEXTEDIT.pid &&
        out1.results.get("ap1")!.content.includes("focusRestored"),
      "人在终端里批准之后，打字、点击、按键都先把人批准的 TextEdit 切回前台、复核通过再执行（点击那一下终端整屏盖着目标）。" +
        "注入：describeForApproval 不记目标 → 红（打字被判前台是终端、点击被判窗口变了）",
    );

    const q2 = approvalRig("calculator", [
      turn(shot("aq0")),
      turn(act("aq1", { action: "type", text: "发给 TextEdit 的字" })),
      turn(act("aq2", { action: "left_click", x: 800, y: 800 })),
      END,
    ]);
    const out2 = await run(q2.r);
    q2.r.composed.db.close();
    q2.aborter.abort();
    fact("焦点被另一个白名单应用（Calculator）拿走", `${codeOf(out2.results.get("aq1"))} / ${codeOf(out2.results.get("aq2"))}，投递 ${q2.driver.performed.length} 次`);
    verdict(
      codeOf(out2.results.get("aq1")) === "TOOL_GUI_FOCUS_CHANGED" &&
        codeOf(out2.results.get("aq2")) === "TOOL_GUI_STATE_CHANGED" &&
        q2.driver.performed.length === 0,
      "配对：审批卡写着 TextEdit，执行时前台换成了 Calculator → 不改发、不切焦点、零投递（评审复现的那条：字原本会打进 Calculator）。" +
        "注入：切回焦点不区分「白名单应用拿走」→ 红",
    );

    // 配对：切回的请求发出了、应用却没到前台 —— 切换本身不替复核作保，照旧什么都不投。
    const q4 = approvalRig(
      "terminal",
      [turn(shot("as0")), turn(act("as1", { action: "type", text: "x" })), turn(act("as2", { action: "left_click", x: 800, y: 800 })), END],
      false,
    );
    const out4 = await run(q4.r);
    q4.r.composed.db.close();
    q4.aborter.abort();
    fact("切回没生效", `${codeOf(out4.results.get("as1"))} / ${codeOf(out4.results.get("as2"))}，投递 ${trail(q4.driver)}`);
    verdict(
      codeOf(out4.results.get("as1")) === "TOOL_GUI_FOCUS_CHANGED" &&
        codeOf(out4.results.get("as2")) === "TOOL_GUI_STATE_CHANGED" &&
        q4.driver.performed.every((a) => a.kind === "activate"),
      "配对：切回的请求发出了、TextEdit 却没到前台 → 打字与点击都不投递（只有那两次激活请求）。" +
        "注入：切回之后不再核对前台 → 红",
    );

    // 配对：没有人看过审批描述（脚本化 decider，等同 AUTO）时不切焦点 —— 切回只为「审批界面拿走的焦点」。
    const d3 = new FakeGuiDriver();
    const ws3 = tempWorkspace();
    cleanups.push(ws3.cleanup);
    const r3 = rig({
      ws: ws3.root,
      driver: d3,
      beforeTurn: (t) => {
        if (t === 1) d3.frontmost = refOf(TERMINAL);
      },
      script: [turn(shot("ar0")), turn(act("ar1", { action: "type", text: "x" })), END],
    });
    const out3 = await run(r3);
    r3.composed.db.close();
    fact("没有审批描述、前台是终端", `${codeOf(out3.results.get("ar1"))}，投递 ${d3.performed.length} 次`);
    verdict(
      codeOf(out3.results.get("ar1")) === "TOOL_GUI_TARGET_DENIED" && d3.performed.length === 0,
      "配对：没有人看过审批描述时不会自行切换应用 —— 「切回」只还审批界面拿走的焦点，不是一个通用的自动激活",
    );
  }

  // ════════════════════════════════════════════════════ R. 取消之后不投递（CU-R02）
  section("R. 取消落在执行前复核期间：尚未投递的动作不再投递（2026-10-03 评审 CU-R02）");
  {
    const cancelDuringProbe = async (call: ScriptedTurn["toolCalls"][number]): Promise<{ driver: FakeGuiDriver; attempt?: RunEvent; terminal: string }> => {
      const driver = new FakeGuiDriver();
      const ws = tempWorkspace();
      cleanups.push(ws.cleanup);
      const r = rig({ ws: ws.root, driver, script: [turn(shot("cx0")), turn(call), END] });
      let runId = "";
      let probes = 0;
      driver.onProbe = () => {
        probes += 1;
        // 复核要等驱动比对画面（真助手上 0.1–0.3 秒）—— 取消请求恰好落在这段等待里。
        r.composed.runtime.cancel(runId as RunId, "复核途中取消");
      };
      const events: RunEvent[] = [];
      const { result } = await drain(r.composed.runtime.start(r.composed.makeRunSpec("取消夹具")), (e) => {
        if (!runId) runId = String(e.runId);
        events.push(e);
      });
      r.composed.db.close();
      const attempt = events.filter((e) => e.type === "AttemptCompleted").pop();
      return { driver, ...(attempt ? { attempt } : {}), terminal: `${result.terminal.reason}（复核 ${probes} 次）` };
    };
    const c1 = await cancelDuringProbe(act("cx1", { action: "left_click", x: 500, y: 250 }));
    const c2 = await cancelDuringProbe(act("cx2", { action: "type", text: "取消之后不该出现的字" }));
    const side = (e?: RunEvent): string => (e?.type === "AttemptCompleted" ? `${e.payload.status} / ${e.payload.sideEffectState}` : "（无）");
    fact("点击：复核途中取消", `投递 ${c1.driver.performed.length} 次，attempt ${side(c1.attempt)}，${c1.terminal}`);
    fact("打字：复核途中取消", `投递 ${c2.driver.performed.length} 次，attempt ${side(c2.attempt)}，${c2.terminal}`);
    verdict(
      c1.driver.performed.length === 0 && c2.driver.performed.length === 0 &&
        side(c1.attempt) === "FAILED / NOT_STARTED" && side(c2.attempt) === "FAILED / NOT_STARTED",
      "取消请求落在复核等待里：点击与打字都没有投递，事实表记「没开始」—— 不是「已执行」。" +
        "注入：perform 前不看 signal → 红（评审复现：SUCCEEDED / APPLIED）",
    );
    // 配对就是 F 段的 f1 与 I 段的 i5：同样的复核、没有取消时照常投递。
  }

  // ════════════════════════════════════════════════════ S. 拖拽终点 ＋ 长文本审批
  section("S. 拖拽终点同样比对画面（CU-R05）；长文本审批给出看得见每个字符的全文（CU-R10）");
  {
    // 起点（x=200/1000）处画面没变；终点（x=900/1000）处同一个窗口里的画面变了（列表重排、滚动）。
    const mkDrag = (endDiff: number): { driver: FakeGuiDriver; r: Rig } => {
      const driver = new FakeGuiDriver();
      driver.regionDiffAt = (x) => (x > 768 ? endDiff : 0);
      const ws = tempWorkspace();
      cleanups.push(ws.cleanup);
      const r = rig({
        ws: ws.root,
        driver,
        script: [turn(shot("dg0")), turn(act("dg1", { action: "drag", x: 200, y: 250, to_x: 900, to_y: 250 })), END],
      });
      return { driver, r };
    };
    const changed = mkDrag(200);
    const outChanged = await run(changed.r);
    changed.r.composed.db.close();
    const same = mkDrag(0);
    const outSame = await run(same.r);
    same.r.composed.db.close();
    fact("终点画面变了", `${codeOf(outChanged.results.get("dg1"))}  ${messageOf(outChanged.results.get("dg1")).slice(0, 50)}`);
    fact("终点画面没变", `${codeOf(outSame.results.get("dg1"))}，投递 ${same.driver.performed.map((a) => a.kind).join(",")}`);
    verdict(
      codeOf(outChanged.results.get("dg1")) === "TOOL_GUI_STATE_CHANGED" &&
        messageOf(outChanged.results.get("dg1")).includes("拖拽终点") &&
        messageOf(outChanged.results.get("dg1")).includes("灰度差") &&
        changed.driver.performed.length === 0,
      "起点没变、终点处画面变了（同一个窗口）→ 拒绝、零投递。注入：终点不比画面（旧写法）→ 红",
    );
    verdict(
      codeOf(outSame.results.get("dg1")) === "OK" && same.driver.performed.length === 1 && same.driver.performed[0]?.kind === "drag",
      "配对：两端画面都没变 → 照常拖拽（一个只会拒绝的终点检查也能让上一条绿）",
    );

    // ── 长文本审批：卡片上是全文，且看得见换行与不可见字符
    const longText = "开头" + "字".repeat(590) + "\n结尾\u202e";
    const driver = new FakeGuiDriver();
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const hub = new PendingHub();
    const aborter = new AbortController();
    let composedRef: Composed | undefined;
    const decider = hub.approvalDecider(
      (a) => autoGrantVerdict(a, ws.root),
      () => "DEFAULT" as const,
      () => false,
      () => aborter.signal,
      (a) => composedRef!.computer!.describeForApproval(a),
    );
    const cards: UiPending[] = [];
    hub.onChange(() => {
      for (const p of hub.list()) {
        if (p.kind !== "APPROVAL" || cards.some((c) => c.pendingId === p.pendingId)) continue;
        cards.push(p);
        setImmediate(() => hub.answer(p.pendingId, { kind: "APPROVAL", approved: true }));
      }
    });
    const r = rig({
      ws: ws.root,
      driver,
      approvalDecider: decider,
      script: [turn(shot("lt0")), turn(act("lt1", { action: "type", text: longText })), END],
    });
    composedRef = r.composed;
    const out = await run(r);
    r.composed.db.close();
    aborter.abort();
    const line = cards[0]?.approval?.gui?.details.find((l) => l.startsWith("将输入")) ?? "";
    const typed = driver.performed.find((a) => a.kind === "type");
    fact("卡片上的输入行", `${line.length} 字符，结尾：${line.slice(-16)}`);
    verdict(
      codeOf(out.results.get("lt1")) === "OK" && typed?.kind === "type" && typed.text === longText &&
        line.includes(JSON.stringify(longText).slice(0, -8)) && line.includes("\\n结尾\\u202e"),
      "审批卡给出 600 字的全文（JSON 字符串形态）：换行写成 \\n、RLO 写成 \\u202e —— 展示层剥掉的是字符本身，" +
        "转义之后人仍然看得见它；批准之后打出去的正是这段原文。注入：改回只展示前 200 字 → 红",
    );
  }

  // ════════════════════════════════════════════════════ T. resume 指纹 ＋ 助手重连
  section("T. vision 进端点行为指纹（CU-R06）；助手重连不混用上一条连接的残留字节（CU-R07）");
  {
    const ws = tempWorkspace();
    cleanups.push(ws.cleanup);
    const dbPath = join(ws.root, "runs.db");
    const startAndCancel = async (): Promise<string> => {
      const c = rig({ ws: ws.root, driver: new FakeGuiDriver(), script: [END], dbPath, apps: "TextEdit" });
      const gen = c.composed.runtime.start(c.composed.makeRunSpec("用得到屏幕的任务"));
      let runId = "";
      let step = await gen.next();
      while (!step.done) {
        if (!runId) {
          runId = String(step.value.runId);
          c.composed.runtime.cancel(runId as RunId, "模拟中断");
        }
        step = await gen.next();
      }
      c.composed.db.close();
      return runId;
    };
    const resumeWith = async (runId: string, profile: EndpointCapabilityProfile): Promise<string> => {
      const c = rig({ ws: ws.root, driver: new FakeGuiDriver(), script: [END], dbPath, apps: "TextEdit", profile });
      try {
        const { result } = await drain(c.composed.runtime.resume(runId as RunId));
        return `resumed:${result.terminal.reason}`;
      } catch (err) {
        return `refused:${String((err as Error).message)}`;
      } finally {
        c.composed.db.close();
      }
    };
    const v = QWEN.vision!;
    const formulaChanged: EndpointCapabilityProfile = {
      ...QWEN,
      vision: { ...v, imageTokens: { ...v.imageTokens, patchPx: v.imageTokens.patchPx + 8 } },
    };
    const countingChanged: EndpointCapabilityProfile = { ...QWEN, vision: { ...v, countTokensIncludesImages: !v.countTokensIncludesImages } };
    const onlyDate: EndpointCapabilityProfile = { ...QWEN, observedAt: QWEN.observedAt + 86_400_000 };
    const a = await resumeWith(await startAndCancel(), formulaChanged);
    const b = await resumeWith(await startAndCancel(), countingChanged);
    const c = await resumeWith(await startAndCancel(), onlyDate);
    fact("只改图像 token 公式", a.slice(0, 60));
    fact("只改 count_tokens 是否计图", b.slice(0, 60));
    fact("只改观测日期", c);
    verdict(
      a.startsWith("refused:") && a.includes("vision") && b.startsWith("refused:") && c.startsWith("resumed:"),
      "冻结时与当前的 vision 不同（图像 token 公式 / count_tokens 计不计图）→ 拒绝 resume；只改观测日期照常恢复（成对）。" +
        "注入：指纹里去掉 vision → 红",
    );
  }
  {
    // 一个 node 写的假助手，挂在 HelperDriver 的启动注入点上：第一代连接回半条截图响应就断开，
    // 第二代连接正常应答。真 socket、真解析器、真重连 —— 不截真屏、不弹授权。
    const dir = mkdtempSync(join(tmpdir(), "workagent-fake-helper-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const servers: Server[] = [];
    let generation = 0;
    const driver = new HelperDriver({
      appPath: dir,
      requestTimeoutMs: 3_000,
      launch: async (sock) => {
        generation += 1;
        const g = generation;
        const server = createServer((conn) => {
          let buf = "";
          conn.setEncoding("utf8");
          conn.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const req = JSON.parse(buf.slice(0, nl)) as { id: number; op: string };
              buf = buf.slice(nl + 1);
              if (req.op === "quit") {
                conn.end(JSON.stringify({ id: req.id, ok: true, result: {} }) + "\n");
                return;
              }
              if (g === 1) {
                // 传一张大截图传到一半，助手退出了。
                conn.end(`{"id":${req.id},"ok":true,"result":{"png":"${"A".repeat(64 * 1024)}`);
                return;
              }
              conn.write(JSON.stringify({ id: req.id, ok: true, result: { screenRecording: true, accessibility: true } }) + "\n");
            }
          });
        });
        await new Promise<void>((res) => server.listen(sock, () => res()));
        servers.push(server);
      },
    });
    let first = "";
    try {
      await driver.permissions();
      first = "（第一代居然应答了）";
    } catch (err) {
      first = String((err as Error).message);
    }
    const t0 = Date.now();
    let second = "";
    try {
      second = JSON.stringify(await driver.permissions());
    } catch (err) {
      second = String((err as Error).message);
    }
    const ms = Date.now() - t0;
    await driver.close();
    for (const sv of servers) sv.close();
    fact("第一代连接（传到一半断开）", first);
    fact("重连后的第一个请求", `${second}（${ms} ms）`);
    verdict(
      first.includes("断开") && second.includes("screenRecording") && ms < 2_000 && generation === 2,
      "助手传截图传到一半退出之后，重连的第一个请求马上拿到应答 —— 上一条连接的半条 JSON 没有和它拼在一起。" +
        "注入：缓冲改回实例字段（跨连接共用）→ 红（那个请求白等到超时）",
    );
  }

  console.log(
    "\n   ⚠️ 没有机械判据、登记在此：\n" +
      "     · CLI 审批提示的 GUI 分支（打印到终端，与 Web 卡片同一个 describeForApproval 给内容）；\n" +
      "     · Swift 助手本身（截图、窗口表、事件投递、看门狗）—— 用 npm run computer:doctor 人工核对，\n" +
      "       真屏截图需要用户显式加 --screenshot，授权提示需要显式加 --request；\n" +
      "       其中 2026-10-03 评审的两条修在助手里：截完再列一次窗口、有新的白名单外窗口就重截（CU-R04，\n" +
      "       剩余盲区：两次列表之间出现又消失的窗口）；激活等待超时抛错而不是报成功（CU-R09）；\n" +
      "     · CLI 入口里助手构建排在一切资源获取之前（CU-R08）—— 判据要真的跑一次失败的 swiftc，\n" +
      "       而那条路径上一次成功的构建会让用户的系统授权作废；\n" +
      "     · 真实端点上的 GUI 任务（要花钱、会真的操作屏幕）。",
  );
}

void runVerify(main, () => {
  for (const c of cleanups.splice(0)) c();
});
