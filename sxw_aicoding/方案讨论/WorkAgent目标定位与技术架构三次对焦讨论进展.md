# WorkAgent 目标定位与技术架构三次对焦讨论进展

> 文档状态：讨论基线 v0.3  
> 讨论日期：2026-08-21  
> 当前阶段：重新固化项目目标、架构优化函数与评测定位，尚未进入编码阶段  
> 目标读者：项目作者、后续参与需求与架构讨论的开发者

## 1. 文档目的

本文档整理在《WorkAgent 需求与技术架构二次反思讨论进展》基础上形成的最新决策与对焦结果。

本轮讨论没有推翻“自研 Agent Harness”的主方向，但进一步改变了项目进行技术决策时的优化目标：项目不再围绕首个网页归档用例或任何现有开源产品组织架构，而是围绕“学习生产级 Agent Harness 核心原理并获得真实任务效果”组织架构。

本文重点回答：

1. 项目的第一目标和最终目标是什么；
2. “生产级 Agent Harness”在本项目中具体指什么；
3. 产品效果、开发速度、安全和 Token 成本如何排序；
4. Eval 为什么必须成为 P0 核心能力；
5. 网页归档及后续真实 Case 在架构中处于什么位置；
6. OpenWork 等调研材料应如何影响技术决策；
7. 昨天的讨论结论中，哪些保留、哪些调整、哪些需要重新论证；
8. 下一轮应该先讨论什么。

本文是新的上位讨论基线。与 v0.2 冲突的部分以本文为准；本文未涉及的网页归档细节、领域对象候选、事件协议候选等内容，仍可继续参考 v0.2，但不自动视为已拍板结论。

## 2. 本轮新增的四项核心决策

### 2.1 学习是项目第一目标

本项目的终极目标是：

> 通过自研个人 Work Agent，系统学习生产级 Work Agent Harness 的核心原理和关键技术实现，形成真正可解释、可实现、可验证的工程能力，从而提高面试成功率。

个人生产力提升是非常重要的真实价值，但同时也承担实验场和评测场的作用。它不是要求项目尽快交付的外部产品压力。

因此，本项目必须坚持自研 Harness 核心，而不能为了快速得到功能结果，把 Agent Loop、上下文管理、工具调度、状态管理、恢复、评测等核心问题整体交给外部 Agent 框架。

### 2.2 追求效果和先进性，不以速度与 Token 成本为主要约束

项目仅服务作者个人，没有外部用户和交付日期，因此：

- 不以最快上线为目标；
- 不需要为了节省少量 Token 牺牲任务效果；
- 可以使用更强的模型、更充分的推理预算、多轮验证和必要的重试；
- 可以投入时间研究具有长期学习价值的核心问题；
- 不需要承担企业级多用户产品的治理和兼容成本。

但“没有交付压力”不等于可以无边界扩张，“技术先进”也不等于组件最多或抽象最复杂。

本项目对先进方案的判断标准是：

1. 是否解决真实 Agent Harness 问题；
2. 是否能够被观察、解释和实验验证；
3. 是否在真实 Case 集上提高任务效果或可靠性；
4. 是否具有明确的学习和面试表达价值；
5. 复杂度是否与收益匹配。

### 2.3 网页归档只是首个评测 Case

使用 Chrome 登录态完成网页正文整理、媒体下载和 ZIP 归档，仍然是首个纵向 Case，但它不代表 WorkAgent 的最终边界，也不能反向定义 Agent Core。

后续将继续补充更丰富、差异更大的真实 Case，用于检验 Harness 的通用性和任务效果，例如：

- 本地多文件搜索、分析、编辑和整理；
- Git 仓库分析与技术方案生成；
- 故障排查和证据整理；
- 钉钉 DWS 与内部知识库任务；
- Word、Excel、PPT、PDF 等 Office 文档处理。

具体 Case 顺序后续根据作者真实工作需要确定。

### 2.4 OpenWork 不具有技术决策约束力

OpenWork 只是此前调研过的一个产品化案例，不代表本项目的产品模型、领域模型、进程架构或技术栈决策。

后续所有技术决策必须从以下事实独立推导：

- 学习目标；
- 个人使用约束；
- 真实任务效果；
- Harness 核心问题；
- 可观察、可恢复和可评测要求；
- 当前 Case 的实际能力需求。

OpenWork、OpenCode 或其他 Agent 产品可以作为对比材料和灵感来源，但不能作为“因为它这样做，所以本项目也这样做”的论据。

