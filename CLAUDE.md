# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目身份

**Atlas**（Project Atlas）是本项目的正式代号，**WorkAgent** 是产品类别与工程命名。

> ⚠️ **Atlas 仅用于项目识别与沟通，不作为任何工程重命名的依据。** 代码、目录、包名、模块、类型一律保持 `workagent` / `@workagent/*` 现状。见 [项目代号.md](sxw_aicoding/项目代号.md)。

定位：**自建生产级 Agent Harness，学习导向，个人使用**。项目第一目标是回答研究问题，不是交付功能——每个阶段结束时应该能说出「我们验证了 X」，而不只是「我们做完了 Y」。

产品语境（[WorkAgent调研.md](sxw_aicoding/WorkAgent调研/WorkAgent调研.md)、[Agent演化发展](sxw_aicoding/WorkAgent调研/Agent演化发展_从ChatAgent到LifeAgent.md)）：Agent 演化路径 ChatAgent → CodingAgent → **WorkAgent** → LifeAgent。本项目不复刻 WorkBuddy / 千问办公这类产品，而是自建它们底下那层 Harness。

## 当前状态

**阶段 3（通用能力面）开发完成（2026-08-28）。** 依据
[阶段 3 实施方案 V20260828-02](sxw_aicoding/实施方案设计/阶段3实施方案_V20260828-02.md) 四批 S1…S14。

> **范围在开工前被决 1 改写过**：原计划是「Case 01 网页归档」，改成**通用能力面**，
> 网页归档移出本阶段（Case 是尺子，不是模具）。评测与 Eval 按决 4 统一推到开发完成之后。

- **12 条验收脚本 91 条判据全绿**，`tsc --noEmit` 干净（摸底考试 bugfix 批后从 86 增至 91）
- 新增 `tools/` 层，默认装配 **12 个工具**（8 场景 ＋ 2 机制 ＋ 2 测量）；固定开销起步价 ≈ 2160 token
  （`fixedOverheadTokens()` = 工具数 × 180。此前各处文档写的「11 个 / 1980」是同一处算术错误：
  8＋2＋2 = 12，收口批统一更正）
- `BlobStorePort` ＋ 外置 ＋ `read_blob` 取回；`ArtifactStorePort` **重设计** ＋ Artifact 级 Verification
- Progress Guard（只做「在原地打转」检测）；人工接管全链路（`WAITING_FOR_INTERACTION` 的持久化 / resume / 等待扣除）
- **六条**边界 grep 全部守住（阶段 3 新增第 6 / 6b 条，且第 6b 条做过判别力实测）

**阶段 3 关掉了哪些存量**：P1-1 / `interject` CLI 入口 / N-8 / P3-26 / U-3 / U-8 / R-2 派生缺口。
**明确不做**：`CapabilityLeasePort`（决 5，见 [ADR-0005](sxw_aicoding/ADR/0005-PARKED-lease-不做的理由.md)）、
`SecretResolverPort`、`cases/web-archive/`（决 1）、Eval 与 Replay（决 4）、
Planner / Memory / Sub-agent（决 6）、通用 Completion Gate（论据被探针推翻）。

> ⚠️ **两条退出门槛仍开着，都要花钱**（属评测范围，按决 4 不阻塞阶段 3）：
> 跨进程 resume 的真实端点实跑、DeepSeek 对照端点实跑（当前 401，已核实是端点侧拒绝）。

> ⚠️ **一条新登记的欠账**：`requiredCapabilities` **逐工具零消费** ——
> 12 个工具全都声明了它，无人读。已在每个声明处留注释，走 bugfix 阶段。
> 见[存量清单 §0.6](sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md) 的 S3-1。

### 收口修复批次（2026-08-28）

三份独立评审（kimi / zocode / pi）逐条回源码复核后，**已确认成立的全部修完**，
见[存量清单 §0.7](sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md)。它关掉的两类：

1. **4 条判据自身没有判别力** —— Artifact 的 hash 检查是**内存自比**（恒真）、
   `verify:artifact` C 段、`verify:progress` D 段、`verify:scenarios` 总判定。
   后三条的共同形态是**抬头换了、verdict 没换**：段标题写着新判据，断言还是旧的那个。
2. **7 条声明与实现不符** —— `write_file` 的 `isIdempotent: false` 是为测量而标的
   （`types/tool.ts` 自己拿它当反面教材，见下）、`read_file`/`search` 的 HEARTBEAT 死声明、
   Guard「还活着」半边只写不读、`MAX_REDIRECTS` 死常量、README 停在阶段 1 口径等。

