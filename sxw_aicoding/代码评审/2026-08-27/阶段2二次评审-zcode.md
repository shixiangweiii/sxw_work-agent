# 阶段 2 二次代码评审（zcode）

> 评审日期：2026-08-27
> 评审对象：提交 `5de3a55`（「阶段2按照方案进行实施开发完成」）。**与首评（2026-08-26）同一代码快照** —— 已核实：HEAD 仍为 `5de3a55`，工作区相对首评时仅有 `sxw_aicoding/` 文档增删，`packages/ apps/ cases/ adapters/ eval/` 零改动。因此本次评审不重复首评的逐项核对，定位是三件事：
> 1. **独立复验**首评与实施记录（`sxw_aicoding/temp/阶段2实施过程与结果_20260826.md`）声明的验收事实；
> 2. **核实首评断言的准确性**（逐条抽查，含修正与升降级）；
> 3. **更深一层走查**，找首评遗漏的新问题。
>
> 评审方式：主评审人精读 runtime 核心（facade / run-loop / settle-batch / settle-outcome / budget / compile / compact / transcript / ports / drift-detector / profile-loader）与 store-sqlite 全部四文件；两路子代理分评（eval 三层＋全部验收脚本＋crash-harness；cases＋两份形状适配器＋endpoint-profiles＋testkit＋CLI），其关键断言由主评审人逐条抽查复核后才采信；复跑 typecheck、verify:all（完整输出）、五条边界 grep。
> 性质：**仅评审，未修改任何代码**。

---

## 0. 总体结论

**实施记录的核心声明独立复验全部成立，首评断言抽查全部属实；但二次走查发现了一批首评未覆盖的新问题，其中四条值得优先处理。**

1. **独立复验结果**：`npm run typecheck` 干净；`npm run verify:all` 完整重跑 `EXIT=0`，恰好 **50 ✓ / 0 ✗**（逐符号统计，与实施记录 §5.1 的数字一致）；五条边界 grep 实质全绿（`node:sqlite` 真实 import 仅 `store-sqlite/src/db.ts:15`）；三份 ADR（0001/0002/0003）在库且先于代码；规模声明属实（实测 74 个 TS 文件 / 14,631 行，文档写 14,622，差 9 行属统计口径）。
2. **首评准确性**：抽查的 2 项 P1 ＋ 8 项 P2 ＋ 若干 P3 **全部核实属实，无夸大**。唯一下修的是 P2-8 的前半（见 §2.修正 1）。
3. **新发现**：约 **10 项 P2 ＋ 约 25 项 P3**（§3）。最重的四条：
   - **N-1** 四个验收脚本把 `process.exit()` 写在 try 块内，`finally` 清理是死代码 —— 本机 `$TMPDIR` 实测已积累 **104 个** `workagent-*` 残留目录；
   - **N-2** `verify:resume` 的 C 段「产物逐字一致」**不进退出码** —— 实施记录 §4.5 最引以为豪的那条收紧判据，在 `verify:all` 的 `&&` 链语义上是只读的；
   - **N-3** `MicroCaseVerifier` 的 observePre/observePost 用裸 `catch` 把「读不了」当「不存在」，在「文件存在但不可读」场景会把已成功的追加判成 NOT_STARTED → **重复追加** —— 这恰好打击决 6 机制要防的那件事；
   - **N-4** `classifyError` 的网络错误判别式不认 Anthropic SDK 的标准消息 `"Connection error."`，一次瞬时断网被判「永不重试」直接 `MODEL_ERROR` 终止。
4. 综合两轮，当前未清偿存量为：**P1 × 2（首评，未修）＋ P2 约 20 ＋ P3 约 45**。处理顺序建议见 §6。

---

## 1. 独立复验与首评核实

### 1.1 复验命令与结果

