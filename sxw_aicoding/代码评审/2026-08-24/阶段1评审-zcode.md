# 阶段 1 代码评审（zcode）

> 文档版本：V20260824
> 评审日期：2026-08-24
> 评审对象：阶段 1 全部实现（52 个 TS 文件 / 6619 行，git 未提交状态）
> 评审依据：`架构设计/WorkAgent架构设计_V20260823_05.md`（V05）、`实施方案设计/阶段1实施方案_V20260823.md`、`阶段roadmap/WorkAgent阶段Roadmap_V20260823.md`
> 评审方式：全量源码走读 + 判据实测运行（typecheck、三条 verify 脚本、四条边界 grep），非纸面核对
> 性质：**仅评审，未修改任何代码**

---

## 0. 总体结论

架构落地质量**高**。四条机械边界全部通过，三条验收脚本实际可跑且全部通过，配对不变量的"单点收敛"设计（ledger 去重 + `finally` 补齐 + 双向扫描）是全代码库最扎实的部分，代码注释与 V05 条款逐条可对照。

但存在三类问题：

- **5 个会产生错误行为的逻辑缺陷（P1）**；
- **6 项"写了但从未接线"的机制（P2）**——类型、事件、类都存在，给读者"有这层保护"的印象，运行时却从不执行，与"证据先于冻结"的纪律相悖；
- **5 处文档 / 脚本声称与实际覆盖面的偏差（P3）**。

| 严重度 | 数量 | 定义 |
|---|---|---|
| **P1** 逻辑缺陷 | 5 | 与 V05【定】条款冲突，或会产生错误运行行为 |
| **P2** 未接线机制 | 6 | 声明/设计存在，运行时从不执行（当前无行为影响，但构成"以为有保护实际没有"的假象） |
| **P3** 声称偏差 | 5 | 文档 / Roadmap / 验收脚本的表述与实际覆盖不符 |
| **P4** 小问题 | 8 | 可维护性、类型卫生、工程配置 |

---

## 1. 符合性核对（实测）

| 判据 | 结果 |
|---|---|
| `npm run typecheck`（`tsc --noEmit`，strict + noUncheckedIndexedAccess） | ✅ 干净 |
| `grep -rn "@anthropic-ai/sdk" packages/ apps/ cases/` | ✅ 无结果（SDK 只在形状适配器） |
| 端点名进 Runtime 代码（dashscope / bailian / 百炼） | ✅ 仅注释中的实测引用，无代码行 |
| 主循环读 `profile.*`（`run-loop.ts`） | ✅ 仅文件头纪律注释 |
| Runtime import Case Package（micro-cases） | ✅ 无结果 |
| `verify:endpoint-profile` / `verify:pairing` / `verify:resume` | ✅ 实跑全部通过、退出码 0 |
| `.env` 泄漏防护 | ✅ 已 gitignore、未被 git 跟踪 |

---

## 2. P1 —— 逻辑缺陷

### P1-1 usage 合并会清零 inputTokens

**位置**：`adapters/shape-anthropic-messages/src/client.ts:115-120`（message_delta 分支）、`client.ts:202-223`（readUsage）

`message_delta` 分支执行 `usage = { ...usage, ...readUsage(u) }`，但 `readUsage` 对缺失字段**返回补 0 的完整对象**。Anthropic 流式协议里 `message_delta.usage` 通常只携带累计 `output_tokens`——这一展开会把 `message_start` 已拿到的 `inputTokens / cacheRead / cacheCreation` 全部覆盖为 0，`billedInputTokens` 随之归零。

后果：

1. 恰好破坏 V05 §19.3 用一整节强调的计费公式（"只读 input_tokens 在缓存命中时低估达 85%"）；
2. 预算的 `inputTokens` 累计随之低估，`maxInputTokens` 预算形同虚设。

修法方向：只覆盖消息里实际出现的字段。

### P1-2 OUTPUT_LIMIT_RECOVERY 是无效恢复

**位置**：`packages/harness-runtime/src/loop/run-loop.ts:351`

`maxOutputTokensOverride: (state.maxOutputTokensOverride ?? frame.reservedOutputTokens) * 4` 写进了 LoopState，但**全仓库没有任何代码读这个字段**（grep 确认仅 3 处：类型定义、置初值、此处赋值）。`context/compile.ts` 的 buildFrame 固定用 `policy.reservedOutputTokens`，`protocol.ts:58` 用 `frame.reservedOutputTokens || deps.maxOutputTokens`。

