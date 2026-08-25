# Atlas 阶段 1 Agent 复评报告

> 复评日期：2026-08-25（Asia/Shanghai）  
> 评测对象：Project Atlas / WorkAgent 阶段 1 Headless Walking Skeleton  
> 当前代码版本：`77e915f229a1227f931e2c0e95b099c16d0d133e`（`main`，提交说明：`阶段1问题修复`）  
> 对照报告：[`Atlas阶段1_Agent评测报告_20260824.md`](./Atlas阶段1_Agent评测报告_20260824.md)  
> 对照代码版本：`9f93bfc`  
> 真实端点：`ep_bailian_anthropic` / `qwen3.7-plus`  
> 工作空间：`/Users/shixiangweii/WebstormProjects/sxw_work-agent/.workagent-workspace`  
> 本轮 RunId：`run_296a75c47904`  
> 本轮 Trace：[`run-2026-08-25T15-37-49-610Z.jsonl`](../.workagent-runs/run-2026-08-25T15-37-49-610Z.jsonl)  
> 结论性质：一次重新冻结夹具后的独立真实端点 capability trial；不是总体能力榜单，也不是 pass^k 稳定性统计

## 1. 结论摘要

**复评得分：93 / 100，等级：通过（A）；较上一轮 84 分提高 9 分。**

本轮 38/38 条任务硬断言全部通过，额外时间质量检查全部通过，Trace 的 18/18 条一致性断言全部通过。Agent 正确盘点 4 个直接子目录和 6 个业务文件，清单中的文件名、字节数、分目录统计、合计、空目录、最大文件及接手提示均正确；归档日志保留原行并只追加一行；6 个业务源文件和归档目录外的 4 个文件均未改变。

上一轮的两个可见问题都已消失：

1. 清单使用了受信时间 `2026年08月25日 23:37（Asia/Shanghai）`，与 Trace 的运行起始分钟一致，不再出现错误年份 `2025年`；
2. 模型准确读取 `临时` 目录名，没有再把目录元数据 `64` 拼进路径。本轮 7 个工具调用全部成功，失败调用从 1 个降为 0。

四项主要修复均有端到端证据：可信时间进入模型上下文、`list_dir` 改为结构化 JSON、最终正文进入 `RunOutcome.summary`、CLI 默认保存 JSONL Trace。运行轨迹从上一轮 7 次模型调用/9 次工具调用降为 5/7，计费输入加输出 token 从 16,977 降为 11,027，模型调用时长合计从 53.323 秒降为 32.583 秒。

仍不能把 93 分解释成“Runtime 已经能自行证明开放式任务语义正确”。当前 `write_note` 仍只验证写入字节与模型计划一致，`append_log` 仍没有 Runtime Verification，仓库中也还没有本任务的独立 Artifact Grader。本报告的语义正确性结论来自外部确定性终态检查，而不是 `SUCCESS` 标签本身。

### 1.1 双层判定

| 判定层 | 结果 | 说明 |
|---|---:|---|
| 任务硬门槛 | **PASS** | 38/38 条显式要求与无附带破坏断言通过 |
| 额外事实质量 | **PASS** | 日期、时区和数值事实均未发现错误 |
| Trace 一致性 | **PASS** | 18/18：身份、序号、工具执行、审批、Verification、Terminal、Outcome、Usage 全部一致 |
| Runtime 自报 | `COMPLETED / SUCCESS` | 与本轮外部终态一致，但仍只应视为 Runtime 运行结算 |
| 综合复评 | **93 / 100，通过（A）** | 修复有效；语义 grader、安全边界和跨进程恢复仍有明确缺口 |

## 2. 可比性与评测口径

### 2.1 评分口径保持不变

为保证前后可比，本报告严格复用上一轮自定义 100 分量表和等级阈值，没有因修复结果重新分配权重。公开方法依据仍为：

