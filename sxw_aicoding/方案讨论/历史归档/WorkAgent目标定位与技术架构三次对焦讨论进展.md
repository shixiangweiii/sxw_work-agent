# WorkAgent 项目目标定位与技术架构讨论基线

> 文档版本：v0.4
> 更新日期：2026-08-21
> 文档定位：当前唯一有效的上位讨论基线
> 当前阶段：目标与架构原则对焦，尚未进入正式编码阶段
> 适用范围：项目目标、决策原则、架构边界、评测体系与推进顺序

## 1. 文档目的与决策状态

本文档是 WorkAgent 当前唯一有效的上位讨论基线，不依赖其他历史讨论文件即可独立阅读。

本文用于回答：

1. 项目的第一目标和最终目标是什么；
2. 技术决策发生冲突时按什么原则取舍；
3. “生产级 Agent Harness”在本项目中具体指什么；
4. Harness Kernel、Runtime Services、Eval Lab 和具体 Case 如何分层；
5. 哪些能力必须自研，哪些基础设施应该复用；
6. Eval 为什么是 P0，以及如何避免它污染 Runtime Kernel；
7. 网页归档和后续真实任务如何驱动而不绑死架构；
8. 面向个人使用时如何兼顾低摩擦和灾难性错误防护；
9. 后续讨论和实现应该按什么顺序推进。

文中结论使用以下四种状态：

- **已拍板**：当前上位原则，不再反复讨论；
- **当前方向**：已有明确倾向，但需要通过详细设计或实验验证；
- **待讨论**：尚未形成结论；
- **明确非目标**：当前阶段不进入范围。

## 2. 项目北极星

### 2.1 最新定义

> **自研一个面向真实办公任务、Case 无关、可观察、可恢复、可实验评测的生产级 Agent Harness；通过亲自实现其核心机制完成系统性学习，并用个人真实任务持续检验和提升效果，最终形成可供个人长期使用的桌面 Work Agent。**

这里的“Case 无关”是一条依赖规则，而不是尚未被证明的万能性承诺：Harness Core 不得依赖网页归档、Git、钉钉或 Office 等具体业务语义；其抽象是否真正通用，必须由多个差异化 Case 持续反证。

### 2.2 四层项目价值

1. **Agent Harness 学习项目**：系统理解并实现生产级 Harness 核心机制；
2. **Agent 实验平台**：能够替换策略、记录轨迹、复现实验和比较效果；
3. **真实任务执行器**：使用个人办公场景持续暴露真实问题；
4. **个人桌面产品**：最终形成可长期使用的 Work Agent，而不是研究 Demo。

个人产品与实验平台不是两个项目。个人产品提供真实任务和失败样本，实验平台帮助持续改进个人产品效果。

## 3. 已拍板的四项核心决策

### 3.1 学习是项目第一目标

本项目的终极目标是：

> 通过自研个人 Work Agent，系统学习生产级 Work Agent Harness 的核心原理和关键技术实现，形成真正可解释、可实现、可验证的工程能力，从而提高面试成功率。

因此，不能为了快速得到功能结果，把 Agent Loop、Context、Tool Runtime、状态管理、恢复和评测等核心问题整体交给外部 Agent 框架。

### 3.2 追求任务效果和技术先进性

项目仅服务作者个人，没有外部用户和交付日期，因此：

- 不以最快上线为目标；
- 不为了节省少量 Token 牺牲任务效果；
- 可以使用更强模型、更充分的推理预算、多轮验证和必要重试；
- 可以投入时间研究具有长期学习价值的核心问题；
- 不承担企业级多用户产品的治理和兼容成本。

但“没有交付压力”不等于无边界扩张，“技术先进”也不等于组件最多或抽象最复杂。

先进方案必须满足：

1. 解决真实 Harness 问题；
2. 能被观察、解释和实验验证；
3. 在真实 Case 集上提高效果或可靠性；
4. 具有明确学习和面试表达价值；
5. 复杂度与收益匹配。

### 3.3 网页归档只是首个真实 Case

使用 Chrome 登录态完成网页正文整理、媒体下载和 ZIP 归档，仍然是首个端到端 Case，但它不代表 WorkAgent 的最终边界，也不能反向定义 Harness Core。

