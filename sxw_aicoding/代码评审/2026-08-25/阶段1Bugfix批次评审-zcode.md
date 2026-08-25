# 阶段 1 Bugfix 批次代码评审（zcode）

> 评审日期：2026-08-25
> 评审对象：阶段 1 Bugfix 批次（git 未提交改动，26 个文件 / 约 1326 行新增）
> 实施方案：`~/.claude/plans/1-v20260824-md-bugfix-composed-cloud.md`（组 A：评测报告四项 A1–A4；组 B：阶段 2 四条前置 B1/D-2、B3/R-4、B2/R-6、B4/D-3 探针；另含 U-4）
> 评审依据：上述方案 ＋ `架构设计/WorkAgent架构设计_V20260823_05.md`（V05）＋ `存量BUG/阶段1存量问题清单_V20260824.md` ＋ `评测/Atlas阶段1_Agent评测报告_20260824.md`
> 评审方式：全量 diff 走读 ＋ 关键声明独立复验（typecheck、verify:all、两条边界 grep、真实 trace artifact 校验），非纸面核对
> 性质：**仅评审，未修改任何代码**

---

## 0. 总体结论

**实现与方案高度一致，质量整体过硬，可以提交。** 具体判据：

1. 方案里的 9 个事项（A1–A4、B1、B3、B2、B4、U-4）全部落地，且未越界——方案明确不做的 R-5 判定语义、`outcome.kind` 值域、`deliveredArtifactIds`、grader 层均未被触碰；
2. 方案声明的验收结果经独立复验全部成立（见第 2 节）；
3. 代码注释按仓库纪律写明理由与失败模式（中文、V05/清单条目引用），新增的几段长注释（D-2 取号点、R-6 四缺陷、R-4 guard 的 sideEffectState 分档）质量高于平均水平——它们记录的是「为什么这么定」而不是「这行干什么」。

发现 **2 项 P1（均为文档口径 / 设计登记问题，不涉及代码正确性）＋ 5 项 P2（小问题，不阻塞提交）**，详见第 3、4 节。

---

## 1. 评审范围

改动文件按层分布：

| 层 | 文件 | 对应方案项 |
|---|---|---|
| runtime 核心 | `loop/run-loop.ts`、`facade/index.ts`、`ports/index.ts`、`types/{run,event,context,endpoint}.ts` | B1(D-2)、U-4、A3、A1、B2 |
| Context 层 | `context/compile.ts`、`context/compact.ts` | A1、B2(R-6) |
| Action 层 | `action/settle-batch.ts` | B3(R-4) |
| 形状适配器 | `shape-anthropic-messages/src/protocol.ts`、`endpoint-profiles/bailian-anthropic.json` | B4(D-3) |
| Composition / CLI | `compose.ts`、`main.ts`、`trace/file-sink.ts`（新增） | A1、A3、A4 |
| 验收脚本 | `verify/{harness,pairing,resume}.ts`、`verify/compact.ts`（新增）、`verify/reasoning-tokens.ts`（新增） | B3、B1、B2、B4 |
| 工具用例 | `tools/{list-dir,write-note,append-log}.ts`、`tools/fs-common.ts`（新增） | A2 |
| 文档 | `CLAUDE.md`、存量清单、roadmap、`package.json`、`.gitignore` | 文档回写 |

---

## 2. 独立复验结果（非复述文档声明）

| 验证项 | 命令 / 方法 | 结果 |
|---|---|---|
| 静态 | `npm run typecheck` | ✅ 干净 |
| 边界 grep ① | `grep -rn "@anthropic-ai/sdk" packages apps cases` | ✅ 仅 `adapters/.../client.ts`（合规） |
| 边界 grep ② | `grep -n "profile\." packages/harness-runtime/src/loop/run-loop.ts` | ✅ 仅文件头纪律注释（合规） |
| 脚本 | `npm run verify:all` | ✅ 四条脚本全绿，含 `verify:compact` 5 条判定（A/B 对照：推理片段 100 → 0） |
| 真实 artifact | 直接解析 `.workagent-runs/run-2026-08-25T14-53-15-241Z.jsonl` | ✅ 158 事件 sequence **严格递增、零重号**（1..169，空洞对应 transcript 条目号）；`LoopTerminated: COMPLETED` 在场；footer 含 `outcome.summary`（模型真实总结）——A3/A4/B1/U-4 端到端成立 |
| header/footer | 同上 | ✅ header 含 commit / `profile.id@observedAt` / modelId / task / workspaceRoot / timezone / runId，与方案 A4 清单一致 |
| 规模声明 | `find … -name "*.ts" \| wc` | ✅ 57 文件 / 9337 行，与 roadmap 声明逐字一致 |