**三条判别力实测在实施时真跑过并翻红**：把 hash 检查改回内存自比、删掉 `search` 的
`onProgress`、删掉 `StdinChannel` abort 时清 waiter 那一行 —— 各自对应的判据当场变红。

### 摸底考试 Bugfix 批次（2026-08-28，A / A′ / B / C 四组）

[办公任务考卷 V1](考卷/V1/Atlas阶段3_办公任务考卷_V1_20260828.md) 实测 pass@1 = 4/9、NO-GO。
逐条回源码核对后的结论：**挂掉的不是能力面，是接线和仪器。**
题 2 三次全过说明工具面够用；题 1、题 3 各三次全灭，各由一条可定位的缺陷解释。
详见[存量清单 §0.8](sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md)。

> ### 【定】为什么 86 条判据全绿而实测 4/9 —— 记住这一条就够了
>
> **每一处出事的地方，夹具都让「正确值」与「错误值」恰好相等。**
>
> - `read_blob` 的取回判据调的是 `ports.blobs.get()`，**从没经过工具那一跳** ——
>   而 `line_offset` 正是在 handler 里被丢掉的（`tools/common/src/index.ts` 只转发了三个参数）；
> - `makeUsage()` 把 `billedInputTokens` 直接赋成 `inputTokens`、cache 计数恒 0，
>   于是主循环把漂移观测点传成 `inputTokens` 也测不出来（真实端点上是 1482% 假漂移）；
> - `verify:budget` 给每条轴都注入 `Partial` 覆盖，证明的是**读取点**能用，
>   而 `DEFAULT_BUDGETS` 里两条 token 轴根本没值 —— 生产里八条轴只有五条活着。
>
> **所以新增判据时先问：这条判据要区分的两个值，在夹具里相等吗？**
> 相等就先去改夹具，再写断言。然后当场做一次「改坏 → 翻红」实测 ——
> 本批 8 条新判据每条都做过，其中 `maxTotalWallClockMs` 那条两个方向都试了。

四组修的东西：**A** 接线断（`read_blob` 参数透传、外置提示、漂移比错字段、
并行开关规则方向、两条 token 轴默认值）；**A′** 前缀缓存断点前移到 messages 末尾
（U-9 后半，原理由「messages 每轮都在变」在 `STRICT_PREFIX` 下不成立 —— transcript 是只追加的）；
**B** `request_handoff` 的引导面措辞（题 3 的模型分析全对却零调用，
被 system prompt 收尾那条更便宜的出口接走了）；**C** 在途模型调用挂预算 deadline
＋ 软限进模型上下文。

> ⚠️ **B 组在 `verify:all` 里拿不到判据**，这是边界不是遗漏：脚本化模型不会替你选工具。
> 它只能靠 live 复跑验证（题 3 × 3，`InteractionRequested ≥ 1`）。
> 不要为它硬造「description 里必须出现某个词」的机械判据。

### 改验收脚本前必读

**【定】退出码由 `harness.ts` 的判据登记表推出，不得手写布尔表达式。**
每次 `verdict()` 自动计入，`runVerify()` 负责收尾（并保证 `finally` 的清理先于退出跑完）。

理由是实测：阶段 2 期间有**四条判据算出来了、打印了，却没接在退出码上** ——
其中一条正是被实施记录列为「最有价值的发现」的那条。手写表达式漏一项不会有任何征兆。
D-25 决定不写单测，这些脚本就是本项目唯一的测量仪器；**仪器上有一根线没接，比没有那根线更糟，它还会打绿勾。**

同源的一条：`run-loop` 的 `persistFacts()` 每轮**整体重写** RUN_META，
漏写一个字段 ≠「这条没有」，而是**整个 Run 的那个累计量被抹掉**（`readRunFacts` 只读最后一条）。
`lastSequence` 和 `resumeBranchCounts` 都在这里栽过。加字段时必须同时改它。

