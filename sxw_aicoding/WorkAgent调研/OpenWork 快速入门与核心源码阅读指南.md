# OpenWork 快速入门与核心源码阅读指南

## 1. OpenWork 是什么

可以先把 OpenWork 理解成一句话：

> **OpenWork ≈ 给 OpenCode 套上一层“面向普通办公用户的桌面 Work Agent 产品壳 + Runtime 管理层”。真正的 Agent Loop 主要由 OpenCode 提供，OpenWork 的核心价值在于把它产品化成 Workspace / Session / 文件 / Skill / MCP / 权限审批 / 桌面 UI / 远程运行。**

OpenWork 的官方定位是一个面向 macOS、Windows、Linux 的开源桌面 AI 工作应用，可以视为 Claude Cowork、Codex 一类产品的开源替代方案。

理解 OpenWork 的第一个关键是：

> **OpenWork 并不是从零重新实现一套 Agent Loop，而是建立在 OpenCode Agent Runtime 之上的 Work Agent 产品层。**

因此，如果已经理解 OpenCode、Coding Agent、Agent Loop、Tool Calling、Sandbox 等概念，很多认知都可以直接迁移到 OpenWork。

---

# 2. 从 Coding Agent 理解 Work Agent

## 2.1 Coding Agent

典型 Coding Agent 的工作链路可以抽象成：

```text
用户
 ↓
Claude Code / Codex / OpenCode
 ↓
Agent Loop
 ↓
read / grep / edit / bash / git ...
 ↓
代码仓库
```

核心工作对象通常是：

```text
Repository / Workspace
```

Agent 最主要的行动能力是：

```text
Read
Search
Edit
Shell
Git
Test
Build
```

---

## 2.2 Work Agent

桌面 Work Agent 可以抽象成：

```text
用户
 ↓
桌面 GUI
 ↓
自然语言任务
 ↓
Agent Runtime
 ↓
File / Shell / Skill / MCP / Browser / SaaS
 ↓
办公产物或业务动作
```

例如：

```text
帮我整理这个文件夹

根据这些 Excel 和 PDF 做一份分析报告

总结这些资料并生成 PPT

读取 Google Drive 文件并整理

调用企业 SaaS 完成一项操作
```

最后产生：

```text
docx
pptx
xlsx
pdf
markdown
文件修改
SaaS 操作
浏览器操作
```

所以 Coding Agent 与 Work Agent 本质上并没有断层。

区别主要不是：

```text
Coding Agent 有 Agent Loop
Work Agent 有另一种 Agent Loop
```

而是：

> **同样的 Agentic Runtime，从“代码仓库”扩展到了“用户工作空间 + 办公文件 + SaaS + Browser + 企业能力”。**

OpenWork 正是这种思路的典型实现。

---

# 3. OpenWork 的整体架构

理解 OpenWork 时，可以先只记住四层：

```text
┌─────────────────────────────────────┐
│           OpenWork Desktop          │
│                                     │
│ Electron / Desktop Lifecycle        │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│             OpenWork App            │
│                                     │
│ React UI                            │
│ Workspace                           │
│ Session                             │
│ Composer                            │
│ Message                             │
│ Tool UI                             │
│ Permission UI                       │
└──────────────────┬──────────────────┘
                   │
                   │ OpenCode SDK
                   │ HTTP / SSE
                   │
┌──────────────────▼──────────────────┐
│           OpenWork Server           │
│                                     │
│ Workspace                           │
│ Auth                                │
│ Approval                            │
│ Files / Artifact                    │
│ Skill                               │
│ MCP                                 │
│ Plugin                              │
│ OpenCode Proxy                      │
│ Engine Lifecycle                    │
└──────────────────┬──────────────────┘
                   │
                   │ spawn / proxy
                   ▼
┌─────────────────────────────────────┐
│             OpenCode                │
│                                     │
│ Session                             │
│ Agent Loop                          │
│ LLM                                 │
│ Tools                               │
│ Shell                               │
│ Filesystem                          │
│ MCP                                 │
│ Skill                               │
└─────────────────────────────────────┘
```

仓库中最主要的三个目录是：

```text
apps/app
apps/desktop
apps/server
```

