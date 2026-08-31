# Atlas 变量命名与历史代码兼容全量评审（Codex）

> 评审日期：2026-08-31  
> 评审基线：`3d6277e`  
> 评审方式：全仓只读静态审查、调用链交叉检索、TypeScript 只读编译检查  
> 评审边界：本轮评审阶段没有修改业务代码、配置、Schema 或已有评审文件

## 1. 评审目标与结论

本次评审覆盖当前 Atlas（工程标识仍为 `workagent` / `@workagent/*`）主要代码面，重点检查：

1. 变量、字段、类型和注释命名是否与实际代码逻辑一致；
2. 是否仍存在为旧 API、旧行为或旧业务数据服务的兼容层；
3. 是否存在没有实际消费者的历史实现、未来占位或重复事实；
4. 在“个人使用的办公 Agent、不承担真实线上流量”的前提下，哪些结构可以直接按当前版本收口。

评审覆盖 `packages/`、`adapters/`、`tools/`、`cases/`、`apps/`、`eval/` 共 130 个代码/配置文件，约 36,596 行。

### 总体结论：NO-GO

当前代码不符合“只支持当前版本、不保留旧数据兼容”的目标。仓库里仍存在真实生效的 Schema Migration runner、Transcript 逐条版本兼容、旧 Run workspace 放行、旧存储路径继承和旧工具名提示逻辑。

与此同时，部分名称表达的保证强于实际实现，例如：

- `contentHash` 实际可能只是 `name@version` 或人工常量；
- `maxInputTokens` 实际限制的是 `billedInputTokens`；
- `RunSnapshot.updatedAt` 实际是本次 inspect 的当前时间；
- `LiveRun.done` 实际表示进程内执行段是否结束，而不是持久化 Run 是否终止；
- 一些 ToolDefinition 字段看起来已经受到 Runtime 执行，实际上没有任何生产消费者。

建议先完成“当前 Schema 单一化、旧 Run 兼容分支删除、身份与预算字段语义统一”，再继续扩展产品能力。

## 2. P1：必须优先处理的问题

### P1-1：完整的 Schema Migration 机制仍在运行

#### 证据

- `packages/store-sqlite/src/db.ts:16` 导入 `MIGRATIONS`。
- `packages/store-sqlite/src/db.ts:49` 每次打开数据库都执行 `migrate(db)`。
- `packages/store-sqlite/src/db.ts:59-94` 创建 `schema_migrations`，查询已应用版本，并按版本顺序执行增量 SQL。
- `packages/store-sqlite/src/migrations/index.ts:28-217` 保留 M001、M002、M003 以及“只追加、不改写”的迁移约束。

#### 问题

这不是未使用的脚手架，而是每次打开数据库都会运行的正式逻辑，直接违背“不保留 schema migration 机制”的产品约束。

#### 建议方向

只保留一份当前 Schema 初始化器。数据库不符合当前结构时立即报错并提示删除重建，不再保留：

- `schema_migrations` 表；
- migration 版本号、名称和应用时间；
- M001/M002/M003 历史演化顺序；
- 已应用版本判断、增量事务和 rollback 文案。

需要保留的是事务工具函数与当前 Schema 本身，而不是 Schema 演化机制。

### P1-2：Transcript 仍保留逐条 Schema 兼容，并会静默跳过事实

#### 证据

- `packages/harness-runtime/src/types/transcript.ts:7-8` 要求对不兼容记录逐条跳过或 upcast。
- `packages/harness-runtime/src/types/transcript.ts:50` 每条 `TranscriptEntry` 都携带 `schemaVersion`。
- `packages/harness-runtime/src/transcript/index.ts:44` 跳过未来版本的 Message。
- `packages/harness-runtime/src/transcript/index.ts:86` 跳过未来版本的 `RUN_META`。
- `packages/harness-runtime/src/transcript/index.ts:133` 跳过未来版本的 Action Fact。
- `packages/harness-runtime/src/types/transcript.ts:59` 定义 `TRANSCRIPT_SCHEMA_VERSION`。
- `packages/harness-runtime/src/transcript/index.ts:51` 又定义 `CURRENT_SUPPORTED_SCHEMA`。
- `packages/harness-runtime/src/facade/index.ts:325` 仍有硬编码 `schemaVersion: 1`。

#### 问题

同一个版本事实存在三个写法。如果其中一个常量单独变化，Runtime 可能静默跳过预算、恢复分支计数或 Action 前置指纹，而不是立即暴露结构不一致。

