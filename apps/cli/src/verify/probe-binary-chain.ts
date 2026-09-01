/**
 * probe:binary-chain —— 二进制取回链路到底断在哪一节。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它是**一次性探针**，不是验收脚本：不进 `verify:all`、不产出 verdict，
 * 只打印一组读数供人判断（与 Spike 0 的探针同形态，D-25 的口径）。
 *
 * 【定】它**会发一次真实 GET**，所以不能进 `verify:all` ——
 * 那条链路必须能在离线、无外网的环境里跑完。
 *
 * 回答的问题：`fetch_url` 取回一张真实图片之后，有没有**任何**通路
 * 能让这些字节落到 workspace 的 `images/` 里？
 *
 * 2026-08-30 的答案是**没有**，且原因是结构性的（存量清单 S3.5-8）：
 *   ① `BlobStorePort.put({ content: string })` 只吃文本，存不了字节；
 *   ② `ToolExecutionContext` 里没有 blob 句柄；
 *   ③ `ModelContent` 只有 text / reasoning / tool_call / tool_result 四种，
 *      **没有 image 块** —— 所以这不是工具层能解决的。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { ToolExecutionContext } from "@workagent/harness-runtime";
import { executeFetchUrl } from "@workagent/tools-common";

const url = process.argv[2] ?? "https://pi.dev/social.png";

/**
 * 【定】用真实的 `ToolExecutionContext` 类型，不用 `as any`。
 *
 * 探针也是仪器。一个绕过类型的探针在接口变化时**不会报错**，
 * 只会悄悄测另一件事 —— 而探针的全部价值就是它测的那件事是准的。
 */
const ctx: ToolExecutionContext = {
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
  onProgress: (m: string) => console.log(`  [progress] ${m}`),
  timezone: "Asia/Shanghai",
  executionPrivilege: "SANDBOXED",
};

const out = await executeFetchUrl({ url }, ctx);

console.log(`\nfetch_url("${url}")`);
console.log(`  ok            = ${out.ok}`);
if (!out.ok) {
  console.log(`  error         = ${JSON.stringify(out.error)}`);
} else {
  const body = JSON.parse(out.output) as Record<string, unknown>;
  for (const k of ["status", "contentType", "sizeBytes", "isText", "format"]) {
    console.log(`  ${k.padEnd(14)}= ${String(body[k])}`);
  }
  const content = String(body["content"] ?? "");
  console.log(`  content.length= ${content.length}`);
  console.log(`  note          = ${String(body["note"] ?? "(无)")}`);
  console.log(
    `\n判据：模型能拿到的字节数 = ${content.length} / 服务器实际返回 ${String(body["sizeBytes"])}`,
  );
}