| 判据 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 干净（两次） |
| `npm run verify:all`（完整输出落盘重跑） | ✅ `EXIT=0`，50 ✓ / 0 ✗ |
| 边界 1：`grep -rn "@anthropic-ai/sdk" packages apps cases eval` | ✅ 0 命中 |
| 边界 2：`grep -rn "dashscope" packages/harness-runtime/src` | ✅ 0 命中 |
| 边界 3：`grep -n "profile\." run-loop.ts` | ✅ 3 命中全是注释 |
| 边界 4：`grep -rn "micro-cases" packages/harness-runtime/src` | ✅ 0 命中 |
| 边界 5：`grep -rn "node:sqlite"`（滤注释） | ✅ 真实 import 仅 db.ts:15 |
| ADR 0001/0002/0003 在库、`ACCEPTED`、日期先于实施 | ✅ |
| 8 条 verify 脚本 ＋ `eval:suite` 注册进根 package.json | ✅ |

### 1.2 首评断言核实表（本次抽查过的条目）

| 首评编号 | 核实方式 | 结论 |
|---|---|---|
| P1-1（resume 端点一致性校验缺失） | 全仓 grep `profileMatches` 调用点；读 profile-loader.ts:56-59 自证 | ✅ 属实。`profileMatches` 零调用点（唯一出现是 drift.ts:254 的注释）；`profile-loader.ts` 自己的注释写着「§18.3【定】要求 resume 时校验」，即代码自认的欠账 |
| P1-2（suite 不导出分支计数） | grep `resumeBranch / RUN_META / readRunFacts` 于 eval/ | ✅ 属实。eval/ 全目录零命中；生产侧 `resumeBranchCounts` 确实落 RUN_META（facade/index.ts:331,480-481） |
| P2-3（审批超时＝用户拒绝） | 读 settle-batch.ts:761-782（超时 resolve `approved:false`）＋ :315-318（记 `USER_REJECTED`）＋ settle-outcome.ts:79-82 | ✅ 属实 |
| P2-4（interject 未接线） | grep main.ts | ✅ 属实 |
| P2-5（三语种探针未做） | grep reasoning-tokens.ts 语言标记 | ✅ 属实（0 命中） |
| P2-10（render.ts 模块级状态保留） | render.ts:35 `let streaming = false;` 仍在 | ✅ 属实 |
| P2-12（三处失真） | list-dir.ts:25 vs :194；bailian :66 旧注释 vs :54 fieldEvidence；observedAt=1755907200000=**2025**-08-23 | ✅ 三条全属实 |
| P3-1（resumedFrom 无人写入） | grep 全仓 | ✅ 属实（仅 file-sink.ts:52 声明） |
| P3-8（deepseek usageFieldMap 键名错位） | 读 client.ts:218-235 消费方 | ✅ 属实，且本次**升级为 P2**（见 N-8，机制比首评写的更死） |

**结论：首评没有需要撤销的条目，一处需要修正表述（下节），两处建议升级（N-8/N-9）。**

### 1.3 与首评的分工声明

首评 §2 的「方案逐项核对摘要」（S1–S18 逐项）本轮未重做 —— 代码零改动，重做只会复制结论。本报告 §3 起全部是**增量**。

---

## 2. 对首评的修正、升级与扩展

**修正 1（P2-8 前半，实测推翻）**：首评称「`@@KILLED@@` 标记与 SIGKILL 间有输出丢失竞态（macOS 正是受影响平台）」。本轮以同构造在 macOS 上实测 **200/200 未丢失** —— 小体量写进管道缓冲是同步落地的，竞态在当前形态下不构成现实风险。P2-8 的**后半仍然成立**：`proc.signal === "SIGKILL"` 的 fallback 在 npx→tsx 拓扑下永远为假（被杀的是内层进程），标记机制没有第二道保险。综合定级从 P2 降为 **P3**（可靠性欠账，非现实 bug）。

**升级 2（P3-8 → N-8/P2）**：首评把 deepseek `usageFieldMap` 键名错位记为 P3（「靠 fallback 兜底」）。本轮读消费方后认定应升 P2：这不是「兜底」，是**机制实质失效** —— map 的键（`input`/`output`）在唯一消费方 `readUsagePartial`（client.ts:226-229）的查找键（`inputTokens`/`outputTokens`/…）里**根本不存在**，当前正确纯粹因为值恰好等于 Anthropic 标准回退名。将来 DeepSeek 真换了字段名，改这份 map 完全不生效且无任何报错；类型 `Record<string, string>`（types/endpoint.ts:78）放行拼错。

