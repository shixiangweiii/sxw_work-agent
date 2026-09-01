/**
 * Tool、Effect 与 Action 类型（V05 §12）。
 */

import type {
  ActionBatchId,
  ActionId,
  AttemptId,
  JsonValue,
  RunId,
  Timestamp,
  ToolId,
  VersionedRef,
} from "./ids.js";
import type { RuntimeErrorRecord, SideEffectState } from "./error.js";

// ─────────────────────────────────────────────────────────── Effect

export type EffectType = "READ" | "WRITE" | "DELETE" | "EXECUTE" | "NETWORK" | "NONE";

export interface EffectScope {
  /**
   * ── `EXTERNAL_TOOL`：外部 MCP 服务器执行的工具 ────────────────────────
   *
   * 【定】它**不能**并进 `PROCESS`，虽然两者都是"跑一个外部东西"。
   *
   * 理由不在语义，在**审批展示**：`main.ts` 与 `human-channels.ts` 都按
   * `scope.kind` 分派展示内容，而 `PROCESS` 那一支是 `run_shell` 专属的 ——
   * 它读 `input["command"]`，并打印「沙箱：只能写 workspace 与本次调用的
   * $TMPDIR；禁止联网」。**MCP 工具没有任何沙箱**，复用 PROCESS 的后果是
   * 人在批准的那一刻看到一句方向相反的保证。
   *
   * `main.ts` 那段注释写着「按 scope.kind 判而不是按工具名判 —— 将来任何一个
   * PROCESS scope 的工具都自动获得同样的展示」。那句话是对的，而这正是它的
   * 代价：展示按 scope 泛化，内容却按工具特化。加一个 kind 是唯一诚实的出路。
   */
  kind: "FILE" | "DIRECTORY" | "URL" | "PROCESS" | "EXTERNAL_TOOL" | "NONE";
  /** 规范化语义对象，不以自由文本作为授权边界。 */
  value: string;
}

export interface DataMovementDescriptor {
  destination: string;
  scope: string;
}

export interface ResolvedEffect {
  effectType: EffectType;
  operation: string;
  scope: EffectScope;
  reversibility: "REVERSIBLE" | "PARTIALLY_REVERSIBLE" | "IRREVERSIBLE";
  /**
   * 这次调用把数据发去了哪里（护栏 3）。
   * 【定】它与 `riskFacts` 一起进 `ActionProposed` 事件 —— 那是
   * `policy.ts` 「让外发在 Trace 上可审计」这句话唯一的兑现处。
   */
  dataMovement?: DataMovementDescriptor;
  riskFacts: string[];
  digest: string;
}

export interface DeclarativeScopeRule {
  /** JSON Pointer 指向输入里的目标字段。 */
  pointer: string;
  effectType: EffectType;
  scopeKind: EffectScope["kind"];
  reversibility: ResolvedEffect["reversibility"];
  operation: string;
}

/**
 * 【定】DECLARATIVE 那一档是**单条**规则，不是数组。
 *
 * 此前是 `rules: DeclarativeScopeRule[]`，而解析器只读 `rules[0]` ——
 * 谁写第二条会被静默丢弃，而这里恰好是 §12.4「不以自由文本作为授权边界」
 * 最不能出错的地方：被丢掉的那条规则可能正是限制写入范围的那条。
 */
export type EffectResolutionDescriptor =
  | { kind: "DECLARATIVE"; rule: DeclarativeScopeRule }
  | { kind: "RESOLVER"; resolverRef: VersionedRef<unknown> };

// ─────────────────────────────────────────────────────── Descriptors

export interface RedactionDescriptor {
  /** 必填。不声明的 Tool 走默认最严格 profile，而不是默认放行。 */
  profile: "STRICTEST" | "STANDARD" | "NONE";
  fieldsToRedact?: string[];
}

/**
 * 消息级恢复把它从可选优化属性抬成了恢复正确性的前提（原则十五）。
 * resume() 无法区分「工具跑没跑」，只能靠这个声明与 Observation 逼近。
 */
export interface IdempotencyDescriptor {
  isIdempotent: boolean;
  isReadOnly: boolean;
}

export interface TimeoutPolicy {
  timeoutMs: number;
}