这类“尽量读旧数据”的行为对当前个人项目没有收益，反而降低故障可见性。

#### 建议方向

删除 Transcript 行级版本字段、版本常量、跳过/upcast 分支以及对应的未来版本兼容验收。当前结构不匹配时直接失败，不继续恢复一个事实不完整的 Run。

### P1-3：服务启动路径显式继承旧数据库和旧 Trace 目录

#### 证据

- `apps/workagent-service/src/workspace-hosts.ts:37-43` 明确说明，为了让旧 `.workagent-state/runs.db` 中的 Run 继续可见而保留旧 CLI 路径。
- `apps/workagent-service/src/workspace-hosts.ts:62-68` 创建 registry 条目后，又用 bootstrap 的旧 `dbPath` 和 `traceDir` 覆盖当前默认值。
- `packages/harness-runtime/src/workspace/index.ts:107-110` 对本闸门上线前、缺少 workspace 的 Run 继续放行。
- `packages/harness-runtime/src/workspace/index.ts:113-119` 为此保留 `UNKNOWN_LEGACY` 三态分支。
- `packages/harness-runtime/src/types/run.ts:222` 仍将 `RunSpec.workspace` 声明为可选。
- `apps/cli/src/compose.ts:653-665` 当前所有新 Run 已经始终冻结 workspace。

#### 问题

`UNKNOWN_LEGACY`、可选 workspace 和 bootstrap 旧路径全部只服务旧 Run/旧数据布局。它们让当前存储位置存在两套规则，也使 workspace 身份闸门无法保持单一语义。

#### 建议方向

- `RunSpec.workspace` 改为当前 Run 的必填事实；
- 删除 `UNKNOWN_LEGACY` 和降级放行事件；
- 缺少 workspace 身份的 Run 直接拒绝加载；
- 当前 Web/CLI 使用同一套 workspace 存储布局，不再继承 `.workagent-state/runs.db` 等旧路径。

### P1-4：`contentHash` 多处并不是真实 Hash

#### 证据

- `packages/harness-runtime/src/types/tool.ts:248-253` 声明 `ToolSnapshot.contentHash`。
- 工具快照普遍填入 `${name}@${version}`，例如 `tools/common/src/exec/run-shell.ts:813`。
- `apps/cli/src/compose.ts:628` 仍使用 `agent_micro_case` 作为 AgentSpec ID。
- `apps/cli/src/compose.ts:630` 把 `micro@0.1.0` 填入 `AgentSpecSnapshot.contentHash`。
- `packages/store-sqlite/src/run-repository.ts:41-64` 保存时又对序列化后的 AgentSpec 独立计算真正的 SHA-256，类型中的 `contentHash` 并不是数据库使用的内容身份。

#### 问题

同一个名称同时表示：

- 真实 SHA-256；
- `name@version` 版本标签；
- 人工写死的 Agent 标识。

这会误导 Replay、审计和未来缓存逻辑，让调用方误以为已经具备内容寻址保证。

#### 建议方向

如果字段没有消费者，直接删除快照上的 `contentHash`。如果确实需要内容身份，则由唯一函数基于规范化内容计算真实摘要，禁止人工填写。

`agent_micro_case` 也已不能描述当前同时组合 common tools、micro cases 和 Web/CLI 能力的 Agent，应按当前真实身份命名或删除无消费者的身份字段。

### P1-5：输入 Token 预算名称与实际计费逻辑不一致

#### 证据

- `packages/harness-runtime/src/types/run.ts:80` 配置名为 `maxInputTokens`。
- `packages/harness-runtime/src/types/run.ts:91-93` 使用量同时存在 `inputTokens` 和 `billedInputTokens`。
- `packages/harness-runtime/src/budget/index.ts:204-210` 名为 `inputTokens` 的预算轴实际读取 `usage.billedInputTokens`，限制值仍叫 `budgets.maxInputTokens`。

#### 问题

代码逻辑可能有意按计费 Token 限制，但字段、预算轴、UI 展示和配置名都表达为普通 Input Token。后续调用方按字面使用时很容易产生错误配置或错误评测解释。

#### 建议方向

如果目标是计费口径，统一改为 `maxBilledInputTokens`、`billedInputTokens`。如果目标是原始输入量，则实际读取 `usage.inputTokens`。不能继续依赖注释解释名称与读数为何不同。

### P1-6：代码声称 `dataMovement` 可在 Trace 审计，但事件没有携带该事实

#### 证据

