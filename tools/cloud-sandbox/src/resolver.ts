/**
 * `cloud_shell` 的受信任 Resolver（ADR-0016）。
 *
 * 【定】它住在 `tools/` 而不是 Runtime 的 `action/` —— 与 `ShellEffectResolver`
 * 同一条理由，而边界 grep 第 16 条抓的正是这个文件不得搬进 packages / adapters。
 */

import { createHash } from "node:crypto";
import type { JsonValue, ResolvedEffect, TrustedEffectResolver } from "@workagent/harness-runtime";
import { parseLines, parseNetwork, type NetworkSpec } from "./input.js";

/** scope.value 的前缀，审批与自动放行都按它识别本工具的 effect。 */
export const CLOUD_SCOPE_PREFIX = "cloud:";

export class CloudShellEffectResolver implements TrustedEffectResolver {
  resolve(normalizedInput: JsonValue, _workspaceRoot: string): ResolvedEffect {
    const input = (normalizedInput ?? {}) as Record<string, JsonValue>;
    const command = typeof input.command === "string" ? input.command : "";
    const inputs = parseLines(input.inputs);
    const outputs = parseLines(input.outputs);
    const net: NetworkSpec = parseNetwork(input.network);

    const riskFacts: string[] = ["MUTATES_EXTERNAL_STATE"];
    /**
     * ── 【定】上传就是数据离开本机，**断网也照记** ────────────────────────
     *
     * 一台断网的云沙箱仍然是**别人的机器**：文件已经传到阿里云了。
     * 只在「开了网」时记 `DATA_LEAVES_HOST`，等于说出一句
     * 「需要理解它才成立」的话 —— 本仓反复在修的就是这个形态
     * （`dataMovement` 那次一字不差）。
     */
    const uploads = inputs.length > 0;
    if (uploads || net.kind !== "none") riskFacts.push("DATA_LEAVES_HOST");
    /**
     * 【定】只有**断网**这一档不标 IRREVERSIBLE。
     *
     * 断网 ＋ 用完即销毁 ＋ 只有声明过的 outputs 落回 workspace，这次执行对
     * 外部世界的 durable effect 恰好等于那几个文件 —— 与一次 write_file 同级。
     * 开了网就不成立：命令可以调外部 API，而那是撤不回来的。
     *
     * ⚠️ 这个区别**现在不改变审批档位**（EXECUTE 照旧逐次问，ADR-0016 决定 5）。
     * 它存在是为了让事实表说真话，以及为将来那个 auto-grant 的 ADR 留下依据。
     */
    if (net.kind !== "none") riskFacts.push("IRREVERSIBLE");

    const effect: ResolvedEffect = {
      effectType: "EXECUTE",
      operation: "cloud_sandbox.exec",
      scope: {
        kind: "REMOTE_SANDBOX",
        // 【定】规范化语义对象，不以命令原文作为授权边界（§12.4）。
        // 命令原文进审批面的展示层（approval.ts），不进 scope.value。
        value:
          `cloud:net=${net.label}` +
          `;in=${inputs.length}` +
          `;out=${outputs.length}`,
      },
      reversibility: net.kind === "none" ? "PARTIALLY_REVERSIBLE" : "IRREVERSIBLE",
      riskFacts,
      ...(uploads || net.kind !== "none"
        ? {
            dataMovement: {
              destination: "云沙箱池（阿里云 FC Agent Sandbox）",
              scope: [
                uploads ? `上传 ${inputs.length} 个 workspace 文件` : "不上传文件",
                net.kind === "none"
                  ? "命令本身断网（池子下发 deny-all 并经平台回显核对）"
                  : net.kind === "open"
                    ? "命令可访问整个公网，**无法排除**任意外发"
                    : `命令可访问：${net.allow.join(",")}`,
              ].join("；"),
            },
          }
        : {}),
      digest: "",
    };

    /**
     * digest 必须把命令原文 ＋ 两个文件清单 ＋ 出网档位都算进去。
     *
     * 消费者有两个（与 `ShellEffectResolver` 相同）：`settle-batch` 的
     * `actionDigest`，以及 `progress-guard` 的原地打转检测。后者才是这里
     * 必须带全的原因：同一条命令换了 inputs 或换了出网档位是**不同的尝试**，
     * 只哈希命令会让它们在打转检测里长成同一个指纹。
     */
    effect.digest = createHash("sha256")
      .update([effect.operation, command, inputs.join("\n"), outputs.join("\n"), net.label].join("|"))
      .digest("hex")
      .slice(0, 32);
    return effect;
  }
}