可以粗略理解为：

```text
apps/app
    ↓
Work Agent 前端产品层

apps/desktop
    ↓
桌面容器与生命周期

apps/server
    ↓
OpenWork Runtime / Gateway / Control Layer
```

---

# 4. 最重要的认知：OpenWork 没有重新造 Agent Loop

这是阅读源码前最重要的一点。

OpenWork 前端直接依赖：

```text
@opencode-ai/sdk
```

并通过 OpenCode SDK 创建客户端：

```ts
createOpencodeClient({
  baseUrl,
  directory,
  ...
})
```

所以整体链路实际上是：

```text
OpenWork
   ↓
OpenCode SDK
   ↓
OpenCode Server
   ↓
OpenCode Agent Loop
```

而不是：

```text
OpenWork
   ↓
OpenWorkAgentLoop
   ↓
while (...)
```

这个差异会直接决定源码阅读方法。

---

## 4.1 哪些问题应该读 OpenWork

如果想理解：

```text
用户输入一个任务以后
OpenWork 怎么构造请求

Workspace 怎么管理

Session 怎么创建

文件怎么附加

UI 怎么展示 Agent 执行过程

Tool Call 怎么显示成卡片

权限请求怎么弹出来

OpenCode 进程怎么管理
```

应该读 OpenWork。

---

## 4.2 哪些问题最终应该读 OpenCode

如果想理解：

```text
模型为什么决定调用 Bash

Tool Result 如何重新进入模型上下文

Agent Loop 为什么继续或退出

System Prompt 怎么构造

Context 怎么 Compact

LLM 和 Tool 的循环怎么实现

Reflection / Planning 怎么实现
```

最终需要继续进入 OpenCode 源码。

因此可以把两者关系理解为：

```text
OpenWork
=
Agent Product / Runtime Management Layer

OpenCode
=
Agent Engine
```

---

# 5. 第一条核心链路：用户发送任务到 Agent 开始执行

第一轮阅读源码，最重要的是只追这一条：

> **用户输入一句话 → OpenCode 开始 Agent 执行 → Tool 调用 → UI 实时展示结果**

整体链路可以抽象成：

```text
Composer
   │
   │ 用户点击发送
   ▼
sendPrompt()
   │
   ├── ensureWorkspaceRuntime()
   │
   ├── 创建 / 获取 Session
   │
   ├── buildPromptParts()
   │
   │      ├── text
   │      ├── file
   │      ├── attachment
   │      ├── agent mention
   │      └── app mention
   │
   ▼
client.session.promptAsync()
   │
   ▼
OpenWork Server
   │
   ▼
OpenCode Proxy
   │
   ▼
OpenCode Server
   │
   ▼
Agent Loop
   │
   ├── LLM
   ├── Tool
   ├── LLM
   ├── Tool
   └── Final Answer
   │
   ▼
OpenCode Event Stream
   │
   ▼
SSE
   │
   ▼
session-sync.ts
   │
   ▼
React Query / State
   │
   ▼
聊天消息 / Tool Card / Status / Permission
```

这张图是理解整个 OpenWork 的核心。

---

# 6. 第一核心文件：actions-store.ts

建议第一轮源码不要从 Electron Main Process、应用启动入口或者大量 React UI Component 开始。

直接进入：

```text
apps/app/src/react-app/domains/session/sync/actions-store.ts
```

重点只看：

```ts
sendPrompt()
```

这个函数可以认为是：

> **用户任务从 UI 进入 Agent Runtime 的主要入口。**

其主要流程大致是：

```text
获取 Workspace

↓

ensureWorkspaceRuntime()

↓

确认 Client 可用

↓

如果没有 Session
则创建 Session

↓

buildPromptParts()

↓

获取当前 Model

↓

获取当前 Agent

↓

client.session.promptAsync(...)
```

核心调用类似：

```ts
await c.session.promptAsync({
  sessionID,
  model,
  agent,
  variant,
  parts,
})
```

这里非常重要。

因为读到这里，应该立刻产生下一个问题：

> `c.session.promptAsync()` 到底是谁实现的？

然后继续追到 OpenCode SDK。

---

