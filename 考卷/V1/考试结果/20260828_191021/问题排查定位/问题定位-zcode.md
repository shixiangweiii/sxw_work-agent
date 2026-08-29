# 问题定位（ZCode 复核）

> 排查日期：2026-08-28（Asia/Shanghai）
> 排查对象：本次摸底考试不通过的原因，以及评测实际测出的 harness 缺陷
> 被测提交：`0b26f839d20b5e4b6d88142af1e2144a1e1a5625`（`main`）
> 考卷：`考卷/V1/Atlas阶段3_办公任务考卷_V1_20260828.md`
> 证据来源：`考卷/V1/考试结果/20260828_191021/`（正式 trial trace / grade.json / summary.json）
> 排查方式：只读分析。逐条核对 trace 事件、判分明细与被指源码位置，未改动任何文件。
> 说明：本文件是对官方报告（`Atlas阶段3_办公任务摸底考试报告_20260828.md`）结论的**独立复核与根因下沉**——报告给出「发生了什么」，本文给出「trace 与源码里对应的具体证据链」。

---

## 1. 总结论

不通过是真实的，不是 grader 假红；三题失败各自暴露了不同层面的 harness 缺陷，其中两个是 P0 级设计缺口。

- 正式 9 次：grader 4/9（pass@1 44.4%）。题 2 三次全过，题 1 只过 1 次，题 3 三次全挂。
- 人工逐条复核确认：失败判据全部有任务原文（sourceQuote）或反向不变量依据；smoke 批后题 1 #3 的双重惩罚已在正式考前修掉。误判因素可以排除。
- 问题集中在两处：**题 3 的机制面引导失败**（`request_handoff` 从未被真实调用）和 **题 1 的预算面失守**（三次全部 `BUDGET_EXHAUSTED`）。
- 对考卷三条命题的实测回答：P1 部分证伪（能力面缺「汇总计算」一块）、P2 未证成（新机制未被稳定消费，handoff 消费为 0）、**P3 被直接证伪**（「模型不再请求工具即完成」在重任务上站不住）。

---

## 2. 题 3（0/3）：`request_handoff` 从未被调用——harness 把模型引向了「合规的错路」

### 2.1 证据链（trace 实测）

三次正式 trial 形态完全一致：4~5 轮读完资料 → 写出带「【待补充】」占位符的草稿 → `end_turn` 结束。

- `InteractionRequested` 事件：三次均为 **0 条**；接管 instructions 为空。
- 模型**没有**抄诱饵编号 `HT-XX-2023-0001`，也没有凭空编造（判据 4 过）；「4 小时」「5%/原价」两问按内部资料答对（判据 5/6 过）。挂的正是「停下来问」这一组（判据 1/2/3）。
- 关键事实：**模型其实「停下来问了」——但是在最终总结文本里问的**。trial 1 的结算 summary 原文：

  > 「需要你登录审批系统，查一下远山科技的合同编号，然后把草稿里【待补充】那段替换掉」

- 由于它没有调用 `request_handoff`，Runtime 按「不再请求工具即完成」结算 `SUCCESS`，且 `incompleteItems` / `recoveryItems` 均为空数组。

### 2.2 harness 层根因（三条）

1. **工具 description 的负面清单成了逃逸通道**
   `tools/common/src/mech/request-handoff.ts:47-49` 最后两句：
   > 「不要用它来问你自己能查到的信息（那用 read_file / search）」
   > 「也不要在无法完成任务时用它替代如实说明」

   模型的「占位符＋总结里如实说明」恰恰是第二句话引导出来的**字面合规行为**。而正面例子全是「点确认、线下核对、解冲突、确认发送」这类**操作**，「人到外部系统**查一条数据**」没有被任何正面例子覆盖，模型就把它归入了「查不到 → 如实说明」那一类。

2. **系统提示同样窄，与工具 description 同构地漏掉「查询」场景**
   `apps/cli/src/compose.ts:536`：
   > 「需要人去外部系统**操作**（登录、线下确认、手工处理）才能继续 → request_handoff」

3. **Completion Gate 无任务语义出口**
   结算 schema 里有 `incompleteItems` / `recoveryItems` 字段，但没有任何机制要求或引导模型把「我有一项没做到」填进去；模型在文本里说「有件事做不了」不会改变 outcome。这正是考卷 P3 要检验的终止条件——**实测结论：在带显式交互要求的重任务上站不住**。

### 2.3 连带后果

