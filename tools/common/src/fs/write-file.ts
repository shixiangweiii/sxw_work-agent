/**
 * write_file —— 覆盖写一个文本文件。【场景工具】
 *
 * 三场景：
 *   办公：产出汇总文档、交接清单、纪要
 *   代码：写一份说明文档、生成配置
 *   聊天：把提取出来的待办写成纪要
 *
 * 形态：幂等（覆盖写同样内容两次 == 一次）＋ 可观察 → §18.2 分支一。
 * 「可观察」的声明保留：`recoveryObservation` 说的是「原则上能不能观察」，
 * 与走哪条分支是两件事，而 Action 级验证仍然要靠它把「写下去的是不是计划的那份」验出来。
 *
 * ── 与阶段 1 的 `write_note` 的差别 ──────────────────────────────────
 *
 * 1. **改名**。`write_note` 是 Micro Case 时期的名字，它暗示「记笔记」，
 *    而这是一个通用的写文件能力。
 * 2. **去掉 `delay_ms`**。那个参数是**测量装置**：`verify:pairing` 的
 *    「工具执行中被 cancel」判据靠它把工具变慢。一个通用工具的入参里
 *    不该有「请慢一点」这种只服务于测量的旋钮 —— 那正是「能力面被
 *    测量需求反向定义」。载体改由 `cases/micro-cases` 的 `slow_write`
 *    承担（阶段 3 方案 §2.1）。
 *
 * 【定】迁移的代价是显式接受的：迁移前的 Run 不能 resume（工具名对不上
 * 冻结在 RunSpec 里的快照）。不做别名表 —— 库里只有开发期 Run，
 * 而别名表是永久负担。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId } from "@workagent/harness-runtime";
import { artifactKindOf } from "../artifact-checks/index.js";
import { cancelledError, classifyFsError, resolveToolPath, writeBoundaryRefusal } from "./fs-common.js";

export const writeFileDefinition: ToolDefinition = {
  id: asId("tool_write_file"),
  version: "1.1.0",
  name: "write_file",
  // 1.1.0：`kindOf` 改为共享的 `artifactKindOf`，`.png` 这类扩展名从
  // `text` 变成 `binary` —— **跑的检查器变了**，是语义变化。
  // 升版本的意义见 run-shell.ts 同一处的【定】（contentHash 目前零消费者）。
  description:
    "把一段文本写入文件，**覆盖**已有内容。path 相对于 workspace 根目录，" +
    "必须落在 workspace 内（写操作不允许越界）。父目录会自动创建。" +
    "只想改文件里的一小段时用 edit_file，不要把整个文件重写一遍。" +
    'artifact_role 用来声明这份文件是本次任务的产物："DELIVERABLE" 表示它就是要交付的东西，' +
    '"INTERMEDIATE" 表示是中间产物。声明之后系统会对它做完整性检查（JSON 能否解析等）。' +
    "只有真正的产出才声明，草稿和临时文件不要声明。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "相对 workspace 根的文件路径" },
      content: { type: "string", description: "要写入的完整文本（会覆盖原内容）" },
      artifact_role: {
        type: "string",
        description: '产物角色："DELIVERABLE"（核心交付物）或 "INTERMEDIATE"（中间产物）。不是产物就不要传',
      },
    },
    required: ["path", "content"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/path",
      effectType: "WRITE",
      scopeKind: "FILE",
      // 覆盖写。不是 IRREVERSIBLE（文件还在），但也不是完全可逆（旧内容没了）。
      reversibility: "PARTIALLY_REVERSIBLE",
      operation: "write",
    },
  },
  redaction: { profile: "STANDARD" },
  /**
   * 【定】幂等。消息级恢复下这个声明是恢复正确性的前提（原则十五）。
   *
   * 覆盖写同样的内容写两次，结果与写一次完全一样 —— 崩溃后**直接重跑**是
   * 安全的，所以它落 §18.2 分支一。
   *
   * ── 它曾经被标成非幂等，那是一句为测量而写的谎（阶段 3 收口批改回）──────
   *
   * 原注释自己承认：「覆盖写严格说是幂等的，这里标成非幂等，是为了让
   * 『非幂等但可观察』这条路径有**通用工具**可测」。而这与本阶段
   * 把 `delay_ms` 赶出本工具、交给 `cases/` 的 `slow_write` 的理由
   * **是同一条纪律** —— 能力面不得被测量需求反向定义，只是那次改的是入参，
   * 这次藏在一个布尔字段里。
   *
   * 后果不是纸面上的：`facade` 的分支判定里 `isIdempotent` 是**第一个**
   * 判别项（决 6 只把「分支二 vs 分支三」挪到了 Action 级事实，
   * 「分支一 vs 其余」仍由这个声明决定）。于是最常用的写工具会把
   * 阶段 2 的研究问题 —— resume 落进哪条分支的分布 —— 系统性地带偏。
   *
   * 分支二现在由 `edit_file` 承载：替换是**相对**操作，它是天然非幂等的，
   * 不需要谁去假装。
   */
  idempotency: { isIdempotent: true, isReadOnly: false },
  timeoutPolicy: { timeoutMs: 60_000 },
  progressReporting: { mode: "NONE" },
  verification: {
    mode: "REOBSERVE",
    // 唯一能把 SUCCESS 降级为 COMPLETED_WITH_LIMITS 的开关
    requiredForSuccess: true,
  },
  /**
   * 覆盖写崩溃后可观察，且**不需要**执行前指纹（决 6）：
   * 目标内容是绝对的（== 计划内容），不像 append 那样取决于起始状态。
   */
  recoveryObservation: { requiresPreFingerprint: false },
};