后续将增加差异更大的真实 Case，例如：

- 本地多文件搜索、分析、编辑和整理；
- Git 仓库分析与技术方案生成；
- 故障排查和证据整理；
- 钉钉 DWS 与内部知识库任务；
- Word、Excel、PPT、PDF 等 Office 文档处理。

### 3.4 外部项目不具有规范性约束

OpenWork、OpenCode 或其他 Agent 产品可以作为调研材料、黑盒基线和灵感来源，但不能直接决定本项目的产品模型、领域模型、进程架构和技术栈。

所有技术决策必须从以下事实独立推导：

- 学习目标；
- 个人使用约束；
- 真实任务效果；
- Harness 核心问题；
- 可观察、可恢复、可评测要求；
- 当前 Case 的实际能力需求。

## 4. 决策优先级与冲突处理

### 4.1 总体优先级

1. **学习与面试价值**；
2. **真实任务效果**；
3. **可观察、可评测和可演进性**；
4. **个人使用体验**；
5. **实现速度和工程成本**；
6. **Token 与模型调用成本**。

Token 和耗时仍然需要记录，因为它们可以暴露无意义循环、上下文膨胀和策略退化，但不是主要优化目标。

### 4.2 学习目标与效果目标冲突时

使用以下分区规则处理：

- **Harness 核心机制**：学习优先，必须亲自研究和实现；
- **通用基础设施与业务 Adapter**：效果优先，复用成熟实现；
- **Harness 内部策略选择**：通过 Eval 比较效果和复杂度；
- **外部成熟 Agent**：可以作为黑盒对照组，但不替代自研 Harness Core。

允许自研 Harness 在早期暂时弱于成熟外部方案，但必须通过可重复实验识别差距并逐步改进，而不能用“学习项目”回避效果验证。

### 4.3 阶段划分的目的

无交付压力不代表不做阶段划分。阶段划分用于：

- 每次集中研究一个主要问题；
- 控制实验变量；
- 尽早暴露错误抽象；
- 形成可复盘的学习闭环；
- 防止研究范围同时向所有方向扩张。

## 5. “生产级”的三层含义

### 5.1 Harness Kernel 不变量

Kernel 只包含每个 Agent Run 都必须依赖的最小执行语义：

- Run Controller 与 Agent Loop；
- 明确的继续、等待、完成、失败和取消语义；
- Context Assembly 与上下文来源追踪；
- Model Invocation 与结构化响应规范化；
- Tool Call 到 Action 的转换；
- Action 生命周期与执行结果回填；
- Observe → Decide → Act → Verify 的基本决策步骤；
- 停止条件、无进展检测和失控保护；
- 向外输出规范化 Trace 的能力。

Kernel 不包含网页、Markdown、Git、钉钉、Office 等 Case 语义，也不依赖 Electron、Eval Dataset 或具体模型厂商协议。

### 5.2 生产级 Runtime Services

Runtime Services 为 Kernel 提供可靠运行能力：

- Durable State、Event、Snapshot、Resume 和 Replay；
- Tool Registry、Schema 校验、超时、取消和错误分类；
- Tool 重试、幂等、执行前后验证和恢复语义；
- Capability Grant、Policy、Approval 和副作用控制；
- Artifact 注册、验证、来源和版本关系；
- Trace 存储、诊断信息和敏感信息脱敏；
- 大 Tool Result 的外置、引用和 Compact；
- Provider、Storage、Browser、Git、MCP、DWS 等 Adapter。

### 5.3 可插拔的高级实验策略

以下能力具有重要学习价值，但不是所有 Agent 都必须启用的 Kernel 不变量：

- 显式 Planning；
- Planner / Executor / Verifier 分工；
- 自我反思和二次验证；
- 跨 Run Memory；
- 模型路由和推理预算策略；
- Sub-agent 与并行执行；
- 更高级的 Context 检索和 Compact。

这些能力是否引入、以什么形式引入，由学习价值、真实 Case 需求和 Eval 结果共同决定，不能因为“看起来先进”就预设进 Kernel。

### 5.4 当前不属于生产级目标