> ⚠️ **`.env` 的 `dashscope_model` 与端点声明不一致会在启动时被挡下**（M-5）。
> 这个值在阶段 1 一直被静默忽略（实际用的是声明里的），阶段 2 把它变成了显式错误。
> 二选一：把 `.env` 改成声明里的 modelId，或为你想用的模型补一份端点能力声明。
>
> **同族的第三条，阶段 3 撞到的**：E-3 的自动放行规则要求 `REVERSIBLE`，
> 而 `write_file` 声明 `PARTIALLY_REVERSIBLE` —— **那条规则从来没覆盖过它唯一为之而写的工具**。
> 真实端点实跑才撞出来：模型正确做完了全部工作，两次写入被「无人应答」挡掉，
> 结算 `USER_REJECTED`，而全程没有任何人拒绝过任何东西。
> **一条闸门排在另一条后面，等于没有闸门** —— 新增校验都要有能单独触发它的判据。

GUI 在阶段 4，阶段 1–3 全部 headless。

## 常用命令

```bash
npm install                        # Node 24＋（.nvmrc / engines 都写了）
npm run typecheck                  # tsc --noEmit，必须干净（每完成一步就跑一次）
npm run dev -- --task "看看根目录里有什么，然后写一份 summary.txt"
npm run dev -- --list-runs         # 库里有哪些 Run
npm run dev -- --resume <runId>    # 接上一个没跑完的 Run
npm run dev -- --resume <runId> --recovery-decision CONTINUE --recovery-note "已人工确认"
npm run dev -- --endpoint deepseek --task "..."   # 换对照端点（受枚举约束，拼错立刻失败）
```

**审批档位（阶段 3 决 3 改过默认值）**：默认**自动放行 workspace 内、非 IRREVERSIBLE 的写**；
`append_log` 这类不可逆操作与 EXECUTE 仍逐次问；**越界写由 Policy 直接拒绝，不给审批机会**。
`--confirm` 恢复「每一步都问」；`--yes-all` 是显式的「批准一切」。
> `--yes` 保留为默认档位的显式写法（不破坏既有命令行）。
> 【定】改这段前先读 `main.ts` 里 `autoGrant` 的注释 —— 那条规则曾经因为
> `REVERSIBLE` vs `PARTIALLY_REVERSIBLE` 的一字之差，从来没覆盖过 `write_file`。

**运行期交互**：TTY 下 stdin 是**单一通道**，按「谁在等」分派三种语义 ——
RUNNING 敲一句话回车 = 插话；等审批时回车 = 应答；等接管时回车 = 完成信号。
非 TTY 优雅降级（审批按**拒绝**处置，接管按「没有人」处置，都不挂起）。
`--workspace <path>` 指定工作目录（默认 `.workagent-workspace`）；`--db <path>` 指定 SQLite 库（默认 `.workagent-state/runs.db`）；
`--trace <file>` 指定事件流落盘位置（默认按 runId 定名 `.workagent-runs/<runId>.jsonl`，**resume 续写同一文件**），`--no-trace` 关闭。

```bash
npm run verify:endpoint-profile    # 端点差异能否被挡在主循环之外
npm run verify:pairing             # 批内配对不变量能否守住（三条中断路径各一条真注入 ＋ R-4 四条 Port 异常 ＋ orphan 反向注入）
npm run verify:resume              # 消息级恢复够不够用；C 段判据已收紧到「产物与基线逐字一致」
npm run verify:compact             # Compact 是否真的落地（R-6）
npm run verify:persistence         # 跨进程恢复：真 kill -9 之后能不能只凭 SQLite 接上
npm run verify:budget              # 预算八轴逐条撞墙 ＋ 墙钟拆分 ＋ 时间事实段级冻结
npm run verify:crash               # 三个崩溃窗口 × 三条恢复分支（决 6 的判别力在这里）
npm run verify:drift               # 端点漂移检测 ＋ 对照端点装配 ＋ resume 端点一致性闸门（U-1 / U-6 / P1-1）
npm run verify:tools               # 批 1：六条边界 grep ＋ 两类声明 ＋ 分页非截断 ＋ 组合器三方法路由 ＋ 读黑名单
npm run verify:artifact            # 批 2：外置与逐字取回 ＋ URL 护栏 ＋ 产物登记与第二层验证 ＋ role 分流
npm run verify:progress            # 批 3：进展 ＋ 无进展 ＋ 真实慢工具取消 ＋ 人工接管三条状态闭合
npm run verify:scenarios           # S13：三场景 smoke（决 7 的判据）＋ 三条护栏在场性总校验
npm run verify:all                 # 12 条脚本 / 91 条判据
```

`verify:scenarios -- --live` 用真实端点跑同样三个任务（**花钱，不在 verify:all 里**）。

