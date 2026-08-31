# Current-Only 清理实施方案 V20260831-01

> **依据**：2026-08-31 三方评审（codex / zcode / claude）交叉核验后的合并结论。
> **授权**：用户明确「可以删除目前所有现存的 runs.db，不需要保留历史数据」，
> 且「不兼容旧 API、旧行为、旧业务数据，不保留 schema migration 机制，不为旧数据保留兼容层」。
> **形态**：本方案先于开发落盘，开发按批次对照它执行。

---

## §0 前提

| 项 | 结论 |
|---|---|
| 产品定位 | 个人使用的办公 Agent，**不承担真实线上流量**，单人单机 |
| 旧数据 | **全部丢弃**。改完后所有 `runs.db` 不可读，直接删库重建 |
| 旧 trace | **保留**（JSONL 是独立轨道，不受 schema 变更影响） |
| 兼容层 | 一条不留。「新约定只对新东西生效」这条纪律**本批作废** |

---

## §1 本批要回答的问题

> **一个把「历史兼容」当成美德写了四个阶段的仓库，把兼容层全部拆掉之后，
> 还剩下多少真正在承重的结构？**

判据不是「删了多少行」，是**删完之后哪些判据会翻红** ——
翻红的说明那条兼容层在承重（要重新设计），不翻红的说明它一直是装饰。

---

## §2 六个决定

### 决 1：Schema 不做版本，做**形状断言**

删掉 migration runner 之后，`openDb()` 面对一个旧库会怎样？
两个候选：① 静默 `CREATE TABLE IF NOT EXISTS` 跳过（旧表结构留着，查询在运行期炸）；
② 打开即断言表结构，不符就**明确报错并提示删库**。

**选 ②。** 理由是本仓反复记的那条：「一条放行了却没验过的闸门，与验过并通过事后不可区分」。
`IF NOT EXISTS` 会让一个 schema 已经漂移的库看起来完全正常，直到某个 SELECT 报
`no such column` —— 而那时错误信息指向的是查询，不是成因。

### 决 2：`observePairingError` **接线**，不删

它是三条漂移规则里唯一 FAIL_FAST 的一条，而 FAIL_FAST 的语义是
「继续跑会让后续失败离成因很远」。删掉等于承认这条不变量没有运行期载体。

**接线口径**：判别式改用 **Runtime 自己的词汇**（`RuntimeErrorRecord.source/category`），
不读 HTTP status、不读 SDK 形状 —— `source === "MODEL_PROVIDER" && category === "PROTOCOL"`
就是「端点说我们的请求结构不对」，这正是 `classifyError` 对 400 非上下文超长的映射。
循环纪律第 5 条（主循环不读端点声明）因此仍然成立：读 profile 的是 detector 内部。

### 决 3：`dataMovement` / `riskFacts` **上事件**，不删声明

`policy.ts` 的护栏 ③ 是「越界读放行」这个决定的**依据之一**，
而它声称的「Trace 上可审计」从来没有在场过（事件只带一个拼接字符串，
判据直接对 Resolver 验，绕过了它声称在测的那条链路）。

**两条一起做**：`ActionProposed` 载荷加 `riskFacts` ＋ `dataMovement`；
projection 与 UI 各加一个消费点。少了消费点就是新造一处「未接线」。

### 决 4：`hasUntrustedContext` **整条链路删**

`evaluatePolicy` 零引用。三跳（compile → run-loop → executeBatch → policy）全删。
**不改成「真的参与判定」** —— 那需要一条「不可信上下文在场时提高审批档位」的
产品决定，而本批没有那个决定，凭空加等于新造一条没有证据支撑的闸门（阶段 3.5 的教训）。
它作为**审计事实**已经由 `ContextFrameCompiled.trust` 承载，那一条留着。

### 决 5：命名口径统一时，**四处一起改**

`maxInputTokens` → billed 口径的改名会同时落在：
`RunBudgets` 字段名 / `BudgetAxis` 值 / `BudgetHardLimitReached` 事件载荷 / UI `AXIS_LABEL`。
漏一处就是新的分叉 —— 这正是本批在消灭的东西。

### 决 6：死面裁剪按「**没有生产者**」而不是「没有消费者」下刀