## 3. 项目的最新北极星定义

项目最新定义为：

> **自研一个面向真实办公任务、场景无关、可观察、可恢复、可实验评测的生产级 Agent Harness；通过亲自实现其核心机制完成系统性学习，并用个人真实任务持续检验和提升效果，最终形成可供个人长期使用的桌面 Work Agent。**

这一定位包含四层价值：

1. **Agent Harness 学习项目**：系统理解并实现生产级 Harness 核心机制；
2. **Agent 实验平台**：能够替换策略、记录轨迹、复现实验和比较效果；
3. **真实任务执行器**：使用个人办公场景持续暴露真实问题；
4. **个人桌面产品**：最终形成可长期使用的 Work Agent，而不是停留在研究 Demo。

“个人产品”和“实验平台”不是两个彼此分离的项目。个人产品提供真实 Case，实验平台帮助持续改进个人产品效果。

## 4. 最新目标优先级

当前技术决策按照以下优先级判断：

1. **学习与面试价值**：是否掌握了生产级 Harness 的关键原理和实现；
2. **真实任务效果**：任务结果是否正确、完整、稳定和有实际价值；
3. **可观察、可评测和可演进性**：是否能解释问题、比较策略并持续改进；
4. **个人使用体验**：是否适合作者自己的日常工作；
5. **实现速度和工程成本**：影响推进顺序，但不是项目成败的首要标准；
6. **Token 与模型调用成本**：作为诊断指标记录，不作为主要优化目标。

无交付压力并不意味着不做阶段划分。阶段划分仍然必要，其作用是控制研究变量、形成反馈闭环和避免同时研究过多问题，而不是为了赶上线日期。

## 5. 本项目所说的“生产级”

### 5.1 属于生产级 Harness 核心的问题

- Agent Loop 与明确的继续、等待、完成和失败语义；
- Run 状态机与合法状态转换；
- Model Invocation、Tool Call、Action 和 Tool Result 的边界；
- Context 构建、裁剪、压缩、引用和来源追踪；
- Tool/Skill/Capability 注册、选择、校验和执行；
- Tool 超时、取消、错误分类、重试、幂等和恢复；
- Durable State、Event、Snapshot、Resume 和 Replay；
- Artifact 注册、验证、来源和版本关系；
- Policy、Approval 和副作用控制；
- Trace、Eval、失败分析和实验对比；
- 多轮任务中的停止条件和失控保护；
- 后续基于真实需求演进的 Memory、Planning、Verifier 和 Sub-agent 机制。

### 5.2 不属于当前生产级目标的问题

- 多租户；
- 企业 SSO、RBAC 和组织权限体系；
- 商业计费、配额和 FinOps；
- 管理后台；
- 多端同步；
- 云端 Runtime；
- 自动发布、签名、公证和商业化更新体系；
- 为假想用户设计的兼容性和配置能力；
- 在没有第二种实现需求前设计万能外部 Agent Engine 抽象。

生产级指 Harness 核心语义和运行质量达到真实可用、可解释、可恢复的标准，不等于补齐企业软件的全部外围设施。

## 6. 自研与复用的最新边界

### 6.1 必须亲自研究和实现

- Run Controller 与 Agent Loop；
- Run 状态机和执行边界；
- Context Engine 与 Compact 策略；
- Tool Runtime、Action、Policy 和 Approval；
- Durable Execution、Persistence、Resume 和 Replay；
- Trace 与 Eval 基础设施；
- Artifact 领域语义；
- 后续需要的 Memory、Planning、Verification 和 Sub-agent 调度核心机制。

### 6.2 应优先复用成熟基础设施

- 模型 Provider 官方 SDK；
- MCP SDK 与协议实现；
- SQLite 驱动、Migration 工具和成熟序列化库；
- JSON Schema 等通用校验能力；
- Chrome Extension、Native Messaging 和 CDP 等标准能力；
- Git、HTTP、压缩、Checksum、文件格式和媒体处理库；
- 钉钉 DWS 等已有业务能力；
- Electron、React 等桌面产品基础设施。

自研的判断标准不是“能否自己写”，而是“亲自实现它是否有助于掌握 Agent Harness 的核心知识”。

## 7. 架构中心的重新确定

最新架构中心不是 Desktop UI，也不是网页归档，而是场景无关的 Harness Kernel。