Eval 层（不复用生产结算路径，§24.1【定】）：

```bash
npm run eval:suite                 # 脚本化，不花钱，验管路（夹具→Run→manifest→grader→报告）
npm run eval:suite -- --live 5     # 真实端点跑 5 次，出 pass@1 / pass^5 / token 与时延分布
npm run verify:drift -- --live     # DeepSeek 对照端点实跑（§24.6）
```

一次性探针，**要花钱、发真实请求，不在 `verify:all` 里**（上面带 `--live` 的两条同理）：

```bash
npm run probe:reasoning-tokens     # D-3：count_tokens 算不算推理块
```

**不写单测、不引入测试框架**（D-25）。验收以**可运行脚本**交付，打印可读证据供人判断，而不是断言绿灯——与 Spike 0 的探针形态一致。新增验证时按这个形态写，放进 `apps/cli/src/verify/`，用 `harness.ts` 里的 `banner/section/fact/verdict` 输出。

工程基线：**Node 24 ＋ npm workspaces，不引入 pnpm / turbo / nx**。运行期依赖只有 `@anthropic-ai/sdk` 和 `dotenv` —— **SQLite 用内置 `node:sqlite`，不新增依赖**；`tsx` 直接跑 TS，无构建步骤。

### 凭证

根 `.env`（已 gitignore）提供百炼 Anthropic 形状的凭证：

```
dashscope_base_url_Anthropic=...
dashscope_model=qwen3.7-plus
dashscope_api_key=...
```

`compose.ts` 用 `override: true` 加载 dotenv 是刻意的——shell 里 export 过的 `ANTHROPIC_BASE_URL` 会把第三方 Key 发往官方端点（Spike 0 期间真实踩过）。`credential-guard.ts` 在启动前断言凭证去向，不是出错后记录。

> 阶段 2 起：用 `modelPortOverride` 时不再要求真凭证（存量清单 §4.5 已关）。
> 验收脚本一律用 `dbPath: ":memory:"` —— 同一条 SQLite 代码路径，但每次 compose 都是干净的一份。

## 架构

> **单进程、消息级持久化的 Agent Harness：主循环驱动模型与工具，端点差异以数据形式隔离在外，协议不变量 100% 由 Runtime 自持。**

三层：Layer 1 UI（阶段 4）→ Layer 2 Application Service（未实现）→ **Layer 3 Harness Runtime（阶段 1 的全部）**。

### 主循环（`loop/run-loop.ts`）

```text
while (true) {
  ⓪ 排空 Interject 队列
  ① 编译 ContextFrame（外置 → Compact → 协议校验）
  ② 调模型（流式，delta 直接 yield）
  ③ 无 tool call → 结算 outcome，具名 Terminal 退出
  ④ 执行 ActionBatch（串行，每个 call 恰好一个 result）
  ⑤ 构造完整的下一个 LoopState，写明 transition.reason
}
```

**循环纪律五条**（改这个文件前先读文件头注释）：

1. 每个 `continue` 站点必须构造完整的 `LoopState`——由 `nextState()` 强制；
2. 每个 `continue` 带具名 `Continue.reason`，每个 `return` 是具名 `Terminal`；
3. 消息先落盘再进 `messages` 数组——由 `appendAndPush()` 强制；
4. 流式 delta、进度、心跳不进 `LoopState`，直接 yield；
5. **循环不读取端点能力声明**（本文件出现 `profile.` 即违规）。

阶段 2 在第 ① 步之前多了一次 `checkBudgets()`（八条轴一次判完，R-1），
在第 ② 步之后多了一次漂移观测（U-1）；阶段 3 在第 ④ 步之后多了一次
Progress Guard 判定（U-3，无进展 → 具名 Terminal `NO_PROGRESS`），
并在批事件流上多了两个消费点（`ToolProgress` → Guard；
`InteractionRequested/Completed` → 等待时间扣除）。

**三次扩展都收在纯函数/独立类里，循环只消费判定结果，纪律五条一条没动。**
【定】允许动的是「新增等待分支 / 新增事件消费点 / 新增等待扣除的事件对」，
每一处都必须由 `nextState()` 构造完整 `LoopState`、带具名 reason、在 verify 段里有判据。

`Terminal` ≠ Run 终结：`RECOVERY_REQUIRED` 是明确的**非终态**，不结算 outcome，`StartResult.outcome` 为 `undefined`。

### 恢复走 transcript，不走状态快照

