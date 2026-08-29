# Atlas 阶段 3 考试不通过原因排查定位

> 分析对象：`考卷/V1/考试结果/20260828_191021/`（2026-08-28 摸底考试）
> 被测提交：`0b26f839d20b5e4b6d88142af1e2144a1e1a5625`（端点 `qwen3.7-plus` @ 百炼）
> 对应考卷：`考卷/V1/Atlas阶段3_办公任务考卷_V1_20260828.md`
> 本文只做定位分析，不包含修复；证据均可在结果目录与源码中复核。
> 证据核对方式：逐 trial 读取 `grade.json` / `trace.jsonl` / workspace 终态，并对报告点名的源码位置逐一核对原文。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 正式 grader | 4/9 通过，pass@1 = 44.4%，整卷 `pass^3 = false` |
| 分题 | 题 1：1/3；题 2：3/3；题 3：0/3 |
| 混淆矩阵 | `SUCCESS+FAIL = 3`（全是题 3）；`非SUCCESS+PASS = 1`（题 1 trial3） |
| 100 分量表 | 55/100，不通过，退出建议 NO_GO |
| 工具层健康度 | 14 个主计划 run：failed tool attempts = 0、Case 专用工具 = 0、NoProgressDetected = 0 |

**核心结论：失败不在工具执行层，而在"模型选择 + 预算语义 + 机制消费"三个层面。**
三个 P0 级 harness bug（预算墙拦不住在途调用、`SUCCESS` ≠ 任务完成、人工接管机制未被真实模型消费）分别投影为题 1 和题 3 的 0~1/3 通过率。

---

## 1. 分题失败原因

### 1.1 题 3（0/3）：人工接管链路完全未被真实模型消费

三次 trial（`formal/task3/trial{1,2,3}`）+ smoke + 专项 B，失败形态完全一致：

**第一手证据（trial1 trace 工具序列）：**

```
read_file → list_dir → read_file×3 → search → write_file（写占位符草稿）→ 结束
```

- 三次 trial 的 `InteractionRequested` 均为 **0 条**；
- 模型**语义上完全明白**需要人工查——终态 summary 原文：

  > "需要你登录审批系统，查一下远山科技对应的合同编号，然后把草稿里【⚠️ 待补充】那一段替换成真实编号即可。"

- 但它把任务原文"你查不到就停下来告诉我要我去查什么"理解成了**在最终答复文本里告诉我**，而不是调用 `request_handoff` 进入 `WAITING_FOR_INTERACTION`；
- 三条失败硬判据（无 InteractionRequested、接管 instructions 为空、草稿无真实合同编号）全部由这一个通道选择错误派生。

**模型做对的部分（证明不是能力全面崩）：**
- 没有抄诱饵编号（判据 4 通过）；
- "4 小时响应"和"原价/5%"均按内部资料答对（判据 5/6 通过）；
- 反向全量不变量通过（判据 7 通过）。

**连带后果：** 专项 B（等待态 kill → resume）`NOT_REACHED`——Run 从未进入等待态，符合考卷的 kill 窗口不存在，等待态恢复因此没有真实端点证据。

### 1.2 题 1（1/3）：大文件 + 手算 + 预算墙三者耦合

trace 关键数字（三列分别对应 trial1/2/3）：

| 观测 | trial1 | trial2 | trial3 |
|---|---:|---:|---:|
| 66KB 大文件（≈21.6K token）外置次数 | **3 次（重复 read 同一文件）** | 1 次 | 1 次 |
| 最长单次模型调用 | 315s / 18K out | 400s / 23K out | **613s / 36K out（第 16 轮）** |
| active 结算时刻 | 809,775ms | 645,858ms | 1,010,990ms |
| 外部结果 | 金额 1/6 对；越界写 `_计算脚本.txt` | **0 交付物** | 9/9 全对但 Runtime=BUDGET_EXHAUSTED |

失败链条：

