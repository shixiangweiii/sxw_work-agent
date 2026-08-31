# 变量命名与历史代码兼容 —— 全量评审（zcode）

- **日期**：2026-08-31
- **范围**：`packages/`（harness-runtime、store-sqlite、testkit）、`adapters/`（shape-anthropic-messages、endpoint-profiles）、`tools/common/`、`cases/micro-cases/`、`apps/cli/`、`apps/workagent-service/`、`eval/` 的全部生产代码，约 111 个 TS 文件 / 3.4 万行；`apps/cli/src/verify/` 验收脚本做重点抽查而非逐行。
- **评审目标**（两条）：
  1. 代码变量命名与实际代码逻辑是否一致；
  2. 是否存在不必要的历史数据 / 逻辑兼容层。
- **前提约束**：本产品为个人使用的办公 Agent，不承担真实线上流量。**不受既有技术债与历史兼容包袱约束**：不兼容旧 API、旧行为、旧业务数据，不保留 schema migration 机制，不为旧数据保留兼容层。
- **结论形态**：仅评审，未改动任何文件。所有「零消费 / 零生产」断言均经全仓 grep 验证（verify 脚本除外）。

---

## 一、历史数据 / 兼容层（按前提约束应清除，共 7 处）

这是本次评审最明确的一类：单人本地产品，库删了重建比维护兼容便宜，但代码里为「不存在的旧数据 / 旧行为」保留了成套的层。

### 1. Schema migration 机制整体 ⭐ 最大的一个

**位置**：`packages/store-sqlite/src/db.ts`（`migrate()` runner + `schema_migrations` 表）＋ `packages/store-sqlite/src/migrations/index.ts`（M001/M002/M003，217 行）

`openDb()` 带完整的版本化 migration runner：`schema_migrations` 记账表、逐条事务、回滚语义。而三条 migration 的 DDL **全部**已写 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`——天然幂等。

对个人产品，折叠成一段按固定顺序执行的幂等 DDL，行为完全等价；runner、记账表、版本号、回滚语义可整体删除。

注意 M002 本身就是「M001 已经发出去之后打的补丁」——迁移跑步机已经启动，这正是本次要清除的包袱的典型形态。

### 2. transcript 逐行 `schema_version` 前向兼容机制

**位置**：
- `packages/store-sqlite/src/migrations/index.ts:85`——`schema_version` 单独成列，理由是「不解析 payload 就能读到版本号以便 upcast」；
- `packages/harness-runtime/src/transcript/index.ts:44/86/133`——读取侧三处 `if (e.schemaVersion > CURRENT_SUPPORTED_SCHEMA) continue` 跳过逻辑；
- `packages/store-sqlite/src/transcript-store.ts:109` 与 `packages/testkit/src/in-memory-transcript-store`——写入侧 `entry.schemaVersion || TRANSCRIPT_SCHEMA_VERSION` 兜底；
- `apps/cli/src/verify/persistence.ts` D 段——专门测「插入 schemaVersion=999 后逐条降级」，为不存在的场景维护判据。

个人产品里 schema 不兼容变更时就是删库重建，这整套前向兼容机制（逐行版本列＋跳过＋兜底＋判据）可以拿掉。

### 3. workspace `UNKNOWN_LEGACY` 三态

**位置**：`packages/harness-runtime/src/workspace/index.ts:113`（`WorkspaceMatch = "MATCHES" | "UNKNOWN_LEGACY"`）＋ `packages/harness-runtime/src/facade/index.ts:346`（`RESUME_WORKSPACE_UNVERIFIED` 降级事件分支）

`assertResumeWorkspaceMatches` 对「RunSpec 没冻结 workspace」返回 `UNKNOWN_LEGACY` 放行并降级发事件——注释自己写明这是为「S4-5 闸门上线前创建的存量 Run」保留的。

不背旧数据的前提下：`spec.workspace` 设为必填、缺失即抛，三态塌缩成两态，facade 里那段降级事件分支一并消失。

### 4. `STAGE1_ACTIVE_SOURCES` / `STAGE1_ACTIVE_CATEGORIES`

**位置**：`packages/harness-runtime/src/types/error.ts:129/161`

`@deprecated` 改名别名（改名为 `ACTIVE_ERROR_SOURCES` / `ACTIVE_ERROR_CATEGORIES`），全仓零使用者。代码内部的自我兼容层，直接删。

### 5. `InMemoryTranscriptStore`

**位置**：`packages/testkit/src/in-memory-transcript-store/index.ts`

文件头自述「阶段 2 起已无使用者……保留的理由只有一条：历史证物」。所有 verify 脚本都已走 `openDb({ path: ":memory:" })` ＋ `SqliteTranscriptStore`。按前提约束属于应清除项。

### 6. `MIGRATED_TOOL_NAMES` 改名提示

**位置**：`apps/cli/src/composite.ts:48`——`write_note → write_file` 的错误文案提示，只为阶段 3 之前的 Run 服务。旧 Run 本来就不可 resume，这段提示没有服务对象。

### 7. `--yes` 幽灵旗标

**位置**：`apps/cli/src/main.ts` Args 定义处

注释声称「`--yes` 只是自动放行的显式写法（保留是为了不破坏既有命令行与文档）」，但 `parseArgs` **从不解析 `--yes`**（只看 `--confirm` 与 `--yes-all`），`Args.yes` 恒等于 `!confirm`，两个字段冗余。这是「文档承诺了一个实现里不存在的开关」——恰好是本仓反复猎杀的声明与实现不符形态。

---

## 二、变量命名与实际逻辑不一致（7 处）

### 1. `contentHash` 一名三义 ⭐ 最重要

- `ToolSnapshot.contentHash = \`${name}@${version}\``（所有工具，如 `tools/common/src/fs/write-file.ts`）——不是 hash，且全仓**零消费者**（run-shell.ts 的【定】自己也承认）；
- `AgentSpecSnapshot.contentHash = "micro@0.1.0"`（`apps/cli/src/compose.ts:638`）——也不是 hash；
- SQLite `agent_spec_snapshots.content_hash` 列存的是真 `sha256(snapshot_json)`（`packages/store-sqlite/src/run-repository.ts:88`）。