有生产者无消费者的（`targetFingerprints` / `resolverVersion` / `batchDigest` …）
先判断它是不是某条不变量的载体：是就接线，不是就连生产端一起删。
**不留「写了但没人读」的字段** —— 那正是本仓「未接线比不写更糟」说的形态。

---

## §3 批次

### P0 —— 行为正确性风险（4 项）

| # | 项 | 处置 |
|---|---|---|
| P0-1 | `CURRENT_SUPPORTED_SCHEMA` / `TRANSCRIPT_SCHEMA_VERSION` 双常量 | 被 P1-2 整体吸收（schemaVersion 机制全删） |
| P0-2 | `DriftDetector.observePairingError` 生产零调用 | **接线**（决 2）：run-loop 的 model 错误分支上加观测点 |
| P0-3 | `dataMovement` 声称 Trace 可审计、事件不带 | **上事件 ＋ 投影 ＋ UI**（决 3） |
| P0-4 | `LoopPolicySnapshot.maxTurns/maxConsecutiveFailures` 影子字段 | 删两个字段，执行期一律读 `spec.budgets.*` |

### P1 —— 历史兼容层，成套删（11 项）

| # | 项 | 落点 |
|---|---|---|
| P1-1 | migration runner ＋ `schema_migrations` ＋ M001/M002/M003 | `store-sqlite/src/db.ts`、删 `migrations/` 目录；换成单一 `SCHEMA` ＋ 形状断言（决 1） |
| P1-2 | transcript 逐行 `schemaVersion`（列＋跳过＋写入兜底＋判据） | `types/transcript.ts`、`transcript/index.ts`、`transcript-store.ts`、`verify/persistence.ts` D 段 |
| P1-3 | `RuntimeErrorRecord.schemaVersion` | `types/error.ts` |
| P1-4 | workspace `UNKNOWN_LEGACY` 三态 ＋ 降级事件 | `workspace/index.ts`、`facade/index.ts`；`RunSpec.workspace` 改**必填** |
| P1-5 | `workspace-hosts` 的 `bootstrap.dbPath/traceDir` 旧路径继承 | `workspace-hosts.ts`、`server.ts` |
| P1-6 | `MIGRATED_TOOL_NAMES`（`write_note → write_file`） | `composite.ts` |
| P1-7 | `STAGE1_ACTIVE_SOURCES` / `STAGE1_ACTIVE_CATEGORIES` | `types/error.ts` |
| P1-8 | `InMemoryTranscriptStore` | 删 `testkit/src/in-memory-transcript-store/` |
| P1-9 | `RegistryFile.version` 半套 schema 门 | `workspace-registry.ts` |
| P1-10 | `--yes` 幽灵旗标 ＋ `Args.yes`/`confirm` 冗余 | `main.ts`、CLAUDE.md |
| P1-11 | 删库 | `.workagent-state/runs.db` 及全部历史 `runs.db` |

### P2 —— 命名与真实语义（12 项）

| # | 项 | 处置 |
|---|---|---|
| P2-1 | `ToolSnapshot.contentHash` / `AgentSpecSnapshot.contentHash` | **删**（零消费；真 hash 由 `run-repository` 自算） |
| P2-2 | `agentSpecId: "agent_micro_case"` | → `agent_default` |
| P2-3 | `maxInputTokens` 名字 vs 读 billed | → `maxBilledInputTokens` / axis `billedInputTokens`，四处一起（决 5） |
| P2-4 | `RunSnapshot.updatedAt` 实为 inspect 时刻 | → `inspectedAt` |
| P2-5 | `RunSnapshot.currentBatchId` / `waitingOn` 从不填 | 删 |
| P2-6 | `LiveRun.done` | → `segmentActive`（取反） |
| P2-7 | `LiveRun.terminal` 只装 reason | → `terminalReason` |
| P2-8 | `RunHost.currentRunId` 会装哨兵 | → `foregroundHolder`（字段），哨兵改 `STARTING` 常量语义不变 |
| P2-9 | run-loop `const budget` 装的是 usage | → `usageAfter` |
| P2-10 | `runtimeEnvironmentFingerprint` = node 版本 | 删（零消费） |
| P2-11 | `OBSERVED_TOOLS` 注释描述 Map、实现 Set | 改注释 |
| P2-12 | `registryFile?` 文档说「不传则不启用多 workspace」 | 改成「覆盖默认路径」 |
| P2-13 | `RunOrigin.EVAL` 零生产者，Eval 起的 Run 自称 CLI | `RunEntry` 加 `EVAL`，`eval/suite` 传它 |

