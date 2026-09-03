# 二次评审报告（pi）——针对 d716a5c + 2c453b0 修复批次

- **日期**：2026-09-03
- **评审人**：pi（Claude Sonnet 4.5）
- **评审对象**：commit `801b200`（一轮评审基线）→ `d716a5c`（按评审结果修复）→ `2c453b0`（清理目录和文件）之后的当前代码
- **性质**：仅评审，未改任何代码。核对方式为逐条回到现行源码 + 通读两批 diff + 全量机械验证。

---

## 一、总体结论

1. **一轮评审（pi 报告 5 项 + opencode 报告约 60 项）逐条核对：除「需拍板保留」类外全部兑现**，且多数修复超出了报告建议的最低处置——不是删了了事，而是把「注释声称存在但实际不存在的机制」补成了真机制（见 §二.2、§二.3）。
2. **机械验证全绿**：`npm run typecheck` 零报错；`npm run verify:all` 16 个脚本全部通过、合计判据无一红（各脚本 3～84 条，见 §四）。
3. **但 `2c453b0`「清理目录和文件」引入了一条新的一级问题**：它把一轮评审明确定位为「证据链一环」的文档成批删除或移入 `历史归档/`，而 **AGENTS.md、CLAUDE.md、两份端点声明 JSON 和约 30 处生产代码注释仍在现在时引用这些文件**。修复批次清理了代码里的悬空引用，却在同一周里自己制造了一批新的、规模更大的悬空引用（见 §三 N1）。
4. 另有 3 处**行为变化搭在了「卫生修复」的提交信息之下**（预算默认值、端点 limits 接线、executionPrivilege fail-fast），实现本身正确且有判据，但提交叙事会误导事后复盘（§三 N2）。

---

## 二、一轮问题逐项核对（全部回源码验证）

### 2.1 pi 报告（5 项 + 格式微瑕）——全部修复

| 问题 | 处置 | 核对结果 |
|---|---|---|
| P1 旧 Trace invocationId/frameId 兼容链 | 按建议整链拆除 | ✅ `projection.ts` 两处 `typeof === "string"` 防御已删，`appendCall` 的 `invocationId` 改为必填，`model-event:` fallback id 不复存在；`api-types.ts:187` 注释改为「主行展示同一轮最后一次编译帧」（不再称「兼容」）；`verify/ui.ts` 的 `legacyTurns` 判据段已删。**应保留的两处都留下了**：`RuntimeErrorOccurred`（字段本就可选）与 `ModelInvocationAuditFailed`（损坏数据防御）的 `typeof` 检查原样在位，与一轮报告的区分建议完全一致 |
| P2 `settleWallOutcome` 死参数 `handoff` | **超出建议**：不只删参数，还把注释引用的「DETERMINISTIC handoff」补成了真机制 | ✅ `deterministicWallHandoff()` 新函数把墙种、已验 Action、交付物、未完成项、停止前摘要按固定模板拼成 outcome.summary；新增 `verify:budget` 判据断言其确定性（两次相同输入逐字相同）与五类事实齐备。R-7 的 RECOVERY ABORT 文案现在作为「停止前记录」行保留在模板内，语义未丢 |
| P3 `maxAttempts` 过期注释块 | ✅ 已删，全仓 `grep maxAttempts` 零命中 |
| P4 `export { REPO_ROOT }` 死导出 | ✅ 已删（连同 import 侧） |
| P5 `VersionedRef<_T>` 装饰性泛型 | ✅ 按建议取「删泛型」方案，`types/tool.ts` 同步去掉 `<unknown>` |
| 格式微瑕（两处多余空行） | ✅ 均在 settle-batch / facade diff 中消除 |

### 2.2 opencode 报告——历史兼容残留（1.1–1.6）