**升级 3（P3-9/10 → N-9/P2）**：首评把 list_dir 的错误分类问题记为 P3。本轮补充触发场景后升 P2：`list-dir.ts:174-187` 把 readdir/stat 的**一切**异常统一映射为 `NOT_FOUND / AFTER_MODEL_CORRECTION` —— (a) EACCES（无读权限）被报成「目录不存在」，模型无从纠正；(b) workspace 里一个 dangling symlink 即可让**整页**列举失败；(c) readdir 与 stat 之间条目被删同样炸整页。E-4 刚给 list_dir 补了分页与截断语义，错误分类这条腿还停在阶段 1。

**扩展 4（P2-6 加重）**：首评指出 grader「只比总行数、不验原有行保留」。本轮发现更糟的一层：检查 6 的前提是 `if (logBefore && logAfter)`（archive-inventory.ts:158），**Agent 把 `归档日志.txt` 整个删掉时该检查被静默跳过**；检查 7 的 `businessPaths` 只含子目录内文件（`slash < 0 continue` 排除归档根文件）；检查 8 只看 `added` 不看 `removed`。合起来：删除任务显式要求追加的日志文件，`hardPassed` 仍为 true。golden truth grader 对「破坏性行为」存在结构性盲区。

**细化 5（P2-2 补证据）**：源码 grep 判据的脆弱性首评已指出，本轮补一个具体反例：persistence F 段 grep 的模式是 `const elapsed = now() - state.budgetUsage.startedAt`（run-loop.ts 专属写法），而**同一语义的合法代码**就存在于 `budget/index.ts:97`（`now - usage.startedAt`，totalWallClockMs 轴）。把墙钟计算从 run-loop 搬进 budget/index.ts 的重构会让 F 段在 bug 复活时保持绿。

---

## 3. 新发现问题（首评未覆盖）

### P2

**N-1　`process.exit()` 在 try 块内，`finally { rmSync }` 永不执行 —— 四个验收脚本的临时目录每次运行必泄漏。**
`persistence.ts:337-341`、`budget.ts:284-287`、`crash.ts:270-273`、`compact.ts:135`（`process.exit(1)`）与 `:289-292`。`process.exit()` 不解开 try/finally（子代理已用 node 进程实验证实；主评审人核对了 persistence/compact 两处代码形态与本机实证）。后果：persistence/budget/crash 成败两路都泄漏，**compact 连成功路径也泄漏**（收尾也走 exit）。本机 `$TMPDIR` 实测 **104 个** `workagent-*` 残留目录（含 runs.db 与 workspace 文件），每跑一次 verify:all 约增 4 个。修法机械：改设 `process.exitCode` 后自然走完 finally。

**N-2　`verify:resume` 的 C 段判据不进退出码 —— 「产物逐字一致」是只读的。**
`resume.ts:270` 定义 `cOk = bothCompleted && noUnpaired && transcriptGrew && sameArtifact && sameCallSet`，但 `:336` 的 `process.exit(bothCompleted && noUnpaired && b2Ok && abortOk && seqOk && budgetInherited ? 0 : 1)` **不含 cOk**。实施记录 §4.5 把「收紧判据后立刻抓到恢复路径没产出 note.txt」列为本次实施最有价值的发现之一，但这条判据在脚本化验收里只打印不判定 —— 恰好落在它身上的回归（恢复写坏产物、丢基线调用）退出码仍为 0，`verify:all` 的 `&&` 链检测不到。一行修复：把 `cOk` 加进 exit 表达式。

**N-3　`MicroCaseVerifier` 把「读不了」当「不存在」—— 决 6 机制在不可读文件上制造重复追加。**
`cases/micro-cases/src/index.ts:147-155`（observePre）与 `:175-180`（observePost）用裸 `catch { fingerprint = { exists: false } }`。触发链：目标文件存在但当前用户不可读（如 mode 0222）→ append 实际成功、崩溃 → pre/post 指纹都是 `{exists:false}` → observePost 判「那次写入没有发生」→ resume 分支二标 `NOT_STARTED` → 模型补写 → **重复追加一行**。分支二存在的全部意义就是把 UNKNOWN 变成已知；「读失败」被折叠成「不存在」让它在最需要判别力的场景给出错误的确信。修法：只把 `err.code === "ENOENT"` 当不存在，其余读错误返回 `undefined`（= 观察不了，降级分支三）。这与首评 P3-9（safeRealpath 的 EACCES 混淆）是同一个错误模式在 Verifier 侧的复现，但后果直接打击决 6，故单列 P2。

