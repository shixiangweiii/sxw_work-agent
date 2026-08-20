# WorkAgent 需求与技术架构二次反思讨论进展

> 文档状态：讨论基线 v0.2  
> 讨论日期：2026-08-20  
> 当前阶段：需求方向已基本确定，进入 Agent Core 领域模型与技术架构设计阶段  
> 目标读者：项目作者、后续参与架构讨论和实现的开发者

## 1. 文档目的

本文档整理截至当前为止围绕个人 Work Agent 的需求讨论、技术调研、关键拍板和第二轮架构反思结果，作为后续详细设计与实现的共同基线。

本文重点回答以下问题：

1. 当前项目真正要解决什么问题；
2. 产品目标与学习目标如何排序；
3. 为什么选择从零实现 Agent Loop；
4. 首个网页归档场景应该承担哪些架构验证职责；
5. 之前的前端和整体架构建议中，哪些保留、哪些调整、哪些延后；
6. 下一阶段应该优先讨论和设计什么。

本文不是最终 PRD，也不是完整技术设计。文中内容分为三种状态：

- **已拍板**：当前已经明确，不再作为近期开放问题反复讨论；
- **当前建议**：基于现有约束形成的架构方向，后续可通过 ADR 继续固化；
- **待详细设计**：方向已经出现，但对象、协议和实现细节尚未最终确定。

## 2. 相关调研材料

本轮讨论建立在以下材料之上：

1. [WorkAgent 调研报告](<../WorkAgent调研/WorkAgent调研.md>)：行业、产品形态与 Work Agent 技术能力地图；
2. [OpenWork 快速入门与核心源码阅读指南](<../WorkAgent调研/OpenWork 快速入门与核心源码阅读指南.md>)：OpenWork 产品层、Runtime 管理层及其与 OpenCode Agent Engine 的关系；
3. [Work Agent 前端技术栈调研](<../WorkAgent调研/WorkAgent前端技术栈调研.md>)：桌面壳、前端框架、Agent UI、事件流、Artifact、安全和测试技术选型。

三份材料的作用不同：

| 材料 | 当前定位 | 不应直接驱动的内容 |
|---|---|---|
| WorkAgent 调研报告 | 行业与能力地图 | 企业治理、多 Agent、技能市场等远期能力不进入首期范围 |
| OpenWork 源码指南 | 学习 Agent Runtime 如何产品化 | OpenWork 未自研 Agent Loop，不能直接作为 Agent Engine 实现答案 |
| 前端技术栈调研 | 桌面端与 UI 工程参考 | UI 完整度不再高于 Agent Core 的学习优先级 |

## 3. 已拍板的核心决策

### 3.1 用户与产品范围

- 首先服务作者个人，用于提升个人工作效率；
- 首版只考虑 macOS；
- 首阶段是本地文件型个人 Work Agent；
- 长期希望形成类似 WorkBuddy 的通用桌面办公 Agent；
- 后续能力方向包括本地文件、Git、钉钉 DWS、内部知识库及 Office 文档处理。

### 3.2 项目目标排序

**学习目标优先于产品交付速度。**

即使从零实现 Agent Loop 会显著拉长首个可用版本的时间，也继续坚持自研。项目没有外部合同、上线日期或商业交付压力，不设置以时间为核心的止损线。

这意味着项目的首要评价标准不是“最快做出多少功能”，而是：

- 是否真正理解并掌握 Agent Harness 的关键组成；
- 是否能够观察、解释、调试每次 Agent 决策；
- 是否亲自实现并验证状态机、上下文、工具调度、安全、记忆与恢复；
- 是否用真实任务验证架构，而不是只实现概念 Demo。

### 3.3 自研 Agent Loop 的边界

以下能力属于自研范围：

- Run 状态机与循环语义；
- 上下文构建与压缩策略；
- Tool/Skill 调度；
- Approval 与安全策略；
- RunEvent 事件协议；
- 持久化、恢复与回放；
- 记忆系统。

以下通用基础设施优先复用：

- 模型 Provider 官方 SDK；
- MCP SDK 与协议实现；
- 钉钉 DWS 等已有 Agent 基础设施；
- Git、文件格式、压缩、网络下载等成熟库；
- 桌面进程管理与系统集成能力。

复用 Provider SDK 只代表复用鉴权、请求、响应和流式传输能力，不代表把 Tool Loop、上下文管理或 Agent 状态机交给 SDK。

