# WorkAgent 阶段 1 代码评审（Codex）

> 评审日期：2026-08-24  
> 评审对象：阶段 1（Headless Walking Skeleton）当前未提交实现  
> 评审方式：只读源码审查、架构契约交叉核对、无写入静态验证  
> 基准文档：`阶段roadmap/WorkAgent阶段Roadmap_V20260823.md`、`实施方案设计/阶段1实施方案_V20260823.md`、`架构设计/WorkAgent架构设计_V20260823_05.md`  
> 本次变更：仅新增本评审文档，没有修改任何代码逻辑或其他文件

---

## 1. 评审结论

当前实现已经形成清楚的阶段 1 工程骨架，类型检查和四条核心依赖边界均通过；Effect、Policy、Approval、Tool、Redaction、Verification 的主干分层也基本符合 V05 设计方向。

但是，现有代码和验收证据仍不足以支撑 roadmap 中“阶段 1 已完成”的强结论。本次评审识别出：

- **9 项 P1 问题**：会破坏 Resume 正确性、安全边界、预算硬墙、Outcome 真实性或阶段退出判据；
- **10 项 P2 问题**：会影响 token/usage 口径、可观测性、配置一致性和已声明功能的完整度；
- 当前 `verify:resume` 和 `verify:pairing` 的通过条件存在明显证据缺口，不能证明文档所写的“三条恢复策略已验证”“三条中断路径全覆盖”以及“恢复结果与不中断一致”。

**总体建议：阶段 1 状态应暂时视为“主体实现完成，但退出门槛未通过”；至少关闭全部 P1，并重写关键验收场景后，再正式进入阶段 2。**

---

## 2. 评审范围与方法

### 2.1 代码范围

本次把所有未提交内容视为完整阶段 1 变更集进行审查，主要覆盖：

- `packages/harness-runtime/`
- `packages/testkit/`
- `adapters/shape-anthropic-messages/`
- `adapters/endpoint-profiles/`
- `cases/micro-cases/`
- `apps/cli/`
- 根目录工程配置、README、阶段 roadmap 和阶段 1 实施方案

### 2.2 重点执行链路

```text
CLI / Composition Root
  → HarnessRuntime.start() / resume()
  → runLoop()
  → compileFrame()
  → ModelProtocolPort.buildRequest()
  → ModelPort.invoke()
  → executeBatch()
  → Effect → Policy → Approval → Tool
  → Redaction → Verification → ToolResult
  → transcript append
  → settleOutcome() / Terminal
```

### 2.3 已执行的只读验证

