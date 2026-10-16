# ADR-0019：任务级完成契约（S5-7）—— 重开「不加通用 Completion Gate」

- 日期：2026-10-16
- 状态：**已实施（B ＋ C ＋ CG-4，2026-10-16），待用户复核**。A 暂缓、D 不单独做，均照推荐。
  实施是在用户给验收批的目标「完成所有事项的开发」下做的，**不是用户逐条拍板**；结论与回退方式见文末「实施与结果」。
- 重开的决定：
  - 阶段 3 实施方案 §0.3「不加通用 Completion Gate，留评测阶段判定」（CLAUDE.md 压缩成了「论据被探针推翻」）；
  - [ADR-0001](历史归档/0001-outcome-kind-不区分是谁没做成.md) 接受的代价「模型声称做不了仍结算 `SUCCESS`」；
  - V05 §10.4【定】拒绝声明式验收的三条理由（`settle-outcome.ts` 文件头原样保留着它们）。
- 关联：[ADR-0008](历史归档/0008-ask-user-与-request-handoff-是两个洞.md)（handoff 没人接＝那件事真的没做）、
  [ADR-0010](历史归档/0010-二进制交付物走字节通道与按路径声明.md)（产物按路径声明、旧文件不得冒认）、
  [ADR-0013](历史归档/0013-本机-computer-use-图像进模型轨道与自建-Swift-助手.md) CU-9、
  [ADR-0014](历史归档/0014-观察过期不计失败与只读外部状态不判打转.md)、
  [ADR-0018](历史归档/0018-带上传的断网云沙箱调用经显式信任声明放行.md)（「悄悄降级成心算」）
- 存量编号：S5-7（同族 S3-27 / S5-5 / CU-9）

> 文件放在 `ADR/` 根下而不是 `历史归档/`：它是待决的，还不是历史。拍板后按惯例挪过去。

---

## Problem

`outcome.kind` 现在只按事实表结算：必需验证、产物检查、状态未知的副作用。循环在「模型不再请求工具」时终止。
**「用户要的那件事做没做成」这个问题，事实表里没有一行回答它。** 于是出现三种 `SUCCESS`：

1. 交付物写对了，但模型没声明，第二层检查一项没跑。`SUCCESS` 碰巧是真的，只是**没有任何事实撑着它**；
2. 事情没做成，模型自己在总结里说了没做成，结算仍是 `SUCCESS`。这时 `SUCCESS` **是假的**；
3. 结果数值对，但用户**显式要求的做法**没做到（「在云沙箱里用 pandas」变成了手工累加），模型自己说了，结算仍是 `SUCCESS`。

**为什么现在必须决：**

- 引导面已经用到头了。2026-10-16 改完 system prompt 与 `write_file` description 之后，live 仍有漏声明（见证据 E1、E2）。
  CLAUDE.md 与验收报告都写着「根治是 S5-7，要 ADR 不要补丁」，再修一次引导面就是在绕开这条登记。
- 第 2、3 类发生在仓里**明说为无人值守设计**的入口上（非 TTY 的 CLI，见下文「重评触发条件核对」）。
  在那里 `SUCCESS` 后面没有人去读 summary。
- 当初的处置是「推到评测阶段判定」，现在评测已经跑过（`eval:suite --live 5`）。挂着的判定该判了。

**可以推迟吗？** 只要 Atlas 始终是「人在屏幕前看输出」，可以推迟，ADR-0001 也是按这个前提接受代价的。
但这个前提已经有一处不成立了（非 TTY CLI），所以本 ADR 至少要把「推迟」写成一个**有名字的选项**（候选 D），而不是默认。

---

## 证据（逐条回源）

### E1　交付物声明率：引导面改完仍漏

| | live 任务数 | 声明并登记了 DELIVERABLE |
|---|---|---|
| 改前（`verify:scenarios --live` 两轮） | 6 | 3 |
| 改后（五轮） | 15 | 14 |

出处：[验收报告](../验收报告/2026-10-16-Atlas集成fcsandbox全量验收报告.md) §2 R5、§4.1（第 3 轮「任务 C 漏声明（引导面的残差）」）。
漏声明的后果原文：「文件写对了，但第二层 Artifact 检查一项都没跑，`deliveredArtifactIds` 为空，**Run 照样结算 SUCCESS**」。
改动在提交 `810c166`（`apps/cli/src/compose.ts` 收尾段 ＋ `tools/common/src/fs/write-file.ts` 1.1.1）。

### E2　起草本 ADR 时回源发现：eval 任务上声明率更低，而报告没把它算进去

报告 R5 那个「14/15」只数了 `verify:scenarios`。同一批的 `eval:suite --live 5` 也有漏声明，只是 grader 与 Runtime 都没把它报出来：

| 批次（`.workagent-eval/…`） | grader | 没有任何 DELIVERABLE 的 trial | 这几个 trial 的 grader / Runtime |
|---|---|---|---|
| `2026-10-16T10-30-23-178Z` | 1.0.1 | **trial 2（`run_26e5d1cda093`）、trial 4（`run_88e0809fc22d`）** | PASS 26/26 ／ `SUCCESS` |
| `2026-10-16T10-18-26-487Z` | 1.0.0 | trial 1（`run_d06065c558b9`） | PASS ／ `SUCCESS` |

出处：各 trial 的 `trial-N.jsonl` 里 `LoopTerminated.outcome.deliveredArtifactIds` 为 `[]`，trial 2 的 trace 里有一次写 `2026Q2归档/交接清单.md` 的 `write_file`。

时序要说清楚，因为它决定这几条算不算「改后」：

- `/tmp/atlas-acceptance/` 的日志时间显示，R5 之后第一轮复跑（`live-scenarios-fix1.log`）18:15:25 结束，
  R5＋R6 之后的第 3 轮（`fix3`）18:19:45 结束。1.0.1 那批 18:30:23 开跑，**肯定在 R5 之后**。
- 1.0.0 那批 18:18:26 开跑，按日志时间也在 R5 之后；但报告 R7 写的是「两批中间夹着 R5 的 prompt 改动」。
  trace 不记工具版本，我**裁决不了**这两种说法，所以只把 1.0.1 那批算进「改后」。

合起来，R5 之后两个仪器上的 live 声明率是 **14/15 ＋ 3/5 ＝ 17/20（85%）**，不是 93%。
另外 1.0.1 那批里 grader 判 PASS 的 5 个 trial，有 2 个 **Atlas 从来没检查过交付物**。grader 只判清单内容，不判有没有登记，所以这件事不会出现在 pass@1 里。

### E3　`run_8fc75ecea093`：方法违约，自己说了，仍 `SUCCESS`