### 3.4 数据使用边界

- 首期只选择作者个人资料及安全等级较低的数据；
- 可以将这些被选择的数据发送给模型；
- Cookie、Token、浏览器存储、登录凭证等不进入模型上下文；
- 网页内容、模型输出和 Tool 输出仍统一视为不可信输入。

### 3.5 首个真实任务

首个纵向任务确定为：

> 使用现有 Chrome 登录态打开一个 URL，读取网页正文，将正文整理为 Markdown，同时下载网页中的图片、视频等媒体资源，最终生成包含 Markdown、images、videos 和必要清单文件的 ZIP 压缩包。

## 4. 项目的重新定位

结合上述决策，项目不再定义为“产品优先、尽快可用的个人 Work Agent”，而应定义为：

> **一个以学习 Agent Harness 为第一目标，以个人真实任务作为实验载体，最终具备桌面产品形态的本地 Work Agent。**

这个定位包含三个层次：

1. **Agent Runtime 实验平台**：能够独立研究 Agent Loop、Context、Tool、Policy、Memory、Persistence 和 Replay；
2. **真实任务执行器**：不是停留在聊天或玩具工具调用，而是能完成网页归档等真实任务；
3. **桌面 Work Agent 产品原型**：通过 Workspace、Task、Run、Tool Card、Approval 和 Artifact 将 Runtime 产品化。

长期的“通用 WorkBuddy”仍作为产品北极星，但不直接等同于首期范围。

## 5. 需求分层调整

### 5.1 P0：Agent Harness 学习主线

首期必须覆盖：

- 可解释、可调试的自研 Agent Loop；
- Run 生命周期与明确的停止条件；
- 模型流式调用与多轮 Tool Call；
- Tool Schema 校验、执行、结果回填；
- Approval 请求、允许、拒绝和恢复；
- 结构化事件输出；
- SQLite 持久化；
- 应用重启后的 Run 恢复；
- Event Replay 和运行审计；
- 基础 Context Builder；
- 基础 Compact/Summarize；
- Memory 接口和最小实现；
- Artifact 注册、验证与交付。

### 5.2 P0：网页归档纵向切片

首个真实任务需要覆盖：

- 输入 URL 或选择当前 Chrome 页面；
- 复用现有 Chrome 登录态；
- 页面打开、等待、人工接管和恢复；
- DOM/页面结构提取；
- 正文识别与 Markdown 生成；
- 图片和视频资源发现；
- 媒体下载、失败重试和进度展示；
- 本地资源路径重写；
- Archive Manifest；
- 完整性校验；
- ZIP 打包；
- 最终 Artifact 展示；
- 中断、失败和重启恢复。

### 5.3 P1：个人工作能力扩展

网页归档跑通以后，再按真实使用需要逐步增加：

- 本地文件搜索、读取、编辑和整理；
- Git 仓库查询和只读分析；
- 技术方案生成；
- 问题排查和证据整理；
- 内部知识库检索；
- 钉钉 DWS 能力；
- Word、Excel、PPT、PDF 等 Office 文件处理。

### 5.4 当前明确后置

- Windows/Linux；
- 多用户和团队协作；
- 云端 Runtime；
- 多端同步；
- 多 Agent 编排；
- Skill 市场；
- 企业组织、SSO、配额、FinOps 和管理后台；
- 自动发布、自动更新和完整商业化分发体系；
- 同时接入多套外部 Agent Engine。

## 6. 对网页归档任务复杂度的重新认识

网页归档不是简单的“下载 HTML，再转成 Markdown”。加入 Chrome 登录态、动态网页和媒体资源以后，它同时涉及浏览器控制、内容提取、网络请求、文件系统、恢复、安全和 Artifact。

主要复杂度包括：

- 静态网页与 SPA 的加载完成判定；
- 懒加载、滚动加载和无限列表；
- iframe、Shadow DOM、Canvas 和客户端渲染；
- `src`、`srcset`、`picture`、CSS background 等资源来源；
- 相对路径、重定向、临时签名地址；
- Cookie、Referer 或登录态相关媒体请求；
- `blob:` 视频和背后的真实网络资源；
- HLS/DASH 等流媒体协议；
- 正文、导航、评论、推荐、广告和隐藏内容的区分；
- 文件名冲突、非法字符、MIME 与扩展名不一致；
- 大文件、失败重试、取消、断点和磁盘空间；
- Markdown 内本地资源路径重写；
- 页面内容中的提示词注入和恶意链接。

