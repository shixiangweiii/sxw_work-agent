# 全仓代码评审报告：过期代码 / 名实不符 / 过期注释 / 历史兼容残留

- 评审日期：2026-09-03
- 评审基线：提交 `801b200`（轮次展示），工作区干净（仅 `.DS_Store` 未跟踪）
- 评审范围：全仓 128 个 `.ts/.js` 源文件约 49,700 行（不含 `spikes/`、`sxw_aicoding/`）
- 方法：`npm run typecheck` 基线（通过）→ 机械扫描（导出符号全仓词频、兼容关键词 grep、verify 脚本注册核对）→ 5 路分区逐文件深读（harness-runtime+store+testkit / tools+adapters+cases+eval+考卷 / cli 非 verify / service+ui / verify 全目录）→ 关键结论本人二次复核
- 标注：✅ = 本次评审中人工二次验证源码确认；☑ = 深读阶段逐行验证；⚠ = 存在合理设计解释的空间，需拍板
- 范围约束：仅评审，未改动任何代码
- 评审前提（用户指令）：**个人使用项目，不为旧数据/旧接口保留兼容层**；凡"为历史保留"的降级分支都按可删处理，除非它保护的是现行功能

## 摘要

| 类别 | 条数 | 最高优先级 |
|---|---|---|
| 历史兼容残留 | 6 | 旧 Trace 兼容链（有验收判据主动维护，与全仓宣言直接矛盾） |
| 命名/注释与语义不一致 | 10 | run-shell 产物角色"与 write_file 同一纪律"为假；workspace 启动激活行为疑似回归 |
| 死代码/多余导出 | 12 | `Composed.transcript`、`readGuardRules`、`TraceHeader` 契约脱节 |
| 验收判据失效（本仓特有的"过期代码"） | 5 | `isActiveBased()` 恒真、假证据行 |
| 过期注释（指向已删对象/翻案结论） | 16 处成批 | `UNKNOWN_LEGACY` 悬空引用 ×4 |
| 冻结一次性材料 | 2 | `考卷/` 目录（不参与 typecheck、无脚本引用） |

AGENTS.md 宣称的"16 个验收脚本"与 package.json 实测一致（17 个 `verify:*` 键 = 16 脚本 + `verify:all`），未过期。四条依赖边界 grep 全部干净，12 个工具文件头部声明齐全。

---

## 一、历史兼容残留（重点专项）

### 1.1 旧 Trace 缺字段兼容链 —— 宣称已删、实际残留的第二套规则 ⚠ 需拍板

仓库三处宣言「旧数据不再兼容，规则因此只剩一套」（`apps/cli/src/compose.ts:116`、`apps/workagent-service/src/workspace-hosts.ts:56-57`、`apps/workagent-service/src/server.ts:59-60`）**就存储路径规则本身属实**，但投影/契约/UI 三层存在一条完整的、为旧版 JSONL trace 保留的降级链：

- ✅ `apps/workagent-service/src/projection.ts:555-563` — 注释原文「旧 Trace 没有这两个字段：保留轮级 frame，等 completed 事件创建兼容调用」；`invocationId`/`frameId` 在当前事件类型上是**必填**（`packages/harness-runtime/src/types/event.ts:50-62`），现行写方总是产出（`context/compile.ts:318`、`loop/run-loop.ts:588`），`typeof !== "string"` 分支只可能由旧版本写出的 JSONL 触发；
- ☑ `apps/workagent-service/src/projection.ts:588-591` + `:500-521` — `appendCall` 用 `model-event:${sequence}` 造"兼容调用"兜底 id；
- ☑ `apps/workagent-service/src/api-types.ts:187`（「兼容主行」注释）、`:205-211`（`invocationId?`/`frameId?` 为旧 Trace 而可选）、`:235` 附近；
- ☑ `apps/workagent-ui/public/app.js:974`（「旧 Trace（无 invocationId）」文案）、`:997-1003`（`model-call-legacy` 专属渲染分支，配套 `app.css:672`）、`:1185`（「可能是旧 Run…」）；
- ☑ `apps/cli/src/verify/ui.ts:1607-1635` — **判据在主动维护这套兼容**：手工 `delete payload["invocationId"]` 构造旧形状并要求为绿。

一个缓和因素：trace JSONL 是追加式跨版本轨道，旧 Run 的后段由新代码写，同文件混合格式确实可能出现——但按"个人项目不做历史兼容"的口径，删旧 Run 数据即可，这条链整体可拆。**拆除需 projection / api-types / app.js / ui.ts 判据四处同一批处理，只删一处会让 verify:ui 翻红。**