另核实两处易错点：

- `facade.observe()`（resume 分支二的观察路径）虽直接调 `effects.resolve` / `verification.verify`，但整体包在 try/catch 里、失败返回 undefined 降级到第三分支——**没有**漏网的 R-4 型调用点；
- `SYSTEM_NOTICE` 在适配器 `roleOf()` 走 default 分支成为第一条 user 消息的首个 text 块，真实复跑产物中模型正确引用了时间事实——A1 的序列化路径是通的。

---

## 3. P1 问题（建议提交前处理）

### P1-1　「剩余 26 项」计数对不上（三处文档沿用）

9 个已关项里只有 **5 个**（D-2 / R-6 / R-4 / D-3 / U-4）属于原 32 项；评测报告那 4 项（时间编造、`list_dir` 误读、summary、trace sink）是清单外新发现，不在 32 里。再加新增的 U-9，实际活跃项 = 32 − 5 ＋ 1 = **28**，不是 26。

逐节清点同样对不上：

- 存量清单第 2 节 header 写「现 7 项」，表内活跃行为 **8** 条（U-1/2/3/5/6/7/8/9）；
- 第 1 节 header 仍写「7 项」，而 R-4 / R-6 已划掉（活跃 5 条）；
- `CLAUDE.md` 与 roadmap 均沿用「26 项」。

这份清单是阶段 2 的设计输入，计数错会传导。**建议提交前统一改对三处数字**（纯文档改动，五分钟）。

### P1-2　时间事实逐轮重渲染且位于 messages 前缀头部，STRICT_PREFIX 端点上会话内隐式缓存每轮失效

`renderTimeFact()`（`context/compile.ts:249` 附近）含时分，每轮 `compileFrame` 用新的 `deps.now` 重渲染；`SYSTEM_NOTICE` 经适配器合并为**第一条 user 消息的首个 text 块**。于是在 STRICT_PREFIX 语义下，每轮请求的最长稳定前缀只剩 system block——越滚越贵的历史**永远命不中隐式前缀缓存**。

代码注释与存量清单 0.3 节第 3 条只论证了「system block 保持稳定」，没有点破这个更强的后果。评测报告的 15% 隐式命中是在**没有**时间事实时测的，A1 落地后大概率更低——这与 D-3 刚抢回来的钱方向相反。

定性：**不是本批的 bug**（`cache_control` 本就未接线，U-9 已挂账），但应当被登记。建议：

- 至少在存量清单 U-9 条目补一句这条耦合；
- U-9 设计时考虑把时间渲染**冻结在 run 级**（`timezone` 已随 RunSpec 冻结，startedAt 渲染同理可冻结）或降低时间粒度——冻结后 run 内前缀稳定，跨 run 才变化。

---

## 4. P2 问题（记录在案，不阻塞提交）