| # | 处置 | 核对 |
|---|---|---|
| 1.1 旧 Trace 兼容链四文件 | ✅ `projection.ts`/`api-types.ts`/`app.js`/`verify/ui.ts` 同批拆除；UI 的 `model-call-legacy` 渲染分支与配套 CSS 已删 | 唯一残留是 `app.js:1187`「没有审计文件：**可能是旧 Run**、未采集，或…」——见 §三 N3-3 |
| 1.2 `executionPrivilegeOf` 缺字段兜底 | ✅ 按「删分支」拍板：缺字段/非法值一律抛，`run.ts:56/79` 的 UNKNOWN_LEGACY 空比较随之消失；`verify:shell` 的 `privilegeCases` 现在拿 `undefined/null/"UNKNOWN_LEGACY"` 断言**必须抛**（把删除的兼容反向钉死） | ⚠ 行为影响见 §三 N2-3 |
| 1.3 `now.ts` 宿主时区回退 | ✅ `const tz = ctx.timezone;` 直取，`??` 已删，注释与【定】归一 |
| 1.4 deepseek `usageFieldMap` 键名 | ✅ 改为 `inputTokens/outputTokens` 与 reader 一致，**并加了两道新保护**：`parseProfile` 拒未知键（兑现类型注释里「未知键必须在加载声明时拒绝」这句此前无人执行的承诺），`verify:endpoint-profile` 新增 B2 段实测接线（删掉 map 键会翻红） |
| 1.5 `.workagent-runs` 旧路径 | ✅ 三处全清：run-host 注释、db.ts 报错文案均改 `.workagent/runs/`；search.ts 黑名单死条目删除——`.workagent` 由 `read-guard.ts` 的 `DENIED_SEGMENTS` 覆盖，search 遍历时走 `isReadDeniedPath`（契约 ③），确认不是把保护删丢了 |
| 1.6 `--yes-all` 迁移提示 | ✅ 两入口均已删（README 同步改为「未知参数一律报错，不维护已删除参数的别名」） |

### 2.3 opencode 报告——名实不符（2.1–2.10）

| # | 核对 |
|---|---|
| 2.1 `artifact_role` 一宽一严 | ✅ 统一为 write_file 式三态：run-shell 对错值返回「未登记 + 说明」而不是提升为 DELIVERABLE；schema 与 description 同时讲清「不填按 DELIVERABLE」是**声明了 artifact_path 之后**的缺省，与 write_file（不传 role 就不算产物）的不对称是有意的、两侧文案成对（`run-shell.ts:249` 注明）。注释声称的「同一条纪律」现在为真 |
| 2.2 workspace 启动激活回归 | ✅ 新增 `selectStartupWorkspace()`：显式参数 > 注册表 active > 首次默认值，且在 `connectMcpServers` 之前执行（与「MCP 绑启动 workspace」的既有【定】对齐）；`WorkspaceHosts` 构造器改为对已选结果的幂等登记激活，注释「一个每次启动都跳回默认目录的界面会让切换形同虚设」与行为现在一致 |
| 2.3 `digest()` 双实现 | ✅ `compile.ts` 本地 `sha256()` 已删，contentHash/帧指纹统一走 `ids.digest()`，「全仓唯一一份」声明恢复为真 |
| 2.4 恒真合取项 | ✅ `settle-batch.ts:415` 只剩 `deps.verification.observePre`，左项删去；配套注释改为「每个当前工具都声明 recoveryObservation；有 observePre 能力时尝试拍」——描述的是事实而不是伪装过滤器 |
| 2.5 场景头「看 git 状态」 | ✅ 改为「检查生成文件」 |
| 2.6 「本段」措辞 | ✅ 两处改为「本进程观察到的跨段事件缓冲」等名实相符措辞；顺带把 `taskCache` 升级成 `specCache`（header 的 task/timezone/executionPrivilege 全部改读冻结 RunSpec 而非进程现值），这比报告要求的更大但方向正确 |
| 2.7 CONFIRM 徽章 | ✅ 「需要审批的操作逐次确认」 |
| 2.8 `currentRunId` 形参名 | ✅ 接收侧改 `currentRunHolder`，`human-channels.ts:155` 的说明同步 |
| 2.9 notice 折叠标题 | ✅ 改通用「详情」，MCP 专属文案随 `McpNotice.detail` 自身文本走 |
| 2.10 `preFingerprint: never` | ✅ 改回 `JsonValue`；compose.ts:81「只放注册表」自相矛盾句已不存在；`WRITE_OUTLET_FLAGS` 改成按程序解释的 Map（`grep -i` 不再误判）——复核过白名单内其余程序（ls/cat/head/tail/wc/stat/file/grep/du/df/pwd/echo/which/basename/dirname）在核心utils里确无文件写出口（写出口靠重定向，被 SHELL_METACHARS 拦），`date` 同时移出白名单属保守方向 |