### 1.2 `executionPrivilegeOf` 缺字段 → SANDBOXED 兜底 ⚠ 需拍板

- ✅ `packages/harness-runtime/src/types/run.ts:51,82` — 以「从一份**可能来自旧库**的 AgentSpec 里读」为由，对类型上**必填**（run.ts:120）的字段保留 `undefined → "SANDBOXED"` 默认分支。
- 与同仓纪律的矛盾：`packages/store-sqlite/src/db.ts:15-18`「没有 migration 机制，schema 变了删库重建」；`packages/harness-runtime/src/types/transcript.ts:11-14` 正是以"挡的是不可能存在的数据"为由删掉了逐行 `schemaVersion`。按同一条判据，drop-rebuild 前提下此分支不可达。
- 作者有两个刻意的辩护（run.ts:54-57「缺字段推出当时在沙箱里是**事实**不是猜测」、且已把推断收敛进单函数），非法值也确实抛（run.ts:84）。所以这是"半兑现"的兼容：非法值 fail-fast 做了，缺字段还留着默认。若盘上已无 ADR-0012 之前的 workspace 数据，删分支；若保留，则 run.ts:75「不保留兼容层」这句话只对了一半。

### 1.3 `now.ts` 的宿主时区回退：不可达 + 与自己【定】矛盾 ✅

- `tools/common/src/time/now.ts:68-69`【定】「**不读宿主时区**——它必须与注入的时间事实用同一个时区」；
- `:76` 实现 `ctx.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone` 正是读宿主时区。`ToolExecutionContext.timezone` 在 `packages/harness-runtime/src/ports/index.ts:238` 为必填 `string`，`??` 右支恒不可达。删回退、直取 `ctx.timezone`，注释与代码即归一。

### 1.4 deepseek profile 的 `usageFieldMap` 是写错键名的惰性死配置 ☑

- `adapters/endpoint-profiles/deepseek-anthropic.json:36-39` 用键 `input`/`output`；
- 读取方 `adapters/shape-anthropic-messages/src/client.ts:267-270` 查表的键是 `inputTokens`/`outputTokens`/`cacheCreationInputTokens`/`cacheReadInputTokens`（bailian profile 用的正是这套）。`map[k]` 对 deepseek 恒 `undefined`，功能全靠 `pick` 的内置 fallback 侥幸成立。要么删整块，要么改成与 reader 一致的键——现在这种"看起来有配置、实际没接线"的形态最容易误导后续编辑。

### 1.5 `.workagent-runs` 旧路径名残留 ☑

现行唯一约定是 `<ws>/.workagent/runs/`（`apps/cli/src/compose.ts:128-133`；`compose.ts:113-116` 宣布删掉旧默认时代规则）。旧目录名残留三处：

- ✅ `apps/workagent-service/src/run-host.ts:74` — 注释「与 CLI 同一个约定（`.workagent-runs/<runId>.jsonl`）」，括号里的路径已不存在；
- ✅ `packages/store-sqlite/src/db.ts:381` — 面向用户的错误提示仍写「Trace（`.workagent-runs/*.jsonl`）是独立轨道」；
- ⚠ `tools/common/src/fs/search.ts:75` — 读黑名单还列着 `.workagent-runs` 条目。对不存在目录的 deny 是死配置，若按 defense-in-depth 保留应把现行 `.workagent` 已覆盖的事实写进注释。

### 1.6 `--yes-all` / `--confirm` 迁移提示 ⚠（低）

- ✅ `apps/workagent-service/src/main.ts:94-95`、`apps/cli/src/main.ts:212-213` — 已删 flag 在 `assertKnownArgs` 里留了「已改成 --approval auto（ADR-0012）」的纠错提示。AGENTS.md 明确「没有 --yolo 别名」的严格口径，这两条是给唯一使用者自己肌肉记忆的错误提示，成本极低可留可删，留作记录。

---

## 二、命名 / 文案 / 注释与代码语义不一致

### 2.1 `run_shell` 产物角色「与 write_file 同一条纪律」是假话 ✅（高危，判据级别）

