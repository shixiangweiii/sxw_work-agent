# 阶段 3 代码评审（kimi）

> 评审日期：2026-08-28
> 评审对象：阶段 3（通用能力面）全部实施改动 —— **工作区未提交快照**（`git status`：45 文件修改 ＋ `tools/`、`apps/cli/src/composite.ts`、`stdin-channel.ts`、`packages/store-sqlite/src/{blob,artifact}-store.ts`、`packages/harness-runtime/src/loop/progress-guard.ts`、4 个新 verify 脚本、ADR×3 等新增），基线 HEAD 为 `bb27709`。
> 评审基准：《阶段3实施方案_V20260828-02.md》全文（S1–S14、§4 不得绕过清单 14 条、§5.2 退出门槛 8 条）。
> 评审方式：四个并行评审组分批核对（批 1 工具与装配 / 批 2 大结果与产物 / 批 3 长任务与人机通道 / 批 4 收口＋横向＋实跑），逐条核源码与 `git diff`；主评审人对两条 P1 结论与一处关键 P2 亲自二次抽查源码确认；实跑 `npm run typecheck`、六条边界 grep、全部 12 条 verify 脚本、一次真实端点（bailian）live 三场景。
> 性质：**仅评审，未修改任何源文件**（实跑仅在 `.workagent-runs/` 等运行时目录留下记录）。

---

## 0. 总体结论

**实施与方案高度一致，退出门槛 8 条全部成立，可以收口；但有 2 条 P1 判据质量问题和 7 条 P2 偏离，建议先处置再归档。**

1. **四批 S1–S14 主体全部落地**：10 个通用工具（8 场景＋2 机制）＋2 个测量工具、Blob 外置/取回闭环、ArtifactStore 重设计＋Artifact 级验证、Progress Guard、人工接管状态闭合、跨场景 smoke。
2. **实跑全绿**：`typecheck` EXIT=0；六条边界 grep 无真实违规（第 6b 条注入判别力实测当场翻红并指出行号）；12 条脚本 **84 判据全过**；live 三场景（办公/代码/聊天）5/5，产物均登记且 `verified=true`。
3. **不得绕过清单 14 条逐条可核实成立**（§3）；**退出门槛 8 条全部成立**（§2）。
4. **两个 P1 集中在验收判据的判别力上** —— 恰好踩中方案 §8 风险表点名的「验收脚本膨胀但判别力下降」形态，且都是几行断言量级的修复。

---

## 1. P1 问题（2 条，建议提交前修掉）

### P1-1　`verify:artifact` C 段判据实质恒真 —— 方案点名要换的形态，抬头换了、判据没换

- 方案批 2 验收 C 明确：原断言「不可信内容不能自动批准 Action」在决 3 之下恒真，必须改成「trust 标记正确 ＋ `hasExternalUntrusted` 为 true 时 Trace 里出现对应事实记录」。
- 实际 `apps/cli/src/verify/artifact.ts:329` 的 verdict 是 `untrustedFlowed && frames.length >= 2` —— 5 个工具调用＋两轮编帧的夹具下**必然为真**，唯一失败路径是 Run 本身崩掉，与 trust 无关。对 `EXTERNAL_UNTRUSTED` 标记值、`trustSummary` 汇总一条都没有断言（`:321` 只是 fact 打印）。
- 连带缺口：`ContextFrameCompiled` 载荷（`run-loop.ts:508-513`）不含 trustSummary，Trace 上没有「不可信内容已流入」的专门事实记录点。
- 处置方向：对帧内 item 的 trust 分布做断言（直验 `trustSummary.hasExternalUntrusted === true` 且 counts 与 tool_result 数一致），并给 `ContextFrameCompiled` 载荷补 trust 摘要或在 verdict 中断言一条对应 Trace 事实。

### P1-2　`verify:progress` D 段未断言「观察真的发生」，§20.3 没有会红的判据守着

- 方案 S10【定】：「验收要断言观察**真的发生了**，而不只是状态流转」。
- 实际 `apps/cli/src/verify/progress.ts:388-394` 的 `ok` 只断言状态流转与结果措辞（WAITING 可达、`HANDOFF_COMPLETED_BY_USER`、note 含「他的声明」），**不含 terminal，也不含 h2 那次 `stat` 观察调用发生的任何证据** —— 模型接管后直接收尾，D 段依然全绿。
- 且 Runtime 侧的「重新 Observation」本身只有措辞形态（`request-handoff.ts:178-192` 的 `nextStep` 引导，无机制保证）。两半叠加，「完成信号 ≠ 任务成功」目前无任何判据兜底。
- 修法是一行级：`ok` 加上 terminal 断言，或显式断言 h2 的 tool_result 存在。

---

## 2. 退出门槛 §5.2 八条核对