/**
 * 这个工具执行期间回不回报进展（`ctx.onProgress`）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】三种 mode 的语义（阶段 3 收口批补 —— 在此之前一个字都没定义）：
 *
 *   NONE               不回报。**允许**实现里偶尔报一两次（少做多不算错），
 *                      但不承诺任何节奏。
 *   HEARTBEAT          执行期间**周期性**回报「我还活着」。
 *   MONOTONIC_PROGRESS 回报**单调递增**的进度量（已处理 N / 共 M）。
 *
 * 【定】这个描述符里**只有 `mode`，没有 `intervalMs`** ——「间隔上界是多少」
 * 曾经是一个字段，2026-08-31 那批因为零读取点删掉了。这段注释此前还写着
 * 「`intervalMs` 是两次之间的间隔上界」，而实现里已经没有那个东西：
 * 又一处「声明与实现不符」，只是这次声明是一句描述另一个字段的话。
 * 节奏由工具自己定（`run_shell` 是 5s），Runtime 不校验它。
 *
 * ── 为什么这三行值得写下来 ────────────────────────────────────────────
 *
 * 没有它们的时候，`read_file` 与 `search` 都声明了 `HEARTBEAT 30s`，
 * 而两个文件里**一次 `ctx.onProgress` 都没有** —— 声明与实现的距离
 * 没有任何判据量得出来，读代码的人会以为大文件读取是被监控的。
 *
 * 【定】所以还有一条机械判据：`mode !== "NONE"` 的工具，源码里必须存在
 * `ctx.onProgress(` 调用点（`verify:tools` B 段扫描，缺一即红）。
 * ══════════════════════════════════════════════════════════════════════
 */
export interface ProgressReportingDescriptor {
  mode: "NONE" | "HEARTBEAT" | "MONOTONIC_PROGRESS";
}

/** 【定】值域只放**有实现**的两档。`INLINE_RESULT` / `CUSTOM_VERIFIER` 零生产者。 */
export interface VerificationDescriptor {
  mode: "NONE" | "REOBSERVE";
  /** 唯一一个能把 SUCCESS 降级为 COMPLETED_WITH_LIMITS 的信号（V05 §10.4）。 */
  requiredForSuccess: boolean;
}

/**
 * JSON Schema。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它有**两个使用者，纪律相反**，这一点不能混：
 *
 *   Atlas 自家工具 —— 只用扁平标量子集（string / number / boolean）。
 *                     由 `verify:tools` B4 段的机械判据钉住，写宽了就翻红。
 *   外部工具（MCP）—— 原样携带服务器给的**完整** JSON Schema，
 *                     Atlas 一个字都不解析，只透传给模型。
 *
 * ── 为什么是"放开索引签名"而不是"枚举支持哪些构造" ──────────────────────
 *
 * 参照 opencode 的 `convertTool`：它之所以能"换个 MCP 只改配置"，
 * 是因为它**从不试图理解那个 schema** —— 原样交给下游。
 * 反过来，"支持 array / object / enum" 这种写法有一个致命性质：
 * **永远有下一个构造**（`$ref` / `oneOf` / `prefixItems` / …），
 * 而下一个构造就是下一次"接个新 MCP 得改 Atlas 代码"。
 *
 * 代价如实记：索引签名让 Atlas 自家工具的**关键字拼写错误**（`descripton`）
 * 不再被编译器抓住。这不是不管了 —— 换成了 `verify:tools` B4 那条判据，
 * 它比类型系统管得更宽（还能一起判"自家工具不许用非标量"）。
 * ══════════════════════════════════════════════════════════════════════
 */
export interface JsonSchema {
  type: "object";
  /**
   * 【定】**可选**。「服务器没给 properties」与「服务器给了一个空 properties」
   * 是两件事，而合并它们会造成一次静默的数据丢失。
   *
   * 根级 `$ref` / `oneOf` / `additionalProperties` / `patternProperties` 形态的
   * schema **根本没有** `properties`，参数不展开在根上。此前 Atlas 会在翻译时
   * 伪造一个空的补上，然后 `validateAndNormalize` 按这份**自己伪造的** schema
   * 把模型的入参全部裁掉 —— 校验通过、`normalized` 为 `{}`、下游收到空对象，
   * 一路没有任何报错。
   *
   * 那正是本仓反复猎杀的形态：**一边声称「从不解析外部 schema」，一边用一个
   * 只有解析过才成立的假设去改写模型的意图。**
   */
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  /**
   * 外部 schema 的其余顶层关键字（`additionalProperties` / `$defs` / `oneOf` / …）
   * 原样保留、原样发给模型。
   *
   * 其中 `additionalProperties` 是**唯一一个 Atlas 真的会读**的：它按 JSON Schema
   * 的标准语义决定「`properties` 之外的键要不要丢」。见 `validateAndNormalize`。
   */
  [keyword: string]: unknown;
}

