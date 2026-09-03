# 第2次评审报告（修复核验）

- **日期**：2026-09-03（修复提交之后）
- **评审人**：pi（GLM）
- **评审对象**：`d716a5c`（根据评审结果修复历史旧代码）+ `2c453b0`（清理目录和文件），基线为上轮评审的 `801b200`
- **性质**：仅评审，未改任何代码
- **输入**：`评审报告-pi.md`（5 项）+ `评审报告-opencode.md`（6 大类约 50 项）

---

## 一、总体结论

**上轮两份报告的全部确认问题均已修复，且多数修复质量高于报告建议的最低要求。**
未发现修复引入的新缺陷；未发现新的死代码、名实不符或过期注释。
`npm run typecheck` 与 `npm run verify:all`（16 个验收脚本）全部通过，退出码 0。

残留事项只有 3 条观察级记录（见第四节），均不构成缺陷。

---

## 二、逐项核验

### 2.1 pi 报告 5 项

| # | 问题 | 核验结果 |
|---|------|----------|
| P1 | 旧 Trace 兼容链（projection 防御 + `model-event:` fallback + api-types + app.js legacy 渲染 + verify:ui legacyTurns 判据） | ✅ 四文件同批拆除。`ContextFrameCompiled`/`ModelInvocationCompleted` 分支直取必填 `invocationId`；`appendCall` 收紧为必填参数；`UiModelCall.id` 注释改为「由 invocationId 推出」；`UiTurn.frame` 注释改为「主行展示同一轮最后一次编译帧」；`model-call-legacy` 渲染分支与 `legacyTurns` 判据全删（grep 零命中）。**报告要求区分保留的 `RuntimeErrorOccurred`/`ModelInvocationAuditFailed` 损坏数据防御原样保留**，注释（「不能被投影成 `model:undefined` 假调用」）仍在 |
| P2 | `settleWallOutcome` 的 `handoff` 死参数 + 「DETERMINISTIC handoff」过期注释 | ✅ **超预期**：不止删参数，实装了 `deterministicWallHandoff()`——按固定模板从已落盘事实（墙种类/通过验证/交付物/未完成项/停止前摘要）生成 summary。注释从「引用不存在的机制」变为准确描述实现。facade 的 ABORT 路径自定义 summary 以「停止前记录」行并入模板，R-7 语义保持 |
| P3 | run-shell `maxAttempts` 过期注释块 | ✅ 已删（全仓 `maxAttempts` 零命中） |
| P4 | run-host `export { REPO_ROOT }` 死导出 | ✅ 连同 import 一起删（文件内零命中） |
| P5 | `VersionedRef<_T>` 装饰性泛型 | ✅ 去泛型，`tool.ts` 同步去掉 `<unknown>` |

### 2.2 opencode 报告——历史兼容残留（1.1–1.6）

| # | 问题 | 核验结果 |
|---|------|----------|
| 1.1 | 旧 Trace 兼容链（含 api-types `invocationId?`/`frameId?`、app.js 文案） | ✅ 同 P1。`invocationId` 改必填；`frameId?` 保留可选（部分 trace 中调用可无 preceding compile 事件，合理）；「旧 Trace」文案清除 |
| 1.2 | `executionPrivilegeOf` 缺字段→SANDBOXED 兜底 + `UNKNOWN_LEGACY` 空比较 | ✅ **比建议更严**：缺失/null/拼错/截断一律 throw，注释论证「兜底会让这个 Run 当时有没有沙箱永久失真」。`UNKNOWN_LEGACY` 现在时引用全部清除，仅剩 workspace/index.ts:132 一处合法的过去时叙述 |
| 1.3 | now.ts 宿主时区回退 | ✅ `const tz = ctx.timezone`，与【定】归一 |
| 1.4 | deepseek `usageFieldMap` 错键名 | ✅ 改为 `inputTokens`/`outputTokens`；**并加防复发机制**：`parseProfile` 新增键集合校验（未知键 throw），键名漂移从此启动即红 |
| 1.5 | `.workagent-runs` 旧路径三处 | ✅ run-host 注释、db.ts 用户提示改 `.workagent/runs`；search.ts 死条目删除（现行 `.workagent` 由 `DENIED_SEGMENTS` 覆盖，遍历期 `isReadDeniedPath` 生效） |
| 1.6 | `--yes-all`/`--confirm` 迁移提示 | ✅ 两入口均删 |

