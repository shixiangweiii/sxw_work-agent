/**
 * 探针：能不能从任务原文里机械地抽出「用户显式要求了哪几件事」？
 *
 * ══════════════════════════════════════════════════════════════════════
 * 起因：2026-08-27 回归评测（88/100）里唯一那条硬失败。
 *
 *   Trial 1：`COMPLETED / SUCCESS`，grader 25/26，
 *            唯一红的是「合计字节数 20223」。
 *
 * 评测报告把它记成「用户显式要求『给出总大小』未完整满足」。
 * 但把任务原文摊开看，那句话是：
 *
 *     「给出**每个子目录的**文件数与总大小」
 *
 * ——「总大小」被「每个子目录」限定了。**全局合计字节数在任务原文里没有出现过。**
 * 而 grader 第 4 组恰恰硬查了它（`archive-inventory.ts:119-121`），
 * 又**没有**任何一条去查任务真正要求的「每个子目录的总大小」。
 *
 * 于是同一件事有两个互斥的解释，而且分数、pass^5、乃至「要不要给 Harness
 * 加一层完成闭合」全都压在它上面：
 *
 *   H1  模型漏了用户显式要求的东西      → 需要「要求闭合」机制
 *   H2  grader 检了用户没要求的东西      → 是 grader 误判，Trial 1 该重算
 *
 * ── 这个探针要回答什么 ────────────────────────────────────────
 *
 * 不是「模型聪不聪明」，是一个**机制可行性**问题：
 *
 *     一段中性的、不含任何业务语义的提示，能不能从任务原文里
 *     稳定抽出「可在产物上核对的显式要求」清单？
 *
 * 因为「要求闭合」这个机制的第一步就是它。抽不出来，整条路直接毙掉，
 * 省下后面全部设计；抽得出来，才谈得上第二步（拿清单对照产物）。
 *
 * ── 为什么必须有 C 段 ──────────────────────────────────────────
 *
 * 只测「原文上抽不抽得出全局合计」是不够的 —— 一个**从不**输出该项的
 * 抽取器也能让 B 段"通过"。所以 C 段把同一条任务加一句显式的全局合计要求，
 * 看抽取器认不认。**两段合起来才有判别力**，这与 `verify:drift` E 段
 * 「三条都要，只测拒绝的话一个永远拒绝的闸门也能变绿」是同一条纪律。
 *
 * ── 成本与定位 ────────────────────────────────────────────────
 *
 * 15 次短请求（3 段 × 5 次），发真实请求、要花钱，**不进 verify:all**。
 * 与 probe:reasoning-tokens 同一形态：一次性、显式调用、打印可读证据。
 *
 *     npm run probe:requirement-extraction
 * ══════════════════════════════════════════════════════════════════════
 */

import { loadProfileFromFile } from "@workagent/harness-runtime";
import { createAnthropicModelPort } from "@workagent/shape-anthropic-messages";
import { ARCHIVE_TASK } from "../../../../eval/fixtures/archive-inventory.js";
import { loadEnv, readEndpointConfig } from "../compose.js";
import { banner, fact, runVerify, section, verdict } from "./harness.js";

/** 每段跑几次。分布比单次有意义 —— 失败率本来就是 1/5 这个量级。 */
const N = 5;

/**
 * 变体任务：在原文基础上**只加一句**显式的全局合计要求。
 *
 * 【定】只能加这一句，别的一字不改 —— 否则 B / C 两段的差异就不能归因到它。
 */
const VARIANT_TASK =
  ARCHIVE_TASK.replace(
    "并在末尾写一段给接手人的提示。",
    "并在清单开头给出全部文件的总数与总字节数，末尾写一段给接手人的提示。",
  );

/**
 * 抽取提示。三条刻意的约束：
 *
 * 1. **中性、零业务语义** —— 不出现「归档」「清单」「字节」这些词。
 *    这个机制将来要服务任意办公任务，提示里但凡有一个业务词就是过拟合。
 * 2. **明确禁止补充** —— 「不要补充你认为应该有的」。抽取器最大的风险
 *    不是漏，是自作主张补出用户没说的要求，然后据此把 Run 判成没做完。
 * 3. **要求可核对** —— 抽出「要写得清楚」这种没法机械对照的条目等于没抽。
 */