### 2.4 opencode 报告——死代码 / 判据 / 注释（3、4、5 章）

- **3.1 死代码 D1–D8 全部处置**：`readGuardRules`（D1）、`Composed.transcript`（D2）、`TraceHeader.resumedFrom`（D3）、`export { REPO_ROOT }`（D5）、`UiModelFrame.compacted`（D6，UI 改读原始事件行）、`cleaned` 半成品（D7，`injectionTest` 返回值收窄为 `{ hit }`）、`blobRef` 死析取（D8）均已删。**D4 `EndpointLimits` 选择了「接线」而不是「删」**——见 §三 N2-2。
- **3.2 假证据行**：`fact("注入文件已清理","是")` 两处改为真实 `!existsSync(canary)` 检测并合入判据；mcp.ts 的 Playwright 占位与写死的 2520 已删。
- **3.3 多余 export**：`maskKey`/`outsideWorkspaceError`/`resolverRefFor`/`resolverKey`/`SearchMatch`/`CallResult`/`lit`/`concludeVerdicts` 全部降为模块私有；`parseProfile` 保留导出是因为它现在**有了真实消费者**（verify:endpoint-profile 的拒绝路径实测）；`ReadDenial` 留在导出面是 `checkReadAllowed` 公共签名的组成部分。
- **3.4 零消费契约字段**：`UiWorkspace` 的 `path/createdAt/lastUsedAt/active` 已从 server 载荷与类型里删除；`UiRunDetail.spec` 的 `endpointId/modelId/...` 与 `approvalTimeoutMs` 等**原样保留**——该项在报告里就是「需人工确认是否刻意留作白盒全量」，未见处置也未见新增的裁决注释，维持待拍板状态。
- **3.5 TraceHeader 契约失效**：✅ `gitDirty/nodeVersion/entry` 进入类型（`entry: "cli"|"web"|"eval"`），eval 的 header thunk 也补齐了三个字段——spread 豁免问题以「把字段收进类型」关闭。
- **4.1 `isActiveBased()` 恒真**：✅ 整条 grep 守卫删除，F 段 fOk 改断言真实行为：`startedAt === forcedStartedAt`（保留值）、`elapsed > 墙 && active ≤ 墙`、且 **terminal 必须 COMPLETED**——若主循环退回墙钟差判法，resume 会以 BUDGET_EXHAUSTED 收尾而翻红。判别力恢复，停在修复前世界的 R-2 文案（「届时自动转绿」「run-loop.ts:261」）随段落改写消失。
- **4.2 手抄边界 7**：✅ shell.ts 改为 `BOUNDARIES.find(id==="7")` + `grepBoundary`，注释【定】「规则只从中央表取，不在这里手抄第二份」。
- **4.3 CSS 切片锚点**：✅ 新增 `traceCssAnchorsOk`（起止锚点缺失或倒序即判红）并合入 n9 判据，同时打印锚点区间作为证据。
- **4.4 verdict 第二来源**：✅ 五个脚本的 `results.push(...)+results.every()` 手写合取全部删除，退出码单源化到 `verdictLog`。
- **4.5 重复 HEARTBEAT 判据**：✅ shell.ts C6 副本删除，只留 tools.ts B2 一处。
- **5.1 `UNKNOWN_LEGACY` 悬空引用**：✅ run.ts×2、event.ts、facade、mcp.ts（含打印进终端的那条）全部清除。全仓现存两处命中均合法：`workspace/index.ts:132` 是过去时叙述删除过程；`verify/shell.ts:1005` 是拿它当**必抛样本**的活夹具。
- **N2–N16 十六组过期注释**：逐项抽查全部处置——MAX/timeoutMs 措辞（N2）、contentHash 现在时（N3，字段【定】段也补了删除记录）、`recoveryObservation.kind` 枚举（N4）、"写死的 eval"（N5）、RedactionProfile 悬空承诺（N6）、「三条验收项/三条脚本」（N7，改为不带数字的表述）、「批 1 已知欠账」（N8）、计数漂移组（N9，含「唯一 HEARTBEAT 生产者」「七条边界」「两个消费者」）、workspace 字段（N10）、窗口 C 不验（N11——处置方式是**补了真判据**：crash.ts 现在有一条「窗口 C：Blob 已落库、引用消息未落盘」段）、八条轴五条活（N12，随预算默认值一并改写）、阶段 2 前瞻口吻（N13）、阶段 1 现在时（N14）、绝对行号引用（N15，改引接口/步骤名）、noteProgress 现在时（N16，改为「已删除」过去时）。

