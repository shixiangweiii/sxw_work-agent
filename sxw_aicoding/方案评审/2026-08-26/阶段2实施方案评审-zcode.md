# 阶段 2 实施方案评审（zcode）

> 评审日期：2026-08-26
> 评审对象：`实施方案设计/阶段2实施方案_V20260826.md`（V20260826）
> 评审依据：上述方案 ＋ 最新源码（main @ 8ed1d8a 之后工作树）＋ `架构设计/WorkAgent架构设计_V20260823_05.md`（V05 §26.2 / §28.6）
> 评审方式：方案中所有可核验的源码断言逐条对照源码验证（含实际运行 `npm run verify:all`），非纸面核对
> 性质：**仅评审，未修改任何代码与文档**

---

## 0. 总体结论

**方案的事实底座经得起核验，结构合理，可以进入开工决策；但存在 4 个开工前应补进方案的缺口（P1），其中第一条（P1-1）直接关系决 3 的正确性，不是锦上添花。**

具体判据：

1. 方案引用的源码位置与现状判断**逐条验证均属实**（见第 2 节核验表，含行号）；
2. 四批的依赖顺序成立：批 2 防批 1 成果作废（§1.1 ② 的墙钟问题）、S15 漂移接线先于 S16 DeepSeek 对照的理由充分；
3. 36 项处置映射与源码现状对得上，决 1–7 与代码证据自洽；
4. 退出门槛的三处改写（真 kill、真实端点跨进程、测量装置化）每一条都对应阶段 1 的真实短板——B2 段确是注入、CLI 确无 resume 入口、分支分布确无测量装置。

**推荐定稿，条件是补上 P1 四条**（见第 3 节）；其余按现方案执行即可。

---

## 1. 评审范围

- 方案全文（§0 七个前置决定 ＋ §1–§9）；
- 源码侧覆盖：`packages/harness-runtime/src`（facade / run-loop / transcript / ports / budget / verification / interrupt / capability / action / context / types 全量）、`apps/cli/src`（main / compose / verify 全部脚本）、`adapters/shape-anthropic-messages/src`、`cases/micro-cases/src/tools`、`packages/testkit/src`、根 `package.json`；
- 环境侧：`.nvmrc`（不存在）、`engines`（不存在）、本机 Node v22.22.3；
- 运行时验证：实际执行 `npm run verify:all`——**25 条判定全绿**，与方案 S1 的「25 条判定」数字一致（静态 `verdict()` 调用点 19 个，运行时因循环/条件展开为 25）；
- 文档侧：V05 §26.2（确认 13 张表、无 event 表）、§28.6（Contract 冻结门槛表）。

---

## 2. 事实核验结果：关键断言全部属实