### 6.1 建议的首期支持矩阵

| 页面或资源类型 | 首期目标 |
|---|---|
| 普通静态网页 | 完整支持 |
| 登录后的普通 SPA | 完整支持 |
| 懒加载图片 | 支持 |
| `img/srcset/picture` 图片 | 支持 |
| 可直接请求的图片和视频 URL | 支持 |
| 需要现有登录态的媒体请求 | 在不暴露凭证给模型的前提下支持 |
| CSS 背景图 | 尽量支持 |
| iframe 内容 | 同源优先，跨域降级并报告 |
| HLS/DASH | 后续增强 |
| Blob 背后的真实资源 | 后续通过网络观察能力增强 |
| DRM/加密媒体 | 明确不支持 |
| Canvas/WebGL | 使用截图或说明性降级 |
| 无限信息流 | 通过页数、滚动次数、资源数和大小上限约束 |

支持矩阵需要在实现阶段进一步细化为可执行验收用例。

## 7. 总体架构二次调整

### 7.1 建议架构

```text
┌──────────────────────────────────────────┐
│ Desktop Product                         │
│                                          │
│ React Renderer                           │
│ Task / Run / Tool / Approval / Artifact │
└──────────────────┬───────────────────────┘
                   │ Typed IPC
┌──────────────────▼───────────────────────┐
│ Electron Desktop Host                   │
│                                          │
│ Window / Lifecycle / Runtime Supervisor │
│ Permission Gateway / Native Integration │
└──────────────────┬───────────────────────┘
                   │ Runtime Protocol
┌──────────────────▼───────────────────────┐
│ Self-built Agent Runtime Process         │
│                                          │
│ Agent Loop                               │
│ Context Engine                           │
│ Tool & Skill Runtime                     │
│ Policy / Approval                        │
│ Memory                                   │
│ Persistence / Resume / Replay            │
└───────┬──────────┬───────────┬───────────┘
        │          │           │
        ▼          ▼           ▼
 Model Provider   SQLite     Capability Adapters
 SDK Adapter      Event Log  Files / Browser / Git / MCP / DWS
                               │
                               ▼
                    Browser Bridge / Native Host
                               │
                               ▼
                    Chrome Extension → 登录态页面
```

### 7.2 核心架构原则

1. Agent Runtime 使用 TypeScript/Node 实现，但不依赖 Electron；
2. Electron 只是 Runtime 的一个宿主和产品界面；
3. Agent Runtime 运行在独立进程中，避免 Renderer 或 Main 崩溃影响执行；
4. 提供最小 CLI 入口，用于脱离 UI 调试和测试 Agent Loop；
5. UI 只消费项目自己的领域协议，不直接消费模型 Provider 格式；
6. Chrome 登录态通过 Browser Bridge 暴露，不允许 Renderer 直接访问浏览器特权；
7. 首期不照搬 OpenWork 的本地 Server 层；
8. 如果未来需要远程客户端或外部 Engine，再增加 HTTP/SSE/JSON-RPC Transport Adapter；
9. 外部 OpenCode 等 Engine 只保留未来适配缝隙，首期不为假想兼容需求过度抽象。

### 7.3 为什么首期不照搬 OpenWork Server

OpenWork 的结构可以概括为：

```text
OpenWork Desktop
        ↓
OpenWork Server / Runtime Manager
        ↓
OpenCode Engine
```

它需要 Server 层管理外部 Engine、Workspace、Proxy、事件和生命周期。本项目首期是单用户、本地 Runtime、自研 Agent Loop，没有远程多客户端需求。

因此首期可以使用：

```text
Electron Renderer
        ↓ Typed IPC
Electron Main
        ↓ Runtime Protocol
Agent Runtime Process
```

这样仍然保留进程边界和协议边界，但避免过早引入本地 HTTP Server、端口、鉴权、SSE 重连等额外复杂度。

## 8. 对原有前端技术选型的复盘