出处：验收报告 §4.6 第二行；trace `/tmp/atlas-acceptance/ws-cloud-off/.workagent/runs/run_8fc75ecea093.jsonl`；终端 `live-cli-cloud-off.log`。

- 任务原文：「请**在云沙箱里用 pandas** 按 region 汇总 amount 的合计……」。用的是 200 行数据，规模故意大到心算不现实（报告 §4.6）。
- `cloud_shell` 与本机 `run_shell` 各被拒一次。`ApprovalDecided` 两条都是 `approved:false, decidedBy:"UNDECLARED"`，
  理由「非交互环境下无人应答，按拒绝处置」。
- 模型「通读 CSV 全部 200 行、手工按 region 累加」。总结里原话写了「**pandas 没有真正跑起来**」「数值是我……**手工累加**得出的，不是 pandas 输出」。
- `region_totals.json` 声明为 DELIVERABLE 并通过 JSON 检查。`outcome = SUCCESS`，`incompleteItems = []`。

### E4　`run_27dc9813e231`：同一道题守约完成，**也有一次被拒，也写了「未做到」**（E3 的天然对照）

出处：验收报告 §4.6 第一行；trace `/tmp/atlas-acceptance/ws-cloud-on/.workagent/runs/run_27dc9813e231.jsonl`；`live-cli-cloud-on.log`。

- 信任声明开着，`cloud_shell` 记 `AUTO_GRANT`，在云沙箱里真的用了 pandas，结果与真值逐字一致。
- 随后本机 `run_shell`（awk 第三次复核）被拒，记 `decidedBy:"UNDECLARED"`，与 E3 那两次完全同形。
- 总结里有一段「**未做到的一点**：我本想在本地再用 awk 做第三次独立复核，该命令未获审批……这不影响结论」。
  它来自 system prompt 收尾段「说明你做了什么、以及**有哪些没做到**」（`compose.ts:1483`）。
- `outcome = SUCCESS`。这是对的。

**E3 与 E4 放在一起是本 ADR 最有判别力的一组样本。** 两者都有一次被拒的审批，总结里也都有「没做到」。
区别只有一条：没做到的是**用户显式要求的**，还是**模型自己加的**。凡是分不出这一点的候选，都会把其中一个判错。

### E5　ADR-0018 那次 live：同形，6 行数据

出处：[ADR-0018](历史归档/0018-带上传的断网云沙箱调用经显式信任声明放行.md)「实测里冒出来的一条：未声明时模型会悄悄降级成心算」；CLAUDE.md:57–61。
`cloud_shell` 被拒三次，模型「退回 read_file ＋ 心算 ＋ write_file」，Run 照样 `SUCCESS`。

### E6　`run_73db9f5de54f`（computer use）：没做成，自己说了，请人接管没人接，仍 `SUCCESS`

出处：[changelog 2026-10-03](../changelog/2026-10-03-Atlas集成ComputerUse.md) §8 第 3 行、§11；ADR-0014「之后两次真桌面运行」表第 3 行；
CLAUDE.md:389；trace `.workagent-workspace/.workagent/runs/run_73db9f5de54f.jsonl`。

- 任务两步：计算器算 37×24，再在文本编辑里输入结果。计算器那步做成了，键盘输入一律 `TOOL_GUI_TARGET_DENIED`（B4 前台陈旧，后来修了）。
- 模型调了 `request_handoff`，`InteractionCompleted` 记 `answered:false`。
- 总结原话：「**没能把那行文字输入进去**……所以文档里目前是空的」。
- `outcome = SUCCESS`，`deliveredArtifactIds = []`，`incompleteItems = []`。

### E7　ADR-0001 的起点（2026-08-24）

工具集里没有任何网络能力，模型列了一遍工具就拒绝了任务，一个写工具都没调。结果 `Terminal: COMPLETED / Outcome: SUCCESS`。
出处：ADR-0001 Problem 段。

### E8　反向证据：模型**没有**「以为做完了」

- `eval:suite --live 5`（grader 1.0.1）：5/5 PASS，「Runtime 自报与 grader 一致 5/5」（验收报告 §4.2；`live-eval-suite-fix.log`）。
- E3、E6、E7 三次，模型都**如实说了**没做到。

### 证据归类

| 类 | 样本 | Runtime 的 `SUCCESS` | 模型自己说了吗 | 事实表里有没有对应的事实 |
|---|---|---|---|---|
| ① 做对了、没登记 | E1（1/15）、E2（2/5，另有 1/5 时序存疑） | 碰巧为真，**无事实支撑** | 没说（它不知道自己漏了） | **有**：成功的 `write_file` ＋ 零 DELIVERABLE |
| ② 没做成、自己说了 | E6、E7 | **假** | 说了（只在 summary 里） | E6 **有**：未被应答的 `request_handoff`；E7 没有 |
| ③ 结果对、方法违约、自己说了 | E3、E5 | 结果真、**契约未满足** | 说了 | **没有可区分的事实**：被拒的审批在守约的 E4 里同样存在 |

**一句话：新证据里没有一条是「模型以为做完了」，说假话的是结算层。**
第 ②③ 类里，信息在 summary 中已经有了，只是以自然语言的形式存在。第 ① 类里，事实已经在事实表里了，但结算时被丢掉。

样本量要老实说：② 类 2 个，③ 类 2 个，① 类 3–4 个。这里每一条都只是「形态存在」的证据，**没有一条能当比率**。

---

## 当初推翻的到底是哪个论据

### 链条（全部回源）

1. **主张方**：阶段 3 评审 pi「维度 1」（`方案评审/2026-08-28/阶段3评审-pi.md`，已在 `2c453b0` 删除，`git show 2c453b0^:<路径>` 可取回）。
   它的核心论据是：阶段 2 回归评测 Trial 1「漏掉了用户显式要求的总字节数 `20223`」，说明模型「容易在生成最终总结时产生
   **认知盲区**或**伪完成感知**」。所以 Harness 必须「在模型意图结束前驱动一个受控的**通用自检思考步**（Self-Verification Loop / Completion Gate）」。
2. **探针**：`probe:requirement-extraction`（`apps/cli/src/verify/requirement-extraction.ts`；原始输出
   `WorkAgent调研/探针记录/probe-requirement-extraction_20260828.md` 已在 `2c453b0` 删除，同法取回）。结果是：
   - 任务原文写的是「给出**每个子目录的**文件数与总大小」，全局合计字节数**原文从未出现**，grader 却硬查了它；
   - 中性抽取提示下，原文抽出「全局合计」0/5，加一句显式要求后 5/5，「每个子目录的总大小」5/5；
   - 单端点（百炼 qwen3.7-plus；当时 DeepSeek 401）。
