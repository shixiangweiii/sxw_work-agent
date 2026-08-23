# WorkAgent 阶段 Roadmap

> 文档版本：V20260823
> 创建日期：2026-08-23
> 同步日期：2026-08-23
> 来源：`架构设计/WorkAgent架构设计_V20260823_05.md` §28（推进顺序与冻结门槛）
> 性质：**总览与索引**。实现语义、阶段范围和冻结门槛以 V05 架构设计为准；项目目标与上位原则以 v0.4 上位基线为准。
> 当前位置：**Spike 0 已完成，阶段 1 阻塞项已清空，待开工**

---

## 0. 一条贯穿全程的原则

**阶段划分的重心是「每阶段回答一个研究问题」，不是「每阶段交付一批功能」。**

这是这个项目区别于普通功能开发的地方，也是它作为学习导向项目的核心。每个阶段结束时，应该能说出「我们验证了 X」，而不只是「我们做完了 Y」。

---

## 1. 总览

| 阶段 | 一句话目标 | 做完能干什么 | 状态 |
|---|---|---|---|
| **Spike 0** | 把 Provider 协议的推测换成实测 | 4 个端点的行为写成数据 | ✅ 已完成 |
| **阶段 1** | 主循环跑通，端点差异挡在外面 | 终端里跑真任务，进程关了就忘 | ⬜ 待开工 |
| **阶段 2** | 记得住事，崩了能继续 | 关掉再开能接上，故障可复现 | ⬜ |
| **阶段 3** | 一个真实 Case 端到端 | 网页归档，跟确定性 Baseline 比出高下 | ⬜ |
| **阶段 4+** | 反证抽象 + 产品化 | 第二个 Case 跑通，有桌面界面 | ⬜ |

**图形界面在阶段 4**，不在之前。阶段 1–3 全部是 headless / CLI。

---

## 2. Spike 0：Provider 协议现实核对 ✅

### 核心目标

V03 架构设计是在**零次真实 Provider 调用**的前提下写出来的。先把推测换成证据。

### 做成了什么

三轮，覆盖 **2 平台 × 2 形状 = 4 个端点**，75 份原始证据，11 个探针（P0–P10）。

**产出**

- `WorkAgent调研/ProviderProtocolFacts_V20260822.md`（第一、二轮）
- `WorkAgent调研/ProviderProtocolFacts_V20260823_R3.md`（第三轮）
- `spikes/s0-provider-protocol/raw/*.jsonl`（原始证据）
- 实测结论已全部吸收进当前架构设计 V05

### 最有价值的产出

不是那些数字，是一条方法论结论：

> **第二轮十条结论有六条换端点就不成立**，而第二轮的变量隔离已经做得很干净（同平台、同模型、同 Key，只换 API 形状）。

这直接催生了架构设计的 §8.6（端点能力声明）与【端点】状态标记。

### 遗留未答

缓存 TTL；OpenAI 形状本地 tokenizer 误差；加密推理块签名校验；SDK partial message 累积行为；429 错误体；DeepSeek OpenAI 形状 `cached_tokens` 异常。

对应条款保持【验】标记。

---

## 3. 阶段 1：Headless Walking Skeleton ⬜

### 核心目标

主循环能跑通，且**端点差异一行都不进主循环**。

### 研究问题

> 端点差异能否被完全挡在主循环之外？批内配对不变量在没有状态机的情况下能否守住？

### 做完是什么样子

终端一条命令，真实百炼 Anthropic 端点，真做事：

```text
模型一次要多个工具
  → ActionBatch 串行执行
  → 每个 call 恰好一个 result
  → 回灌继续
  → 模型不再要工具
  → 具名 Terminal 退出
```

写文件前会停下来等确认，执行中能插话，Ctrl+C 能取消。

**关掉终端就忘了**——transcript 只在内存里。

### 最小实现范围