| 原有决策 | 二次判断 | 调整说明 |
|---|---|---|
| Electron | 保留 | 与 TypeScript/Node Agent Runtime、Chrome Native Messaging 和 macOS 集成路径匹配 |
| React + TypeScript + Vite | 保留 | UI 生态成熟，但不是第一阶段研究核心 |
| Agent Core 放 utility process | 保留并强化 | Agent Core 本身必须保持纯 Node、可测试、可从 CLI 运行 |
| SQLite 保存 Task/Run/Event | 保留 | 支撑持久化、恢复、审计和回放 |
| TanStack Query 管异步快照 | 保留 | 只用于 UI 数据访问层 |
| Zustand 管 UI 状态 | 保留 | 不保存 Run、Event、Artifact 等领域事实 |
| 版本化 RunEvent | 保留但重构 | 需要区分 Durable Event、Transient Event 和 UI Projection |
| 三栏 Workbench | 作为目标形态保留 | 首期 UI 可以简化，但 Artifact 仍是一等对象 |
| Chrome MV3 + Native Messaging | 保留并提升优先级 | 现有 Chrome 登录态是首期核心约束 |
| 外部 Engine Adapter | 只保留架构缝隙 | 暂时不实现 OpenCode Adapter |
| 签名、公证、自动更新 | 延后 | 个人学习和本机使用阶段不应阻塞 Agent Core |
| 多格式 Office Preview | 延后 | 先完成 Markdown、图片、视频元数据、Manifest 和 ZIP |
| Renderer 安全基线 | 保留且不可延后 | 数据低敏不等于网页、模型输出和 Tool 输出可信 |

## 9. Agent Core 的建议边界

### 9.1 Agent Loop

Agent Loop 的最小逻辑如下：

```text
加载或创建 Run
       ↓
构建本轮 Context
       ↓
记录 Context Manifest
       ↓
调用 ModelProvider
       ↓
持久化模型响应
       ↓
是否存在 Tool Call？
       ├── 否：完成 Run
       └── 是
              ↓
          Tool Schema 校验
              ↓
          Policy 判定
              ↓
          必要时请求 Approval
              ↓
          执行 Tool
              ↓
          持久化 Tool Result
              ↓
          重新构建 Context
```

真正需要研究的不是 `while` 本身，而是：

- 本轮上下文由哪些内容组成；
- 为什么允许或拒绝某个 Tool Call；
- Tool Result 如何压缩后重新进入上下文；
- 什么状态下等待用户；
- 什么错误可以重试；
- 什么 Tool 可以安全恢复；
- 什么条件代表任务完成；
- 如何避免无限循环和无意义调用。

### 9.2 建议的 Run 状态

```text
created
running
waiting_approval
waiting_user
paused
completed
failed
cancelled
```

状态转换需要由领域规则驱动，而不是由 UI 组件直接修改。

### 9.3 Provider Adapter

Provider Adapter 只负责：

- 模型鉴权；
- Request 格式转换；
- 流式响应解析；
- Tool Call 格式规范化；
- Usage 和错误规范化。

Provider Adapter 不负责：

- 自动执行工具；
- 决定上下文内容；
- Run 状态转换；
- Approval；
- Memory 写入；
- Agent 是否继续循环。

## 10. 领域对象的当前建议

后续需要详细设计的核心对象包括：

| 对象 | 当前定义 |
|---|---|
| Workspace | Agent 被授权工作的本地空间和能力边界 |
| Task | 一个持久化用户目标及其产物容器 |
| Conversation | 用户与 Agent 围绕 Task 的持续交互 |
| Run | 一次从输入开始到终态结束的执行尝试 |
| ModelInvocation | Run 内的一次模型调用 |
| ToolCall | 模型请求使用某个 Tool 的结构化意图 |
| Action | 经过校验和 Policy 判定后准备执行的实际动作 |
| Approval | 对 Action 的人工授权记录 |
| Artifact | Run 产生的可交付文件或成果集合 |
| Capability | 当前 Workspace 可使用的执行能力 |
| Memory | 跨 Invocation、Run 或 Task 保留的经验和偏好 |

需要特别避免把外部 Engine 的 `sessionId` 直接当成本项目核心领域 ID。未来接入外部 Engine 时，只保存类似 `ExternalEngineSessionRef` 的映射关系。

## 11. 事件协议的二次调整

之前的建议倾向于用一个 `RunEvent` 同时承担流式传输、持久化和 UI 渲染。为支持真正的恢复与回放，建议拆成三层。

### 11.1 Durable Domain Event

持久化到 SQLite，用于重建领域状态：