3. **决定**：阶段 3 实施方案 §0.3（`实施方案设计/阶段3实施方案_V20260828-02.md`，已删，同法取回）原文是：
   > 不加通用 Completion Gate（评审 pi 维度 1 的核心论据即这次失败，前提已倒）。它还会改动 §10.4【定】的循环终止条件，
   > 需独立 ADR，且判别力未经测量。**留评测阶段判定**
   
   Roadmap §5、存量清单「明确不做」表（「推到评测判定」）、回归评测报告 §5.1 口径更正都是同一句话的副本。
   CLAUDE.md:1320 与 V05:2759 把它压缩成「通用 Completion Gate（论据被探针推翻）」。

### 推翻的是什么

推翻的是**一个样本的归因**：Trial 1 是 grader 误判，不是模型漏了要求。
由此倒掉的是「模型会漏掉显式要求／有伪完成感知」这条**经验前提**。

### 没推翻的是什么

| | 出处 |
|---|---|
| 机制本身可不可行。探针结论边界第 2 条原文：「**不证明**『Completion Gate 这个机制整体可行』—— 第二步（拿清单对照产物）没有测」。反过来，它**证明了第一步可行**：中性提示能稳定地区分「原文要求的」与「原文没要求的」（0/5 对 5/5） | 探针记录「结论的边界」 |
| §0.3 另两条理由：会改动 §10.4 的循环终止条件；判别力未经测量 | 阶段 3 实施方案 §0.3 |
| §10.4 拒绝声明式验收的三条理由，以及 ADR-0001 否决 `MODEL_DECLINED` 的理由（结算一旦读模型的话，就成了 Run 给自己打分，违反不变量 12） | V05 §10.4；`settle-outcome.ts:8`、`:120`；ADR-0001 方案 B |
| 状态：当初是「**推到评测判定**」，不是「不做」。压缩成「论据被探针推翻」时，这层意思丢了 | 存量清单「明确不做」表 |

### 新证据碰没碰到它

**没碰到，而且进一步削弱了它。** pi 主张的前提是「模型以为做完了」，E3、E6、E7、E8 说的都是相反的情况。
所以 pi 那种「强制自检轮」（下文否决的 F）**仍然没有证据**。

新证据支持的是**另一个论据**：**结算层丢掉了它手里已经有的信息。**

- 第 ① 类和 E6：事实已经在表里（未声明的写入、未被应答的接管），结算时没看。§10.4 自己的底线写着「结算时忽略它，等于花钱测出一个事实然后扔掉」，这里两条都犯了。
  ADR-0008 对 handoff 的定义更直接：没人接＝「**那件事真的没做**」。Runtime 把这件事记了下来，然后结算成 `SUCCESS`。
- 第 ②③ 类：模型已经如实说了，只是说在自然语言里。这正是 ADR-0001 接受的那条代价：「**人能看到，机器判不出**」。

### 重评触发条件核对

V05 §10.4「什么情况下需要加一层【验】」与 ADR-0001「重新评估的触发条件」，三条逐条对照：

| 触发条件 | 现状 | 判定 |
|---|---|---|
| 1. 无人值守运行（定时任务、自动化触发），没人看输出 | 非 TTY 的 CLI 是仓里**明说**的无人值守入口（CLAUDE.md：「无人值守跑批不要用 Web 入口，用 CLI —— 那里的非交互降级是为它设计的」），E3、E6 都跑在这条路径上，E3 的降级就是「没人在」直接造成的。但还没有定时器或自动化去**消费** `outcome.kind`，连 CLI 退出码都不看它（`main.ts` 只在找不到 Run 或抛错时置 `exitCode = 1`） | **部分触及** |
| 2. Eval 显示「grader 判 FAIL 而 Runtime 自报 SUCCESS」超过 10% | 1.0.1：0/5。1.0.0 那 3/5 全是 grader 漏判（验收报告 R7）。⚠️ 指标本身不分方向：`(runtimeOutcome === "SUCCESS") === grader.hardPassed`（`eval/suite/index.ts:400`） | 未触发 |
| 3. 某个 Case 的交付物有明确、静态、与用户输入无关的结构约束 | 无 | 未触发 |

---

## Hypothesis（做决策时的认知状态）

**已知：**

- 结算现在只有四个降级源：必需验证（`requiredForSuccess`）、产物检查、RecoveryItem、全部是用户拒绝时的 `USER_REJECTED`。
  `cloud_shell`、`run_shell`、`computer`、`request_handoff` 全部是 `requiredForSuccess: false`
  （`tools/cloud-sandbox/src/definitions.ts:140`、`tools/common/src/exec/run-shell.ts:295`、`tools/computer/src/definitions.ts:103/179`、
  `tools/common/src/mech/request-handoff.ts:124`）。所以 E3、E6 里被拒的 EXECUTE、没人接的 handoff，**结构上不可能**让 Run 降级。
- `edit_file` 不收 `artifact_role`（全仓只有 `write_file` / `run_shell` / `cloud_shell` / `materialize_resource` 收）。
  只靠修改文件交付的任务，**根本无法声明交付物**。
- 结算已经在消费**模型的结构化声明**：`artifact_role` 由模型填，DELIVERABLE 检查失败就判 `FAILED`。
  不变量 12 实际划的线是「不解析模型的自然语言」，而不是「不消费任何来自模型的数据」。

**不知道：**

- 给模型一个结构化的「我没做到 X」通道，它会不会用（`request_handoff` 先例：引导面修好之前，五次尝试零调用，见 `request-handoff.ts` 文件头）。
- 它会不会**过度声明**。E4 已经证明，现在的收尾提示会让模型把「我自己想加的复核没跑」也写成「未做到」。
- qwen3.8-flash 在循环里、收尾时能不能分清「用户显式要求的」与「我自己加的」。探针测的是 qwen3.7-plus、独立的抽取提示、不在循环里。
- 第 ① 类事实规则在**正确的** Run 上会触发多少次。目前唯一的估计是 E1＋E2 的 3/20，样本小。

---

## Alternatives（候选）

先看证据覆盖面：

| 候选 | E1/E2 ① | E6 ② | E7 ② | E3/E5 ③ | 守约的 E4 会不会被误判 |
|---|---|---|---|---|---|
| A. RunSpec 交付契约 | ✓（要入口填了） | ✗ | ✓（要入口填了） | ✗ | 不会 |
| B. 结算吸收已有的两条事实 | ✓ | ✓ | ✗ | ✗ | 不会 |
| C. 收尾结构化声明未满足的显式要求 | ✗ | ✓ | ✓ | ✓ | **可能**（过度声明）【验】 |
| D. 维持现状，只把依据有多薄投影出来 | 只给人看 | 只给人看 | 只给人看 | 只给人看 | 不会 |

### A. RunSpec 声明交付契约（入口显式填写）