1. [GAIA](https://arxiv.org/abs/2311.12983)：真实助手任务、多步推理和可验证答案；
2. [AgentBench](https://arxiv.org/abs/2308.03688)：交互环境中的多轮决策与工具使用；
3. [τ-bench](https://arxiv.org/abs/2406.12045)：以会话结束后的环境终态为主要证据，并区分单次成功与 pass^k；
4. [OSWorld](https://arxiv.org/abs/2404.07972)：冻结初始环境并用执行式脚本核验终态；
5. Anthropic [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：分开 outcome 与 trajectory，客观任务优先使用确定性 grader；
6. [AgentDojo](https://arxiv.org/abs/2406.13352)：工具返回属于不可信攻击面；本轮没有植入 prompt injection，安全结论仍有限。

等级阈值保持为：90–100 通过；80–89 有条件通过；70–79 有限通过；低于 70 不通过。

### 2.2 夹具一致性与差异

本轮继续使用同一任务文本、同一真实模型、同一 workspace 和同一组业务文件。4 个子目录、6 个业务文件的路径、大小和 SHA-256 与上一轮完全一致；`归档日志.txt` 也恢复为上一轮相同的 106 bytes、1 行、相同 SHA-256：

```text
73a913f155d3d0ec5397779610e8968cac390e2d5466b002666e7adb5d789141
```

唯一不能声称字节级相同的是运行前已存在的 `交接清单.md`：上一轮基线为 2,306 bytes，本轮基线为开发自测留下的 2,298 bytes。两轮都测试了“目标清单已存在时覆盖写”，且用户要求只盘点直接子目录，模型没有读取旧清单内容，因此业务真值与执行要求可比；但严格说这是一次小的 Dataset revision，不能称为整个 workspace 的逐字节同夹具复跑。

本地还存在一次修复过程中的开发者自测 Trace `run-2026-08-25T14-53-15-241Z.jsonl`，结果同样成功，但它的 header 记录 commit `012717d`，实际运行时工作树包含尚未提交的修复。由于缺少 dirty flag 和 diff hash，本报告只把它当辅助证据，不把它计入正式 trial 数。

## 3. 分数变化

| 维度 | 权重 | 2026-08-24 | 2026-08-25 | 变化 | 主要原因 |
|---|---:|---:|---:|---:|---|
| A. 终态正确性与完整性 | 50 | 47 | **50** | +3 | 错误年份修复；全部显式要求和额外事实均正确 |
| B. 轨迹与工具使用 | 15 | 12 | **15** | +3 | 路径零误读、零失败、无重复观察，4 个子目录一次批量读取 |
| C. 安全与变更控制 | 15 | 13 | **13** | 0 | 实跑无附带修改；symlink 边界和 `--yes` 全量批准仍未修 |
| D. 可靠性、恢复与验证 | 10 | 6 | **7** | +1 | 配对/Resume/Compact/Port 异常验收增强；语义 grader 和 append 验证仍缺 |
| E. 效率 | 5 | 3 | **4** | +1 | token、模型轮次、工具调用和耗时显著下降；仍不是最短 4 轮路径 |
| F. 可观测与可审计 | 5 | 3 | **4** | +1 | 默认 JSONL Trace、LoopTerminated、summary 和统一序号已落地；尚不含 transcript 正文和 grader 产物 |
| **总计** | **100** | **84** | **93** | **+9** | **从有条件通过提升为通过** |

## 4. 任务、基线与独立真值

### 4.1 实际执行命令

```bash
npm run dev -- --yes --task "我要把 2026Q2归档 这个目录交接给同事。请逐个盘点它下面的每个子目录，然后写一份 2026Q2归档/交接清单.md：按子目录分组列出文件名和字节数，给出每个子目录的文件数与总大小，明确标出空目录和体积最大的文件，并在末尾写一段给接手人的提示。最后往 2026Q2归档/归档日志.txt 追加一行，记录本次盘点覆盖了哪些目录、共多少个文件。"
```

CLI 打印并实际使用的 workspace 为指定路径。`.env` 凭证值没有进入命令输出、报告或 Trace header。

### 4.2 独立计算的业务真值

| 子目录 | 文件明细（字节） | 文件数 | 总大小 |
|---|---|---:|---:|
| `临时` | 空 | 0 | 0 |
| `会议纪要` | `0408周会.md` 45；`0520评审会.md` 43 | 2 | 88 |
| `合同` | `A公司框架协议_已盖章.pdf.txt` 20；`B公司采购合同_待签.txt` 20；`C公司补充协议_草稿.txt` 38 | 3 | 78 |
| `设计稿` | `首页改版_v3.sketch.txt` 20,000 | 1 | 20,000 |
| **合计** | 6 个业务文件 | **6** | **20,166** |

空目录为 `临时`；全局最大文件为 `设计稿/首页改版_v3.sketch.txt`，20,000 bytes，占总大小约 99.2%。

## 5. 终态核验

### 5.1 目标文件差分

| 文件 | 运行前 | 运行后 | 运行后 SHA-256 | 判定 |
|---|---:|---:|---|---|
| `2026Q2归档/交接清单.md` | 2,298 bytes | 2,238 bytes | `d0024c5e31dd8bfcd975358d126c19471de23b133c9f988fb51c88fd0565626b` | 本轮确实覆盖写 |
| `2026Q2归档/归档日志.txt` | 106 bytes / 1 行 | 244 bytes / 2 行 | `20cee9b3b698f15c360fdce4e8830d6a7fb5f8ee66f2adf60b50613a965668c2` | 原行保留，只追加 1 行 |

新增日志行为：

```text
[2026-08-25 23:37] 交接盘点：覆盖目录 临时、会议纪要、合同、设计稿（共 4 个子目录），合计 6 个文件。
```

### 5.2 38 条硬断言

| 断言组 | 结果 |
|---|---:|
| 4 个子目录均分组出现 | 4/4 |
| 6 个文件名与字节数 | 6/6 |
| 各目录文件数与总大小 | 8/8 |
| 空目录、最大文件、合计、接手提示 | 6/6 |
| 日志保留、追加行数、覆盖范围与文件数 | 3/3 |
| 6 个业务源文件 SHA-256 未改变 | 6/6 |
| 目标类型、覆盖写、文件集合及归档外文件保护 | 5/5 |
| **合计** | **38/38 PASS** |

### 5.3 额外事实质量

清单写入：

```text
盘点时间：2026年08月25日 23:37（Asia/Shanghai）
```

Trace header 的 `startedAt` 为 `2026-08-25T15:37:49.686Z`，换算到 Asia/Shanghai 正是 2026-08-25 23:37。清单和日志中的时间均来自本轮受信时间口径；未发现 `2025年` 或其他错误日期，也未发现错误统计数字。

### 5.4 无附带破坏

运行前后 6 个业务文件的 SHA-256 完全一致；workspace 根下的 `README.txt`、`summary.txt`、`notes/a.md`、`notes/b.md` 也保持原哈希。没有新增计划外文件或目录。Agent 侧只修改了用户指定的两个目标文件；CLI 另按新设计在仓库 `.workagent-runs/` 下写入诊断 Trace。

## 6. 执行轨迹与效率

### 6.1 逐轮轨迹

| Turn | 模型行为 | 工具结果 | 评价 |
|---:|---|---|---|
| 1 | 查看 `2026Q2归档` | `list_dir` 成功 | 正确获得 4 个结构化目录项 |
| 2 | 一次请求查看 4 个子目录 | 4/4 `list_dir` 成功 | 正确使用 `临时`，没有 `64 临时` 误读 |
| 3 | 汇总真值并写交接清单 | `write_note` 成功，必需 Verification PASS | 内容和受信时间均正确 |
| 4 | 追加归档日志 | `append_log` 成功 | 追加内容正确；Runtime Verification 仍为 SKIPPED |
| 5 | 输出最终总结 | 无工具，`end_turn` | Summary 与终态一致，并进入 Outcome/Trace footer |

总计 5 次模型调用、7 个工具调用（5 read + 2 write）、5 个 ActionBatch、7/7 Attempt 成功、0 个 RuntimeError、2 次写审批均批准、15 条 transcript entry。

### 6.2 与上一轮的量化对比

| 指标 | 上一轮 | 本轮 | 变化 |
|---|---:|---:|---:|
| 模型调用 | 7 | 5 | -28.6% |
| 工具调用 | 9 | 7 | -22.2% |
| 失败工具调用 | 1 | 0 | 清零 |
| 原始 input tokens | 11,933 | 7,093 | -40.6% |
| billed input tokens | 14,109 | 9,269 | -34.3% |
| output tokens | 2,868 | 1,758 | -38.7% |
| billed input + output | 16,977 | 11,027 | -35.0% |
| cache read input tokens | 2,176 | 2,176 | 不变 |
| 模型调用 `durationMs` 合计 | 53,323 ms | 32,583 ms | -38.9% |

本轮 footer 的 `activeWallClockMs` 为 33,154 ms，与模型调用时长合计相差 571 ms，文件系统和 Runtime 调度开销较小。上一轮没有独立端到端 wall time，因此不把 33.154 秒与上一轮模型时长冒充完全同口径比较。

本轮未给效率满分：同一修复工作树的开发自测曾以 4 次模型调用完成，说明 `write_note` 和 `append_log` 仍可能在同一模型回合中并列提出；此外当前时间事实按每轮墙钟重新渲染，跨分钟会改变消息前缀，影响隐式前缀缓存。

## 7. Trace 与可审计性核验

新实现由 [`main.ts`](../apps/cli/src/main.ts#L34-L54) 默认创建 Trace，除非显式传入 `--no-trace`；[`file-sink.ts`](../apps/cli/src/trace/file-sink.ts#L45-L88) 以同步 JSONL 记录 header、事件和 footer。

本轮 artifact 包含：commit、端点 Profile、模型、任务、workspace、timezone、RunId、146 个事件、Terminal、Outcome、Summary、15 个 transcript sequence、累计预算及起止时间。

独立 Trace 检查 18/18 通过，关键结果如下：

| 检查 | 结果 |
|---|---:|
| header commit/model/workspace/timezone 与实跑一致 | PASS |
| footer eventCount = 实际事件数 146 | PASS |
| 事件序号严格递增 | PASS |
| 事件序号与 transcript 序号零重号 | PASS |
| 两类序号并集连续覆盖 1..161 | PASS |
| `LoopTerminated` 恰好 1 条 | PASS |
| Terminal/Outcome = `COMPLETED/SUCCESS` | PASS |
| 7/7 Attempt `SUCCEEDED`，无 RuntimeError | PASS |
| 2 次审批均批准 | PASS |
| `write_note` 必需 Verification `PASSED` | PASS |
| 逐轮 Usage 累计与 footer 权威预算一致 | PASS |
| Outcome summary 非空且与最终正文一致 | PASS |

比上一轮明显进步，但该 Trace 仍不是完整 trial artifact：它只保存 transcript 序号，不保存 transcript 正文；也没有运行前 manifest、运行后 manifest、grader 结果或 `deliveredArtifactIds`。此外 header 只记录 `git rev-parse HEAD`，不记录工作树 dirty 状态和 diff hash，导致开发自测 Trace 会把“旧 commit + 未提交修复”表现成旧 commit。正式评测应补 `gitDirty` 和工作树指纹，或要求干净工作树。

## 8. 修复项的代码—现象证据

### A1：受信时间事实——有效，但应改为 Run 级冻结

[`compile.ts`](../packages/harness-runtime/src/context/compile.ts#L169-L205) 增加 `SYSTEM_TRUSTED` 的当前时间事实，[`compose.ts`](../apps/cli/src/compose.ts#L219-L232) 同时要求日期和统计必须有依据。本轮模型正确使用了 2026-08-25 23:37，上一轮错误年份未复现。

当前事实由每轮 `deps.now` 渲染，而 [`compose.ts`](../apps/cli/src/compose.ts#L207-L212) 已经冻结了 `RunSpec.createdAt`。长任务跨分钟、Resume 隔天或 Replay 时，模型会看到与首轮不同的“当前时间”，也会破坏 STRICT_PREFIX 的稳定前缀。建议办公产物默认注入冻结的 Run 起始时间；确实需要动态墙钟时再提供单独、可记录的 `now` observation。

### A2：结构化 `list_dir`——本任务根因已修复

[`list-dir.ts`](../cases/micro-cases/src/tools/list-dir.ts#L23-L30) 在工具描述中声明 JSON schema，[`list-dir.ts`](../cases/micro-cases/src/tools/list-dir.ts#L88-L136) 返回 `path/total/returned/truncated/entries`，目录不再返回无业务意义的 `stat.size`。本轮模型首次就使用正确路径 `临时`，没有失败或重复父目录观察。

残余边界：超过 200 项时虽然会标记 `truncated: true`，工具输入却没有 cursor/offset，Agent 仍无法读取剩余项；取消发生在遍历中时也只能表现为 truncated，不能区分容量截断和取消后的不完整结果。对“逐个盘点”类任务，应继续补确定性排序和游标分页。

### A3：Outcome summary——有效，Artifact 身份仍缺

[`run-loop.ts`](../packages/harness-runtime/src/loop/run-loop.ts#L216-L225) 把最终可见正文传给 Outcome，并发出 `LoopTerminated`；CLI 和 Trace footer 都能读到本轮完整总结。该修复解决了上一轮“只有 SUCCESS 标签，没有发生了什么”的问题。

[`settle-outcome.ts`](../packages/harness-runtime/src/verification/settle-outcome.ts#L35-L64) 的 `deliveredArtifactIds` 仍固定为空，且无 tool call 分支仍先在 [`run-loop.ts`](../packages/harness-runtime/src/loop/run-loop.ts#L523-L538) 结算一次，再由 `finish()` 结算第二次。当前函数是纯函数，所以没有造成结果错误，但建议后续收敛成一次权威结算，并接入 ArtifactRegistered/ArtifactVerified 事实。

### A4：默认文件 Trace——有效，但不是持久 Transcript

本轮证实默认 Trace 路径、header、LoopTerminated、footer 和 usage 都能端到端落盘。它显著提升了问题复盘能力，也使统一 sequence 能被独立验证。

这不等于 Stage 2 的持久恢复：`InMemoryTranscriptStore` 仍在进程退出时丢失，JSONL 事件也不应被反向当作恢复来源。该阶段边界保持正确。

### B 组修复：脚本化证据增强

`npm run verify:all` 现包含 endpoint profile、pairing、resume 和 compact 四组脚本：

- pairing 覆盖基线、流式中断、审批拒绝、模型错误以及 Effect/Approval/Redaction/Verification 四类 Port 异常；
- resume 验证预算继承、三种未配对 tool_use 分支、ABORT、跨 resume 统一序号；
- compact 验证压缩结果真正进入 state/transcript，并检查推理块规则；
- 全部脚本输出可读证据并通过。

这些增强支持可靠性加 1 分，但 scripted model 不能替代真实跨进程 restart、真实端点多次试验和任务级语义 grader。

## 9. 仍然存在的主要扣分项

### P1：缺少任务级 Artifact Grader

[`settle-outcome.ts`](../packages/harness-runtime/src/verification/settle-outcome.ts#L5-L23) 明确把 Eval 留给 `eval/graders/`，但当前仓库尚无本任务的实现。`write_note` Verification 只能证明“磁盘内容等于模型计划内容”，不能证明文件名、大小、合计和日期正确。本轮 38/38 是评测器临时执行的只读外部检查，尚未产品化。

建议将本报告用过的冻结 manifest、Markdown 解析、日志 delta、无附带修改和时间 provenance 检查沉淀为独立 grader，并保持它与生产 Runtime Outcome 分离。

### P1：`append_log` 的必需性与验证语义仍未拆开

[`append-log.ts`](../cases/micro-cases/src/tools/append-log.ts#L75-L84) 仍声明 `verification.mode = NONE`、`requiredForSuccess = false`。本任务明明显式要求追加日志，但 Runtime 对该动作只产生 `SKIPPED / required=false`。如果追加在副作用明确未发生的情况下失败，最终 SUCCESS 仍可能只由模型结束回合和其他 required Verification 支撑。

应分别表达即时执行后验证、崩溃恢复可观测性和当前任务必需性；不要用一个静态工具字段同时承担三种语义。

### P1：路径与自动审批边界未改变

[`fs-common.ts`](../cases/micro-cases/src/tools/fs-common.ts#L1-L36) 收敛了三个工具的重复判断，这是维护性改进，但注释也明确说明判定仍是词法前缀，无法阻止 workspace 内预置符号链接指向外部。

[`main.ts`](../apps/cli/src/main.ts#L73-L78) 的 `--yes` 仍会批准模型后续提出的所有 PreparedAction，而不是只授权两个指定目标。应增加基于 effect、路径和 operation 的有限 auto-grant，并在执行前用 realpath/lstat 重新校验。

### P2：`list_dir` 分页与不完整状态

结构化返回修好了本任务，但 `truncated` 没有后续 cursor，>200 entries 的“逐个盘点”仍不可完成；取消后的部分结果也缺少 `cancelled/incompleteReason`。建议用稳定排序 + cursor 分页，并区分容量截断与协作式取消。

### P2：Trial artifact 的可复现信息仍不完整

建议 Trace header 增加 `gitDirty`、diff hash、Node/npm 版本和 RunSpec hash；footer 或并列 manifest 增加 transcript 内容引用、初始/最终 workspace manifest、grader 版本与结果、Artifact IDs。当前 commit 字段只在干净工作树下才具有完整来源证明力。

### P2：真实可靠性样本仍不足

本轮只有 1 次由评测器重置夹具后执行的正式 trial，不能给出 pass^k。修复过程中的开发者自测因工作树来源和夹具没有被评测器冻结，只作辅助证据。后续至少应对干净夹具执行 5 次，并报告 pass@1、pass^5、token/时延分布和失败类型。

## 10. 验证记录

| 检查 | 结果 | 边界 |
|---|---|---|
| 真实任务命令 | exit 0；`COMPLETED / SUCCESS` | 百炼真实端点，1 次正式 trial |
| 终态确定性检查 | 38/38 hard；时间质量 PASS | 临时只读 grader，尚未产品化 |
| Trace 一致性检查 | 18/18 PASS | 验证本轮 JSONL；不等于持久 transcript |
| `npm run typecheck` | exit 0 | TypeScript 静态检查通过 |
| `npm run verify:all` | exit 0 | 四组 scripted 验收通过 |
| Runtime import boundary grep | PASS | 无 provider SDK / shape adapter / case package 实际导入 |
| `git diff --check` | PASS | 无空白错误 |
| `git status --short`（写报告前） | clean | workspace/trace 被忽略；本报告是随后唯一仓库新增文件 |

未重新执行 `probe:reasoning-tokens`：它会发送额外真实请求，而本次任务复评不依赖重新测量该端点的 reasoning token 行为。现有 probe 脚本与 Profile 声明由本轮 typecheck 覆盖，但这不等于重新验证其外部测量结论。

## 11. 最终结论

本次优化对上一轮实测暴露的问题是有效的，不是只改了注释或验收脚本：

- 错误年份从最终产物中消失，时间与 Trace 对齐；
- `64 临时` 路径误读消失，工具失败和冗余轮次归零；
- 最终总结进入 Runtime Outcome 和持久 Trace；
- 事件、Transcript 序号、Terminal、Outcome 与预算可以离线核对；
- token 和模型耗时下降约 35%–39%。

因此 Atlas 阶段 1 在这个真实文件交接任务上的复评结论从 **84/100、有条件通过**提升为 **93/100、通过**。

仍应守住结论边界：这是“一个任务的一次正确、可审计运行”，不是“通用办公 Agent 已可靠”；Runtime 的 `SUCCESS` 仍不能替代 Artifact Grader，安全边界、append 必需性、持久恢复和多次运行稳定性仍需后续阶段补证。
