/**
 * verify:scenarios —— S13 跨场景 smoke（决 7 的判据）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验证：**三个来自不同场景、互不相干的真实任务，用同一套工具都跑通。**
 *
 *   任务 A  办公：读一批文档 → 汇总 → 产出结构化文档
 *   任务 B  代码：分析一个模块 → 找出某类形状 → 产出说明文档
 *   任务 C  聊天：从导出的聊天记录里提取待办 → 产出纪要
 *
 * 这是反过拟合三道机械闸门里的**第三道，也是唯一能真正证伪「通用」的那道**。
 * 前两道（边界 grep、两类声明）只能防止**显式依赖**，
 * 防不了「工具的形状是照着某个任务长的」。
 *
 * ── 任务 C 与「任务 A 不用 append_log」都是刻意的 ──────────────────────
 *
 * 聊天场景在声明层存在（每个场景工具的文件头都写了它），在执行层缺席的话，
 * 「通用性成立」这条门槛的证明力度就弱一档。
 *
 * 任务 A 也**不用 `append_log` 收尾**：那是个测量工具，三场景标准一条都不满足。
 * 用它去完成办公任务的最后一步，恰好是「能力面被测量需求反向定义」的现场示范。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ── 【定】这个脚本证明什么、不证明什么 ─────────────────────────────────
 *
 * 默认用**脚本化模型**跑，所以它证明的是：
 *   **同一套工具面，在三种互不相干的任务形状上，端到端都走得通** ——
 *   工具组合得起来、产物登记得上、检查跑得过、配对不破。
 *
 * 它**不证明**「模型能自己想出这些步骤」。那属于评测，按决 4 推到评测阶段。
 * 加 `--live` 会用真实端点跑同样三个任务（花钱，不进 verify:all）。
 *
 * 【定】为了不让判据变成自证，「最小有效性」锚在**工具返回值**上而不是产物上：
 * 产物内容是脚本写的（我说它写什么它就写什么），而工具返回值里出现夹具里的
 * 对象名，只可能来自真的读到了它们。
 * ══════════════════════════════════════════════════════════════════════
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CollectingTraceSink,
  findOrphanResults,
  findUnpairedToolUses,
  type ContextMessage,
  type RunId,
} from "@workagent/harness-runtime";
import { commonSceneTools, commonTools } from "@workagent/tools-common";
import { compose } from "../compose.js";
import { ScriptedModelPort, banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

const LIVE = process.argv.includes("--live");

interface Scenario {
  id: string;
  scene: "办公" | "代码" | "聊天";
  task: string;
  /** 铺夹具。返回「任务原文点名的对象」，最小有效性判据要用。 */
  materialize(root: string): string[];
  /** 脚本化模型的轮次。--live 时不用。 */
  turns(root: string): Array<{ text: string; toolCalls: Array<{ toolCallId: string; name: string; input: unknown }> }>;
  /** 产物的相对路径。 */
  artifactPath: string;
}

// ══════════════════════════════════════════════════════ 三个场景

const OFFICE: Scenario = {
  id: "A",
  scene: "办公",
  task:
    "读 客户资料/ 下的三份文档，汇总成一份 客户汇总.md，" +
    "每个客户一节，写明它的所在城市与合同状态。",
  materialize(root) {
    const dir = join(root, "客户资料");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "远山科技.md"), "# 远山科技\n城市：杭州\n合同状态：已签署\n", "utf8");
    writeFileSync(join(dir, "北岸物流.md"), "# 北岸物流\n城市：天津\n合同状态：待签署\n", "utf8");
    writeFileSync(join(dir, "青禾食品.md"), "# 青禾食品\n城市：成都\n合同状态：条款待确认\n", "utf8");
    return ["远山科技", "北岸物流", "青禾食品"];
  },
  turns() {
    return [
      {
        text: "先看看有哪些文档",
        toolCalls: [{ toolCallId: "o1", name: "list_dir", input: { path: "客户资料" } }],
      },
      {
        text: "逐份读",
        toolCalls: [
          { toolCallId: "o2", name: "read_file", input: { path: "客户资料/远山科技.md" } },
          { toolCallId: "o3", name: "read_file", input: { path: "客户资料/北岸物流.md" } },
          { toolCallId: "o4", name: "read_file", input: { path: "客户资料/青禾食品.md" } },
        ],
      },
      {
        text: "写汇总",
        toolCalls: [
          {
            toolCallId: "o5",
            name: "write_file",
            input: {
              path: "客户汇总.md",
              content: [
                "# 客户汇总",
                "",
                "## 远山科技",
                "- 城市：杭州",
                "- 合同状态：已签署",
                "",
                "## 北岸物流",
                "- 城市：天津",
                "- 合同状态：待签署",
                "",
                "## 青禾食品",
                "- 城市：成都",
                "- 合同状态：条款待确认",
                "",
              ].join("\n"),
              artifact_role: "DELIVERABLE",
            },
          },
        ],
      },
    ];
  },
  artifactPath: "客户汇总.md",
};