```text
run.started
run.state_changed
context.assembled
model.invocation.started
model.invocation.completed
tool.call.requested
action.prepared
approval.requested
approval.resolved
tool.execution.started
tool.execution.completed
tool.execution.failed
artifact.registered
memory.candidate_created
memory.committed
memory.invalidated
run.completed
run.failed
run.cancelled
```

### 11.2 Transient Runtime Event

用于实时展示，可以批量合并或只周期性生成 checkpoint：

```text
assistant.delta
reasoning.delta
tool.progress
download.progress
archive.progress
```

不建议一个 token 对应一行 SQLite 记录。

### 11.3 UI Projection

前端通过 Snapshot + Event Reducer 生成：

```text
AssistantMessage
ToolCard
ApprovalCard
ArtifactCard
RunStatus
ProgressSummary
```

领域协议不应被具体 React 组件结构反向绑死。

### 11.4 事件通用字段

建议所有持久化事件至少包含：

```text
eventId
schemaVersion
workspaceId
taskId
runId
seq
type
timestamp
causationId
correlationId
payload
```

后续需要确定是否使用严格 Event Sourcing，还是“事件日志 + 规范化事实表 + Snapshot”的混合模式。当前更倾向于混合模式，以降低查询和迁移复杂度。

## 12. 恢复与回放语义

“回放”不能笼统定义，需要区分：

1. **状态回放**：从事件重建 Run 和 UI 状态，必须支持；
2. **审计回放**：查看当时的 Context、模型响应、Tool 输入输出和 Approval，必须支持；
3. **重新执行**：复制原始输入创建一个新的 Run；
4. **完全确定性复现**：不承诺，因为模型输出、网页内容和外部网络状态可能变化；
5. **崩溃恢复**：从最后一个稳定执行边界继续，不恢复到半次模型调用的某个 token。

Tool 需要声明恢复语义，例如：

```text
retry_safe
verify_before_retry
manual_recovery
not_resumable
```

网页归档中的下载、路径重写和 ZIP 打包应尽量实现为可验证、可幂等或可从 Manifest 恢复的步骤。

## 13. Tool、Skill、Capability、Policy 与 Artifact

### 13.1 Tool

原子、可执行、带 Schema 的动作，应包含：

- 名称和描述；
- 输入/输出 Schema；
- 读写和外部影响等级；
- 所需 Capability；
- 超时、取消和重试策略；
- Approval 要求；
- 恢复与幂等语义；
- 模型可见结果；
- UI 展示摘要；
- 原始诊断和 Artifact 引用。

### 13.2 Capability

Runtime 当前可以调用的执行能力，例如：

```text
filesystem
browser
git
shell
mcp
dws
office
```

Capability 是可用能力和授权边界，不等于具体 Tool。

### 13.3 Skill

Skill 是指导 Agent 如何组合 Tool 完成任务的知识和工作流包，可以包含：

- 元数据；
- 指令；
- 工具依赖；
- 示例；
- 脚本；
- 参考资料；
- 验收规则。

### 13.4 Policy

Policy 根据 Tool、参数、Workspace、Run 和数据范围决定：

- allow；
- deny；
- ask approval；
- allow once；
- allow for run；
- allow for workspace。

### 13.5 Artifact

Artifact 是一等领域对象，不是聊天消息中的附件。至少应记录：

- Artifact ID；
- 来源 Run；
- 路径或文件集合；
- Media Type；
- 创建状态；
- 验证状态；
- Manifest；
- Preview Adapter；
- Checksum；
- 版本和来源关系。

## 14. 网页归档 Skill 的建议分解

不建议把每个文件下载或 DOM 节点操作都暴露为模型 Tool。模型应该操作相对粗粒度、语义清晰的 Tool，确定性细节由 Tool 内部完成。

建议首期提供：

```text
browser.open_or_attach
page.inspect
page.extract_content
media.collect
archive.build
archive.verify
```

建议执行流程：

```text
输入 URL
   ↓
打开或关联 Chrome Tab
   ↓
等待加载 / 用户登录 / 人工接管
   ↓
页面检查与资源发现
   ↓
正文提取
   ↓
媒体收集与下载
   ↓
Markdown 路径重写
   ↓
生成 Manifest
   ↓
完整性校验
   ↓
ZIP 打包
   ↓
Artifact 注册
```

模型负责：