/**
 * 从路径后缀推产物类型，决定跑哪些 Artifact 级检查器。
 *
 * 【定】只认后缀，**不看内容**。看内容去猜类型的话，一份坏掉的 JSON
 * 会被判成 text 从而跳过 JSON 检查 —— 而那恰恰是最需要被抓住的情况：
 * 检查器会在最该报警的时候安静下来。
 *
 * 【定】实现搬去了 `artifact-checks/artifactKindOf`，这里只留转发（ADR-0010）。
 * 搬家的理由：`run_shell` 也要推 kind，而这张表抄第二份的后果是
 * 两个工具对同一个扩展名跑不同的检查器，**且两边都是绿的**。
 * 它住在检查器旁边是因为 kind 的全部意义就是决定跑哪些检查器。
 */
const kindOf = artifactKindOf;

export async function executeWriteFile(
  input: { path: string; content: string; artifact_role?: string },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const target = resolveToolPath(ctx.workspaceRoot, input.path);

  // 【定】写保留 workspace 边界（决 3）。这是执行侧的第二道，
  // EffectResolver ＋ Policy 已经算过一次 —— 两道都不能省（V05 §22.1）。
  // 【定】判定走 `writeBoundaryRefusal`（唯一一份），不要在这里内联 ——
  // ADR-0012 加了 executionPrivilege 这一维，四个写工具漏改任何一处就会分叉。
  const refusal = writeBoundaryRefusal(ctx, target, "写入", input.path);
  if (refusal) {
    return { ok: false, output: "", sideEffectState: "NO_EFFECT", error: refusal };
  }

  // 【定】走 `cancelledError`（唯一一份），不要内联 —— 与 `writeBoundaryRefusal`
  // 同一条理由：四个写工具各抄一遍，改其中一个时另外三个不会有任何征兆。
  if (ctx.signal.aborted) {
    return { ok: false, output: "", sideEffectState: "NOT_STARTED", error: cancelledError("write_file") };
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content, "utf8");

    /**
     * §17：产物由**工具显式声明**后登记，Runtime 不扫 workspace 自动派生。
     *
     * 【定】只认 DELIVERABLE / INTERMEDIATE 两个值，别的一律不当产物。
     * 宽松匹配（「只要传了就算产物」）会让模型随手传个 "yes" 就登记一份
     * 交付物，而 DELIVERABLE 的检查失败会把整个 Run 判成 FAILED ——
     * 一个拼错的参数值不该有这么大的后果。
     */
    const role =
      input.artifact_role === "DELIVERABLE"
        ? ("DELIVERABLE" as const)
        : input.artifact_role === "INTERMEDIATE"
          ? ("INTERMEDIATE" as const)
          : undefined;

    return {
      ok: true,
      output: `已写入 ${input.path}（${Buffer.byteLength(input.content, "utf8")} 字节）`,
      sideEffectState: "APPLIED",
      ...(role
        ? {
            artifact: {
              // logicalId 用相对路径：「同一个文件被改了两次」是版本链最自然的来源。
              logicalId: input.path,
              role,
              kind: kindOf(input.path),
              path: input.path,
              content: input.content,
            },
          }
        : {}),
    };
  } catch (err) {
    return {
      ok: false,
      output: "",
      // 写到一半失败，无法确认磁盘上是什么状态。
      // 【定】UNKNOWN 不得自动重试（不变量 10）。
      sideEffectState: "UNKNOWN",
      error: { ...classifyFsError(err, `写入 "${input.path}"`), sideEffectState: "UNKNOWN" },
    };
  }
}

/**
 * 独立 Verification（V05 §15.1）：Tool Handler 的 "success" 不能替代它。
 * 这里真去读文件，而不是相信上面的返回值 —— 这正是「REOBSERVE」的含义。
 */
export async function verifyWriteFile(
  input: { path: string; content: string },
  ctx: ToolExecutionContext,
): Promise<{ ok: boolean; detail: string }> {
  const target = resolveToolPath(ctx.workspaceRoot, input.path);
  try {
    const actual = await readFile(target, "utf8");
    if (actual === input.content) {
      return { ok: true, detail: `重新读取 ${input.path}，内容与预期一致（${actual.length} 字符）` };
    }
    return {
      ok: false,
      detail: `重新读取 ${input.path}，内容与预期不一致：期望 ${input.content.length} 字符，实际 ${actual.length} 字符`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `重新读取 ${input.path} 失败：${String((err as Error).message).slice(0, 120)}`,
    };
  }
}

export const writeFileSnapshot: ToolSnapshot = {
  toolId: writeFileDefinition.id,
  version: writeFileDefinition.version,
  definition: writeFileDefinition,
};