- 多租户；
- 企业 SSO、RBAC 和组织权限体系；
- 商业计费、配额和 FinOps；
- 管理后台；
- 多端同步；
- 云端 Runtime；
- 自动发布、签名、公证和商业化更新体系；
- 为假想用户设计的兼容性；
- 为尚不存在的第二个 Agent Engine 设计万能 Adapter。

生产级指 Harness 核心语义和运行质量达到真实可用、可解释、可恢复的标准，不等于补齐企业软件的所有外围设施。

## 6. 总体架构边界

```text
┌──────────────────────────────────────────────┐
│ Eval Lab                                     │
│ Case / Dataset / Experiment / Grader         │
│ Regression / Live / Fault-injection Suites   │
└──────────────────────┬───────────────────────┘
                       │ RunSpec / Result
                       ▼
┌──────────────────────────────────────────────┐
│ Harness Runtime                              │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Kernel                                 │  │
│  │ Loop / Context / Action / Verification │  │
│  └───────────────────┬────────────────────┘  │
│                      │                       │
│  ┌───────────────────▼────────────────────┐  │
│  │ Runtime Services                       │  │
│  │ Persistence / Trace / Policy /         │  │
│  │ Approval / Artifact / Recovery         │  │
│  └───────────────────┬────────────────────┘  │
└──────────────────────┼───────────────────────┘
                       │ Tool / Capability Contract
                       ▼
┌──────────────────────────────────────────────┐
│ Case Packages                                │
│ Web Archive / Local Files / Git / DWS /      │
│ Knowledge / Office                           │
└──────────────────────────────────────────────┘

CLI / Desktop / Test Runner 均通过同一 Runtime Contract 使用 Harness。
```

### 6.1 Eval 是 P0，但不属于 Kernel

Eval 必须从项目早期建设，但 P0 不等于 Kernel：

- Kernel 负责执行 Run 并输出规范化 Trace、Artifact 和状态；
- Runtime 保存不可变的 AgentSpec/RunSpec 快照；
- Eval Lab 负责批量运行 Case、组织 Experiment、调用 Grader 和比较结果；
- 生产 Runtime 不依赖 Dataset、Experiment 或 LLM Judge；
- Eval 与 Runtime 通过稳定 Contract 协作，而不是互相混入领域模型。

### 6.2 Case 无关的依赖规则

- Kernel 和 Runtime Services 不得 import 具体 Case 代码；
- Case 通过 Tool、Skill、Capability、Adapter 和验收规则接入；
- 先定义必要的最小通用 Contract，不提前设计万能接口；
- 第二个差异化 Case 出现后，再验证和抽取更高层抽象。

### 6.3 桌面端边界

已拍板的是：Headless Runtime 必须独立于桌面框架。

Electron 当前只是桌面宿主的候选方向，不是 Harness 的运行前提。是否最终采用 Electron、采用何种 UI 布局，以及 Main 与 Runtime 使用何种通信协议，仍需独立论证。

## 7. 自研与复用边界

### 7.1 必须亲自研究和实现

- Harness Kernel；
- Run 状态机和 Action 生命周期；
- Context 构建、引用、裁剪和 Compact 策略；
- Tool Runtime、Policy、Approval 和恢复语义；
- Durable Execution、Persistence、Resume 和 Replay；
- 规范化 Trace Contract；
- Eval Lab 的核心实验组织和对比能力；
- Artifact 领域语义；
- 后续被实验验证需要的 Planning、Verification、Memory 和 Sub-agent 调度策略。

### 7.2 优先复用成熟基础设施

- 模型 Provider 官方 SDK；
- MCP SDK 与协议实现；
- SQLite 驱动、Migration 工具和成熟序列化库；
- JSON Schema 等通用校验能力；
- Chrome Extension、Native Messaging 和 CDP 等标准能力；
- Git、HTTP、压缩、Checksum、文件格式和媒体处理库；
- 钉钉 DWS 等已有业务能力；
- Electron、React 等可能采用的桌面产品基础设施。

自研的判断标准不是“能否自己写”，而是“亲自实现它是否有助于掌握 Agent Harness 的核心知识”。

## 8. 核心运行语义

### 8.1 AgentSpec 与 RunSpec

为了支持审计、恢复和实验比较，需要区分：