- 选择和调整执行步骤；
- 判断页面是否需要人工介入；
- 在多种正文提取结果间做选择；
- 判断失败是否需要重试或降级；
- 组织最终执行说明。

确定性程序负责：

- 网络请求；
- 下载队列；
- 重试和限流；
- 文件命名；
- MIME 校验；
- Checksum；
- Markdown 路径重写；
- Manifest；
- ZIP 打包和验证。

## 15. Browser Bridge 架构

由于首期必须使用现有 Chrome 登录态，Chrome Extension 不再是后置附件，而是核心执行面。

建议逻辑链路：

```text
Agent Runtime
    ↓ Browser Capability Contract
Browser Bridge Client
    ↓ Local IPC / Socket
Native Messaging Host
    ↓ Chrome Native Messaging
Extension Service Worker
    ↓
Content Script / chrome.debugger / Tab
```

边界要求：

- Extension 只暴露明确的浏览器操作，不暴露通用 Shell；
- Native Host 校验 Extension ID、消息类型和参数；
- Cookie 和 Token 只能由本地 Browser Capability 使用，不进入模型消息；
- 页面内容标记为 untrusted data；
- 浏览器读操作和会产生外部影响的写操作分级；
- 对验证码、登录、二次确认等场景支持人工接管；
- 所有 Browser Action 进入 Run 事件和审计记录；
- 对资源数量、单文件大小、总大小、请求时间和 URL Scheme 设置限制。

具体采用 DOM API、Content Script、`chrome.debugger`/CDP 或多策略组合，留待 Browser Capability 详细设计阶段决定。

## 16. 上下文工程

### 16.1 Context Builder

建议 Context 由多个可观察 Contributor 组成：

```text
System / Agent Identity
Task Goal
Run State
Workspace Context
Selected Skill Instructions
Selected Memory
Conversation Summary
Recent Messages
Relevant Tool Results
Pending Approval / User Input
```

每次模型调用都生成 Context Manifest，记录：

- 使用了哪些 Contributor；
- 每部分来源；
- 原始大小和压缩后大小；
- 估算 Token；
- 是否被截断；
- 是否来自不可信网页；
- 使用了哪种 Compact 策略。

这比单纯保存最终 Prompt 更有利于学习和调试上下文工程。

### 16.2 Compact

首期不追求复杂算法，可以从确定性规则开始：

- 大 Tool Output 写入文件，只把摘要和引用放入上下文；
- 完成阶段的历史调用压缩成摘要；
- 最近交互保留原文；
- Artifact 只传元数据或引用；
- 网页 DOM 和媒体清单分离存储；
- 达到 Token 阈值时产生显式 Summary Event。

## 17. 记忆系统

记忆先从简单但语义正确的结构开始，不立即引入向量数据库或知识图谱。

### 17.1 记忆层次

1. **Run 工作状态**：属于 Runtime State，不是长期记忆；
2. **Task/Conversation 摘要**：情景记忆；
3. **用户偏好**：长期语义记忆；
4. **网站归档成功策略和失败经验**：程序性记忆；
5. **内部知识库内容**：Knowledge Source，不与 Agent Memory 混为一体。

### 17.2 首期实现建议

- SQLite 存储；
- FTS 全文检索；
- 明确的 scope、source 和 provenance；
- 支持 candidate、committed、invalidated 状态；
- 先支持用户明确保存和系统候选，不默认把所有内容永久记忆；
- Embedding 和向量检索作为后续 Adapter。

建议 Memory Record 至少包含：

```text
memoryId
scope
kind
content
source
provenance
confidence
createdAt
updatedAt
status
```

## 18. 安全边界

即使首期只处理个人低敏数据，仍然存在网页提示词注入、本地文件覆盖、恶意媒体、路径逃逸和 Renderer XSS 等风险。

首期安全基线包括：

- Renderer：`nodeIntegration: false`；
- Renderer：`contextIsolation: true`；
- Renderer sandbox；
- Preload 只暴露逐项、typed、校验过的 API；
- 不把原始 `ipcRenderer` 暴露给页面；
- Markdown 和 HTML 统一清洗；
- HTML Artifact 在隔离 sandbox 中预览；
- Workspace 路径进行 realpath 和 symlink escape 校验；
- Cookie、Token、浏览器存储不进入模型上下文；
- 网页内容使用 untrusted 标记，不允许变成系统指令；
- Tool 在执行前经过 Schema、Policy 和 Approval；
- 下载限制 URL Scheme、文件数、大小、超时和 MIME；
- 高风险和外部影响动作保留人工确认；
- 所有 Action 和 Approval 可审计。