```text
CLI / Desktop / Test Runner
            │
            ▼
┌─────────────────────────────────────┐
│ Scenario-neutral Harness Kernel     │
│                                     │
│ Run Controller / Agent Loop         │
│ Context Engine                      │
│ Tool Runtime / Policy               │
│ Durable State / Resume / Replay     │
│ Trace / Eval Hooks                  │
│ Artifact Registry                   │
└──────────────────┬──────────────────┘
                   │
        Capability / Tool / Skill
                   │
      ┌────────────┼────────────┐
      ▼            ▼            ▼
  Web Archive   Local Files   Git / DWS / Office
    Case 01       Case 02       Later Cases
```

核心边界原则：

1. Harness Kernel 不包含网页、Markdown、媒体下载等 Case 语义；
2. Case 通过 Capability、Tool、Skill、验收规则和测试样本接入；
3. Electron 只是一个宿主和客户端，不能成为 Runtime 的运行前提；
4. CLI 和 Eval Runner 与桌面端使用同一个 Harness Kernel；
5. Provider 格式、Chrome 协议和钉钉协议通过 Adapter 隔离；
6. 暂时不为 OpenWork、OpenCode 或其他外部 Engine 设计适配层；
7. 只有第二个真实实现出现后，才验证并抽取真正通用的接口。

## 8. Eval 升级为 P0 核心能力

### 8.1 已对齐结论

Eval 必须与 Agent Loop、Context、Tool Runtime 和 Persistence 并列，成为 Harness 的 P0 核心，而不是项目完成后的验收附件。

原因是：不存在一个脱离任务集的静态“最优秀 Agent 架构”。不同模型、Prompt、Tool Schema、上下文策略、Planning、Verification 和 Memory 方案是否有效，必须在真实 Case 上通过实验判断。

### 8.2 Eval 需要回答的问题

- 任务最终是否完成；
- 结果是否正确、完整和可用；
- Agent 是否选择了合适的工具和步骤；
- 失败后是否正确重试、降级、等待用户或终止；
- Artifact 是否通过确定性校验；
- Context 是否遗漏关键信息或被无关内容污染；
- 增加规划、验证或更多推理 Token 是否真实改善效果；
- 相同配置多次运行的成功率和失败分布如何；
- 某次变更改善了哪些 Case，又破坏了哪些 Case。

### 8.3 每次实验至少应保留的信息

- Case 和输入版本；
- Model Provider、模型名称和参数；
- Agent 配置版本；
- System Prompt、Skill 和 Tool Schema 版本；
- Context/Compact 策略；
- Loop、Retry、Planning 和 Verification 策略；
- 完整 Run Trace；
- Tool 输入输出和错误；
- Artifact；
- 确定性检查结果；
- LLM Judge 结果；
- 必要时的人工评价；
- Token、耗时和调用次数等诊断数据。

### 8.4 评价优先级

1. 最终任务结果；
2. 正确性、完整性和鲁棒性；
3. 失败恢复和行为合理性；
4. 用户体验；
5. 耗时与调用次数；
6. Token 成本。

Token 成本仍然应该记录，因为它有助于发现无意义循环、上下文膨胀和策略退化，但不作为本项目的主要优化目标。

### 8.5 不把“轨迹复杂”当作效果好

Harness 必须支持多轮模型与 Tool 交互，但具体任务不要求为了展示 Agent 能力而强制发生多轮调用。

如果一个 Case 可以通过一次正确的模型判断和一次确定性 Tool 执行完成，就不应人为拆成多轮。多轮循环、重试、Approval、恢复等机制通过专门的 Harness 测试和确实需要这些能力的 Case 验证。

## 9. Case 驱动而非 Case 绑定

### 9.1 Case 01：登录态网页归档

网页归档仍然适合作为首个纵向 Case，因为它同时覆盖：

- Chrome 登录态和浏览器控制；
- 不可信网页内容；
- 动态页面和人工接管；
- 长时间媒体下载；
- Tool 失败、重试和恢复；
- Markdown、Manifest、Report 和 ZIP Artifact；
- 确定性完整性验证。

网页归档是 Harness 的第一个综合考题，不是 Harness 的产品定义。

### 9.2 尽早选择差异明显的 Case 02

在正式冻结通用接口前，应选择一个与网页归档差异明显的第二 Case 作为设计探针。它可以暂时只定义需求、样本和验收规则，不需要立即实现。

选择 Case 02 的目的包括：