### P3 —— 死面裁剪

**3a 零生产者的枚举值 / 字段 / 类型**（全删）

- `RunStatus."WAITING_FOR_USER"`、`"CREATED"`（后者改为 `getStatus` 返回 `undefined` 时显式报错，不再兜底）
- `RunOrigin."SESSION_MESSAGE"`
- `Continue` 的 `COMPACT_RETRY` / `CONTEXT_OVERFLOW_RECOVERY` / `APPROVAL_RESUMED` / `INTERJECTION_ACCEPTED`
- `ContextItemKind` 8 个死值 ＋ `compile.ts` 里 `USER_INTERJECTION` 的死分支
- `ContextProtocolRole."CACHE_BREAKPOINT"`、`ContextSource.kind."SESSION"`
- `ActionStage."SKIPPED"`、`ExecutionAttempt.status` 的 `STARTED`/`CANCELLED`/`SKIPPED`
- `VerificationDescriptor.mode` 的 `INLINE_RESULT`/`CUSTOM_VERIFIER`
- `ActionBatch.executionMode."CONCURRENT_LIMITED"` / `maxConcurrency` / `approvalMode."BATCH_SINGLE"`
- `BatchSettlementPolicy.onCancel`
- `TranscriptEntryKind."BLOB_REF"`
- `StepKind`、`ErrorDisposition`、`Approval`、`ConcurrencyDescriptor`、`CapabilityLeasePort`、`SecretResolverPort`
- `ApprovalId` / `VerificationId` / `BlobRef` / `SessionId`（连带 `diagnosticRef`/`verbatimPayloadRef`/`blobRef`/`previewRef`）
- `LoopState.compactTracking` ＋ `CompactTrackingState`
- `idempotencyKeyPointer`、`verifierRef`、`staleAfterMs`、`observationCost`、`intervalMs`
- `retryPolicy`、`cancellation`、`requiredCapabilities`、`concurrency`（14 个工具的声明一并删）
- `recoveryObservation.kind`（零消费；`requiresPreFingerprint` 留着，它是分支判据）
- `ModelUsage.reasoningTokens`（零生产；projection / api-types 的透传一并删）
- `RunSpec.correlationId`、`ProposedAction.schemaError`、`PreconditionFingerprint.hash/existedAt`
- `ContextItem.actualTokens`、`ContextFrame.compilerVersion/policyVersion`
- `CompactionRecord.removedItemIds`（恒 `[]`）
- `ContextBudgetPolicy.modelWindowTokens` / `retrievalPageLimitTokens`
- `RunBudgets.handoffReserveTokens`
- `ContextFrameOutcome.irreducibleExceedsHardLimit`
- `TraceHeader.resumedFrom`
- `InterjectionItem.intent/urgency/at`（`InterjectQueue` 退化成 `string[]`）
- `SettleInput` 的 `handoff` 参数
- `targetFingerprints` / `resolverVersion` / `actionDigest` / `batchDigest` / `protocolGroupId`
- `ContextItem.redactionApplied`（恒 true）
- `mayRetryAutomatically()`
- DB 只写不读的列：`agent_spec_snapshots.agent_spec_id/version/created_at`、`run_specs.spec_hash/created_at`、`blob_refs.run_id/tool_name/created_at` ＋ `idx_blob_refs_run`

**3b 死代码点**

- `--noUnusedLocals` 报的 10 条
- `compose.ts` 的 `void registry`
- `settle-batch` 的 `progressNotes`（只写不读）
- `settle-batch` 三处 `proposed.stage = ...`（写在随即丢弃的对象上）
- `protocol.ts` 两处 TS 收窄后的永假分支
- `effect-resolver` 的 `rules[]` → 单条 `rule`
- testkit 的 `FakeClock` / `DeterministicIdGenerator` / `alwaysApprove` / `alwaysReject`
  （**保留 `SystemClock` 与 `approveExcept`** —— 后者是 verify:pairing 的 R-4 注入器）
- `settleOutcome` 在 run-loop 里被算两遍