# 7. Prompt 不只是文本

Work Agent 和传统 Chatbot 一个明显不同点是：

> 用户输入不再只是 Text。

OpenWork 会构造不同类型的 Prompt Part：

```text
Text Part

File Part

Attachment

Agent Mention

App Mention
```

因此 Work Agent 的输入更接近：

```text
Prompt
=
Text
+
Local File Context
+
Attachments
+
Agent Selection
+
Application Context
```

这也是办公 Agent 很重要的一个特点：

> **Agent 处理的是一个工作环境，而不只是一个聊天框。**

---

# 8. 第二核心文件：opencode.ts

继续阅读：

```text
apps/app/src/app/lib/opencode.ts
```

这里的核心作用是：

```text
OpenWork Client
   ↓
OpenCode SDK
   ↓
HTTP API
```

其中会创建：

```ts
createOpencodeClient(...)
```

并对部分 OpenCode SDK API 进行适配。

例如：

```text
promptAsync
```

最终对应类似：

```text
POST /session/{sessionID}/prompt_async
```

所以链路继续展开：

```text
sendPrompt()
   ↓
client.session.promptAsync()
   ↓
OpenCode SDK
   ↓
HTTP
   ↓
POST /session/:id/prompt_async
```

---

# 9. 为什么是 promptAsync

这里有一个很值得注意的设计：

```text
promptAsync
```

而不是让整个 Agent Run 挂在一个普通同步 HTTP 请求中。

因为一个 Work Agent 任务可能运行：

```text
30 秒
2 分钟
10 分钟
甚至更久
```

如果整个 Agent Loop 生命周期都绑定在一个 HTTP 请求上，会产生很多问题：

```text
超时

中断

断线

重连

页面刷新

多客户端同步

长任务状态管理
```

因此更合理的模型是：

```text
发送任务请求
        ↓
快速确认任务已开始
        ↓
Agent 后台持续运行
        ↓
状态通过 Event Stream 持续推送
```

也就是：

```text
Command Plane
+
Event Plane
```

可以抽象为：

```text
promptAsync
    ↓
启动任务

event.subscribe
    ↓
订阅任务执行事件
```

---

# 10. 第三核心文件：managed-opencode.ts

接下来建议读：

```text
apps/server/src/managed-opencode.ts
```

这个文件可以非常直接地看到：

> **OpenWork 是怎么真正启动 Agent Engine 的。**

核心逻辑本质上就是启动：

```text
opencode serve
```

大致类似：

```ts
spawn("opencode", [
  "serve",
  "--hostname",
  hostname,
  "--port",
  port,
  "--cors",
  "*"
])
```

所以桌面 OpenWork 的整体进程模型可以理解成：

```text
OpenWork Desktop
      │
      ├── OpenWork Server
      │
      └── OpenCode Server Process
                │
                └── Agent Runtime
```

这意味着：

> OpenWork 并不是把 OpenCode 当一个普通 Library 嵌进去，而是把它作为一个独立的 Agent Engine Process 管理。

这个架构非常重要。

---

# 11. OpenWork Server 的定位

OpenWork Server 可以理解为：

> **位于 Desktop UI 和 OpenCode Agent Engine 之间的一层 Runtime Gateway / Runtime Manager。**

整体关系：

```text
OpenWork UI
     ↓
OpenWork Server
     ↓
OpenCode Server
```

如果从职责角度拆分：

```text
OpenCode
负责：
Agent Loop
Session
LLM
Tool
Shell
Filesystem
MCP
Skill
```

而：

```text
OpenWork Server
负责：
Workspace
Auth
Permission
Approval
File
Artifact
Plugin
Runtime Config
Token
OpenCode Proxy
Engine Lifecycle
```

因此 OpenWork Server 并不是一个简单反向代理。

---

# 12. 为什么 UI 不直接连接 OpenCode

理论上当然可以：

```text
OpenWork UI
    ↓
OpenCode
```

但是一旦从 Coding Agent 变成真正的 Work Agent 产品，就会出现大量 Agent Loop 本身不应该负责的问题：