export interface JsonSchemaProperty {
  /**
   * 【定】可选，且不是字面量联合。
   *
   * 两条都由外部 schema 的真实形态逼出来：
   *   · `type` 可以**缺失**（`oneOf` / `anyOf` / `$ref` 形态的属性）；
   *   · `type` 可以是**数组**（`["string","null"]`）。
   *
   * 硬要求它是三个字面量之一，会让一个只有某个参数不合口味的 MCP 服务器
   * **整个装不上**，而那个参数模型本来可能根本不用。
   * Atlas 的校验策略因此是：认识的形态照校，不认识的**原样放行**
   * （见 `validateAndNormalize`）。
   */
  type?: string | string[];
  description?: string;
  /** `items` / `enum` / `properties` / `$ref` … 原样保留，原样发给模型。 */
  [keyword: string]: unknown;
}

/**
 * 【定】这里只放**Runtime 真的会读**的声明。
 *
 * 此前还有 `requiredCapabilities` / `retryPolicy` / `cancellation` /
 * `concurrency` 四项：14 个工具逐个认真填值，Runtime 侧零消费点。
 * 后果不是浪费几行 —— 是工具作者会以为 Harness 已经提供了重试、
 * 能力校验、协作式取消与并发保护。**声明了却不生效比不声明更危险。**
 * 真要做它们时，第一步是写消费者，不是补声明。
 */
export interface ToolDefinition {
  id: ToolId;
  version: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  effectResolution: EffectResolutionDescriptor;
  /** 必填（V05 §12.3）。 */
  redaction: RedactionDescriptor;
  idempotency: IdempotencyDescriptor;
  timeoutPolicy: TimeoutPolicy;
  progressReporting: ProgressReportingDescriptor;
  verification: VerificationDescriptor;
  /**
   * 崩溃后能不能观察（决 6，阶段 2 新增）。
   *
   * ── 它为什么不能和 `verification` 是同一个字段 ────────────────────────
   *
   * 阶段 1 用 `verification.mode !== "NONE"` 回答「§18.2 该走哪条分支」，
   * 而那个字段说的是「**执行后**能不能验」。两件事真的不同：
   *
   *   `append_log` 执行后验不了（验证器不知道「该有几行」），
   *   但崩溃后能不能观察，取决于**执行前有没有留下前置指纹**。
   *
   * 更要紧的是：阶段 2 的研究问题正是「有多少次 resume 落进第三条分支」，
   * 而分流依据就是这个字段 —— 测量仪器和被测对象是同一个旋钮。
   *
   * 那个旋钮真的被拧过：`write_note`（今天的 `write_file`）的 idempotency
   * 注释曾经自己承认「覆盖写严格说是幂等的，标成非幂等是为了让分支二有
   * 工具可测」。**阶段 3 收口批把它改回了诚实值**，分支二改由天然非幂等的
   * `edit_file` 承载。这段历史留在这里，因为它说明了这类偏移的形状：
   * 它藏在一个布尔字段里，不会报错，只会让研究问题的数据悄悄失真。
   *
   * 注意决 6 只把「分支二 vs 分支三」挪到了 Action 级事实 ——
   * 「分支一 vs 其余」至今仍由 `idempotency.isIdempotent` 这个**静态声明**
   * 决定。所以那个字段必须是事实，不能是为了测量而写的。
   *
   * 【定】声明它**不等于**崩溃后一定观察得了。真正的判据是 Action 级事实
   * （transcript 里那条 `ACTION_FACT`），不是这里。这个字段只说明
   * 「这个工具**原则上**可以这么观察」。
   *
   * ── 阶段 3：去掉 `?`，由类型强制而不是靠纪律（§2.2）─────────────────
   *
   * 阶段 2 它是可选的，靠 verify 扫描兜底。而 §2.2 把它列为
   * `ToolDefinition` 三个必填项之一 —— 一个「必填但类型上可选」的字段，
   * 在新增 10 个工具的这一批里必然会被漏掉一两个，而漏掉的后果是
   * **那个工具永远落进 §18.2 第三条分支**（`canObserve` 的第一个合取项
   * 就是 `!!def?.recoveryObservation`），且盘上看不出来。
   *
   * 让编译器管这件事，比让 verify 事后发现便宜得多。
   */
  recoveryObservation: RecoveryObservationDescriptor;
  /**
   * 这个工具在执行期间**等人**（阶段 3 S10，§20 人工接管）。
   *
   * Runtime 据此做两件事：
   *   ① 把 Run 切到 `WAITING_FOR_INTERACTION`；
   *   ② 把这段等待从 `activeWallClockMs` 里扣掉。
   *
   * ── 【定】它是**声明**，不是工具名判定 ──────────────────────────────
   *
   * 最直接的写法是 `if (toolName === "request_handoff")`，而那会让 Runtime
   * 认识一个具体工具 —— 边界 4 要守的正是这件事（`packages/harness-runtime/`
   * 不得 import 任何工具实现；认识工具名是同一条线的另一种越界，
   * 只是 grep 抓不到它）。用声明驱动的话，将来任何一个「要等人」的工具
   * 都自动获得同样的处置，而 Runtime 一行都不用改。
   *
   * ── 为什么不复用 `progressReporting` 或 `timeoutPolicy` ──────────────
   *
   * 那两个说的是「它慢」。**慢与等人不是一回事**：一个 30 秒的下载不该让
   * Run 进入 WAITING 状态，也不该把那 30 秒从预算里扣掉 —— 那 30 秒是
   * Agent 在干活。只有「在等外部世界里的人」才该两者都做。
   */
  waitsForHumanInteraction?: boolean;
}