数据是否敏感主要影响“能否发给哪个模型”，不能替代 Runtime 的执行安全。

## 19. 网页归档 Artifact 规范建议

首期输出建议统一为：

```text
archive.zip
├── index.md
├── manifest.json
├── assets/
│   ├── images/
│   └── videos/
└── reports/
    └── archive-report.json
```

`manifest.json` 至少记录：

- 原始 URL；
- 最终 URL；
- 页面标题；
- 归档时间；
- 内容提取策略；
- Markdown 文件；
- 原始资源 URL 与本地路径映射；
- MIME、大小和 Checksum；
- 下载成功、失败或跳过状态；
- 重定向信息；
- 警告和降级说明；
- 生成该 Artifact 的 Run ID。

`archive-report.json` 面向运行和验收，建议包含：

- 页面处理阶段；
- 资源统计；
- 下载耗时；
- 重试次数；
- 失败原因；
- 完整性校验结果；
- 未支持内容列表。

## 20. 首期验收维度

### 20.1 功能验收

- 可以从桌面端输入 URL；
- 可以使用现有 Chrome 登录态访问页面；
- 可以生成正文 Markdown；
- 可以下载支持范围内的图片和视频；
- Markdown 中的资源路径指向本地文件；
- 可以生成 Manifest、Report 和 ZIP；
- UI 可以查看过程状态和最终 Artifact。

### 20.2 Agent Harness 验收

- 至少发生多轮模型与 Tool 交互；
- Tool 输入输出均被结构化记录；
- Approval 可以暂停和恢复 Run；
- Run 可以取消；
- 应用重启后可以恢复；
- Event 可以重建 UI 状态；
- 可以查看每次 Invocation 的 Context Manifest；
- 大 Tool Output 不直接污染上下文；
- Tool 失败后 Agent 可以重试、降级或结束；
- Loop 有最大步数、预算或其他明确防失控机制。

### 20.3 Artifact 验收

- ZIP 可以正常打开；
- Manifest 与实际文件一致；
- 文件 Checksum 正确；
- 失败媒体明确列出；
- 重复或恢复执行不会无控制地复制资源；
- Artifact 可以定位回来源 Task 和 Run。

### 20.4 安全验收

- Cookie、Token 不出现在 Prompt 和 Event Payload；
- 网页正文中的指令不能直接触发 Tool；
- 不允许写出授权 Workspace；
- 不允许 `file:`、危险自定义 Scheme 等未授权下载；
- Renderer 不拥有 Node 和通用 IPC 权限；
- 所有高风险 Action 有可追溯 Approval。

## 21. 建议的代码组织

以下仅作为讨论候选，不代表必须一次拆出全部包：

```text
apps/
├── desktop/                 # Electron Main / Preload / Renderer
├── cli/                     # Agent Runtime 调试入口
└── chrome-extension/        # Chrome MV3 Extension

packages/
├── contracts/               # Domain、Event、IPC、Runtime 协议
├── agent-runtime/           # Agent Loop 与 Run 状态机
├── context-engine/          # Context Builder 与 Compact
├── tool-runtime/            # Tool Registry、Execution、Policy
├── memory/                  # Memory 接口与 SQLite 实现
├── storage/                 # Repository、Migration、Snapshot、Event Log
├── browser-bridge/          # Runtime 到 Chrome 的能力适配
└── model-providers/         # Provider Adapter

skills/
└── web-archive/             # 网页归档 Skill、规则、脚本与验收样本
```

实际初始化时可以先合并部分包，等边界稳定后再拆分，避免空项目一开始就产生大量无内容 package。

## 22. 建议的推进阶段

阶段划分用于保证每一阶段学清楚一个问题，不是时间或上线止损线。

### 阶段 0：领域模型与协议

- 定义 Workspace、Task、Conversation、Run、Invocation、ToolCall、Action、Approval、Artifact；
- 定义 Run 状态机；
- 定义 Durable Event 和 Transient Event；
- 明确 Replay 和 Resume 语义；
- 形成首批 ADR。

### 阶段 1：Headless Agent Loop

- Provider Adapter；
- 最小 Agent Loop；
- Tool Registry；
- 简单只读 Tool；
- CLI；
- SQLite Event Log；
- Context Manifest；
- 基础测试。