**N-4　`classifyError` 不认 `"Connection error."` —— 瞬时断网被判「永不重试」。**
`protocol.ts:250-260`：`status === undefined` 且消息不匹配 `/fetch|network|socket|ECONN|timeout/i` 时判 `MODEL_SDK_REJECTED / retryability: NEVER`。Anthropic SDK 网络错误的典型消息是 `"Connection error."`（APIConnectionError），**不含上述任何关键词**（"connection" 不含子串 "econn"）。于是：一次瞬时断网 → 被归类为「SDK 发请求前拒绝」→ run-loop（`run-loop.ts:502-515` 只重试 `SAME_INPUT_BACKOFF`）直接 `MODEL_ERROR` 终止。跨进程 resume 的招牌能力对着一个本应退避重试的瞬时故障收尾，方向反了。

**N-5　verify:drift D 段的 selfAccepted 可以「什么都没断言」而显示「放行（正确）」。**
`drift.ts:175-183`：`readEndpointConfig(false, "deepseek")` 缺凭证不抛；`.env` 没有 `deepseek_base_url_Anthropic` 时 `cfg.baseUrl === ""`，`if (cfg.baseUrl) assertProfileMatchesEndpoint(...)` 整段跳过，`selfAccepted` 保持 true，fact 行照印「DeepSeek 声明 ＋ 自己的 baseUrl 放行（正确）」并计入 `dOk` 与退出码。AGENTS.md 只要求「配置了 .env」，没要求配齐两家端点 —— 新机器上这条判据是静默降级的 no-op 绿灯。对照同文件 A/B 段「有判别力，不是只会亮绿灯」的自我要求，D 段这里恰好违反。

**N-6　grader 的「清单含文件 X 的字节数」实际验证的是「该数字在全文任意位置出现过」。**
`archive-inventory.ts:104-113` ＋ `:214-217`：`containsNumber(md, f.bytes)` 与 `md.includes(name)` 相互独立 —— 名字在文中某处出现、字节数在文中某处出现即过，不要求相邻。「名字列一遍、数字列一遍」的错位清单可过；某文件字节数恰等于合计数或另一文件字节数时会被顶替。作为 E-1 产品化的核心内容判据，对 scripted 管路验证恰好精确（夹具可控），对 `--live` 能力评测会漏放错误产物 —— 而 live 恰是这套 grader 的下一个用途。

**N-7（升级自首评 P3-8）**、**N-8（升级自首评 P3-9）**：见 §2 升级 2 / 升级 3。

**N-9　eval suite 的 provenance 自洽性缺口（两处，合并记一条 P2）。**
`eval/suite/index.ts:88-106 vs 288-299`：`gitDirty` 取 `status --porcelain`（含 untracked），`diffHash` 只哈希 `git diff HEAD`（不含 untracked）→「dirty=true ＋ diffHash=clean」可达，两个仅差 untracked 文件的工作树在 artifact 里不可区分 —— 这正是 provenance 想解决的「旧 commit＋未提交改动」问题的一半（首评 P3-14 只点了 diffHash 不含 untracked 的自相矛盾，未点 dirty/diffHash 口径分裂的后果）。加上 `:194` live 模式 trace header 写死 `modelId: "live"` —— 未来花钱实跑的评测 artifact 反而丢失「实际用的哪个模型」这一最关键身份。两条合起来：**退出门槛里「真实端点 pass^5 与分布」还没有能被审计的载体**。

### P3（择要；主评审人独立发现标 ★，子代理发现经复核采信）