const CODE: Scenario = {
  id: "B",
  scene: "代码",
  task:
    "看看 src/ 这个模块，找出所有导出的函数（以 export function 开头的），" +
    "在 模块说明.md 里列出它们分别在哪个文件的第几行。",
  materialize(root) {
    const dir = join(root, "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "parser.ts"),
      "// 解析器\nconst X = 1;\n\nexport function parseHeader(s: string) {\n  return s;\n}\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "writer.ts"),
      "// 写出\nexport function writeChunk(b: Buffer) {\n  return b.length;\n}\n",
      "utf8",
    );
    writeFileSync(join(dir, "README.md"), "内部说明，不是源码\n", "utf8");
    return ["parseHeader", "writeChunk"];
  },
  turns() {
    return [
      {
        text: "先搜一下导出的函数",
        toolCalls: [
          { toolCallId: "c1", name: "search", input: { pattern: "export function", path: "src", kind: "content" } },
        ],
      },
      {
        text: "确认一下文件大小",
        toolCalls: [{ toolCallId: "c2", name: "stat", input: { path: "src/parser.ts" } }],
      },
      {
        text: "写说明",
        toolCalls: [
          {
            toolCallId: "c3",
            name: "write_file",
            input: {
              path: "模块说明.md",
              content: [
                "# src 模块导出的函数",
                "",
                "- `parseHeader` —— src/parser.ts 第 4 行",
                "- `writeChunk` —— src/writer.ts 第 2 行",
                "",
              ].join("\n"),
              artifact_role: "DELIVERABLE",
            },
          },
        ],
      },
      {
        // edit_file：三场景里代码场景最常用它，也是唯一天然落 §18.2 分支二的场景工具。
        text: "补一句说明",
        toolCalls: [
          {
            toolCallId: "c4",
            name: "edit_file",
            input: {
              path: "模块说明.md",
              old_string: "# src 模块导出的函数",
              new_string: "# src 模块导出的函数\n\n（README.md 不是源码，已排除）",
            },
          },
        ],
      },
    ];
  },
  artifactPath: "模块说明.md",
};

const CHAT: Scenario = {
  id: "C",
  scene: "聊天",
  task: "从 导出记录/项目群.txt 里把待办挑出来，写一份 待办纪要.md，注明是谁的事。",
  materialize(root) {
    const dir = join(root, "导出记录");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "项目群.txt"),
      [
        "[09:12] 林岚：早，今天的联调什么时候开始",
        "[09:15] 赵珩：十点，我先把测试环境刷一遍",
        "[09:31] 林岚：TODO 我这边下午之前把接口文档补齐",
        "[10:02] 周叙：昨天那个导出的乱码问题还没定位到",
        "[10:40] 赵珩：TODO 我来复现一下导出乱码，today 内给结论",
        "[11:05] 周叙：好，那我先跟进客户那边的反馈",
      ].join("\n"),
      "utf8",
    );
    return ["林岚", "赵珩"];
  },
  turns() {
    return [
      {
        text: "先把 TODO 找出来",
        toolCalls: [
          { toolCallId: "t1", name: "search", input: { pattern: "TODO", path: "导出记录", kind: "content" } },
        ],
      },
      {
        text: "把整段记录读一遍确认上下文",
        toolCalls: [{ toolCallId: "t2", name: "read_file", input: { path: "导出记录/项目群.txt" } }],
      },
      {
        text: "写纪要",
        toolCalls: [
          {
            toolCallId: "t3",
            name: "write_file",
            input: {
              path: "待办纪要.md",
              content: [
                "# 项目群待办",
                "",
                "- 林岚：下午之前补齐接口文档",
                "- 赵珩：复现导出乱码问题，当天给结论",
                "",
              ].join("\n"),
              artifact_role: "DELIVERABLE",
            },
          },
        ],
      },
    ];
  },
  artifactPath: "待办纪要.md",
};