- `tools/common/src/exec/run-shell.ts:691-694` — 注释【定】「只认 DELIVERABLE / INTERMEDIATE，与 write_file 同一条纪律」，实现 `input.artifact_role === "INTERMEDIATE" ? "INTERMEDIATE" : "DELIVERABLE"`：**任何**非 INTERMEDIATE 值（含拼错的 `"yes"`）默认成 DELIVERABLE；
- 对照 `tools/common/src/fs/write-file.ts:164-169` — 对同一输入返回 `undefined` → 不登记产物，其 `:159-163` 的理由恰是「随手传 yes 就登记交付物、DELIVERABLE 检查失败判 Run FAILED」。
- 两个工具对同一参数一宽一严，注释却声称同一纪律。后果不对称且偏危险方向（错值 → 交付物登记 → 检查失败 → 整个 Run 判 FAILED）。要么统一为 write_file 式三态，要么改注释并在工具 schema 用枚举约束。

### 2.2 workspace 启动激活：注释承诺与行为相反 ⚠ 疑似功能回归（不只是注释问题）

- ✅ `apps/workagent-service/src/workspace-hosts.ts:78-81`【定】「显式传 --workspace 就以它为准；**没传则沿用注册表里上次用的那个**……一个每次启动都跳回默认目录的界面，会让切换功能形同虚设」；
- ✅ `:82-85` 实现无条件 `registry.create(bootstrap.path)` + `activate(created.entry.id)`，且调用方 `apps/workagent-service/src/main.ts:104` 在无 `--workspace` 时**恒**传入默认值 `REPO_ROOT/.workagent-workspace` —— 即注释自己批判的"每次启动都跳回默认目录"正是当前行为。要么 main 在无 flag 时不传 bootstrap、registry 恢复上次激活项，要么注释改写为现状。这直接决定 UI 重启后落在哪个 workspace，建议优先确认。

### 2.3 `digest()`「全仓唯一一份」声明被同包本地实现破坏 ✅

- `packages/harness-runtime/src/types/ids.ts:44-48`「短摘要。**全仓唯一一份** —— …ContextItem/Frame 的 contentHash 都走它……【定】不要在各文件里各写一个 `sha256(s).slice(0, 32)`」；
- ✅ `packages/harness-runtime/src/context/compile.ts:509-511` 正是一个本地 `sha256(s) = createHash(...).slice(0, 32)`，`:398/:506` 的 contentHash 走它。当前两实现字节相同无行为差，但该注释警告的"口径分叉"防护恰好在本包内失守（Progress Guard 打转检测比的正是这类 digest）。统一走 `digest()`。

### 2.4 `settle-batch.ts:415` 恒真合取项伪装成过滤器 ☑

- `if (snapshot.definition.recoveryObservation && deps.verification.observePre)` — `recoveryObservation` 在 `types/tool.ts:271` 是**必填**（tool.ts:261-269 记录「阶段 3 去掉 `?`」），左项恒真，真正起筛选作用的只有 `observePre`。这正是本仓反复清理的「恒真的合取项读起来像一条保护」形态（compile.ts:493 有同类自述）。

### 2.5 run-shell 场景头「看 git 状态」名不副实 ☑

- `tools/common/src/exec/run-shell.ts:19` 声明场景「代码：跑测试、跑构建、**看 git 状态**」；但 `command-analysis.ts:91-99` 记录 `.git` 被读黑名单内核级 deny、`git` 已移出只读白名单，沙箱下该用例跑不通。工具头部声明是本仓纪律（AGENTS.md），错了会误导模型和用户。

### 2.6 `run-host.ts` 两处「本段」措辞与跨段累积实现矛盾 ☑

- `run-host.ts:117`「**本段**的事件缓冲，供 SSE 重连按 since 续拉」、`:425`「本进程缓冲（**这一段**正在发生的…）」；而 `:1172` beginSegment 文档明确「事件缓冲**不清**：跨段累积才对得上 trace 文件」且实现确实不清。事件"并集"名实问题主体已修复（`:429` 自述原二选一 bug，`:804-809` 已真并集），只剩这两处措辞。

### 2.7 UI CONFIRM 徽章漏改口径 ✅

- `apps/workagent-ui/public/app.js:216` 写「逐次确认」；权威措辞 `apps/cli/src/compose.ts:466`「CONFIRM：**每个需要审批的操作**都问（读操作不问）」，`human-channels.ts:185-196` 记录了二次评审 P1-5 正是为此禁写"每一步都问"。徽章是全仓第三处措辞、漏改回旧写法，over-claim 了读操作也问。

### 2.8 `currentRunId` 参数名接的是可能含哨兵的 holder ☑（低）

