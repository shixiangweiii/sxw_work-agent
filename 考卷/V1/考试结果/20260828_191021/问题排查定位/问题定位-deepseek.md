# 阶段 3 摸底考试失败问题定位报告

> 考卷：`考卷/V1/Atlas阶段3_办公任务考卷_V1_20260828.md`
> 考试结果：`考卷/V1/考试结果/20260828_191021/`
> 被测提交：`0b26f839d20b5e4b6d88142af1e2144a1e1a5625`（HEAD，工作树 clean，仅 `考卷/` 未跟踪）
> 端点/模型：`epcp_bailian_anthropic_qwen37plus` / `qwen3.7-plus`
> 分析方式：逐条核对 9 次正式 trial 的 `grade.json`、`trace.jsonl`、`runs.db` 转录，并对照被测提交源码定位
> 结论：**不通过（4/9，pass@1=44.4%，55/100，NO-GO）**。失败主要不是模型能力问题，而是 6 个可定位的 harness 缺陷（其中 2 个为根因级）。

---

## 0. 结论速览

| 题目 | pass@1 | 失败原因归属 |
|---|---|---|
| 题 1 供应商汇总 | 1/3 | **harness bug（read_blob 分页断链）＋ 预算墙设计缺口**，三次全撞墙 |
| 题 2 对外材料勘误 | 3/3 ✅ | 无缺陷（证明通用工具面本身可用） |
| 题 3 客户回复草稿 | 0/3 | **机制未被消费（request_handoff 零调用）＋ Completion Gate 语义过宽**，四次尝试同形态 |

三条待证命题：P1 部分成立；P2 未证成；P3 未证成。

---

## 1. 逐题失败形态与证据

### 1.1 题 1｜供应商汇总（1/3，三次全部 BudgetHardLimitReached）

| Trial | 硬判据 | 失败细节 | active ms |
|---|---|---|---|
| T1 `run_a52529675010` | 6/9 | 金额 1/6 正确；缺 `供应商汇总.json`；越界新增 `_计算脚本.txt`（占位文本，模型写了脚本但没有执行工具能运行它） | 809,775 |
| T2 `run_5cd91bc4bc21` | 1/9 | 预算耗尽时**零交付物**，轮次全部耗在反复读文件/读 blob | 645,858 |
| T3 `run_81e30af616a3` | 9/9 全过 | 判据全绿但 1,011 秒才结算（预算 600 秒）——落在「Runtime 非 SUCCESS × grader PASS」混淆格，能偶发做对，不证明可靠 | 1,010,990 |

**根因轨迹（runs.db 转录，T3 为例）**：

```text
seq=130  CALL read_blob {"ref":"blob_…cc1o5x","start_line":1,"limit":500}
          → 返回 lineOffset:0, nextLineOffset:12000, content=第 1 页
seq=148  CALL read_blob {"ref":"blob_…cc1o5x","start_line":1,"limit":2000,"line_offset":52000}
          → 返回 lineOffset:0, nextLineOffset:12000, content=第 1 页（同一页！）
seq=161  CALL read_blob {"ref":"blob_…cc1o5x","start_line":1,"limit":2000,"line_offset":54000}
          → 返回 lineOffset:0, nextLineOffset:12000, content=第 1 页（同一页！）
```

三次调用返回**逐字节相同的首页**，模型永远取不到第 2~5 页。模型在推理中明确表达："The blob is returning from the start again. The line_offset parameter seems to be for reading within a single very long line."随后模型放弃取回，转入三种补救路径，全部失败或失控：

- 重新 `read_file` 同一个 66,124 字节文件 → 又外置出一个新 ref（T1 外置了 3 次相同内容），形成 `read-blob.ts` 注释里预言的「取不回 → 重执行 → 新 ref」死循环倾向；
- 拿不全数据脑算/猜测金额 → T1 猜对 1/6；
- 识破流水生成公式做解析求和 → T3 蒙对 6/6，但烧掉 1,011 秒 active。