const EXTRACT_PROMPT = (task: string) =>
  [
    "下面是一条用户交给助理的任务。",
    "请只依据这段文字，逐条列出它**显式要求**的、可以在最终产物上核对的事项。",
    "",
    "规则：",
    "- 只列这段文字里明确要求的。不要补充你认为应该有的，也不要合并或拆分成你觉得更合理的样子；",
    "- 每条写清「在哪个产物上」「要有什么」；",
    "- 输出严格的 JSON 数组，形如 [\"...\", \"...\"]，不要任何其他文字。",
    "",
    "任务：",
    task,
  ].join("\n");

// ══════════════════════════════════════════════════════ 机械分类判据

/** 「总/合计/全部…… + 字节/大小/体积」。 */
const BYTES_TOTAL = /(总|合计|全部|整体|所有|累计|共)[^，。；、]{0,14}(字节|大小|体积|byte)/i;
/** 「每个/各/按…… 子目录/目录/分组」—— 出现它说明这条要求被限定在子目录级。 */
const PER_DIR_SCOPE = /(每个|各个|各|逐个|按)[^，。；、]{0,8}(子目录|目录|分组)/;
/** 「总/合计/共…… 文件数」。 */
const FILES_TOTAL = /(总|合计|共|全部)[^，。；、]{0,10}(文件数|个文件|文件总数|数量)/;

interface Classified extends Extraction {
  /** 全局合计字节数（grader 硬查、任务原文没写的那一条）。 */
  grandBytes: string[];
  /** 每个子目录的总大小（任务原文真正写了、grader 没查的那一条）。 */
  perDirBytes: string[];
  /** 全局文件总数（任务原文在**日志**那句里写了）。 */
  grandFiles: string[];
}

function classify(e: Extraction): Classified {
  const grandBytes: string[] = [];
  const perDirBytes: string[] = [];
  const grandFiles: string[] = [];
  for (const it of e.items) {
    const scoped = PER_DIR_SCOPE.test(it);
    if (BYTES_TOTAL.test(it)) (scoped ? perDirBytes : grandBytes).push(it);
    if (FILES_TOTAL.test(it) && !scoped) grandFiles.push(it);
  }
  return { ...e, grandBytes, perDirBytes, grandFiles };
}

// ══════════════════════════════════════════════════════ 端点调用

type Port = ReturnType<typeof createAnthropicModelPort>;

/**
 * `max_tokens` 取 8192 而不是够用的 2048 —— 这是**实测踩出来的**。
 *
 * 2048 时本探针 10 次全部返回「0 条」，看起来像「抽取器抽不出东西」这条结论。
 * 实际是：`stopReason = "max_tokens"`、`outputTokens = 2049`、
 * 推理块 3516 字、**正文 0 字** —— 推理把输出预算吃光了。
 *
 * 这正是 V05 §16.1【定·实测】写明的那件事：`reservedOutputTokens` 必须同时
 * 覆盖推理与正文，且「finish_reason=length 且无内容」必须识别为**明确错误条件，
 * 而不是正常完成**。探针第一版把空正文当成了合法的「0 条」，
 * 差一点用它下一个完全相反的结论。
 */
const MAX_TOKENS = 8192;

interface Extraction {
  items: string[];
  stopReason: string;
  outputTokens: number;
  textChars: number;
  /** 空正文 ＋ 撞上限 —— 按 §16.1 必须当错误，不能当「抽出 0 条」。 */
  truncated: boolean;
}

async function extractOnce(model: Port, modelId: string, task: string): Promise<Extraction> {
  const body = {
    model: modelId,
    max_tokens: MAX_TOKENS,
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: EXTRACT_PROMPT(task) }] }],
  };
  const ac = new AbortController();
  const stream = model.invoke({ body, modelId }, ac.signal);
  let r = await stream.next();
  while (!r.done) r = await stream.next();

  const text = r.value.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return {
    items: parseArray(text),
    stopReason: r.value.stopReason,
    outputTokens: r.value.usage.outputTokens,
    textChars: text.length,
    truncated: text.length === 0 && r.value.stopReason !== "end_turn",
  };
}