- `apps/workagent-service/src/run-host.ts:196-198` 特意声明「名字是 holder 不是 runId：也可能装 STARTING 哨兵」，但 `:237-241` 把 `() => this.foregroundHolder` 传给形参仍叫 `currentRunId` 的通道（`human-channels.ts:158/294/322`）。改名未贯穿接收侧；实际 handoff/question 只发生在真 runId 之后，无真实触发路径。

### 2.9 `UiNotice.detail` 通用字段被硬编码成 MCP 专属标题 ⚠（低）

- `apps/workagent-ui/public/app.js:252` 折叠标题写死「工具原名清单（写 mcp.json 的 tools 段时展开）」；契约 `api-types.ts:404-420` 定义 detail 为通用第二层。今天恰好只有 MCP notice 填 detail 所以显示正确，下一条带 detail 的非 MCP notice 会被错误标题折叠。

### 2.10 杂项 ☑

- `apps/cli/src/composite.ts:119` — `preFingerprint: never` 靠方法签名双变性通过编译（Port 声明是 `JsonValue`，ports/index.ts:426），类型注解是错的，应为 `JsonValue`，现写法使转发失去类型检查；
- `apps/cli/src/compose.ts:81`「**只放注册表**」与同块注释第三行「MCP 不跟着走（指库）…但 `mcp.json` 默认也落 `.workagent-state/`」（`:100-104`）自相矛盾，加粗句应改为「注册表 + mcp.json，不放库」；
- ⚠ `tools/common/src/exec/command-analysis.ts:113-116` — `WRITE_OUTLET_FLAGS` 含 `-i/-o/-w`，对 `grep` 是只读参数（`grep -i` 会被误判为写出口）。失败方向保守（多问一次），需人工确认是否有意接受。

---

## 三、死代码 / 无消费者导出

### 3.1 确认死亡（无任何真实引用）

| # | 位置 | 证据 |
|---|---|---|
| D1 ✅ | `tools/common/src/fs/read-guard.ts:148` `readGuardRules()` | 全仓唯一非定义出现是 `verify/tools.ts:582` 的一句注释；其自身文档 `:141-147` 承诺"供 verify 段打印黑名单"，而 F 段早已改为行为实测，承诺的消费方不存在 |
| D2 ✅ | `apps/cli/src/compose.ts:771-777,1135` `Composed.transcript` 字段 | 全仓消费者一律走 `composed.ports.transcript`（main.ts:907 等），顶层字段零读取；`noUnusedLocals` 不查导出所以绿灯下活着 |
| D3 ☑ | `apps/cli/src/trace/file-sink.ts:56-57` `TraceHeader.resumedFrom` | 两个入口的 header thunk（main.ts:664-678、run-host.ts:1233-1249）都不写它，app.js 不读；唯一出现是 ui.ts:2762 手造 fixture |
| D4 ✅ | `packages/harness-runtime/src/types/endpoint.ts:87-92` `EndpointLimits` + `:118-120` `limits?` 字段 | 类型与全部字段零读取点（`behaviorFingerprint` 也不含它）；姊妹字段 `errors` 经 protocol.ts:275 真实消费，`limits` 是整块休眠 |
| D5 ☑ | `apps/workagent-service/src/run-host.ts:1404` `export { REPO_ROOT }` | 死 re-export：import run-host 的两处都只取 RunHost/RunHostOptions，其余消费者直接用 compose.js 的 REPO_ROOT（连同 :51 的导入） |
| D6 ☑ | `apps/workagent-service/src/api-types.ts:235` `UiModelFrame.compacted` | 投影在算（projection.ts:550）、契约在传、UI 对 frame 不读该字段（app.js:1628 读的是原始事件行，不经 UiModelFrame）、verify:ui 不断言 |
| D7 ☑ | `apps/cli/src/verify/ui.ts:183,189` `injectionTest` 返回的 `cleaned` 恒 `false` | 5 个调用点从不读取——是"清理已验证"这条断言的半成品 |
| D8 ✅ | `apps/cli/src/verify/tools.ts:895` `parsed["blobRef"]` 死析取项 | stub 字段现名 `ref`（settle-batch.ts:1016-1024），`blobRef` 分支永假；判据整体仍靠 `ref` 分支生效（评审过程中子 agent 曾误判"整个析取恒不成立"，此处已修正为仅单臂失效） |

### 3.2 假证据行（违反本仓"打印可读证据"纪律的死判据）⚑