- **AgentSpec**：可版本化的 Agent 配置，包括模型、System Prompt、Tool、Skill、Context Policy、Loop Policy 和 Approval Policy；
- **RunSpec**：某次执行开始时生成的不可变快照，包括任务输入、AgentSpec 内容或哈希、Capability Grant、预算、环境指纹和启动来源。

Run 启动后不能因为全局 Prompt、Tool Schema 或模型配置发生变化而悄悄改变语义。重新使用新配置执行同一任务，应创建新的 Run。

### 8.2 基本决策步骤

```text
Observe current state
        ↓
Assemble context
        ↓
Model decides
        ↓
Normalize Tool Call
        ↓
Prepare Action
        ↓
Policy / Approval
        ↓
Execute Action
        ↓
Observe result and environment
        ↓
Verify postcondition
        ↓
Continue / Wait / Complete / Fail
```

Tool 返回“执行成功”不自动等于任务状态已经正确改变。对重要副作用，应通过文件状态、页面状态、返回对象或其他后置条件进行验证。

### 8.3 Action 生命周期

后续详细设计至少需要区分：

- 模型提出的 Tool Call；
- 经过 Schema 和 Policy 处理后的 Action；
- 一次或多次 Execution Attempt；
- Tool Result；
- 对环境重新观察得到的 Observation；
- Postcondition Verification；
- 必要时的 Compensation 或 Manual Recovery。

这一区分是正确重试、幂等、恢复和审计的基础。

### 8.4 失控保护

Token 成本不是主要目标，但生产级 Runtime 仍需防止失控：

- 最大决策步数；
- 最大连续失败次数；
- 无进展检测；
- 最大墙钟时间；
- Tool 超时和取消；
- 可配置的 Token 或调用预算；
- 用户暂停和取消；
- 必要时升级为等待用户。

这些限制的目标是可靠性和可控性，不是单纯节省费用。

## 9. Eval Lab：P0 实验与评测体系

### 9.1 Eval 需要回答的问题

- 任务最终是否完成；
- 结果是否正确、完整和可用；
- Agent 是否选择了合适的工具和步骤；
- 失败后是否正确重试、降级、等待用户或终止；
- Artifact 是否通过确定性校验；
- Context 是否遗漏关键信息或被无关内容污染；
- Planning、Verification 或更多推理预算是否真实改善效果；
- 相同配置多次运行的成功率和失败分布如何；
- 某次变更改善了哪些 Case，又破坏了哪些 Case。

### 9.2 三类 Eval Suite

#### 稳定回归集

- 受控网页、固定文件和确定性环境；
- 用于发现 Prompt、Tool、Context 和 Runtime 改动造成的退化；
- 尽量使用确定性 Grader。

#### 真实世界集

- 登录态网页和作者真实办公任务；
- 允许外部环境变化和结果波动；
- 用于测量实际效果，而不是承诺完全可复现。

#### 故障注入集

- Tool 超时、断网和限流；
- Runtime 或宿主进程崩溃；
- 重复消息和重复执行；
- 磁盘空间不足或文件冲突；
- 用户拒绝、暂停和恢复；
- 用于验证 Durable Execution 和恢复语义。

### 9.3 每次 Experiment 至少记录

- Case、Dataset 和输入版本；
- AgentSpec 与 RunSpec；
- Provider、模型和参数；
- Prompt、Skill、Tool Schema 和 Adapter 版本；
- Context、Compact、Loop、Retry 和 Verification 策略；
- Capability Grant 和环境指纹；
- 规范化 Run Trace；
- Tool 输入输出、错误和 Artifact 引用；
- 确定性检查结果；
- 可选的 LLM Judge 结果；
- 必要时的人工评价；
- Token、耗时、调用次数和失败分类。

完整 Trace 不等于无条件保存所有原始内容。Cookie、Token 和浏览器凭证不进入 Trace；大结果通过脱敏摘要、哈希和 Artifact 引用保存。

### 9.4 Grader 优先级

1. 确定性规则和 Artifact 校验；
2. 结构化部分得分；
3. 经过人工样本校准的 LLM Judge；
4. 必要的人工评价。

LLM Judge 只用于摘要质量、方案质量等难以完全确定性判断的维度，不是每个 Experiment 的强制依赖。

### 9.5 评价优先级