同一个名字在三层分别意味着「名字@版本」「常量串」「内容哈希」。要么改成真 hash，要么改名（如 `versionRef`）。

### 2. `agentSpecId: "agent_micro_case"`

**位置**：`apps/cli/src/compose.ts:637`

AgentSpec 早已装载全部 12 个通用工具 + 测量工具，名字还停在 Micro Case 时期。盘上、trace 里都会带着这个误导性身份。

### 3. `CURRENT_SUPPORTED_SCHEMA` vs `TRANSCRIPT_SCHEMA_VERSION` 双常量 ⭐ 潜伏故障源

**位置**：`packages/harness-runtime/src/transcript/index.ts:47` 与 `packages/harness-runtime/src/types/transcript.ts:59`

两个常量同值（=1）、同义、不同名、不同文件。写侧用后者、读侧比前者——将来谁只 bump 了其中一个，所有新条目会在重建时被**静默跳过**，且没有任何报错。这是实故障风险，不是风格问题。

### 4. run-loop 里的 `const budget = {...}`

**位置**：`packages/harness-runtime/src/loop/run-loop.ts`（模型调用完成后构造用量的那段，约 700 行处）

变量名叫 `budget`，装的是 **BudgetUsage**（本轮用量累计）。全仓约定 `budgets` = 限额、`usage` = 消耗，这一处命名正好反着——同文件几十行外 `spec.budgets` 就是限额。应叫 `usageAfter` 之类。

### 5. `LoopPolicySnapshot.maxTurns / maxConsecutiveFailures` 影子字段

**位置**：`packages/harness-runtime/src/types/run.ts:52-53`

与 `RunBudgets` 同名字段重复。grep 确认 `loopPolicy` 只有 `maxModelErrorRetries` / `maxOutputLimitRecoveries` 被消费，turns 与连续失败的实际执行读的是 `spec.budgets.*`。这两个字段是纯写不读的影子副本——compose 从 `DEFAULT_BUDGETS` 抄值，一旦有人只改一处就是静默双事实源。

### 6. `runtimeEnvironmentFingerprint: \`node-${process.version}\``

**位置**：`apps/cli/src/compose.ts:665`

名为「运行环境指纹」，实际只有一个 node 版本串，且全仓零消费者。要么删，要么让它名副其实。