- ☑ `apps/cli/src/verify/tools.ts:284` 与 `apps/cli/src/verify/mcp.ts:134` — `fact("注入文件已清理", "是")`：不做检测，`unlinkSync`/`rmSync` 失败也照打「是」；
- ☑ `apps/cli/src/verify/mcp.ts:935` — 永久占位 `fact("Playwright 实测（待填）", "跑一次真实任务后回填这里")`；同段 `:933` 写死「14 个 ≈ 2520 token」，:934 已改为动态推导，:933 是留下的旧手写数。

### 3.3 多余的 `export`（函数活着，导出无人用；个人项目可降为模块私有）☑

`model/capability/profile-loader.ts:31` `parseProfile`、`verify/harness.ts:64` `concludeVerdicts`（其存在暗示"可绕开 runVerify 自己收尾"，而 runVerify:76-89 的存在理由恰是不许绕）、`credential-guard.ts:74` `maskKey`、`fs-common.ts:235` `outsideWorkspaceError`、`tools/mcp/tool-bridge.ts:49/53` `resolverRefFor`/`resolverKey`（index.ts barrel 都没列它们）、`fs/search.ts:139` `SearchMatch`、`mcp/client.ts:237` `CallResult`、`fs/read-guard.ts:86` `ReadDenial`、`verify/boundaries.ts:54` `lit`。

### 3.4 传输但零消费者的契约字段（对照本仓「未接线比不写更糟」标准）⚠

- ☑ `UiRunDetail.spec` 的 `endpointId/modelId/endpointProfileRef/timezone/toolCount/createdAt`（api-types.ts:495-508，app.js 只读其中 5 个）；
- ☑ `UiRunListItem.createdAt/updatedAt`、`UiToolActivity.toolCallId`、`UiApproval.actionId`、`UiInteraction.actionId`、`UiArtifact.artifactKind`、`UiWorkspace.path/createdAt/lastUsedAt/active`、`approvalPolicy.approvalTimeoutMs` — UI 均不读。需人工确认是否刻意留作 devtools 白盒全量。

### 3.5 `TraceHeader` 类型契约失效 ☑（机制已实验坐实）

实际 JSONL header 写入 `nodeVersion`（main.ts:666）、`gitDirty`（:665 经 `...gitProvenance()` 展开）、`entry:"web"`（run-host.ts:1248）——三者都不在 `TraceHeader`，UI 在读（app.js:2030/2077/2254 等）。typecheck 全绿是因为**带 spread 的对象字面量整体豁免 excess property check**（评审中有子 agent 用同版本 tsc 做了判别实验：去掉 spread 立即报错）。该类型已约束不到任何真实载荷，补字段或收进类型化公共构造点。

---

## 四、验收判据失效（本仓语境下的"过期代码"）

### 4.1 `isActiveBased()` 恒真 ✅（失去判别力）

- `apps/cli/src/verify/persistence.ts:532-538` — 守卫是 `!/const elapsed = now\(\) - state\.budgetUsage\.startedAt/.test(run-loop.ts)`，而该字符串在 run-loop.ts 中**已完全不存在**（实测 grep `elapsed` 零命中；实现早已改为 `activeNow()`）。F 段 `fOk` 只剩夹具算术，换一种写法重新引入墙钟差不会翻红。配套注释 `:524-531`「R-2 修完后……届时返回 true，F 段自动转绿」与 `:368-369`「主循环判的是 `now() - startedAt`（run-loop.ts:261）」都停在修复前的世界（run-loop.ts:261 现在是别的代码，行号也漂了）。

### 4.2 手抄的第二份「边界 7」grep ⚑

- ☑ `apps/cli/src/verify/shell.ts:1080-1106` 自带一份边界 7 正则和注释过滤实现，表里已有同一条（`boundaries.ts:127-132`）且 verify:tools A 段整表跑过——改表不改副本就出现"加了一条规则、只有一个脚本认识它"，恰是 boundaries.ts:11 声明要避免的形态，也与 AGENTS.md「边界检查经 verify:tools 跑」冲突。应改为 `grepBoundary(BOUNDARIES.find(b => b.id === "7"))`。

### 4.3 Trace CSS 切片锚点丢失时静默变空 ✅☑

- `apps/cli/src/verify/ui.ts:2855-2858,2874` — `uiCss.indexOf("/* ── Trace Inspector */")` 锚点若被改名，slice 长度 0，`!traceCss.includes("overflow-y")` 恒绿。当前有判别力（实测注入会红）但零护栏；同文件其它切片（:1662-1669、:2324、:2490）都在锚点丢失时 throw，这里应补齐同款断言。