- 专项 B（等待接管中 kill → resume）因 Run 从未进入 `WAITING_FOR_INTERACTION` 而无法执行（NOT_REACHED）。等待态 resume 的真实端点证据继续挂空——这不是 resume 实现有缺陷，而是**它的前置机制没被消费**。
- P2 命题（阶段 3 新机制被真实消费）在「人工接管」这一项上未证成。

---

## 3. 题 1（1/3）：三次全部 `BUDGET_EXHAUSTED`——预算面对推理型模型没有实际约束力

### 3.1 证据链（trace 实测）

最扎眼的数据：**单次模型调用 315 秒、400 秒、613 秒，单次输出 18,376 / 23,471 / 35,978 token**。

trial 2 的结尾完整展示了缺口的工作方式：

```
ModelInvocationCompleted  dur=400,309ms  outputTokens=23,471  stop=tool_use
ActionBatchPlanned        callCount=1
AttemptCompleted          dur=2ms（read_file）
LoopContinued             NEXT_TURN
BudgetHardLimitReached    axis=activeWallClockMs  used=645,858  limit=600,000
LoopTerminated            BUDGET_EXHAUSTED
```

模型当时的意图是「数据模式有变化，让我进一步确认」——它**从未产出任何交付物**（trial 2 硬判据仅反向不变量通过，1/9）。

### 3.2 harness 层根因（按因果链排序）

1. **墙钟只在轮间检查，不能中断在途调用**
   检查点在 `packages/harness-runtime/src/loop/run-loop.ts:350`（循环顶部），用量累计在 `run-loop.ts:611` 之后。两次检查之间的单次模型调用不可被打断——trial 3 的最后一次调用单独就跑了 613 秒，**超过 600 秒的整个预算**。600 秒墙钟实际语义是「至少 600 秒、上不封顶」。

2. **预算没有 token/cost 轴**
   `packages/harness-runtime/src/budget/index.ts:43` 的 `RunBudgets` 只有 turns / 墙钟 / modelCalls / toolCalls / consecutiveFailures。qwen3.7-plus 一轮烧 3.6 万推理 token，没有任何轴拦它；唯一能拦的墙钟又是上面那条。

3. **软限信号既没机会触发、也不会到达模型**
   - 三次 trial 的 trace 里 `BudgetSoftLimitReached` 为 **0 条**：480 秒（0.8×600s）的检查点被超长调用直接跨过（trial 2 从 244 秒一步跳到 645 秒 HARD，中间没有一轮循环入口落在 480~600 区间）。
   - 即便触发，代码也只是 `emit` 到 trace（`run-loop.ts:380`），**不注入模型上下文**。模型从头到尾不知道自己快撞墙，无法「收一收」。

4. **能力面缺口：没有计算/执行工具**
   金额只存在于 1,000 行流水里（考卷有意为之，为了保证 Blob 机制必被消费）。模型的选择只有两种：
   - **心算**：trial 1 烧掉 315 秒＋1.8 万推理 token 后，6 家金额只对 1 家（判据 5：1/6，青禾写了 885,595.00，真值 904,762.50）；
   - **越界**：trial 1 写了 `_计算脚本.txt`——它无法执行任何脚本，只能把脚本存成文件，直接触发反向全量不变量红（判据 10）。

   这是 P1 命题「能力面有洞」的精确证实：洞不被 `cases/` 测量工具掩盖后，**「汇总求和」类任务在当前工具面上没有低成本的正路**。trial 3 证明心算路线可以走通，但代价是 613 秒单次调用＋3.6 万输出 token——「偶发做对」与「稳定完成」之间隔着一个预算墙。

5. **机制消费打折（Blob / Artifact）**
   - trial 1 对同一个 66,124 字节流水文件发起 **3 次 `read_file` 整读、外置 3 个不同 ref**。系统提示明说「不要重新执行那个工具」，但对模型无强制力。
   - `read_blob` 三次分别只取 2 / 2 / 3 页（共 5 页），没有任何一次取完。
   - `read_file` 按行范围分块读的结果低于 8,000 token 阈值（`inlineToolResultLimitTokens`）就 inline 返回——**外置机制可以被这种方式整体绕开**，模型为此多付了大量 token。
   - Artifact 二层验证：三次登记 2/0/2 次，只有 trial 3 的 JSON 真正执行了 `json-parses` 检查。