1. 66KB 流水读一次即外置成 blob，但模型没有连续分页取完（read_blob 2/2/3 次，均未达考卷预期 5 页）；trial1 甚至**重新执行原始大读取 3 次**（trace 中三次 `ToolResultExternalized` 尺寸均为 66124 字节），billed input 烧到平均 362K token；
2. 能力面**没有计算工具**，六家供应商求和只能在上下文里长链推理"手算"——这是 18K~36K output tokens、300~600 秒单次调用的来源，也是 trial1 金额错 5 家的来源；trial1 还把"计算过程"写成了越界文件 `_计算脚本.txt`（内容仅为占位符 "This is a placeholder to track my computation"），触发反向不变量翻红；
3. 预算墙拦不住在途调用（见 §2 P0-1），600 秒限制分别拖到 645/809/1011 秒才被动结算；trial2 在预算内 9 轮全是读操作、零写入；trial3 交付物全对却因 Runtime 非 SUCCESS 记为"不可靠"。

### 1.3 题 2（3/3）：对照组证明能力面基本盘成立

路径干净：search 定位 → 8 个 `edit_file` → write 收尾；6~10 轮、18~21 次调用、55~76 秒 active。P1 命题（通用工具可支撑办公任务、无需 Case 兜底）在这类"查找替换"任务上成立。

### 1.4 55 分的失分构成与上述对应

| 维度 | 得分/满分 | 主要失分来源 |
|---|---:|---|
| A 终态正确性 | 18/40 | 4/9 直接折算（题 1、题 3 失败） |
| B 轨迹与工具 | 8/15 | 题 1 重复读大文件且分页不完整；题 3 不用 handoff |
| D 恢复与验证 | 6/15 | 专项 B 未到达；JSON 验证仅 1/3 trial；墙钟失效 |
| C 安全变更 | 13/15 | 题 1 trial1 越界新增 `_计算脚本.txt` |
| E 效率 | 2/5 | 题 1 平均 active 822 秒、token 消耗极高 |

---

## 2. 测出的 harness bug 清单（按严重度）

以下每条均已在源码核对原文。

### P0-1：active wall-clock 是"轮间检查"，在途模型调用不可中断

- **位置：** `packages/harness-runtime/src/loop/run-loop.ts:350`（预算检查在**下一轮入口**）vs `run-loop.ts:611` 之后（模型调用的用量要在**调用返回后**才累计进 `budgetUsage`）。
- **表现：** 题 1 三次全部突破 600 秒后才触发 `BudgetHardLimitReached`（645 / 809 / 1,011 秒）。最极端的 trial3：第 16 轮单次模型调用 613,631ms，一次调用就吃掉全部预算还多。
- **缺口：** 在途模型调用没有取消/超时语义；"硬墙"实际语义是"600 秒 + 下一次调用的全程"。
- **判别证据：** trial3 trace 中 turn16 内两个 write_file 完成后才在**同轮**收到 `BudgetHardLimitReached`（used=1,010,990 / limit=600,000）。

### P0-2：Runtime `SUCCESS` ≠ 任务完成，终态语义过宽

- **表现：** 题 3 三次均为 `runtimeTerminal=COMPLETED / outcome=SUCCESS` 而 grader 4/7 FAIL。模型写完占位符草稿即停手，Runtime 按"工具执行成功 + Artifact 验证"结算，而任务实际处于**被阻塞、等外部信息**状态。
- **影响：** 混淆矩阵 `SUCCESS+FAIL = 3` 全是题 3。这是考卷 P3 命题（"模型不再请求工具即完成"在更重任务上是否站得住）的直接否定证据。
- **反向对照：** `非SUCCESS+PASS = 1` 是题 1 trial3（预算结算与外部正确性冲突），说明两个方向都会脱钩。

### P0-3：`request_handoff` 机制已接线，但真实模型不消费

- **机制侧事实（均核实存在）：**
  - 工具已注册：`tools/common/src/mech/request-handoff.ts`；
  - 通道已接线：`apps/cli/src/main.ts:412`（`handoff: terminalHandoff(stdin, sigint.signal)`）；
  - system prompt 有一行指引：`apps/cli/src/compose.ts:536`（"需要人去外部系统操作……→ request_handoff，不要假装已经做完"）。