### 4.4 手写 verdict 合取第二来源 ⚑（现状未漂移，形态违【定】）

- ☑ `budget.ts:204/624`、`drift.ts:54/505`、`persistence.ts:86/411`、`crash.ts:146/240+329`、`compact.ts:417` 各自维护 `results.push(...)` 再 `results.every()` 汇总，而 `verdictLog` 已逐条登记——harness.ts:42 的【定】正禁止这种第二来源。本次核对各脚本账目当前逐条同步（budget 12/11、persistence 9+2/8 对齐），属"还没漂"的漂移温床。建议 `verdict(name, ok)` 合并。

### 4.5 重复判据（一条不变量两处钉）⚠

- ☑ `shell.ts:858-869`（C6）与 `tools.ts:159-168`（B2）重复检查 run-shell HEARTBEAT 声明↔实现，注释自称「就地再钉一次」是刻意的；保留或删一处需拍板。

---

## 五、过期注释（指向已删对象 / 已翻案结论 / 计数漂移）

### 5.1 `UNKNOWN_LEGACY` 成批悬空引用 ✅（已删档位被现在时引用 ×5）

`workspace/index.ts:132`（过去时叙述，合法）、`:178`【定】「没有 UNKNOWN_LEGACY 这一档」亲述该档已删；但下列位置仍把它当**现存事物**做类比对象：

- `packages/harness-runtime/src/types/run.ts:56`、`:79` —— 「与 assertResumeWorkspaceMatches 那个 UNKNOWN_LEGACY 不同类」：比较对象已不存在，"不同类"成了空比较（这两条位于 1.2 的辩护链上，处理 1.2 时一并改）；
- `packages/harness-runtime/src/types/event.ts:187` —— 「一字同源」的同已不存在；
- `packages/harness-runtime/src/facade/index.ts:407`；
- `apps/cli/src/verify/mcp.ts:640-641` —— 这条还会**打印进终端证据**。

### 5.2 其余逐条

| # | 位置 | 问题 | 级别 |
|---|---|---|---|
| N1 | `context/compile.ts` 见 2.3 | ids.ts「唯一一份」现时失效 | ☑ 已归入 2.3 |
| N2 | `run-shell.ts:62-64` | 「MAX 必须等于 timeoutPolicy.timeoutMs」被 `:87` `STEP_TIMEOUT_MS = MAX + 30_000` 且 `:290` 用它推翻（`:73-74` 自己也改口"必须 ≥"）。✅ | ☑ |
| N3 | `run-shell.ts:134-139`、`write-file.ts:46` | 现在时描述 `ToolSnapshot.contentHash`"零消费者"，但该字段**已删除**（`types/tool.ts:316`【定】没有 contentHash）。✅ | ☑ |
| N4 | `cases/micro-cases/src/index.ts:118-121` | 文档描述 `recoveryObservation.kind` 及其枚举 TARGET_APPEND_TAIL / TARGET_CONTENT_HASH，字段已在 `types/tool.ts:299-303` 删除（只剩 `requiresPreFingerprint`），实现按 `action.toolName` 分支 | ☑ |
| N5 | `apps/cli/src/compose.ts:208-209` | 「manifest 里的 endpointProfile 还是写死的 "eval"」已被推翻：eval/suite/index.ts:23/336 现调 `parseEndpointArg`，:212/:218 记真实端点名 | ☑ |
| N6 | `apps/cli/src/compose.ts:1251` | 「Case 01 的 RedactionProfile 是阶段 3 的范围」——全仓 `RedactionProfile` 仅此一处，无 Case 01 包；阶段 3.5 已完成仍未兑现，悬空承诺 | ☑ |
| N7 | `verify/harness.ts:4` | 「三条验收项以可运行脚本交付」→ 现 16 条（AGENTS.md/package.json 均为 16）。`trace/file-sink.ts:7-8`「三条 verify 脚本都在用」同型（实 11 个文件用 CollectingTraceSink） | ☑ |
| N8 | `verify/persistence.ts` | 见 4.1，「R-2 由批 2 的 S7 修」红分支文案停在已完成的修复上；`tools.ts:31/:1000` 附近「这条红是批 1 已知欠账」同形 | ☑ |
| N9 | 计数漂移一组 | `tools.ts:10`「七条边界 grep」→ 表 14 条（boundaries.ts:57 自证）；`ui.ts:8/:388`「三条新边界」→ A 段实测 5 条；`boundaries.ts:5-9`「两个消费者」→ verify:mcp 是第三个；`tools.ts:235`「阶段 4 的第 8/9/10 条在 verify:ui」→ 11、13 也在；`tools.ts:156-157`「slow_write 全仓唯一 HEARTBEAT 生产者」→ run-shell.ts:298 也是（✅） | ☑ |
| N10 | `verify/ui.ts:1931-1933` | 「RunSpec.workspace 从阶段 1 起就在类型里、一直是 undefined」→ 现为必填且 compose.ts:1118 每次 freezeWorkspace 填入；J 段验的闸门就拿它比对 | ☑ |
| N11 | `verify/crash.ts:336-338` | 「当前没有任何工具会产出 Blob，本阶段不验窗口 C」→ settle-batch.ts:1011-1048 超阈值即外置、tools.ts H 段正是其判据，前置条件今天已成立，「不验」理由失效（是补判据还是删说法需拍板） | ⚠ |
| N12 | `verify/budget.ts:265` | 「八条轴在生产里只有五条活着」与 DEFAULT_BUDGETS 现有 7 条有值（仅 maxTotalWallClockMs 故意空）矛盾；上下文可读成历史叙述 | ⚠ |
| N13 | `types/endpoint.ts:81,86-87` | 「阶段 2 实现（D-17）。阶段 1 只留类型」的前瞻口吻未更新：`errors` 已实现，`limits` 永远没实现（见 D4） | ☑ |
| N14 | `main.ts:4`、`render.ts:4` | 「阶段 1 没有图形界面——那是阶段 4」现在时；阶段 4 已入库，且同文件 :358/:1065 已用过去时，风格分裂 | ☑ |
| N15 | `settle-batch.ts:709` | 「上面第 605 行左右」实际在 :621，绝对行号引用已漂 ~16 行；`tools/mcp/src/config.ts:89` 引「settle-outcome.ts 第 77 行」虽仍准，但违反同包 tool-bridge.ts:62 自订规矩「引接口名不引行号」 | ☑ |
| N16 | `loop/progress-guard.ts:9-11` | 「`noteProgress()` 把时刻记在 `lastProgressAt` 上，而那个字段全仓没有任何读者」用现在时描述两个本类已不存在的成员；同批 run-loop.ts:206、drift-detector.ts:31-32 都写"已删掉"，单读此文件会以为成员还在 | ⚠ |