### 2.5 opencode 报告——一次性材料与行为问题（6、7 章）

- **6.1 考卷**：报告建议「移出工作树**归档**到 sxw_aicoding/」——实际是**整目录物理删除**（含 760 行台架、考卷原文、全部考试结果 log）。见 §三 N1。
- **6.2 探针三连**：`reasoning-tokens.ts` 补了「需要人看一眼」分支的 `process.exitCode = 1`（红字不再是伪装成功）；`probe-binary-chain.ts` 头部「没有任何通路」按要求收窄为「fetch_url 自己的返回链，不评价 run_shell 旁路」；三个探针挪进 `apps/cli/src/verify/` 后进入 tsconfig include，受 typecheck 保护了——这条不在报告清单里，是净改善。`bailian profile._comment_evidence` 指向的脚本路径仍是活的（`apps/cli/src/verify/reasoning-tokens.ts@2026-08-25` 在 sourceEvidenceRefs 里同步更新了路径）。
- **B1 CLI 异常出口绕过 MCP 收殓**：✅ `try` 块起点从 compose 之后提到了 `connectMcpServers` 之后，`finally { stdin.close(); await shutdownMcp() }` 覆盖 compose/resume/运行期全部抛点；`main().catch` 不再 `process.exit(1)` 而是设 `exitCode`（不再截断 finally）；文案改「命令执行失败」，不再把 Run 中途故障误标为启动失败。服务入口做了对称处置（外层 finally `await mcp.close()`，文案「服务运行失败」）。复核了 `connectMcpServers` 自身的部分失败路径，已有 `closeAll()` 收殓，无遗留窗口。
- **B2 参数被静默吞掉**：✅ 新增 `assertModeArgs()`——`--recovery-decision`/`--recovery-note` 出现在非 resume 模式、`--task`/`--trace` 出现在 `--list-runs` 下都直接抛，并附「拒绝静默忽略不会生效的配置」；还加了两条组合校验（`--trace` 与 `--no-trace` 互斥、`--recovery-note` 必须伴生 decision）。
- **B3 `--trace auto` 撞哨兵**：✅ 哨兵取消——`Args.trace` 现在是 `true | string | undefined` 三态，无值 flag 即默认（按 runId 定名），显式值一律当路径，用户传 `auto` 会得到一个真叫 `auto` 的文件。
- **B4 CLI 终端漏投影**：✅ 不止补齐了点名的事件（ToolProgress/BudgetSoftLimit/ResumeExternalToolsUnverifiable/ArtifactRegistered 等 13 个 case），还加了 `default: { const exhaustive: never = e; }` —— 新增事件类型不渲染就编译不过，这条边界从「靠自觉」升级成了机械保证。顺带 `AttemptStarted` 也开始打印。

---

## 三、二次评审新发现的问题

### N1（P1）：`2c453b0` 目录清理把「正典」和证据链拆了，而所有引用方都没跟着改

一轮评审的修复批次对**代码内**的悬空引用做了极干净的收口；但紧随其后的清理提交对 `sxw_aicoding/` 做了 386 个文件的删除（含 ADR 全文、Roadmap、存量问题清单、ProviderProtocolFacts 实测报告、阶段实施记录、考卷与考试结果），并把 12 份 ADR 与 V20260823_05 架构文档移入 `历史归档/` 子目录。引用侧一处都没同步：