1. **facade resume 的早退出口没有 `LoopTerminated`**：恢复决策 ABORT（`facade/index.ts:248` 附近）与 `RecoveryRequired`（`:403` 附近）直接 return，只有 runLoop 的 `finish()` 发这条事件。U-4 的「Trace 能读出终止路径」对 resume 分支的终止仍不成立，目前靠 footer 兜底。建议在 U-4 条目补边界说明，或阶段 2 顺手补齐。
2. **R-4 注入 fake 的 `as never` 绕过类型检查**（`verify/pairing.ts:32-49`）：fake 的方法名拼错会静默退化成「方法缺失 → TypeError」，经 `guard()` 收敛后用例照样绿。脚本里「把 guard 改成 rethrow 四条全翻红」验证的是 **guard 的判别力**，不是注入形状的正确性。建议改用 `Pick<EffectResolverPort, "resolve">` 之类的窄类型。
3. **`guard()` 失败路径的死赋值**：`settle-batch.ts` 里 `proposed.stage = "REJECTED_SCHEMA"`（`:209` 附近）与 `action.stage = "REJECTED_APPROVAL"`（`:274` 附近）赋值后立即 `continue`，对象不再被读；且把内部异常标成 `REJECTED_SCHEMA` 会轻微误导读 trace 的人（真实原因在 `reason` 字段）。纯噪音，顺手可清。
4. **`verify:compact` C 段的 `compactedTurnIdx` 边界**（`verify/compact.ts:128-131`）：若压后 totalTokens 回到 soft 以下，`findIndex` 返回 −1，`peakBefore` 退化成第一轮的值。当前固定脚本数据不触发，但判据对数据形状有隐性依赖，换参数时易踩。
5. **小勘误**：文档写「158 事件 ＋ 12 条目」，按 trace 实测 169 个号 − 158 事件 = **11** 个条目号（可能含一个 resume 交接空号）。footer 既然写了 `transcriptSequences`，数字应能对齐。

另有一条**面向阶段 2 的实现契约提醒**（非问题）：`InMemoryTranscriptStore.append()` 不传 `atLeast`，同进程下 counter 单调故无损；将来 SQLite 实现必须从已持久化行播种 counter（或每次 append 传 `atLeast`），否则重启后会从 1 重发号——这正是 D-2 要防的事，端口注释已写明，实现时别漏。

---

## 5. 与方案的偏差（均已论证，可接受）

| 偏差 | 方案原文 | 实际落地 | 评价 |
|---|---|---|---|
| B4 探针位置 | `verify:endpoint-profile` 加一段 | 独立脚本 `probe:reasoning-tokens`，不进 `verify:all` | ✅ 方案引用的清单原话本给过「进 spikes/ 或作为一段」两个选项；花钱、发真实请求的探针不应进日常回归，脚本头注释已把理由写透；profile 的 `sourceEvidenceRefs` 已指向本次运行 |
| R-4 注入载体 | 「testkit 需要能注入会抛的 Port 实现」 | `compose()` 新增 `portOverrides`，注入逻辑在 pairing.ts 内 | ✅ 功能等价，落点不同 |
| prompt 多加一行 | 方案只要求加时间事实配套句 | 额外加了「统计数字必须来自工具返回值」 | ✅ 与 A2 同源的小加强，无害 |

---

## 6. 亮点（值得保持的做法）

- **`verify:compact` 的判据设计**：R-6 修复前 `ContextCompacted` 事件照常发出，只看事件流会得出「压缩正常」的错误结论——所以该脚本所有判据都落在**下一轮实际 token 数**与 **transcript 实际内容**上，并用 `reasoningBlockRule` 的 A/B 对照（同脚本只换声明，100 → 0）验证块级剥离。这是对「事件 ≠ 事实」的正面回应。
- **B2 对「保护规则导致不可达」的重构**：把粒度从消息改成协议单元（并查集处理一次多 call 的传递性牵连），并把「用户输入」判据从 `role === "user"` 改成「有 text 块」——两个修法都先在注释里论证了为什么原规则在此架构下永远不触发，并在 0.3 节如实登记为新发现而非沉默修复。
- **B3 的 `sideEffectState` 分档**：按调用点区分 `NOT_STARTED` 与「沿用工具结果」，拒绝一律写 UNKNOWN——注释里「谎报的方向恰好是最贵的那边」准确点出了 RecoveryItem 的代价不对称。
- **D-2 的顺序纪律**：「先 emit 再 persistFacts」的论证（反序会在崩溃后重发已用号）写进了 `persistFacts` 的注释，且真实 trace 验证了单调性成立。

---

## 7. 结论

代码可以提交。提交前建议：

1. 改掉 P1-1 的三处计数（`CLAUDE.md`、存量清单 header、roadmap）；
2. P1-2 至少在存量清单 U-9 条目补一句登记；
3. P2 各项记入后续批次（P2-2 / P2-3 可在下次动 pairing 或 settle-batch 时顺手处理）。