**3c 注释与文档**

- 三处孤儿 doc 注释（settle-batch / compile / protocol）
- 四处「够阶段 1 的两个工具用」
- `ports/index.ts` 的「共 15 个」与「（17、18）」
- `budget/index.ts` 头部关于 `handoffReserveTokens` 的错误陈述
- `package.json` 的 `description`
- 重复 helper：`hostOf` ×2、`digest` ×3、`readJsonl` ×2、`sha256` ×4

---

## §4 不得绕过

1. **不得为「让判据继续绿」而保留任何兼容分支。** 判据该改就改，该删就删。
2. **删一个字段时必须同时删它的生产端。** 只删消费端会留下「写了没人读」，
   那正是本批在消灭的形态。
3. **决 3 的三处（事件 / 投影 / UI）必须一次做完。** 只上事件不接消费点 = 新造一处未接线。
4. **`openDb` 的形状断言必须有判据。** 造一个缺列的库，打开必须翻红。
5. **`--noUnusedLocals --noUnusedParameters` 收进 `npm run typecheck`。**
   这次清出来的 10 条不接进闸门，下一批还会长回来。
6. **边界 grep 12 条必须仍然全绿**，且 `boundaries.ts` 仍是唯一一份表。
7. **不新增任何「将来会用到」的类型、枚举值或 Port。**

---

## §5 退出门槛

| # | 门槛 | 证据 |
|---|---|---|
| 1 | `npm run typecheck`（含 `--noUnusedLocals --noUnusedParameters`）干净 | 命令输出 |
| 2 | `npm run verify:all` 全绿 | 逐脚本输出 |
| 3 | 全仓 grep 零命中：`schema_migrations`、`schemaVersion`、`UNKNOWN_LEGACY`、`STAGE1_ACTIVE`、`MIGRATED_TOOL_NAMES`、`InMemoryTranscriptStore`、`hasUntrustedContext`、`contentHash`（工具声明侧）、`--yes` | grep |
| 4 | 空库启动：删库后 `--list-runs` 与一次 Run 正常 | 实跑 |
| 5 | 旧库 fail-fast：拿一个缺列的库打开必须报错并提示删库 | 注入实测 |
| 6 | `observePairingError` 在生产路径上可触发 | `verify:drift` 新判据 |
| 7 | `riskFacts` / `dataMovement` 出现在 `ActionProposed` 事件与 UI 上 | `verify:artifact` 判据改为读**事件**而非 Resolver |
| 8 | 边界 grep 12 条全绿 | `verify:tools` A 段 |

> ⚠️ **不在本批**：真实端点实跑（花钱）。本批全部是结构性改动，
> 脚本化模型足以覆盖；但门槛 4 的「一次 Run」用 `verify:scenarios` 的脚本化端点代替。


---

## §6 执行结果（2026-08-31 完成）

| 门槛 | 结果 |
|---|---|
| 1 `typecheck`（含 `--noUnusedLocals --noUnusedParameters`） | ✅ 干净。`typecheck` 脚本已收进这两个开关 |
| 2 `verify:all` | ✅ **14 条脚本 / 163 条判据全绿** |
| 3 全仓 grep 零命中 | ✅ 剩余命中**全部是解释「删掉了什么」的注释**，无一处是活代码 |
| 4 空库启动 ＋ 一次 Run | ✅ `--list-runs` 空库正常；`npm run ui` 起得来；`verify:scenarios` 三场景通过 |
| 5 旧库 fail-fast | ✅ `verify:persistence` D 段，**注入实测**：摘掉断言当场翻红（且报的是无用的 `no such column`，正是【定】描述的失败形态） |
| 6 `observePairingError` 生产可触发 | ✅ 判别式改用 Runtime 词汇并接进 run-loop 的模型错误分支；`verify:drift` 改走真实 `classifyError` |
| 7 `riskFacts` / `dataMovement` 进事件与界面 | ✅ `verify:artifact` D 段改为**读事件**，**注入实测**过 |
| 8 边界 grep 12 条 | ✅ 全绿。过程中第 5 条抓到了我自己（判据脚本 import 了 `node:sqlite`），已改走 store-sqlite 公开 API |

### 计划外的两处