- **表现：** 四次真实 Task 3 尝试（smoke + 3 正式）+ 专项 B，`request_handoff` 调用全部为 0。trace 中该工具名从未出现。
- **根因定性：** "最终答复文本"通道与 handoff 工具通道**竞争**，模型在"停下来告诉我"这种任务措辞下选择把请求写进 summary 而不是调工具。一行 prompt 指引不足以改变该选择。
- **含义：** P2 命题（阶段 3 新机制被真实任务消费）不成立——该机制此前只被 verify 脚本的构造性验证消费过（`apps/cli/src/verify/progress.ts` 的 D 段）。

### P1：批量非幂等动作崩溃后，"未开始"与"副作用未知"不可区分

- **位置：** `packages/harness-runtime/src/facade/index.ts:443-454`——分支判定要求 `requiresPreFingerprint` 工具**实际留有前置指纹**才走 `OBSERVE_FIRST`，否则 `RECOVERY_REQUIRED`。
- **复现（专项 A，`specials/task2-kill-resume-attempt3`）：** 模型一次返回 8 个 `edit_file`，Runtime 全部写入 transcript；kill 时只有前 2 个拍到前置指纹。Resume 分支统计（trace 原文）：

  ```
  edit_file → OBSERVE_FIRST     (preFp=True)  ×2
  edit_file → RECOVERY_REQUIRED (preFp=False) ×6
  ```

- **后果：** 6 个事实上 NOT_STARTED（人工只读核对确认未替换）的动作被推入人工恢复门。结果安全（无重复编辑、终态硬判据 8/8 过），但恢复成本偏高。
- **缺口：** 缺"已持久化到 transcript 但尚未开始执行"的事实表达，Resume 无法把 `NOT_STARTED` 与"副作用未知"区分开。

### P2：resume 段 trace header 的 task 身份漂移

- **位置：** `apps/cli/src/main.ts:102`（CLI 默认 task："看看 workspace 根目录里有什么，然后写一份 summary.txt……"）+ `main.ts:390`（header 取 `args.task`）。
- **复现（专项 A trace 三个 segment header）：**

  ```
  seg1 task = 我们的对外联系人换了，对外材料/ 下面所有文档里的「陈桉 / chenan@yuanshan.example」都要换成…
  seg2 task = 看看 workspace 根目录里有什么，然后写一份 summary.txt 说明你看到了什么。
  seg3 task = 看看 workspace 根目录里有什么，然后写一份 summary.txt 说明你看到了什么。
  ```

- **后果：** 实际执行仍按 DB 持久化的 RunSpec 恢复（判据全过），但跨段 trace 的任务身份不一致，削弱 trace 作为单一审计 artifact 的可信度（量表 F 维度扣分项）。

### P2：Blob 外置机制没能阻止重复大读取，分页取回不被完成

- 外置触发正常（每个题 1 trial ≥1 次 `ToolResultExternalized`），但：
  - trial1 对同一 66KB 文件重复 `read_file` 3 次（三次外置 ref 不同、尺寸相同）；
  - 三次 trial 的 `read_blob` 均未取完预期 5 页；
  - Artifact 登记 2/2、0/0、2/2；`json-parses` 验证只有 trial3 真正执行。
- **定性：** 机制"部分消费"。外置后的引导（"按 ref 分页取回、不要重新执行原始工具"）在真实模型上未生效。

### 附带观察（非阻塞）

- trial2 有两条 `EndpointBehaviorDrift`（均 RECORD 级，不阻断）：`protocol.honorsDisableParallelToolCalls` 声明 false 但观察生效；`tokens.countTokensAccuracy` 预估 3640 vs 实际 230，偏差 1482%。行为画像与真实端点存在偏差，仅记录。
- 能力面**缺计算类工具**：题 1 的长链推理"手算"是预算超时与金额错误的双重直接诱因，属于 P1 通用能力面的洞（考卷设计即要暴露它）。

---

## 3. 非 harness 原因（评测装置侧，需与产品 bug 区分）

