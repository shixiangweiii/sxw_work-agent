# 阶段 2 代码评审（zcode）

> 评审日期：2026-08-26
> 评审对象：提交 `5de3a55bfebeb6364de1597a4a60ae0cad4c8a78`（「阶段2按照方案进行实施开发完成」，70 个文件 / 约 6841 行新增，当前 HEAD、工作树干净）
> 实施方案：`sxw_aicoding/实施方案设计/阶段2实施方案_V20260826.md`（V20260826-03，决 5 复核落地版）
> 评审依据：上述方案（四批 S1–S18 ＋「不得绕过清单」＋ §5 完成判据）＋ `架构设计/WorkAgent架构设计_V20260823_05.md`（V05）
> 评审方式：按批逐文件走读（store-sqlite / facade / run-loop / budget / settle-batch / settle-outcome / compile / profile-loader / ports / transcript / compose / main / file-sink / 全部新验收脚本）＋ 两路子代理分评（cases/adapters；crash-harness/eval）＋ 独立复验（typecheck、五条边界 grep、ADR 在库核对）
> 性质：**仅评审，未修改任何代码**

---

## 0. 总体结论

**完成度和工程质量都很高的实施，方案四批的主体内容全部有真实落点。** 具体判据：

1. **3 份 ADR 先于代码入库**（`sxw_aicoding/ADR/0001` 决2、`0002` 决6、`0003` 决3），满足「ACTION_FACT 这类 Contract 变更必须先有 ADR」的硬性要求；
2. `npm run typecheck` 干净；五条边界 grep 实质全绿（唯一瑕疵见 P3-5）；
3. `verify:persistence / verify:budget / verify:crash / verify:drift` 四条新验收脚本与 `eval:suite` 全部注册进根 `package.json`，判据保持了「可读证据」的项目风格，F 段「已知红」机制按方案落地（且已随批 2 转绿）；
4. 代码注释按仓库纪律记录理由与失败模式，多处记录了「第一版做错被实测打脸」的过程（指纹位置、重号 5、REOBSERVE 污染 outcome、A-1 结算假绿），质量高于平均水平。

发现 **2 项 P1 ＋ 12 项 P2 ＋ 约 20 项 P3**。两个 P1 分别是：

- 「不得绕过清单」明列项（§18.3 / 不变量 14：resume 时端点声明一致性校验）**完全未实现**；
- 阶段 2 退出门槛「分支分布的测量装置可用」**断在最后一环**（RUN_META 侧已备好，eval:suite 侧没接）。

另有一批「实测推翻设计、理由充分」的偏离（`sequence_counters` 落库、M-9 保留模块级状态），按项目自己的纪律（存量清单开篇：「不要让它们退回成隐性负债」）**应当回写方案而未回写**。

---

## 1. 评审范围与批次覆盖

| 层 | 文件 | 对应方案项 |
|---|---|---|
| 存储层（新增包） | `packages/store-sqlite/`（db / migrations / transcript-store / run-repository） | S1–S5、M-4、不变量 5、D-2 |
| runtime 核心 | `facade/index.ts`、`loop/run-loop.ts`、`transcript/index.ts`、`ports/index.ts` | S3、S5、S7、S9、S11、E-7、M-1、M-2 |
| 预算与 Context | `budget/index.ts`、`context/compile.ts` | S7、S8、S9、S10（R-2/R-1/R-3/决3） |
| Action 与结算 | `action/settle-batch.ts`、`verification/settle-outcome.ts` | S7（U-2）、S11、S18（决2） |
| 能力声明与漂移 | `model/capability/profile-loader.ts`、`drift-detector.ts` | S4（深冻结）、S15（U-1/U-6） |
| 形状适配器 | `protocol.ts`、`credential-guard.ts`、两份 endpoint-profiles JSON | S9④、S16、U-7、D-1 |
| Composition / CLI | `compose.ts`、`main.ts`、`render.ts`、`trace/file-sink.ts` | S6、N-1、E-3、M-5、M-6、E-5（header 半） |
| 验收脚本 | `verify/{persistence,budget,crash,drift}.ts`（新增）、`verify/{pairing,resume,compact,endpoint-profile,harness}.ts`、`workers/run-segment.ts` | 批 1–4 验收、S13 五缺口、S18 改判 |
| 工具用例 | `tools/now.ts`（新增）、`append-log / write-note / fs-common / list-dir` | S9③、S11、R-5、E-4 |
| Eval 层（新增顶层） | `eval/graders/`、`eval/suite/`、`eval/fixtures/` | S14（决4）、E-5 |
| testkit | `crash-harness/`（新增）、`fake-endpoint-profile`、`in-memory-transcript-store` | S12、D-22 自洽 |
| 文档 | 3 份 ADR（新增）、方案、roadmap、存量清单、V05、CLAUDE.md、`.nvmrc`、`.gitignore`、`package.json` | §8 回写清单、S1 |

