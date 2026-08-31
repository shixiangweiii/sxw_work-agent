# 变量命名与历史代码兼容 —— 二次评审（zcode）：current-only 清理实施批次

- **评审日期**：2026-08-31
- **评审人**：ZCode（三次评审：通读全部 97 个文件的未提交 diff、实施方案与关联 ADR，对六条决定逐块回源，独立复刻退出门槛验证）
- **评审对象**：依据《current-only清理实施方案_V20260831》（决 1–6、批次 P0–P3）实施的未提交改动；前序输入为本目录《变量命名和历史代码兼容-评审-codex/zcode.md》两份首轮评审
- **评审目标**（应作者要求）：① 确认重构不引入隐藏 bug；② 确认代码简洁、逻辑直接；③ **不保留任何旧数据、旧代码、旧逻辑的兼容层**
- **评审方式**：只读评审 + 验收命令实证（verify 脚本仅在系统临时目录工作）；未新增或修改任何仓库文件

---

## 总评

**批次的主体质量很高，六个决定全部正确落地，兼容层删得干净、删掉的东西有判据护送。独立复刻的退出门槛全部通过（typecheck 含 unused 双开关干净、verify:all 163/163 全绿、兼容词活代码零命中）。但按"不保留任何旧逻辑"的验收标准，找到一处真实的删除不彻底（run-host.ts 残留对已删除枚举值 `"CREATED"` 的兜底，且落在 typecheck 盲区）、一处 .gitignore 缺口、一个波及 13 个文件的机械缩进错位；另有五个前批开放项（F1–F4/P4）本批未处理也不在方案范围内，需明确其去向。**

## 一、退出门槛独立复刻（全部实际运行）

| 门槛 | 方案声明 | 复刻结果 |
|---|---|---|
| 1 typecheck 含 `--noUnusedLocals --noUnusedParameters` | 干净 | ✅ 干净，双开关已进 `package.json:18` |
| 2 verify:all | 14 脚本 / 163 判据 | ✅ 163/163 全绿，exit 0（逐脚本判据数相加=163，与声明一致） |
| 3 兼容词零命中 | 只剩解释性注释 | ✅ `schema_migrations`/`schemaVersion`/`UNKNOWN_LEGACY`/`STAGE1_ACTIVE`/`MIGRATED_TOOL_NAMES`/`InMemoryTranscriptStore`/`hasUntrustedContext` 活代码零命中 |
| 4–8 | 空库启动、旧库 fail-fast、漂移可触发、riskFacts 进事件与 UI、边界 12 条 | ✅ 由 verify:persistence/artifact/drift/tools/ui/scenarios 承载，全绿 |

## 二、核心机制正确性（逐块回源，未发现行为性 bug）

### 决 1｜Schema 形状断言（`packages/store-sqlite/src/db.ts`）

实现比方案还严：`ddl` 与 `columns` 两份手写清单互为判据（空库首次启动即自校验，写错列名当场炸）；索引排在断言之后（作者实测过"缺列库先炸索引、报不出该删库"的误导形态）；错误信息直接给出 `rm` 处置并说明 JSONL 独立轨道不受影响。旧库被 `CREATE TABLE IF NOT EXISTS` 跳过后由断言拦截，缺列/多列双向报。**没有 migration、没有降级、没有兜底。**

### 决 2｜observePairingError 接线

签名从 `(httpStatus, message)` 改为收 `RuntimeErrorRecord`，判别式 `source==="MODEL_PROVIDER" && category==="PROTOCOL"` 用 Runtime 自己的词汇；HTTP status 的解耦发生在形状适配器里，主循环仍不碰端点声明（循环纪律第 5 条成立）。接线点在模型错误分支（只有失败的调用才带得出配对漂移的证据），触发后 FAIL_FAST 终止。此前这条唯一 FAIL_FAST 的规则生产路径零调用。

### 决 3｜riskFacts / dataMovement 三处一次做完

事件（`ActionProposed` 载荷）→ 投影（`projection.ts` 转述不推算）→ UI（`app.js:490-496` 真实渲染，消费点已核实存在且用新名字）。方案说得对：此前"Trace 上可审计"这条护栏是不成立的依据，而放开越界读正是靠它撑着的——事件里只有一个拼接字符串，两样事实从未离开过 Resolver 返回值。

### 决 4｜hasUntrustedContext 整链删除

参数从未被 `evaluatePolicy` 函数体解构（二次评审已确认它只是 risk signal），删除而非"补成真闸门"是诚实选择——凭空加一条没有产品决定的闸门是阶段 3.5 犯过的错。trust 作为审计事实由 `ContextFrameCompiled.trust` 承载，那条有读者。

### 存储位置统一（计划外修正 #2）

`workspaceStorage()` 是唯一出处：CLI 默认库从仓库级 `.workagent-state/` 迁到 `<workspace>/.workagent/`，服务注册表同源调用 Composition Root 那一份而不是自己拼第二份路径；bootstrap 的 `storage` 覆盖仅验收脚本可传；`.workagent-state` 保留且只放注册表，与注释一致。旧注册表 JSON 的 `version` 字段被宽容忽略——这是产品状态文件的容错解析，不是兼容层，无需处理。

### 命名四处同改

`maxBilledInputTokens` 在 RunBudgets / BudgetAxis / 事件载荷 / UI `AXIS_LABEL` 四处一致；`inspectedAt`/`segmentActive`/`terminalReason`/`usageAfter`/`foregroundHolder` 同查。**app.js 是纯 JS、typecheck 盲区**——已单独 grep，无任何旧字段名残留。