**判据。** RunSpec 冻结一个**可选的**相对路径列表 `expectedDeliverables`，由入口填写：CLI `--deliverable <path>`、界面「新任务」栏、eval / scenarios harness。
结算时，每条路径都要有一个「最终版本、role=DELIVERABLE、检查通过」的产物。缺一条就判 `COMPLETED_WITH_LIMITS`，
加一条具名 incompleteItem：「契约要求交付 X，没有登记或没有通过检查」。**不填时行为与今天完全一样。**

子选项 **A2**：模型写了契约路径却没声明时，结算代为登记并检查。这会碰 §17 语义 1
（`packages/harness-runtime/src/ports/index.ts:576`「由工具显式产出后登记，**不由 Runtime 扫 workspace 自动派生**」）。
严格说它不是「扫」，读的是一条用户声明过的路径。但它仍然需要 ADR-0010 H4 那道「执行前 `mtimeMs + size` 快照」，
否则用户事先放在那里的旧文件会被冒认成本 Run 的交付。

**会不会误判正确的 Run。** 用户填的路径与模型的合理选择对不上（改了文件名、放进子目录）时会误判。只在填了契约时发生。

**与「只查事实表」的【定】。** 不冲突：结算只读冻结的 RunSpec 和产物事实。
但它直接撞上两处已拍板的话：ADR-0001 否决的方案 C（Run 级必需操作清单），以及 V05 §10.4「形态应当是 Case Package 里注册的检查器，**而不是 RunSpec 上的必填字段**」。
**可以辩护的一点**：V05 §7 的 RunSpec 判据是「**逐 Run 变化的进 RunSpec**」（V05:513）。§10.4 反对的是把逐 Case 的**规则**放进 RunSpec，
而用户点名的那个文件名恰恰是逐 Run 变化的，按 §7 自己的判据它就该在 RunSpec 里。**辩护不了的一点**：§10.4 理由 1「这个信息不存在」依然成立，
除非用户自己把它结构化地交出来。A 没有消掉这个成本，只是把它转给了用户。

**对 eval 与 `verify:scenarios`。** eval 的夹具本来就知道期望产物，可以直接填。填了以后，E2 的 trial 2、4 在 A 下变成 `COMPLETED_WITH_LIMITS`，
在 A2 下变成「检查过的 `SUCCESS`」。scenarios 的 `artifactPath` 也可以直接填。grader 不读 outcome（V05 §24.1【定】），pass@1 不受影响。

**代价。**

- 两个入口各多一个参数（「未知参数一律报错」的纪律照旧，CLI 与 `POST /api/runs` 共用一个校验）。
- RunSpec 的 schema 变了。没有 migration，只能删库重建。
- 契约随 RunSpec 冻结，resume 读冻结的那份（与 budgets 同理，不需要新闸门）。
- **今天唯一会填它的，是测量装置**（eval / scenarios）。这正是本仓反复拒绝的「能力面被测量需求反向定义」：`write_file` 那条 `isIdempotent` 的【定】、决 6 都是这个形态。

**何时会后悔。** 做完以后发现真实任务里没人填它，字段零生产者。本仓清理过三十多个「先声明着，将来会用」的字段，就是这个下场。

### B. 结算吸收事实表里已有、却被丢掉的两条事实（零新输入）

**判据：**

- **B1**：本 Run 至少有一次成功的 `write_file` **没带** `artifact_role`，而且最终连一个 DELIVERABLE（含检查失败的）都没有，
  那么最高只能判 `COMPLETED_WITH_LIMITS`。incompleteItem 写成：「写了 `a.md`、`b.md`，没有一份声明为交付物：第二层检查没有运行」。
  只声明过 INTERMEDIATE 的写入**不算**未声明（见【议】CG-1）。
  这条规则只看 `write_file`，不看 `materialize_resource`，理由是实测。两次正确完成的 GUI 运行都物化过截图或抓取结果：
  `run_800091ccaf65` 的 `_shot_calc.png`、`run_536c62856c99` 的 `.tmp/bili_search.md`，两者都登记成 INTERMEDIATE、零 DELIVERABLE
  （trace 在 `.workagent-workspace/.workagent/runs/`）。
- **B2**：本 Run 有一次 `request_handoff` 以 `TOOL_HANDOFF_UNANSWERED` 或 `TOOL_HANDOFF_NO_CHANNEL` 结束
  （`request-handoff.ts:170/196`），而且之后没有一次被应答的接管，那么判 `COMPLETED_WITH_LIMITS`，incompleteItem 引用那次调用的 `expected_completion`。
  依据是 ADR-0008 的定义（没人接＝失败，「那件事真的没做」）。`expected_completion` 是**必填**的结构化字段，模型在那里亲口声明了「完成条件」是什么。

**实现形态。** 两条事实都在 `settle-batch` 里产生，与 `artifactChecks` 同一个收集点。它们必须写进 `persistFacts()` 每轮整体重写的 RUN_META。
「漏写一个字段＝整个 Run 的累计量被抹掉」那条坑（CLAUDE.md「改验收脚本前必读」）在这里同样适用。
`requiredForSuccess` 的语义不动，循环终止条件不动，不登记任何产物。

**被否决的变体 B0：「`deliveredArtifactIds` 为空一律降级」。** 它会误判三整类正确的 Run：

- 纯问答；
- 只做 GUI 的任务：`run_800091ccaf65`（文本编辑，不保存）、`run_536c62856c99`（Chrome 搜 B 站）都正确完成，都零文件；
- 只用 `edit_file` 的修改任务：这个工具**根本不收** `artifact_role`。

结果是 `COMPLETED_WITH_LIMITS` 成了这几类任务的默认值，也就是 MCP execute 档那条教训：「降级信号变成一盏永远亮着的灯」。
CU-9 的候选「GUI 任务默认 `COMPLETED_WITH_LIMITS`」是 B0 的子集，代价相同。

**会不会误判正确的 Run。会，而且要说出口：** E1、E2 里被 B1 抓到的那几次，**交付物全都是对的**。
给它们打 `COMPLETED_WITH_LIMITS` 说的是「Atlas 没有检查过交付物」，这句话是真的，但它把这个 kind 的含义从「有东西**没达成**」扩成了「有东西没达成**或没核实**」（见【议】CG-2）。
按 E1＋E2 估，R5 之后大约每 7 次 live Run 有 1 次会因此降级。其他已知的误判与盲区：

- 修改任务用 `edit_file` 交付、顺手 `write_file` 了一个草稿，B1 会触发，尽管真正的交付是那次 edit；
- `run_shell` / `cloud_shell` 不带 `artifact_path` 产出的文件，事实表里**没有路径**，B1 看不见（盲区，不是误判）；
- B2：handoff 没人接，模型后来自己绕过去做成了，B2 会误判。目前没有样本。