错误消息声称"第 N 次抬高上限重试"，实际以同样的 max_tokens 重发，必然再撞同一堵墙——两次恢复预算烧完，落到 CONTEXT_EXHAUSTED。这是对 §16.1"识别为明确错误条件并恢复"条款的假实现。

### P1-3 resume() 不保留预算，且无 §18.3 重新校验

**位置**：`packages/harness-runtime/src/facade/index.ts:73-171`

V05 §18.4【定】Resume "保留 RunId、RunSpec、已完成副作用**和预算使用**"。实现里 resume 重新构造 LoopState：`turnCount=0`、`budgetUsage` 清零、`startedAt=now()`。

后果：**反复 crash+resume 可以无限绕过 maxTurns 与墙钟预算**。

§18.3 的七项外部世界重新校验（capability、contentHash、端点声明一致性等）也完全没有实现。阶段 1 简化本身可以接受，但当前代码语义与文档【定】条款直接冲突，至少应在代码注释里显式声明"阶段 1 已知缩水"（现有注释只说明了幂等性取舍那一条）。

### P1-4 §18.2 分支二不观察、分支三不停止、第三分支不可达

**位置**：`packages/harness-runtime/src/facade/index.ts:95-161`

三个连续问题：

1. **`OBSERVE_FIRST` 名不副实**：该分支只合成一个 `RESUMED_UNKNOWN` result 继续跑，从不调用 Observation / Verifier。§18.2 说"先观察外部世界，据结果决定"——现在的行为是把 UNKNOWN 结果喂给模型继续推进，模型很可能相信写入失败而**重写一次**，这正是该分支要防的双写。
2. **`RECOVERY_REQUIRED` 不停**：`blocked=true` 时 yield 了 `RecoveryRequired` 事件、置了一次状态，但紧接着无条件 `status.set("RUNNING")` 继续执行循环（`facade/index.ts:159-161`）。"交用户决定"没有任何等待点。
3. **第三分支在当前工具集下不可达**：`cases/micro-cases/src/tools/write-note.ts:62-65` 注释明确说"把它标成非幂等，是为了让阶段 1 有一条能落进『非幂等且不可观察』分支的路径可测"——但 facade 的判定顺序是先查幂等、再查 `verification.mode === "REOBSERVE"`（`facade/index.ts:99-105`），write_note 因 REOBSERVE 优先落入分支二，**永远到不了分支三**。注释声明的测试意图没有实现。

实测确认：`verify:resume` 实跑输出中，B2 段命中分支仅 `IDEMPOTENT_RETRY、OBSERVE_FIRST` 两条；`resume.ts` 文件头注释"本项会把三条分支各走一遍"与事实不符。

### P1-5 审批等待时间计入 activeWallClock

**位置**：`packages/harness-runtime/src/loop/run-loop.ts:173-181`

`elapsed = now() - state.budgetUsage.startedAt` 包含了 `await approvalDecider` 的全部等待时间。V05 §16.1【定】"`maxActiveWallClockMs` 只累计 RUNNING 且有在途步骤的时间；**WAITING_\* 不累计**——等审批一小时不该把预算耗光"。

现状：交互式审批挂一小时，用户批准后下一轮迭代直接 `BUDGET_EXHAUSTED` 终止。叠加 P2-2（审批无超时、cancel 不能打断 `rl.question`），这是一个用户可实际踩到的路径。

---

## 3. P2 —— 写了但未接线的机制

这类问题的共同危害：类型、事件、类都存在，**给读者"有这层保护"的印象，运行时却从不执行**。与本项目"证据先于冻结"的纪律相悖——按 D-22 精神，未接线的机制比不写更糟。