`resume()` = **从 `RunStorePort` 读回冻结的 RunSpec** → 读 transcript → 重建 messages ＋ 从 `RUN_META` 读回累计事实 → 按 §18.2 三条分支处置末尾未配对的 tool_use → 从下一轮继续。

【定】RunSpec 必须是**启动时冻结的那一份**（深冻结，M-4）。三条分支的判定读的是
`spec.agentSpec.toolSnapshots`——用今天 compose 出来的工具声明去判一条昨天的 transcript，
改一次工具声明就会让同一条记录走进不同分支，而盘上看不出来。读不到就抛，**不回退到当前配置**。

`LoopState` 因此**不需要可序列化**（可以放 Promise / AbortController / 完整 Message[]）——这是删掉纯 Kernel 后剩下的唯一自由度。代价：崩溃时正在执行的工具会重跑，「工具跑没跑」在 transcript 上不可区分。**这把「Tool 是否幂等」从可选属性变成了恢复正确性的前提。**

三条分支与工具形态的对应（阶段 3 后）：

| 工具 | 包 | 性质 | 分支 |
|---|---|---|---|
| `list_dir` / `stat` / `read_file` / `search` / `now` / `fetch_url` / `read_blob` | tools/common | 只读、幂等 | 一：真的重新执行 |
| `write_file` | tools/common | **幂等**（覆盖写同样内容两次 == 一次） | 一 |
| **`edit_file`** | tools/common | **真的非幂等** ＋ 相对操作（`requiresPreFingerprint: true`） | 二：**唯一天然落在分支二的场景工具** |
| `request_handoff` | tools/common | 只读、幂等；`waitsForHumanInteraction` | 一 |
| `append_log` | cases/micro-cases | 非幂等、执行后不可验、**相对**操作 | 二或三：**取决于有没有拍到执行前指纹** |
| `slow_write` | cases/micro-cases | 可控慢的**写**（`delay_ms`） | 一（幂等，与 `write_file` 同理） |

> **收口批改过 `write_file` 那一行。** 它此前声明 `isIdempotent: false` 落分支二，
> 而注释自己承认那是「为了让分支二有**通用工具**可测」—— 与把 `delay_ms` 赶出这个工具
> 是同一条纪律（能力面不得被测量需求反向定义），只是藏在一个布尔字段里。
> 后果不是纸面的：`facade` 的分支判定里 `isIdempotent` 是**第一个**判别项，
> 于是最常用的写工具会把 §18.2 的分支分布系统性带偏。
> `verify:crash` / `verify:resume` 的分支二载体同批换成 `edit_file`。

`edit_file` 让 §2.4 的组合器路由第一次被**真正需要**：`CompositeVerifier` 漏路由
`observePre`，它会静默从分支二退化到分支三，**盘上看不出来、没有任何报错**。
`verify:tools` E 段对这条做判别力实测（改坏路由必须翻红）。

**【定】阶段 2 起，分支判据是 Action 级事实，不是工具的静态声明（决 6）。**
阶段 1 用 `verification.mode !== "NONE"` 回答「崩溃后能不能观察」，而那个字段说的是
「执行后能不能验」。两者不同：`append_log` 执行后验不了（不知道该有几行），
但崩溃后能不能观察，取决于**执行前有没有留下指纹**（`ACTION_FACT` 条目）。
拍不拍由 Runtime 侧的 Verifier 决定——这样测量的旋钮才不长在被测对象身上。

停在 `RECOVERY_REQUIRED` 后，**再次 `resume()` 必须带 `recoveryDecision: "CONTINUE" | "ABORT"`**，否则抛错——不然「交用户决定」会退化成「停一次，下次自动放行」。

### 端点行为是数据，不是代码（原则十四 / D-07）

判据：**如果换一个端点这条结论可能变，它就是数据。**

理据是实测：Spike 0 第二轮的十条结论，第三轮重测有**六条换端点就不成立**，而变量隔离已经做得很干净（同平台、同模型、同 Key，只换 API 形状）。

落地形态是 `adapters/endpoint-profiles/*.json` ＋ `ModelProtocolPort`：

```text
buildRequest      形状提供请求结构      端点提供常量
validateFrame     形状提供协议规则      端点提供校验强度
protocolRoleOf    形状提供载体          端点提供约束档位
countTokens       形状提供端点路径      端点提供精度
classifyError     —                    端点提供判别式
isBlockClosed     形状提供事件          端点提供有无
```