### 7. facade.resume 的 `schemaVersion: 1` 字面量

**位置**：`packages/harness-runtime/src/facade/index.ts:325`

同文件其余路径都用 `TRANSCRIPT_SCHEMA_VERSION` 常量，这里硬编码——与第 3 条是同族风险。

---

## 三、声明了但从未生产 / 从未消费的面（按「保持简洁」可删）

均经 grep 验证零生产者或零消费者（verify 脚本除外）。

### 3.1 枚举死值（类型里有、运行时永不产生）

| 位置 | 死值 |
|---|---|
| `types/run.ts` | `RunStatus."WAITING_FOR_USER"`（ask_user 走的是 `WAITING_FOR_INTERACTION`）；`"CREATED"` 从不落库，仅作 fallback 显示 |
| `types/transcript.ts` | `TranscriptEntryKind."BLOB_REF"`（零生产零消费） |
| `types/loop.ts` | `Continue` 7 个 reason 里 4 个从不产生：`COMPACT_RETRY` / `CONTEXT_OVERFLOW_RECOVERY` / `APPROVAL_RESUMED` / `INTERJECTION_ACCEPTED` |
| `types/context.ts` | `ContextItemKind` 15 个值只有 7 个产生，8 个死值：`USER_INTERJECTION`（注意 `context/compile.ts:429` 的 irreducible 判定还在为它留一行**死分支**）、`SKILL_DESCRIPTOR`、`SKILL_INSTRUCTION`、`OBSERVATION`、`VERIFICATION`、`ARTIFACT_REFERENCE`、`SUMMARY`、`RESOURCE_EXCERPT` |
| `types/context.ts` | `ContextProtocolRole."CACHE_BREAKPOINT"`——零生产；缓存断点实际走适配器里直接改写 block |
| `types/tool.ts` | `ActionBatch`：`executionMode:"CONCURRENT_LIMITED"`、`maxConcurrency`、`approvalMode:"BATCH_SINGLE"`、`onCancel:"ABORT_UNSTARTED"` 均无路径 |

### 3.2 死类型 / 死接口

| 位置 | 项 |
|---|---|
| `types/loop.ts` | `StepKind`——零引用 |
| `types/error.ts` | `ErrorDisposition`——零引用 |
| `types/tool.ts` | `Approval` 实体接口（完整的 PENDING/APPROVED/... 状态机）——零引用 |
| `types/ids.ts` | `ApprovalId` / `VerificationId`——零引用 |
| `ports/index.ts` | `CapabilityLeasePort` / `SecretResolverPort`——注释自己写「决 5 明确不做」，接口还挂在公共面上 |
| `types/tool.ts` | `PreparedAction.previewRef`——`BlobRef` 的唯一使用点，连带 `ids.ts` 的 `BlobRef` 类型 |

### 3.3 写而不读的字段

| 位置 | 项 |
|---|---|
| `types/loop.ts` ＋ run-loop.ts:209 | `LoopState.compactTracking`（恒 undefined）＋ `CompactTrackingState` 类型 |
| `types/run.ts` | `RunSnapshot.currentBatchId` / `waitingOn`——inspect() 从不填 |
| `types/run.ts` | `RunOrigin` 的 `SESSION_MESSAGE` / `EVAL` 变体零生产 |
| `types/run.ts` ＋ compose.ts | `RunSpec.correlationId`——生产、从不消费 |
| `types/run.ts` | `ModelUsage.reasoningTokens`——零生产者（client 的 `readUsagePartial` 只挑 4 个字段），projection 的条件透传永远走不到 |
| `types/run.ts` ＋ budget/index.ts:91 | `RunBudgets.handoffReserveTokens`——`DEFAULT_BUDGETS` 给默认值 2000，但 `checkBudgets` 八条轴不含它；budget/index.ts 的 R-1 注释**自己写着它「有声明、无读取点」**，默认值照给 |
| `types/context.ts` ＋ budget/index.ts | `ContextBudgetPolicy.modelWindowTokens` / `retrievalPageLimitTokens`——零读取 |
| `apps/cli/src/trace/file-sink.ts:52` | `TraceHeader.resumedFrom`——声明了、从未写入 |
| `types/error.ts` | `RuntimeErrorRecord.schemaVersion`（恒 1 无人读）、`diagnosticRef` / `providerCode` |
| `loop/interrupt/index.ts` | `InterjectionItem.intent / urgency / at`——facade 写死 `ADD_CONTEXT`/`NEXT_SAFE_POINT`，drain 消费端只用 `content`，三个字段纯装饰 |
| 全部 12 个工具 | 声明的 `retryPolicy` / `cancellation` / `requiredCapabilities`——工具认真填值，Runtime 侧零消费（对比：timeoutPolicy、progressReporting、recoveryObservation 都有真实消费者） |
| `packages/store-sqlite` | `blob_refs.run_id / tool_name` 两列 ＋ `idx_blob_refs_run` 索引只写不查（`SqliteBlobStore.get` 不按 run 查） |