---

## 2. 方案逐项核对摘要

### 批 1（跨进程 resume）

| 项 | 结论 |
|---|---|
| S1 Node 24 写进仓库 | ✅ `.nvmrc`=24、`engines.node: ">=24"`，运行期依赖未新增（`node:sqlite` 内置） |
| S2 四张表＋单一 runner | ✅ M001 四张表、schema_migrations 固定顺序、WAL＋busy_timeout＋外键；`schema_version` 独立成列支撑逐条降级；migration 说明记了修订 14（activeWallClockMs 口径迁移）。**偏离**：M002 新增 `sequence_counters` 表（见 P2-9） |
| S3 SqliteTranscriptStore | ✅ 接口一字未改；`append()` 提交即返回（不变量 5）；三下界取号。**偏离**：分配器高水位落库，推翻了修订 4 的字面结论（理由充分，见 P2-9） |
| S4 RunRepository＋深冻结 | ✅ `freezeRunSpec`/`deepFreeze`（structuredClone＋递归，含循环引用保护）；验收用「逐层写入抛错」正是修订 6 的加强形态；RunSpec/AgentSpecSnapshot/Run 行同事务落盘 |
| S5 四 Map → Repository | ✅ specs/status 走库，interrupts/running 留进程内并在注释说明理由；E-7 收敛到 `finish()`；M-1 `inspect()` 读真事实 |
| S6 CLI 三入口＋Trace 续写 | ✅ `--list-runs / --resume / --recovery-decision(-note)`；Trace 按 runId 命名、续写不覆盖、段号连续（G 段验证）。**缺**：interject 入口未接线（P2-4）、`resumedFrom` 字段无人写入（P3-1） |
| 批 1 验收 | ✅ A–G 七段全落地，F 段「已知红」机制正确且已随批 2 转绿 |

### 批 2（预算与时间）

| 项 | 结论 |
|---|---|
| S7 R-2 墙钟拆分＋U-2 超时 | ✅ `waitingSince` 由 Approval 事件对夹取；`activeNow()` = 继承累计＋段内运行−等待；审批超时 `Promise.race`（偏离方案的 AbortSignal 方案，注释说明接口成本）；`stepSignal` 用 `AbortSignal.any` 接线；`rl.question` 接 signal |
| S8 R-1 预算全轴 | ✅ `checkBudgets` 纯函数、HARD 优先 SOFT、软限每轴一次（U-5）；`ScriptedModelPort` 补 usage 注入（修订 17 落实）。**缺**：验收只注入 6/8 轴（P2-11） |
| S9 决3 三件事 | ✅ ① `timeFactAt: segmentStartedAt` 段级冻结（`ResumableRunFacts` 未落 `segmentStartedAt` 字段，见 P3-2）；② 系统提示词改写且守住两条【定】（强约束原样保留、不说「可能不准」）；③ `now` 工具只读幂等 mode=NONE、注释引用历史实证；④ `cache_control` 在 protocol.ts 打到 system block（tools＋system 稳定前缀）。**缺**：批 2 验收「时间事实段」被弱化为源码 grep（P2-2） |
| S10 R-3 阈值口径 | ✅ `computeIrreducible` 三口径判定表（EXACT 不加／ESTIMATED 加）、超硬限一律不发、用户输入进不可压缩集 |

### 批 3（故障注入＋Eval）

