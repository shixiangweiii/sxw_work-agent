/**
 * Run 领域模型（V05 §7.7、§10）。
 */

import type {
  ActionId,
  AgentSpecId,
  EndpointId,
  JsonValue,
  RunId,
  RunSpecId,
  Timestamp,
  WorkspaceId,
} from "./ids.js";
import type { EndpointCapabilityProfileSnapshot } from "./endpoint.js";
import type { RuntimeErrorRecord } from "./error.js";
import type { ToolSnapshot, VerificationResult } from "./tool.js";
import type { ContextBudgetPolicy } from "./context.js";

// ───────────────────────────────────────────────────────── AgentSpec

/**
 * 本次 Run 的执行特权档位（ADR-0012）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】Runtime 只认得这两个值，**不知道"沙箱"是怎么实现的**。
 *
 * 名字刻意是 Runtime 自己的词而不是 `sandboxMode`：sbpl profile 的生成、
 * `sandbox-exec` 的调用、命令解析全都住在 `tools/common/src/exec/`，
 * 边界 grep 第 7 条（`sandbox-exec|analyzeCommand|sbpl` 不得进 packages）
 * 守的就是这条。这里传递的是一个**档位**，工具侧自己决定它意味着什么 ——
 * 与 `VerificationPort` / `artifactChecks` 同构。
 *
 * 【定】它必须**随 RunSpec 冻结**，理由与隔壁的 `timezone` 一字不差：
 * resume 会用今天的档位去接一条昨天的 transcript，而盘上看不出来。
 * 更糟的是这个字段决定的是"那些副作用当时有没有边界"——
 * 一条在 UNRESTRICTED 下跑出来的 transcript，若 resume 时被当成 SANDBOXED，
 * 事后没有任何东西能说出真相。
 *
 * 【定】不给"每次调用一个档位"的自由度。逐次可变意味着同一个工具在同一个
 * Run 里声明相同而行为不同，而 §18.2 的三条恢复分支读的是冻结的工具声明。
 * ══════════════════════════════════════════════════════════════════════
 */
export type ExecutionPrivilege =
  /** 默认。工具侧的沙箱与 workspace 写边界全部生效。 */
  | "SANDBOXED"
  /** ADR-0012：沙箱不生效，`policy` 不再拒绝越界写。唯一还在的闸门是审批和人。 */
  | "UNRESTRICTED";

/** 从反序列化得到的 AgentSpec 严格读取执行特权档位。 */
export function executionPrivilegeOf(agentSpec: AgentSpecSnapshot): ExecutionPrivilege {
  const raw = agentSpec.executionPrivilege as unknown;
  /**
   * 【定】缺失、null、拼错的枚举和截断字符串全部视为损坏，不做旧数据降级。
   *
   * 后果具体：一条本来 UNRESTRICTED 的 Run 记录损坏后被读成 SANDBOXED，
   * 而 §18.3 第三维闸门比的正是这个值 —— 于是它用 `--sandbox on` 恢复时
   * **闸门会放行**，那条 transcript 从此在盘上自称"一直有沙箱"。
   * 这与 current-only 的「不保留兼容层、损坏数据 fail-fast」是同一条纪律。
   */
  if (raw === "SANDBOXED" || raw === "UNRESTRICTED") return raw;
  throw new Error(
    `RunSpec 的 executionPrivilege 是一个非法值：${JSON.stringify(raw)}（agentSpec ` +
      `${String(agentSpec.agentSpecId)}）。合法值只有 "SANDBOXED" / "UNRESTRICTED"。\n` +
      `这条记录已经损坏 —— 不按 SANDBOXED 兜底，因为兜底会让「这个 Run 当时到底` +
      `有没有沙箱」永久失真，而 §18.3 的第三维闸门比的正是这个值。`,
  );
}

export interface ModelConfigurationSnapshot {
  endpointId: EndpointId;
  modelId: string;
  parameters: Record<string, JsonValue>;
  endpointProfileRef: string;
}