**runtime / store**
1. ★ `facade.observe()`（facade/index.ts:644-647）catch-all 吞掉观察异常的全部细节：降级到分支三是安全行为，但 Trace 里没有一条事件说明「为什么观察失败」，与本项目「事后分得清原因」的可观测性纪律不符（对比：observePre 在 settle-batch 里有注释说明，恢复侧连 safeMessage 都不留）。
2. ★ `getRunSpec`（run-repository.ts:81-96）返回 JSON 重解析的**未冻结**对象 —— M-4 深冻结保证在落库/读回往返后丢失，resume 路径拿到的 spec 可被无意改动而不炸。读回后应再过一遍 `freezeRunSpec`。
3. ★ `nextSequence`（transcript-store.ts:55-78）用 deferred BEGIN 的「先读后写」：WAL 下另一进程并发写库时，写升级可能得到 `SQLITE_BUSY_SNAPSHOT`，**busy_timeout 救不了**（须回滚重试）。当前「一 Run 一循环 ＋ CLI 串行」下不可达，阶段 3/4 引入并行 worker 前需要改为 `BEGIN IMMEDIATE`。
4. ★ `rebuildFromEntries`（transcript/index.ts:44）对 `schemaVersion > 当前` 的条目静默跳过：若被跳过的是 tool_result 的 MESSAGE 条目，重建后会出现**幻影未配对 tool_use** → resume 对一个已完成的调用重走三分支。当前 schemaVersion 恒为 1 不可达，属前向兼容陷阱，建议在跳过处与 `findUnpairedToolUses` 之间加一道告警。
5. ★ `readActionPreFingerprints`（transcript/index.ts:127-139）按 toolCallId 后写覆盖：resume 分支一重执行会为同一 toolCallId 再拍一次指纹并覆盖原值（时点在可能的副作用之后）。当前工具集触发不到（幂等工具不声明 recoveryObservation），语义上应显式声明「首写为权威」。
6. ★ `parseProfile`（profile-loader.ts:30-47）只校验顶层键存在：`protocol: {}` 也能过，嵌套字段缺失会以 falsy 静默改变漂移/协议行为。端点声明是数据不是代码，缺 schema 校验意味着「声明写错」只能在运行时以间接方式暴露。
7. ★ 预算事件失真一处：`checkBudgets` 的 `inputTokens` 轴实读 `usage.billedInputTokens`（budget/index.ts:100，计费口径含缓存，是刻意决定），但 `BudgetHardLimitReached` 事件的 `axis` 仍报 `inputTokens`、`used` 报计费值 —— 读 Trace 的人会把「计费 token 超限」误读为「上下文 token 超限」。axis 命名宜改为 `billedInputTokens` 或在事件里注明口径。
8. ★ resume() 的并发窗口：`running.has(key)` 检查（facade/index.ts:187）与 `running.add(key)`（:209）之间隔多个 await，同进程并发两次 resume 可双双通过。CLI 串行不可达，与「一 Run 一循环」的 DB 侧闸门（不存在）一并记为阶段 3 前置。
9. ★ 审批链路成因不完整：approval decider 抛异常走 `PORT_APPROVAL_DECIDER_THREW` 结算（settle-batch.ts:291-307）但**不写 unmetCause** —— 用户拒绝有 `USER_REJECTED`、超时被混进 `USER_REJECTED`（首评 P2-3）、Port 异常则三者皆无，同一类「必需操作未完成」在事实表上三种口径。
10. ★ DriftDetector 规则 1 证据弱（drift-detector.ts:32-43）：`count ≤ 1` 即认为「开关看起来生效了」—— 模型本来就只请求一个工具时是假信号。RECORD-only 无后果，但会稀释漂移观测的信噪比。