1. **`ACTIVE_ERROR_CATEGORIES` 缺 QUOTA / RATE_LIMIT。** 注释写着「刻意不登记：
   当前没有任何代码路径产生它们」，而形状适配器的 429 分支两个都产生 ——
   一次真实限流会在开发期被 `assertActiveErrorDomain()` 抛成「值域越界」。
   已补登记。它不在计划里，是删 `schemaVersion` 时顺手回源核对发现的。

2. **存储位置统一。** 计划只写了「删掉 bootstrap 的旧路径继承」，但删完之后
   CLI 与界面会指向两个不同的库 —— 而「终端与浏览器是同一套装配」是仓里的【定】。
   所以顺带把 `workspaceStorage()` 提成唯一出处，两个入口共用。

### 判据的净变化

163 → 163（条数不变，构成变了）：`verify:persistence` D 段换了被测对象
（transcript 逐行版本降级 → 库形状 fail-fast），`verify:artifact` D 段换了取数路径
（Resolver 返回值 → `ActionProposed` 事件），`verify:ui` 的预算轴判据跟着改名。
**两条新判据各做了一次注入实测。**

---

## §7 二次评审的处置（V20260831-02）

> **来源**：`代码评审/2026-08-31/变量命名和历史代码兼容-二次评审-{zcode,codex}.md`，
> 逐条回源核实之后的合并结论。**codex 给的是 NO-GO，成立。**
> **但最该阻断的不是它排在第一的那条** —— 见下面的定级理由。

### §7.1 【定】最重要的发现：两条是**本批自己引入的**

| | 形态 |
|---|---|
| **`Terminal.incompleteItems` 填 `[]`** | 我为了消除一次重复计算，把它从 `r.incompleteItems` 换成 `[]`，而 `LoopTerminated` 同时装 `terminal` 与 `outcome` —— **同一行 JSONL 里两个互相矛盾的事实**。旁边我写的理由是「两份必然相同」，填空数组之后它们必然**不同** |
| **`segmentActive` 名字换了、极性没换** | 6 处读写里 **5 处保持旧 `done` 极性**，而我把第 6 处（`aborterFor`）翻转了 —— 制造了内部不一致。我重写的注释还把历史说反了（真实历史是默认 `done:false` 出的 bug，不是 `true`） |

> **为什么 163 条判据全绿**：`terminal.incompleteItems` **零消费者** ——
> 任何判据都不会碰它，而正因为零消费者，它才能被填成 `[]` 而全绿。
> 这是决 6（没有消费者就删）的又一条论据：**留着一个没人读的字段，
> 等于留着一块判据照不到的地方。** 跑了全套判据的那份评审没发现这两条，
> 只读代码的那份发现了。

### §7.2 定级与处置顺序

| 序 | 项 | 处置 | 理由 |
|---|---|---|---|
| 1 | `Terminal.incompleteItems` | **删掉这个字段**（不是填回真值） | 零消费者。两份报告都建议「传同一份结果」，而按决 6 该删 —— 那才是不再有第二个事实载体 |
| 2 | `segmentActive` 极性 | 统一为**正向**：开始 `true`、收尾 `false`，六处一起；顺带补 `drive()` 的 `first.done` 分支（generator 在首个事件前就返回时，段从未被关闭 —— **旧极性下同样漏，是 pre-existing**） | 名字换了极性没换，正是本批的目标形态 |
| 3 | `run-host.ts` 的 `?? "CREATED"` | 直接用 `snapshot.status`（`inspect()` 已经取过），不再第二次查库、不再发明默认值 | 引用一个**已删除的枚举值**，且落在 typecheck 盲区（`UiRunDetail.status: string`） |
| 4 | transcript payload 解析失败静默吞成 `{}` | **抛**，错误里带 `runId / sequence / kind` | 与「删 schemaVersion 跳过」是同一条理由，而同一个文件里另一处我留着了 —— 口径不一致 |
| 5 | registry 持久化派生路径 | **不再存 `dbPath` / `traceDir`**，一律由 `workspaceStorage(realPath)` 现算 | 我把「唯一出处」写进了【定】，而落盘的派生路径就是第二个出处 |
| 6 | schema 断言先建表、只比列名、抛错不关连接 | **空库建 ＋ 自校验；非空库动任何 DDL 之前先完整验**（表集合 ＋ 列 ＋ 索引名），失败关连接再抛 | 断言强度低于它自己那句【定】—— 「声明强于实现」，本批要消灭的形态 |
| 7 | `--yes` 只删了一半 | README、终端输出两处、`autoYes` 参数名一起改；**解析器拒绝未知参数** | 旧命令必须**明确失败**，而不是被静默忽略 |
| 8 | `.gitignore` 缺 `.workagent/` · 13 个文件 `rule: {` 缩进 · EOF 空行 · 新 testkit 文件 untracked | 一起收 | 补丁自洽性 |
| 9 | artifact 去重不含 `kind`/`path` · F1–F4/P4 开放项 | **登记，不在本批修** | pre-existing 且可达性低（`kind` 由 path 推出、path 变则 logicalId 变）；开放项要有去向，不能无声蒸发 |