export interface AgentSpecSnapshot {
  agentSpecId: AgentSpecId;
  version: string;
  model: ModelConfigurationSnapshot;
  systemPrompt: string;
  /**
   * IANA 时区名（如 "Asia/Shanghai"）。用于把 ClockPort 的时间戳渲染成
   * 模型能读的受信时间事实（见 context/compile.ts 的 buildFrame）。
   *
   * 【定】它属于 AgentSpec 而不是运行期环境变量 —— 一个 Run 看到的时间口径
   * 必须随 RunSpec 冻结，否则 Replay 会在不同时区下重放出不同的上下文。
   */
  timezone: string;
  /**
   * 本次 Run 的执行特权档位（ADR-0012）。见 `ExecutionPrivilege`。
   *
   * 【定】反序列化后的读取一律走 `executionPrivilegeOf()`，让缺失或非法值
   * fail-fast；不能靠 TypeScript 断言把损坏的 JSON 当成合法快照。
   */
  executionPrivilege: ExecutionPrivilege;
  toolSnapshots: ToolSnapshot[];
  contextPolicy: ContextBudgetPolicy;
  loopPolicy: LoopPolicySnapshot;
  approvalPolicy: ApprovalPolicySnapshot;
}

/**
 * 循环自身的重试上限。
 *
 * 【定】**不含 `maxTurns` / `maxConsecutiveFailures`** —— 那两条是**预算轴**，
 * 权威副本在 `RunBudgets` 里，执行期读的也是那边（`checkBudgets`）。
 * 这里此前抄了一份同名字段、零读取点，于是「改哪个才生效」有两个答案，
 * 而只改错的那个不会有任何征兆。
 */
export interface LoopPolicySnapshot {
  maxModelErrorRetries: number;
  maxOutputLimitRecoveries: number;
}