| 门槛 | 结论 | 关键证据 |
|---|---|---|
| 能力面成立（10 工具） | ✅ | `tools/common/src/index.ts:81-103`；verify:tools 11/11 |
| 通用性成立（三场景） | ✅ | verify:scenarios 脚本化 5/5 ＋ live 实跑 5/5（产物非空、点名对象出现、verified=true） |
| 不过拟合 | ✅ | 六条 grep 全过、6b 注入翻红、prompt 通读无业务规则（`compose.ts:484-529`） |
| 机制被真需求逼出 | ✅ | 外置取回逐字比对 52892 字符一致；检查器恰好四项；Guard/接管各有 verify 段且多数含判别力实测 |
| 状态闭合 | ✅ | 持久化（`facade/index.ts:148-178`）、resume 重新引导不调模型（`:340-344`＋E 段真 kill）、等待扣除（F 段 1200ms→3ms） |
| 数据边界护栏 | ✅ | 读黑名单双工具共用常量表（`read-guard.ts:113-115`）；私网/localhost 拒绝；URL scope riskFact＋dataMovement（`effect-resolver.ts:121-136`） |
| 无回归 | ✅ | 84/84 全绿＋typecheck EXIT=0 |
| 编排层未膨胀 | ✅ | 无 Planner/Memory/Sub-agent；固定开销实测 12 工具 → 2160 token |

---

## 3. 不得绕过清单 14 条核对（全部成立）

| # | 结论 | 关键证据 |
|---|---|---|
| 1 六条边界 grep | ✅ | 实跑无真实违规；verify:tools A 段＋A2 注入判别力实测 |
| 2 两类工具声明 | ✅ | verify:tools B 段 10/10（场景 8＋机制 2） |
| 3 ToolDefinition 三必填 | ✅ | C 段 12 工具无缺失；`types/tool.ts:173` 已无 `?`（类型强制） |
| 4 不新增编排层 | ✅ | runtime 新增仅 `loop/progress-guard.ts`（方案 S9 明确要做的） |
| 5 不建 cases/web-archive/ | ✅ | `cases/` 仅 `micro-cases` |
| 6 工具不静默截断 | ✅ | verify:tools D 段三形状 total/returned/truncated 自洽 |
| 7 fetch_url 不内置正文提取 | ✅ | `fetch-url.ts:27-28`【定】声明，全文无提取逻辑 |
| 8 检查器无任务级规则、无无判别力检查 | ✅ | 恰好四项（hash/编码/JSON/ZIP），无 Markdown 恒绿检查 |
| 9 外置必须配对取回通路 | ✅ | verify:artifact A 段逐字比对 52892 字符一致 |
| 10 CompositeVerifier 路由三方法 | ✅ | `composite.ts:79/107/116`；E 段改坏 `observePre` 当场翻红 |
| 11 主循环纪律（有限扩展） | ✅ | 新增均具名、走 `nextState()`、有对应 verify 段（`run-loop.ts:776-783`） |
| 12 persistFacts() 加字段整体带过 | ✅ | `run-loop.ts:238-266`（`artifactChecks` 全部写点带齐） |
| 13 读黑名单覆盖 read_file 与 search | ✅ | F 段两工具各试 .env 均被拒；共用一份常量表 |
| 14 prompt 无业务规则 | ✅ | `compose.ts:484-529` 通读，全部为能力边界与工具选择指引 |

---

## 4. P2 问题（7 条，补齐或按方案纪律登记为已知欠账）

1. **S9「周期性回报」未实现，声明先行。** `fetch_url` 全文仅 1 次 `onProgress`（`fetch-url.ts:129`）；`read_file`/`search` 声明了 `HEARTBEAT 30s`（`read-file.ts:106`、`search.ts:130`）却**零生产点**；且事件在工具返回后才排空（`settle-batch.ts` 注释自认非实时）。「声明了却不做」正是方案批评的「未接线比不写更糟」。
2. **Guard「还活着」判定只写不读。** `progress-guard.ts:75` `lastProgressTime()` 全仓零读者，`noteProgress` 无决策出口 —— 「Guard 消费它判定还活着」字面接线、机制空转。要么接判定，要么删掉承认 Guard 只做重复检测。
3. **fetch_url 二进制未外置 Blob。** 方案 S7 契约原文「只返回元数据**并外置 Blob**」，实际正文直接丢弃（`fetch-url.ts:205-209`，工具无 blobs 注入）。模型取回 PDF 后永远拿不到内容 —— 与 S6.5 论证的「信息阻断」同形。
4. **`eval/suite` 未加 `--endpoint`。** 方案 S1 原文要求 CLI 与 eval/suite 都加受枚举约束的 `--endpoint`；`eval/suite/index.ts:303-307` 只认 `--live`/`-n`，`compose()` 调用未传 endpoint。
5. **`MAX_REDIRECTS = 5` 声明零消费**（`fetch-url.ts:44`），实际靠 undici 默认上限（20）兜底 —— 方案自己反复警告的「有声明、零消费」形态。
6. **README 未同步 `--yes`/`--yes-all` 新语义**（`README.md:25` 仍写「--yes 跳过交互式审批」）。回归评测 P2-1 点名 README；README 整体停留在阶段 1 口径（「三条验收脚本」/「四条边界」等）。
7. **`verify:progress` G 段后半未做**：批 3 验收表要求「三种 stdin 语义各触发一次且互不串台」，脚本只测了 interject，审批/接管两态的 StdinChannel 分派零触发，以结构论证替代实测（`progress.ts:633-636`）。