- `packages/harness-runtime/src/action/policy.ts:42-50` 把 `riskFact + dataMovement` 描述为网络外发的 Trace 审计护栏。
- `packages/harness-runtime/src/types/event.ts:42-45` 的 `ActionProposed` / `ApprovalRequested` 只有拼接后的 `effect` 字符串。
- `packages/harness-runtime/src/action/settle-batch.ts:275-308` 发事件时没有携带 `riskFacts` 或 `dataMovement`。
- `apps/workagent-service/src/projection.ts:15-19` 明确承认事件流中没有工具入参。

#### 问题

当前 Trace 无法结构化回答数据从哪里流向哪里，也无法还原完整风险事实。注释和验收描述因此高估了实际审计能力。

#### 建议方向

如果该护栏是当前产品要求，就把脱敏后的 `riskFacts` 和 `dataMovement` 作为结构化事件事实；否则删除“Trace 上可审计”的声明，避免把摘要字符串当作完整审计证据。

## 3. P2：明显的语义漂移与冗余接口

### P2-1：若干 ToolDefinition 字段只有声明，没有 Runtime 行为

`packages/harness-runtime/src/types/tool.ts:149-226` 声明了完整工具契约，但全树没有生产代码读取以下字段：

- `requiredCapabilities`；
- `retryPolicy`；
- `cancellation`；
- `concurrency`。

相比之下，`timeoutPolicy` 在 `packages/harness-runtime/src/action/settle-batch.ts:420-428` 确有实际消费者。

这些未执行字段会让工具作者误以为 Runtime 已提供重试、能力租约、取消和并发保证。当前项目应遵循“实现出现时再扩接口”，没有行为的字段直接删除。

### P2-2：`hasUntrustedContext` 被称为风险信号，但策略完全忽略它

- `packages/harness-runtime/src/action/policy.ts:20-24` 声明该字段是风险信号。
- `packages/harness-runtime/src/action/policy.ts:27-29` 实际只解构 `action` 和 `approvalPolicy`。
- `packages/harness-runtime/src/loop/run-loop.ts:877` 主循环仍计算并传入它。

当前字段既不改变 Allow/Deny，也不改变审批理由。应真正接入策略或从调用链删除，不能维持“看起来已经参与决策”的状态。

### P2-3：配对漂移的 fail-fast 规则没有生产调用点

- `packages/harness-runtime/src/model/capability/drift-detector.ts:59-76` 定义 `observePairingError()`，声称在端点开始校验配对时 fail-fast。
- `packages/harness-runtime/src/loop/run-loop.ts:702-705` 主循环只调用 tool-call-count 和 token-accuracy 两条规则。
- `observePairingError()` 的其他调用只存在于 `apps/cli/src/verify/drift.ts`。

因此该规则只能在自身验证脚本中通过，生产运行不可能触发。应接入真实 Provider 错误路径或删除该能力声明。

### P2-4：`--yes` 兼容说明和 `Args.yes` 都不符合实际语义

- `apps/cli/src/main.ts:52-64` 声称保留 `--yes` 是为了不破坏旧命令和文档。
- `apps/cli/src/main.ts:114` 实际设置为 `yes: !argv.includes("--confirm")`。
- 解析器没有检查 `argv.includes("--yes")`。

`Args.yes` 实际表示默认 auto-grant 模式，而不是用户是否传入 `--yes`。旧参数兼容逻辑应删除，当前策略应使用真实名称表达。

### P2-5：`registryFile?` 的文档与服务行为不一致

- `apps/workagent-service/src/server.ts:52-56` 声称不传 `registryFile` 就不启用多 workspace。
- `apps/workagent-service/src/server.ts:74-84` 无论是否传入都会创建 `WorkspaceHosts`，只是在缺省时采用默认 registry 路径。

应修正选项语义：要么参数必填，要么明确它只是覆盖默认路径；不能再称为功能开关。

### P2-6：运行状态字段混淆持久化 Run 生命周期和进程内执行段

#### `LiveRun.done`

- `apps/workagent-service/src/run-host.ts:75-104` 把字段命名为 `done`。
- `apps/workagent-service/src/run-host.ts:628-635` 用 `!done` 判断当前进程是否存在 live execution。
- `apps/workagent-service/src/run-host.ts:685-701` 对仅用于查询的历史 Run 默认创建 `done: true`，即使其持久化状态可能是 `RUNNING` 或 `RECOVERY_REQUIRED`。