export interface ApprovalPolicySnapshot {
  /** 需要审批的 effectType。TRUSTED_PERSONAL preset 下只有写与删。 */
  requiresApprovalFor: string[];
  /**
   * 审批等待超时（U-2）。不设＝永远等。
   *
   * 【定】超时的语义是**拒绝**，不是批准。没人应答不能当作默许 ——
   * 那会让「写操作要人确认」这条闸门在无人值守时自动敞开，
   * 而无人值守恰恰是最不该敞开的场景。
   */
  approvalTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────── Budget

export interface RunBudgets {
  maxTurns: number;
  /** 只累计 RUNNING 且有在途步骤的时间。WAITING_* 不累计。 */
  maxActiveWallClockMs: number;
  maxTotalWallClockMs?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  /**
   * 【定】名字里的 **billed** 不是修饰，是口径：它限制的是
   * `BudgetUsage.billedInputTokens`（含缓存读写两项），不是 `inputTokens`。
   *
   * 两者在命中前缀缓存时差 5 倍以上 —— 此前这条轴叫 `maxInputTokens`
   * 而读的是 billed，靠一行注释维持，而注释拦不住下一个照字面配置的人。
   */
  maxBilledInputTokens?: number;
  maxOutputTokens?: number;
  maxConsecutiveFailures: number;
  softLimitRatio: number;
}

export interface BudgetUsage {
  turns: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  billedInputTokens: number;
  activeWallClockMs: number;
  startedAt: Timestamp;
}

/**
 * resume() 必须继承的已完成事实（V05 §18.4【定】：
 * 「保留 RunId、RunSpec、已完成副作用**和预算使用**」）。
 *
 * 它不是 LoopState 的快照 —— 恢复仍然走 transcript，messages 从条目重建。
 * 这里只装那些**无法从消息序列反推**的累计量：花掉的 token、走过的轮次、
 * 已经付费测出来的 Verification 事实、以及尚未销账的 RecoveryItem。
 *
 * 【定】它必须落在 transcript 上（RUN_META 条目），不能只留在内存里。
 * 否则「反复 crash + resume」就能把预算清零，硬墙形同虚设。
 */
export interface ResumableRunFacts {
  turnCount: number;
  consecutiveFailures: number;
  budgetUsage: BudgetUsage;
  verifications: VerificationResult[];
  recoveryItems: RecoveryItem[];
  /**
   * 事件/transcript 共用序列的高水位（D-2）。
   *
   * 【定】必须落盘。事件从这条序列取号但**不落 transcript**，所以重启后
   * 单看 transcript 的最后一条只能得到一个下界 —— 从那里续号会把上一段
   * 已经发给 Trace 的号重发一遍，两份 trace 拼起来就对不上了。
   *
   * 这是「消息级恢复」这个选择的又一处代价：能从消息序列反推的都不用存，
   * 反推不出来的必须显式存（与 budgetUsage / turnCount 同理）。
   */
  lastSequence: number;
  /**
   * §18.2 三条分支各命中过多少次（阶段 2 的**测量装置**）。
   *
   * ── 它是阶段 2 研究问题的唯一出口 ──────────────────────────────────
   *
   * Roadmap §4 的研究问题是「跑够多真实任务，统计有多少次 resume() 落进
   * 『非幂等且不可观察』那条分支」。比例低说明消息级恢复的粒度选对了。
   *
   * 【定】阶段 2 只建**测量装置**，不出结论（Roadmap §4 的 B 方案）。
   * 故障注入跑出来的是**构造分布**，不是真实分布 —— 真实分布要等阶段 3
   * 有真工具。所以这个字段可以被 Eval 导出，但导出的数字不足以支撑
   * 「恢复粒度选对了」这句话。
   */
  resumeBranchCounts?: Record<string, number>;
  /**
   * Artifact 级检查的结果（阶段 3 S8，§10.4 第二层）。
   *
   * 【定】它与 `verifications` **分开存**，不是懒得合并。
   *
   * 两层问的不是同一个问题（一层问「这一步的副作用达成没有」，
   * 二层问「这个产物本身完不完整合法」），而**结算映射也不同**：
   * 二层还要按 `role` 分流（DELIVERABLE 失败 → FAILED，
   * 其余失败 → COMPLETED_WITH_LIMITS）。`VerificationResult` 里没有
   * role 这个维度，硬塞进去就得再加一个字段，然后一层的代码要开始判
   * 一个跟它无关的字段 —— 那正是「两层互相替代」的开始。
   */
  artifactChecks?: ArtifactCheckFact[];
}

/**
 * 一次 Artifact 级检查的事实（§10.4 第二层）。
 *
 * 【定】`checksRun` 为空**不等于**通过 —— 那是「没有适用的检查器」。
 * 两者必须分得开，否则「我们验过了」这句话会被一个空集合背书。
 */
export interface ArtifactCheckFact {
  artifactId: string;
  logicalId: string;
  role: "DELIVERABLE" | "INTERMEDIATE";
  ok: boolean;
  checksRun: string[];
  detail: string;
  at: Timestamp;
}

// ───────────────────────────────────────────────────────── RunSpec

/**
 * 这个 Run 是**谁发起的**。
 *
 * ── 【定】`WEB` 是阶段 4 之后补上的，补它的理由值得写下来 ───────────────
 *
 * 阶段 4 加了白盒界面之后，Web 起的 Run 在 RunSpec 里**一律被记成 `CLI`** ——
 * 因为 `makeRunSpec()` 把 `kind: "CLI"` 写死了，而 `workagent-service` 直接
 * 复用它。这个字段在全仓有**一个生产者、零消费者**，于是没有任何东西能与
 * 它矛盾：一个恒定的常量与一个正确的值，在「没人读」的前提下不可区分。
 *
 * 它不影响任何执行事实，但会污染 Replay、归档与**正式评测的归因** ——
 * 决 4 把评测推到开发完成之后，那批数据读入口身份读的正是这里。
 *
 * 【定】判据在 `verify:ui`：Web 起的 Run 的 `origin.kind` 必须是 `WEB`。
 * 判据比枚举值本身重要 —— 补一个枚举值容易，让它不再退回常量要靠那条判据。
 */
export type RunOrigin =
  | { kind: "CLI"; invokedAt: Timestamp }
  | { kind: "WEB"; invokedAt: Timestamp }
  | { kind: "EVAL"; invokedAt: Timestamp };

export interface RunInput {
  task: string;
}

export interface WorkspaceExecutionSnapshot {
  workspaceId: WorkspaceId;
  /** 授权的根目录。ResolvedEffect 必须是它的子集。 */
  mounts: Array<{ mountId: string; absolutePath: string; writable: boolean }>;
}

/**
 * 自包含 —— Runtime 执行期间不需要回查 Layer 2。
 *
 * 判据：逐 Run 变化的进 RunSpec，不变的不进。
 * 完成判定规则对所有 Run 都一样，因此不在这里（V05 §10.4）。
 */
export interface RunSpec {
  id: RunSpecId;
  origin: RunOrigin;
  input: RunInput;
  agentSpec: AgentSpecSnapshot;
  /**
   * 冻结的理由：Replay 要求「用当时的条件重放」。如果端点行为只存在于运行时配置里，
   * 三个月后 Replay 一个旧 Run 用的是今天的端点行为 —— 而实测表明端点行为会变。
   */
  endpointProfile: EndpointCapabilityProfileSnapshot;
  /**
   * 【定】必填。它是 §18.3 第二维闸门（`assertResumeWorkspaceMatches`）的被比对方 ——
   * 可选意味着「有一档没有身份可比」，而那一档只能放行，闸门就此有洞。
   */
  workspace: WorkspaceExecutionSnapshot;
  budgets: RunBudgets;
  createdAt: Timestamp;
}

// ────────────────────────────────────────────────── Status & Outcome

/**
 * 没有 PAUSED —— 消息级恢复下它与「cancel() 后稍后 resume()」行为一致。
 * 也没有 CREATED：`createRun()` 一律以 RUNNING 落库，没有第二个起点。
 *
 * WAITING_FOR_* 不是「循环停下来等一个 durable request」，而是循环阻塞在一个 await 上。
 * 状态值保留是给 Layer 2 与 UI 用的，不驱动调度。
 *
 * 【定】这里只放**有写入点**的值。`WAITING_FOR_USER` 在此之前挂了四个阶段，
 * 全仓零生产者，而 UI 的可恢复状态表照抄了它 —— 一个永远不会出现的分支
 * 被当成产品行为维护着。
 */
export type RunStatus =
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_INTERACTION"
  | "RECOVERY_REQUIRED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface IncompleteItem {
  what: string;
  why: string;
  actionId?: ActionId;
}