| 项 | 结论 |
|---|---|
| S11 决6 落地 | ✅ `ACTION_FACT`＋`recoveryObservation`（append_log=TARGET_APPEND_TAIL/需指纹，write_note=TARGET_CONTENT_HASH/不需）；`observePre` 在 `AttemptStarted` **之前**（注释记录第一版放错的教训）；分支判据改读 Action 级事实；`required: false` 防 REOBSERVE 污染 outcome；分支计数进 RUN_META；旋钮 `disableRecoveryObservation` 在 Runtime 侧 |
| S12 真 kill | ✅ 子进程＋SIGKILL＋父进程 resume 断言；排除 `process.exit()` 假崩溃。**隐患**：`@@KILLED@@` 标记与 kill 间有输出丢失竞态，且 `proc.signal` fallback 在 npx→tsx 拓扑下永假（P2-8） |
| S13 五缺口 | ✅ 缺口1（delay_ms＋定时 cancel 真注入）、缺口2（resume C 段补齐产物/outcome/调用集合判据）、缺口4（orphan 反向注入）、缺口5（无 override 才断言）全部落实 |
| S14 决4 | ✅ grader 与生产结算严格分离（真值取 before manifest）；冻结夹具逐字节复验（fixtureHash）；§0.2 结论边界在 suite 与 crash 双双显式声明。**缺**：分支计数与失败类型未导出（P1-2）、E-5 缺 RunSpec hash（P2-7）、grader 日志判据可穿透（P2-6） |
| 批 3 验收 | ⚠️ A/B 窗口＋指纹分流对照例在真 kill 下可重复；**cancel race 未进真 kill**（P2-1）；窗口 C 不验有决 1 理由（可接受） |

### 批 4（端点对照＋顺带）

| 项 | 结论 |
|---|---|
| S15 U-1 接线＋U-6 | ✅ DriftDetector 三规则实例化、`EndpointBehaviorDrift` 真发出、FAIL_FAST 不静默继续；D-3/本地补估矛盾在接线当场被发现并正确处理（RECORD 而非 FAIL_FAST）；U-6 断言有判别力验证（交叉拒/自配放） |
| S16 DeepSeek 对照 | ✅ 声明就位、`--live` 实跑路径就绪（真实请求判据：无配对相关 400 即自持结论成立）。实跑证据属运行时判据，见 §5 |
| S17 顺带项 | ✅ R-5（realpath 两道判定＋root 自身 realpath）、E-3（有限 auto-grant＋`--yes-all` 显式化）、M-6（两档真不同＋取舍注释）、M-5（modelId 校验一致）、M-7（值域补齐＋开发期断言）、U-7（反方向断言）、E-4（稳定排序＋cursor＋截断/取消区分）。**缺**：D-4 三语种探针（P2-5）；**偏离**：M-9 前半保留模块级状态仅写论证（P2-10） |
| S18 决2 | ✅ `unmetCause` 在事实发生时记录；语义边界＝「**全部**未达成必需项皆用户拒绝才判 USER_REJECTED」；pairing 判据同步改判且脚本抬头写明出处。**隐患**：审批超时与用户拒绝混同（P2-3） |

---

## 3. 问题清单

### P1

**P1-1　不变量 14 / §18.3：resume 时的端点声明一致性校验完全缺失。**
冻结的 `spec.endpointProfile` 落了库（`run-repository.ts` 两表拼装读回）、`facade.resume()` 也确实用冻结版做三条分支判定，但**全仓没有任何一处**把「本次 compose 出来的 profile/model」与「冻结版」比对（`spec.endpointProfile` 的消费点为零，grep 已核实）。compose 层的 M-5 校验与 U-6 断言（`compose.ts:253-269`）只管「声明 vs .env」的一致性，检测不到「今天 .env 换了端点/模型、而 RunSpec 冻结的是昨天那份」。后果正是 `profile-loader.ts:56-59` 注释自己写的场景——「拿一份能被改的对象去做这个校验没有意义」，现在是连校验本身都没有。`verify:persistence` E 段只验「能读回＋冻得住」，未验「不一致时拒绝」。这是「不得绕过清单」的明列项。