```text
Workspace 管理

文件授权

文件上传

Artifact 管理

Skill 管理

MCP 管理

Plugin 管理

权限审批

Token 管理

远程 Workspace

多客户端

审计

企业权限

配置管理

Agent Engine 生命周期
```

于是自然形成：

```text
Product Layer
      ↓
Runtime Gateway
      ↓
Agent Engine
```

这也是 OpenWork Server 存在的原因。

---

# 13. OpenWork Server 的核心 API 类型

可以粗略理解为以下几类。

## 13.1 Workspace

```text
/workspaces

/workspace/:id/config
```

---

## 13.2 Capability

```text
/workspace/:id/skills

/workspace/:id/mcp

/workspace/:id/plugins

/workspace/:id/commands
```

---

## 13.3 File / Artifact

```text
/workspace/:id/inbox

/workspace/:id/artifacts

/files/sessions/...
```

---

## 13.4 Approval

```text
/approvals
```

---

## 13.5 Token / Auth

```text
/tokens
```

---

## 13.6 OpenCode Proxy

```text
/opencode/*

/w/:id/opencode/*
```

这些 API 能很好地说明：

> **OpenWork Server 是围绕 OpenCode Engine 建的一层 Work Agent Runtime 管理体系。**

---

# 14. 第四核心链路：Agent 如何把执行过程实时推给 UI

Agent 开始执行以后，前端必须实时知道：

```text
现在是在 Thinking

现在在调用 Tool

Tool 参数是什么

Tool 返回了什么

是否需要权限

是否需要用户回答问题

任务是否完成

任务是否失败
```

这条链路主要可以从：

```text
apps/app/src/react-app/domains/session/sync/session-sync.ts
```

开始阅读。

其中会建立类似：

```ts
client.event.subscribe()
```

然后获取：

```text
subscription.stream
```

因此整体数据流变成：

```text
               promptAsync
OpenWork UI ───────────────► OpenCode
     ▲
     │
     │ SSE / Event Stream
     │
     └──────────────────────
```

这是一种很典型的 Agent Runtime 架构：

```text
Request
+
Stream Events
```

---

# 15. OpenCode Runtime Event

可以粗略把 OpenCode 推过来的事件理解成：

```text
session.created

session.updated

session.status

message

message part delta

tool

permission

question

todo

error
```

OpenWork 再把这些 Runtime Event 转换成：

```text
Application State

↓

UI State

↓

Visible UI
```

例如：

```text
session.status
    ↓
Running / Idle

message.delta
    ↓
流式文本

tool
    ↓
Tool Card

permission
    ↓
权限确认 UI

question
    ↓
用户交互 UI
```

---

# 16. Work Agent 中非常重要的一层：Runtime Event → Product UI

Coding Agent CLI 可以简单输出：

```text
Thinking...

Running command...

Reading file...

Done.
```

但是一个桌面 Work Agent 需要把这些内容产品化：

```text
Assistant Message

Thinking

正在读取文件...

┌────────────────────┐
│ Read               │
│ report.xlsx        │
└────────────────────┘

正在执行脚本...

┌────────────────────┐
│ Bash               │
│ python analyze.py  │
└────────────────────┘

需要你的授权

┌────────────────────┐
│ Allow    Deny      │
└────────────────────┘
```

因此真正的桌面 Agent 一定存在这样一层：

```text
Agent Runtime Event
        ↓
Agent UI Model
        ↓
Product Component
```

这是桌面 Work Agent 非常值得学习的部分。

因为真正产品落地时，大量复杂度并不在 Agent Loop，而在：

```text
消息状态

执行卡片

实时更新

中断

权限

异常恢复

多任务

多端状态同步
```

---

# 17. Tool Call 如何变成 Tool Card

相关代码可以继续关注：

```text
apps/app/src/react-app/domains/session/sync/parse-tool-parts.ts
```

可以把 OpenCode 返回的：

```text
Tool Part
```

理解成一种：

> **Agent Runtime Protocol。**

OpenWork 再把 Runtime Protocol 转成产品 UI 能理解的结构：

```text
Tool Part
    ↓
Parser
    ↓
UI Part
    ↓
Tool Card
```

最终得到：