| 检查 | 结果 | 说明 |
|---|---|---|
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false` | ✅ 通过 | 只证明类型与语法检查通过 |
| `git diff --check` | ✅ 通过 | 未发现 whitespace error |
| Provider SDK 边界 grep | ✅ 通过 | SDK 没有进入 `packages/`、`apps/`、`cases/` |
| 端点名称边界 grep | ✅ 通过 | 主循环没有编译具体端点行为 |
| 主循环读取 `profile.*` | ✅ 通过 | 仅注释命中，没有行为读取 |
| Runtime Core import Case Package | ✅ 通过 | 未发现反向依赖 |

### 2.4 未执行的验证

没有运行 `verify:*` 脚本。原因是原评审约束要求“不修改任何文件”，而这些脚本会创建临时目录并执行文件写入。本文对验收脚本的结论来自源码级路径审查。

因此，本次验证不证明：

- 真实 LLM/网络调用行为；
- 真正的慢工具 cancel race；
- 临时文件写入与 Resume 的动态结果；
- 百炼端点当前在线行为是否与历史 profile 完全一致。

---

## 3. P1：阻断阶段 1 退出的问题

### P1-1　`RECOVERY_REQUIRED` 没有真正阻断运行

**事实**

`resume()` 发现 `RECOVERY_REQUIRED` 或未知工具后，会设置 `blocked = true`，发出 `RecoveryRequired` 事件并短暂写入 `RECOVERY_REQUIRED` 状态；但随后无条件创建新的 `RunInterrupts`，把状态改回 `RUNNING`，并进入 `runLoop()`。

证据：

- [`packages/harness-runtime/src/facade/index.ts:117`](../../packages/harness-runtime/src/facade/index.ts#L117)
- [`packages/harness-runtime/src/facade/index.ts:146`](../../packages/harness-runtime/src/facade/index.ts#L146)
- [`packages/harness-runtime/src/facade/index.ts:159`](../../packages/harness-runtime/src/facade/index.ts#L159)

**影响**

- Runtime 会在副作用未知、架构要求用户决策时继续调用模型；
- 后续操作可能依赖一个未经确认的外部状态；
- Run 甚至可能进入 Terminal，与 V05 将 `RECOVERY_REQUIRED` 定义为非终态直接冲突。

**建议验收条件**

- `RECOVERY_REQUIRED` 分支不得进入主循环；
- 必须等待显式恢复决策；
- 在用户选择重试、接受已应用或终止之前，不得再调用模型或副作用工具。

### P1-2　Resume 三条策略只有分类，没有真实处置

**事实**

代码会把未配对 Tool Call 分类为：

- `IDEMPOTENT_RETRY`
- `OBSERVE_FIRST`
- `RECOVERY_REQUIRED`

但实际执行对三类都相同：追加一条 `RESUMED_UNKNOWN` ToolResult，然后继续主循环。代码没有重新执行幂等工具，也没有调用 Observation/Verification。

证据：

- [`packages/harness-runtime/src/facade/index.ts:99`](../../packages/harness-runtime/src/facade/index.ts#L99)
- [`packages/harness-runtime/src/facade/index.ts:119`](../../packages/harness-runtime/src/facade/index.ts#L119)

此外，该路径先执行 `messages.push()`，之后才 `transcript.append()`：

- [`packages/harness-runtime/src/facade/index.ts:121`](../../packages/harness-runtime/src/facade/index.ts#L121)
- [`packages/harness-runtime/src/facade/index.ts:137`](../../packages/harness-runtime/src/facade/index.ts#L137)

这违反了项目不变量 5：“先落盘，再更新内存 messages”。

**影响**

- Resume 事件名称与实际行为不一致；
- 幂等 Tool 没有得到重试；
- 可观察 Tool 没有重新观察外部世界；
- append 失败时，内存可能领先 transcript，破坏恢复基础。

### P1-3　Resume 缺少 Run 生命周期与并发保护

**事实**

`resume()` 只检查 RunSpec 是否存在，不检查 Run 是否为非 Terminal，也不检查当前是否已有循环正在运行。

证据：

- [`packages/harness-runtime/src/facade/index.ts:73`](../../packages/harness-runtime/src/facade/index.ts#L73)

当前验收脚本是在第一次 Run 已返回 Terminal 后调用 `resume()`：

- [`apps/cli/src/verify/resume.ts:215`](../../apps/cli/src/verify/resume.ts#L215)
- [`apps/cli/src/verify/resume.ts:293`](../../apps/cli/src/verify/resume.ts#L293)

**影响**

- Terminal Run 可以被重新执行；
- 包含真实写操作时可能产生重复副作用；
- 同一个 Run 可以同时存在两个循环，违反“一个 Run 同时只有一个循环”的不变量；
- 验收脚本把本应拒绝的路径当成了成功用例。

Resume 还会重新创建初始 LoopState，导致以下事实归零：

- `turnCount`
- Budget usage
- Verification 结果
- RecoveryItem
- 连续失败计数

这不符合 V05 对 Resume“保留已完成副作用和预算使用”的定义。

### P1-4　已失败的必需操作可能结算为 `SUCCESS`

**事实**

`write_note` 执行失败时，Verifier 返回：

```ts
required: true,
status: "SKIPPED"
```

证据：

- [`cases/micro-cases/src/index.ts:87`](../../cases/micro-cases/src/index.ts#L87)

但 `settleOutcome()` 只筛选 `required && status === "FAILED"`：

- [`packages/harness-runtime/src/verification/settle-outcome.ts:58`](../../packages/harness-runtime/src/verification/settle-outcome.ts#L58)

**可复现逻辑路径**

```text
write_note 明确失败，副作用为 NO_EFFECT/NOT_STARTED
  → required Verification 被标为 SKIPPED
  → 错误 result 回灌模型
  → 模型不再请求工具
  → failed required Verification 数量为 0
  → RunOutcome = SUCCESS