| # | 机制 | 位置 | 现状 |
|---|---|---|---|
| P2-1 | **DriftDetector 全部三规则** | `model/capability/drift-detector.ts` | 类从未被实例化（grep 确认仅 export）；`EndpointBehaviorDrift` 事件从未发出。实施方案 S3 声称已交付"三条最小规则"，实为已编写未接线。§8.6 不变量 4"不得静默继续"目前无运行时载体 |
| P2-2 | **全部超时** | `loop/interrupt/index.ts:83`（stepSignal）、`write-note.ts:67`、`list-dir.ts:50`、micro-cases verifier | `timeoutPolicy`、`verification.timeoutMs`、审批超时（§14.3 AbortSignal.timeout）均无执行路径；`stepSignal()` 无人调用。cancel 也无法打断审批等待（`apps/cli/src/main.ts:55` 的 `rl.question` 不监听 signal） |
| P2-3 | **LoopTerminated 事件** | `types/event.ts` 有定义，runLoop 无 emit | §19.2"Trace 里能直接读出走了哪条恢复路径"对 continue 成立、对终止不成立；终止原因只在 generator return 值里，Trace sink 看不到 |
| P2-4 | **Progress Guard / ToolProgress** | `action/settle-batch.ts:272-277` | `progressNotes` 收集后从未发出、从未消费；§16.2 的无进展检测完全缺席（write_note 声明了 HEARTBEAT 模式，纯声明） |
| P2-5 | **mayRetryAutomatically / profileMatches** | `types/error.ts:136`、`model/capability/profile-loader.ts:74` | 两个判据函数均无人调用。后者意味着 **compose 不校验声明与 baseUrl 的对应关系**——把 baseUrl 换成 DeepSeek 而保留百炼声明不会有任何警告；credential-guard 也只挡"第三方 key → 官方 host"单方向，反方向（官方 key → 第三方代理）不挡（`credential-guard.ts:41-51`） |
| P2-6 | **softLimitRatio、BudgetSoftLimitReached** | `budget/index.ts:66`、`types/event.ts` | 字段与事件类型均无生产/消费点 |

---

## 4. P3 —— 声称与覆盖面的偏差

1. **"执行中能插话"没有用户入口**。Roadmap §3"做完是什么样子"明确列出"执行中能插话"；`runtime.interject()` API 存在，但 `apps/cli` 全目录无任何调用点（grep 确认），CLI 运行期间没有 stdin 监听。`WAITING_FOR_USER` 同样只有类型定义、无任何写入点、无 ask-user 工具。这两项都在 Roadmap"最小实现范围"清单里。

2. **pairing 脚本的"中断路径 B"实为审批拒绝**（`apps/cli/src/verify/pairing.ts:65-76`）。§9.2 的三路径是流式中断 / 工具执行中断 / 模型错误；脚本用"第二个被审批拒绝"冒充"工具执行中断"。真正的批中途 abort（finalize 以 `aborted=true` 补 SKIPPED）只在 `verify:resume` B 段被顺带覆盖。覆盖事实上分布在两个脚本，但 pairing 的标签会让读者（以及 Roadmap"三条中断路径全覆盖"的表述）高估其覆盖。

3. **event.sequence 与 transcript sequence 是两条独立计数器**。`types/event.ts` 注释声称"与 transcript 同一条序列"（§19.1），实际 `runLoop` 的 `seq` 与 store 的 sequence 各自递增、必然漂移；resume 后新 runLoop 的 seq 从 0 重计，与 facade 手工发的 `lastSeq+1/+2/+3` 冲突。阶段 2 做 Layer 2 投影游标（§23.2）前必须统一。

4. **`verify:endpoint-profile` 失败不返回非零退出码**（脚本 main 无 `process.exit(1)`，pairing / resume 都有）。`verify:all` 的 `&&` 链对它失去失败检测能力，无法 CI 化。

5. **Compact 不写 COMPACT_BOUNDARY、压缩结果不回写 state.messages**（`context/compile.ts:53-66` 只作用于帧内；`COMPACT_BOUNDARY` 类型从不写入 transcript）。每轮从全量历史重新压缩，"从最后一个 boundary 之后重建"的语义永远不触发。属于已声明的"没被真跑过"路径，但该路径里的这两个缺口应在阶段 2 转正前补齐，否则 Replay 与重建语义对不上。

---

## 5. P4 —— 小问题 / 可维护性

| # | 问题 | 位置 |
|---|---|---|
| P4-1 | 死变量：`const registry = new ToolRegistry(tools); ... void registry;` | `apps/cli/src/compose.ts:115,197` |
| P4-2 | `runId as never` / `runId as RunId` 字符串断言绕过 branded type（应经 `asId`） | `main.ts:89`、verify 脚本多处 |
| P4-3 | `inspect()` 返回硬编码 0 的 turnCount / budgetUsage / messageCount——"只读投影"返回假数据 | `facade/index.ts:195-217` |
| P4-4 | `runs / specs / status` 三个 Map 永不清理（单次 CLI 无害，长驻进程泄漏） | `facade/index.ts:32-34` |
| P4-5 | render.ts 模块级可变 `streaming` 状态（单进程 CLI 可接受） | `render.ts:18` |
| P4-6 | workspace 各 package.json 未声明相互依赖（依赖图只存在于目录约定与 import 习惯，"单向依赖的编译期表达"未完整兑现）；`@anthropic-ai/sdk` 只在根声明，适配器包自身不声明 | 各 `package.json` |
| P4-7 | SimpleRedaction 对 STRICTEST 与 STANDARD 行为完全相同（档位未区分）；`fieldsToRedact` 未用 | `compose.ts:218-261` |
| P4-8 | `credential-guard.ts` 的 `maskKey` 导出未用；client 对缺失 tool id 合成 `toolu_missing_${idx}`（跨 invocation 可能撞 id，Anthropic 形状实际不会发生） | `credential-guard.ts:55`、`client.ts:192` |