```text
OpenCode Tool Call

↓

Runtime Event

↓

OpenWork Tool Part

↓

UI Adapter

↓

Tool Card
```

这条链路非常值得单独研究。

因为它对应的是：

> **Agent Runtime 与 Agent Product UI 的协议边界。**

---

# 18. Permission：Work Agent 的 Human-in-the-loop

桌面 Agent 不可能默认无限制执行所有操作。

例如 Agent 可能需要：

```text
修改本地文件

执行 Shell

访问网络

调用 MCP

执行敏感 SaaS 操作
```

因此会形成 Permission 流程：

```text
Agent
 ↓
Permission Request
 ↓
Runtime Event
 ↓
OpenWork UI
 ↓

┌────────────────────────┐
│ Agent wants to ...     │
│                        │
│ Allow        Deny      │
└────────────────────────┘

 ↓
Permission Reply
 ↓
OpenCode
 ↓
Agent Loop 继续
```

这就是典型的：

> **Human-in-the-loop Agent Runtime。**

从企业级 Agent 的角度，Permission / Approval 体系的重要程度甚至不低于 Agent Loop 本身。

---

# 19. Workspace：OpenWork 的核心抽象

如果 Coding Agent 中：

```text
Workspace ≈ Repository
```

那么 Work Agent 中：

```text
Workspace ≈ AI 被授权工作的文件空间
```

例如：

```text
~/Finance

~/Sales

~/ProjectA

~/Research
```

Workspace 会影响：

```text
Filesystem

Shell cwd

Skill

MCP

Session

File Access

Artifact
```

因此整个对象层级可以先理解为：

```text
User
 ↓
Workspace
 ↓
Session
 ↓
Agent Run
```

---

# 20. directory、workspaceId、sessionId 的关系

阅读 OpenWork 时，经常会看到：

```text
workspaceId

directory

sessionId
```

建议始终保持以下心智模型：

```text
Workspace
    │
    │ directory
    ▼
Filesystem Scope

Workspace
    │
    └── Session A
    │
    └── Session B
```

其中：

```text
workspaceId
=
OpenWork 产品层的 Workspace 标识

directory
=
OpenCode Runtime 实际执行时的文件目录

sessionId
=
一次持续对话 / Agent Task Context
```

这三个概念非常重要。

---

# 21. Session 是什么

可以简单理解为：

```text
Workspace
│
├── Session A
│    ├── User Message
│    ├── Assistant Message
│    ├── Tool Call
│    ├── Tool Result
│    └── Final Response
│
└── Session B
     └── ...
```

OpenWork 大量复用了 OpenCode 原生 Session 能力。

例如：

```text
session.create()

session.promptAsync()

session.abort()

session.revert()

session.unrevert()

session.fork()

session.summarize()

session.shell()
```

因此：

> **OpenWork 没有重新造一个独立的 Session Runtime，而是把 OpenCode Session 当成核心执行实体。**

---

# 22. opencode-session.ts 的定位

相关文件：

```text
apps/app/src/app/lib/opencode-session.ts
```

它主要是对 OpenCode Session API 做一些 typed wrapper。

可以把它理解为：

```text
OpenCode Session SDK
      ↓
OpenWork Helper Layer
      ↓
Product Logic
```

其中会封装：

```text
Abort

Revert

Fork

Compact

Shell

Command
```

因此这个文件虽然重要，但本质上并不是 Agent Loop。

---

# 23. Context Compact

OpenWork 可以直接利用 OpenCode 的 Session Compact 能力。

整体逻辑类似：

```text
Long Session

↓

session.summarize()

或者

/compact

↓

减少上下文长度

↓

继续 Agent Run
```

因此 Context Management 这类底层能力，仍然主要来自 OpenCode Runtime。

---

# 24. OpenWork 如何启动整套 Runtime

另一个重要文件是：

```text
apps/server/src/embedded.ts
```

这个文件负责把整套 Runtime 启动起来。

大致流程：

```text
startEmbeddedServer()

↓

resolve config

↓

启动 OpenWork Server

↓

准备 Runtime Config

↓

createManagedOpencodeServer()

↓

spawn opencode serve

↓

获得 OpenCode Base URL

↓

写入 OpenWork Runtime Config

↓

建立 Proxy / Runtime Connection
```