**P1-2　eval:suite 未导出三条分支命中计数，阶段 2 测量装置断在最后一环。**
S11 说「命中计数进 RUN_META，**供 suite 导出**」，S14 点名导出五项之一，§5.1 退出门槛写「分支分布的测量装置可用」。生产侧已兑现：`resumeBranchCounts` 累计进 RUN_META（`facade/index.ts:331,481`、`types/run.ts:139`）。但 `eval/suite/index.ts` 的 trial 只 `start()` 不 resume、从不读 RUN_META（全文零处引用 branch / resumeBranchCounts），report.json 里分支计数永远为空；目前它只存在于 `verify:crash` 的控制台打印（`crash.ts:240`），不落任何文件。「失败类型」聚合导出同样缺失。

### P2

| # | 问题 | 位置/佐证 |
|---|---|---|
| P2-1 | 批 3 验收的 cancel race 未在真 kill 下覆盖：crash CASES 只有窗口 A/B 五例；执行中取消注入在 pairing 走进程内 `runtime.cancel()` 优雅取消。方案要求「三个 crash 窗口 ＋ cancel race……全部在真 kill 下」（窗口 C 不验有决 1 理由，cancel race 无任何说明） | `verify/crash.ts:69-109`、`verify/pairing.ts:318-321` |
| P2-2 | 批 2 验收「时间事实段」被弱化为源码 grep：D 段自认间接判据（只数帧数），E 段直接 grep run-loop.ts 源码文本。方案要求「模拟跨天 resume 断言 renderTimeFact 输出 resume 当天，**并同时断言两种失败模式**（编造/回避）都不出现，只测前者会漏」。同类源码 grep 代理也用在 persistence F 段，重构时会静默失效 | `verify/budget.ts:232-273`、`verify/persistence.ts:447-452` |
| P2-3 | 审批超时被结算成「用户拒绝」：`withApprovalTimeout` 超时按拒绝处置（闸门语义正确），但走 `approved=false` 路径 → `causeByCall` 记 `USER_REJECTED` → 可令 outcome 判 USER_REJECTED。「无人应答」≠「用户明确拒绝」；`UnmetCause` 值域没有 TIMEOUT/NO_ANSWER，ADR 0001 未覆盖此成因辨析 | `settle-batch.ts:315-318,761-782`、`types/tool.ts:340-350` |
| P2-4 | CLI interject 入口未接线（S6/批 1 范围项、§7 处置映射明列）：facade.interject / runLoop 插话排空 / render 的 InterjectionAccepted 都在，但 main.ts 没有任何 stdin→interject 路径，grep 仅命中注释，「执行中能插话」仍不可用 | `apps/cli/src/main.ts`（全文） |
| P2-5 | D-4 三语种等长探针未做（S17 标「做」）：`probe:reasoning-tokens` 停留在阶段 1 版本（提交 77e915f，仅中文），中/英/混排探针未补 | `verify/reasoning-tokens.ts:203,224` |
| P2-6 | grader「归档日志只追加一行」判据可被穿透：只比总行数、不验原有行保留；`归档日志.txt` 又被 `computeTruth` 排除出业务文件集、check 7 不覆盖它——重写原行＋追加一行（总行数不变）可全绿。golden truth grader 的核心职责就是防这种自证 | `eval/graders/archive-inventory.ts:50-54,157-186` |
| P2-7 | E-5 缺 RunSpec hash：`run_specs` 表存了 `spec_hash`，但 suite 的 `TrialProvenance` 无该字段，且收尾把含 runs.db 的临时目录整个删除——artifact 里最终无处可查（gitDirty/diff hash/Node/npm/manifest 四项都有） | `eval/suite/index.ts:43-53,252` |
| P2-8 | crash 标记与 SIGKILL 间有输出丢失竞态（macOS 正是受影响平台）：管道 stdout 异步写、SIGKILL 不给 flush 机会；而 fallback 判据 `proc.signal === "SIGKILL"` 在 npx→tsx 拓扑下**永远为假**（被杀的是内层进程，注释自己已指出）。标记一旦丢失即报「段 1 没 kill」的假阴性。建议改 `fs.writeSync(1, …)` 同步写 | `workers/run-segment.ts:103-106`、`crash-harness/index.ts:85-96` |
| P2-9 | `sequence_counters` 落库偏离修订 4 且未回写方案：方案明文「进程内计数器不落库、RUN_META 唯一权威」，M002 却持久化分配器高水位。**理由是硬的**——真崩溃下事件号在盘上无痕迹会重号，`verify:persistence` 实测「重号 5」，migration 注释论证了「分配器状态 ≠ 事实第二权威」——但 §8 回写清单没有这条，方案文档仍写着相反结论。属「实测推翻设计」的有理由偏离，应回写（方案自身纪律：不要退回成隐性负债） | `store-sqlite/src/migrations/index.ts:94-129`、方案 §2.3/修订 4/S3 |
| P2-10 | M-9 前半未按方案做：方案决定「render.ts 模块级可变状态 **做**」，实现保留模块级 `streaming` 只写论证注释（进程单 stdout、收尾纪律已覆盖、复用前必须实例化）。论证成立，但这是对既定决定的变更，未走决策记录 | `apps/cli/src/render.ts:18-35`、方案 S17 |
| P2-11 | budget A 段只覆盖 6/8 条轴：activeWallClockMs 只有 C 段间接覆盖、consecutiveFailures 无独立撞墙注入（其 Terminal 形态不同，需单独断言） | `verify/budget.ts:134-149`、`budget/index.ts:94-103` |
| P2-12 | 三处自相矛盾/失真：① `list_dir` 的 `contentHash: "list_dir@1.1.0"` 与 `version: "1.2.0"` 脱节（升版本未同步，快照身份失真）；② bailian profile 残留旧注释「字段级 evidenceRef 还没做」与同文件已存在的 `fieldEvidence` 直接矛盾；③ bailian `observedAt` 为 **2025**-08-23（错一年），该值参与 `endpointProfileVersion` 与漂移判定 | `list-dir.ts:24,194`、`bailian-anthropic.json:54-66` |