**与「只查事实表」的【定】。** **完全在内。** 不读自然语言，不改终止条件，不进 RunSpec，不碰 ADR-0001 对 `MODEL_DECLINED` 的否决，不碰 §17 语义 1。
要改的只有一句已经不准的话：V05 §15.2（V05:1727）说 `requiredForSuccess`「是**唯一一个**能把 SUCCESS 降级为 COMPLETED_WITH_LIMITS 的信号」。
产物检查和 RecoveryItem 早就是降级源了，B 再加两个。

**对 eval 与 verify 的影响（都是预期变更，不是回归，与 ADR-0001 当初翻 `verify:pairing` 期望值同性质）：**

- 脚本化 eval 夹具写 `交接清单.md` 时**不带** `artifact_role`（`eval/suite/index.ts:172`，这个夹具停留在 R5 之前的模型行为上），
  B1 会在 3 个 trial 上全部触发，「一致」从 3/3 掉到 0/3。要么先改夹具，要么先拆指标。
- live 1.0.1 那批，按现在的指标「一致」会从 5/5 变成 3/5。**指标不分方向**，B 制造的是「Runtime 偏严」，而 ADR-0001 触发条件 2 盯的是「Runtime 偏宽」。
  不论选哪个候选，都要先把它拆成两个数（【议】CG-4）。
- `verify:pairing` 基线（`CALLS_3` 里的 `write_file a.txt` 没带 role，`expectOutcome: "SUCCESS"`，`pairing.ts:130–165`）
  与 `verify:ui` D3 段（`kind === "SUCCESS"`，`ui.ts:820`）的夹具要跟着改。
- `verify:scenarios`：脚本化轮次都声明了 DELIVERABLE，不受影响。live 的「存在性」层本来就要求有登记的 DELIVERABLE，判定不变，
  变的只是 outcome 第一次和 scenarios 的判定说同一句话。
- 新判据都要**成对**：未声明→降级 ↔ 声明了→`SUCCESS` ↔ 只声明 INTERMEDIATE→`SUCCESS`；没人接→降级 ↔ 接了→`SUCCESS`。每条都要做注入实测。

**代价：** `COMPLETED_WITH_LIMITS` 的语义变宽了；声明率上不去之前，约 15% 的正确 live Run 会被降级；对 `edit_file` 交付与 EXECUTE 产出是盲的；**对第 ③ 类完全无效**。

**何时会后悔。** 声明率一直停在 85% 左右，用户学会了无视 `COMPLETED_WITH_LIMITS`。缓解办法是 incompleteItem 措辞写死、可区分，但缓解不了全部。

### C. 收尾时结构化声明「用户显式要求而未满足」的事项（只降不升）

**判据。** 新增一个机制工具（暂名 `declare_unmet`），每一项包含 `requirement`（引用任务原文里那句要求）、`status`（`NOT_DONE` / `DONE_DIFFERENTLY`）、`why`。
Runtime 在调用发生的那一刻记下 `ModelDeclaredUnmet` 事实，与 `unmetCause`「在事情发生的那一刻写下」是同一条纪律（ADR-0001 决定理由 2）。
结算时有任何一项就判 `COMPLETED_WITH_LIMITS`，incompleteItems 标明来源是模型声明。
**它只能降、不能升**：不覆盖 `FAILED`，不改变 RecoveryItem 的优先级，也产出不了 `SUCCESS`。

system prompt 收尾段要同步改：「用户明确要求而没做到的，调 `declare_unmet`；你自己额外想做而没做的，写在总结里就行」。
现在那句「有哪些没做到」（`compose.ts:1483`）不分这两类，E4 的那段过度表述就是它引出来的。
这个工具的 description 要与 `ask_user` / `request_handoff` 成对写（ADR-0008 的纪律）。

为什么是工具而不是「最后一条消息里的结构化字段」：理由与 `request_handoff` 存在的理由相同，「模型表达这个意图的唯一途径就是工具调用」（`request-handoff.ts` 文件头）。

**会不会误判正确的 Run。可能，而且已经有现成的样本：E4。** 如果模型把「awk 第三次复核没跑」也声明进来，一个守约的 Run 会被降级。
分清这两类，需要的正是探针测过的那种判别力（原文抽出 0/5、显式要求抽出 5/5）。
但那次是 qwen3.7-plus、独立提示、不在循环里，所以是【验】，不是【定】。
反方向的风险是不声明，结果与今天一样，不会更糟。

**与「只查事实表」的【定】。这是要重开的地方。** ADR-0001 否决 `MODEL_DECLINED`，是因为它要求「判断模型的话语意图」。C 不解析任何文本，理由有三：

1. 声明是结构化的、发生时就记下；
2. 已有先例：`artifact_role`（模型填、驱动 `FAILED`）、`request_handoff`（模型声明需求）；
3. 事实表里记的是「**模型声明了** X 未满足」，这是一句关于这次 Run 的真话，不是「X 未满足」。
   与 `decidedBy: "UNDECLARED"`、`dataMovement` 写「无法解析」是同一种如实。

而且它**不对称**：被测对象只能给自己扣分，不能加分，所以「给自己打分」那条担忧只剩一半。
但模型的自报确实进了 `kind`，**不变量 12 的措辞要改**（「结算依据来自事实表；模型的结构化声明可以是事实，自然语言不是」），ADR-0001 要被部分取代。
V05 §24.1「Eval 不复用 outcome」不受影响，grader 照旧独立。

**对 eval 与 `verify:scenarios`。** grader 不受影响。模型在 grader 判 PASS 的 Run 上声明了未满足项，会制造「Runtime 偏严」的不一致，同样需要 CG-4 拆指标。
scenarios 的脚本化模型从不调它，不受影响。R6 刚确认过机制工具「过不了三场景常用这一关不是问题」（`commonMechanismTools` 的【定】），所以新工具不会被已拆除的第 ③ 项误报。
固定开销多一个工具，每请求约 +180 token（`fixedOverheadTokens()` ＝ 工具数 × 180）。新判据要成对：声明了→降级 ↔ 没声明→不变 ↔ 已 `FAILED` 的 Run 声明后仍是 `FAILED` ↔ 声明产出不了 `SUCCESS`。

**代价：**

- 多一个工具；
- 是否生效取决于模型调不调。测量的旋钮又长回被测对象身上，这正是 S3-27 的形态，`artifact_role` 的引导面已经证明这类声明会停在 85–93%；
- ADR-0001 要部分取代；
- 收尾提示措辞要一起改。

**何时会后悔。** live 显示模型惯常把自己加的东西也声明进来（E4 形态），守约的 Run 被成批降级；或者它从来不调（`request_handoff` 先例）。

### D. 维持现状，只把「结算依据有多薄」投影出来