1. 最终任务结果；
2. 正确性、完整性和鲁棒性；
3. 失败恢复和行为合理性；
4. 用户体验；
5. 耗时和调用次数；
6. Token 成本。

### 9.6 不把轨迹复杂度当作效果

Harness 必须支持多轮模型与 Tool 交互，但具体任务不要求为了展示 Agent 能力而强制发生多轮调用。

如果一次正确判断和一次确定性 Tool 执行已经足够，就不应人为拆成多轮。多轮循环、重试、Approval 和恢复通过专门的 Micro Case、故障注入和确实需要这些能力的真实任务验证。

## 10. Case 组合与架构反证

### 10.1 Case 01：登录态网页归档

网页归档适合验证：

- Chrome 登录态和浏览器控制；
- 不可信网页内容；
- 动态页面和人工接管；
- 长时间媒体下载；
- Tool 失败、重试和恢复；
- Markdown、Manifest、Report 和 ZIP Artifact；
- 确定性完整性验证。

但网页归档的大部分步骤可以由确定性 Pipeline 完成，因此它主要是 Runtime 可靠性综合 Case，不能独立证明 Agent 的规划和决策效果。

网页归档评测应至少包含：

- 一个确定性 Workflow Baseline；
- 一个由 Agent 自适应编排的实现；
- 对动态页面、异常处理、人工接管和降级决策的对比；
- 对“使用 Agent 是否真实带来增益”的结论。

### 10.2 Harness Micro Cases

在完整网页归档之前，使用小而可控的 Case 单独验证：

- 多 Tool 选择；
- 信息不足时请求用户输入；
- Tool Schema 错误和自动修正；
- Tool 失败后的替代路径；
- 执行后的环境验证；
- Approval 的拒绝与恢复；
- 中途崩溃后的继续执行；
- 无进展检测和安全停止。

Micro Case 用于学习和隔离变量，不承担产品价值证明。

### 10.3 Case 02 的选择标准

在冻结更高层通用接口前，应选定一个与网页归档差异明显、推理和决策更重的 Case 02。它可以先定义需求、样本和验收规则，不要求立即完整实现。

Case 02 应尽量覆盖：

- 多来源信息收集和取舍；
- 动态规划与步骤调整；
- 多文件或多系统操作；
- 可验证的中间结果；
- 至少一种可逆写操作或外部副作用；
- 与网页归档不同的 Artifact；
- 对 Context、Planning 或 Verification 提出真实需求。

### 10.4 每个真实 Case 的定义

- 任务目标和输入；
- 环境与授权条件；
- 可用 Capability、Tool 和 Skill；
- 确定性或半确定性 Baseline；
- 预期 Artifact；
- 验收规则和评分维度；
- 可接受的降级行为；
- 故障注入与恢复场景；
- 人工评价维度；
- 已知限制和明确非目标。

## 11. 面向个人的宽松安全策略

### 11.1 已拍板原则

本项目不需要企业级安全和频繁审批，但不能删除 Policy、Approval、Capability 边界、凭证隔离和审计机制。

默认策略可以命名为：

```text
trusted_personal
```

它是可替换的 Policy Preset，不是写死在 Kernel 中的安全假设。

### 11.2 优先使用可逆性降低审批摩擦

相比所有写操作都询问用户，优先采用：

- dry-run；
- 修改前生成 diff；
- 写入 staging；
- 覆盖前自动备份；
- 原子替换；
- 执行后验证；
- 可补偿动作；
- 只有不可逆或高影响动作才请求 Approval。

### 11.3 建议默认放行

- 已授权 Workspace 内的常规文件读取；
- 已授权 Workspace 内可恢复的创建和修改；
- 常规网页读取和内容提取；
- 无外部副作用的 Shell 与 Git 只读操作；
- 常规下载、压缩、校验和 Artifact 生成；
- 正常范围内的模型调用和 Token 消耗。

### 11.4 建议拦截或确认

- 递归删除、大范围删除和不可恢复覆盖；
- Workspace 或显式授权目录之外的写操作；
- 可能丢失未提交内容的 Git 操作；
- Cookie、Token、浏览器存储和其他凭证进入模型或 Trace；
- 上传本地文件或向外部系统发送数据；
- 发送钉钉消息、邮件、提交审批等外部副作用；
- 来自网页内容的指令直接驱动高影响 Tool；
- 其他不可逆或难以恢复的动作。