export interface RecoveryItem {
  what: string;
  sideEffectState: string;
  actionId?: ActionId;
  toolCallId?: string;
}

export interface RunOutcome {
  kind:
    | "SUCCESS"
    | "COMPLETED_WITH_LIMITS"
    | "USER_REJECTED"
    | "BUDGET_EXHAUSTED"
    | "CONTEXT_EXHAUSTED"
    /** 与 CONTEXT_EXHAUSTED 分开：后者必须压缩上下文，前者压缩没用。 */
    | "QUOTA_EXHAUSTED"
    | "CANCELLED"
    | "FAILED";
  summary?: string;
  deliveredArtifactIds: string[];
  incompleteItems: IncompleteItem[];
  recoveryItems: RecoveryItem[];
  error?: RuntimeErrorRecord;
}

/** 只读投影，不是恢复来源。恢复走 transcript。 */
export interface RunSnapshot {
  runId: RunId;
  runSpecId: RunSpecId;
  status: RunStatus;
  turnCount: number;
  consecutiveFailures: number;
  budgetUsage: BudgetUsage;
  messageCount: number;
  /**
   * 【定】它是**这次 inspect 的时刻**，不是 Run 最近一次状态更新的时刻。
   * 此前叫 `updatedAt`，而值是 `clock.now()` —— 名字承诺的是一个持久化事实，
   * 给的是一个每次读都不同的数。要「最近更新时刻」请读 `RunListItem.updatedAt`，
   * 那个才来自 `runs.updated_at`。
   */
  inspectedAt: Timestamp;
  /**
   * §18.2 三条分支各命中过多少次。**阶段 2 测量装置的对外出口。**
   *
   * 它在 `ResumableRunFacts` 里落了盘（那条注释还写着「可以被 Eval 导出」），
   * 但一直没有出口 —— Eval 全目录零命中，而阶段 2 的退出门槛
   * 「分支分布测量装置可用」写的是「分支计数落 transcript **＋ Eval 能导出分布**」。
   * 后半句当时没做到，门槛却标了绿（P1-2）。
   *
   * 【定】出口必须在 Facade 上。§24.1 要求 Eval 只经 Facade、不碰 Runtime 私有类 ——
   * 让 Eval 自己去读 transcript 的 RUN_META，等于把测量装置和被测对象焊在一起。
   */
  resumeBranchCounts: Record<string, number>;
  /**
   * 未达成的必需项按**成因**聚合（`USER_REJECTED` / `TOOL_FAILED` / …）。
   *
   * 与 `outcome.kind` 是两件事：后者只说「没全做成」，这里说「是哪一类没做成」。
   * ADR-0001 决定不扩 `outcome.kind` 的值域，代价就是「是谁没做成」只能从
   * 事实表里聚合 —— 这就是那个聚合。
   */
  unmetCauseCounts: Record<string, number>;
}

// ─────────────────────────────────────────────────────────── Usage

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /**
   * 派生字段。只读 inputTokens 会在缓存命中时低估达 85%，
   * 因为命中时 inputTokens 只剩非缓存部分。
   */
  billedInputTokens: number;
}