/**
 * 这次云沙箱执行的副作用范围，是不是**可以被机械地证明**为「只有声明过的 outputs」（ADR-0017）。
 *
 * 两条合取：
 *   ① 断网 —— 命令到不了外面，而这不是 Atlas 自己说的：池子下发 deny-all 之后
 *      Atlas 读回平台回显核对过（`handler.verifyEgress`），对不上根本不执行；
 *   ② 没有上传 —— 没有任何本地文件离开本机。
 *
 * 【定】它**读已经解析好的 effect**，不在这里重新 parse 一遍入参。
 * 第二份解析分叉的时候，「审批面说断网、实际开着网」不会有任何征兆。
 *
 * 【定】**不查 outputs 的路径边界**，那不是遗漏：handler 在借沙箱**之前**就拒绝
 * 越界的 outputs（`TOOL_PATH_ESCAPE`），所以这里再查一遍在任何可观察量上都与
 * 不查相同 —— 一个永远不可能单独触发的守卫是装饰，而本仓的纪律是
 * 「每道闸门都要有能单独触发它的判据」。边界归 handler，这里只回答「要不要人看」。
 */
export function isProvablyContained(
  effect: ResolvedEffect,
  opts: { uploadsTrusted?: boolean } = {},
): boolean {
  /**
   * ⚠️ 下面四道里有**两对是互相遮蔽**的，注入实测确认过（各自单独摘掉判据不红）：
   *
   *   `scope.kind !== "REMOTE_SANDBOX"`  ↔  `startsWith(CLOUD_SCOPE_PREFIX)`
   *   `net=none`                         ↔  `!riskFacts.includes("DATA_LEAVES_HOST")`
   *
   * 第二对尤其要说清楚：resolver 里**一开网就必然同时标 DATA_LEAVES_HOST**，
   * 所以后一道已经接住了前一道。
   *
   * 【定】**仍然显式写**，不靠「反正会落到下面」。这与 ADR-0012 在 `policy.ts` 里
   * 的处置一字不差（那里 `requiresApprovalFor` 与 `mutates` 的定义重合，也保留了
   * 显式那一支）：靠两处定义重合维持正确性，是本仓反复清理的形态 ——
   * 改了其中一个，另一个不会有任何征兆。
   *
   * 代价如实记：`verify:cloud` I 段测的是**合取**，单摘任一道不会红；
   * 判别力由「两道同摘」那条注入承担。
   */
  if (effect.effectType !== "EXECUTE") return false;
  if (effect.scope.kind !== "REMOTE_SANDBOX") return false;
  if (!effect.scope.value.startsWith(CLOUD_SCOPE_PREFIX)) return false;
  // 断网这一档在 resolver 里就是 `net=none`；认不出来的档位一律按「不是断网」处理
  if (!/(^|;)net=none(;|$)/.test(effect.scope.value.slice(CLOUD_SCOPE_PREFIX.length))) return false;
  /**
   * ADR-0018：部署者显式声明信任自己的池子时，断网调用的上传不再逐次询问。
   *
   * 【定】走到这里时 `net=none` 已经成立，所以「数据离开本机」只可能来自上传 ——
   * 信任声明放开的**只有这一条**。开了网的调用在上面那道就已经返回 false 了，
   * 信任声明管不到它（信任的对象是「我的池子」，而开了网的命令能把数据送到池子之外）。
   *
   * 顺带：这个模式下 `net=none` 成了唯一的闸门，ADR-0017 里它与
   * `DATA_LEAVES_HOST` 互相遮蔽的那一对，在这里**变得可以单独触发**。
   */
  if (opts.uploadsTrusted === true) return true;
  // 上传即数据外发（resolver 里 uploads 与开网共用这个事实，断网也照记）
  return !effect.riskFacts.includes("DATA_LEAVES_HOST");
}
