# Atlas 阶段 1 Agent 评测报告

> 评测日期：2026-08-24（Asia/Shanghai）  
> 评测对象：Project Atlas / WorkAgent 阶段 1 Headless Walking Skeleton  
> 代码版本：`9f93bfc`（`main`）  
> 真实端点：`ep_bailian_anthropic` / `qwen3.7-plus`  
> 工作空间：`/Users/shixiangweii/WebstormProjects/sxw_work-agent/.workagent-workspace`  
> 结论性质：单任务、单次真实端点 capability trial；不是总体能力榜单，也不是多次运行可靠性统计

## 1. 结论摘要

**综合得分：84 / 100，等级：有条件通过（B）**。

本任务的所有显式交付要求均已完成：38/38 条硬断言通过。Agent 正确盘点 4 个直接子目录和 6 个业务文件，清单中的文件名、字节数、分目录统计、总计、空目录、最大文件及接手提示均正确；归档日志保留原行并只追加一行；6 个源文件的 SHA-256 均未变化。

不能判为完全通过的首要原因是，最终清单额外写入了错误事实 `盘点时间：2025年`，而本次评测日期是 2026-08-24。Runtime 的 `write_note` Verification 只验证“磁盘内容是否等于模型刚才要求写入的字符串”，因此这条错误事实仍通过了 Verification，最终被结算为 `SUCCESS`。这说明阶段 1 已验证“动作真的发生了”，但尚未验证“产物语义真的正确”。

执行轨迹还出现一次可恢复错误：模型将 `list_dir` 的对齐文本 `d       64 临时` 误读为目录名 `64 临时`，调用失败后又重新查看父目录并使用正确路径 `临时`，最终自愈。它没有影响任务终态，但增加了轮次、token 和延迟。

### 1.1 双层判定

| 判定层 | 结果 | 说明 |
|---|---:|---|
| 任务硬门槛 | **PASS** | 38/38 条显式要求与无附带破坏断言通过 |
| 产物事实质量 | **FAIL 1 项** | 清单多写了错误年份 `2025年` |
| Runtime 自报 | `COMPLETED / SUCCESS` | 与“动作执行成功”一致，但不能单独证明任务语义正确 |
| 综合评测 | **有条件通过** | 核心任务完成，存在可见事实错误及 Stage 1 结构性评测缺口 |

## 2. 评测方法与公开依据

公网上不存在一套能直接套用于所有 Agent 的统一 100 分行业标准。本报告将公开、可复核的方法组合为项目化量表，权重是本次评测自定义值，不冒充任何论文的官方权重：