- 主循环（`LoopState` ＋ 具名 `Continue` / `Terminal`）
- 形状适配器 `shape-anthropic-messages` ＋ 端点能力声明（Recorded 与 Live 双模式）
- In-memory transcript、FakeClock
- `resume()`：丢弃 `LoopState`，从 transcript 重建后继续
- 一个只读 Tool ＋ 一个**可控慢的**可验证写 Tool
- ActionBatch（`SEQUENTIAL` + `PER_ACTION`）
- 最小 ResolvedEffect、ErrorRecord、ContextFrame
- WAITING_FOR_USER / APPROVAL / Interject（均为进程内）
- 基本 Budget / Cancel

**10 个 Port 实现，4 个只留接口**（详见架构设计 §8.7 与 §30.1 D-14）。

### 不得绕过

Effect 解析、错误副作用状态、批内配对不变量、边界脱敏、`outcome.kind` 结算、端点能力声明的读取路径。

### 判据：三条可运行脚本（不写单测）

| 脚本 | 验证什么 | 挂了意味着 |
|---|---|---|
| `verify:endpoint-profile` | 用 `fake-endpoint-profile` 构造「校验配对＋推理块需占位」的虚拟端点，Runtime 行为正确改变而**主循环代码不变** | 端点能力声明没有真正落地，换端点仍需改主循环 |
| `verify:pairing` | 分别注入流式中断、工具执行中断和模型错误，transcript 中不存在无 result 的 tool_use | 消息级恢复下的批内配对代价比预估更大 |
| `verify:resume` | 批执行中途丢弃 `LoopState`，从 transcript 重建后继续，与不中断跑完的结果一致 | 消息级恢复粒度的选择不成立 |

三条脚本**输出可读证据供人判断**，不是断言绿灯——与 Spike 0 的探针形态一致。

**第三条最关键：消息级恢复是当前架构最大的取舍，不验证它，阶段 1 结束时这个选择仍然没有运行证据。**

### 预期 ADR

主循环形态与消息级恢复粒度的取舍；ActionBatch 执行模式与结算默认值；完成判定为循环终止规则；端点能力声明的最小字段集。

### 已知会跑不到的路径

主循环第 ① 步有 Compact，但普通任务撞不到上下文墙。阶段 1 结束时应当明确知道：**Compact 写了但没被真跑过。**

---

## 4. 阶段 2：持久化与 Resume ⬜

### 核心目标

从「能干活但记不住」变成「记得住、崩了能接上」。

### 研究问题

> 消息级恢复够不够用？哪些工具因为非幂等而无法安全 resume？

### 做完是什么样子

transcript 落 SQLite。关掉终端明天再开，`resume` 能接上昨天那个 Run。Artifact 有登记，Replay 能从 transcript 任意一条消息重放，故障注入 Eval 全集能跑。

**同时接上 DeepSeek Anthropic 端点做对照测试**——把 Runtime 产出的请求打到一个真正会校验的端点上，是一次免费的正确性检查。

### 范围

SQLite transcript、Blob；timeout / cancel / retry / error taxonomy 全集；Capability live lease（含 PARKED）、Policy、Approval；`resume()` 与 Recorded Replay；Artifact Registry；数据保留与 GC 最小实现；故障注入 Eval 全集；端点能力回归 ＋ DeepSeek 对照测试。

### 退出门槛

三个 crash 窗口、cancel race、未配对 tool_use 的三条处置分支均有可重复验证；对照端点未发现自持逻辑的系统性缺陷。

### 本阶段真正要回答的问题

比退出门槛更重要的一条：

> 跑够多真实任务，**统计有多少次 `resume()` 落进了「非幂等且不可观察」那条分支。**

比例低到可忽略，说明当前消息级恢复粒度选择成立；比例不低，再考虑把恢复粒度往细里推。

**但那时会有真实数据支撑，而不是推演。**

---

## 5. 阶段 3：Case 01 网页归档 ⬜

### 核心目标

第一个真实业务 Case 端到端，并且**跟确定性 Workflow Baseline 比一次**。

### 做完是什么样子

登录态网页抓下来，归档成 Markdown ＋ Manifest ＋ Report ＋ ZIP，Action 级与 Artifact 级两层 Verification 通过。