/**
 * 崩溃后观察的声明。
 *
 * 【定】只剩 `requiresPreFingerprint` 一个字段 —— 它是 §18.2 分支二判定的
 * 合取项之一，有真实读取点。此前还有一个 `kind`（TARGET_EXISTS /
 * TARGET_CONTENT_HASH / TARGET_APPEND_TAIL），两个 Verifier 都按
 * `action.toolName` 分支，谁都没读过它。
 */
export interface RecoveryObservationDescriptor {
  /**
   * 观察是否**必须**有执行前指纹才成立。
   *
   * false：像 write_note 那样「目标内容 == 计划内容」就能判定，不需要前置状态；
   * true ：像 append_log 那样的**相对**操作 —— 目标状态取决于起始状态，
   *        没有起始状态的指纹就无从判断那一行到底追加了没有。
   */
  requiresPreFingerprint: boolean;
}

/**
 * 【定】没有 `contentHash`。
 *
 * 它此前是 `${name}@${version}` —— 一个叫 hash 的字段装着版本标签，
 * 且全仓零读取点。真正的内容身份由 `store-sqlite/run-repository` 对
 * 序列化后的 AgentSpec 现算（那才是 `agent_spec_snapshots` 的主键）。
 * 留着它只会让人以为已经有了内容寻址保证。
 */
export interface ToolSnapshot {
  toolId: ToolId;
  version: string;
  definition: ToolDefinition;
}

// ────────────────────────────────────────────────────────── Action

export type ActionStage =
  | "PROPOSED"
  | "REJECTED_SCHEMA"
  | "REJECTED_POLICY"
  | "REJECTED_APPROVAL"
  | "PREPARED"
  | "EXECUTING"
  | "SETTLED";

export interface ProposedAction {
  id: ActionId;
  runId: RunId;
  batchId: ActionBatchId;
  batchIndex: number;
  /**
   * 配对锚点。在选定端点上无外部校验 —— 篡改后 200 接受。
   * 它是 Runtime 的自我约定，Runtime 必须自己保证一致性。
   */
  toolCallId: string;
  toolName: string;
  rawInput: unknown;
  stage: ActionStage;
  createdAt: Timestamp;
}

export interface PreparedAction extends ProposedAction {
  normalizedInput: JsonValue;
  /** Progress Guard 的打转判据之一（另一个是 `resolvedEffect.digest`）。 */
  inputDigest: string;
  resolvedEffect: ResolvedEffect;
  preparedAt: Timestamp;
}