### P3（择要，两路子代理评审已逐条列出，此处归并）

1. N-1 半落地：`TraceHeader.resumedFrom` 声明了但**无人写入**（`file-sink.ts:52`），方案要求 header 记 segmentIndex 与 resumedFrom；
2. `ResumableRunFacts` 未按 S9① 增加 `segmentStartedAt`（实现用循环局部变量 `const segmentStartedAt = now()`，跨段重冻的行为语义等价，但「每段第一条 RUN_META 落它」的审计落点缺失）；
3. `persistence.ts:164-173` 的「记一笔（修在批 3 S11）」提示已随 S11 落地而过时（observe 现已 `required: false`）；
4. M-3 的 `as never` 在 `pairing.ts` 仍有 5 处（方案只点名 main.ts 两处，已修为 `asId<RunId>`）;
5. 边界 grep 第 5 条按字面会被 `ports/index.ts:152` 的**注释**命中（判据是机械 grep，注释措辞需让路）；
6. now 工具：`ctx` 交叉类型把必填 `timezone` 变可选＋宿主时区兜底，形态上违反 ports 的【定】（实际调用链不可达）；
7. `MicroCaseVerifier.observePre` 不读 `recoveryObservation.kind`（一律整文件 hash），与 tool.ts Contract 描述不符，`TARGET_APPEND_TAIL` 的「尾部 hash」语义未实现；
8. DeepSeek profile 无 `fieldEvidence`（D-1 半边落实）；其 `usageFieldMap` 键名（input/output）与消费方逻辑键（inputTokens/outputTokens）不一致，靠 fallback 兜底；
9. `safeRealpath` 把 EACCES/ELOOP 一律当 ENOENT 向上回退；词法＋realpath 与实际写之间的 TOCTOU 窗口（注释已如实声明利用门槛）；
10. `list_dir` cursor NaN 无守卫（端点不校验 schema，`Math.max(0,NaN)` 仍 NaN → 空页无解释）；单条目 stat 失败导致整页失败；
11. credential-guard 的 key 形态与官方 host 的**交叉**错配不挡（sk-proj-→anthropic 官方等）；
12. cache 断点前缀约 640 token 低于 Anthropic 官方最小可缓存前缀 1024，可能静默不生效，且无 cache_read 命中证据；
13. ADR 0003 引用的 `compile.ts:189-193` 已被本次改动推移至 229-238（方案修订 13 批评过的行号漂移问题复发）；
14. eval suite 的 compose 在 try 块之外（缺 .env 时整个 suite 崩掉而不记失败 trial）；diffHash 不含 untracked（gitDirty=true 而 diffHash="clean" 的自相矛盾）；`escapeRe` 死代码；「未出现错误年份」regex 只覆盖 2010–2025 且只查清单一个文件；`beforeLines` 靠 bytes>0 猜行数；
15. crash banner 宣称「三个 crash 窗口」实际只验 A/B（尾部有诚实声明，措辞应对齐）；
16. `start()` 段起始用 `now()` 而非方案写的 `RunSpec.createdAt`（毫秒级差异，无实际影响）。