const SCENARIOS = [OFFICE, CODE, CHAT];

// ══════════════════════════════════════════════════════════════ main

async function main(): Promise<void> {
  banner(
    "S13 跨场景 smoke —— 决 7 的判据（verify:scenarios）",
    "三个互不相干的真实任务，用**同一套工具**都跑得通吗？",
  );
  console.log(
    LIVE
      ? "\n   \x1b[33m--live：用真实端点跑，会花钱\x1b[0m\n"
      : "\n   脚本化模式（默认，不花钱）。它证明的是「同一套工具面在三种任务形状上端到端走得通」，\n" +
        "   **不证明**「模型能自己想出这些步骤」—— 那属于评测，按决 4 推到评测阶段。\n" +
        "   加 --live 用真实端点跑同样三个任务。\n",
  );

  const results: Array<{ id: string; scene: string; ok: boolean; why: string }> = [];
  /** 三个任务各自用到了哪些工具 —— 汇总起来才看得出「同一套工具」这句话成不成立。 */
  const toolsUsedByScenario = new Map<string, Set<string>>();

  for (const sc of SCENARIOS) {
    section(`任务 ${sc.id}（${sc.scene}）：${sc.task}`);
    const ws = tempWorkspace();
    try {
      const named = sc.materialize(ws.root);
      const trace = new CollectingTraceSink();
      const composed = compose({
        dbPath: ":memory:",
        workspaceRoot: ws.root,
        approvalDecider: async () => ({ approved: true }),
        trace,
        ...(LIVE
          ? {}
          : {
              modelPortOverride: new ScriptedModelPort([
                ...sc.turns(ws.root),
                { text: "做完了。", toolCalls: [] },
              ]),
            }),
      });

      const gen = composed.runtime.start(composed.makeRunSpec(sc.task));
      let runId = "";
      let r = await gen.next();
      while (!r.done) {
        if (!runId) runId = String(r.value.runId);
        r = await gen.next();
      }

      const messages: ContextMessage[] = await composed.ports.transcript.rebuildMessages(
        runId as RunId,
      );
      const artifacts = await composed.ports.artifacts.listByRun(runId as RunId);
      const used = new Set(trace.byType("ActionProposed").map((e) => e.payload.toolName));
      toolsUsedByScenario.set(sc.id, used);

      // ── 层 1：结构
      const unpaired = findUnpairedToolUses(messages);
      const orphans = findOrphanResults(messages);
      const terminal = r.value.terminal.reason;
      const outcome = r.value.outcome?.kind ?? "未结算";
      const structureOk =
        unpaired.length === 0 &&
        orphans.length === 0 &&
        (terminal === "COMPLETED" || terminal === "COMPLETED_WITH_LIMITS");

      // ── 层 2：产物存在性（**存在且非空** —— 原版只验「跑通」，
      //          一个 0 字节的空文件也能过）
      let artifactBytes = -1;
      let artifactText = "";
      try {
        artifactText = readFileSync(join(ws.root, sc.artifactPath), "utf8");
        artifactBytes = Buffer.byteLength(artifactText, "utf8");
      } catch {
        /* 读不到就是没产出 */
      }
      const registered = artifacts.filter((a) => a.role === "DELIVERABLE");
      const existenceOk =
        artifactBytes > 0 && registered.length > 0 && registered.every((a) => a.verified === true);

      /**
       * ── 层 3：最小有效性 ──────────────────────────────────────────────
       *
       * 【定】锚在**工具返回值**上，不锚在产物上。
       *
       * 脚本化模式下产物内容是我写的 —— 拿「产物里有没有这些名字」当判据
       * 就是自证。而这些名字出现在**工具返回值**里，只可能来自真的读到了
       * 夹具文件：工具没工作的话，那些字符串无处可来。
       *
       * `--live` 模式下产物是模型写的，那时才额外要求产物里也出现它们。
       */
      const toolOutputs = messages
        .flatMap((m) => m.content)
        .filter((c) => c.type === "tool_result")
        .map((c) => (c.type === "tool_result" ? c.content : ""))
        .join("\n");
      const seenInTools = named.filter((n) => toolOutputs.includes(n));
      const seenInArtifact = named.filter((n) => artifactText.includes(n));
      const effectivenessOk =
        seenInTools.length === named.length && (!LIVE || seenInArtifact.length === named.length);

      fact("Terminal / Outcome", `${terminal} / ${outcome}`);
      fact("用到的工具", [...used].join(", ") || "（无）");
      fact("配对", unpaired.length === 0 && orphans.length === 0 ? "一一对应" : "有缺口");
      fact("产物", artifactBytes > 0 ? `${sc.artifactPath}（${artifactBytes} 字节）` : "（不存在或为空）");
      fact(
        "Artifact 登记 / 检查",
        registered.length > 0
          ? registered.map((a) => `${a.logicalId} v${a.version} verified=${a.verified}`).join("; ")
          : "（没有 DELIVERABLE 被登记）",
      );
      fact("任务点名的对象", named.join(", "));
      fact("其中出现在工具返回值里", `${seenInTools.length}/${named.length}`);
      fact("其中出现在产物里", `${seenInArtifact.length}/${named.length}${LIVE ? "" : "（脚本化模式下不作判据）"}`);

      const ok = structureOk && existenceOk && effectivenessOk;
      results.push({
        id: sc.id,
        scene: sc.scene,
        ok,
        why: ok
          ? "结构、产物存在性、最小有效性三层都过"
          : !structureOk
            ? `结构层失败（${terminal}，未配对 ${unpaired.length}）`
            : !existenceOk
              ? "产物不存在 / 为空 / 没通过 Artifact 检查"
              : "最小有效性失败：任务点名的对象没有出现在工具返回值里",
      });
      verdict(ok, `任务 ${sc.id}（${sc.scene}）：${results[results.length - 1]!.why}`);

      composed.db.close();
    } finally {
      ws.cleanup();
    }
  }

  // ── 汇总：这才是「通用」这句话的落点
  section("总判定：三个场景用的是不是同一套工具");
  console.log(
    "   【定】判据不是「三个都跑通了」，而是**没有任何一个场景需要它专属的工具**。\n" +
      "   如果某个场景用到了别人都用不上的东西，那件东西就该被重新审视 ——\n" +
      "   它多半是照着那个任务长出来的。\n\n" +
      "   ── 这条判据在阶段 3 收口批才真的接上 ──────────────────────────\n" +
      "   在此之前 shared 只进了 fact() 打印，verdict 是 `results.every(ok)` ——\n" +
      "   把上面三条已经各自断言过的结论**又断言了一遍**。段标题写着\n" +
      "   「判据不是三个都跑通了」，而实现的判据恰恰就是三个都跑通了。\n",
  );

  for (const [id, used] of toolsUsedByScenario) {
    console.log(`     · 任务 ${id}：${[...used].sort().join(", ")}`);
  }

  const sets = [...toolsUsedByScenario.values()];
  const allUsed = new Set(sets.flatMap((s) => [...s]));
  const shared = [...allUsed].filter((t) => sets.every((s) => s.has(t)));
  /** 只有一个场景用到的工具。独占**不违规**，但下面要追问它是什么来路。 */
  const exclusive = [...allUsed].filter((t) => sets.filter((s) => s.has(t)).length === 1);

  const commonNames = new Set(commonTools.map((t) => t.definition.name));
  const sceneNames = new Set(commonSceneTools.map((t) => t.definition.name));
  /** 判据 ①：有没有哪个场景动用了 Case 包里的工具。 */
  const caseToolsUsed = [...allUsed].filter((t) => !commonNames.has(t));
  /** 判据 ③：任意两个场景的工具集有没有交集 —— 三座孤岛不叫「同一套」。 */
  const pairwiseDisjoint: string[] = [];
  const ids = [...toolsUsedByScenario.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = toolsUsedByScenario.get(ids[i]!)!;
      const b = toolsUsedByScenario.get(ids[j]!)!;
      if (![...a].some((t) => b.has(t))) pairwiseDisjoint.push(`${ids[i]}×${ids[j]}`);
    }
  }
  /** 判据 ②的补充：独占的那件东西必须是**声明过三场景用例**的场景工具。 */
  const exclusiveNotScene = exclusive.filter((t) => !sceneNames.has(t));

  fact("三个场景合计用到的工具", [...allUsed].sort().join(", "));
  fact("三个场景**都**用到的", shared.sort().join(", ") || "（无）");
  fact(
    "只有一个场景用到的",
    exclusive.sort().join(", ") || "（无）",
  );
  fact("其中不是场景工具的", exclusiveNotScene.join(", ") || "（无 —— 独占的都声明过三场景用例）");
  fact("用到的 Case 包工具", caseToolsUsed.join(", ") || "（无 —— 三个场景都只用通用工具）");
  fact("工具集互不相交的场景对", pairwiseDisjoint.join(", ") || "（无 —— 两两都有交集）");

  const allOk = results.every((r) => r.ok);
  /**
   * 【定】四项合取，缺一条这段就退回「三个都跑通了」：
   *   ① 三场景全过；
   *   ② **没有任何场景动用 Case 包的工具** —— 这是本段唯一真正的反过拟合
   *      判据，也正是方案删掉「任务 A 用 append_log 收尾」时要防的形态：
   *      一个场景一旦需要 cases/ 里的东西，「通用能力面」这句话就不成立了；
   *   ③ 独占工具必须是声明过三场景用例的场景工具（独占 ≠ 为它而生，
   *      但得拿得出「另外两个场景也用得上」的声明，那条由 verify:tools B 段守）；
   *   ④ 两两场景的工具集有交集 —— 否则是三座孤岛各用各的，不是同一套。
   */
  const universalOk =
    allOk && caseToolsUsed.length === 0 && exclusiveNotScene.length === 0 && pairwiseDisjoint.length === 0;
  verdict(
    universalOk,
    universalOk
      ? `三个来自不同场景、互不相干的任务，用同一套 tools/common 全部跑通：` +
        `${shared.length} 个工具三个场景都用到，${exclusive.length} 个只被一个场景用到` +
        `（都是声明过三场景用例的场景工具），**没有一个场景需要 Case 包里的东西**，` +
        `两两之间也都有交集`
      : !allOk
        ? `有场景没跑通：${results.filter((r) => !r.ok).map((r) => `${r.id}(${r.scene})`).join(", ")}`
        : caseToolsUsed.length > 0
          ? `有场景动用了 Case 包的工具（${caseToolsUsed.join(", ")}）—— 能力面正在被某个场景反向定义`
          : exclusiveNotScene.length > 0
            ? `独占工具里有非场景工具（${exclusiveNotScene.join(", ")}）—— 它拿不出三场景用例`
            : `这些场景对的工具集互不相交（${pairwiseDisjoint.join(", ")}）—— 那是三座孤岛，不是同一套工具`,
  );

  // ── S12 的护栏总校验
  section("S12：三条数据边界护栏的总校验");
  console.log(
    "   决 3 放开了 workspace 外的读，换来的是三条护栏。\n" +
      "   它们各自的判别力实测在 verify:tools F 段与 verify:artifact D 段；\n" +
      "   这里做的是**在场性**总校验 —— 三条里少任何一条，读放开都该被改回去。\n",
  );
  const { checkReadAllowed, isPrivateAddress } = await import("@workagent/tools-common");
  const g1 = checkReadAllowed("/repo/.env") !== undefined && checkReadAllowed("/repo/.git/config") !== undefined;
  const g2 = isPrivateAddress("127.0.0.1") && isPrivateAddress("169.254.169.254") && !isPrivateAddress("93.184.216.34");
  const { DeclarativeEffectResolver } = await import("@workagent/harness-runtime");
  const eff = new DeclarativeEffectResolver().resolve(
    {
      kind: "DECLARATIVE",
      rule: {
        pointer: "/url",
        effectType: "NETWORK",
        scopeKind: "URL",
        reversibility: "REVERSIBLE",
        operation: "fetch",
      },
    },
    { url: "https://example.com/x?a=1" },
    "/tmp",
  );
  const g3 = eff.riskFacts.includes("EXTERNAL_ENDPOINT") && eff.dataMovement !== undefined;

  fact("护栏 1：读黑名单（.env / .git）", g1 ? "在场" : "缺失");
  fact("护栏 2：私网与回环判定", g2 ? "在场（且不误伤公网地址）" : "缺失或误伤公网");
  fact("护栏 3：URL scope 的 riskFact ＋ dataMovement", g3 ? "在场" : "缺失");
  verdict(
    g1 && g2 && g3,
    g1 && g2 && g3
      ? "三条护栏都在场。决 3 的读放开因此仍然成立 —— 少任何一条都该把它改回一律拒绝"
      : "有护栏缺失，读放开的前提不再成立",
  );
}

void runVerify(main);