### 11.5 Tool Contract 需要表达的安全与恢复语义

- 副作用类型和作用域；
- 所需 Capability；
- 是否幂等；
- 是否可安全重试；
- 是否可逆；
- 是否支持 dry-run；
- Compensation 方式；
- Postcondition Verification；
- Approval 要求；
- 超时、取消和恢复策略。

## 12. 学习成果与阶段验收

学习是第一目标，因此每个阶段除了功能结果，还应形成一条可用于复盘和面试表达的证据链。

每个主要研究问题至少产出：

1. **Problem**：要解决的 Harness 问题；
2. **Hypothesis**：对原因和方案的假设；
3. **Alternatives**：至少两个候选方案及取舍；
4. **Implementation/Prototype**：用于验证的最小实现或实验；
5. **Eval Evidence**：可重复的结果和失败样本；
6. **ADR**：最终决策、适用条件和代价；
7. **Postmortem**：重要失败和架构修正；
8. **Interview Narrative**：能够清晰解释问题、方案、权衡和证据。

阶段完成不以“写了多少代码”判断，而以是否真正回答了该阶段的研究问题判断。

## 13. 当前技术决策状态

### 13.1 已拍板

- 学习和面试价值是第一目标；
- Harness 核心机制必须自研；
- 真实任务效果高于交付速度和 Token 成本；
- Headless Runtime 不依赖 Electron；
- Eval 是 P0，但 Eval Lab 位于 Runtime 外部；
- Kernel 不依赖具体 Case；
- 网页归档是 Case 01，不是产品边界；
- 使用 `trusted_personal` 类型的宽松 Policy Preset；
- Cookie、Token 和浏览器凭证不进入模型上下文与 Trace；
- 不为 OpenWork、OpenCode 或其他假想外部 Engine 提前设计 Adapter；
- 高级策略是否引入由真实 Case 和 Eval 决定。

### 13.2 当前方向

- TypeScript/Node 实现 Harness Runtime；
- 使用最小 CLI 和 Eval Runner 驱动同一个 Runtime；
- SQLite 作为本地持久化候选；
- 采用事件日志、事实表和 Snapshot 的混合持久化，而非追求纯 Event Sourcing；
- Durable Event 与流式 Transient Event 分离；
- Artifact 是一等领域对象；
- 使用粗粒度语义 Tool，确定性细节在 Tool 内执行；
- Chrome 登录态通过受控 Browser Capability 暴露；
- Electron + React 作为桌面宿主候选。

### 13.3 待讨论

- Kernel、Runtime Services 和 Adapter 的精确 Contract；
- AgentSpec、RunSpec、Run、Task、Conversation 的最终边界；
- Command、Event、Snapshot 和事实表的具体关系；
- Tool Call、Action、Execution Attempt、Observation 和 Verification 的详细模型；
- Runtime 进程协议和生命周期管理；
- Browser Capability 的 DOM、Content Script、CDP 与 Native Messaging 组合；
- Case 02 的具体选择；
- Planning、Verifier、Memory 和 Sub-agent 的引入时机；
- Electron 是否最终采用及 UI 产品形态。

### 13.4 明确非目标

- 快速复刻现有 Work Agent 产品；
- 使用外部框架替代 Harness Core；
- 多用户与企业治理；
- 云端 Runtime 和多端同步；
- 多 Agent 作为首期默认架构；
- Skill 市场；
- 为外部 Engine 做假想兼容；
- DRM 和其他明显不适合个人研究范围的能力。

## 14. 最新推进顺序

推进采用“先确定不变量，再用薄切片验证”的方式，避免在没有运行证据前冻结全部领域对象。

### 阶段 0：讨论基线与实验协议

- 固化目标、边界和决策状态；
- 对齐 Kernel / Runtime Services / Eval Lab 分层；
- 定义最小 AgentSpec、RunSpec、Trace 和 EvalCase Contract；
- 确定 Case 01；
- 选定 Case 02 的类型和验收轮廓；
- 形成第一批 ADR。

退出证据：能够解释为什么这样分层，以及每层不应该包含什么。