**eval / 验收脚本**
11. `eval/suite/index.ts:269-280`：`readJsonl` 静默丢坏行（撕裂写后 token/工具计数无标记地偏小）；`runTrial` 内 mkdtemp→rmSync 之间无 try/finally，grader 抛错即泄漏整个 trial 目录（与 N-1 同模式）。
12. `eval/graders/archive-inventory.ts:148-155`：年份检查只匹配「YYYY年」形态且仅 2010–2025，ISO 日期「2025-08-27」漏检；`:162` 的 `beforeLines` 硬编码「夹具日志恰 1 行」，夹具变更即神秘红；`:131-139` 空目录判据是「目录名首现位置 120 字符窗口内匹配 /空|0个|无文件/」的启发式，窗口错位假红、「空间/空文件」假绿皆可构造。
13. `eval/graders/workspace-manifest.ts:54`：`statSync` 跟随符号链接 —— 链接目录会被走进去（workspace 外文件进哈希），断链 symlink 直接抛异常炸掉整张快照。冻结夹具触发不到，live Agent 建 symlink 即触发。
14. `eval/suite/index.ts:295-298`：`fixtureHash` 只哈希 files 不含 emptyDirs，「临时空目录」是任务真值的一部分却不在指纹里。
15. `apps/cli/src/verify/endpoint-profile.ts:48-49,215-239`：「主循环代码指纹」在同一进程内跑前跑后各哈希一次同一文件，物理上不可能变化 —— 永绿检查计入 `boundaryOk` 与退出码；e2e 三组合中 `[1]`（虚拟端点＋有推理块）只打印不断言。
16. `apps/cli/src/verify/budget.ts:184-191`：B 段标题「软限每条轴只报一次」，实际只断言了 turns 轴恰好一次，其余轴的去重无判据（与首评 P2-11 的 6/8 轴覆盖是两回事）。
17. `apps/cli/src/verify/pairing.ts:317-321`：执行中 cancel 靠 250ms/800ms 定时竞速，极端慢机上 cancel 可能落进模型调用期，场景归类翻红 —— 计时型 flake。
18. `apps/cli/src/verify/crash.ts:131`：用例目录名 `c.name.slice(0,8).replace(/\W/g,"_")`，中文全是 `\W`，目录名塌缩成下划线串。
19. `apps/cli/src/verify/resume.ts:389-397`：注释说「第 4 条消息落盘后 cancel」，实现数的是三种事件的混合计数 —— 叙事与实现漂移。
20. `eval/suite/index.ts:23-25`：eval 直接 import `apps/cli/src/...`（compose、file-sink、verify/harness）—— 五条边界 grep 覆盖不到 eval → apps 的方向，apps 内部重构会连带打断 eval；另 `-n` 缺参时 `argv[indexOf+1]` 取到 `argv[0]`。

**cases / adapters / CLI**
21. `client.ts:176-180`（及 protocol.ts:334-341 同款、后者暂零调用方）：`hasExplicitBlockCloseEvent=false` 的端点上，块闭合判据是「存在更大 index 的块」→ **最后一个流块永远判不闭合**，末尾 tool_use 被静默丢弃。当前三份 profile 均为 true，潜伏缺陷；正确规则应是 `!interrupted` 时末块视为闭合。
22. `deepseek-anthropic.json:47` 的 `observedAt`（2026-08-17）早于其唯一证据文件 p9 的时间戳（2026-08-23）—— 与 bailian 的 2025 年错误（首评 P2-12③）同类的证据纪律问题，对照端点的「出生日期」先于其证据存在。
23. `now.ts:82`：`ctx.timezone ?? 宿主时区` 的回退与同文件【定】「不读宿主时区」矛盾（首评 P3-6 的补充）；非法时区串会让 `Intl.DateTimeFormat` 抛 RangeError → 只读时钟工具被记 `TOOL_THREW / sideEffectState=UNKNOWN` 并产生 RecoveryItem —— 一个零副作用的工具背上「副作用未知」。
24. `profile-loader.ts:144`：`host.includes(expectedBaseUrlHost)` 是子串匹配，`dashscope.aliyuncs.com.evil.com` 可通过 U-6 断言；与 credential-guard 的精确后缀规则不一致。
25. `credential-guard.ts:42`：`looksLikeOfficialKey` 只认 `sk-ant-`/`sk-proj-`，不带 proj 的存量 OpenAI 官方 `sk-` key 发往第三方代理会漏过 U-7 方向拦截（首评 P3-11 的交叉方向的补充场景）。
26. `compose.ts:428-441`（SimpleRedaction）：STANDARD 档 email 正则作用于**所有**工具输出 —— `list_dir` 里名为 `user@example.com.txt` 的条目会被打成 `[REDACTED:email]`，模型随后拿损坏路径去调工具 → NOT_FOUND 循环。
27. `main.ts:54-85`：值形 flag 吞掉下一个 token（`--task --yes` → task="--yes"）；`--resume` 不带值时静默降级为 start 新开 Run 而非报错。
28. `main.ts:402`：无论终态一律 `process.exit(0)` —— RECOVERY_REQUIRED / MODEL_ERROR / FAILED 也返回 0，外层脚本无法用退出码判成败（与 N-1/N-2 对照：退出码语义在三处各自为政）；`main.ts:219` listRuns 的 promise fire-and-forget。
29. `compose.ts:277`：与 `resolveDbPath`（:73-76）重复实现默认库路径，不对显式相对 dbPath 做 resolve。
30. `verify/harness.ts:102-105`：ScriptedModelPort 的 invoke 完全忽略 `_signal` —— 真实 Port 会因 abort 返回半截内容＋`interrupted:true`，fake 永远完整返回，「模型调用中取消」在脚本化环境测不到真实形态（fake 保真度偏差，与首评 P2-1 的 cancel-race-真-kill 缺口同源）。
31. `write-note.ts:119-139` / `append-log.ts:136`：abort 只在延迟循环/写前检查，最后一次检查到 `writeFile` 之间到达的取消仍会完成写入并报 APPLIED —— 协作取消是尽力而为，未见文档化（按 `sideEffectState: APPLIED` 如实上报，危害有限）。
32. `cases/micro-cases/src/index.ts:147,204-209`：observePre 无大小上限 readFile 整文件（大文件内存峰值＋每次写操作 O(size) 哈希）；observePost 对「覆盖写成与原内容相同」判「没有发生」（对覆盖语义无害，与非幂等声明有轻微张力）。