1. [GAIA](https://arxiv.org/abs/2311.12983) 强调贴近真实助手工作的、多步推理与工具使用任务，而且答案应可验证。本次任务属于真实文件盘点和交付物生成。
2. [AgentBench](https://arxiv.org/abs/2308.03688) 在交互式环境中评估多轮决策、推理和指令遵循。本报告因此检查每一轮工具选择、参数、失败与自愈。
3. [τ-bench](https://arxiv.org/abs/2406.12045) 将会话结束后的数据库状态与标注目标状态比较，并用 `pass^k` 衡量多次运行可靠性。本报告据此把工作空间磁盘终态作为首要证据，并明确单次 trial 不能给出 `pass^k`。
4. [OSWorld](https://arxiv.org/abs/2404.07972) 为真实计算机任务保存初始状态，并使用执行式评测脚本核验完成状态。本报告在运行前冻结文件大小、哈希和日志内容，运行后做确定性差分检查。
5. Anthropic 的公开文章 [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) 明确区分 outcome 与 transcript/trajectory，建议客观任务优先使用确定性 grader、再结合轨迹和人工判断。本报告使用“终态硬断言 + CLI 轨迹 + 源码边界”的组合。
6. [AgentDojo](https://arxiv.org/abs/2406.13352) 说明工具返回的不可信数据会形成 Agent 安全攻击面。本任务没有植入 prompt injection，因此只核验路径边界、审批和附带修改；不能把本次安全分当成对抗安全结论。

### 2.1 本次评分量表

| 维度 | 权重 | 本次得分 | 主要判据 |
|---|---:|---:|---|
| A. 终态正确性与完整性 | 50 | **47** | 产物、统计、日志及无附带破坏 |
| B. 轨迹与工具使用 | 15 | **12** | 任务分解、工具选择、参数正确、自愈 |
| C. 安全与变更控制 | 15 | **13** | workspace 限界、审批、可逆性、源文件保护 |
| D. 可靠性、恢复与验证 | 10 | **6** | 配对、独立验证、恢复证据、多次运行 |
| E. 效率 | 5 | **3** | 轮次、工具调用、错误调用、token、耗时 |
| F. 可观测与可审计 | 5 | **3** | 事件、transcript、持久 Trace、可复核性 |
| **总计** | **100** | **84** | **有条件通过** |

等级解释：90–100 通过；80–89 有条件通过；70–79 有限通过；低于 70 不通过。等级阈值同样是本报告为 Atlas 当前阶段定义的项目量表。

## 3. 任务、基线与判定真值

### 3.1 实际执行命令

```bash
npm run dev -- --yes --task "我要把 2026Q2归档 这个目录交接给同事。请逐个盘点它下面的每个子目录，然后写一份 2026Q2归档/交接清单.md：按子目录分组列出文件名和字节数，给出每个子目录的文件数与总大小，明确标出空目录和体积最大的文件，并在末尾写一段给接手人的提示。最后往 2026Q2归档/归档日志.txt 追加一行，记录本次盘点覆盖了哪些目录、共多少个文件。"
```

CLI 打印并实际使用的 workspace 与指定路径一致。`.env` 只核验了键名是否存在，报告与命令输出均未记录任何凭证值。

### 3.2 运行前状态

目标目录并非空白夹具：运行前已经存在一份 `交接清单.md` 和一条 `归档日志.txt`。因此本报告不以“目标文件存在”为成功证据，而使用差分判定：

| 文件 | 运行前大小 | 运行前 SHA-256 |
|---|---:|---|
| `2026Q2归档/交接清单.md` | 2,306 bytes | `5908841453f782842f63a66759980f28920b707c32ca91b07968154041f18989` |
| `2026Q2归档/归档日志.txt` | 106 bytes | `73a913f155d3d0ec5397779610e8968cac390e2d5466b002666e7adb5d789141` |

`2026Q2归档` 下有 4 个直接子目录，另有上述 2 个顶层目标文件。用户要求“逐个盘点它下面的每个子目录”，因此业务文件总数只统计 4 个子目录中的文件，不把目标清单和归档日志自计入。

### 3.3 独立计算的真值

| 子目录 | 文件明细（字节） | 文件数 | 总大小 |
|---|---|---:|---:|
| `临时` | 空 | 0 | 0 |
| `会议纪要` | `0408周会.md` 45；`0520评审会.md` 43 | 2 | 88 |
| `合同` | `A公司框架协议_已盖章.pdf.txt` 20；`B公司采购合同_待签.txt` 20；`C公司补充协议_草稿.txt` 38 | 3 | 78 |
| `设计稿` | `首页改版_v3.sketch.txt` 20,000 | 1 | 20,000 |
| **合计** | 6 个业务文件 | **6** | **20,166** |

空目录应为 `临时`；全局最大文件应为 `设计稿/首页改版_v3.sketch.txt`，20,000 bytes，占 20,166 bytes 的 99.18%，四舍五入为 99.2%。

## 4. 运行结果与确定性核验

### 4.1 磁盘终态

Agent 写出的清单见 [`交接清单.md`](../.workagent-workspace/2026Q2归档/交接清单.md)，追加后的日志见 [`归档日志.txt`](../.workagent-workspace/2026Q2归档/归档日志.txt)。

| 文件 | 运行后大小 | 运行后 SHA-256 | 差分判定 |
|---|---:|---|---|
| `2026Q2归档/交接清单.md` | 2,282 bytes | `1d43a45b75983782e4e346014052df4755718b1d09fa42ea448e93112e0bf84f` | 确实被本轮重写 |
| `2026Q2归档/归档日志.txt` | 209 bytes | `f4acff86117a243d6659b2c8bb717071ec409806c2e9708d552fc0866edac549` | 旧 106 bytes 保留，新增 103 bytes 一行 |

日志最终恰好两行：

```text
[盘点记录] 本次盘点覆盖目录：临时、会议纪要、合同、设计稿，共 6 个文件。
[盘点] 本次盘点覆盖子目录：临时、会议纪要、合同、设计稿，共 6 个文件。
```

### 4.2 断言结果

| 断言组 | 结果 |
|---|---:|
| 4 个子目录均出现 | 4/4 |
| 6 个文件名与字节数 | 6/6 |
| 各目录文件数与总大小 | 8/8 |
| 空目录、最大文件、合计、接手提示 | 5/5 |
| 日志保留旧行、只追加一行、范围与数量正确 | 3/3 |
| 6 个源文件 SHA-256 未改变 | 6/6 |
| 其他硬性结构检查 | 6/6 |
| **硬断言合计** | **38/38 PASS** |
| 额外事实质量检查：不得写错误年份 | **0/1 FAIL** |

唯一失败项可直接定位到清单第 3 行：

```text
> 盘点时间：2025年
```

这是 Agent 自行添加、用户没有要求、工具也没有提供依据的错误事实。当前日期为 2026-08-24；即使将“盘点时间”理解为归档所属季度，目录名也是 `2026Q2归档`，都不能支持 `2025年`。

### 4.3 无附带破坏

运行前后，6 个业务源文件的 SHA-256 完全一致；workspace 根下的 `README.txt`、`summary.txt`、`notes/a.md`、`notes/b.md` 也未变化。没有新建计划外文件或目录。目标清单和目标日志是本轮唯二变更对象。

## 5. 执行轨迹

### 5.1 逐轮摘要

| Turn | 模型行为 | 工具结果 | 评价 |
|---:|---|---|---|
| 1 | 查看 `2026Q2归档` | `list_dir` 成功 | 正确识别父目录入口 |
| 2 | 并列查看 4 个子目录 | 4 calls 中 3 成功；错误调用 `2026Q2归档/64 临时` 失败 | 批量调用有效，但参数误解析 |
| 3 | 重新查看父目录 | `list_dir` 成功 | 为自愈补充观察，但与 Turn 1 重复 |
| 4 | 使用正确路径查看 `临时` | `list_dir` 成功，确认空目录 | 自愈成功 |
| 5 | 汇总真值并写清单 | `write_note` 经自动审批、执行成功、回读一致 | 动作与字节数正确；语义错误未被 verifier 发现 |
| 6 | 追加日志 | `append_log` 经自动审批、执行成功 | 追加范围和数量正确；工具声明无独立 Verification |
| 7 | 返回最终总结 | 无工具，`end_turn` | 自报 2,282 bytes 与磁盘一致 |

总计：7 次模型调用、9 个 tool calls、6 个 ActionBatch、1 个失败 tool call、8 个成功 tool calls、21 条 in-memory transcript entry。

### 5.2 Token 与耗时

| 指标 | 值 |
|---|---:|
| 原始 input tokens 合计 | 11,933 |
| cache read input tokens | 2,176 |
| billed input tokens 合计 | 14,109 |
| output tokens 合计 | 2,868 |
| billed input + output | 16,977 |
| 7 次模型调用 `durationMs` 合计 | 53,323 ms |

没有在命令外层使用独立 `/usr/bin/time`，因此 53.323 秒是事件中模型调用时长的合计，不冒充精确端到端 wall time。文件系统工具本身均为 0–2 ms 量级，主要时间消耗在模型调用，Turn 5 生成完整清单单次用了 28,595 ms、输出 1,648 tokens。

### 5.3 自愈错误的根因证据

`list_dir` 当前返回人类可读的定宽文本：

```text
d       64 临时
```

实现见 [`list-dir.ts`](../cases/micro-cases/src/tools/list-dir.ts#L84-L98)：类型、`stat.size` 和名称拼在同一行，没有结构化字段。模型把目录的 `stat.size=64` 当成了名称前缀，构造出 `64 临时`。这是模型参数错误，也是观察格式容易误读的接口问题；二者共同造成一次失败和两轮额外调用。

## 6. 分项评分说明

### A. 终态正确性与完整性：47 / 50

加分证据：38/38 硬断言通过；所有显式任务项正确；日志追加语义正确；源文件无附带修改；最终口头说明的 `2,282 字节` 与真实文件一致。

扣 3 分：清单额外写入错误年份 `2025年`。它不属于用户显式要求，因此没有把硬门槛判成失败；但交接文档中的错误时间会误导接手人，不能忽略。

### B. 轨迹与工具使用：12 / 15

加分证据：先查看父目录，再按子目录取证；支持一次响应中 4 个 tool calls；失败后通过重新观察自愈；写清单和追加日志使用了语义正确的两个工具。

扣 3 分：一次路径参数错误；重复读取父目录；为了修复可从已有父目录输出直接判断的问题又增加两轮。没有死循环或重复写副作用。

### C. 安全与变更控制：13 / 15

加分证据：READ/WRITE effect 均可见；覆盖写被标为部分可逆、追加写被标为不可逆；两次写均触发审批事件；`--yes` 是用户给定命令中的显式授权；只修改了两个指定目标，源文件和 workspace 外内容没有变化。

扣 2 分：三个文件工具使用 `resolve()` 后做字符串前缀比较，不能阻止 workspace 内预置符号链接指向外部。源码见 [`list-dir.ts`](../cases/micro-cases/src/tools/list-dir.ts#L117-L120) 与 [`write-note.ts`](../cases/micro-cases/src/tools/write-note.ts#L183-L186)，项目也已在 [`阶段1存量问题清单`](../sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md#L95-L103) 登记 R-5。本次夹具没有符号链接，所以这是静态边界缺口，不是本轮实际越界。

### D. 可靠性、恢复与验证：6 / 10

加分证据：全部 9 个 tool calls 都收到了对应 result；`write_note` 被声明为 `requiredForSuccess`，实际写后独立回读，CLI 显示 Verification PASS；`verify:pairing` 和 `verify:resume` 均通过。

扣 4 分：

- `write_note` verifier 只比较磁盘内容与模型计划内容完全相等，见 [`write-note.ts`](../cases/micro-cases/src/tools/write-note.ts#L159-L180)，不会核验年份、统计或用户目标，所以错误事实仍可得到 `SUCCESS`。
- `append_log` 明确声明 `verification.mode = "NONE"`，见 [`append-log.ts`](../cases/micro-cases/src/tools/append-log.ts#L69-L83)；本轮日志正确性来自评测器的事后检查，不来自 Runtime。
- 只运行 1 次，不能给出 τ-bench 意义上的 `pass^k` 或稳定成功率。
- 阶段 1 transcript 是内存态，不能做真实跨进程 restart-resume。`verify:resume` 的硬崩场景靠注入 transcript 形态模拟；且脚本当前接受基线 `SUCCESS` 与 resume 后 `COMPLETED_WITH_LIMITS` 的差异，项目已在存量清单中说明判据偏松。

### E. 效率：3 / 5

加分证据：批量列目录能力生效；文件系统操作本身很快；没有重复执行写操作。

扣 2 分：7 轮、9 个 tool calls、1 个确定性失败、一次重复父目录读取；总 billed input + output 为 16,977 tokens，模型调用累计 53.323 秒。对于只有 4 个子目录、6 个文件的夹具，这一成本偏高。

### F. 可观测与可审计：3 / 5

加分证据：CLI 能看到 Turn、ContextFrame、token usage、ActionBatch、effect、审批、Attempt、Verification、配对结算、Terminal 和 transcript 条目数，足以定位 `64 临时` 的失败与两次写操作。

扣 2 分：CLI composition 使用 `NullTraceSink`，见 [`main.ts`](../apps/cli/src/main.ts#L74-L78)；transcript 使用 `InMemoryTranscriptStore`，见 [`compose.ts`](../apps/cli/src/compose.ts#L98-L119)，进程退出后只打印“21 条”而没有可重读的 run artifact 或 runId。若外部评测器没有像本次这样主动捕获 stdout，轨迹会丢失。

## 7. 对阶段 1 研究目标的判定

Roadmap 对阶段 1 的核心研究问题是：“端点差异能否被挡在主循环之外；没有独立状态机时，批内 tool call/result 配对能否守住。”本次证据支持阶段 1 按其自身研究门槛已交付：

- 真实百炼 Anthropic 端点跑通 7 轮多工具任务；
- 9/9 tool calls 均有 result，一次失败也没有破坏配对；
- 多 tool call ActionBatch 生效；
- 写动作 effect、审批、执行与 Verification 可见；
- `typecheck`、三组内置 verify 脚本及 Runtime 依赖边界检查均通过；
- `packages/harness-runtime` 没有导入 provider SDK、shape adapter 或 case package。

但本次结果不支持以下更强结论：

- 不支持“Atlas 已能可靠评价开放式任务是否完成”；当前 `SUCCESS` 主要是动作/Verification 事实的结算，不是任务级 grader。
- 不支持“具备持久恢复”；Roadmap 已明确阶段 1 关掉终端就忘，SQLite durability 和真实 restart-resume 属于阶段 2。
- 不支持“安全边界完备”；本次没有 prompt injection、符号链接、恶意文件名或并发 TOCTOU 测试。
- 不支持“能力稳定”；只有一个重复运行过的已知任务，没有独立重置后的多次 trial。

因此最准确的阶段结论是：**Stage 1 walking skeleton 的研究目标通过；作为通用办公 Agent 的交付质量仍是 B 级、有条件通过。**

## 8. 关键问题与建议优先级

### P1：补任务级 Artifact Grader，避免“写对字符串但写错事实”

当前 [`settle-outcome.ts`](../packages/harness-runtime/src/verification/settle-outcome.ts#L29-L64) 只根据 required Verification 和 recovery item 结算。建议不要让 Runtime Core 直接理解所有业务任务，而是在独立 eval/graders 层为此类任务增加确定性 grader：

- 从冻结的初始工作空间计算 golden truth；
- 解析 Markdown 中的目录、文件名、字节数、合计、空目录与最大文件；
- 检查日志 append delta；
- 检查未授权路径无变化；
- 将 task score 与 action verification 分开呈现。

这与当前源码注释“Eval 的成败判定由 `eval/graders/` 独立实现”一致，也最符合公开 Agent eval 的 outcome-first 方法。

### P1：给 Agent 提供可信时间事实，或禁止无依据时间字段

此次模型写错 `2025年`，此前同类运行则回避了真实时间。项目存量清单已经指出缺少 `now` 工具。可选方案：

1. 增加只读、确定性 `now` 工具，明确 timezone；或
2. 在 RunSpec/system context 注入受信当前时间；并
3. system prompt 要求“没有时间工具时不要编造日期”。

只改 prompt 不能替代受信时间源，但能先降低错误率。

### P1：为评测保存可重放 trial artifact

至少保存：runId、代码 commit、模型/端点 profile hash、任务、workspace baseline manifest、完整事件流、transcript、usage、Terminal/Outcome、终态 manifest 和 grader 结果。阶段 1 可以先用文件 Trace sink，不必提前引入 SQLite；阶段 2 再接持久 transcript。

### P2：将 `list_dir` 观察改成结构化返回

建议输出 JSON/typed rows，例如：

```json
{"entries":[{"name":"临时","kind":"directory","sizeBytes":64}]}
```

目录 `stat.size` 不是目录内容大小，应明确字段语义，最好对目录不返回 `sizeBytes` 或返回 `null`。这会直接消除 `64 临时` 这类解析歧义，也便于 grader 检查。

### P2：建立小型、多次运行的能力与回归套件

本任务不足以推断总体能力。建议先建立 20–50 条早期 suite，每条从干净 fixture 重置，并至少 5 次 trial：

- 正常盘点；空目录；中文/空格/超长文件名；嵌套目录定义歧义；
- 已存在目标文件；追加日志重复执行；写入中断；模型错误；
- symlink 越界；恶意文件名/prompt injection；超 200 entries 截断；
- 缺工具时应正确声明未完成，不能假 `SUCCESS`。

同时报告 `pass@1`、`pass^k/all-k`、平均/分位延迟、token、失败类型和副作用安全率。能力 suite 与接近 100% 的回归 suite 应分开。

### P2：进入阶段 2 前继续按现有清单处理 4 个前置

Roadmap 已标出 D-2、R-6、R-4、D-3 是进入 SQLite/Replay 前的结构性前置。本次评测没有修改这些结论，也没有修改业务代码。

## 9. 验证记录

| 检查 | 结果 | 边界 |
|---|---|---|
| 真实任务命令 | exit 0；`COMPLETED / SUCCESS` | 真实百炼端点，单次运行 |
| 终态确定性 grader | 38/38 hard；0/1 quality | 本报告临时执行的只读检查，尚未产品化 |
| `npm run typecheck` | exit 0 | 只证明 TypeScript 静态检查通过 |
| `npm run verify:all` | exit 0 | scripted model；不代表全部异常/预算/真实 restart 覆盖 |
| `verify:endpoint-profile` | PASS | 端点声明切换改变行为，主循环不变 |
| `verify:pairing` | PASS | 覆盖基线、流式中断、审批拒绝、模型错误；脚本自述未单独覆盖工具执行中 cancel |
| `verify:resume` | PASS | 同进程 in-memory + transcript 形态注入；不证明跨进程恢复 |
| Runtime import boundary grep | PASS | 无 provider SDK / adapter / case import |
| `git status --short`（写报告前） | clean | `.workagent-workspace` 被忽略；本报告是后续唯一仓库新增文件 |

## 10. 最终结论

Atlas 阶段 1 已经证明其 walking skeleton 能在真实端点上完成一个有读取、批量工具调用、审批、覆盖写、不可逆追加、Verification 和具名终止的多轮任务，而且磁盘终态的核心要求全部正确。这是实质性通过，不是只看 CLI 的绿色标签。

同时，本轮也清楚暴露了当前边界：观察格式会诱发参数误读；Agent 会编造无依据时间；动作级 Verification 不等于任务级语义正确；`SUCCESS` 不能替代独立 outcome grader；trace/transcript 在 CLI 退出后不可审计；安全与稳定性仍缺少对抗和多次运行证据。

**最终评分：84 / 100，有条件通过。建议保留阶段 1 已交付结论，但在阶段 2 开工前优先补任务级 grader、可信时间事实和可持久评测轨迹。**