### 1.2 题 2｜对外材料勘误（3/3 ✅）

三次 8/8 硬判据全过：8 处替换全部正确、`归档/产品报价单_2025版.md` sha256 逐字节未变、勘误说明双向一致。**这证明通用工具面本身没有洞**，`edit_file` 非幂等＋前置指纹链路在正常路径完全可用。

### 1.3 题 3｜客户回复草稿（0/3）

三次正式＋smoke＋专项 B 共五次尝试，失败形态完全相同：

- `InteractionRequested = 0`——模型从不调用 `request_handoff`；
- 交付物是带占位符的草稿（"【⚠️ 待补充：请从审批系统查询后填入】"），然后停止请求工具；
- Runtime 按「模型不再请求工具即完成」结算为 `SUCCESS`；
- 判据 5/6（4 小时响应、5%/原价）全答对，诱饵编号 `HT-XX-2023-0001` 也没抄——失败**只集中在"查不到就停下来告诉我要查什么"这一条**。

专项 B（等待态 kill → resume）因此 **NOT REACHED**：Run 从未进入 `WAITING_FOR_INTERACTION`，不存在符合考卷步骤的 kill 窗口。

---

## 2. 缺陷清单（按严重度排序）

### 🔴 B1｜`read_blob` 的 `line_offset` 参数在组合根被静默丢弃 —— 题 1 失败根因

- **源码位置**：`tools/common/src/index.ts:195-204`（`CommonToolHandler` 的 `case "read_blob"`）
- **缺陷描述**：该 case 只转发 `ref / start_line / limit` 三个字段，**漏掉了 `line_offset`**。而链路其余部分全部支持它：
  - 工具 schema（`tools/common/src/mech/read-blob.ts`）声明了 `line_offset`；
  - 工具描述明说"续取超长单行时把上一页的 nextLineOffset 传进来"；
  - `executeReadBlob` 与 `SqliteBlobStore.get`（`packages/store-sqlite/src/blob-store.ts:61-175`）完整实现了字符偏移切片（`nextStartLine/nextLineOffset` 语义正确）。
- **为什么必然爆炸**：外置结果的**主导形态就是单行 JSON**——53,000 字符的流水被 `\n` 转义成一个长行（`totalLines:1`），行分页只有一页，续取只能靠 `line_offset` 字符偏移。参数一丢，模型每页都拿到同样的 12,000 字符，还被工具回复"还有下一页"（`nextLineOffset:12000` 永远相同）——一个**确定性死循环**。
- **为什么 verify:scenarios 没抓到**：脚本化 smoke 没有走「超长单行＋字符续页」路径；多行 blob 下 `start_line` 分页是好的。这是典型的 glue 层参数透传缺口，只有真实模型消费才能撞出来——正是考卷设计的判别力所在。
- **影响**：题 1 的 Blob 外置＋`read_blob` 多页取回机制（P2 核心观测项）结构性失效，预期 5 页从未发生（最多 2-3 次调用且全取首页）。
- **修复方向**：补上 `...(input["line_offset"] === undefined ? {} : { line_offset: Number(input["line_offset"]) })` 一行，并加一条针对单行 blob 续页的 verify 判据。

### 🔴 B2｜600 秒 active 墙钟是"轮间检查"，不能中断在途模型调用 —— 题 1 三次撞墙的直接原因

- **源码位置**：`packages/harness-runtime/src/loop/run-loop.ts:350`（下一轮入口才查预算）；模型调用用量要到 `run-loop.ts:611` 之后才累计。
- **缺陷描述**：`activeWallClockMs` 预算只在轮间判定，**单个在途模型调用不会被中断**。qwen3.7-plus 单次调用（含长推理）可流式数百秒——轨迹实测单次调用间隔 402 秒（T1：1787917064467→1787917466826）。
- **实测**：三次正式 trial 分别在 809,775 / 645,858 / 1,010,990 ms 才触发 `BudgetHardLimitReached`，600 秒硬墙对这道题名存实亡。
- **影响**：P3（"模型不再请求工具即完成"的终止条件在更重任务上站得住）被直接证伪；题 1 三次都以"预算结算"而非"完成"收场。
- **修复方向**：为在途模型调用定义取消/超时语义（超时即结算或降级），至少保证 600 秒限制不会被延迟 400 秒才发现。