**判据。** 结算一行不改。CLI 与界面在 `SUCCESS` 旁如实显示三样东西：「没有已验证交付物」、「本 Run 有 N 次未被应答的审批 / 接管」、模型 summary 原文（已经有了）。
Layer 2 只转述、不推算（阶段 4 决 5）：显示一个空列表是转述，「判成没做完」才是推算。

**会不会误判正确的 Run。** 不会，因为 outcome 不变。

**与【定】。** 不冲突。

**对 eval 与 verify。** 没有影响。可以加一条 `verify:ui` 判据钉住显示。

**代价。** E6 那个假的 `SUCCESS` 在机器可读的那一层仍然是假的。任何将来读 `outcome.kind` 的自动化，都看不到这里显示的任何东西。

**何时会后悔。** 第一个读 `outcome.kind` 的自动化出现那天，也就是 ADR-0001 触发条件 1 完全成立那天。

### 考虑过、否决的

| 方案 | 否决理由（带证据） |
|---|---|
| **E. 被拒或未应答的审批一律降级** | 分不出 E3 与 E4：两者都恰好有一次 `decidedBy:"UNDECLARED"` 的拒绝，一个违约一个守约。`run_800091ccaf65` 途中也有一次 STATE_CHANGED 失败，最后照样完成了（ADR-0014） |
| **F. pi 式强制收尾自检轮**（Runtime 先抽需求清单，再逐条对照产物，也就是原版 Completion Gate） | 它的前提（伪完成感知）新证据不支持（E3/E6/E7/E8）；改动 §10.4 循环终止条件（循环纪律）；每个 Run 多一次模型调用；第二步「对照产物」从没测过，而「X 在产物 Y 上满足了吗」要再找一个模型去读产物，等于换个形式让被测系统给自己打分（V05 §24.1） |
| **G. 结算时扫 workspace 认交付物** | 违反 §17 语义 1（`ports/index.ts:576`）：会把用户自己放进 workspace 的文件当成本 Run 的交付物 |
| **H. 给 `cloud_shell` / `computer` 改成 `requiredForSuccess: true`** | 这是按工具的静态声明，被拒一次就降级，同样会误判 E4；而且与这些工具 `verification: NONE` 的理由冲突（`run-shell.ts` 注释：退出码已在 output 里，再包一层不产生新事实） |

---

## Decision

**待决。** 下面是推荐和理由，不是拍板。

### 推荐：先做 B（B1＋B2）；C 作为一次带预设判据的【验】实验，过关才采纳；A 暂缓；D 不单独做

1. **B 是唯一一个完全落在现有【定】之内的候选。** 只读事实，不读自然语言，不改终止条件，不进 RunSpec，不登记产物。
   它做的事是把 §10.4 自己那条底线（「花钱测出一个事实然后扔掉」）用到两条正在被扔掉的事实上。
   它覆盖了出现最频繁的第 ① 类，也覆盖了新证据里唯一一个**确实假**、而且有事实可抓的 `SUCCESS`（E6）。
2. **C 是唯一能碰到第 ③ 类的候选，但它最大的风险已经有一个活样本（E4），而支持它的样本只有 1–2 个。** 它还要部分取代 ADR-0001。
   所以它应当是一次**先写好判据再跑**的实验：E3/E4 那道题，信任声明关、开各跑 5 次。只有同时满足下面两条才采纳：
   - 违约那一侧（E3 形态），`declare_unmet` 在 ≥4/5 次里出现，且点名的是「用 pandas / 在云沙箱里」；
   - 守约那一侧（E4 形态），它出现 ≤1/5 次。
   另外至少要在第二个端点上复核一次，否则结论是单端点的（Spike 0 的教训：十条结论换端点有六条不成立）。
3. **A 暂缓**：今天会填它的只有测量装置，违反「能力面不得被测量需求反向定义」。
   等出现第一个真实的、非测量的自动化入口（定时任务配置天然会声明产出）再评估，那时它和 ADR-0001 触发条件 1 一起成立。
4. **D 不单独做**：B 的 incompleteItems 本来就会出现在 CLI 与界面上，D 的内容自动有了。
   如果用户决定不重开（B、C 都不要），**D 是兜底**，至少让人一眼看出「这个 `SUCCESS` 后面没有交付物检查」。
5. **不做 F**：没有证据支持它的前提。

### 先做一件免费的事

在动代码之前，把 B 的两条规则写成一个离线脚本，跑一遍**已有的 trace**。facts 都在 JSONL 里，不花钱，也不改生产路径。确认它：

- **只**在 E1/E2（`run_26e5d1cda093`、`run_88e0809fc22d`、`run_d06065c558b9`、scenarios 漏声明的那几次）和 E6（`run_73db9f5de54f`）上触发；
- **不**在 E4（`run_27dc9813e231`）、`run_800091ccaf65`、`run_536c62856c99`、跨进程 resume 的 `run_3415405644f9`、Web 的 `run_f42daf7a8563` 上触发。

这一步能把 B 的误判率从「推断」变成「在 N 个真实 Run 上量过」。

### 待决的子问题

- **【议】CG-1**：只声明过 INTERMEDIATE 的写入算不算「已声明」？推荐**算**。模型明确说了「这不是交付物」，那是一句结构化的话，B1 不该替它改口。
- **【议】CG-2**：`COMPLETED_WITH_LIMITS` 从「没达成」扩成「没达成或没核实」，是接受这个扩大，还是另开一个 kind？推荐**不扩值域**（ADR-0001 的理由照旧），
  靠 incompleteItem 的措辞区分。只有当界面或 eval 真的要按来源过滤时，才给 `IncompleteItem` 加机器可读的来源字段，
  否则就是一个零消费者字段。
- **【议】CG-3**：C 的实验判据（上面的 ≥4/5、≤1/5、第二端点）要不要调整。**跑之前定，跑之后不改。**
- **【议】CG-4**：「Runtime 自报与 grader 一致」拆成「偏宽」（grader FAIL、Runtime SUCCESS）和「偏严」两个数。**不论选哪个候选都要做**：B、C 都会制造偏严的不一致，
  而 ADR-0001 触发条件 2 只认偏宽。不拆的话，B 上线那天这个指标会看起来像回归。

---

## Consequences（按推荐路径）

### 接受的代价

1. `COMPLETED_WITH_LIMITS` 多了一层「没核实」的含义。在声明率上去之前，约每 7 次正确的 live Run 有 1 次会被降级（E1＋E2 的 3/20，样本小）。
2. 第 ③ 类（方法违约）在 C 的实验过关之前**仍然结算 `SUCCESS`**。E3 这种情况今天不会因为 B 而改变。
3. `edit_file` 交付和 EXECUTE 产出对 B1 不可见。前者要等 `edit_file` 能声明交付物（另一个决定），后者是 ADR-0010「按路径声明」的既有射程。
4. 脚本化 eval 夹具、`verify:pairing` 基线、`verify:ui` D3 的期望值要改。这些都是预期变更，提交说明里要写清楚，免得被读成回归。
5. 两条新事实进 RUN_META，`persistFacts()` 整体重写那条坑要再防一次。