export interface ExecutionAttempt {
  id: AttemptId;
  actionId: ActionId;
  startedAt: Timestamp;
  finishedAt?: Timestamp;
  /** 【定】只有这两个有写入点。执行要么跑完了要么没跑成，没有第三种记录。 */
  status: "SUCCEEDED" | "FAILED";
  sideEffectState: SideEffectState;
  output?: string;
  error?: RuntimeErrorRecord;
}

// ─────────────────────────────────────────────────────── ActionBatch

export interface BatchSettlementPolicy {
  onActionFailure: "CONTINUE_REMAINING" | "SKIP_REMAINING" | "ABORT_BATCH";
  onApprovalRejected: "SKIP_REMAINING" | "CONTINUE_REMAINING";
}

/**
 * D-21：默认值依据 query.ts 的实际行为（已核对源码）。
 * runTools() 遍历全部 tool block，不 break、不短路；失败与拒绝在内部变成 tool_result。
 *
 * 任何取值都不影响不变量 8 —— 它只决定后续 Action 的 result 是真实结果还是 SKIPPED，
 * 不决定有没有 result。
 */
export const DEFAULT_SETTLEMENT: BatchSettlementPolicy = {
  onActionFailure: "CONTINUE_REMAINING",
  onApprovalRejected: "CONTINUE_REMAINING",
};

export interface ActionBatch {
  id: ActionBatchId;
  runId: RunId;
  invocationId: string;
  actions: PreparedAction[];
  /**
   * 【定·D-01】恒为 SEQUENTIAL，所以它是一个**单值类型**而不是二选一。
   *
   * 理据是 Runtime 自持，不是协议保障：四个端点全部静默接受强制单条开关，
   * 其中三个不生效，没有一个会告诉你「我不支持」。写成联合类型会让人
   * 以为另一档是可选项，而全仓没有任何并发执行路径。
   */
  executionMode: "SEQUENTIAL";
}

// ───────────────────────────────────────────────────────── Approval

/**
 * 谁做的这个决定。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它由**决策者自己声明**，Runtime 不推断。
 *
 * 加它的直接理由：在此之前 `--yes-all` 的无条件批准与一个人亲手敲 y，
 * 在 `ApprovalDecided` 事件上**一个字都不差**（两者都是不带 reason 的
 * `{approved:true}`）。于是一条自动跑完的 Run 与一条被逐步审视过的 Run，
 * 在 Trace、事件流、界面上事后完全不可区分 —— 这正是本仓反复在修的形态
 * （`dataMovement` 那次、`replacedBytes` 那次都是同一条）。
 *
 * 【定】Runtime 不给它兜底成 `HUMAN`。没声明就记 `UNDECLARED`，
 * 那是一句真话；记 `HUMAN` 是一句假话，而假话在事实表里比空白贵得多。
 * ══════════════════════════════════════════════════════════════════════
 */
export type ApprovalDecidedBy =
  /** 人当场做的决定（终端敲 y/n、界面上点了按钮）。 */
  | "HUMAN"
  /** 档位性的无条件放行（AUTO 档、或人对本次 Run 说过「不再问」）。 */
  | "AUTO"
  /** 有限自动放行：满足既定条件才放行（`autoGrantVerdict`）。 */
  | "AUTO_GRANT"
  /** 决策者没有声明来源（脚本化 decider 多半如此）。**不猜**。 */
  | "UNDECLARED";

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  /**
   * 【定】新写的 decider **必须**填它。类型上是可选的，只是为了不逼着
   * 十几条验收脚本里的脚本化 decider 全部改签名 —— 它们如实落
   * `UNDECLARED`，而那正是它们的真实情况。
   */
  decidedBy?: ApprovalDecidedBy;
}

/**
 * 审批决策由调用方注入，不是 Runtime 内建（V05 §14.3）。
 * CLI 注入交互式实现，验收脚本注入脚本化实现 —— 后者是必需的，
 * 因为验收脚本必须能无人值守跑完。
 */
export type ApprovalDecider = (action: PreparedAction) => Promise<ApprovalDecision>;

// ───────────────────────────────────────────────────── Verification