### 2.3 opencode 报告——命名/注释/语义（2.1–2.10）

| # | 问题 | 核验结果 |
|---|------|----------|
| 2.1 | run_shell `artifact_role`「与 write_file 同一纪律」为假 | ✅ 统一为 write_file 式三态：非法值返回 note 拒绝登记；undefined→DELIVERABLE 的差异保留但补了理由注释（「声明产物路径的人要的就是交付物」）；版本升 1.1.1 并记录变更 |
| 2.2 | workspace 启动激活注释与行为相反（疑似功能回归） | ✅ **行为修复**：新增 `selectStartupWorkspace()`（registry.ts），实现「显式参数 > 注册表 active > 首次默认值」，main.ts 不再恒传默认值；workspace-hosts 注释同步改写 |
| 2.3 | `digest()`「全仓唯一」被 compile.ts 本地 sha256 破坏 | ✅ compile.ts 改用 `digest()`（:397/:505） |
| 2.4 | settle-batch 恒真合取项 | ✅ 条件只剩 `if (deps.verification.observePre)`，注释改「每个当前工具都声明 recoveryObservation」 |
| 2.5 | 场景头「看 git 状态」名不副实 | ✅ 改「检查生成文件」 |
| 2.6 | run-host「本段」措辞 | ✅ 改「本进程观察到的跨段事件缓冲」等 |
| 2.7 | UI CONFIRM 徽章 over-claim | ✅ 改「需要审批的操作逐次确认」，与 compose.ts 权威口径一致 |
| 2.8 | `currentRunId` 形参名 | ✅ human-channels 改名 `currentRunHolder` 贯穿 |
| 2.9 | `UiNotice.detail` 硬编码 MCP 标题 | ✅ 折叠标题通用化为「详情」 |
| 2.10 | 杂项三项 | ✅ `preFingerprint: JsonValue`（类型检查恢复）；「只放注册表」矛盾改「放注册表与 MCP 配置，不放 Run 数据」；`WRITE_OUTLET_FLAGS` 从裸 `-i/-o/-w` 改为按程序映射（`diff --output`），`grep -i` 误判消除 |

### 2.4 opencode 报告——死代码（D1–D8、3.2、3.3、3.5）

| # | 问题 | 核验结果 |
|---|------|----------|
| D1 | `readGuardRules()` | ✅ 整体删除 |
| D2 | `Composed.transcript` | ✅ 字段删除，消费者全走 `composed.ports.transcript` |
| D3/3.5 | `TraceHeader.resumedFrom` + 类型契约失效 | ✅ **双向修复**：死字段删除；`nodeVersion`/`gitDirty`/`entry` 补进 `TraceHeader`——类型重新约束真实载荷（spread 豁免漏洞收口） |
| D4 | `EndpointLimits` 整块休眠 | ✅ **选择接线而非删除**：compose 按 `maxContextTokens` 收紧 contextPolicy（等比缩 soft/compact）、`observedMaxSingleRequestTokens`/`quotaBeforeContextLimit` 产 notices；`behaviorFingerprint` 纳入 limits；loader 增加形状校验；bailian/testkit 同步 |
| D5/D6 | `REPO_ROOT` 死导出 / `UiModelFrame.compacted` | ✅ 均删除 |
| D7 | `injectionTest` 恒 false 的 `cleaned` | ✅ 返回值只剩 `{ hit }`，判据基于真实命中 |
| D8 | `blobRef` 死析取项 | ✅ 删除 |
| 3.2 | 假证据行 ×2 + 占位 fact + 写死「14 个≈2520」 | ✅ `canaryCleaned` 实测后打印；占位删除；数字改 `DEFAULT_TOOLS.length` 动态推导 |
| 3.3 | 多余 export 批（10 处） | ✅ 全部处理（grep 零命中） |