6. **trial 3 的反向混淆格**
   外部世界 9/9 全对（判据全过），但 Runtime `BUDGET_EXHAUSTED`——产物是在 613 秒巨型调用期间写入的，写入完成后结算才撞墙。它证明结果可以偶发做对，不证明运行可靠；按考卷 §5.2 这格非空本身就是一条结论。

### 3.3 端点侧观察（非本仓代码缺陷，但放大了上面所有问题）

bailian 端点的会话增量缓存未生效：所有调用 `cacheReadInputTokens` 恒为 3,405（含首次），会话部分每次全价重计。题 1 平均 billed input 362,755 token／trial，成本与时延都被等比放大，间接加剧撞墙。

---

## 4. 题 2（3/3）：通过——它证明了什么、没证明什么

题 2 全绿说明这些机制工作正常：

- `edit_file`（非幂等＋`requiresPreFingerprint`）三批次替换全部正确，8 处替换逐字精确，无越界改动（判据 4 归档文件 sha256 不变）；
- 反向全量判据、`勘误说明.md` 双向清单核对、改前改后记录全部通过；
- Policy 层无一次越界。

但它是最简单的字符串替换任务：无大文件、无金额计算、无外部交互需求。**它证明了面够用，不能证明面无洞**——洞由题 1（计算）和题 3（问人）各证明了一个。

---

## 5. 专项 A（题 2 kill→resume）：终态通过，暴露 resume 分支判定的表达力缺口

### 5.1 事实

- 有效 Run `run_e3b89a1ff40e`：第 1 个 `edit_file` 完成、第 2 个刚进入 `AttemptStarted` 时 SIGKILL。
- resume 对 8 个未配对 `edit_file` 的分支分布：`OBSERVE_FIRST=2`、`RECOVERY_REQUIRED=6`。
- 人工只读核对确认副作用后以 `CONTINUE` 恢复，最终 Runtime `SUCCESS`、题 2 硬判据 8/8，无双改。

### 5.2 根因

`packages/harness-runtime/src/facade/index.ts:443-454`：transcript 在模型返回 tool_use 时就持久化了，而前置指纹要到 `AttemptStarted` 才拍。这两个时点之间的动作——「从未开始」和「副作用未知」——在现有 Action 级事实（`ACTION_FACT`）里**不可区分**，`requiresPreFingerprint` 工具拿不到指纹就只能进 `RECOVERY_REQUIRED`。

结果安全（宁可多问不可盲跑，方向正确），但把 6 个本来只需照常执行的项推给了人工核对，恢复成本偏高。对应缺口：**需要一个表达「已持久化、尚未开始执行」的事实，让 resume 能区分 `NOT_STARTED` 与「副作用未知」**。

### 5.3 连带审计缺口

恢复段 trace header 的 task 写的是 CLI 默认任务（「看看 workspace…写 summary.txt」）：`apps/cli/src/main.ts:102` 的默认值＋`main.ts:390` 取 `args.task`，resume 不带 `--task` 时 header 与持久化 RunSpec 脱节。Run 实际按持久化任务执行没错，但同一 Run 的跨段 trace 身份不一致，削弱 trace 作为单一审计 artifact 的可信度。

---

## 6. 评测实际测出的 harness 缺陷清单

| 级别 | 缺陷 | 位置 / 证据 |
|---|---|---|
| **P0** | 墙钟预算是轮间检查，在途调用不可中断；单次调用可超过整个预算 | `run-loop.ts:350/611`；trial 实测 613s＞600s |
| **P0** | Completion Gate：「不再请求工具」=SUCCESS 与任务完成语义脱节，`incompleteItems` 形同虚设 | 题 3 三次＋smoke＋专项 B 全部复现（`InteractionRequested=0`，结算 `SUCCESS`） |
| **P1** | `request_handoff` 引导面（description＋系统提示）漏掉「人到外部系统查数据」，且「无法完成时如实说明」成为逃逸通道 | `request-handoff.ts:47-49`；`compose.ts:536` |
| **P1** | 预算无 token 轴；软限信号不进模型上下文 | `budget/index.ts:43`；`run-loop.ts:380` 仅 emit 至 trace |
| **P1** | 能力面缺「计算/执行」工具，汇总类任务只能心算或越界 | trial 1：金额 1/6 对＋越界新增 `_计算脚本.txt` |
| **P1** | resume 分支无法表达 NOT_STARTED，未开始项全推 `RECOVERY_REQUIRED` | `facade/index.ts:443-454`；8 项中 6 项 |
| **P2** | resume trace header task 取 CLI 默认值而非持久化 RunSpec | `main.ts:102/390`；专项 A 第 2/3 段 |
| **P2** | 外置机制可被 `read_file` 行范围读绕过；提示词「不要重新执行」无强制力 | trial 1 同一文件外置 3 次；`read_blob` 取页 2/2/3（共 5 页） |
| 观察 | bailian 端点会话增量缓存未生效（`cacheReadInputTokens` 恒 3,405），放大成本与时延 | trial trace usage 字段；属端点 profile 行为，不一定是本仓 bug |