### 死面删除抽查

- `rules[] → rule`：空规则在类型上不可表达（比原先静默 `noEffect` 更严）。
- `loopPolicy.maxTurns` 影子字段：删除后全仓无读取点。
- `InterjectQueue → string[]`：facade/run-loop 同步收口，三个纯装饰字段（intent/urgency/at）描述的假调度语义一并消失。
- `settleOutcome` 双算改为只取 kind，`incompleteItems` 由 finish() 用同一份输入重算。
- `digest()` 收敛到 `types/ids.ts` 唯一一份——打转检测比的正是这几个 digest，两处口径分叉会静默失准。
- write-only 列删除后，INSERT 列清单与新 Schema 逐一对齐（agent_spec_snapshots 三列、run_specs 三列、blob_refs 两列、blobs 三列）。

### QUOTA/RATE_LIMIT 补登记（计划外修正 #1）

必要修复：protocol 的 429 分支两个类别都产生，而 run-loop 的 `QUOTA_EXHAUSTED` 分支等着它——不补的话一次真实限流会先被 `assertActiveErrorDomain` 抛成"值域越界"。

## 三、发现的问题

### R1｜删除不彻底：`run-host.ts:267` 的 `?? "CREATED"` 兜底残留（本批唯一一处，正中验收标准）

`RunStatus` 联合类型已删掉 `"CREATED"`（方案 P3a 明说"改为 getStatus 返回 undefined 时显式报错，不再兜底"，facade 侧照做了），但 service 的 run-host 还留着旧兜底。它落在 **typecheck 盲区**：`UiRunDetail.status` 是宽松的 `string`，局部联合 widen 后无人校验。实际触发概率低（spec 行与状态行同事务写入，snapshot 在则状态行在），但这正是本批要消灭的形态——**引用一个已不存在的领域值的兜底**，且一旦触发，UI 会显示一个既非运行也非终态的幽灵状态。全仓 grep 确认这是唯一命中。处置建议：去掉兜底，undefined 时按本仓纪律显式处理（读侧如实上报"状态行缺失"比编造一个值便宜）。

### R2｜`.gitignore` 缺 `.workagent/`（低）

存储统一后，runs.db 与 trace 落在**用户任选的 workspace 目录**里（Web UI 支持选仓库内目录）。`.gitignore` 有 `.workagent-workspace/-state/-runs/-eval` 四条旧路径，唯独没有新的 `.workagent/`。默认 CLI workspace 已被 `.workagent-workspace` 条目覆盖，但用户把 workspace 指到仓库内任意目录时，状态库会以未跟踪文件出现。一行修复；`.workagent-runs` 条目已无生产者（trace 改走 workspace 内目录），可顺手清理。

### R3｜`rule: {` 缩进错位波及 13 个文件（纯外观，与"简洁清晰"目标相悖）

`rules[] → rule` 的机械改写保留了旧嵌套层级的内容缩进：`rule: {` 在 4 格、内容在 5 格。fetch-url、append-log、slow-write 及全部 fs/mech/time 工具文件同型。不构成行为问题，但是一次"重构完成度"的可见欠账，建议一次性格式化收掉。

### R4｜前批开放项去向未标注（流程问题，非代码缺陷）

- **F1**：binary kind 无魔数检查——`artifact-checks` 本批未动，"curl 无 `--fail` 把 404 错误页存成 .jpg 再声明"仍畅通且 SUCCESS；
- **F2 / S5-4**：声明落空只进 `artifactNote`、不进 `artifactChecks` 结算事实，Run 仍 SUCCESS；
- **F3**：`collectDeclaredArtifact` 的 `void (async () => …)` 无整体 try/catch；
- **F4**：`logicalId` 用原始入参字符串，未归一化；
- **P4**：fetch_url 仍无浏览器式 UA（已再次确认）。

五项都不在本批方案范围内，属合理；但本批的存量清单没有为它们更新状态，P4 两轮评审后仍是失联。建议补一行"评估后不修/排期"，避免开放项无声蒸发。

## 四、亮点（值得保持的做法）

- **删除有判据护送**：fail-fast 断言做注入实测（摘掉断言当场翻红）；verify:artifact D 段把取数路径从 Resolver 返回值改成读**事件**（修掉"判据测的不是它声称在测的东西"）；边界 grep 12 条在本批还抓到了判据脚本自己 import `node:sqlite` 的违例并改走 store-sqlite 公开 API。
- **两份手写清单互为判据**（ddl/columns）：把"文档与实现分叉"这个老敌人变成第一条启动判据。
- **方案 §6 如实记录两处计划外修正**及理由（存储统一是"终端与浏览器同一套装配"这条【定】逼出来的），方案—实现—判据三者闭环。
- **"没有生产者就删、有不变量载体就接线"的取舍**（决 6）在 observePairingError（接线）与 targetFingerprints/batchDigest（连生产端删）上执行一致。

## 五、结论

批次达到了它自己立的军令状：兼容层删净（活代码里只找到 R1 一处残留）、命名与语义一致（含 typecheck 盲区的纯 JS 侧）、判据 151→163 且构成随被测对象更新、新增闸门均有注入实测。**建议合并前处理 R1（真实的旧逻辑残留，正是本次清理的目标形态）与 R2（一行 gitignore）；R3 可随手收；R4 补登记即可。** 评审全程未改动任何文件（验收命令仅在系统临时目录工作，仓库工作区与评审开始时一致）。