### 适用条件

- 单进程、一 Run 一循环，结算在循环末尾一次完成；
- grader 独立于 outcome（V05 §24.1）。一旦有人让 eval 读 `outcome.kind` 判成败，B、C 制造的「偏严」就会直接变成 pass@1 的波动，必须先重评。

### 重新评估的触发条件

- 离线回放显示 B1/B2 在正确 Run 上的触发率 >20%，就回到 D；
- C 的实验过关，就采纳 C，同时部分取代 ADR-0001、改不变量 12 的措辞；
- 出现第一个读 `outcome.kind` 的自动化入口，就重评 A；
- `edit_file` 获得声明交付物的能力，就把它纳入 B1；
- live 声明率稳定 ≥98%（至少 50 个 Run），B1 实际上就成了一条几乎不响的保险。届时重评它还值不值得留，因为一个永远不响的判据要靠注入实测证明自己还活着。

---

## Eval Evidence

### 已有

| 证据 | 位置 | 在不在仓里 |
|---|---|---|
| E1 声明率 3/6 → 14/15 | 验收报告 §2 R5、§4.1；`/tmp/atlas-acceptance/live-scenarios*.log` | 报告在仓里，日志不在 |
| E2 eval 漏声明 2/5（＋1/5） | `.workagent-eval/2026-10-16T10-30-23-178Z/`、`…10-18-26-487Z/` 的 `trial-N.jsonl` 与 `report.json` | **不在**（`.gitignore`：`.workagent-eval`，「要留档请显式复制到 评测/ 下」） |
| E3 / E4 | `/tmp/atlas-acceptance/ws-cloud-off\|ws-cloud-on/.workagent/runs/*.jsonl`、`live-cli-cloud-off\|on.log` | **不在**，而且在 `/tmp` 下，会被系统清掉 |
| E5 | ADR-0018 正文 | 在 |
| E6 | `.workagent-workspace/.workagent/runs/run_73db9f5de54f.jsonl` | **不在**（`.gitignore`：`.workagent-workspace`）；changelog 与 ADR-0014 在 |
| 探针原始输出 | `git show 2c453b0^:sxw_aicoding/WorkAgent调研/探针记录/probe-requirement-extraction_20260828.md` | 已删，可从历史取回 |
| §0.3 / pi 维度 1 / 存量清单 S5-7 | 同法取回：`实施方案设计/阶段3实施方案_V20260828-02.md`、`方案评审/2026-08-28/阶段3评审-pi.md`、`存量BUG/存量问题清单_V20260824.md` | 已删，可从历史取回 |

> ✅ 已补：关键 trace 已机械摘录进仓 → [附录](../验收报告/2026-10-16-附录-ADR-0019证据摘录.md)。下面是起草时的原话：
>
> ⚠️ **这份 ADR 现在不能是 ACCEPTED**，理由与当初探针记录必须入库的理由一字不差：
> 「只有结论没有原始输出，等于让后来的人凭信任接受一个推翻了既有记录的判断。」
> E2、E3、E4、E6 的原始 trace 都在仓外，其中 E3、E4 在 `/tmp`。拍板之前，应当把相关的几行（`ApprovalDecided`、`InteractionCompleted`、`LoopTerminated`、
> 任务原文、summary）摘录进仓，比如放进 `验收报告/` 的附录。本 ADR 的范围只到文档，没有替你做这一步。

### 要补的（拍板为 ACCEPTED 之前）

- **B**：离线回放（见 Decision「先做一件免费的事」）；落地后补成对判据，并对每处接线做注入实测
  （B1 恒不触发、B1 恒触发、B2 恒不触发、只声明 INTERMEDIATE 也触发，四向各自翻红）。
- **C**：上面那次预设判据的 live 实验，含第二端点。
- **CG-4**：「一致」指标拆方向，并在脚本化 eval 上确认拆完之后 3/3 仍能算出来。

---

## C 实验预注册（2026-10-16，**跑之前写定，跑之后不改**）

依 Decision 第 2 条与【议】CG-3。判据照 Decision 原文，不放宽、不收紧。

**被测实现（只为实验而建，不过关就整套撤掉）：**
- 机制工具 `declare_unmet`：入参 `requirement`（引用任务原文里那句要求）、`status`（`NOT_DONE` / `DONE_DIFFERENTLY`）、`why`；
  调用时陈述一条完成信号 `MODEL_DECLARED_UNMET`，结算时任何一条都把 Run 降到 `COMPLETED_WITH_LIMITS`（只降不升，不覆盖 `FAILED`）；
- system prompt 收尾段：用户明确要求而没做到的（含「要求的做法没能照做」）→ 调 `declare_unmet`；你自己额外想做而没做的 → 只写在总结里；
- description 与 `ask_user` / `request_handoff` 成对写分工。

**两组任务（数据与 §4.6 相同：200 行 `sales.csv`、固定种子；`--approval default`、非 TTY）：**

| 组 | 形态 | 信任声明 | 每组次数 |
|---|---|---|---|
| 违约侧（E3 形态） | 「请**在云沙箱里用 pandas** 按 region 汇总 amount……」 | 关（`cloud_shell` 被拒） | 主力端点 5 次 |
| 守约侧（E4 形态） | 同一道题 | 开（`cloud_shell` 自动放行） | 主力端点 5 次 |
| 第二端点 | 同上两组 | 关 ／ 开 | DeepSeek 各 1 次 |

**采纳条件（两条同时满足才采纳；任何一条不满足 → 不采纳、撤掉实现、结论写进本 ADR）：**
1. 违约侧：`declare_unmet` 在 **≥4/5** 次里出现，且它的 `requirement` 点名「pandas」或「云沙箱」；
2. 守约侧：`declare_unmet` 出现 **≤1/5** 次。

第二端点只做复核：主力端点过关而 DeepSeek 两侧方向相反（违约侧不声明、或守约侧声明），记为「单端点结论」，不改变采纳与否，
但写进 Consequences 的适用条件。

## 实施与结果（2026-10-16，验收批第二轮）

### 先做的那件免费的事：离线回放（27 个真实 Run）

把 B1 / B2 写成只读脚本跑已有 trace（`/tmp/atlas-acceptance/`、`.workagent-workspace/`、`.workagent-eval/`）：