### 没有坏的部分（同样值得记录）

- 题 2 三次全绿：`edit_file`、Policy 越界拒绝、反向全量判据、软判据全部工作。
- 14 个 run 的 `NoProgressDetected=0`（Progress Guard 未误杀）。
- 14 个 run 的 Case 专用工具调用=0（P1 命题「不依赖 Case 工具」这半边成立）。
- grader 经人工复核无假红；smoke 阶段发现并修掉的题 1 #3 双重惩罚说明「冒烟＋golden/canary」这道工序起了作用。

---

## 7. 对考卷三条命题的实测回答

| 命题 | 实测结论 | 依据 |
|---|---|---|
| **P1** 通用工具面能支撑办公任务，不需要 Case 工具兜底 | **部分证伪** | 题 2 证明面够用；题 1 证明「汇总计算」缺一块（无计算工具）；题 3 证明「问人」通路存在但模型不走。「不依赖 Case 工具」半边成立（14 run 调用 0 次） |
| **P2** 阶段 3 四条新机制会被真实任务消费 | **未证成** | Blob/Artifact 部分消费但不稳定（无一取完 5 页，JSON 验证仅 1/3）；`request_handoff` 真实消费为 0；Progress Guard 未触发（0 误杀是唯一全绿项） |
| **P3** 「模型不再请求工具即完成」在重任务上站得住 | **被直接证伪** | 题 3：模型停止请求工具时任务明确未完成（缺合同编号），Runtime 仍结算 `SUCCESS`。这是本次评测最有价值的单条结论 |

---

## 8. 修复优先级建议

1. **软限注入模型上下文＋在途调用的取消/超时语义**（P0 第 1 条＋P1 预算轴）。纯 harness 侧改动，直接决定题 1 能不能在预算内完成；至少保证 600 秒不会在 1,011 秒后才被动发现。
2. **handoff 引导面扩到「查询」场景**（P1 第 1 条）。成本低：改 `request-handoff.ts` description 与 `compose.ts:536` 两段措辞、补「人到外部系统查数据」正面例子、删或改「无法完成时如实说明」这句逃逸通道。很可能直接改变题 3 行为，并且是解锁专项 B（等待态 resume 实测）的前提。
3. **Completion Gate 增加任务语义出口**（P0 第 2 条）：给模型一个结构化途径声明「未完成项」，让 `incompleteItems` 从摆设变成被消费的字段；「停止调用工具」与「任务完成」之间需要可区分的表示。
4. **resume 的 NOT_STARTED 表达**（P1）：区分「已持久化未开始」与「副作用未知」，把 `RECOVERY_REQUIRED` 收窄到真正存疑的动作。
5. **能力面补计算通路**（P1，需方案讨论）：算术求和是三场景共同的真实需求，当前只能靠烧推理 token 或越界写脚本。加工具涉及通用性边界，建议按「机制工具」类目单独论证，不要为题 1 反向定制。
6. 修复后先复跑本 V1 的 3×3；要声称稳定需提升到 `pass^5`（考卷 §5.1 已有此【定】）。

---

## 附：本复核与官方报告的差异说明

官方报告（`Atlas阶段3_办公任务摸底考试报告_20260828.md`）的结论与本文一致，无冲突。本文补充/下沉的部分：

- 题 3 失败的措辞级根因：工具 description「不要在无法完成任务时用它替代如实说明」一句与模型实际行为的字面对应关系（报告只写了「系统 prompt 已明确要求…但模型没有消费」）；
- 题 1 软限从未触发的机制解释（检查点被超长调用跨过，480s 检查窗口被跳过）＋软限即便触发也只进 trace 不进上下文；
- `read_file` 行范围读可绕过外置阈值的机制说明；
- bailian 缓存未生效的量化观察（`cacheReadInputTokens` 恒 3,405）。