---

## 6. 亮点（值得保持的设计）

- **不变量 8 的三层防御**：`settle()` 重复结算直接抛错（`settle-batch.ts:103-110`，把"恰好一个"防成"最后一个"）、`finally` 里的 `finalize()` 兜底、`findUnpairedToolUses` + `findOrphanResults` 双向扫描。批结算台账是教科书级的单点收敛。
- **循环纪律的可执行化**：`nextState()` 在类型层面强制完整状态构造；五条纪律连同 grep 判据写在文件头；`verify:endpoint-profile` 用代码指纹 diff 证明"换声明不改主循环"——这个验收设计比常规测试更强。
- **实测结论的落码密度**：billedInputTokens 公式、MODEL_SDK 来源、QUOTA / RATE_LIMIT 分离、`perRequestBaseTokens`、推理吃光输出预算的显式识别、`honorsDisableParallelToolCalls` 只在声明为 true 时才发送参数——每处都有出处注释。
- **ScriptedModelPort 只替换 ModelPort 不替换 ProtocolPort**（`verify/harness.ts:63-67` 注释说明理由）——保住了 endpoint-profile 验收的有效性。
- **write_note 分段延迟 + NOT_STARTED 语义**：中断点设计使副作用状态可判定，与 UNKNOWN 的区分严格。
- **双道路径校验**：EffectResolver 归一化 + 工具执行边界 `isInside` 复查（§22.1 的落实）。
- **dotenv `override: true`** 把 Spike 0 踩过的坑变成不变量，配 fail-fast 断言。

---

## 7. 对阶段 2 的建议（按优先级）

1. **先修 P1-1 / P1-2**：两处都是小改动，且 P1-1 影响所有真实端点运行的账目。
2. **P2-1 漂移检测接线**是 §24.6"端点能力回归 + DeepSeek 对照"的前置——对照端点测试的意义就建立在能观测漂移上。
3. **resume 语义（P1-3 / P1-4）正好是阶段 2 的主题**，建议把以下四点写进阶段 2 方案，而不是当作阶段 1 遗留：
   - resume 保留预算与轮次；
   - OBSERVE_FIRST 真正调用 Observation；
   - RECOVERY_REQUIRED 真正停止等待用户决策；
   - 第三分支补一个可测工具（或提供 verification.mode=NONE 的非幂等工具用于注入）。
4. **transcript / event 序列统一（P3-3）必须在 SQLite 落盘之前做**，否则游标语义带病进库。
5. 补写四份 ADR 时，建议把本评审的 P2 清单作为"已声明未接线机制"的处置记录——这与 V05 §2.5"删掉一个拿不出证据的机制与新增一个有证据的机制是同一条纪律"直接呼应。

---

## 附录：评审执行记录

| 项目 | 命令 / 方法 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过，无输出 |
| 验收脚本 1 | `npm run verify:endpoint-profile` | 通过（E 段：四个主循环文件指纹未变；虚拟端点组合 MODEL_ERROR / CONTEXT_PROTOCOL_INVALID） |
| 验收脚本 2 | `npm run verify:pairing` | 通过（四场景 3 call / 3 result 一一对应） |
| 验收脚本 3 | `npm run verify:resume` | 通过（B2 命中分支：IDEMPOTENT_RETRY、OBSERVE_FIRST） |
| 边界 grep ×4 | 见 §1 表 | 全部通过 |
| 死代码排查 | grep `maxOutputTokensOverride` / `DriftDetector` / `stepSignal` / `mayRetryAutomatically` / `profileMatches` / `ToolProgress` / `LoopTerminated` | 确认 P2 清单 |
| 凭证安全 | `git check-ignore .env`、`git ls-files` | .env 已忽略、未跟踪 |