### §7.3 新增判据（每条都要有判别力）

| 判据 | 落点 | 它能抓住什么 |
|---|---|---|
| 跑动中 `liveInThisProcess === true` | `verify:ui` | 现有两条只验 `false`（跑完之后、取消历史 Run 之后）—— **一个恒返回 false 的实现也能全绿**。极性统一之后这条是必需的配对判据 |
| 多余旧表（`schema_migrations`）必须被识别 | `verify:persistence` D | 断言此前只遍历期望表，多余表看不见 |
| 坏 payload 必须抛，且错误里带 runId/sequence/kind | `verify:persistence` | 静默吞会让 resume 把关键事实当成「从未存在」 |

### §7.4 明确**不做**的

- **不给 `Terminal` 补一份「正确的」`incompleteItems`。** 那会留下第二个事实载体，
  而 outcome 才是权威。
- **不为 artifact 去重加 `kind`/`path`。** 它需要一条「同字节不同 kind 算不算同一个产物」
  的产品判断，本批没有；先登记。
- **不动 F1–F4**（binary 魔数、声明落空不进结算事实、`collectDeclaredArtifact` 的 try/catch、
  `logicalId` 归一化）—— 都不在 current-only 的范围内。


---

## §8 二次评审处置的执行结果（2026-08-31）

| 项 | 结果 |
|---|---|
| 1 `Terminal.incompleteItems` | ✅ **删字段**（零消费者）。`Terminal` 其余变体的字段留着 —— 它们补充 reason 说不出的信息，不复述 outcome |
| 2 `segmentActive` 极性 | ✅ 六处统一为正向 ＋ 补 `first.done` 分支的关段（pre-existing 漏） |
| 3 `?? "CREATED"` | ✅ 改用 `snapshot.status`，不再二次查库、不再发明默认值 |
| 4 payload 解析失败 | ✅ 抛，错误带 `run / sequence / kind` |
| 5 注册表派生路径 | ✅ `dbPath`/`traceDir` **不再落盘**，一律 `workspaceStorage(realPath)` 现算 |
| 6 schema 断言 | ✅ 空库建＋自校验；非空库先验（表集合 ＋ 列 ＋ 索引名）；抛前关连接 |
| 7 `--yes` | ✅ README ＋ 终端输出 ＋ `autoYes` 一起改；**未知参数明确失败**（实测 `--yes` 现在报错并给出替代） |
| 8 补丁自洽 | ✅ `.gitignore` 加 `.workagent/`；14 个文件缩进修正；`git diff --check` exit 0；新 testkit 文件已入变更集 |
| 9 登记 | ✅ 存量清单 §0.17：S6-9（artifact 去重不含 kind/path）· S6-10（F1–F4）· S6-11（P4 UA） |

### 新增三条判据，**每条都做了注入实测**

| 判据 | 注入 | 结果 |
|---|---|---|
| 跑动中 `liveInThisProcess === true`（`verify:ui`） | `beginSegment` 改回旧极性 | ✅ 当场翻红 —— **这正是原本抓不到那次改名的那条判据** |
| 坏 payload 必须抛并点名（`verify:persistence` D2） | 退回 `catch { payload = {} }` | ✅ 翻红 |
| 多余旧表必须被识别（`verify:persistence` D） | 断言里去掉表集合比对 | ✅ 翻红 |

`verify:all`：**14 脚本 / 165 判据全绿，exit 0**；`typecheck`（含双开关）干净；`git diff --check` exit 0。