### 阶段 1：Headless Walking Skeleton

- 最小 Agent Loop；
- Fake 或受控 Provider；
- 简单 Tool Registry；
- 内存状态和结构化 Trace；
- CLI；
- 最小 Eval Runner；
- Harness Micro Cases。

退出证据：Observe → Decide → Act → Verify 闭环可运行，且轨迹可以被评测。

### 阶段 2：生产级 Durable Runtime

- Run 状态机；
- SQLite 持久化；
- Event、事实表和 Snapshot；
- Tool 超时、取消、重试和错误分类；
- Policy、Approval 和 `trusted_personal`；
- Artifact Registry；
- Crash Resume 与 Replay；
- 故障注入 Eval。

退出证据：关键故障可以被复现、解释和安全恢复。

### 阶段 3：Case 01 网页归档

- Browser Capability；
- Chrome 登录态 Bridge；
- 正文提取与媒体收集；
- Markdown、Manifest、Report 和 ZIP；
- 确定性 Workflow Baseline；
- Agent 自适应编排；
- 稳定回归集、真实世界集和故障注入集；
- 多配置重复实验。

退出证据：能用数据说明 Agent 在哪些环节产生价值，在哪些环节不应替代确定性程序。

### 阶段 4：Case 02 与架构反证

- 接入推理和决策更重的第二类任务；
- 检查 Core 是否泄漏网页归档语义；
- 检查 Tool、Skill、Capability、Workspace 和 Artifact 抽象；
- 根据两个真实 Case 重构；
- 判断是否需要 Planning、Verifier 或更复杂策略。

退出证据：通用 Contract 得到第二个 Case 支持，或有明确反例并完成修正。

### 阶段 5：桌面产品化

- Task、Run 和 Transcript；
- Tool、Approval 和 Artifact UI；
- Trace 与 Eval Inspector；
- Runtime Supervisor；
- 个人长期使用体验。

退出证据：作者能够在真实工作中持续使用并收集失败样本。

### 阶段 6：基于评测结果增强

- 更高级的 Context 和 Compact；
- 跨 Run Memory；
- Planner / Executor / Verifier；
- Sub-agent 和并行执行；
- 更多办公 Capability 和真实 Case。

退出证据：新增策略在目标 Case 上产生可测量收益，并且复杂度可解释。

## 15. 下一轮优先讨论事项

在正式编码前，下一轮建议依次对焦：

1. **Kernel / Runtime Services / Eval Lab 的精确职责和依赖方向**；
2. **最小 AgentSpec、RunSpec、Trace、EvalCase Contract**；
3. **Observe → Decide → Act → Verify 与 Action 生命周期**；
4. **Case 02 的具体选择和验收轮廓**；
5. **Run 状态机与 Durable Execution 边界**；
6. **Tool Contract 与 `trusted_personal` Policy**；
7. **Task、Conversation、Run、Artifact 等产品领域对象**。

不要求在第一段实验代码前一次性冻结所有类和协议。先拍板不可违反的架构原则，再通过薄切片和 Micro Case 迭代领域模型。

## 16. 当前结论

```text
学习生产级 Harness
        ↓
自研 Case 无关的 Harness Core
        ↓
把可靠执行能力放入 Runtime Services
        ↓
把 Eval Lab 作为 Runtime 外部的 P0 系统
        ↓
用 Micro Cases 隔离验证核心语义
        ↓
用网页归档检验可靠性和 Agent 实际增益
        ↓
用差异化 Case 反证和演进抽象
        ↓
在个人宽松信任策略下追求最佳任务效果
        ↓
最终形成个人长期使用的桌面 Work Agent
```

当前最重要的三项架构结论是：

1. **Eval 是 P0 系统能力，但 Eval Lab 不属于 Harness Kernel。**
2. **网页归档是 Runtime 可靠性综合 Case，需要确定性 Baseline 和推理型 Case 补足 Agent 效果评测。**
3. **生产级 Kernel 不变量、Runtime Services 与可插拔高级策略必须分层，避免把所有先进能力预设进 Core。**

下一轮讨论中心是：

> **Kernel、Runtime Services 与 Eval Lab 之间最小且稳定的 Contract 应该是什么。**