### 2.5 opencode 报告——判据失效（4.1–4.5）与过期注释（第五章 16 处）

| # | 问题 | 核验结果 |
|---|------|----------|
| 4.1 | `isActiveBased()` 恒真 | ✅ 守卫整段删除；F 段判据重写为「startedAt 保留 + 墙上时间差超限 + active 未超限 + terminal 完成」——主循环若退回 `now()-startedAt` 会让 resume 撞墙翻红，判别力真实 |
| 4.2 | shell.ts 手抄边界 7 副本 | ✅ 改 `BOUNDARIES.find(b => b.id === "7")` + `grepBoundary`，规则只从中央表取 |
| 4.3 | CSS 切片锚点静默变空 | ✅ `traceCssAnchorsOk` 进判据并打印锚点位置，锚点丢失即红 |
| 4.4 | verdict 手写合取第二来源（5 个脚本） | ✅ `results.push/every` 全部清除，统一走 `verdictLog` 登记表 |
| 4.5 | C6/B2 重复判据 | ✅ shell.ts 侧重复段删除，机械检查只在 tools.ts B 段 |
| N2–N16 | 过期注释 16 处（MAX/timeoutPolicy、contentHash、recoveryObservation.kind、eval 端点、harness 计数、R-2 文案、计数漂移组、RunSpec.workspace、窗口 C、八条轴、endpoint 阶段口吻、main/render 头、行号引用、lastProgressAt） | ✅ 逐条核对全部修复。其中 N11（窗口 C）**补了真判据**：kill 于 `ToolResultExternalized#1`、120KB 种子文件触发外置、期望 `IDEMPOTENT_RETRY` 分支，verify:crash 实跑通过且分支计数含该分支 |
| 5.1 | `UNKNOWN_LEGACY` 悬空引用 ×5 | ✅ 见 1.2 |

### 2.6 opencode 报告——冻结材料（6.1/6.2）与行为问题（B1–B4）

| # | 问题 | 核验结果 |
|---|------|----------|
| 6.1 | `考卷/` 目录 | ✅ 已删除（与报告建议的「先归档」略有出入，见第四节 R3） |
| 6.2 | 探针三连 | ✅ binary-chain 措辞收窄为「fetch_url 响应字节」；reasoning-tokens「需要人看一眼」分支补 `process.exitCode = 1`；requirement-extraction 裸文件名改为目录限定路径、过期 modelId 说明刷新 |
| B1 | `main().catch` 绕过 `shutdownMcp()` | ✅ `try/finally { stdin.close(); await shutdownMcp(); }` 覆盖 compose/resume/运行中异常；catch 文案改「命令执行失败」并用 `process.exitCode`（不再强杀跳过清理）；service 侧 main.ts 同款 try 包裹 |
| B2 | `--recovery-decision` 非 resume 静默吞掉 | ✅ `assertKnownArgs` 改分模式白名单，多余参数直接 throw「拒绝静默忽略不会生效的配置」（M-5 纪律落地） |
| B3 | `--trace auto` 哨兵撞名 | ✅ trace 三态化（`undefined=no-trace / true=按 runId / string=显式路径`），「auto」成为合法文件名 |
| B4 | render.ts `default: break` 漏投影 4 类事件 | ✅ **超预期**：补齐 ToolProgress/BudgetSoftLimitReached/ResumeExternalToolsUnverifiable/ArtifactRegistered 等 case，且 switch 末尾改 `const exhaustive: never = e`——今后新增事件类型漏渲染直接编译报错 |

---

## 三、修复质量亮点（超出报告建议的部分）