因此可以把：

```text
embedded.ts
```

理解成：

> **OpenWork Runtime Bootstrap。**

---

# 25. OpenWork 与 OpenCode 的进程关系

在本地 Desktop 模式下，可以粗略理解为：

```text
OpenWork Desktop Process
        │
        ├── Web / React UI
        │
        ├── OpenWork Server
        │
        └── OpenCode Process
```

OpenCode Process 独立运行：

```text
opencode serve
```

OpenWork Server 则负责发现、认证、代理和管理它。

这种模式的好处是：

```text
Agent Engine 与 UI 解耦

Runtime 可以独立重启

可以做 Remote Runtime

可以做代理层

可以做 Engine Pool

可以做多个 Workspace
```

---

# 26. Engine Pool：开始进入生产级 Agent Runtime

一个非常值得关注的文件：

```text
apps/server/src/engine-pool.ts
```

这里已经不是简单桌面 Demo 的问题，而是在处理：

> **Agent Engine 生命周期管理。**

例如一个 OpenCode Engine 当前正在运行 Agent Session：

```text
OpenCode Engine v1
      │
      └── Session A 正在运行
```

此时 Runtime Config 发生变化。

如果直接：

```text
kill v1
启动 v2
```

那么：

```text
Session A
```

就会被直接中断。

因此更合理的做法是：

```text
          Config Reload
                │
                ▼
          启动 Engine v2
                │
                │
        ┌───────┴────────┐
        │                │
        ▼                ▼
   Engine v1         Engine v2
   Draining          Primary
        │                │
旧 Session 继续      新 Session 进入
        │
        ▼
Session 全部完成
        │
        ▼
Kill Engine v1
```

这实际上就是：

> **Blue / Green Agent Engine Rollover。**

---

# 27. 为什么 Engine Pool 很值得研究

这已经开始进入真正的 Agent Runtime 工程问题：

```text
长任务

运行中 Session

配置热更新

Engine 崩溃

重启

任务中断

状态恢复

流量切换

Session Ownership
```

也就是说：

```text
OpenWork
```

已经不仅仅是：

```text
Desktop AI UI
```

还开始处理：

```text
Production-grade Agent Runtime Lifecycle
```

---

# 28. 第一轮源码阅读不要读什么

第一轮目标是理解：

```text
用户任务
→ Agent 执行
→ Runtime Event
→ UI
```

因此建议先跳过大量非核心内容。

---

## 28.1 第一轮先跳过 Enterprise Den

```text
ee/apps/den-*
```

这些主要属于：

```text
Organization Control Plane

Team

Enterprise Policy

Central Capability Management
```

等后续能力。

---

## 28.2 第一轮先跳过大量 UI 细节

例如：

```text
i18n

CSS

大量 Components

Settings

Theme

Login

Analytics

Telemetry

Billing
```

---

## 28.3 Electron 也不用最先读

```text
apps/desktop
```

第一遍只需要知道：

```text
它负责 Desktop Shell / Lifecycle
```

即可。

否则很容易出现：

```text
看了两个小时 Electron 和 React
但还是不知道 Agent 到底怎么跑起来
```

---

# 29. 推荐的第一轮源码阅读顺序

第一轮不要追求“看完 OpenWork”。

只读几个关键文件。

---

## 29.1 第一步：README.md / AGENTS.md

```text
README.md

AGENTS.md
```

目标：

```text
OpenWork 是什么

OpenWork 与 OpenCode 什么关系

Repo 包含哪些主要 Surface
```

这一阶段只建立整体地图。

---

## 29.2 第二步：actions-store.ts

```text
apps/app/src/react-app/domains/session/sync/actions-store.ts
```

只追：

```text
sendPrompt()
```

回答：

```text
用户输入怎么变成 Agent Request

Session 怎么创建

Prompt Part 怎么生成

Model / Agent 怎么带进去

最终调用了哪个 API
```

---

## 29.3 第三步：opencode.ts

```text
apps/app/src/app/lib/opencode.ts
```

重点看：

```text
createClient()

promptAsync

HTTP Adapter

Auth

OpenWork Proxy Mode
```