export interface VerificationResult {
  id: string;
  actionId: ActionId;
  mode: VerificationDescriptor["mode"];
  required: boolean;
  status: "PASSED" | "FAILED" | "SKIPPED";
  detail: string;
  at: Timestamp;
  /**
   * 这条必需验证「没拿到通过」的成因（决 2，阶段 2 新增）。
   *
   * 【定】它只在 `required && status !== "PASSED"` 时有意义，
   * 且**必须来自事实**（谁拒的、哪一步失败的），不得由结算逻辑推断。
   *
   * 为什么需要它：`outcome.kind` 里 `USER_REJECTED` 有值域、无事实来源 ——
   * 结算时看到一条失败的必需验证，分不出「用户按了 N」和「工具挂了」。
   * 而这两件事对用户的意义完全不同：前者是他自己的决定，
   * 后者是需要排查的故障。
   */
  unmetCause?: UnmetCause;
}

/**
 * 【定】值域只放**有明确事实来源**的成因。
 *
 * 特意**不**包含「模型声称做不了」—— 那需要判断模型的话语意图，
 * 会把结算从「只查事实表」拖回「读模型说了什么」，直接违反不变量 12。
 * 那一类继续走 SUCCESS ＋ summary，取舍写在 ADR 里（决 2）。
 */
export type UnmetCause =
  /**
   * 用户在审批环节**明确拒绝**。
   *
   * 【定】只有 `ApprovalDecision.decidedBy === "HUMAN"` 的否决才算
   * （ADR-0012 二次评审 P1-6）。此前**任何** `approved:false` 都写这个值 ——
   * 包括非交互环境无人应答、等待被 Ctrl+C 打断、以及审批超时。
   * 于是「没有人在场」在事实表上长得和「有人按了否」一模一样，
   * 而上面那条【定】写着「必须来自事实（谁拒的）」。
   * E-3 那句「结算 USER_REJECTED，而全程没有任何人拒绝过任何东西」
   * 说的就是这个形状，只是当时修的是另一半。
   */
  | "USER_REJECTED"
  /**
   * 审批**没有拿到应答**：无人值守、等待被中断、或审批超时。
   *
   * 【定】它与 `USER_REJECTED` 必须分开，理由与 ADR-0001 论证
   * `COMPLETED_WITH_LIMITS` 的那句一致：**不声称自己知道该怪谁**。
   * 它的事实来源同样明确（`decidedBy` 不是 `HUMAN` 而决定是否决），
   * 所以它满足这个值域「只放有明确事实来源的成因」那条【定】。
   *
   * 【定】它**不会**让 outcome 判成 `USER_REJECTED` —— `settle-outcome`
   * 要求所有未达成项都是 `USER_REJECTED` 才那么判，混进这个值就落
   * `COMPLETED_WITH_LIMITS`，那正是诚实的结果。
   */
  | "NO_APPROVAL"
  /** Policy 判定越界。 */
  | "POLICY_DENIED"
  /** 工具执行失败或抛异常。 */
  | "TOOL_FAILED"
  /**
   * 压根没启动：Run 被 cancel，或批内策略把后续都跳过了。
   *
   * 【定】它此前**零生产者** —— 值域里挂着，而一次跑到一半被 Ctrl+C 的 Run，
   * 那些没轮到的必需操作在 `unmetCauseCounts` 里全部记成 `UNSPECIFIED`。
   * 2026-09-01 接线在 `settle-batch` 的 `finally` 里（`aborted` / `skipRemaining`
   * 这两个局部事实），排在 `finalize()` 之前 —— 之后 ledger 就满了，
   * 「谁没启动」这个事实读不出来。
   */
  | "CANCELLED";

/**
 * ── 这里**故意没有** `NOT_OBSERVED` ──────────────────────────────────────
 *
 * 它曾经在值域里，注释是「走到了验证但没能得出结论」，而**零生产者**：
 * 两个内置 Verifier 对「走到了验证」的 call 只会返回 PASSED / FAILED，
 * 而它们产出 SKIPPED 的那些一律 `required: false`（不进 `unmetRequired`）。
 *
 * 删而不是接线，理由是**接了也不会触发**：唯一能产生 `required && SKIPPED`
 * 的是一个第三方 Verifier，而那种情况已经被 `tallyUnmetCauses` 的
 * `?? "UNSPECIFIED"` 如实兜住了（「没写 unmetCause 的记成 UNSPECIFIED，
 * 不悄悄丢掉」）。一个永远不触发的分支比一个诚实的缺省更贵。
 *
 * 对比 `CANCELLED`：那一个有**今天就走得到**的路径，所以它是接线，不是删除。
 */