/** 模型常把 JSON 裹在 ``` 里。解析失败返回空数组 —— 那本身就是一条证据。 */
function parseArray(text: string): string[] {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

async function runSegment(
  model: Port,
  modelId: string,
  task: string,
  label: string,
): Promise<Classified[]> {
  const out: Classified[] = [];
  for (let i = 0; i < N; i++) {
    const c = classify(await extractOnce(model, modelId, task));
    out.push(c);
    if (c.truncated) {
      // 【定】空正文不是「抽出 0 条」。混为一谈会让「机制不可行」这个结论
      // 建立在一次预算配置失误上 —— 本探针第一版正是这么翻的车。
      console.log(
        `   ${label} #${i + 1}  \x1b[31m输出被截断\x1b[0m  ` +
          `stop=${c.stopReason} out=${c.outputTokens} 正文 0 字（推理吃光预算，§16.1）`,
      );
      continue;
    }
    console.log(
      `   ${label} #${i + 1}  抽出 ${String(c.items.length).padStart(2)} 条  ` +
        `(out=${String(c.outputTokens).padStart(4)})  ` +
        `｜全局合计字节 ${c.grandBytes.length > 0 ? "有" : "无"}` +
        `｜子目录总大小 ${c.perDirBytes.length > 0 ? "有" : "无"}` +
        `｜全局文件总数 ${c.grandFiles.length > 0 ? "有" : "无"}`,
    );
    for (const g of c.grandBytes) console.log(`        └─ 全局合计字节 → 「${g}」`);
  }
  return out;
}

const hit = (rs: Classified[], pick: (c: Classified) => string[]): number =>
  rs.filter((r) => pick(r).length > 0).length;

interface Endpoint {
  label: string;
  ok: boolean;
  error?: string;
  model?: Port;
  modelId: string;
}

/**
 * 打开一个端点并做最便宜的一次连通性调用。
 *
 * 【注意】modelId 取 `.env` 的值而不是 `profile.modelId`。二者当前不一致
 * （回归评测 P1-1：百炼声明写 qwen3.7-plus，`.env` 写 deepseek-v4-flash），
 * 生产路径会被 M-5 闸门挡下 —— 那是**对的**，声明的粒度是端点 × 模型。
 * 探针不是 Run：不结算 outcome、不落 transcript、不驱动主循环，
 * 用实际部署的模型名直连，并在标签里如实写出这件事。
 */
async function openEndpoint(choice: "deepseek" | "bailian"): Promise<Endpoint> {
  const cfg = readEndpointConfig(false, choice);
  const label = `${choice} / ${cfg.modelId}`;
  if (!cfg.baseUrl || !cfg.apiKey) {
    return { label, ok: false, error: ".env 缺 baseUrl 或 key", modelId: cfg.modelId };
  }
  const profile = loadProfileFromFile(cfg.profilePath);
  const model = createAnthropicModelPort({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    profile,
  });
  try {
    const ac = new AbortController();
    const stream = model.invoke(
      {
        body: {
          model: cfg.modelId,
          max_tokens: 8,
          stream: true,
          messages: [{ role: "user", content: [{ type: "text", text: "ok" }] }],
        },
        modelId: cfg.modelId,
      },
      ac.signal,
    );
    let r = await stream.next();
    while (!r.done) r = await stream.next();
    return { label, ok: true, model, modelId: cfg.modelId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, ok: false, error: msg.slice(0, 120), modelId: cfg.modelId };
  }
}

// ══════════════════════════════════════════════════════════════ main

async function main(): Promise<void> {
  banner(
    "探针：任务原文里的「显式要求」能不能被机械抽出来",
    "「要求闭合」机制的第一步是否可行？以及 Trial 1 到底是模型漏了还是 grader 过严？",
  );

  loadEnv();

  // ── A. 零成本：任务原文的字面读法 ─────────────────────────────
  section("A. 任务原文怎么写的（不花钱，先把事实摆出来）");
  console.log(`\n   ${ARCHIVE_TASK.replace(/。/g, "。\n   ")}`);

  const at = ARCHIVE_TASK.indexOf("总大小");
  const before = ARCHIVE_TASK.slice(Math.max(0, at - 12), at);
  fact("「总大小」出现位置", at);
  fact("它前面 12 个字", `「${before}」`);
  verdict(
    /每个子目录的/.test(before),
    `任务原文里的「总大小」被「每个子目录」限定 —— 全局合计字节数没有字面依据`,
  );
  verdict(
    !/(全部|所有|整体|全体)[^，。]{0,10}(总字节|总大小)/.test(ARCHIVE_TASK),
    "任务原文中不存在「全部文件的总字节数」这类全局合计要求",
  );
  console.log(
    "\n   对照 grader（archive-inventory.ts:116-121）：\n" +
      "     ✓ 硬查「合计文件数 6」      ← 任务在**日志**那句里要求了「共多少个文件」\n" +
      "     ✓ 硬查「合计字节数 20223」   ← 任务原文找不到对应要求\n" +
      "     ✗ 没有任何一条查「每个子目录的总大小」← 任务明确要求了",
  );

  // ── 端点 ────────────────────────────────────────────────────
  //
  // 首选 DeepSeek —— Trial 1 就跑在它上面，同组合才可比。
  // 但端点可能当场不可用（凭证过期、配额），所以先做一次最便宜的连通性预检，
  // 不可用就如实记下来再换。**不可用这件事本身是证据**：评测报告的 live
  // 结论若此刻复现不了，那份证据的保鲜期就要写进报告。
  section("B0. 端点可用性预检");
  const live = await openEndpoint("deepseek");
  const alt = await openEndpoint("bailian");
  for (const e of [live, alt]) {
    fact(e.label, e.ok ? "可用" : `不可用：${e.error}`);
  }
  const primary = live.ok ? live : alt.ok ? alt : undefined;
  if (!primary) {
    verdict(false, "两个端点都不可用，探针无法进行");
    return;
  }
  if (!live.ok) {
    console.log(
      `\n   ⚠ Trial 1 所用的 DeepSeek 端点此刻不可用，B/C 段改在「${primary.label}」上跑。\n` +
        "     模型名相同（.env 的 deepseek-v4-flash），但**是另一个平台的部署**，\n" +
        "     按本项目的端点纪律，这不等于同一个端点 —— 结论要相应收窄。",
    );
  }

  section(`B. 原文 × ${N} 次（${primary.label}）`);
  const b = await runSegment(primary.model!, primary.modelId, ARCHIVE_TASK, "原文");

  section(`C. 变体 × ${N} 次（原文＋一句显式的全局合计要求）—— 判别力`);
  console.log(`   加的那一句：「并在清单开头给出全部文件的总数与总字节数」\n`);
  const c = await runSegment(primary.model!, primary.modelId, VARIANT_TASK, "变体");

  // ── D. 跨端点 ───────────────────────────────────────────────
  //
  // 本项目最贵的一条方法论教训：Spike 0 第二轮十条结论，第三轮换端点有六条
  // 不成立。任何"模型能不能做到 X"的结论，单端点都不作数。
  section("D. 换一个端点复核");
  let d: Classified[] | undefined;
  const other = [live, alt].find((e) => e.ok && e !== primary);
  if (!other) {
    console.log("   没有第二个可用端点，跳过。**本次结论因此是单端点的**。");
  } else {
    d = await runSegment(other.model!, other.modelId, ARCHIVE_TASK, `原文/${other.label}`);
  }

  // ── 结论 ────────────────────────────────────────────────────
  section("E. 结论");

  const bGrand = hit(b, (x) => x.grandBytes);
  const cGrand = hit(c, (x) => x.grandBytes);
  const bPerDir = hit(b, (x) => x.perDirBytes);
  const bParsed = b.filter((x) => !x.truncated && x.items.length > 0).length;
  const truncated = [...b, ...c].filter((x) => x.truncated).length;
  if (truncated > 0) fact("输出被截断的次数（不算作 0 条）", truncated);

  fact("B 原文：抽出全局合计字节", `${bGrand}/${N}`);
  fact("C 变体：抽出全局合计字节", `${cGrand}/${N}`);
  fact("B 原文：抽出子目录总大小", `${bPerDir}/${N}`);
  fact("B 原文：条目数", b.map((x) => x.items.length).join(" / "));
  if (d) fact("D 另一端点：抽出全局合计字节", `${hit(d, (x) => x.grandBytes)}/${N}`);

  verdict(bParsed === N, `${N} 次输出都能解析成 JSON 数组（抽取这一步本身可用）`);

  // 判别力：不是「抽不出就算好」，是「该抽出时抽得出、不该抽出时不抽」。
  verdict(
    cGrand >= N - 1,
    `变体上认得出真的有的要求（${cGrand}/${N} ≥ ${N - 1}）—— 否则抽取器没有判别力，整条路作废`,
  );
  verdict(
    cGrand - bGrand >= 3,
    `原文与变体的差异显著（${cGrand} − ${bGrand} ≥ 3）—— 抽取器确实在读原文，不是在背模板`,
  );
  verdict(
    bPerDir >= N - 1,
    `原文上抽得出任务真正要求的「每个子目录的总大小」（${bPerDir}/${N}）`,
  );

  section("F. 原文抽取的完整结果（供人读，不进判据）");
  b.forEach((r, i) => {
    console.log(`\n   ── 第 ${i + 1} 次，共 ${r.items.length} 条 ──`);
    r.items.forEach((it, j) => console.log(`   ${String(j + 1).padStart(2)}. ${it}`));
  });
}

void runVerify(main);
