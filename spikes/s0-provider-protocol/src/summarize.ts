/**
 * 跨探针汇总（修 M-4）。
 *
 * 9 个探针写 9 个文件，Facts 文档要「逐条引用 raw 日志」，
 * 没有汇总就只能手工翻。本脚本把所有 finding / unanswered 连同其证据文件
 * 收拢成一张表，直接供 Facts 文档引用。
 *
 * 同时做两件评审里发现的自检：
 *   1. 单家运行时若出现跨 provider 断言，立刻报警（C-1 类缺陷的回归防护）；
 *   2. 统计 token 消耗，避免下次重跑时对成本无感。
 *
 * 用法：npm run summary
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "raw");

interface Entry {
  file: string;
  probe: string;
  provider: string;
  model: string;
  recordedAt: string;
  findings: string[];
  unanswered: string[];
  inputTokens: number;
  outputTokens: number;
  billedCalls: number;
  dryRun: boolean;
}

function load(): Entry[] {
  if (!fs.existsSync(RAW)) return [];
  return fs
    .readdirSync(RAW)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const lines = fs
        .readFileSync(path.join(RAW, f), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const meta = lines[0]?.payload ?? {};
      const e: Entry = {
        file: f,
        probe: meta.probe ?? "?",
        provider: meta.provider ?? "?",
        model: meta.model ?? "?",
        recordedAt: meta.recordedAt ?? "?",
        dryRun: !!meta.dryRun,
        findings: [],
        unanswered: [],
        inputTokens: 0,
        outputTokens: 0,
        billedCalls: 0,
      };
      for (const l of lines) {
        if (l.kind === "finding") e.findings.push(l.payload.text);
        if (l.kind === "unanswered") e.unanswered.push(l.payload.text);
        const u = l.payload?.body?.usage;
        if (u) {
          e.billedCalls++;
          e.inputTokens += u.prompt_tokens ?? u.input_tokens ?? 0;
          e.outputTokens += u.completion_tokens ?? u.output_tokens ?? 0;
        }
      }
      return e;
    })
    .sort((a, b) => (a.probe + a.recordedAt).localeCompare(b.probe + b.recordedAt));
}

const entries = load().filter((e) => !e.dryRun);
if (entries.length === 0) {
  console.log("raw/ 下没有真实运行的证据。先跑 npm run p0。");
  process.exit(0);
}

const providers = [...new Set(entries.map((e) => e.provider))];

console.log("\n" + "=".repeat(78));
console.log("Spike 0 证据汇总");
console.log("=".repeat(78));
console.log(`覆盖 provider：${providers.join(", ")}`);
console.log(`证据文件：${entries.length} 个`);

// ---------------------------------------------------- 自检：跨 provider 断言
// C-1 的回归防护：只跑了一家却在结论里提到另一家，是伪造对照。
const FAMILIES = ["anthropic", "openai", "gemini", "claude", "gpt"];
const absent = FAMILIES.filter((fam) => !providers.some((p) => p.toLowerCase().includes(fam)));
const bogus: Array<{ file: string; text: string; mentions: string }> = [];
for (const e of entries) {
  for (const t of e.findings) {
    for (const fam of absent) {
      if (new RegExp(fam, "i").test(t)) bogus.push({ file: e.file, text: t, mentions: fam });
    }
  }
}
if (bogus.length) {
  console.log("\n⚠️  自检失败：结论中提到了本次未运行的 provider（疑似硬编码跨家断言）");
  for (const b of bogus) console.log(`   [${b.mentions}] ${b.file}\n     ${b.text}`);
  console.log("   → 这类结论不得写入 Facts 文档");
} else {
  console.log("\n✓ 自检通过：没有针对未运行 provider 的断言");
}

// ---------------------------------------------------------------- findings
console.log("\n" + "-".repeat(78));
console.log("结论（按探针）");
console.log("-".repeat(78));
for (const e of entries) {
  console.log(`\n[${e.probe}] ${e.provider} / ${e.model}`);
  console.log(`  证据：raw/${e.file}`);
  if (e.findings.length === 0) console.log("  （无结论）");
  for (const f of e.findings) console.log(`  ✓ ${f}`);
  for (const u of e.unanswered) console.log(`  ? 未解答：${u}`);
}

// ------------------------------------------------------------- 未解答汇总
const allUnanswered = entries.flatMap((e) => e.unanswered.map((u) => ({ probe: e.probe, u })));
console.log("\n" + "-".repeat(78));
console.log(`未解答项合计 ${allUnanswered.length} 条 —— 对应 V03 条款保持【验】标记`);
console.log("-".repeat(78));
for (const { probe, u } of allUnanswered) console.log(`  [${probe}] ${u}`);

// ------------------------------------------------------------------ 成本
const inTok = entries.reduce((s, e) => s + e.inputTokens, 0);
const outTok = entries.reduce((s, e) => s + e.outputTokens, 0);
const calls = entries.reduce((s, e) => s + e.billedCalls, 0);
console.log("\n" + "-".repeat(78));
console.log(`成本：${calls} 次计费调用，输入 ${inTok.toLocaleString()} / 输出 ${outTok.toLocaleString()} tokens`);
const top = [...entries].sort((a, b) => b.inputTokens - a.inputTokens).slice(0, 3);
console.log(`大头：${top.map((e) => `${e.probe}(${e.inputTokens.toLocaleString()})`).join(", ")}`);
console.log("=".repeat(78) + "\n");