---

## 5. P3 问题（瑕疵与文档口径，收口时批量修）

- **「11 个工具」数字系统性错误**：实际默认装配 12 个（10＋2），8+2+2=12 算术本身不成立；Roadmap §5、V05 §28.4、CLAUDE.md、存量清单 §0.6、ADR-0004 多处写「11」，ADR-0004 的「11 工具 ≈ 1980 token」与脚本实测 12 → 2160 不符。
- **requiredCapabilities 零消费注释 10/12**：缺 `append-log.ts:69`、`slow-write.ts:61`，而存量清单 S3-1 写「**每个**声明处」。
- **S13 任务 B 未按方案「分析本仓某个模块」**，用了 temp 夹具（有确定性理由，但偏离方案文字；live 模式本可对本仓真模块跑）。
- `compose.ts:555` M-6 陈旧注释仍写「STANDARD 打邮箱」，与 P3-26 修复后的代码矛盾。
- CLAUDE.md 被更新 ＋143 行，与方案 §7「本阶段不逐次维护」的记载不一致 —— 需确认是用户改口还是实施者自行维护。
- prompt 给测量工具 `append_log` 写了选择指引（`compose.ts:499`），与「任务 A 不用 append_log」的反过拟合示范有轻微张力。
- verify:progress 三处弱断言：C 段不钉「取消落在执行中」（离线环境 fetch 快速失败时假绿）、E 段 `InteractionResumed` 只打印不断言、A 段无「Guard 消费」断言。
- `slow_write` 声明 `intervalMs: 1000` 与实际每 200ms 一报不符。
- verify:tools：G 段判据接近恒真（方案口径本就是「打印读数」，知情取舍）；E 段「两个包都路由」只实测 common 包（micro 包由 verify:crash 间接覆盖）。
- 记录在案（注释已如实写明边界，单人本地开发期可接受）：fetch_url 重定向只复检终点不检中间跳、DNS 校验 TOCTOU 未做 IP 固定、countTokens 为本地估算（`length/2.5`）。

---

## 6. 高质量项（值得点名）

- **N-8 错误分类修复**（EACCES/ENOTDIR/ELOOP 分家，条目级 stat 失败不拖垮整页）与 **P3-26 修复**（email 正则归入 STRICTEST，sk-/Bearer 凭证脱敏未削弱）均干净彻底。
- **组合器三方法路由＋判别力实测**（改坏 `observePre` 当场翻红）—— 方案最担心的分支二静默退化被专门守住。
- **ArtifactStore 是真重设计**（版本链/Tombstone/role/工具显式登记触发源），outcome 映射 `DELIVERABLE→FAILED` 与 `INTERMEDIATE→COMPLETED_WITH_LIMITS` 可区分且有反向判别力（G 段）。
- **slow_write「慢的写 ≠ 慢的空转」**、`sideEffectState` 诚实上报、主循环五条纪律、`persistFacts` 字段整体带过，均有代码注释与判据双保险。
- **S14 文档回写**（AGENTS/Roadmap/V05/评测报告 §5.1 口径更正/存量清单/探针记录原始输出入库/ADR×3）基本齐全且言之有物。

---

## 7. 处置建议

1. **提交前**：修 P1-1、P1-2（均为几行断言级修改）。
2. **收口时**：P2-1/2/3/5/7 要么补齐、要么按方案自身纪律登记进存量BUG清单为已知欠账；P2-4、P2-6 与 P3 文档口径一并修。
3. 补充说明：本次评审中 verify:scenarios 的 live 实跑（真实端点，约 2.5 分钟，5/5）补上了批 4 验收要求的「三个跨场景任务实跑记录」—— `.workagent-runs/` 里此前只有一条启动自检 run。

---

## 附：分批符合性速览

| 批次 | 结论 | 说明 |
|---|---|---|
| 批 1（S1/S2/S2.5/S3/S4/S5＋verify:tools） | ✅ 主体符合 | 唯一 P2：eval/suite 未加 --endpoint |
| 批 2（S6/S6.5/S7/S8＋verify:artifact） | ⚠️ 符合带缺口 | P1-1（C 段恒真）；P2：二进制未外置、MAX_REDIRECTS 零消费 |
| 批 3（S9/S10/S11＋verify:progress） | ⚠️ 符合带缺口 | P1-2（D 段观察未断言）；P2：周期性回报/Guard 消费空转、G 段后半未做 |
| 批 4（S12/S13/S14＋横向） | ✅ 符合 | 无 P1；P2：README 口径；P3：文档数字与注释口径 |