---

## 4. 两轮累计核实「没有问题」的关键点（第三轮不必重复怀疑）

以下为本轮主评审人独立走查或子代理实证后确认成立的设计，与首评 §4 亮点互补，重点列**首评未覆盖**的：

- **三分支判定与决 6 的咬合**：`canObserve` 判据（facade/index.ts:359-362）＝ 工具声明 ＋ `observePost` 存在性 ＋（requiresPreFingerprint 时）指纹在场，旋钮确实在测量装置侧；RECOVERY_REQUIRED 闸门「必须带显式决策」跨进程生效，ABORT 收尾补 `LoopTerminated` 且 emit 先于 persistFacts（D-2 顺序在 facade 侧的复制是自觉的）。
- **配对不变量的双兜底**：`finalize()`（结算层）＋ `recordUnmetRequired()`（事实层）覆盖全部 continue/break 出口；`settle` 对重复结算直接抛而非静默覆盖。
- **compact 的协议单元**：并查集按 toolCallId 聚合＋经 assistant 消息的传递闭包（A、B 两 call 经同一条 assistant 牵连必须同丢）正确；「只剥推理块不写 boundary」与「真丢消息才写 boundary＋重放 kept」的区分有据。
- **时间事实段级冻结**：`segmentStartedAt` 与 `now` 的职责分离（compile.ts:55-71）在 resume 场景下行为正确；时间事实独立成 item 保住 system 前缀缓存。
- **`sequence_counters` 三下界**（高水位／transcript MAX／atLeast）取号在「库被外部改过」「resume 带旧高水位」两个方向都收敛；persistence B 段「并集零重号＋连续」是**有效且强**的判据。
- **深冻结**：structuredClone＋递归＋循环引用保护；「逐层写入抛错」验收形态正确（但见 P3-2：读回侧未再冻结）。
- **usage 口径**：partial 读法不把缺失字段抹零、billedInput 按 INPUT_PLUS_CACHE 重算、thinking signature 经 signature_delta 累积且 compact 后原样回放（VERBATIM_REQUIRED 链路不断）。
- **grader 与 Runtime 的独立性**：GraderContext 结构上拿不到 RunOutcome；before 快照在 materialize 之后、start 之前拍摄；truth 只从 before 计算。无循环自证。
- **pass^k ＝ (c === k)**：与「同一任务 k 次全过」定义一致；k 不可能为 0，无除零；`passPowK` 进退出码。
- **`@@KILLED@@` 写竞态**：macOS 实测 200/200 未丢失（见 §2 修正 1）。
- **fs-common 双道边界**：词法前缀＋root/target 双 realpath 对 `/tmp→/private/tmp` 与「新目录里的新文件」都正确；E-3 autoGrant 与工具执行共用同一判定，无「授权判内、执行判外」裂缝。
- **file-sink / render**：JSONL 追加写、按 header 行数计段号、坏行容错；render 的模块级 `streaming` 在所有非 delta 事件、审批提问、收尾处均正确复位（首评 P2-10 的问题仅在「对既定决定的变更未记录」，不在行为）。