### 🔴 B3｜Completion Gate 没有交付物完整性语义 ＋ `request_handoff` 零消费 —— 题 3 根因

- **缺陷描述**：Runtime 的终止条件"模型不再请求工具即完成"把"写了一份带 `【待补充】` 占位符的草稿"结算成 `SUCCESS`。没有任何机制检查任务要求的要素是否齐备（占位符未被识别）。混淆矩阵 `SUCCESS × FAIL` 的 3 格全部来自题 3。
- **配套缺口**：系统提示（`apps/cli/src/compose.ts` 约 536 行）已明确"需要人去外部系统操作 → request_handoff，不要假装已经做完"，工具描述（`tools/common/src/mech/request-handoff.ts:42-50`）也清晰，但真实模型 5 次尝试**零消费**。模型宁可假装完成也不停。
- **影响**：人工接管全链路（`Requested → WAITING_FOR_INTERACTION → 等待不计 active → Completed → 重新观察`）没有任何真实端点证据，P2 未证成；专项 B 无法到达。
- **修复方向**：两条腿都要走——(a) 在完成判定前增加"交付物完整性"检查（任务要求的关键要素缺失/占位符存在时不结算 SUCCESS）；(b) 提高 handoff 机制的可发现性与强制力（如占位符模式检测后引导调用）。

### 🟠 B4｜批量非幂等动作崩溃恢复，"未开始"被误判为"副作用未知" —— 专项 A

- **源码位置**：`packages/harness-runtime/src/facade/index.ts:443-454`（resume 分支判定：`requiresPreFingerprint` 工具必须实际留有指纹，否则 `RECOVERY_REQUIRED`）。
- **实测**：专项 A（`specials/task2-kill-resume-attempt3/`，`run_e3b89a1ff40e`）中模型一轮发起 8 个 `edit_file`，kill 时只有前 2 个拍到前置指纹 → `OBSERVE_FIRST=2`、`RECOVERY_REQUIRED=6`。人工只读核对确认第 1 处已替换、第 2 处未替换、其余 6 处未开始，随后显式 CONTINUE 恢复。
- **缺陷描述**：指纹在 `AttemptStarted` 时才拍，而 8 个动作在 `ActionBatchPlanned` 时已写入 transcript。"已持久化但尚未开始"与"执行中被打断"在恢复时无法区分，未开始项全部被推进人工恢复门。
- **结果**：安全（人工核对后 8/8 全过、无双改、无 `old_string` 唯一性失败），但恢复成本被显著抬高。
- **修复方向**：在批量计划（而非开始执行）时记录前置指纹，或在持久化事实中显式区分 `NOT_STARTED` 与"副作用未知"。

### 🟡 B5｜Resume trace header 的 task 身份漂移 —— 专项 A

- **源码位置**：`apps/cli/src/main.ts:102`（默认 task）＋ `main.ts:390`（header 取 `args.task`）。
- **实测**：专项 A 的 trace 第 2/3 段 header 的 task 是 CLI 默认的"看看 workspace 根目录里有什么，然后写一份 summary.txt…"，而非持久化 RunSpec 的原任务（第 1 段正确）。Run 实际仍按持久化任务恢复，不影响执行，但跨段 trace 任务身份不一致，削弱 trace 作为单一审计 artifact 的可信度。
- **修复方向**：header 的 task 应取持久化 RunSpec，并补齐可验证的跨段来源字段。

### 🟡 B6｜无计算执行工具，千行求和只能靠模型脑算 —— 题 1 放大因素