```

Schema、Policy、Approval 拒绝也没有生成会参与最终结算的失败 Verification，因此存在同类问题。

**影响**

RunOutcome 可能与实际执行事实相反，直接破坏阶段 1 的完成判定可信度。

### P1-5　Budget hard limit 大部分没有生效

**事实**

主循环当前只检查：

- `maxTurns`
- 一个从 Run 启动时间直接相减的 elapsed
- `maxConsecutiveFailures`

证据：

- [`packages/harness-runtime/src/loop/run-loop.ts:164`](../../packages/harness-runtime/src/loop/run-loop.ts#L164)

以下 RunBudgets 字段没有执行判定：

- `maxTotalWallClockMs`
- `maxModelCalls`
- `maxToolCalls`
- `maxInputTokens`
- `maxOutputTokens`
- soft limit 与 handoff reserve

类型定义与默认配置：

- [`packages/harness-runtime/src/types/run.ts:57`](../../packages/harness-runtime/src/types/run.ts#L57)
- [`packages/harness-runtime/src/budget/index.ts:31`](../../packages/harness-runtime/src/budget/index.ts#L31)

同时，`activeWallClockMs` 使用 `now() - startedAt`，会把等待审批的时间计入 active 时间，与 V05 明确排除 `WAITING_*` 的规则冲突。

工具定义中的 `timeoutPolicy` 也没有接入；`RunInterrupts.stepSignal()` 存在但从未使用。

**影响**

- 模型调用、工具调用和 token 使用可以穿透声明的 hard limit；
- 等待用户审批可能错误耗尽 active wall clock；
- 挂住的 Tool/Verification Port 没有步骤级 timeout 保护。

### P1-6　Context hard limit 可以被超长输入绕过

**事实**

当 `count.tokens > hardInputLimitTokens` 时，只有 `irreducible + fixedOverhead` 也超限才返回 `COMPACTION_INSUFFICIENT`；否则函数继续返回 `READY`。

证据：

- [`packages/harness-runtime/src/context/compile.ts:71`](../../packages/harness-runtime/src/context/compile.ts#L71)
- [`packages/harness-runtime/src/context/compile.ts:97`](../../packages/harness-runtime/src/context/compile.ts#L97)

但 Compact 会永久保留所有 user 消息，而 `computeIrreducible()` 并没有把这些消息计入 irreducible。因此，超长用户输入在 Compact 后仍超过 hard limit 时，可能继续发往模型。

另一个相反方向的问题是：`computeIrreducible()` 已经把 fixed overhead 放入 sum，调用方判定时又加了一次。

证据：

- [`packages/harness-runtime/src/context/compile.ts:234`](../../packages/harness-runtime/src/context/compile.ts#L234)

**影响**

- 一侧可能把超限请求发给 Provider；
- 另一侧可能错误提前进入 `CONTEXT_EXHAUSTED`；
- D-05 依赖的精确触发点失真。

### P1-7　Workspace 文件边界可通过符号链接逃逸

**事实**

Effect Resolver 与两个 Tool 都使用 `resolve()` 加字符串前缀判断路径是否位于 workspace：

- [`packages/harness-runtime/src/action/effect-resolver.ts:73`](../../packages/harness-runtime/src/action/effect-resolver.ts#L73)
- [`cases/micro-cases/src/tools/list-dir.ts:117`](../../cases/micro-cases/src/tools/list-dir.ts#L117)
- [`cases/micro-cases/src/tools/write-note.ts:180`](../../cases/micro-cases/src/tools/write-note.ts#L180)

该检查可以阻止 `..`，但不能阻止 workspace 内已有 symlink 指向外部目录。

示例：

```text
workspace/link -> /outside
write_note(path="link/file.txt")
```

词法路径仍以 workspace 开头，会通过 `isInside()`；Node 的 `writeFile`/`readdir` 会跟随 symlink，最终访问 workspace 外部。

**影响**

Agent 可以读取或写入授权根目录以外的位置，是明确的安全边界绕过。

### P1-8　输出预算恢复重试的是相同请求

**事实**

主循环识别“推理吃光输出预算”后会提高 `state.maxOutputTokensOverride`：

- [`packages/harness-runtime/src/loop/run-loop.ts:333`](../../packages/harness-runtime/src/loop/run-loop.ts#L333)

但下一轮构造请求时，Protocol 只读取 `frame.reservedOutputTokens`；`maxOutputTokensOverride` 没有传进 ContextFrame 或 Protocol：

- [`adapters/shape-anthropic-messages/src/protocol.ts:53`](../../adapters/shape-anthropic-messages/src/protocol.ts#L53)

**影响**

- 所谓“抬高上限重试”实际连续发送相同请求；
- 白白消耗模型调用次数；
- 最终错误地返回 `CONTEXT_EXHAUSTED`，掩盖真正原因。

### P1-9　ActionBatch 的 Port 异常会绕过 Terminal 与 result 落盘

**事实**

`executeBatch()` 只捕获 `tools.execute()` 抛出的异常。以下调用都可能直接向外抛出：

- Effect Resolver
- ApprovalDecider
- RedactionPort
- VerificationPort

典型证据：

- [`packages/harness-runtime/src/action/settle-batch.ts:188`](../../packages/harness-runtime/src/action/settle-batch.ts#L188)
- [`packages/harness-runtime/src/action/settle-batch.ts:241`](../../packages/harness-runtime/src/action/settle-batch.ts#L241)
- [`packages/harness-runtime/src/action/settle-batch.ts:328`](../../packages/harness-runtime/src/action/settle-batch.ts#L328)
- [`packages/harness-runtime/src/action/settle-batch.ts:346`](../../packages/harness-runtime/src/action/settle-batch.ts#L346)

`finally` 虽然会补齐内部 ledger，但 generator 已经异常退出，`runLoop()` 拿不到 `BatchOutcome`，因此这些合成 result 不会写入 transcript，也不会形成具名 Terminal。

**影响**

- Run 可能以未捕获异常结束；
- transcript 可能留下未配对 Tool Call；
- Facade status 可能永久停留在 `RUNNING`。

---

## 4. P2：重要但可在 P1 之后处理的问题

### P2-1　Anthropic usage 合并会把输入 token 清零

`message_start` 先提供 input/cache usage；后续 `message_delta` 常只提供 output usage。当前代码调用 `readUsage()` 后整体 spread，缺失字段被转换成 0，从而覆盖先前的 input/cache 数据。

证据：

- [`adapters/shape-anthropic-messages/src/client.ts:115`](../../adapters/shape-anthropic-messages/src/client.ts#L115)
- [`adapters/shape-anthropic-messages/src/client.ts:202`](../../adapters/shape-anthropic-messages/src/client.ts#L202)

结果是 Trace 和 BudgetUsage 中的输入/计费 token 可能错误归零。

### P2-2　精确 `count_tokens` 被重复加固定底数

当前端点的 `count_tokens` 已由 Spike 0 证明与实际 usage 5/5 项完全一致，但代码仍然额外加上 `perRequestBaseTokens`：

- [`adapters/shape-anthropic-messages/src/protocol.ts:84`](../../adapters/shape-anthropic-messages/src/protocol.ts#L84)

这会让精确路径固定多算 5 tokens。本地估算路径需要固定底数，端点精确计数路径不应再次叠加。

### P2-3　Compact 结果没有成为持久事实

`compileFrame()` 在局部变量 `working` 上压缩消息，但 `runLoop()` 后续仍从原始 `state.messages` 追加助手消息；同时没有写入 `COMPACT_BOUNDARY`。

结果：

- 下一轮会重新看到未压缩历史；
- Resume 无法重建刚才使用的压缩上下文；
- Compact 事件与 transcript 事实不一致；
- `targetTokens` 参数目前完全未被使用。

这是 roadmap 已承认“Compact 未被真跑过”背后的真实实现风险，不只是覆盖率不足。

### P2-4　DriftDetector 已实现但没有接入运行时

`DriftDetector` 和 `EndpointDriftError` 存在，但 Composition Root 和主执行链路没有创建或调用它们：

- [`packages/harness-runtime/src/model/capability/drift-detector.ts:23`](../../packages/harness-runtime/src/model/capability/drift-detector.ts#L23)

因此 `EndpointBehaviorDrift` 事件实际不会产生，端点声明漂移不变量并未兑现。

### P2-5　CLI 没有执行中插话入口

CLI 只处理模型事件、审批 readline 和 SIGINT，没有读取普通输入并调用 `runtime.interject()`：

- [`apps/cli/src/main.ts:68`](../../apps/cli/src/main.ts#L68)

所以 README/roadmap 中“执行中能插话”的功能目前不可使用。

另外，Ctrl+C 只 abort Runtime；当程序阻塞在 `rl.question()` 时，question 本身不会被 signal 解除，取消可能需要用户再输入一次才能继续。

### P2-6　事件流契约没有完整兑现

以下事件有类型定义，但主流程没有产出：

- `LoopTerminated`
- `ToolProgress`
- `BudgetSoftLimitReached`
- `EndpointBehaviorDrift`

Resume 的事件 sequence 还存在两个问题：

- 多个 `ResumeUnpairedToolUse` 全部使用 `lastSeq + 2`；
- 进入 `runLoop()` 后内部 sequence 从 1 重新开始。

这会破坏事件序列的唯一性和顺序解释能力。

### P2-7　`inspect()` 返回的是固定零值

`inspect()` 的 turn、failure、budget、messageCount 全部写死为 0：

- [`packages/harness-runtime/src/facade/index.ts:195`](../../packages/harness-runtime/src/facade/index.ts#L195)

当前返回值不是实际 RunSnapshot，无法用于 CLI/UI 投影或状态判断。

### P2-8　RunSpec/Profile 并未真正不可变

`freezeProfile()` 只冻结第一层及三个直接子对象：

- [`packages/harness-runtime/src/model/capability/profile-loader.ts:49`](../../packages/harness-runtime/src/model/capability/profile-loader.ts#L49)

以下内容仍可变：

- `tokens.usageFieldMap`
- `sourceEvidenceRefs`
- `errors.discriminators`
- `RunSpec` 本身
- ToolSnapshot 和 ToolDefinition
- Approval/Context/Loop policy

调用方可以在 Run 执行期间修改这些对象，破坏“一个 Run 绑定不可变 RunSpec”和 Replay 前提。

### P2-9　`.env` 的模型配置被读取但没有生效

`readEndpointConfig()` 读取 `dashscope_model`，但 Compose 后续始终使用 profile 内的 `modelId`：

- [`apps/cli/src/compose.ts:68`](../../apps/cli/src/compose.ts#L68)
- [`apps/cli/src/compose.ts:125`](../../apps/cli/src/compose.ts#L125)

当前行为应二选一并显式化：

- 只允许 profile 冻结模型，则校验 `.env` 模型必须匹配；
- 允许 `.env` 覆盖，则必须加载与该模型对应的端点能力声明。

不能静默忽略用户配置。

### P2-10　阶段 1 错误值域声明与实际产生值不一致

`STAGE1_ACTIVE_SOURCES/CATEGORIES` 声明的值域不包含多种当前代码实际会产生的值，例如：

- `source: USER`
- `category: NOT_FOUND`
- `category: AUTHORIZATION`
- `category: REDACTION`

证据：

- [`packages/harness-runtime/src/types/error.ts:98`](../../packages/harness-runtime/src/types/error.ts#L98)
- [`packages/harness-runtime/src/action/settle-batch.ts:165`](../../packages/harness-runtime/src/action/settle-batch.ts#L165)
- [`packages/harness-runtime/src/action/policy.ts:34`](../../packages/harness-runtime/src/action/policy.ts#L34)

应统一“阶段 1 主动值域”的定义与实际实现，否则 D-22 的裁剪声明不可验证。

---

## 5. 三条验收脚本的证据有效性

### 5.1 `verify:endpoint-profile`

**有效部分**

- 能证明 `protocolRoleOf()` 会随 profile 改变；
- 能证明严格 profile 会改变 `validateFrame()` 结果；
- 主循环未直接读取具体端点配置。

**局限**

- “运行前后文件 hash 不变”只能证明脚本没有修改源码，不能单独证明所有端点差异都已隔离；
- DriftDetector、usage mapping、token 口径、错误分类等端点声明消费路径没有覆盖；
- Compose 即使使用 fake model 仍要求读取真实 `.env` 凭证，降低离线验收的独立性。

### 5.2 `verify:pairing`

**关键缺口**

所谓“工具执行中断”场景实际是 Approval Reject：

- [`apps/cli/src/verify/pairing.ts:65`](../../apps/cli/src/verify/pairing.ts#L65)

它没有：

- 给 `write_note` 注入延迟；
- 在 Tool 正在执行时调用 cancel；
- 验证已完成、执行中和未启动 Action 的三种 side-effect/result 结算；
- 注入 Effect/Approval/Redaction/Verification 抛异常；
- 覆盖重复 `toolCallId`。

“模型错误”场景发生在第一批已经正常结算之后，只能说明此前的 result 已存在，不能证明异常出口会自动补齐未结算批次。

因此，roadmap 中“三条中断路径全覆盖”的描述不成立。

### 5.3 `verify:resume`

最终判据只检查：

- 基线和恢复路径都到达某个完成 Terminal；
- 没有未配对 Tool Call；
- transcript 条目数增加。

证据：

- [`apps/cli/src/verify/resume.ts:112`](../../apps/cli/src/verify/resume.ts#L112)

它没有比较：

- 最终 Outcome 是否完全一致；
- `note.txt` 内容是否一致；
- 最终 ContextMessage 序列是否一致；
- Budget usage 是否继承；
- Verification/RecoveryItem 是否继承；
- 幂等 Tool 是否真的重新执行；
- Observation 是否真的先运行；
- 非幂等且不可观察分支是否真的停在 `RECOVERY_REQUIRED`。

脚本还接受恢复路径为 `COMPLETED_WITH_LIMITS`，而基线为 `COMPLETED`，这与“结果一致”的表述冲突。

硬崩模拟只注入：

- `list_dir` → `IDEMPOTENT_RETRY`
- `write_note` → `OBSERVE_FIRST`

没有第三个非幂等且不可观察 Tool，所以“三条分支各走一遍”的注释与实际代码不一致。

---

## 6. 实现中值得保留的部分

以下设计方向是正确的，后续修复应尽量保留：

1. **依赖边界清楚**：Runtime Core、Case Package、Provider Adapter、Composition Root 的单向依赖已经形成；
2. **端点行为数据化**：profile、protocol port 与 shape adapter 的职责区分总体清晰；
3. **Effect 先于 Policy**：模型自由文本先解析为语义化 ResolvedEffect，再交给 Policy；
4. **统一批结算 ledger**：`settle()` + `finalize()` 是保证配对不变量的正确方向；
5. **错误四维模型**：source/category/retryability/sideEffectState 的正交结构有价值；
6. **ToolResult 进入上下文前脱敏**：安全边界放置位置正确；
7. **Verification 独立于 Tool success**：概念与模块边界正确，当前问题主要在状态语义和最终结算；
8. **真实 Clock/ID/Transcript 通过 Port 注入**：有利于后续阶段 2 的替换与可重复验证；
9. **显式 Continue/Terminal**：主循环状态迁移可读性较好；
10. **已承认 Compact 未被真跑过**：文档没有把这条路径伪装成已验证能力。

---

## 7. 建议的阶段 1 重新退出门槛

建议在 roadmap 重新标记“阶段 1 完成”前，至少满足以下条件。

### 7.1 Runtime 正确性

- [ ] `RECOVERY_REQUIRED` 真正阻塞，等待用户恢复决策；
- [ ] 幂等重试、Observe First、Recovery Required 三条策略各有真实行为；
- [ ] 禁止 Resume Terminal Run，禁止同一 Run 同时启动两个循环；
- [ ] Resume 保留预算、turn、Verification、RecoveryItem 等已完成事实；
- [ ] Tool/Verification 失败不会被结算为 `SUCCESS`；
- [ ] 所有 Port 异常都收敛为 RuntimeError、合法 ToolResult 和具名 Terminal；
- [ ] max model/tool/token/wall-clock hard limits 全部生效；
- [ ] 输出预算恢复确实改变下一次请求；
- [ ] Context hard limit 不会被任何可压缩/不可压缩组合绕过。

### 7.2 安全边界

- [ ] 文件 Tool 对 symlink/realpath 逃逸有明确处置；
- [ ] append 顺序统一为 transcript 成功后才更新内存；
- [ ] frozen RunSpec/Profile/Tool Snapshot 在执行期间不可变；
- [ ] 凭证断言绑定明确的 Endpoint host，而不是只判断少数官方 Key 前缀。

### 7.3 验收脚本

- [ ] `verify:pairing` 真正 cancel 正在运行的慢工具；
- [ ] 对 Effect/Approval/Redaction/Verification 异常分别注入；
- [ ] 加入重复 Tool Call ID、重复 result、orphan result 用例；
- [ ] `verify:resume` 从非 Terminal Run 恢复；
- [ ] 比较基线与恢复路径的 Outcome、消息、文件事实、预算和 Verification；
- [ ] 三条 Resume 策略都验证实际行为，不只验证 branch 名称；
- [ ] Recovery Required 用例证明恢复后没有模型或 Tool 调用；
- [ ] 所有脚本可在不依赖真实凭证和网络的环境下运行。

### 7.4 文档状态

- [ ] roadmap 的“已完成”结论与真实验收结果同步；
- [ ] “三条中断路径全覆盖”“三条恢复分支已验证”等表述有对应可重复证据；
- [ ] 已知限制与实际缺陷分开记录，避免把正确性问题归入后续阶段范围。

---

## 8. 最终判断

阶段 1 的代码量、目录结构和核心抽象已经达到“主体实现完成”的程度，但当前最关键的研究问题——消息级 Resume 是否安全成立、批内配对能否覆盖所有异常出口、Budget/Cancel 是否真的是模型无法绕过的硬墙——尚未被现有实现和验收脚本充分回答。

建议当前阶段状态使用以下表述：

> **阶段 1 主体代码完成；类型检查和依赖边界通过；Resume、安全边界、硬预算与验收证据存在阻断项，待修复并重新验收后关闭阶段。**