---

## 六、冻结一次性材料

### 6.1 `考卷/`（V1/exam-support.ts，760 行）⚠

- ✅ `tsconfig.json` 的 `include` 不含 `考卷/` → **不参与 typecheck**；无任何 npm 脚本/生产代码引用它（rg 全仓仅文档把它当历史证据）。
- 它是一次性考试台架（自带 snapshot/grade、直接 `node:sqlite` 读 transcript_entries），其 DB 假设（RUN_FACTS/resumeBranchCounts/budgetUsage）今天仍未失效，所以不是"坏掉"，是"冻结"。
- 建议：整目录移出工作树归档到 `sxw_aicoding/`（它是多份评审/存量清单引用的证据链一环，删除正文前先归档）。

### 6.2 探针三连（probe:* npm scripts，不在 verify:all）☑

- `probe:reasoning-tokens` — D-3 结论已回写 profile 并被生产代码消费；**不可裸删**：`bailian-anthropic.json:66` 的 `_comment_evidence` 把出处写成 `npm run probe:reasoning-tokens`，删脚本会孤立证据链。小瑕疵：不走 runVerify，`:180` 的"需要人看一眼"分支红字退出码仍 0。
- `probe:requirement-extraction` — 使命完成、与现 API 完全对齐（ARCHIVE_TASK、replace 目标句、grader 行号引用逐一核过仍在）；注释里裸文件名 `archive-inventory.ts` 现在有 fixtures/ 与 graders/ **同名双文件**，易指错；`:239` 对未入库 `.env` 的现在时断言无法机械保鲜。
- `probe:binary-chain` — 三条结构断言对现码仍成立，但头部「没有任何通路」需收窄为「fetch_url 响应的字节无通路」（阶段 3.5 的 run_shell + allow_network 已提供 `curl -o` 旁路，与其同日落地）。

---

## 七、顺手发现的行为问题（四类之外，一并登记）