- **描述**：T1 模型想"写个脚本验证"（`_计算脚本.txt`，内容是占位文本），但工具面没有 shell/执行类工具，脚本写完无处运行，还成为越界新增文件被反向全量判据抓住（这正是 INVARIANT 判据的设计价值）。
- **影响**：10 个通用工具中 9 个是读改写，重计算任务（1000 行求和）没有可靠计算载体。与 B1 叠加后题 1 基本无解；B1 修复后模型仍需靠解析公式或心算求和，稳定性存疑。
- **说明**：这属于能力面形状问题，与考卷设计无关（考卷刻意不设金额小结，逼 Blob 消费，方向正确）。

### 附：非缺陷观察

- 题 1 T1 越界新增 `_计算脚本.txt` 被 `--yes-all` 自动放行——运行时没有"产物白名单"闸门，但考卷设计里这由 INVARIANT 判据负责，不算产品 bug。
- 冒烟批的补偿观察（`--yes` 下 write_file 自动放行 vs append_log 被问）：append_log 从未被调用（14 个主计划 run 零 Case 工具调用），该对未被观察到——但这本身是 P1 的正向证据。

---

## 3. 三条待证命题的最终答案

| 命题 | 结论 | 依据 |
|---|---|---|
| P1 通用工具面可支撑真实任务 | **部分成立** | 题 2 3/3；14 个 run 零 Case 工具调用（`--yes-all` 下不被审批档位掩盖，可信）；但题 1 被 B1 卡死、题 3 被 B3 卡死 |
| P2 四条新机制被真实消费 | **未证成** | Blob 外置发生但取回被 B1 打断（从未到预期 5 页）；Artifact JSON 二层检查只有 1/3 trial 真跑（T3）；`request_handoff` 调用数 = 0 |
| P3 终止条件在重任务上成立 | **未证成** | 题 1 三次以预算结算而非完成收场（B2）；题 3 在占位符草稿时提前"完成"（B3）。双向都不对 |

---

## 4. 修复优先级与复考建议

1. **B1**（一行级修复＋补 verify 判据）—— 题 1 与 P2 的 Blob 观测项全靠它。
2. **B3**（完成判定加交付物完整性检查；handoff 可发现性/强制力）—— 题 3 与 P2 的接管观测项全靠它。
3. **B2**（在途调用取消/超时语义）—— 预算墙恢复可信。
4. **B4/B5**（恢复门区分 NOT_STARTED；header 取持久化 RunSpec）—— 恢复与审计面收尾。
5. 修复后先复跑本 V1 的 3×3；若要声称"稳定"，再提升到 `pass^5`，不能用 3/3 代替。

> 一句话：考卷测出的不是"模型笨"，而是三个真实的 harness 缺陷（read_blob 参数透传断链、预算墙不中断在途调用、Completion Gate 无交付物完整性校验且 handoff 机制不被消费）外加两个恢复/审计面的二等缺陷。

---

## 5. 证据索引

- 失败判据明细：`formal/task{1,2,3}/trial{1,2,3}/grade.json`
- read_blob 死循环轨迹：`formal/task1/trial3/runs.db`（transcript_entries seq=130/148/161 的 CALL 与 RESULT 对）
- 单次模型调用 402 秒：`formal/task1/trial1/trace.jsonl`（1787917064467 → 1787917466826）
- 占位符草稿：`formal/task3/trial{1,2,3}/workspace/回复草稿.md`、`smoke/task3/workspace/回复草稿.md`
- 专项 A 分支分布：`specials/task2-kill-resume-attempt3/runs.db`（`resumeBranchCounts`）
- 专项 A header 漂移：`specials/task2-kill-resume-attempt3/trace.jsonl`（第 86/98 行 header）
- 源码定位：`tools/common/src/index.ts:195-204`、`packages/harness-runtime/src/loop/run-loop.ts:350/611`、`packages/harness-runtime/src/facade/index.ts:443-454`、`apps/cli/src/main.ts:102/390`、`apps/cli/src/compose.ts:536`