---

## 4. 值得保持的亮点

- **store-sqlite**：WAL＋busy_timeout＋外键、单一 migration runner、「只前进不回退」、`schema_version` 独立成列支撑逐条跳过（且坏行不炸整份）、`append()` 提交即返回、R-4 异常收敛在换实现时真正兑现了价值；
- **facade.resume**：RECOVERY_REQUIRED 闸门跨进程生效且「必须带显式决策」（少这道闸门就退化成停一次）；ABORT 收尾补 `LoopTerminated`（U-4 边界论证清楚）；「观察给不出结论 ≠ 确认没做」的 SKIPPED 降级处理；
- **run-loop**：`emit` 先于 `persistFacts` 的 D-2 撞号论证（含反例推演）；`checkBudgets` 纯函数化；`waitingSince` 事件对夹取；E-7 收敛到 `finish()`；漂移接线不读 profile 字段（循环纪律第 5 条守住）；
- **settle-batch**：`observePre` 在 `AttemptStarted` 之前（含第一版放错、verify:crash 打出自相矛盾结果的教训记录）；工具「超时后正常返回」的 TOOL_TIMEOUT 识别；`unmetCause` 在事实发生的那一刻记录而非事后从文案猜；
- **compile**：`timeFactAt` 段级冻结与 `now`／`deps.now` 的职责分离注释；R-3 三口径判定表；时间事实独立成 item 保住缓存前缀；
- **M-4 深冻结**：structuredClone＋递归冻结＋循环引用保护，验收用「逐层写入抛错」而非只做序列化往返；
- **`--yes` 有限 auto-grant**：三条件（workspace 内 realpath 后判定＋可逆＋非 EXECUTE）＋ `--yes-all` 让危险决定有名字；
- **验收脚本**：persistence 七段、pairing 的 R-4 四注入＋orphan 反向注入、resume C 段收紧（「到终态 ≠ 做对了」）、budget 的「假绿」自我记录（C 段第一版读错来源）。

---

## 5. 无法从代码验证的判据（提醒）

1. **完成判据第 3 条**：隔天、真实端点、跨进程 resume 到终态且产物日期为 resume 当天——运行时判据，本次评审只能确认代码路径就绪；
2. **`verify:drift --live`**：DeepSeek 对照实跑需真实凭证，代码路径与判据就绪；
3. cache_control 断点实际命中（cache_read_input_tokens）无实测证据入库。

---

## 6. 建议处理顺序（供排期参考，本次未动代码）

1. **P1-1**：resume 路径加一条「当前 compose 的 profile/model vs 冻结 RunSpec」比对断言＋一条验收判据，改动小、是清单明列项；
2. **P1-2**：suite 补读 RUN_META 的 `resumeBranchCounts`（含 fail-type 聚合），打通退出门槛的测量链；
3. **P2-3**：`UnmetCause` 补 `APPROVAL_TIMEOUT` 值并在 ADR 0001 补记成因辨析；
4. **P2-1 / P2-2**：补 cancel race 真 kill 场景、时间事实段行为判据（跨天 resume ＋ 两种失败模式断言）；
5. **P2-9 / P2-10**：偏离回写方案（`sequence_counters`、M-9），消除「方案与代码各说一套」；
6. 其余 P2/P3 按批归位。