该字段实际应表达 `segmentActive`、`pumpRunning` 或类似的进程内执行状态，而不是 Run 是否完成。

#### `currentRunId`

`apps/workagent-service/src/run-host.ts:655-677` 允许 `currentRunId` 保存 `STARTING` 哨兵，因此它并不总是 Run ID。更准确的概念是 foreground slot/holder。

#### `terminal`

`apps/workagent-service/src/run-host.ts:802-806` 只把 `terminal.reason` 字符串写入 `LiveRun.terminal`，字段更准确的名称应是 `terminalReason`。

### P2-7：`RunSnapshot.updatedAt` 实际是 inspect 时间

- `packages/harness-runtime/src/types/run.ts:278-310` 把字段声明为 `updatedAt`。
- `packages/harness-runtime/src/facade/index.ts:810-833` 每次 inspect 都填入 `ports.clock.now()`。

这不是 Run 最近一次状态更新的时间，而是快照被读取的时间。应改名为 `inspectedAt`，或真正读取 RunStore 中的 `updated_at`。

同一类型中的 `currentBatchId` 和 `waitingOn` 也从未由 inspect 填充，应删除或补齐真实投影。

### P2-8：`runtimeEnvironmentFingerprint` 不是环境指纹

- `packages/harness-runtime/src/types/run.ts:224` 声明 `runtimeEnvironmentFingerprint`。
- `apps/cli/src/compose.ts:665` 实际只写入 `node-${process.version}`。
- 全树没有读取消费者。

只记录 Node 版本不能称为环境指纹。当前没有消费者时应删除；如果保留，应使用 `nodeVersion` 这类准确名称。

### P2-9：仍保留多组纯历史兼容残留

1. `apps/cli/src/composite.ts:41-91` 保留 `write_note → write_file` 的旧 Run 错误提示。
2. `packages/harness-runtime/src/types/error.ts:128-129` 保留 `STAGE1_ACTIVE_SOURCES` deprecated 别名。
3. `packages/harness-runtime/src/types/error.ts:160-161` 保留 `STAGE1_ACTIVE_CATEGORIES` deprecated 别名。
4. `packages/testkit/src/in-memory-transcript-store/index.ts:1-18` 明确说明已经没有使用者，只为“历史证物”保留。
5. `packages/harness-runtime/src/types/error.ts:74-87` 的 `RuntimeErrorRecord.schemaVersion` 没有对应的版本读取逻辑。
6. `apps/workagent-service/src/workspace-registry.ts:54-58` 保留 registry `version: 1`，但没有迁移路径；遇到非 1 或损坏内容只会重置为空。

这些内容都可以在 current-only 基线中删除。

### P2-10：公共类型面存在大量无生产者或无消费者的未来占位

全树交叉检索确认的代表项包括：

- `RunStatus.WAITING_FOR_USER` 没有生产者；
- `RunOrigin.SESSION_MESSAGE` / `EVAL` 没有生产者；
- `ModelUsage.reasoningTokens` 当前 Provider adapter 不读取；
- `TranscriptEntryKind.BLOB_REF` 没有生产者/消费者；
- 多个 `ContinueReason`、`StepKind`、`compactTracking` 没有运行路径；
- 多个 `ContextItemKind` 和 `CACHE_BREAKPOINT` 没有生产者；
- `ActionBatch.CONCURRENT_LIMITED`、`maxConcurrency`、`BATCH_SINGLE` 没有执行路径；
- `PreparedAction.previewRef`、`actionDigest`、`batchDigest` 没有消费方；
- `ErrorDisposition`、`ApprovalId`、`VerificationId` 没有引用；
- `CapabilityLeasePort`、`SecretResolverPort` 仍是未实现的公共 Port。

对当前个人实验项目，未来能力不应通过预留公共接口表达。真实用例和调用链出现时再增加，整体会更简洁、可验证。

### P2-11：数据库保留了一批只写不读的字段

- `agent_spec_snapshots.agent_spec_id/version/created_at` 会在 `packages/store-sqlite/src/run-repository.ts:49-56` 写入，但读回时只查询 `snapshot_json`。
- `run_specs.spec_hash/created_at` 会在 `run-repository.ts:58-64` 写入，但读回时不查询。
- `blob_refs.run_id/tool_name/created_at` 和 `idx_blob_refs_run` 当前没有对应查询消费者。
- `blobs.created_at` 当前也没有读取路径。

重建当前 Schema 时，应根据真实查询和约束重新决定字段，而不是机械搬运历史 Schema。

## 4. P3：代码清洁度问题