1. **`deterministicWallHandoff` 实装**（P2）：把「删死参数」升级为「让注释成真」——撞墙 summary 现在真的由已落盘事实确定性生成，不再依赖模型遗言。
2. **trace header 读冻结 RunSpec**（配合 3.5）：run-host 的 header 从「当前服务档位 + 宿主时区」改为 `executionPrivilegeOf(spec.agentSpec)` + `spec.agentSpec.timezone`，顺带修掉了「resume 换档后 header 失真」的潜在缺陷；CLI 侧同构（thunk 变量在首事件前从 frozenSpec 赋值）。
3. **`usageFieldMap` 键集合校验**（1.4）：不止修数据，加了启动期机械护栏，同类错误无法复发。
4. **`limits` 进 `behaviorFingerprint`**（D4）：接线的同时把该块纳入 resume 一致性闸门。
5. **render.ts 的 `never` 穷尽检查**（B4）：把「这次补齐了」变成「以后漏不了」。
6. **run-shell 版本升 1.1.1**（2.1）：语义变化按工具快照纪律升版并写明变更。

---

## 四、二次评审新发现（观察级，均非缺陷）

- **R1｜3.4 契约字段零消费者——保留未动，缺一条声明注释**。`UiRunDetail.spec` 的 `endpointId/modelId/endpointProfileRef/timezone`、`UiToolActivity.toolCallId`、`UiApproval.actionId`、`approvalPolicy.approvalTimeoutMs` 等 UI 不读的字段按原样保留。上轮即标注「需人工确认是否刻意留作白盒全量」；本仓 UI 定位就是白盒全量投影，保留是合理决策。建议（下轮顺手）：在 `api-types.ts` 相应字段加一句「刻意全量透传，UI 暂不读」的【定】，把这个决策从「没人提」变成「有记录」。
- **R2｜`--trace` 尾参无值时静默按默认命名**。`get("trace") ?? true`：`--trace` 作为最后一个参数且无值时回落 `true`（runId 命名），用户拼错不报错。与 B2 刚建立的「拒绝静默吞掉」精神有轻微出入，影响极小（默认行为本就接近用户意图）。
- **R3｜`考卷/` 直接删除，未按报告建议先归档进 `sxw_aicoding/`**。git 历史（`901206e`）可恢复，个人项目可接受；仅作记录——它曾是多份评审引用的证据链一环。

除此之外，对修复 diff 的独立复查（新增的 `selectStartupWorkspace`、`deterministicWallHandoff`、`assertKnownArgs` 分模式表、profile-loader 校验、run-host `specCache` 改造、compose 的 contextPolicy 收紧、main.ts 的 try/finally 收殓）未发现新问题；`grep` 清扫 `maxAttempts`/`resumedFrom`/`schemaVersion`/`UNKNOWN_LEGACY`/`workagent-runs`/`model-event:` 均零残留。

---

## 五、验证证据

| 命令 | 结果 |
|------|------|
| `npm run typecheck` | ✅ 零报错 |
| `npm run verify:tools` | ✅ 16/16 |
| `npm run verify:ui` | ✅ 84/84 |
| `npm run verify:scenarios` | ✅ 5/5 |
| `npm run verify:persistence` | ✅ 8/8 |
| `npm run verify:crash` | ✅ 3/3（含新窗口 C 判据，分支计数 IDEMPOTENT_RETRY=3 / OBSERVE_FIRST=3 / RECOVERY_REQUIRED=1） |
| `npm run verify:endpoint-profile` | ✅ 8/8 |
| `npm run verify:mcp` | ✅ 28/28 |
| `npm run verify:model-audit` | ✅ 17/17 |
| `npm run verify:all` | ✅ 16 个脚本全部通过，退出码 0 |

---

## 六、结论

本轮修复对本仓最看重的三条线——**「注释与代码同真相」「判据必须能红」「不为历史留第二套规则」**——的执行是彻底的，且多处把「删掉错的」升级成「让对的机械成立」。第四节 3 条观察级记录可在下轮顺手处理，不阻塞任何事项。
