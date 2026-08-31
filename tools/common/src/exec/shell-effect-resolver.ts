/**
 * `run_shell` 的受信任 Resolver（`effectResolution.kind === "RESOLVER"`）。
 *
 * 它是 §12.4「文件路径、Shell、Browser、批量操作必须使用受信任 Resolver」
 * 里 Shell 那一条的落地，也是 RESOLVER 这一档**第一次被真正需要** ——
 * 在此之前它从阶段 1 起就在类型里，而 `effect-resolver.ts` 一直是抛错的。
 *
 * ── 它住在 `tools/` 而不是 `packages/harness-runtime/` ──────────────────
 *
 * 【定】把命令解析写进 Runtime 的 `action/` 是最省事的写法，也是越界：
 * 那等于让 Runtime 认识 shell 语法。与「Runtime 认识工具名」是同一条线，
 * 只是 `grep -rnE "@workagent/tools-|tools/common" packages` 抓不到它 ——
 * 这条只有人读代码时守得住。Runtime 侧只有 `TrustedEffectResolver` 这个类型。
 */

import { createHash } from "node:crypto";
import type {
  JsonValue,
  ResolvedEffect,
  TrustedEffectResolver,
} from "@workagent/harness-runtime";
import { analyzeCommand } from "./command-analysis.js";

export const SHELL_RESOLVER_REF = { id: "shell-command", version: "1.0.0" } as const;
export const SHELL_RESOLVER_KEY = `${SHELL_RESOLVER_REF.id}@${SHELL_RESOLVER_REF.version}`;

export class ShellEffectResolver implements TrustedEffectResolver {
  resolve(normalizedInput: JsonValue, _workspaceRoot: string): ResolvedEffect {
    const input = (normalizedInput ?? {}) as Record<string, JsonValue>;
    const command = typeof input.command === "string" ? input.command : "";
    const allowNetwork = input.allow_network === true;

    const a = analyzeCommand(command);

    /**
     * 【定】`allow_network` 会把一条本来只读的命令拉回 EXECUTE。
     *
     * 白名单里没有网络程序，所以正常路径上这一条不会命中；它防的是将来
     * 有人往白名单里加了一个「看起来只读」的程序而它能联网。
     * 联网 ＝ 可外发 ＝ 不能自动放行 —— 这条判定要独立于白名单存在。
     */
    const readOnly = a.readOnly && !allowNetwork;

    const riskFacts: string[] = [];
    if (!readOnly) {
      riskFacts.push("MUTATES_EXTERNAL_STATE", "IRREVERSIBLE");
    }
    if (allowNetwork) {
      riskFacts.push("DATA_LEAVES_HOST");
    }

    const effect: ResolvedEffect = {
      effectType: readOnly ? "READ" : "EXECUTE",
      operation: readOnly ? "shell.read" : "shell.exec",
      /**
       * `PROCESS` scope 的第一个消费者 —— 它从阶段 1 起就在
       * `EffectScope.kind` 的值域里，此前零使用。
       *
       * 【定】value 是**程序名集合**，不是命令原文（§12.4「不以自由文本
       * 作为授权边界」）。但这带来一个必须补上的代价：`main.ts` 的审批提示
       * 原本只打 `effectType → scope.value`，那样人在审批时看不到自己在批
       * 哪条命令 —— 一个看起来有审批、实际盲批的闸门。补在 main.ts 里。
       */
      scope: {
        kind: "PROCESS",
        value: a.programs.length > 0 ? `programs:${a.programs.join(",")}` : "programs:(空)",
      },
      /**
       * 【定】EXECUTE 一律 IRREVERSIBLE，不做细分。
       *
       * `main.ts` 的 `autoGrant` 拿 reversibility 判自动放行档位，而一条
       * shell 命令能不能撤销**根本判不出来**。标成 PARTIALLY_REVERSIBLE
       * 会让它落进「找得回来」那一档 —— 那正是 E-3 反过来的错误：
       * 上次是闸门太严从没覆盖到 `write_file`，这次会是闸门太松放过 `rm`。
       */
      reversibility: readOnly ? "REVERSIBLE" : "IRREVERSIBLE",
      riskFacts,
      ...(allowNetwork
        ? {
            dataMovement: {
              // 【定】与 fetch_url 同口径：只记去向类别，不记命令原文。
              // 命令行里可能就装着被外发的内容，抄进 Trace 等于让审计记录
              // 自己变成第二个泄漏点。
              destination: "(命令自定，未解析)",
              scope: `shell.exec 显式开启了网络；程序：${a.programs.join(",") || "(未解析)"}`,
            },
          }
        : {}),
      digest: "",
    };

    /**
     * digest 必须把**命令原文**算进去。
     *
     * ── 2026-08-30 评审：这段注释原来给的是一个**不存在的机制** ────────────
     *
     * 原文写的是「审批授权是按 digest 认的 —— 只哈希程序名等于
     * 『批准过一次 git，之后所有 git 都算批过』」。回源核对后：
     * **`main.ts` 的审批没有任何记忆**，每次 EXECUTE 都是新鲜问
     * （`--yes-all` 则无条件批）。那个反例描述的复用从来不存在。
     *
     * 行为是对的，理由是错的 —— 而这个仓库自己的教训恰恰是
     * 「一处结论被抄进第二个地方之后就不再有人回源」，
     * 而它当时已经被 `verify:shell` 的 verdict 文案抄了第二处。
     *
     * ── 真实理由（两个消费者，回源确认过）──────────────────────────────
     *
     * ① `settle-batch.ts` 用它参与 `actionDigest` 的构造；
     * ② `progress-guard.ts` 用它做**在原地打转**的检测（`run-loop.ts` 传入）。
     *
     * ② 才是这里必须带命令原文的原因：`git log` 与 `git log --all --graph`
     * 的程序名集合完全相同，只哈希程序名会让两条不同的命令在打转检测里
     * 长成同一个指纹 —— 于是「模型换着参数试」会被误判成「在原地打转」，
     * 而真正的原地打转（同一条命令反复重试）反而混在里面看不出来。
     */
    effect.digest = createHash("sha256")
      .update([effect.effectType, effect.operation, effect.scope.value, command].join("|"))
      .digest("hex")
      .slice(0, 32);

    return effect;
  }
}