### P3-1：额外的 TypeScript 未使用项检查发现 10 个死代码点

执行：

```text
./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json
```

生产/评测实现中的未使用项：

- `apps/workagent-service/src/run-host.ts:46`：未使用 import `stripUnsafeDisplayChars`；
- `apps/workagent-service/src/run-host.ts:681-683`：未使用私有方法 `recordOf()`；
- `eval/graders/archive-inventory.ts:219-221`：未使用函数 `escapeRe()`。

验证脚本中的未使用项：

- `apps/cli/src/verify/artifact.ts:42`；
- `apps/cli/src/verify/crash.ts:19`；
- `apps/cli/src/verify/crash.ts:33`；
- `apps/cli/src/verify/drift.ts:384`；
- `apps/cli/src/verify/reasoning-tokens.ts:39`；
- `apps/cli/src/verify/reasoning-tokens.ts:45`；
- `apps/cli/src/verify/tools.ts:46`。

### P3-2：根包元数据已经过时

`package.json:4` 仍把项目描述为“生产级 Agent Harness。阶段1”，与当前个人办公 Agent 的定位和 Stage 4 代码状态都不一致。

## 5. 不应误判为旧数据兼容层的机制

以下结构虽然保存运行历史，但当前有真实的恢复、审计或可观测用途，不建议仅因为“保存历史”就删除：

### 5.1 `sequence_counters`

它负责崩溃后避免统一序列号被重复分配，是当前恢复正确性的一部分，不是 Schema Migration 兼容层。

### 5.2 append-only Transcript 和 RunSpec/Endpoint 快照

它们用于恢复当前 Run、冻结当时的执行条件和复盘模型上下文。可以删除行级 schemaVersion，但不应删除 Transcript 本身。

### 5.3 Trace segment provenance

跨进程恢复后保留 Trace 分段来源，属于当前证据链，不是旧 API 兼容。

### 5.4 Artifact 版本链与 Tombstone

它们表达当前交付物的版本和删除事实。如果希望进一步简化为“只保留最终文件”，应作为独立产品决策处理，不能与旧数据库兼容机制混为一谈。

## 6. 建议的清理顺序

### 第一批：建立 current-only 数据基线

1. 用一份当前 Schema 替换 migration runner；
2. 删除 `schema_migrations`、M001/M002/M003 历史结构；
3. 删除 Transcript 和 RuntimeError 的 schemaVersion 机制；
4. 删除 `UNKNOWN_LEGACY`、可选 workspace 和旧路径 bootstrap；
5. 明确旧数据库直接删除重建，不提供迁移工具。

### 第二批：修复名称与真实语义

1. 删除或真实计算 `contentHash`；
2. 统一 billed input token 的字段和预算轴名称；
3. 修正 `LiveRun.done`、`currentRunId`、`terminal`；
4. 修正 `RunSnapshot.updatedAt`；
5. 删除 `--yes` 兼容语义并重命名当前 auto-grant 策略；
6. 修正 `registryFile?` 的契约说明。

### 第三批：裁剪虚假能力和死接口

1. 对 ToolDefinition 中没有消费者的字段执行“接入或删除”；
2. 对 `hasUntrustedContext` 和 `observePairingError` 执行“接入或删除”；
3. 删除没有生产者/消费者的状态、枚举、Port、Digest 和 future placeholder；
4. 删除 deprecated aliases、旧工具名映射和历史 Testkit 实现；
5. 清理只写不读的 Schema 字段和 TypeScript 未使用项。

### 第四批：重新验证真实调用链

清理完成后，应重新运行：

- `npm run typecheck`；
- `npm run verify:tools`；
- 与 SQLite、Resume、Workspace、UI Projection 相关的验收；
- 当前 Schema 创建、空库启动和不兼容数据库 fail-fast 检查；
- 全树旧字段/旧分支/旧工具名零命中检查。

## 7. 本轮验证与边界

本轮只读评审执行了：

- 全仓文件与调用链检索；
- `npm run typecheck`，结果通过；
- 额外的 TypeScript 未使用项检查；
- `git diff --check`；
- 评审前后 `git status` 对比。

本轮没有执行可能创建 SQLite、Trace、canary 或临时 workspace 的验收脚本，因此本报告是当前代码的全量静态审查结论，不把它表述为真实 LLM、浏览器、网络或崩溃恢复的动态验证结果。

评审阶段没有修改任何业务文件。本文档是用户在评审完成后单独授权新增的评审产物。