主力端点是**百炼 Anthropic 形状 `qwen3.7-plus`**（D-16）。选它而不是评分更高的 DeepSeek，因为它**零协议兜底**（缺 tool_result、错 tool_call_id 一律 200 放行）且服务端无状态——用一个什么都不校验的端点开发，能逼出自持逻辑的全部漏洞。`compose.ts` 是全仓唯一写死端点名的地方。

### 六条边界（有机械判据，改动后 grep 复核）

```bash
grep -rn "@anthropic-ai/sdk" packages apps cases tools      # 1. Provider SDK 只在形状适配器里
grep -rn "dashscope" packages/harness-runtime/src            # 2. 端点名不进 Runtime 代码
grep -n "profile\." packages/harness-runtime/src/loop/run-loop.ts   # 3. 主循环不读端点声明（仅注释命中）
grep -rnE "micro-cases|tools-common" packages/harness-runtime/src   # 4. Runtime Core 不 import 任何工具实现
grep -rn "node:sqlite" packages apps cases adapters tools    # 5. 只允许 packages/store-sqlite/ 命中
grep -rnE "@workagent/tools-|tools/common" packages adapters # 6. ★阶段 3：Runtime 与适配器不得依赖工具包
grep -rnE "@workagent/micro-cases|cases/" tools/             # 6b. ★阶段 3：通用工具不得依赖任何 Case 包
```

**`verify:tools` A 段机械跑这六条**，不要手工 grep 了事 —— 它还会过滤注释行
（这些文件里到处在引用边界规则本身），并在 A2 段做**判别力实测**：
往 `tools/common` 注入一行对 Case 包的 import，第 6b 条必须当场翻红并指出行号。

第 5 条是阶段 2 新增：`node:sqlite` 是 Node 22.5 才引入的年轻 API，调用面收在一个包里，将来 API 变了只改一处。

第 4 条阶段 3 从「不 import Case Package」推广为「**不 import 任何工具实现**」。
第 6b 是「通用」这个词的机械含义：**通用工具一旦依赖某个 Case，它就不通用了**，
而这件事从代码上看不出来。注意它的模式**不是**方案里写的 `"cases/"` ——
那个抓不到 `import … from "@workagent/micro-cases"`，而包名 import 恰恰是最典型的违规形态。

前两条是研究问题「端点差异能否被完全挡在主循环之外」的机械判据。判据要区分**注释、类型定义与真实依赖**——`ApiShape` 这类类型定义命中不算违规。

### 不变量 8：批内每个 Tool Call 恰好一个 result

理据不是「否则 Provider 会 400」——选定端点上缺 result、错 id 一律 200 放行。理据是**否则模型看到的是一个失真的世界**，而且没有任何外部兜底会替你发现违反。

`action/settle-batch.ts` 是这条不变量的**单点收敛**：所有出口都经过 `finally` 里的 `finalize()` 补齐缺失 result，`recordUnmetRequired()` 同时补齐事实表。改这个文件时保持这个结构——重复结算直接抛错，不静默覆盖。

### outcome 结算只查事实表

**循环终止条件严格是「模型不再请求工具」**，没有独立的声明式验收机制。但结算 `outcome.kind` 时**必须查一次 required Verification 的结果**（`verification/settle-outcome.ts`）：Verification 已经跑过、扣了 token、结果已在表里，忽略它等于花钱测出一个事实然后扔掉。

典型场景：工具报错，模型总结里写「已完成，其中一项已跳过」——此时应结算 `COMPLETED_WITH_LIMITS`，不是 `SUCCESS`。

### 目录