回答：

```text
OpenWork UI 到底怎么连接 OpenCode
```

---

## 29.4 第四步：embedded.ts

```text
apps/server/src/embedded.ts
```

目标：

```text
OpenWork Server 怎么启动

OpenCode Process 怎么启动

两者怎么建立连接
```

---

## 29.5 第五步：managed-opencode.ts

```text
apps/server/src/managed-opencode.ts
```

重点：

```text
spawn("opencode", ["serve", ...])
```

回答：

```text
真正的 Agent Engine 是哪个进程
```

---

## 29.6 第六步：session-sync.ts

```text
apps/app/src/react-app/domains/session/sync/session-sync.ts
```

重点：

```text
event.subscribe()
```

回答：

```text
Agent 执行过程怎么实时回到 UI
```

---

## 29.7 第七步：parse-tool-parts.ts

```text
apps/app/src/react-app/domains/session/sync/parse-tool-parts.ts
```

回答：

```text
Runtime Tool Event
如何转换为 UI Tool Card
```

---

## 29.8 第八步：engine-pool.ts

```text
apps/server/src/engine-pool.ts
```

最后再看：

```text
OpenCode Engine 生命周期

Blue / Green

Session Draining

Engine Recovery
```

---

# 30. 第一轮源码阅读的完整路线图

可以按照下面这条调用链阅读：

```text
用户输入
   ↓
Composer
   ↓
actions-store.ts
   ↓
sendPrompt()
   ↓
buildPromptParts()
   ↓
session.create()
   ↓
session.promptAsync()
   ↓
opencode.ts
   ↓
OpenCode SDK
   ↓
OpenWork Server
   ↓
/w/:workspace/opencode/*
   ↓
OpenCode Server
   ↓
Agent Loop
   ↓
LLM
   ↓
Tool
   ↓
LLM
   ↓
Tool
   ↓
Final
```

与此同时：

```text
OpenCode Runtime
   ↓
Event Stream
   ↓
event.subscribe()
   ↓
session-sync.ts
   ↓
Runtime Event
   ↓
Message / Tool / Permission / Status
   ↓
React Query / UI State
   ↓
OpenWork Desktop UI
```

这两条链路合起来，就是 OpenWork 最核心的运行原理。

---

# 31. 第一轮读完以后应该能回答的 10 个问题

不要以“看了多少代码”为目标。

第一轮只需要确保能回答下面这些问题：

1. OpenWork 和 OpenCode 到底是什么关系？
2. OpenWork Desktop 启动时有哪些主要进程？
3. OpenCode Server 是怎么启动起来的？
4. Workspace 在 OpenWork 中是什么？
5. Session 是什么？
6. 用户点击 Send 后经过哪些核心函数？
7. `promptAsync` 最终请求到了哪里？
8. OpenCode Agent 执行期间，UI 怎么获得执行进度？
9. Tool Call 怎么变成桌面上的 Tool Card？
10. Permission 怎么暂停并继续一次 Agent Run？

如果这 10 个问题都能清楚回答：

> **基本就已经完成了 OpenWork 的第一阶段入门。**

---

# 32. 第二轮再研究 Work Agent 专属能力

第一轮理解主链路以后，再开始拆 Work Agent 的具体产品能力：

```text
Workspace

File

Artifact

Skill

MCP

Plugin

Browser

Permission

Automation

Remote Worker

Cloud Runtime

Den
```

这时候关注重点就不再是：

```text
Agent Loop 怎么实现
```

而应该变成：

> **如何把一个 Agent Loop 产品化成真正可用的桌面办公 Agent。**

---

# 33. Work Agent 真正复杂的地方

第一眼看 Work Agent，容易觉得：

```text
不就是 Chat UI + Agent Loop 吗？
```

实际上真正落地以后，大量复杂度在：

```text
Workspace

文件访问

本地路径

权限控制

执行确认

Tool Card

长任务

实时状态

中断

恢复

Artifact

Skill

MCP

SaaS

多端

企业权限

Runtime Lifecycle
```

因此 Work Agent 本质上是在做：