### 3.4 声明未接线

- **`DriftDetector.observePairingError`**（`model/capability/drift-detector.ts`，规则 2，FAIL_FAST 级）——run-loop 只接了另外两条规则（`observeToolCallCount` / `observeTokenAccuracy`），这条**生产路径零调用**，只有 verify:drift 调它。「端点开始校验配对」这种漂移在生产里不会触发 fail-fast——要么接线要么删。

### 3.5 其他死代码

- `apps/cli/src/compose.ts` 末尾 `const registry = new ToolRegistry(tools); void registry;`——构造后即丢弃的死实例化。
- testkit：`FakeClock` / `DeterministicIdGenerator` / `ScriptedApprovalDecider` 全仓零使用（crash-harness 在用，保留；这三个可删）。
- `apps/workagent-service/src/workspace-registry.ts`：`RegistryFile.version: 1` ＋ load 校验——已有「读坏当空」降级，version 门是多余的半套 schema 机制，可简化。

---

## 四、检查过、没有发现问题的部分

公平起见，列出核对后认为干净的地方（注释声称的行为与代码实际行为一致、命名与语义相符）：

- run-loop 的循环纪律五条与全部出口路径（具名 Terminal / finish 统一收口）；
- settle-batch 的配对不变量（ledger / finalize / recordUnmetRequired 三层兜底）与 guard 异常收敛；
- compact 的「协议单元」并查集聚合、`targetTokens` 收敛、isUserInput 判据；
- budget 八条轴的 billed 口径与 `readBudgetAxes` 单一事实源；
- shape 适配器的 usage 合并（只覆盖实际出现过的字段）、cache_control 断点、classifyError 判别式；
- sandbox / read-guard 的三张常量表对齐与 sbpl 正则边界（双侧有判据）；
- run-host 的段生命周期（beginSegment 换 AbortController、claimForeground 同步占位、close 的取消→等泵→关库顺序）；
- projection 的双轨合并（D-2 序列去重、track 如实标注、逐轮 budgetAfter 取权威副本）；
- human-channels 的三通道语义（handoff / question 失败语义相反的刻意区分）；
- blob-store 的行＋字符双层分页边界（nextLineOffset 续取）。

---

## 五、建议清理优先级（供后续动手排序，本次未改）

| 级别 | 内容 | 性质 |
|---|---|---|
| **P0** | ① `CURRENT_SUPPORTED_SCHEMA` / `TRANSCRIPT_SCHEMA_VERSION` 合一；② `DriftDetector.observePairingError` 接线或删除；③ `--yes` 幽灵旗标与文档对齐 | 行为正确性风险 |
| **P1** | ① migration runner → 单段幂等 DDL；② schema_version 前向兼容机制；③ workspace `UNKNOWN_LEGACY` 三态；④ `STAGE1_*` 别名；⑤ `InMemoryTranscriptStore`；⑥ `MIGRATED_TOOL_NAMES` | 明确的历史兼容层，成套删除 |
| **P2** | ① `contentHash` 三义；② `agent_micro_case`；③ run-loop 的 `budget` 变量；④ `LoopPolicySnapshot` 影子字段 | 命名纠正（涉及盘上数据，可顺便清库） |
| **P3** | 第三节全部：枚举死值、死接口、写而不读字段、testkit 三个未用夹具、`void registry` | 死面裁剪，纯类型/常量级，机械可做 |

预估 P1＋P3 合计可净删 800–1200 行，不损失任何在用能力。

---

*zcode · 2026-08-31 · 仅评审，未修改任何文件*