```text
packages/harness-runtime/    Layer 3 全部
  src/loop/                  主循环、LoopState、Continue / Terminal、interrupt
  src/transcript/            重建与配对扫描（存储实现在 testkit / 阶段 2 换 SQLite）
  src/context/               ContextFrame 编译与 Compact
  src/action/                Effect 解析、Policy、批结算
  src/verification/          Verifier 与 outcome 结算
  src/model/capability/      端点能力声明的加载、冻结与漂移检测
  src/ports/                 15 个 Port ＋ 阶段 3 新增的 ArtifactCheckerPort
                             （阶段 3 后只剩 CapabilityLease / SecretResolver 未实现，各有理由）
  src/loop/progress-guard.ts ★阶段 3。只回答「在原地打转吗」；「还活着吗」那半边
                             收口批删了（进展是批结算时才排空的，时间戳判不了存活）
  src/facade/                HarnessRuntime：start / resume / cancel / interject / inspect
packages/store-sqlite/       ★阶段 2。唯一允许 import node:sqlite 的地方
  src/migrations/            单一 runner，固定顺序（§26.3【定】）
  src/transcript-store.ts    TranscriptStorePort 的 SQLite 实现（接口一字未改）
  src/run-repository.ts      RunStorePort：RunSpec / AgentSpecSnapshot / status
  src/blob-store.ts          ★阶段 3。内容寻址；get 按行**且按字符**分页（见下）
  src/artifact-store.ts      ★阶段 3。版本链 / Tombstone / lineage / role
packages/testkit/            fake-endpoint-profile、fake-clock、crash-harness（真 kill -9）等
eval/                        ★阶段 2。graders / suite / fixtures
                             【定】只经 Facade，不依赖 Runtime 私有类，不读 RunOutcome 判成败
adapters/shape-anthropic-messages/   唯一允许 import Provider SDK 的地方
adapters/endpoint-profiles/  端点行为的**数据**形态，不是代码
tools/common/                ★阶段 3。Case 无关的通用能力面（@workagent/tools-common）
  src/fs/                    list_dir stat read_file search write_file edit_file
  src/fs/fs-common.ts        **唯一一份**边界判定与 fs 错误分类（cases/ 反过来 import 它）
  src/fs/read-guard.ts       读黑名单（决 3 护栏 1，**必须同时覆盖 read_file 与 search**）
  src/net/                   fetch_url ＋ url-guard（私网拒绝，DNS 解析后判 ＋ 重定向终点再判）
  src/mech/                  read_blob / request_handoff —— 机制工具，声明义务不同
  src/artifact-checks/       JSON / ZIP / 编码 / hash 四项。**不做「Markdown 可解析」**（恒绿）
cases/micro-cases/           只剩 append_log 与 slow_write —— **测量工具**，不是能力
apps/cli/                    Composition Root（compose.ts）＋ 入口 ＋ 12 条验收脚本 ＋ 一次性探针
  src/composite.ts           ★阶段 3。工具包组合器。【定】必须路由 Verifier 的**三个**方法
  src/stdin-channel.ts       ★阶段 3。**单一** readline，按「谁在等」分派三种语义
  src/trace/file-sink.ts     事件流落 JSONL（header / event / footer 三种行）
```

**`read_blob` 为什么要按字符分页**：被外置的是**工具结果**，而工具结果几乎都是
**一行 JSON** —— 一个 64KB 的 `read_file` 结果 `totalLines` 就是 1。只按行分页的话，
模型请求 100 行会拿回整整 64KB，**刚外置掉的东西原样搬回上下文，外置等于白做**。
所以还有一层字符预算，超长单行按字符切片并给 `nextLineOffset`。这仍然是分页，不是截断。

单向依赖（`tsconfig.json` 的 paths 是它的编译期表达）：`apps → packages/adapters/cases`，`Runtime → Ports → Adapters`。禁止反向，禁止 Runtime → Case Package、主循环 → Provider SDK、Context 模块 → Provider SDK、形状适配器 → 端点特定常量。

## 文档

`sxw_aicoding/` 是本项目的主要产出之一，**不是附属说明**。