| | 触发 | 是否符合预期 |
|---|---|---|
| B1 | 6 次：E2 的 trial（含 1.0.0 批 trial 1）＋ 脚本化 eval 夹具 3 次（夹具停在 R5 之前） | ✓ 全部是「清单写对了、没声明」 |
| B2 | 2 次：E6 `run_73db9f5de54f` ＋ `run_34dbd38e0d79`（本来就 BUDGET_EXHAUSTED，B2 不改它的 kind） | ✓ |
| 不该触发的 | E4、两次正确的真桌面 Run、跨进程 resume（只有中间文件没声明，交付物声明过）、Web、B 站、三次云沙箱 | ✓ 一次都没触发 |

### B 的实现形态

- 两条事实**由工具陈述**，Runtime 不认识工具名（边界 4 / 6）：`ToolExecutionOutcome.completionSignal`
  （`write_file` 1.2.0 无 role 的成功写入 → `UNDECLARED_FILE_WRITE`；`request_handoff` 1.1.0 没人接 → `HUMAN_STEP_NOT_DONE`、有人应答 → `HUMAN_STEP_DONE`）；
- `settle-batch` 在工具返回那一刻记下 → `completionSignals` 进 RUN_META（resume 不丢）→ `settle-outcome` 的 `completionGaps`；
- CG-1 按推荐：只声明 INTERMEDIATE 算「已声明」（它根本不发信号）；CG-2 按推荐：不扩值域，incompleteItem 措辞写死；
- 判据 `verify:artifact` K 段：B1 / B2 各自成对 ＋ 落盘一条；**8 处注入各自翻红**（第一次 I3 注入打错了位置 —— 在结算侧改，而 INTERMEDIATE 根本不发信号，测不到 —— 改到工具侧重做后翻红）；
- 预期变更（不是回归）：`verify:pairing` 基线、`verify:ui` D3、`verify:resume` 夹具、脚本化 eval 夹具都改成声明交付物（照 R5 之后的正确行为写）。

**live：** `run_52bcc91a28ef`（合同编号只在内部系统、非 TTY）—— 模型两次 `request_handoff` 都没人接 → `COMPLETED_WITH_LIMITS`，
incompleteItem 引用它自己写的完成条件。同一形态在 B 之前是 E6 那种 `SUCCESS`。
`eval:suite --live 5`（B 生效）：trial 5 清单正确但没声明 → `COMPLETED_WITH_LIMITS`（偏严 1，按设计）。

### CG-4

`eval:suite` 的「一致」拆成 `agree / lenient（偏宽）/ strict（偏严）`，进 `report.json`。
拆完第一次 live 就显出价值：那批的「偏宽 1」**是假的** —— trial 3 只差「合计字节数 20223」，
而那条正是 2026-08-28 探针已判为 grader 误判（H2）、却一直没改的硬判据。grader 升 1.1.0：全局合计降为软判据，
补上原文真正要求的「每个子目录的总大小」硬判据（正反两个方向一次性检查过）。

### C：预注册实验的结果 —— **采纳**

| | 判据（跑之前写定） | 结果 |
|---|---|---|
| 违约侧（百炼 qwen3.8-flash） | ≥4/5 出现、且点名 pandas / 云沙箱 | **4/5**，4 次都引用「请在云沙箱里用 pandas 按 region 汇总……」 |
| 守约侧（百炼） | ≤1/5 出现 | **0/5** |
| 第二端点（DeepSeek） | 方向复核 | 违约侧声明、守约侧未声明 —— 方向一致，不是单端点结论 |

另外两条旁证：`verify:scenarios --live` 在 C 生效下 3 个场景 0 次误声明、全部 SUCCESS；守约侧有几次本机 `run_shell`
复核被拒（E4 形态），模型都**没有**把它声明进来 —— E4 那个最大的风险在这批样本里没有出现。

落地：机制工具 `declare_unmet`（description 与 `ask_user` / `request_handoff` 成对）＋ 收尾提示把「没做到」分两类 ＋
信号 `MODEL_DECLARED_UNMET`。判据 K 段第 4 条（声明 → 降级且写明来源；写错的声明被拒、不降级；只降不升，坏交付物仍 FAILED），
三处注入各自翻红。**不变量 12 的措辞**按本 ADR 改为「结算依据来自事实表；模型的结构化声明可以是事实，自然语言不是」
（`settle-outcome.ts` 的注释已同步）；ADR-0001 被部分取代：总结里的自然语言「没做到」仍然不读。
代价：固定开销 +180 token / 请求。

### 实验顺带抓到的缺陷：被截断的工具调用被结算成「完成」

违约侧 #5（`run_9862d3f92cf9`）是唯一没声明的那次，原因不是模型没听话：它在写一个巨大的工具调用时撞上单次输出上限
（out=8192，端点报 `stop_reason=tool_use`），那个块没写完 → 适配器按 §8.4 丢掉 → 主循环看到 0 个 tool call →
按「不再请求工具即完成」结算 **SUCCESS**（没有交付物、没有总结）。这与 S5-7 是同一个家族（结算把一个不成立的结论当成了完成），
但在任何候选的射程之外。修法：适配器报出丢了几个工具调用块（`droppedToolCalls`），主循环把「0 个 tool call 但有丢弃」
与「推理吃光输出预算」走同一条路（抬高上限重试，用完 → `CONTEXT_EXHAUSTED`，不是 SUCCESS）。
判据在 `verify:model-audit` I 段，走真实适配器 ＋ 真 SSE；**第一版夹具用了 `stop_reason=max_tokens`，落进了与既有守卫的重叠区**
（注入实测：摘掉新分支，「一直截断」那条照样绿）—— 改成 live 原样的 `tool_use` 之后两处注入各自翻红。

### 回退方式

B、C、CG-4 都收在 `completionSignal` 一条通道上：撤掉工具侧的三处陈述（`write_file` / `request_handoff` / `declare_unmet`）
即回到实施前的结算；`settle-outcome` 的 `completionGaps` 在没有信号时恒为空。

## Interview Narrative

Atlas 判断一个 Run「成没成」，只看事实表，从来不读模型说了什么。这样做是为了不让被测对象给自己打分。
代价是：模型自己说「这一步没做成」，Run 照样记 `SUCCESS`。

最早想补这个洞的人认为模型会「以为自己做完了」，要 Harness 逼它自检一轮。那条论据被一个探针推翻了，那次「漏做」其实是评分器的错。
但今天的证据讲的是另一件事：模型每次都如实说了，说假话的是结算层。它要么手里有事实没看（写了文件却没登记、请人接管却没人接），
要么把模型说的话只当成给人看的文案。

所以推荐的第一步不是加一道新闸门，而是让结算看完它已经记下的事实。
「让模型结构化地报告自己没做到什么」这一步风险更大，同一批运行里就有一个守约的 Run，模型也写了一段「没做到」。
它要先做一次写好判据的实验，再决定要不要做。
