/**
 * 验收项 1：verify:endpoint-profile
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：端点差异能否被完全挡在主循环之外？
 *
 * 做法：用 fake-endpoint-profile 构造一个「校验配对 + 推理块需占位」的
 * 虚拟端点 —— 四个真实端点里一个都不是这个组合。
 *
 * 期望：Runtime 行为正确改变，而**主循环代码一个字不动**。
 *
 * 挂了意味着：端点能力声明没有真正落地，换端点仍需改主循环，D-07 白拍。
 * ══════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  CollectingTraceSink,
  loadProfileFromFile,
  parseProfile,
  type ContextItem,
} from "@workagent/harness-runtime";
import {
  createAnthropicProtocol,
  emptyUsage,
  mergeUsage,
  readUsagePartial,
} from "@workagent/shape-anthropic-messages";
import { fakeProfile, strictFakeProfile } from "@workagent/testkit";
import {
  DEFAULT_TOOLS,
  compose,
  REPO_ROOT,
  readEndpointConfig,
} from "../compose.js";
import { ScriptedModelPort, banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

const LOOP_FILES = [
  "packages/harness-runtime/src/loop/run-loop.ts",
  "packages/harness-runtime/src/loop/interrupt/index.ts",
  "packages/harness-runtime/src/context/compile.ts",
  "packages/harness-runtime/src/action/settle-batch.ts",
];

/**
 * `sourceEvidenceRefs` 允许和现有 profile 一样在文件名里使用 `*`，并允许
 * 在源码路径后附 `@YYYY-MM-DD` 表示观测日期。目录本身不做递归 glob；当前
 * 声明的通配符都只覆盖同一个 raw 目录里的多次探针。
 */
function evidenceRefExists(ref: string): boolean {
  const pathRef = ref.replace(/@\d{4}-\d{2}-\d{2}$/, "");
  if (!pathRef.includes("*")) return existsSync(resolve(REPO_ROOT, pathRef));
  const parent = resolve(REPO_ROOT, dirname(pathRef));
  if (!existsSync(parent)) return false;
  const pattern = new RegExp(
    `^${basename(pathRef)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")}$`,
  );
  return readdirSync(parent).some((name) => pattern.test(name));
}