---

## 5. 无法从代码验证的判据（提醒，与首评 §5 合并有效）

1. 隔天、真实端点、跨进程 resume 到终态且产物日期为 resume 当天（运行时判据）；
2. `verify:drift --live` 与 `eval:suite --live` 的真实端点实跑（花钱）—— **注意 N-9：live 跑之前应先修 modelId 写死与 provenance 口径，否则实跑证据先天残缺**；
3. cache_control 断点实际命中（cache_read_input_tokens）无实测入库；
4. 新增：`@@KILLED@@` 竞态仅在 macOS 实测过，Linux 管道语义未验证（crash-harness 若上 CI 需补）。

---

## 6. 建议处理顺序（供排期参考，本次未动代码）

1. **P1-1**（首评）：resume 前比对「当前 compose 的 profile/model」vs 冻结 RunSpec。本轮补充的触发场景让优先级更实：换 `.env` 再 `--resume` 时 U-6/M-5 两道现有断言**都拦不住**（它们只校验新环境自身一致）。`--resume` 缺值静默新开 Run（P3-27）可顺手一起修。
2. **N-3**（verifier ENOENT 判定）：一行级修复，保的是决 6 机制的判别力本体；建议在 `verify:crash` 补一条「不可读文件」注入判据防回归。
3. **N-2**（cOk 进退出码）：一行修复，让 §4.5 那条判据在 `verify:all` 语义里生效。
4. **N-1**（process.exit → process.exitCode）：机械修复四个脚本 ＋ 顺手清一次 `$TMPDIR`；eval 的 trial 目录（P3-11）同模式一起修。
5. **P1-2**（首评）＋ **N-9**：suite 读 RUN_META 导出 `resumeBranchCounts` 与失败类型聚合；同时修 live 模式 modelId 与 dirty/diffHash 口径 —— 这两条是「花钱实跑」的前置，不修则实跑证据不可审计。
6. **N-4**（classifyError 补 "Connection error." ＋ 建议改为「已知 SDK 侧不可重试清单」的白名单式判定，而非关键词黑名单的反逻辑）。
7. **P2-3**（首评，审批超时 `APPROVAL_TIMEOUT`）＋ P3-9（成因口径三选一统一）。
8. **N-5 / N-6 / 扩展 4**（grader 与 drift D 段的判据强度）：在 `--live` 之前修，理由同 5。
9. **N-7 / N-8**（usageFieldMap 键名、list_dir 错误分类）：一个让声明机制真正生效，一个是 E-4 的收尾。
10. 首评 P2-9 / P2-10（`sequence_counters`、M-9 偏离回写方案）仍开放 —— 「实测推翻设计」的偏离不回写，方案与代码就各说一套。

---

## 7. 方法论备注

- 本轮对子代理的全部 P2 级断言做了独立抽查（读代码/本机实证）后才采信：104 个临时目录、resume.ts:270/336、drift.ts:175-183、archive-inventory.ts:158、protocol.ts:250-260、micro-cases verifier 的裸 catch —— 六处全部复核属实。
- 首评 P2-8 前半被 200 次实测推翻、两处 P3 被机制分析升级为 P2 —— 二次评审的价值不仅在加新问题，也在给首评的存量做「利息重算」。建议项目把「评审结论标注核实方式（读码/实测/推断）」沉淀为惯例：推断类条目的半衰期明显更短。