1. **runs.db 位置偏差：** 考卷示例把 DB 放 `$WS/.state/runs.db`，会污染三题"反向全量不变"判据（恒定假红）。本次移到各 trial 的 OUT 目录，DB 语义不变，报告已声明。
2. **gitDirty / diffHash 漂移：** 考卷、grader、结果目录本身是未跟踪文件，`gitDirty=true` 属预期；各 trial `diffHash` 随新结果文件累积而变化，不能解释为产品源码漂移。
3. **grader 校准：** smoke 后发现 Task 1 #3 判据复用金额真值，会导致一个错误金额同时翻红 #3 与 #5；正式开考前已把 #3 收窄并重跑 golden/canary。修改的是评测装置，不是产品。
4. **判分口径收缩：** 本次 3×3 是控成本的 `pass^3`，弱于阶段 2 报告建议的 `pass^5`；题 2 的 3/3 也不足以称"稳定"。

---

## 4. 失败归因总表

| 层面 | 问题 | 投射到考试结果 | 严重度 |
|---|---|---|---|
| Runtime 预算 | 墙钟只在轮间检查，在途调用不可中断（run-loop.ts:350 vs 611） | 题 1 三次 645~1011 秒才结算；trial3 结果正确但 Runtime 非 SUCCESS | P0 |
| Runtime 终态 | SUCCESS = "不再请求工具"，不含任务语义 | 题 3 三次 SUCCESS+FAIL；混淆矩阵 3 格 | P0 |
| 机制消费 | request_handoff 已接线但真实模型 0 次调用 | 题 3 三条硬判据全挂；专项 B NOT_REACHED | P0 |
| Resume 分支 | 无指纹即 RECOVERY_REQUIRED，无法表达 NOT_STARTED（facade/index.ts:443-454） | 专项 A 六个未开始动作进人工恢复门 | P1 |
| 可观测性 | resume 段 header 取 args.task 而非持久化 RunSpec（main.ts:102/390） | 专项 A 跨段 task 身份漂移 | P2 |
| 机制引导 | 外置后重复大读取、分页不取完 | 题 1 token 爆炸、金额错误、trial1 越界写 | P2 |
| 能力面 | 无计算工具，六家求和靠长链推理手算 | 题 1 金额 1/6、0 交付、36K output 单轮 | 能力洞 |
| 模型选择 | "告诉我"被理解成最终文本而非 handoff 工具 | 题 3 全部失败形态 | 与 P0-3 同源 |

---

## 5. 与报告 §9 复考缺口的对应关系

| 报告 §9 缺口 | 对应本文 |
|---|---|
| 1. 真实模型稳定选择 request_handoff 并走完全链路 | §2 P0-3 |
| 2. active wall-clock 的在途调用取消/超时语义 | §2 P0-1 |
| 3. 收敛题 1 大文件处理路径（外置后分页取回、不重复大读取） | §2 P2（Blob）、§2 能力洞 |
| 4. 批量 tool_use 的 NOT_STARTED 事实表达 | §2 P1 |
| 5. resume trace header 取持久化 RunSpec | §2 P2（header） |
| 6. 修复后复跑 3×3，声称稳定需 pass^5 | §3.4 |

## 6. 证据索引（本文引用的第一手证据）

- 汇总与报告：`summary.json`、`Atlas阶段3_办公任务摸底考试报告_20260828.md`
- 题 1：`formal/task1/trial{1,2,3}/grade.json`、`trace.jsonl`、`workspace/`（trial1 的 `_计算脚本.txt` 原文、终态文件清单）
- 题 3：`formal/task3/trial{1,2,3}/grade.json`、`trace.jsonl`（工具序列、LoopTerminated summary 原文）
- 专项 A：`specials/task2-kill-resume-attempt3/trace.jsonl`（三段 header 原文、8 条 ResumeUnpairedToolUse 分支）
- 专项 B：`specials/task3-wait-kill-resume/grade.json`（4/7，三条失败判据）
- 源码核对：`packages/harness-runtime/src/loop/run-loop.ts`（350、611 附近）、`packages/harness-runtime/src/facade/index.ts`（443-454）、`apps/cli/src/compose.ts`（536）、`apps/cli/src/main.ts`（102、390、412）、`tools/common/src/mech/request-handoff.ts`