async function main(): Promise<void> {
  banner(
    "验收项 1：端点能力声明是否真正落地",
    "换一个行为完全不同的端点声明，Runtime 行为变而主循环代码不变？",
  );

  section("A. 两份端点声明的差异");
  const real = loadProfileFromFile(
    resolve(REPO_ROOT, "adapters/endpoint-profiles/bailian-anthropic.json"),
  );
  const deepseek = loadProfileFromFile(
    resolve(REPO_ROOT, "adapters/endpoint-profiles/deepseek-anthropic.json"),
  );
  const fake = strictFakeProfile();

  fact("真实端点 modelId", real.modelId);
  fact("  validatesToolResultPairing", real.protocol.validatesToolResultPairing);
  fact("  reasoningBlockRule", real.context.reasoningBlockRule);
  fact("虚拟端点 modelId", fake.modelId);
  fact("  validatesToolResultPairing", fake.protocol.validatesToolResultPairing);
  fact("  reasoningBlockRule", fake.context.reasoningBlockRule);

  section("A2. .env modelId 选择同模型的独立声明");
  const originalModel = process.env["dashscope_model"];
  let qwen38Config: ReturnType<typeof readEndpointConfig>;
  let qwen37Config: ReturnType<typeof readEndpointConfig>;
  try {
    process.env["dashscope_model"] = "qwen3.8-flash";
    qwen38Config = readEndpointConfig(false, "bailian");
    process.env["dashscope_model"] = "qwen3.7-plus";
    qwen37Config = readEndpointConfig(false, "bailian");
  } finally {
    if (originalModel === undefined) delete process.env["dashscope_model"];
    else process.env["dashscope_model"] = originalModel;
  }
  const qwen38 = loadProfileFromFile(qwen38Config.profilePath);
  const qwen37 = loadProfileFromFile(qwen37Config.profilePath);
  fact("qwen3.8-flash 声明", `${basename(qwen38Config.profilePath)} / ${qwen38.id}`);
  fact("  modelId / confidence", `${qwen38.modelId} / ${qwen38.confidence}`);
  fact("qwen3.7-plus 声明", `${basename(qwen37Config.profilePath)} / ${qwen37.id}`);
  verdict(
    qwen38Config.modelId === "qwen3.8-flash" &&
      qwen38.modelId === qwen38Config.modelId &&
      qwen38.confidence === "ASSUMED" &&
      qwen38.id !== qwen37.id &&
      qwen37Config.modelId === "qwen3.7-plus" &&
      qwen37.modelId === qwen37Config.modelId,
    "配置 qwen3.8-flash 会选中独立的 ASSUMED profile；不会覆盖或冒充 qwen3.7-plus 的 PROBED 声明",
  );

  // ── B. protocolRoleOf 的判定必须随声明改变
  section("B. 同一个推理块，两个端点下的协议角色");

  /**
   * 【定】字段要与 `ContextItem` 当前的形状一致。
   *
   * 这里此前多带一个 `redactionApplied: true` —— 那个字段已于 2026-08-31 删除，
   * 而 `as unknown as ContextItem` 这层断言让编译器完全看不见它。
   * 夹具比被测类型多一个字段是无害的，但它是一条**读起来像事实的假话**：
   * 下一个人会以为 `ContextItem` 上还有那个字段。
   */
  const reasoningItem = {
    id: "ci_x",
    kind: "MODEL_REASONING",
    source: { kind: "RUN" },
    trust: "MODEL_GENERATED",
    protocolRole: "ORDINARY",
    content: { type: "reasoning", text: "我先看看目录", signature: "" },
    contentHash: "x",
    estimatedTokens: 10,
    createdAt: 0,
  } as unknown as ContextItem;

  const mk = (p: typeof real) =>
    createAnthropicProtocol({
      profile: p,
      tools: DEFAULT_TOOLS,
      systemPrompt: "test",
      maxOutputTokens: 1024,
    });

  const roleReal = mk(real).protocolRoleOf(reasoningItem);
  const roleFake = mk(fake).protocolRoleOf(reasoningItem);

  fact("真实端点判定", roleReal);
  fact("虚拟端点判定", roleFake);
  verdict(
    roleReal === "ORDINARY" && roleFake === "PLACEHOLDER_REQUIRED",
    `协议角色随端点声明改变：${roleReal} → ${roleFake}`,
  );

  section("B2. usageFieldMap 的键真的接到归一化 usage 字段");
  let unknownUsageKeyRejected = false;
  try {
    parseProfile({
      ...deepseek,
      tokens: { ...deepseek.tokens, usageFieldMap: { input: "input_tokens" } },
    } as unknown as Record<string, unknown>);
  } catch {
    unknownUsageKeyRejected = true;
  }
  let fractionalLimitRejected = false;
  try {
    parseProfile({
      ...deepseek,
      limits: { quotaBeforeContextLimit: false, maxContextTokens: 1.5 },
    } as unknown as Record<string, unknown>);
  } catch {
    fractionalLimitRejected = true;
  }
  const deepseekUsage = readUsagePartial(
    { input_tokens: 321, output_tokens: 9 },
    deepseek,
  );
  fact("DeepSeek map", JSON.stringify(deepseek.tokens.usageFieldMap));
  verdict(
    deepseek.tokens.usageFieldMap.inputTokens === "input_tokens" &&
      deepseek.tokens.usageFieldMap.outputTokens === "output_tokens" &&
      deepseekUsage.inputTokens === 321 && deepseekUsage.outputTokens === 9 &&
      unknownUsageKeyRejected && fractionalLimitRejected,
    "DeepSeek 配置使用归一化键且 reader 真正消费；未知 usage 键与非整数 token 上限会在加载时被拒绝",
  );

  const limitedProfile = fakeProfile({
    limits: {
      maxContextTokens: 12_000,
      observedMaxSingleRequestTokens: 10_000,
      quotaBeforeContextLimit: true,
    },
  });
  const limitWs = tempWorkspace();
  const limited = compose({
    dbPath: ":memory:",
    workspaceRoot: limitWs.root,
    approvalDecider: async () => ({ approved: true }),
    trace: new CollectingTraceSink(),
    profileOverride: limitedProfile,
    modelPortOverride: new ScriptedModelPort([{ text: "不调用。", toolCalls: [] }]),
  });
  try {
    const spec = limited.makeRunSpec("端点上限验收");
    const notices = limited.notices.map((notice) => notice.text).join("\n");
    fact("端点限制后的 context hard/soft", `${spec.agentSpec.contextPolicy.hardInputLimitTokens}/${spec.agentSpec.contextPolicy.softInputLimitTokens}`);
    verdict(
      spec.agentSpec.contextPolicy.hardInputLimitTokens === 12_000 &&
        spec.agentSpec.contextPolicy.softInputLimitTokens < 12_000 &&
        notices.includes("10000 tokens") &&
        notices.includes("QUOTA_EXHAUSTED"),
      "EndpointLimits 会收紧冻结的上下文策略，并把观测上限与 quota-before-context 处置公开给入口",
    );
  } finally {
    limited.db.close();
    limitWs.cleanup();
  }

  section("B3. 机器可读证据引用仍然落在仓内真实文件上");
  const evidenceRefs = [
    ...real.sourceEvidenceRefs.map((ref) => ({ profile: "bailian", ref })),
    ...deepseek.sourceEvidenceRefs.map((ref) => ({ profile: "deepseek", ref })),
  ];
  const missingEvidenceRefs = evidenceRefs.filter(({ ref }) => !evidenceRefExists(ref));
  fact("检查的 sourceEvidenceRefs", evidenceRefs.length);
  fact(
    "不存在的引用",
    missingEvidenceRefs.map(({ profile, ref }) => `${profile}:${ref}`).join("；") || "（无）",
  );
  verdict(
    evidenceRefs.length > 0 && missingEvidenceRefs.length === 0,
    missingEvidenceRefs.length === 0
      ? "端点声明只引用仍存在的源码或 raw 探针；删除阶段性汇总不会留下机器断链"
      : "端点声明仍指向已删除的证据文件",
  );

  // ── C. validateFrame 的严格度必须随声明改变
  section("C. 「含 tool_call 但缺推理块」的帧，两个端点下的校验结果");

  const frameWithoutReasoning = {
    items: [
      {
        kind: "MODEL_TOOL_CALL",
        content: { type: "tool_call", toolCallId: "t1", name: "list_dir", input: {} },
        protocolRole: "PROTOCOL_GROUP_MEMBER",
      },
      {
        kind: "TOOL_RESULT",
        content: { type: "tool_result", toolCallId: "t1", content: "ok", isError: false },
        protocolRole: "PROTOCOL_GROUP_MEMBER",
      },
    ],
    reservedOutputTokens: 1024,
  } as never;

  const vReal = mk(real).validateFrame(frameWithoutReasoning);
  const vFake = mk(fake).validateFrame(frameWithoutReasoning);

  fact("真实端点 ok", vReal.ok);
  fact("虚拟端点 ok", vFake.ok);
  if (vFake.violations.length > 0) {
    for (const v of vFake.violations) console.log(`     · ${v}`);
  }
  verdict(
    vReal.ok && !vFake.ok,
    "同一个帧，真实端点放行、虚拟端点拒绝 —— 校验强度来自声明而非代码",
  );

  // ── C2. 前缀缓存断点：system 一个，messages 末尾一个
  section("C2. U-9：cache_control 断点打在哪（前缀缓存的落点）");
  console.log(
    "   【定】断点要打**两个**：tools＋system 这段稳定前缀，以及 **messages 末尾**。\n\n" +
      "   原实现只打前者，理由写在注释里：「会长大的是 messages，而 messages\n" +
      "   每轮都在变，打在那里没有意义」。这条推理在 STRICT_PREFIX 下不成立 ——\n" +
      "   transcript 是**只追加**的，第 N 轮的 messages 是第 N+1 轮的严格前缀。\n" +
      "   「每轮都在变」把「尾部在增长」和「中间被改写」当成了同一件事。\n\n" +
      "   代价是实测的：2026-08-28 办公任务实跑里 `cacheReadInputTokens` 在每个 run 的\n" +
      "   每一次调用上**恒为 3405**（就是 tools＋system 那一段），\n" +
      "   `cacheCreationInputTokens` 恒为 0，而 inputTokens 从 230 涨到 71,334 ——\n" +
      "   对话部分一次都没进过缓存，同一份内容被全价重计了约 5.6 倍。\n",
  );

  const countBreakpoints = (body: unknown): { system: number; messages: number; tail: boolean } => {
    const b = body as {
      system?: unknown;
      messages?: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    const system = Array.isArray(b.system)
      ? (b.system as Array<Record<string, unknown>>).filter((x) => x["cache_control"]).length
      : 0;
    const msgs = b.messages ?? [];
    let messages = 0;
    for (const m of msgs) for (const c of m.content ?? []) if (c["cache_control"]) messages += 1;
    const lastMsg = msgs[msgs.length - 1];
    const lastBlock = lastMsg?.content?.[(lastMsg.content?.length ?? 0) - 1];
    return { system, messages, tail: Boolean(lastBlock?.["cache_control"]) };
  };

  /**
   * 对照组必须显式关掉这个开关。
   * `fakeProfile()` 默认也声明支持显式断点，直接拿它当反例会得到 1/1 ——
   * 那不是「按声明行事」的反证，只是同一个正例跑了两遍。
   */
  const noBreakpoints = {
    ...real,
    context: { ...real.context, supportsExplicitCacheBreakpoints: false },
  };
  const bpReal = countBreakpoints(mk(real).buildRequest(frameWithoutReasoning).body);
  const bpOff = countBreakpoints(mk(noBreakpoints).buildRequest(frameWithoutReasoning).body);

  fact("真实端点：system / messages 上的断点数", `${bpReal.system} / ${bpReal.messages}`);
  fact("真实端点：断点落在 messages 最后一个 block 上", bpReal.tail ? "是" : "否");
  fact("声明不支持显式断点时：断点总数", bpOff.system + bpOff.messages);

  /**
   * 【定】三个方向缺一不可：
   *   · 稳定前缀有断点（system == 1）；
   *   · 增长部分也有断点，且**落在末尾那个 block 上**（tail）——
   *     打在中间等于把后面的内容排除在缓存外；
   *   · 声明不支持时一个都不发 —— 否则「按声明行事」这条就破了。
   */
  const c2Ok =
    bpReal.system === 1 && bpReal.messages === 1 && bpReal.tail && bpOff.system + bpOff.messages === 0;
  verdict(
    c2Ok,
    c2Ok
      ? "断点两个：稳定前缀一个、messages 末尾一个；声明不支持显式断点的端点一个都不发 —— " +
        "会长大的那一半终于也进缓存了"
      : bpReal.messages === 0
        ? "messages 上没有断点 —— 对话部分永远进不了缓存，每轮全价重计"
        : `断点位置不对（system=${bpReal.system} messages=${bpReal.messages} tail=${bpReal.tail}）`,
  );

  // ── D. 端到端：两个端点各跑一遍同样的脚本，主循环代码不得改动
  section("D. 端到端跑三种组合（脚本化模型，不发真实请求）");
  const e2e: Array<{ label: string; terminal: string; errCode?: string }> = [];

  // 第三种组合是关键：虚拟端点 + 模型没给推理块。
  // 真实端点下这完全合法，虚拟端点下主循环必须在发请求前就停下来。
  for (const [label, profile, withReasoning] of [
    ["真实端点声明 ＋ 有推理块", real, true],
    ["虚拟端点声明 ＋ 有推理块", fake, true],
    ["虚拟端点声明 ＋ 无推理块", fake, false],
  ] as const) {
    const ws = tempWorkspace();
    const trace = new CollectingTraceSink();
    try {
      const composed = compose({
        dbPath: ":memory:",
        workspaceRoot: ws.root,
        approvalDecider: async () => ({ approved: true }),
        trace,
        profileOverride: profile,
        modelPortOverride: new ScriptedModelPort([
          {
            ...(withReasoning ? { reasoning: "我先看看目录" } : {}),
            toolCalls: [{ toolCallId: "t1", name: "list_dir", input: { path: "." } }],
          },
          { text: "看完了，目录是空的。", toolCalls: [] },
        ]),
      });

      const gen = composed.runtime.start(composed.makeRunSpec("看看目录"));
      let r = await gen.next();
      while (!r.done) r = await gen.next();

      const frames = trace.byType("ContextFrameCompiled");
      const errs = trace.byType("RuntimeErrorOccurred");
      fact(
        `${label}`,
        `${r.value.terminal.reason} / ${r.value.outcome?.kind ?? "未结算"}，编帧 ${frames.length} 次` +
          (errs.length > 0 ? `，错误 ${errs[0]!.payload.error.code}` : ""),
      );
      e2e.push({ label, terminal: r.value.terminal.reason, errCode: errs[0]?.payload.error.code });
    } catch (err) {
      fact(`${label} → 异常`, (err as Error).message.slice(0, 100));
    } finally {
      ws.cleanup();
    }
  }

  // ── E. token 口径：两段式 usage 的合并
  section("E. 流式 usage 分两段到达时，计费口径是否守得住");
  console.log(
    "   Anthropic 形状把 usage 拆在两处发：message_start 给 input ＋ cache 两项，\n" +
      "   message_delta 通常只给累计 output。把缺失字段补 0 再整体覆盖，\n" +
      "   就会用后一条抹掉前一条 —— §19.3 的计费公式和 maxInputTokens 预算同时归零。",
  );

  const startUsage = readUsagePartial(
    { input_tokens: 192, cache_read_input_tokens: 256, cache_creation_input_tokens: 0, output_tokens: 1 },
    real,
  );
  // 真实的 message_delta：只有 output_tokens 这一个字段。
  const deltaUsage = readUsagePartial({ output_tokens: 65 }, real);
  const mergedUsage = mergeUsage(mergeUsage(emptyUsage(), startUsage, real), deltaUsage, real);

  fact("message_delta 携带的字段", Object.keys(deltaUsage).join(", ") || "（无）");
  fact("合并后 inputTokens", mergedUsage.inputTokens);
  fact("合并后 cacheReadInputTokens", mergedUsage.cacheReadInputTokens ?? 0);
  fact("合并后 outputTokens", mergedUsage.outputTokens);
  fact("合并后 billedInputTokens", mergedUsage.billedInputTokens);
  fact("端点声明的计费公式", real.tokens.billedInputFormula);

  // 实测口径：input 192 ＋ cache_read 256 = 448（p4 探针 0.00% 误差那一行）
  const usageOk =
    mergedUsage.inputTokens === 192 &&
    mergedUsage.outputTokens === 65 &&
    mergedUsage.billedInputTokens === 448;
  verdict(
    usageOk,
    usageOk
      ? "只覆盖实际出现的字段：output 被更新，input / cache 未被抹掉，" +
        "billedInputTokens = 192 ＋ 256 = 448（与 Spike 0 实测一致）"
      : `usage 合并出错：input=${mergedUsage.inputTokens} output=${mergedUsage.outputTokens} ` +
        `billed=${mergedUsage.billedInputTokens}，期望 192 / 65 / 448`,
  );

  // ── F. 判据：主循环代码里有没有端点特定的东西
  /**
   * 这一段原来是「跑前取一次主循环文件的哈希、跑完再取一次，必须一致」。
   *
   * **那条判据物理上不可能失败** —— 同一个进程、同一批文件、中间没有任何写入。
   * 它常年打绿勾，而印出的那句「主循环文件字节未变」是一条自证的证据。
   * 在一个把「证据先于冻结」写进原则十三的项目里，自证的证据比没有证据更坏。
   *
   * 换成有判别力的形式：在运行时直接执行边界 2 与边界 3 ——
   * 主循环四个文件里不得出现端点名，`run-loop.ts` 里不得有非注释的 `profile.`。
   * 这才是「端点差异被挡在主循环之外」这句话的机械判据，而且它会真的翻红。
   */
  section("F. 主循环代码里有没有端点特定的东西");
  const violations: string[] = [];
  for (const f of LOOP_FILES) {
    const hits = scanBoundary(readFileSync(resolve(REPO_ROOT, f), "utf8"), f);
    fact(f.replace("packages/harness-runtime/src/", ""), hits.length === 0 ? "干净" : hits.join("; "));
    violations.push(...hits);
  }
  const fp = fingerprint();
  fact("主循环文件指纹", LOOP_FILES.map((f) => fp[f]).join(" "));

  const e2eDiffers =
    e2e[0]?.terminal === "COMPLETED" &&
    e2e[2]?.terminal === "MODEL_ERROR" &&
    e2e[2]?.errCode === "CONTEXT_PROTOCOL_INVALID";
  verdict(
    e2eDiffers,
    e2eDiffers
      ? "同一份脚本、同一份主循环代码，仅换端点声明 → 一个跑完、一个在发请求前就停下"
      : "端到端行为未随端点声明改变 —— 声明可能没被真正消费",
  );
  const boundaryOk = violations.length === 0 && roleFake === "PLACEHOLDER_REQUIRED" && !vFake.ok;
  verdict(
    boundaryOk,
    boundaryOk
      ? "端点行为是数据不是代码：换声明改变了 Runtime 行为，而主循环代码里既无端点名、也不读端点声明"
      : `边界被破坏：${violations.join("; ") || "端点声明未改变协议角色或校验强度"}`,
  );

  section("这条验收项的意义");
  console.log(
    "   Spike 0 第三轮把第二轮的十条结论重测了一遍，六条只在原端点成立。\n" +
      "   如果那些结论以 if (provider === 'x') 的形式散在代码里，换端点就是一次全局重构。\n" +
      "   本项验证的就是「它们确实以数据形式存在」。",
  );
  console.log();
}

/**
 * 边界 2 与边界 3 的运行时执行。
 *
 * 【定】必须区分注释与真实依赖 —— CLAUDE.md 记着这条：`run-loop.ts` 里
 * `profile.` 有三处命中，全是注释（在解释「为什么这里不能读端点声明」）。
 * 判据要是不认注释，它就会为了自己能通过而逼人删掉那些解释。
 */
function scanBoundary(src: string, file: string): string[] {
  const out: string[] = [];
  const lines = src.split("\n");
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // 边界 2：端点名不进 Runtime 代码。
    for (const name of ["dashscope", "deepseek", "bailian"]) {
      if (raw.toLowerCase().includes(name)) out.push(`${file}:${i + 1} 出现端点名 ${name}`);
    }
    // 边界 3：主循环不读端点能力声明。
    if (file.endsWith("run-loop.ts") && /\bprofile\.\w/.test(raw)) {
      out.push(`${file}:${i + 1} 读取了端点声明（profile.）`);
    }
  }
  return out;
}

function fingerprint(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of LOOP_FILES) {
    out[f] = createHash("sha256")
      .update(readFileSync(resolve(REPO_ROOT, f)))
      .digest("hex")
      .slice(0, 16);
  }
  return out;
}

void runVerify(main);