| 文档 | 作用 |
|---|---|
| [架构设计 V05](sxw_aicoding/架构设计/WorkAgent架构设计_V20260823_05.md) | **当前实现依据**。代码注释里的 `V05 §x.y` 都指向它 |
| [上位基线 v0.4](sxw_aicoding/方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md) | 项目目标与上位原则，**与架构设计冲突时以它为准** |
| [阶段 Roadmap](sxw_aicoding/阶段roadmap/WorkAgent阶段Roadmap_V20260823.md) | 各阶段研究问题与退出门槛 |
| [存量问题清单](sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md) | **按阶段追加，不是只管阶段 1**。§0.4 阶段 2、**§0.5 阶段 2.5 收口、§0.6 阶段 3**（关 7 项、不做 4 项、新登记 S3-1…S3-5） |
| [Atlas 阶段 1 Agent 评测报告](评测/Atlas阶段1_Agent评测报告_20260824.md) | 真实端点单任务评测（84/100）。它暴露的四项已于 2026-08-25 修完 |
| [阶段 1 Bugfix 批次评审](sxw_aicoding/代码评审/2026-08-25/阶段1Bugfix批次评审-zcode.md) | 对上述修复批次的评审。逐条复核结论见存量清单 §0.2 追补 |
| [阶段 1 实施方案](sxw_aicoding/实施方案设计/阶段1实施方案_V20260823.md) | 分步计划与不得绕过清单 |
| [**阶段 2 实施方案 V20260826-03**](sxw_aicoding/实施方案设计/阶段2实施方案_V20260826.md) | **阶段 2 的实现依据**。§0 七个决定、§0.3 十七条修订记录、§7 的 36 项处置映射 |
| [阶段 2 方案评审](sxw_aicoding/方案评审/2026-08-26/阶段2实施方案评审-zcode.md) | 逐条核源码的评审，P1 四条已吸收进方案 §0.3 |
| [**阶段 3 实施方案 V20260828-02**](sxw_aicoding/实施方案设计/阶段3实施方案_V20260828-02.md) | **阶段 3 的实现依据**。§0 七个决定（决 2 / 决 3 有修订）、§4 十四条不得绕过、§5 结构性退出门槛 |
| [阶段 3 方案评审](sxw_aicoding/方案评审/2026-08-28/) | 两份（zcode / pi）。含一条**被驳回**的：pi 维度 6 说 R-1 / R-2 未修是事实错误，但它指向的后果成立，已并入 S10 |
| [探针记录](sxw_aicoding/WorkAgent调研/探针记录/) | 花钱探针的**原始输出**。`probe-requirement-extraction` 推翻了回归评测 §5.1 的归因 |
| `WorkAgent调研/ProviderProtocolFacts_*.md` | Spike 0 三轮实测事实（75 份证据 / 4 个端点） |
| `代码评审/` | 按日期分目录。`2026-08-24/` 两份阶段 1 评审；`2026-08-25/` 一份 Bugfix 批次评审 |
| `ADR/` | 决策记录。阶段 2 三份（[0001](sxw_aicoding/ADR/0001-outcome-kind-不区分是谁没做成.md) / [0002](sxw_aicoding/ADR/0002-恢复可观测性改为-action-级事实.md) / [0003](sxw_aicoding/ADR/0003-受信时间事实冻结到执行段.md)）＋ 阶段 3 三份（[0004 工具归属](sxw_aicoding/ADR/0004-通用工具归属与两类分拣标准.md) / [0005 lease 不做](sxw_aicoding/ADR/0005-PARKED-lease-不做的理由.md) / [0006 读放开的护栏](sxw_aicoding/ADR/0006-读放开的护栏边界.md)）；**阶段 1 的四份欠了两个阶段了** |
| `spikes/s0-provider-protocol/` | 一次性探针，已完成，不进主干依赖（`tsconfig.json` 已 exclude） |

V04 及更早的架构设计、`V03_Spike0回填清单.md` **不再作为实现依据**，只作过程记录。

### 状态标记

文档与代码注释共用一套标记，含义是硬的：

| 标记 | 含义 |
|---|---|
| **【定】** | 已拍板不变量，跨端点成立。实现违反即架构错误，变更需独立 ADR |
| **【验】** | 当前方向，待 Micro Case / Eval 确认后才能冻结 |
| **【议】D-xx** | 待决策，拍板前不得在代码中固化任一候选 |
| **【端点】** | 仅对特定端点成立，必须写明对哪个端点；不得编译进代码，只能进端点能力声明 |

## 写代码时

- **注释解释「为什么」和「违反了会怎样」，不解释「做了什么」。** 现有注释大量引用 V05 章节号、实测数字（360 tokens 工具固定开销、每请求底数 5、`count_tokens` 0.00% 误差、缓存严格前缀）和它们的证据出处——新增代码保持这个密度和风格，中文。
- **规格纪律**：任何 Contract 冻结前必须能指出证据来源；拿不出证据就标【验】或【议】。反向同样成立——「必须存在某个机制」也需要证据，V03 的 15 个决策点里有 3 个被证明**问题本身不该问**。
- **未接线比不写更糟**：类型、事件、类都在但运行时从不执行，会让人以为问题已经解决了（存量清单 §2 列了 8 项这种）。要么接线，要么删掉。
- 阶段 1 只实现能被当阶段 Micro Case 覆盖的最小面。新增 Port 时必须同时指出强制它存在的不变量。
- 提交前跑 `npm run typecheck` ＋ 相关的 `verify:*`，并复核上面四条边界 grep。