1. **AGENTS.md（仓规文件，最后修改在修复批次之前）现在指向不存在的正典**：
   - `方案讨论/WorkAgent目标定位…md`、`架构设计/WorkAgent架构设计_V20260823_05.md` —— 文件已移到 `sxw_aicoding/…/历史归档/`，根路径不存在（清理前也差一层 `sxw_aicoding/` 前缀，现在连目标语义都变了：实现语义正典躺在「历史归档」里）；
   - “the Roadmap for sequencing” —— `WorkAgent阶段Roadmap_V20260823.md` 已删，`阶段roadmap/` 目录清空；
   - “see stale-issue list §0.7” —— `存量BUG/存量问题清单_V20260824.md` 已删，`存量BUG/` 目录清空。
2. **CLAUDE.md 的 18 个内部文档链接实测断链**（脚本核对存在性）：全部 12 份 ADR 链接、Roadmap、存量清单、方案讨论、架构 V5、current-only 清理方案、阶段 1–4 实施方案。**其中 ADR-0011/ADR-0012 不是历史**：生产代码里 `grep -c "ADR-0012"` 有 83 处现在时引用（两条正交档位轴、MCP 生命周期、trace header 字段的【定】全部锚在它上面），把现行裁决归进「历史归档」目录是在给下一个读者发假情报。
3. **约 30 处生产代码注释引用被删除的文档作为理由出处**（`grep "存量清单\|实施记录\|摸底考试"` 实测）：例如 `budget/index.ts:48` 两条 token 轴默认值的定档依据「2026-08-28 摸底考试题 1 单次 run 烧掉 420,784 billed input token」、`run-loop.ts` 四处、`harness.ts:143/160`「存量清单 §4 第 3 条」、`shell.ts:1101`「记进了实施记录 §十一」、`pairing.ts` 两条「存量清单 §4 第 N 条」。这些注释的体例正是本仓引以为豪的「决策附证据出处」——出处现在找不到了。一轮报告对考卷的处置建议原文是「**删除正文前先归档**（它是多份评审/存量清单引用的证据链一环）」，该建议被跳过了。
4. **机器可读声明里也有断链**：`deepseek-anthropic.json:51` 的 `sourceEvidenceRefs` 指向已删除的 `sxw_aicoding/WorkAgent调研/ProviderProtocolFacts_V20260823_R3.md`，且该文件同时被同文件 `_comment_evidence` 现在时引用（「全部字段出自…实测」）。bailian 的 refs 指向 `spikes/`（仍在）无此问题。

**处置建议**（供下一批执行，本评审未改）：要么按报告建议把被引用材料恢复归档到非「历史归档」的证据区并批量改写 AGENTS/CLAUDE/注释里的路径；要么明确宣布文档域进入「只留代码内注释」时代，把上述所有现在时引用改为「原登记于 已删文档」。二者都可以，**放着断链不管不行**——它复现的正是一轮评审在代码里消灭的那类问题：声明与实现不符。

### N2（P2）：三处行为变化搭在「去除没用的兼容逻辑」的提交叙事里

实现正确、判据也补了，但按提交信息「修复历史旧代码，去除没用的兼容逻辑，过期注释」去找 diff 的人会低估这批改动的影响面：

1. **生产默认预算首次包含两条 token 轴**（`DEFAULT_BUDGETS` 新增 `maxBilledInputTokens: 1_500_000`、`maxOutputTokens: 200_000`）。这直接回应 N12/「八条轴只有五条活着」，方向是 R-1 的正解；但「默认无限”→「默认 1.5M/200K」是真实 Run 会被拦的行为变化，且注释自己标了【验】「前缀缓存断点前移后要复测定档」。建议至少在 README 的预算一节写明新的默认档位。
2. **`EndpointLimits` 从休眠字段变成接线开关**：`compose()` 现在会用 `limits.maxContextTokens` 按比例收紧 `hardInputLimit/softInputLimit/compactTarget` 并打 notice，`parseProfile` 校验其形状。这是对 D4「删 or 接线」的合理拍板，也配了 `verify:endpoint-profile` 新判据；但它属于新功能（一轮报告明确写「Runtime 侧零消费点」时的口径是 D-17 前瞻）。**注意后续**：bailian profile 目前是否声明了 `maxContextTokens` 决定这条钳制今天是否真的有牙齿，值得在下一轮实测里确认收紧路径被真实触发过，而不是又一次「配置在、没人吃」。
3. **`executionPrivilegeOf` 从缺省兜底改为缺字段即抛**：与 current-only 纪律一致，报告也给了这条路径（「若盘上已无 ADR-0012 之前的 workspace 数据，删分支」）。但 801b200 刚做过真实测试，**用户本机 `.workagent/runs.db` 里很可能还躺着 ADR-0012 之前的 Run**——它们现在的症状是 resume 时抛「这条记录已经损坏」。这不算 bug，是该拍板事项的默认值没人确认过一句：要么确认盘上无此类数据，要么给这类 Run 的报错文案加一行「ADR-0012 之前创建的 Run 不再支持，删库重建」（现在错误信息断言“损坏”，会把「正常旧数据」误导成「数据库事故」）。