- 防止领域模型被 Browser 和 Archive 语义绑死；
- 验证 Tool、Skill、Artifact 和 Workspace 抽象是否真正通用；
- 暴露不同的上下文、规划、编辑、审批和恢复需求；
- 为后续 Memory 和 Planning 设计提供真实依据。

Case 02 的具体选择留待后续结合个人高频工作场景拍板。

### 9.3 Eval Case 的建议构成

每个 Case 后续至少需要定义：

- 任务目标和输入；
- 环境与授权条件；
- 可用 Capability、Tool 和 Skill；
- 预期 Artifact；
- 确定性验收规则；
- 可接受的降级行为；
- 故障注入和恢复场景；
- 需要人工评价的维度；
- 已知限制和非目标。

## 10. 面向个人的宽松安全策略

### 10.1 已对齐结论

本项目不需要企业级安全和频繁审批，但不能删除 Policy、Approval、能力边界和审计机制。

更适合本项目的是提供面向个人的宽松信任策略，例如：

```text
trusted_personal
```

它的目标是减少作者自己的操作摩擦，同时保留灾难性错误防线和完整的 Harness 学习价值。

### 10.2 建议默认放行

- 已授权 Workspace 内的常规文件读取；
- 已授权 Workspace 内的普通创建和修改；
- 常规网页读取和内容提取；
- 无外部副作用的 Shell 与 Git 只读操作；
- 常规下载、压缩、校验和 Artifact 生成；
- 正常范围内的模型调用和 Token 消耗。

### 10.3 建议拦截或确认

- 递归删除、大范围删除和覆盖原文件；
- Workspace 或显式授权目录之外的写操作；
- 可能丢失未提交内容的 Git 操作；
- Cookie、Token、浏览器存储和其他凭证进入模型上下文；
- 上传本地文件或向外部系统发送数据；
- 发送钉钉消息、邮件、提交审批等外部副作用；
- 来自网页内容的指令直接驱动高影响 Tool；
- 其他不可逆或难以恢复的动作。

### 10.4 仍应保留的结构能力

- Tool 输入 Schema 校验；
- Capability 和授权目录边界；
- 路径 canonicalization 与越界检查；
- Action 影响等级；
- Policy 决策记录；
- Approval 的暂停和恢复；
- Credential 与模型上下文隔离；
- Action、Tool Result 和 Approval Trace。

因此，安全方向的调整是“默认更信任、减少审批摩擦”，不是“删除安全架构”。

## 11. 对 v0.2 结论的处理

### 11.1 继续保留

- 学习优先和 Harness 核心自研；
- Provider、MCP 和通用基础设施复用；
- 纯 Node Runtime 与最小 CLI；
- Electron 仅作为桌面宿主；
- 独立 Runtime 进程；
- SQLite 持久化；
- Durable Event 与 Transient Event 分层；
- 状态回放、审计回放和重新执行语义分离；
- Tool 恢复语义、幂等和执行前后验证；
- Artifact 作为一等领域对象；
- 粗粒度语义 Tool 与 Tool 内确定性实现；
- Chrome 登录态不向模型暴露 Cookie 和 Token；
- 网页归档作为首个纵向 Case。

### 11.2 需要调整

- “学习优先于交付速度”升级为“学习是所有目标中的第一优先级”；
- Eval 从验收内容升级为 P0 核心架构；
- 网页归档从 P0 产品范围调整为 Case 01；
- 安全从面向通用产品的严格默认，调整为个人宽松信任策略；
- 长期 Memory 不在缺乏多 Case 数据时过早实现；
- 不以“至少发生多轮 Tool Call”作为真实任务效果标准；
- 后续技术方案不再使用 OpenWork 作为正反参照中心。

### 11.3 需要独立重新论证

- Electron 最终产品形态及 UI 布局；
- Electron Main 与 Runtime 的具体通信协议；
- 是否以及何时需要本地 Server；
- Chrome Bridge 的 DOM、Content Script、CDP 与 Native Messaging 组合；
- Task、Conversation、Run 等领域对象的最终边界；
- 严格 Event Sourcing 或混合持久化模式；
- Planning、Verifier、Memory 和 Sub-agent 的引入阶段；
- 第二个及后续真实 Case 的选择。

### 11.4 当前取消的预设

- 不预设未来一定接入 OpenCode；
- 不为外部 Agent Engine 提前设计 Adapter；
- 不使用外部 Engine 的 Session 模型定义本项目领域对象；
- 不因为 OpenWork 使用某种桌面或 Server 架构而继承相同结构；
- 不把网页归档专属流程写入 Harness Kernel。