| # | 方案断言 | 核验结果 |
|---|---|---|
| 1 | `resume()` 第一行读内存 Map，取不到即抛 | 属实，`facade/index.ts:128-129`；`specs`/`status`/`runs`/`running` 四 Map 在 `:78-82` |
| 2 | 三分支判定链完全读 `spec.agentSpec.toolSnapshots` | 属实，`facade/index.ts:280-296`，判据正是 `idempotency` ＋ `verification.mode` |
| 3 | RECOVERY_REQUIRED 闸门在 `facade:154` | 属实 |
| 4 | 跨天 resume 必撞 `BUDGET_EXHAUSTED` | 属实，`run-loop.ts:261` 的 `now() - startedAt`；`DEFAULT_BUDGETS.maxActiveWallClockMs` 确为 10 分钟（`budget/index.ts:33`） |
| 5 | CLI 无 resume 入口；M-3 的 `runId as never` | 属实，`main.ts` 只有 start 路径；`as never` 在 `:139` 与 `:175` |
| 6 | E-7 双结算 ＋ `deliveredArtifactIds` 恒空 | 属实，`run-loop.ts:531` 一次、`finish()`（`:220-221`）一次；两个结算函数里都是 `[]` |
| 7 | `freezeProfile()` 只冻浅层 | 属实，`profile-loader.ts:50-59`——`errors` 完全未冻，`tokens.usageFieldMap`、`sourceEvidenceRefs` 数组仍可变 |
| 8 | TranscriptStorePort 恰五个方法 | 属实，`ports/index.ts:106-133` |
| 9 | DriftDetector / `profileMatches` / `stepSignal()` 有实现无调用 | 属实，三者均零调用点（仅 re-export；`stepSignal` 定义在 `interrupt/index.ts:83`） |
| 10 | `renderTimeFact` 每轮用 `deps.now`；cache_control 未接 | 属实，`compile.ts:201/257`；cache_control 仅存在于 `:186` 的注释里 |
| 11 | M-5 `dashscope_model` 被静默忽略 | 属实——`compose.ts:71` 读入 `cfg.modelId` 后**无任何消费点**，实际全用 `profile.modelId` |
| 12 | `verify:resume` C 段判据太松 | 属实，判据只有「双方到终态＋无未配对＋只增不改」（`resume.ts:225-230`），打印了 note.txt 内容但不纳入 verdict |
| 13 | 决 2「只接上已有的 USER_REJECTED」 | 属实——值在类型里（`run.ts:196`），但 `settle-outcome.ts` 从不产出它，是「有值域、无事实来源」的状态 |
| 14 | R-1 预算多轴声明未执行 | 属实——`run.ts:65-77` 声明了 7 个可选轴，主循环只查 turns / 墙钟 / consecutiveFailures 三项 |
| 15 | Node 现状（无 .nvmrc、无 engines、v22.22.3） | 属实 |
| 16 | ScriptedModelPort usage 写死 | 属实（`verify/harness.ts:141`，`inputTokens: 100`）——注意它住在 CLI 而非 testkit |
| 17 | 凭证守卫单向（U-7） | 属实，`credential-guard.ts:44-51` 只有「官方端点 ＋ 第三方 key」一个方向 |
| 18 | `list_dir` 截断无 cursor（E-4） | 属实，`slice(0, MAX_ENTRIES)` ＋ `truncated` 标志 |
| 19 | `fs-common.ts` 已为 R-5 备好落点 | 属实，注释明说「R-5 的修法就落在这个文件里」 |
| 20 | `write_note` 的 `delay_ms` 就绪；append_log「非幂等 ＋ NONE」 | 属实 |

一个值得单独指出的实证：`write_note` 的注释自己承认「覆盖写严格说是幂等的，标成非幂等是为了让分支二有工具可测」（`write-note.ts` idempotency 注释）。这恰好实证了决 6 的论断「测量仪器是被测对象身上的旋钮」——方案对现状的病理判断是准的。

---

## 3. 评审发现：建议补进方案再定稿（P1）

### P1-1　S9/决 3 漏了系统提示词这条配套——是正确性的一部分

`DEFAULT_SYSTEM_PROMPT` 明确指示模型：「日期与时间一律以上下文中的『[系统事实] 当前时间』为准」（`compose.ts:229`）。而且 `compile.ts:189-193` 白纸黑字记录着历史证据：「为什么不做成 now 工具——工具要模型记得调，它上次就没调，直接编了一个」。

冻结时间事实后，这条指令会把模型**锁死在一个可能过时的日期上**：跨天 resume 后，模型会自信地把昨天的日期写进归档清单——比「编造」更糟，因为这是被系统指令背书的错误。新增 `now` 工具而不改提示词，大概率重演「它上次就没调」。

**建议**：S9 加第 4 件事——改写时间指令，明确「上下文时间可能过时，涉及当前时刻先调 `now`」。

### P1-2　决 6 的前置指纹缺「捕获机制」这一环

方案说「Runtime 在执行前把所需指纹（文件行数 / 内容 hash / 目标 fingerprint）落进 transcript」，但**谁去取指纹没有指定**。给任意工具的目标算指纹是工具域知识，而依赖方向禁止 Runtime import case 包。现有的 `ResolvedEffect.targetFingerprints`（`tool.ts:28-32`）只装了 `[{ target: 路径 }]`，没有 hash（`effect-resolver.ts:49`）。

`RecoveryObservationDescriptor` 需要指明捕获路径：ToolHandlerPort 加 pre-execute 指纹钩子、复用 VerificationPort、还是 descriptor 带 fingerprint 引用。这是决 6 从「拆两个字段」到「可运行」之间缺的设计决定，应在批 3 开工前补上。风险表里「影响面比看上去大」那一条目前只说了填字段，不够。

### P1-3　runs 表存「序号高水位」与方案自身原则相抵