浏览器 Capability 有并发 lease，登录态经 RedactionProfile 处理，遇到验证码能人工接管（PARKED lease 全链路），长媒体下载能取消、能报进展，大结果外置到 Blob 再按需取回。

**Workspace × Endpoint 数据边界在这一阶段落地**——因为这是第一次有真正敏感的内容要发给第三方端点。

### 判据

> **Agent 编排相对确定性 Baseline 是否有增益？**

这是整个项目「Agent 到底值不值」的第一次真实回答。没有这个对比，Case 01 只证明了「能做」，没证明「值得用 Agent 做」。

⚠️ **V05 §28.4 将这一判据标为当前倾向，正式研究问题与退出门槛仍待补齐。** 真走到这一阶段之前应当完成冻结。

---

## 6. 阶段 4 及以后 ⬜

### 核心目标

用第二个 Case **反证抽象**——看前三阶段抽出来的东西是真通用，还是只是 Case 01 的形状。

### 内容

- **Case 02**：倾向 Git 仓库分析与技术方案生成，但需先按上位基线 §10.4 写出完整 Case 定义才谈得上取舍（对应决策点 D-11）
- **桌面产品化 ＋ Trace / Eval Inspector**：GUI 在这里，不在之前

### 一条明确的抑制规则

高级 Context、Memory、Planner、Verifier Strategy、Sub-agent——**只有 Eval 证明需要时才引入**。

⚠️ 同阶段 3，本阶段研究问题与退出门槛尚未写明。

---

## 7. 阶段 1 的决策状态（已全部清空）

| 决策点 | 结论 |
|---|---|
| **D-01** ActionBatch 批内并发 | 接口按并发设计，v0.1 实现 `SEQUENTIAL`，理据是 Runtime 自持 |
| **D-05** 上下文不可压缩时的默认动作 | 更激进 Compact，不足则 `DETERMINISTIC` handoff |
| **D-07** `ModelProtocolPort` 吸收哪类差异 | 形状切分适配器 ＋ 端点级能力声明 |
| **D-16** v0.1 主力端点 | 百炼 Anthropic 形状 |
| **D-14** 阶段 1 实现哪些 Port | 10 个实现，4 个只留接口 |
| **D-17** 端点声明最小字段集 | `protocol` + `context` + `tokens` 三组 |
| **D-20** `LoopState` 字段集 | 参照 `query.ts` 的十字段量级，大对象外置 |
| **D-21** 批结算默认值 | `CONTINUE_REMAINING` / `CONTINUE_REMAINING` / `ABORT_UNSTARTED` |
| **D-22** 错误记录维度切面 | 四维全保留，值域裁剪到 Micro Case 能触发的 |
| **D-23** Micro Case 具体任务 | 推迟；但**必须有一个可控慢的工具** |
| **D-24** `resume()` 进阶段 1 | 进 |
| **D-25** 工程基线 | Node ＋ npm，不写单测，人工验证 |

**三个决策点被取消而非回答**（前提消失）：D-03（验收标准来源）、D-15（KernelState 序列化边界）、D-08（Timer 真定时器 vs 惰性）。

详见架构设计 §30。

---

## 8. 相关文档

| 文档 | 作用 |
|---|---|
| `方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md` | 上位基线 v0.4，项目目标与上位原则的冲突以此为准 |
| `架构设计/WorkAgent架构设计_V20260823_05.md` | **当前架构设计与本 Roadmap 的直接来源** |
| `架构设计/WorkAgent架构设计_V20260823_04.md` | 过程记录，已被 V05 取代，不再作为实现依据 |
| `WorkAgent调研/ProviderProtocolFacts_V20260822.md` | Spike 0 第一、二轮实测事实 |
| `WorkAgent调研/ProviderProtocolFacts_V20260823_R3.md` | Spike 0 第三轮实测事实 |
| `ADR/` | 各阶段决策记录 |
| `架构设计/V03_Spike0回填清单.md` | ⚠️ 结论已被后续实测修正并吸收进 V05，仅作过程记录，**不再作为实现依据** |