| # | 位置 | 问题 |
|---|---|---|
| B1 ✅ | `apps/cli/src/main.ts:1083-1086` | `main().catch` 只 `console.error("启动失败…") + exit(1)`，**绕过 `shutdownMcp()`**——而 `:701`【定】「正常出口必须 await mcp.close()，exit 钩子只是兜底…真正的保证在 shutdownMcp() 那一侧」。`compose()` 在 `connectMcpServers`（:691）之后可抛（缺凭证、modelId 不一致、坏预算 flag），这些路径上 MCP 子进程收殓恰好退回到注释自己否认足够的 exit 钩子。附带：catch 文案「启动失败」也覆盖 Run 中途故障（:853/:907 同落此口），复盘时会误导故障阶段 |
| B2 ⚠ | `apps/cli/src/main.ts:239-242,838-839` | `--recovery-decision/--recovery-note` 在非 resume 模式被静默吞掉（`--task`/`--trace` 在 `--list-runs` 下同），与 M-5 纪律「被静默吞掉的参数与生效的参数不可区分」相悖，无一行提示 |
| B3 ⚠ | `apps/cli/src/main.ts:266,661` | `--trace auto` 撞哨兵值：显式传 `auto` 的用户拿不到名为 auto 的文件而是静默改按 runId 命名 |
| B4 ⚠ | `apps/cli/src/render.ts:193-194` | CLI 终端 `default: break` 不投影 ToolProgress/BudgetSoftLimitReached/**ResumeExternalToolsUnverifiable**/ArtifactRegistered 等事件，与 main.ts:474「两个入口的安全语义必须一致」精神有出入——event.ts:187 说 ResumeExternalToolsUnverifiable 的存在意义就是"闸门必须说话"，CLI 上它对正在看的人恰好不说话 |

---

## 八、已排除的误报（复核过，无需再查）

- `drift-detector.ts:31-33` 「漂移历史被留存的」句：是解释**为什么故意不留** observations()/seen[]，与实现一致，非矛盾；
- `run-host.ts` 全部「历史 Run」读盘路径（:471/:481/:804/:1353/:1371）：跨段/跨进程恢复，产品功能非兼容层；`:460-470` 自述的 `?? "CREATED"` 降级确已删；
- `store-sqlite` 言行一致：确无 schema_version 列、解析失败一律抛、旧库检测即拒（db.ts:24/61/287/327）；`assertSchemaShape`（:331-383）三份手写清单互比；
- 机械线索中存活者：`InterjectQueue`、`NoProgressVerdict`、`PolicyInput/PolicyVerdict`、`EMPTY_MCP_RUNTIME`、`REQUEST_TIMEOUT_FALLBACK_MS`、cases 的 `appendLog*/slowWrite*/diffManifests/snapshotWorkspace/MicroCase*` 全族、六个 `Ui*` 类型、run-host 其余公开成员；
- 边界纪律：verify:tools 的 A 段四条 grep 零命中；12 个工具文件头部声明齐全且格式合规（内容名实问题见 2.5）；ui.ts 对前端 26 处字符串/锚点硬匹配全部命中现状；
- `compose.ts:116` / `workspace-hosts.ts:56-57` / `main.ts:1077` 三处「第二套规则已删」宣言本身属实（存储路径域）；
- `.env` 加载（compose.ts:178-180）与端点配置（:235-273）无 legacy env 名回落；persistence.ts:245-292、model-audit.ts:476 断言的是**拒绝**旧/未知数据，方向正确；
- `activeNow()`、预算取号、`waitingSince`、emit-before-persist 顺序等【定】逐条核对与代码一致。

---

## 九、建议处理顺序（仅建议，未改码）

1. **P0 三个决策题**：1.1 旧 Trace 兼容链（删 vs 改口径声明，四文件同批）；1.2 executionPrivilegeOf 缺字段分支（连 5.1 的 run.ts:56/79 一起）；2.2 workspace 启动激活（先确认真实预期，疑似行为回归）。
2. **P1 失效判据**：4.1 isActiveBased 恒真（改断言目标 + 清 R-2 文案）、4.2 边界 7 手抄副本、4.3 CSS 切片锚点护栏、3.2 两条假证据行 + mcp.ts 占位与写死数字、B1 异常出口 MCP 收殓。
3. **P2 名实与整洁**：2.1 artifact_role 纪律统一、1.3 时区回退删除、1.4 deepseek usageFieldMap、2.3 digest 归一、2.4 恒真合取、3.1 死代码表、3.3 多余 export 批、3.5 TraceHeader 补类型。
4. **P3 注释批扫**：第五章 16 处 + 3.4 字段接线清单拍板 + 2.7/2.9 UI 文案 + 第六章材料归档与探针措辞。