```text
Agent Engine
+
Execution Environment
+
Capability System
+
Workspace
+
Product UI
+
Human-in-the-loop
+
Runtime Management
```

---

# 34. OpenWork 最值得学习的并不是 Agent Loop 本身

因为 Agent Loop 核心主要来自 OpenCode。

OpenWork 更值得学习的是：

## 34.1 Agent Runtime 产品化

```text
Agent Runtime Event
↓
User-visible Product State
```

---

## 34.2 Workspace 化

```text
Agent
不是面对一个 Chat Session

而是面对一个真实工作空间
```

---

## 34.3 Capability 化

```text
Skill
MCP
Plugin
File
Shell
Browser
SaaS
```

统一成为 Agent 可以使用的能力。

---

## 34.4 Human-in-the-loop

```text
Permission
Approval
Question
Interrupt
Resume
```

---

## 34.5 Engine 生命周期

```text
Spawn
Health
Reload
Draining
Recovery
Shutdown
```

---

# 35. 用架构语言总结 OpenWork

可以用下面这段作为对 OpenWork 的总体理解：

> **OpenWork 本身不是一个重新设计 Agent Loop 的 Agent Framework，而是一个建立在 OpenCode Agent Runtime 之上的桌面 Work Agent 产品与运行时管理层。它通过 Workspace 对 Agent 的工作域进行抽象，以 OpenCode Session 承载任务执行，通过 File、Shell、Skill、MCP、Plugin 等能力扩展 Agent 的行动空间，再通过 SSE 将 Agent Runtime 的 Message、Tool、Permission、Question、Status 等事件投影为桌面产品交互。OpenWork Server 则位于 UI 与 OpenCode Engine 之间，负责 Workspace、权限、文件、能力配置、Runtime Proxy 以及 OpenCode Engine 生命周期管理。**

进一步可以简化成：

```text
OpenWork Desktop
=
Agent Product

OpenWork Server
=
Agent Runtime Manager / Gateway

OpenCode
=
Agent Engine
```

---

# 36. 最终核心心智模型

最后把整个 OpenWork 压缩成一张图：

```text
                    ┌─────────────────┐
                    │      User       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ OpenWork Desktop│
                    │                 │
                    │ Workspace       │
                    │ Session         │
                    │ Composer        │
                    │ Tool Card       │
                    │ Permission UI   │
                    └────────┬────────┘
                             │
                    Prompt / Command
                             │
                             ▼
                    ┌─────────────────┐
                    │ OpenWork Server │
                    │                 │
                    │ Workspace       │
                    │ File            │
                    │ Skill / MCP     │
                    │ Approval        │
                    │ Artifact        │
                    │ Runtime Proxy   │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ OpenCode Server │
                    │                 │
                    │ Session         │
                    │ Agent Loop      │
                    │ LLM             │
                    │ Tools           │
                    └────────┬────────┘
                             │
                 ┌───────────┴───────────┐
                 │                       │
                 ▼                       ▼
           Files / Shell            MCP / Skill
                 │
                 └───────────┬───────────┘
                             │
                             ▼
                        Real World

                             ▲
                             │
                       SSE / Events
                             │
                    ┌────────┴────────┐
                    │ session-sync.ts │
                    └────────┬────────┘
                             │
                             ▼
                    Message / Tool UI
```

如果第一轮源码阅读始终围绕这张图展开，就不容易掉进大量局部代码细节里失去方向。

---

# 37. 推荐的入门目标

第一阶段不要试图：

```text
完整理解 OpenWork
```

更合理的目标是：

> **先建立一条可以完整讲清楚的核心执行链路。**

也就是：

```text
User Prompt

↓

OpenWork Composer

↓

sendPrompt()

↓

OpenCode SDK

↓

promptAsync

↓

OpenWork Server

↓

OpenCode Agent Loop

↓

Tool Execution

↓

SSE Runtime Events

↓

session-sync

↓

Tool Card / Message / Permission UI
```

当这条链路真正理解以后，再去扩展：

```text
Workspace
File
Artifact
Skill
MCP
Plugin
Automation
Browser
Remote Runtime
Enterprise Control Plane
```

此时整个 OpenWork 的源码结构会变得非常容易理解。