# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目身份

**Atlas**（Project Atlas）是本项目的正式代号，**WorkAgent** 是产品类别与工程命名。

> ⚠️ **Atlas 仅用于项目识别与沟通，不作为任何工程重命名的依据。** 代码、目录、包名、模块、类型一律保持 `workagent` / `@workagent/*` 现状。见 [项目代号.md](sxw_aicoding/项目代号.md)。

定位：**自建生产级 Agent Harness，学习导向，个人使用**。项目第一目标是回答研究问题，不是交付功能——每个阶段结束时应该能说出「我们验证了 X」，而不只是「我们做完了 Y」。

产品语境（[WorkAgent调研.md](sxw_aicoding/WorkAgent调研/WorkAgent调研.md)、[Agent演化发展](sxw_aicoding/WorkAgent调研/Agent演化发展_从ChatAgent到LifeAgent.md)）：Agent 演化路径 ChatAgent → CodingAgent → **WorkAgent** → LifeAgent。本项目不复刻 WorkBuddy / 千问办公这类产品，而是自建它们底下那层 Harness。

## 当前状态

**阶段 1（Headless Walking Skeleton）主体实现完成，下一步是阶段 2（持久化与 Resume）。**

- 53 个 TS 文件 / ~7600 行，`tsc --noEmit` 干净
- 14 个 Port 定义，实现 10 个（D-14）
- 三条验收脚本可跑；真实百炼 Anthropic 端点跑通多轮多工具任务
- **已知缺口 30 项 ＋ 3 处文档口径待订正**，记录在 [阶段1存量问题清单](sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md)——动阶段 2 之前必读，尤其是「阶段 2 开工前」那三条前置（D-2 序列统一、R-6 Compact 落地、R-4 Port 异常收敛）
- 进程退出即失忆（transcript 只在内存）；GUI 在阶段 4，阶段 1–3 全部 headless

## 常用命令

```bash
npm install
npm run typecheck                  # tsc --noEmit，必须干净（每完成一步就跑一次）
npm run dev -- --task "看看根目录里有什么，然后写一份 summary.txt"
```

`--yes` 跳过交互式审批；`--workspace <path>` 指定工作目录（默认 `.workagent-workspace`）。

```bash
npm run verify:endpoint-profile    # 端点差异能否被挡在主循环之外
npm run verify:pairing             # 批内配对不变量能否守住
npm run verify:resume              # 消息级恢复够不够用（最关键）
npm run verify:all
```

**不写单测、不引入测试框架**（D-25）。验收以**可运行脚本**交付，打印可读证据供人判断，而不是断言绿灯——与 Spike 0 的探针形态一致。新增验证时按这个形态写，放进 `apps/cli/src/verify/`，用 `harness.ts` 里的 `banner/section/fact/verdict` 输出。

工程基线：**Node ＋ npm workspaces，不引入 pnpm / turbo / nx**。运行期依赖只有 `@anthropic-ai/sdk` 和 `dotenv`；`tsx` 直接跑 TS，无构建步骤。

### 凭证

根 `.env`（已 gitignore）提供百炼 Anthropic 形状的凭证：

```
dashscope_base_url_Anthropic=...
dashscope_model=qwen3.7-plus
dashscope_api_key=...
```

`compose.ts` 用 `override: true` 加载 dotenv 是刻意的——shell 里 export 过的 `ANTHROPIC_BASE_URL` 会把第三方 Key 发往官方端点（Spike 0 期间真实踩过）。`credential-guard.ts` 在启动前断言凭证去向，不是出错后记录。

> 已知缺口：三条 verify 脚本即使全程用 fake model port 也要求真实 `.env` 才能 compose（存量清单 §4.5）。

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

`Terminal` ≠ Run 终结：`RECOVERY_REQUIRED` 是明确的**非终态**，不结算 outcome，`StartResult.outcome` 为 `undefined`。

### 恢复走 transcript，不走状态快照

`resume()` = 读 transcript → 重建 messages ＋ 从 `RUN_META` 读回累计事实 → 按 §18.2 三条分支处置末尾未配对的 tool_use → 从下一轮继续。

`LoopState` 因此**不需要可序列化**（可以放 Promise / AbortController / 完整 Message[]）——这是删掉纯 Kernel 后剩下的唯一自由度。代价：崩溃时正在执行的工具会重跑，「工具跑没跑」在 transcript 上不可区分。**这把「Tool 是否幂等」从可选属性变成了恢复正确性的前提。**

三条分支与三个 Micro Case 工具一一对应（`cases/micro-cases/`）：

| 工具 | 性质 | 分支 |
|---|---|---|
| `list_dir` | 只读、快、幂等 | 一：真的重新执行 |
| `write_note` | 可控慢（`delay_ms`）、可验证、非幂等 | 二：真的调 Observation 读外部世界 |
| `append_log` | 非幂等且 `verification.mode = "NONE"` | 三：停在 RECOVERY_REQUIRED |

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

### 四条边界（有机械判据，改动后 grep 复核）

```bash
grep -rn "@anthropic-ai/sdk" packages apps cases     # 1. Provider SDK 只在形状适配器里
grep -rn "dashscope" packages/harness-runtime/src    # 2. 端点名不进 Runtime 代码
grep -n "profile\." packages/harness-runtime/src/loop/run-loop.ts  # 3. 主循环不读端点声明（仅文件头注释命中）
grep -rn "micro-cases" packages/harness-runtime/src  # 4. Runtime Core 不 import Case Package
```

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
  src/ports/                 14 个 Port 接口（★ 标记的 10 个已实现）
  src/facade/                HarnessRuntime：start / resume / cancel / interject / inspect
packages/testkit/            fake-endpoint-profile、fake-clock、in-memory-transcript-store 等
adapters/shape-anthropic-messages/   唯一允许 import Provider SDK 的地方
adapters/endpoint-profiles/  端点行为的**数据**形态，不是代码
cases/micro-cases/           三个工具（见上表）
apps/cli/                    Composition Root（compose.ts）＋ 入口 ＋ 三条验收脚本
```

单向依赖（`tsconfig.json` 的 paths 是它的编译期表达）：`apps → packages/adapters/cases`，`Runtime → Ports → Adapters`。禁止反向，禁止 Runtime → Case Package、主循环 → Provider SDK、Context 模块 → Provider SDK、形状适配器 → 端点特定常量。

## 文档

`sxw_aicoding/` 是本项目的主要产出之一，**不是附属说明**。

| 文档 | 作用 |
|---|---|
| [架构设计 V05](sxw_aicoding/架构设计/WorkAgent架构设计_V20260823_05.md) | **当前实现依据**。代码注释里的 `V05 §x.y` 都指向它 |
| [上位基线 v0.4](sxw_aicoding/方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md) | 项目目标与上位原则，**与架构设计冲突时以它为准** |
| [阶段 Roadmap](sxw_aicoding/阶段roadmap/WorkAgent阶段Roadmap_V20260823.md) | 各阶段研究问题与退出门槛 |
| [阶段 1 存量问题清单](sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md) | 已确认存在、本轮未修的 30 项，阶段 2 设计输入 |
| [阶段 1 实施方案](sxw_aicoding/实施方案设计/阶段1实施方案_V20260823.md) | 分步计划与不得绕过清单 |
| `WorkAgent调研/ProviderProtocolFacts_*.md` | Spike 0 三轮实测事实（75 份证据 / 4 个端点） |
| `代码评审/` | 两份阶段 1 评审 |
| `ADR/` | 决策记录；阶段 1 的四份**待补写** |
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