## 12. 建议的最新推进顺序

以下是基于本轮对焦形成的当前建议，具体阶段内容仍可继续讨论。

### 阶段 0：目标、研究范围与 Eval 设计

- 固化目标优先级；
- 定义生产级 Harness 核心边界；
- 定义自研和复用边界；
- 定义 Eval Case、Experiment 和 Result 的基本语义；
- 确定 Case 01；
- 选择一个差异明显的 Case 02 作为设计探针；
- 形成关键 ADR。

### 阶段 1：场景无关的 Headless Harness Kernel

- Run Controller 和最小 Agent Loop；
- Provider Adapter；
- Tool Registry 和 Tool Contract；
- Context 构建；
- 结构化 Trace；
- SQLite 持久化；
- CLI 与 Eval Runner；
- 使用简单测试 Tool 验证基本语义。

### 阶段 2：生产级执行语义

- Run 状态机；
- Action、Policy 和 `trusted_personal`；
- Approval 的暂停与恢复；
- Tool 超时、取消、重试和错误分类；
- Snapshot、Resume 和 Replay；
- Artifact Registry；
- Compact 与大 Tool Result 管理；
- 故障注入和恢复评测。

### 阶段 3：Case 01 网页归档

- Browser Capability；
- Chrome 登录态 Bridge；
- 网页正文提取；
- 媒体收集和下载；
- Markdown 路径重写；
- Manifest、Report、ZIP 和验证；
- 固定样本、动态样本和失败样本；
- 多配置重复实验和效果比较。

### 阶段 4：Case 02 与架构反证

- 接入与网页归档差异明显的第二类任务；
- 检查 Core 中是否泄漏 Case 语义；
- 检查 Tool、Skill、Workspace 和 Artifact 抽象；
- 根据两个真实 Case 重构，而不是根据想象预抽象；
- 判断是否需要 Planning、Verifier 或更复杂的调度策略。

### 阶段 5：桌面产品化

- Task、Run 和 Transcript；
- Tool、Approval 和 Artifact UI；
- Trace 与 Eval Inspector；
- Runtime Supervisor；
- 个人长期使用体验。

### 阶段 6：基于评测结果增强

- 更高级的 Context 和 Compact；
- 跨 Run Memory；
- Planner / Executor / Verifier 策略；
- Sub-agent 和并行执行；
- 更多办公 Capability 和真实 Case。

这些高级能力不因为“看起来先进”而自动进入范围，是否引入由学习价值、Case 需求和 Eval 结果共同决定。

## 13. 下一轮优先讨论事项

在开始设计类和写代码前，下一轮建议依次对焦：

1. **Harness Kernel 的最小职责**：必须包含什么，坚决不包含什么；
2. **Eval 领域模型**：Case、Dataset、Experiment、RunConfig、Trace、Result 和 Grader 的边界；
3. **Agent 配置快照**：如何记录模型、Prompt、Skill、Tool Schema、Context 和 Loop 策略，保证实验可比较；
4. **Case 02 选择**：选择一个能有效反证网页归档偏置的真实个人任务；
5. **Runtime 领域模型**：Workspace、Task、Conversation、Run、Invocation、ToolCall、Action、Approval、Artifact；
6. **Run 状态机与 Durable Execution**；
7. **Tool Contract 与 `trusted_personal` Policy**。

在这些问题形成稳定结论以前，不进入工程脚手架和正式编码。

## 14. 当前结论

本轮讨论后的核心方向可以概括为：

```text
学习生产级 Harness
        ↓
自研场景无关的 Harness Kernel
        ↓
把 Eval 和 Trace 建成 P0 核心能力
        ↓
用网页归档作为 Case 01，而不是产品边界
        ↓
用差异化 Case 持续反证和演进架构
        ↓
在个人宽松信任策略下追求最佳任务效果
        ↓
最终形成个人长期使用的桌面 Work Agent
```

当前最重要的两项共同结论是：

1. **Eval 必须与 Agent Loop、Context、Tool Runtime、Persistence 并列，成为 Harness 的 P0 核心。**
2. **安全架构继续保留，但采用面向个人的宽松信任策略，降低审批摩擦，仅重点防止不可逆、越界、凭证泄露和外部高影响动作。**

因此，下一轮讨论的中心不再是 OpenWork、Electron 或网页归档细节，而是：

> **一个真正场景无关、可学习、可观察、可恢复、可评测的 Harness Kernel，最小且正确的职责边界到底是什么。**