### N3（P3）：残留小项

1. `apps/workagent-service/src/workspace-hosts.ts:51`：`bootstrap` 字段文档仍写「**首次启动时**用命令行参数登记的那一个 workspace」——2.2 修复后它是「启动选定（显式参数 > 注册表 active > 默认）的那一个」，构造器里的注释已经写对了，字段级这句是修复自身留下的尾差。
2. `apps/cli/src/main.ts` 的 `get()` 取值仍是裸的 `argv[i+1]`：`--trace --approval auto` 会把 `--approval` 当成 trace 路径。B3 的修复消掉了哨兵撞车，但「值吞掉下一个 flag」对全部字符串参数都在（既有弱点，非本批回归；顺带记一笔）。
3. `apps/workagent-ui/public/app.js:1187`「没有审计文件：**可能是旧 Run**、未采集，或打开失败」——兼容链整体拆除后，「旧 Run」这一档读起来像 1.1 没删干净；实际上它描述的是「本功能（6f82bfa）上线前的 Run 没有审计文件」，是诚实事实。但三种原因里前两种对现在的用户已不可区分（都是「查无此文件」），文案可以收窄为「未采集或打开失败」+ 保留行为，不改也无害。
4. `run-host.ts` 的 `specForTrace()` 在查不到 RunSpec 时**抛错**——注释明说是「不能猜」，方向符合 current-only；但要意识到这会让一条诊断轨道（trace header 生成）的缺失把整个 Run 打断。已核对全部事件产生路径都在 `claimForeground`/`specCache`/`pendingSpec` 之后，今天不可达；登记为「刻意 fail-fast，非缺陷」。
5. 3.4 的 `UiRunDetail.spec` 零消费字段维持原状，且没有留下「刻意留作白盒全量」的裁决注释——一轮报告要求的就是拍板，现在仍是未拍板状态。

---

## 四、机械验证证据（本次评审实际执行）

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（strict + noUnused*） | ✅ 零报错 |
| `npm run verify:all`（16 脚本） | ✅ 退出码 0；16 段汇总全部「N ✓ / 0 ✗」（8+14+5+6+8+12+3+6+16+24+15+28+84+28+17+5） |
| `grep -rn "maxAttempts\|model-event:\|legacyTurns\|readGuardRules\|blobRef\|resumedFrom\|\.workagent-runs\|UNKNOWN_LEGACY\|\"RESULT\""` 全仓 | ✅ 除 §二.4 说明的两处合法命中外零残留 |
| `grep -rn "考卷\|存量问题清单\|ProviderProtocolFacts" CLAUDE.md AGENTS.md adapters/endpoint-profiles/` + 链接存在性脚本 | ❌ 18 个断链 + 2 处正典引用失效（N1 的依据） |
| `git status` | 干净（仅 `.DS_Store` 未跟踪，符合仓规不入库） |

## 五、结论与建议顺序

修复批次的**代码部分质量高于一轮报告的预期**：兼容链拆除时精确保住了损坏数据防御、两处「注释吹了但机制不存在」的地方（handoff、limits）选择了补机制而不是删声明、B4 顺手上了穷尽 switch、探针进了 typecheck 面。

需要处理的只剩一件事，但它是 P1 级：**`2c453b0` 的文档清理与代码/仓规的引用面发生了断裂**（N1），外加 N2 的三个行为变化需要各自的文档句或确认动作。建议在关闭本轮之前，先决定 N1 走「恢复归档 + 改路径」还是「正式宣布文档退役 + 清引用」，因为它破坏的正是这批修复辛苦维护的那条纪律：**声明必须与现场一致，出处必须找得回来。**