方案 §2.3 不建九张事实表的理由是「建了就是第二份权威」，但 S5 给 `runs` 表安排了「序号高水位」——而 `lastSequence` 的权威副本已经在 transcript 的 `RUN_META` 里（`run.ts:101-118`，resume 侧 `facade:187` 取 max 消费）。两份高水位需要写明调和规则（谁是权威、另一份只是索引），否则恰好踩了自己划的线。

### P1-4　批 1 有三个留白的实施决定，开工即会遇到

1. **SQLite 文件的默认路径约定**：`--resume <runId>` 跨进程要能找到同一个库，这是 CLI 语义的一部分，也牵涉 `.gitignore`（方案未提）；
2. **`compose.ts:115` 把 `Composed.transcript` 写死为 `InMemoryTranscriptStore` 具体类**，需改为 Port 类型＋注入点（好在这兼容现有 verify 脚本——它们都经 `ports.transcript.append` 注入崩态）；
3. **现有四个 verify 脚本的密封性**：SQLite 化后需临时库路径＋清理，S1 的「25 条判定仍全绿」才有意义。

---

## 4. P2 级小点（不阻塞，随手可修）

| # | 点 | 说明 |
|---|---|---|
| 1 | E-7 的行号引用偏差 | 方案引 `run-loop.ts:523`，实为区段注释行，`settleOutcome` 调用在 `:531`——无实质影响，回写文档时顺手改 |
| 2 | `activeWallClockMs` 口径迁移 | S7 会把它从「派生值」（`run-loop.ts:439` 每次用 `now()-startedAt` 重算）改成「累计值」。RUN_META 里已落盘的旧口径数据会被新逻辑读回，阶段 2 内部自洽没问题，但值得在 migration 说明里记一笔，避免日后考古混淆 |
| 3 | S13 缺口 5 的落点可以更准 | 现状是两层断言：`readEndpointConfig` 在 compose 时抛（`compose.ts:72-77`），`assertCredentialGoesWhereIntended` 在 client 构造时抛（`client.ts:29`）。用 `modelPortOverride` 时后者本来就跳过，延后只需处理前者——比「延到真正发请求时」更简单的选择是「无 override 才断言」 |
| 4 | `@types/node` 版本 | 现为 `^26.2.0`，比目标 Node 24 还新，S1 的「对齐」要留意 types 与运行时 API 面的差异（`node:sqlite` 类型在 26 里已有） |
| 5 | ScriptedModelPort 的归置 | 方案语境里它像 testkit 成员，实际在 `apps/cli/src/verify/harness.ts`——批 2 关掉「usage 写死」时注意改对地方 |

---

## 5. 结构与范围评审

- **四批依赖顺序成立**：批 1 是跨进程成立的硬前提（§1.1 三处阻断全部属实）；批 2 不做则批 1 成果当场作废的判断正确；批 3 把研究问题的回答与测量装置绑定；批 4 的 U-1 接线先于 DeepSeek 对照，理由（「对照跑了也读不出东西」）与 `profileMatches` 零调用点的现状吻合。
- **裁剪有据**：只建四张表、九张事实表不建、Replay/Artifact/Blob 推阶段 3——均与「没有用例检验就是盲写」的 D-14 逻辑一致，且 §26.2 确认 13 张表清单、无 event 表（方案引用准确）。
- **决 1–7 与代码证据自洽**：决 2 的「USER_REJECTED 已有值域未接线」与 `run.ts:196` ＋ `settle-outcome.ts` 完全吻合；决 5 的前提（无 .nvmrc / 无 engines / Node 22）属实。
- **边界 grep 第 5 条可执行**：当前 `node:sqlite` 在 packages/apps/cases/adapters 零命中，扩后仅 `packages/store-sqlite/` 应命中。
- **§8 回写清单完备**：Roadmap / 存量清单 / V05 §28.3 §28.6 / CLAUDE.md / ADR 均已点到，且与「决 2 那份 ADR 是阶段 1 待补 ADR 的续篇」的关联合理。

---

## 6. 结论

**推荐定稿，条件是补上 P1 四条**：

1. P1-1（系统提示词与 `now` 工具的配合）是决 3 落地正确性的组成部分，必须进 S9；
2. P1-2（前置指纹的捕获机制）是决 6 从设计到实现的缺失环节，应在批 3 开工前补设计；
3. P1-3（高水位第二权威）与 P1-4（批 1 三个实施决定）是开工前低成本可补的口径问题。

P2 五条不阻塞，随手可修。除此之外按现方案执行即可。