### 阶段 2：Approval、恢复与 Artifact

- Policy 和 Approval；
- 中断、取消、失败；
- Snapshot；
- 应用重启恢复；
- Artifact Registry；
- Replay Inspector。

### 阶段 3：Chrome Browser Bridge

- Chrome Extension；
- Native Messaging Host；
- 当前 Tab/指定 URL；
- DOM 与页面信息提取；
- 人工登录和接管；
- 浏览器安全策略。

### 阶段 4：网页归档纵向切片

- 正文提取；
- 媒体发现和下载；
- Markdown 重写；
- Manifest；
- ZIP；
- 验证；
- 中断与恢复；
- 固定网页样本测试。

### 阶段 5：桌面产品化

- Task/Run UI；
- Tool Card；
- Approval UI；
- Artifact Workbench；
- Transcript；
- Snapshot + Event reconciliation；
- 流式 Markdown。

### 阶段 6：上下文和记忆增强

- Context Contributor；
- Compact；
- 情景记忆；
- 用户偏好；
- 网站策略经验；
- Memory Inspector。

### 阶段 7：办公能力扩展

- Git；
- DWS；
- 内部知识库；
- Office；
- 外部 Agent Engine Adapter。

## 23. 当前主要风险

| 风险 | 表现 | 应对方向 |
|---|---|---|
| 学习范围无限扩张 | 同时研究太多基础设施 | 使用阶段性研究问题和验收样本控制变量 |
| UI 先行 | 大量时间花在组件和样式 | CLI 和 Headless Runtime 先验证核心语义 |
| Agent Loop 过于简单 | 只有 `while + tool_calls` | 把重点放在状态、上下文、Policy、恢复和可观察性 |
| Agent Loop 过度框架化 | 首期就设计万能 Engine 抽象 | 先服务自研 Runtime，第二个 Engine 出现时再验证抽象 |
| 事件协议 UI 化 | Event 类型由组件反向决定 | Durable Domain Event 与 UI Projection 分层 |
| 每 token 持久化 | SQLite 膨胀、回放低效 | delta 合并、checkpoint 和完成事件 |
| 恢复重复执行 | 下载、写文件或外部动作重复 | Tool 恢复语义、幂等键、执行前后验证 |
| Memory 污染 | 错误信息长期进入上下文 | candidate/commit/invalidate、来源与置信度 |
| 网页提示词注入 | 页面文字诱导 Tool 执行 | 不可信数据标记、指令隔离和 Policy |
| Chrome Bridge 权限过大 | Extension 变成通用远控入口 | 窄协议、Extension ID 校验、无通用 Shell |
| “通用网页”无法验收 | 对所有网站做无限承诺 | 明确支持矩阵、降级策略和失败报告 |

## 24. 下一轮优先讨论事项

前端框架已经不是当前最大的未决问题。下一轮建议依次讨论：

1. **Agent Core 领域模型**：Task、Conversation、Run、Invocation、ToolCall、Action 的边界；
2. **Run 状态机**：状态、命令、事件、终态和非法转换；
3. **事件协议**：Durable/Transient、序列、幂等、Snapshot 和迁移；
4. **Tool Contract**：输入输出、影响等级、审批、恢复和 Artifact；
5. **Context Manifest**：每次模型调用如何可观察和复盘；
6. **Browser Capability**：Chrome Extension、Native Host 与 CDP/DOM 策略；
7. **网页归档支持矩阵和验收样本**。

这些内容确定以后，再进入工程脚手架和第一段代码实现。

## 25. 当前结论

原来的前端技术选型不需要整体推翻。真正需要调整的是实施重心和顺序：

```text
原方向：
成熟桌面产品壳
    ↓
接入 Agent Engine
    ↓
逐渐扩展能力

当前方向：
领域模型与状态机
    ↓
自研 Agent Harness
    ↓
持久化、恢复、回放与观察
    ↓
Chrome 网页归档纵向切片
    ↓
桌面 Work Agent 产品化
```

因此，当前项目的核心不是“复刻一个 WorkBuddy 界面”，也不是“重新实现所有底层协议”，而是：

> **亲自实现一个边界清晰、可观察、可恢复、可扩展的 Agent Harness，并用真实的登录态网页归档任务检验它，再逐步把它产品化为个人 Work Agent。**
