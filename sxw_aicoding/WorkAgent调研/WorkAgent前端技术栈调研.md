# Work Agent 前端技术栈调研

> 调研快照：2026-08-20  
> 调研范围：Codex、Claude Cowork、腾讯 WorkBuddy、OpenWork、OpenCode Desktop，以及具有代表性的开源桌面 Agent 产品。  
> 证据原则：仅采用官方产品文档、官方仓库源码、固定 commit 的 package manifest、官方发布与安全公告。闭源产品没有公开的实现细节一律标为“未公开”，不通过安装包外观或进程名猜测技术栈。文中另有一项本机安装包 manifest 的可重现观察，已单独标注适用范围，不把它泛化为官方长期技术承诺。

## 1. 结论先行

目前桌面 Agent 的前端并没有一个所有产品都遵循的唯一技术栈，但开源成熟项目已经呈现出很明确的工程收敛：

- **桌面壳以 Electron 为主，Tauri 是有实际成熟案例的少数路线。** 本次核实的 OpenWork、OpenCode Desktop、Cherry Studio、5ire 当前均使用 Electron；Jan 使用 Tauri 2。
- **React + TypeScript + Vite 系构建是最常见的 UI 组合。** OpenWork、Cherry Studio、Jan、5ire 都采用 React；OpenCode 是本次样本中的主要例外，采用 SolidJS。
- **成熟 Agent UI 不是“流式字符串聊天框”。** 它们通常将一次执行拆成 text、reasoning、tool、approval、artifact、terminal、diff 等结构化 part，再分别渲染。
- **流式性能是专门的前端课题。** 高频 delta 通常经过 `requestAnimationFrame` 合帧、节流或稳定块拆分，不会让每个 token 都触发整棵消息树重渲染。
- **Tool Call 与 Artifact 已成为独立 UI 子系统。** Tool Call 需要状态机、审批、参数与错误展示；Artifact 需要独立侧栏、预览器注册表、打开/下载/定位等操作，而不是聊天消息里的一个文件链接。
- **状态管理正在分层。** SQLite 或后端数据层保存 Task/Run/Event/Artifact 等事实；Query Cache 管异步快照；Zustand、Context 或 signals 只处理短生命周期 UI 状态。
- **安全边界比组件库更重要。** Markdown、网页、HTML Artifact、模型输出和工具输出都是不可信输入；清洗、CSP、sandbox iframe、窄 IPC、Renderer sandbox 必须从第一版建立。

结合当前项目“macOS-first、个人本地 Work Agent、自研 Agent Loop、Chrome Extension、未来可接外部 engine”的约束，推荐第一版采用：

> **Electron + React 19 + TypeScript + electron-vite + Tailwind CSS 4 + Radix/shadcn 风格组件 + TanStack Query/Virtual + Zustand（仅 UI 状态）+ SQLite（任务事实）+ Streamdown/Shiki + Vitest/Testing Library/Playwright。**

Agent Loop 不放进 Renderer，也不与 React Store 耦合；它运行在独立 Node utility process 中，通过版本化 `RunEvent` 协议向 UI 输出事件。未来的 OpenCode、Codex App Server 或其他外部 engine 只需要适配为同一事件协议。

---

## 2. 闭源对标产品：可以借鉴产品界面，不能声称其技术栈

### 2.1 Codex / ChatGPT Desktop

截至调研日，OpenAI 已将 Codex 桌面体验合入新的 ChatGPT Desktop；官方披露了线程、项目、并行 Agent、diff 内联编辑、PR 侧栏、多仓库项目等产品能力，但**没有公开桌面 UI 使用 React、Electron、Tauri 或其他具体前端框架的官方技术说明**。[OpenAI：ChatGPT 与 Codex 桌面整合](https://openai.com/index/chatgpt-for-your-most-ambitious-work/)

可以确认、值得借鉴的 UI 模式包括：

- Agent 按 Project 组织成独立 Thread；用户可在线程内审查 diff、添加评论并跳转编辑器。[Codex App 官方发布](https://openai.com/index/introducing-the-codex-app/)
- 长任务不仅输出文本，还实时同步 screenshot、terminal output、diff、test result 与 approval，说明执行过程是结构化事件流而非单一 token stream。[OpenAI：Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- Codex harness 通过双向 JSON-RPC 的 App Server 暴露给不同客户端。这是“Agent engine 与 UI 协议分离”的官方案例，但不能据此推断桌面 UI 框架。[OpenAI：Codex App Server](https://openai.com/index/unlocking-the-codex-harness/)

结论：Codex 可作为 **Thread、Diff、Approval、Remote continuation** 的产品参考；公开资料不足以把它纳入 React/Electron 技术统计。

本机补充观察（仅限当前安装构建）：2026-08-20 从 `/Applications/ChatGPT.app/Contents/Resources/app.asar` 直接提取的 `package.json` 标识自身为 `openai-codex-electron`，版本为 `26.818.21641`，并列出 Electron 42.3、Electron Forge 7.11、Vite 8.1、TypeScript 7.0、`better-sqlite3`、Vitest 和 Playwright。可重现命令为：

```bash
npx @electron/asar extract-file \
  /Applications/ChatGPT.app/Contents/Resources/app.asar \
  package.json
```

这能证明当前本机构建采用 Electron 系技术，但它不是官方公开的长期架构说明，也不能由此断定 Renderer 使用 React、Solid 或其他 UI 框架。

### 2.2 Claude Cowork

Claude Cowork 运行在 Claude Desktop，并支持任务引导、文件预览、本地文件、浏览器、computer use 和 Live Artifact；截至调研日，官方**未公开 Claude Desktop/Cowork 的 UI 框架、状态库、Markdown 库或桌面壳实现**。[Claude：各端 Cowork 能力矩阵](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)

值得借鉴的产品模式是：

- Desktop 是完整能力面，用户可以启动、引导和审查任务，并预览生成文件。[Claude：各端 Cowork 能力矩阵](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)
- Live Artifact 是持久、可交互、可版本恢复的独立 HTML 产物，并在 Artifacts 视图中脱离原聊天长期存在。[Claude：Live Artifacts](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork)
- 官方安全模型明确区分 read tool 与 write tool，并对永久删除等动作要求许可；这意味着前端 Approval 不是普通确认框，而是 Agent 安全边界的一部分。[Claude：安全使用 Cowork](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely)

结论：Cowork 可作为 **持久 Artifact、权限分层、跨端继续任务** 的产品参考；其前端技术实现未公开。

### 2.3 腾讯 WorkBuddy

腾讯官方提供 macOS 与 Windows 桌面客户端，但没有公开桌面端源码、package manifest 或 UI 框架，因此 Electron/Tauri、React/Vue 等均应记为**未公开**。[WorkBuddy 官方产品页](https://www.workbuddy.cn/work/)

官方文档公开的界面结构非常有参考价值：

- 左侧为任务/空间，中间为持续对话与关键执行步骤，右侧结果区集中展示 Workspace 文件、内置浏览器、文件变更和 Artifact。[WorkBuddy：任务管理](https://www.workbuddy.cn/docs/workbuddy/Task-Management)、[WorkBuddy：结果查看](https://www.workbuddy.cn/docs/workbuddy/Results)
- 执行中会展示阶段说明、结果摘要和可展开的中间步骤；用户可以中断后继续追问。[WorkBuddy：任务对话](https://www.workbuddy.cn/docs/workbuddy/Conversation)
- 简洁模式会折叠 Tool Call 等过程信息，说明“摘要优先、详情按需展开”比默认输出所有日志更适合办公用户。[WorkBuddy：系统设置](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Setting)
- 官方结果区把 Word、Markdown、PDF、Excel、CSV、PPT、报告等统一视为 Artifact，并提供预览、分享、Workspace 文件树和变更视图。[WorkBuddy：结果查看](https://www.workbuddy.cn/docs/workbuddy/Results)

结论：WorkBuddy 是本项目 **三栏工作台、Task 状态、Tool 摘要和 Artifact 侧栏** 最直接的产品参考，但不能用来证明某种前端技术栈。

---

## 3. 开源项目技术栈总览

以下链接均固定到本次调研时的仓库 commit，避免主分支后续变化造成结论漂移。

| 项目 | 相关性 | 桌面壳 | UI / 语言 | 构建 | 状态与数据 | Markdown / Tool / Artifact | 测试与打包 |
|---|---|---|---|---|---|---|---|
| OpenWork | 最接近通用桌面 Work Agent | Electron 43.2 | React 19、TypeScript | Vite 6、pnpm、Turbo | TanStack Query + Zustand；SQLite/Drizzle 在桌面层 | Marked、DOMPurify、Shiki；专用 Tool Card；独立 Artifact Panel | Bun/Node tests；electron-builder |
| OpenCode Desktop | 成熟 Coding Agent 工作台，可参考高频流和 engine 分离 | Electron 42.3 | SolidJS、TypeScript | Vite 7、electron-vite、Bun、Turbo | Solid Store/Context + TanStack Solid Query | 自研流式 Markdown；BasicTool；Diff/Terminal/File 工作台 | Bun、Playwright、Storybook；electron-builder |
| Cherry Studio 2.0 RC | 接近桌面 Work Agent，有 Workspace、Tool、Artifact | Electron 41 | React 19、TypeScript | electron-vite、Rolldown-Vite、pnpm | Data API + Drizzle/Dexie；Context/hooks/external store | Streamdown、Shiki；专用工具；独立 Artifact Pane | Vitest、Testing Library、Playwright、Storybook；electron-builder |
| Jan | Tauri 路线的成熟本地 AI 客户端 | Tauri 2 / Rust | React 19、TypeScript | Vite 6 | Zustand + TypeScript Core/Tauri plugins | Streamdown、Shiki；细粒度 Tool Approval；HTML Artifact | Vitest、Testing Library；Tauri CLI |
| 5ire | 较轻量的 Electron + MCP Client 路线 | Electron 31 | React 18、TypeScript | Rsbuild/Rspack | Zustand + SWR；SQLite/PGlite/Drizzle | markdown-it、highlight.js；基础 Tool/Approval；无成熟 Artifact Workspace | Jest、Testing Library；electron-builder |

总览证据：[OpenWork App manifest](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/package.json)、[OpenWork Desktop manifest](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/desktop/package.json)、[OpenCode App manifest](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/app/package.json)、[OpenCode Desktop manifest](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/desktop/package.json)、[Cherry Studio manifest](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/package.json)、[Jan Web manifest](https://github.com/janhq/jan/blob/3dcf4cad0124ab72763ac4c5b2edff05b60f81ad/web-app/package.json)、[5ire manifest](https://github.com/nanbingxyz/5ire/blob/d55f353ea507b192afdd77982fa03125e8a84084/package.json)。

### 3.1 OpenWork

本次源码核实的首要纠偏是：**OpenWork 当前桌面壳是 Electron 43.2，不是 Tauri。** 仓库个别旧说明仍可能出现 Tauri，但当前 `apps/desktop` manifest 和打包配置明确使用 Electron 与 electron-builder，应以可执行源码和 manifest 为准。[Desktop manifest](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/desktop/package.json)、[electron-builder 配置](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/desktop/electron-builder.base.yml)

前端主体是 React 19 + TypeScript + Vite 6；React Router 区分 Web 与 Desktop 路由模式，TanStack Query 负责异步/服务端状态，Zustand 按 notification、workbench、composer、scroll 等领域保存 UI 状态。[App manifest](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/package.json)、[React 应用架构说明](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/ARCHITECTURE.md)

其事件链路具有很强的参考价值：OpenCode SDK 的 SSE 事件进入 session sync，规范化后写入 TanStack Query Cache；文本 delta 先缓冲，再按 `requestAnimationFrame` 合并，恢复时采用 Snapshot + SSE reconciliation。[Session sync](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/sync/session-sync.ts)

Agent 消息使用 Vercel AI SDK 的 `UIMessage` 思路，把原始 engine part 转成 text、reasoning、file、dynamic-tool；Tool Call 再按 bash、edit、read、grep、skill、todo、web 等类型分发到专门组件。[UIMessage 适配](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/sync/usechat-adapter.ts)、[Tool 组件目录](https://github.com/different-ai/openwork/tree/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/components/tools)

Markdown 使用 Marked、DOMPurify 和 Shiki：流式阶段快速同步渲染，完成后再异步高亮 fenced code；已完成消息通过 memo 避免跟随当前消息的 token 重算。[Markdown surface](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/surface/markdown.tsx)、[Markdown primitive](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/components/markdown/markdown-primitive.ts)

Artifact 是独立领域：Panel 支持 Markdown、文本、HTML、PDF、图片和 Spreadsheet 预览/编辑，以及下载、Finder 定位、外部应用打开；二进制内容使用 Blob URL，不放入消息状态。[Artifact Panel](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/artifacts/artifact-panel.tsx)、[Preview registry](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/artifacts/preview.tsx)

需要避免照搬的是 Electron 安全配置：它虽然启用了 `contextIsolation` 并关闭 `nodeIntegration`，但当前 Renderer `sandbox` 为 `false`，preload 暴露面也较宽。[OpenWork BrowserWindow](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/desktop/electron/main.mjs)、[OpenWork preload](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/desktop/electron/preload.mjs)

### 3.2 OpenCode Desktop

OpenCode 当前桌面版同样已经从早期 Tauri 迁移为 Electron 42.3，Renderer 使用 SolidJS，Main/Preload/Renderer 均为 TypeScript，构建采用 electron-vite、Vite、Bun workspace 和 Turbo。[Desktop manifest](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/desktop/package.json)、[electron-vite 配置](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/desktop/electron.vite.config.ts)

它没有采用 Redux/Zustand 单体 store，而是通过 Solid signals/store、Context Provider 和 TanStack Solid Query 分层。高频 session/message/part/todo/permission/question/status 事件从 SDK subscription 进入 EventBus，再由按 server/directory 分区的 reducer 写入 Solid Store。[SDK event bus](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/app/src/context/server-sdk.tsx)、[事件 reducer](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/app/src/context/global-sync/event-reducer.ts)

其流式 Markdown 比普通聊天组件更复杂：将稳定 block 与变化中的 tail block 分开，修复不完整 Markdown，把 Shiki 放进 Worker，并用 MorphDOM 局部更新，降低闪烁、滚动跳动和文本选择丢失。[Markdown 组件](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/session-ui/src/components/markdown.tsx)、[流式分块](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/session-ui/src/components/markdown-stream.ts)

Tool UI 使用统一 `BasicTool` 外壳，并根据不同 `ToolPart` 渲染；pending/running、错误、展开、延迟挂载都有专门处理。OpenCode 更强调文件、diff、批注与 terminal 工作台，当前没有 OpenWork 那样通用的 Office Artifact Panel。[BasicTool](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/session-ui/src/components/basic-tool.tsx)、[ToolPart 分发](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/session-ui/src/components/message-part.tsx)

其 Electron 边界更适合作为安全参考：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，并通过 typed preload 暴露白名单 API。[Window 安全配置](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/desktop/src/main/windows.ts)、[Typed preload](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/desktop/src/preload/index.ts)

### 3.3 Cherry Studio

Cherry Studio 2.0 RC 采用 Electron 41 + React 19 + TypeScript、electron-vite、Tailwind 4、TanStack Router/Virtual，并维护以 Radix、CVA、Lucide 为基础的自有 UI package。[根 manifest](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/package.json)、[UI package](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/packages/ui/package.json)

它的 IPC Transport 将 Main 到 Renderer 的数据转换为 `ReadableStream<UIMessageChunk>`，包含 buffered reconnect、abort/detach 区分，并用 RAF 批量刷新 delta。[IPC ChatTransport](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/src/renderer/services/aiTransport/IpcChatTransport.ts)

其 Artifact Pane 已具备 Workspace 文件树、文件预览与编辑、大小限制和外部应用打开；Tool Header 会为 Agent、Bash、Read、Write、Edit、Task、Skill 等提供不同摘要，和本项目目标高度相关。[Artifact Pane](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/src/renderer/components/chat/panes/ArtifactPane.tsx)、[Tool 映射](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/src/renderer/components/chat/messages/tools/ToolHeader.tsx)

### 3.4 Jan

Jan 是本次样本中值得保留的 Tauri 对照：桌面壳使用 Tauri 2/Rust，前端仍是 React 19 + TypeScript + Vite 6，并采用 Zustand、Tailwind、Radix、AI SDK、Streamdown 和 Shiki。[Jan Web manifest](https://github.com/janhq/jan/blob/3dcf4cad0124ab72763ac4c5b2edff05b60f81ad/web-app/package.json)、[Tauri 配置](https://github.com/janhq/jan/blob/3dcf4cad0124ab72763ac4c5b2edff05b60f81ad/src-tauri/tauri.conf.json)

Tool Card 覆盖 queued、running、failed、used、参数、结果和耗时，并提供 allow once、thread、always 等不同审批粒度；HTML Artifact 具有 code/preview 双视图，完成后在带 CSP 的 sandbox iframe 中预览。[Tool Card](https://github.com/janhq/jan/blob/3dcf4cad0124ab72763ac4c5b2edff05b60f81ad/web-app/src/components/ai-elements/tool.tsx)、[HTML Artifact](https://github.com/janhq/jan/blob/3dcf4cad0124ab72763ac4c5b2edff05b60f81ad/web-app/src/components/HtmlArtifact.tsx)

Jan 说明 Tauri 并非不能承载成熟 Agent UI；但 Tauri 的后端是 Rust，而本项目首版希望以 TypeScript 自研 Agent Loop、广泛调用 Node/npm 工具，因此若采用 Tauri，仍需 Node sidecar 或把核心 Runtime 改写为 Rust。Tauri 官方支持打包任意语言的 sidecar，但这会增加进程、协议、签名和发布复杂度。[Tauri：Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)

### 3.5 5ire

5ire 采用 Electron 31、React 18、TypeScript、Rsbuild/Rspack、Fluent UI 9、Zustand 和 SWR，是相对传统、较轻量的 MCP Client 路线。[5ire manifest](https://github.com/nanbingxyz/5ire/blob/d55f353ea507b192afdd77982fa03125e8a84084/package.json)、[Rsbuild 配置](https://github.com/nanbingxyz/5ire/blob/d55f353ea507b192afdd77982fa03125e8a84084/rsbuild.config.ts)

其 Markdown 仍以 markdown-it、highlight.js、KaTeX、Mermaid、DOMPurify 为主；UI 用 50ms debounce 降低流式重绘，敏感 MCP 调用弹出 Approval Dialog。它没有成熟的独立 Artifact Workspace，因此更适合作为“简单 Agent Chat 如何演进”的对照，而不是本项目产品壳的直接模板。[Markdown hook](https://github.com/nanbingxyz/5ire/blob/d55f353ea507b192afdd77982fa03125e8a84084/src/hooks/useMarkdown.ts)、[流式消息](https://github.com/nanbingxyz/5ire/blob/d55f353ea507b192afdd77982fa03125e8a84084/src/renderer/pages/chat/Message.tsx)、[MCP Tool Loop](https://github.com/nanbingxyz/5ire/blob/d55f353ea507b192afdd77982fa03125e8a84084/src/intellichat/services/NextChatService.ts)

---

## 4. 成熟 Work Agent 前端的共同设计

### 4.1 桌面壳：Electron 是当前主流，但不是无条件正确

Electron 将 Chromium 与 Node.js 放进同一桌面运行时，可用一套 JavaScript/TypeScript 代码覆盖 macOS、Windows 和 Linux；Main、Preload、Renderer 的进程模型也天然适合把系统能力与 UI 分离。[Electron 官方介绍](https://www.electronjs.org/docs/latest/tutorial/tutorial-prerequisites)、[Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)

Tauri 使用系统 WebView，包体更小，前端框架无关，并通过 Rust command/plugin 提供本地能力；官方推荐 SPA 使用 Vite。[Tauri 官方介绍](https://v2.tauri.app/start/)、[Tauri Frontend Configuration](https://v2.tauri.app/start/frontend/)

两者真正的选择标准不是“谁更先进”，而是 Runtime 放在哪里：

- Agent Loop、MCP、Office 处理、Git、Shell 和 npm 生态主要使用 TypeScript/Node 时，Electron 的集成路径更短。
- Agent Core 已经是 Rust，或极其看重安装包大小、愿意维护 Rust/TS 边界时，Tauri 更合理。
- 外部 engine 无论在 Electron 还是 Tauri 中都应作为独立进程；Tauri 把它称为 sidecar，Electron 可以使用 child process 或 Node-enabled utility process。[Tauri Sidecar](https://v2.tauri.app/develop/sidecar/)、[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)

### 4.2 消息模型：不要让 UI 直接消费模型供应商格式

成熟实现通常在 UI 前增加一层规范化协议：

```text
Model / Agent Engine / External Engine
                  ↓
             Engine Adapter
                  ↓
     versioned RunEvent / MessagePart
                  ↓
 Transcript / Tool / Approval / Artifact UI
```

OpenWork 把 OpenCode Part 映射为 `UIMessage`；OpenCode 把 SSE 写入自己的 EventBus/reducer；Cherry Studio 用自定义 `ChatTransport` 将 IPC 转为统一的 `UIMessageChunk`。[OpenWork adapter](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/sync/usechat-adapter.ts)、[OpenCode sync](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/app/src/context/server-sync.tsx)、[Cherry IPC Transport](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/src/renderer/services/aiTransport/IpcChatTransport.ts)

这层协议是未来接入 OpenCode 等 engine 的关键 seam，比先选择 Redux 还是 Zustand 更重要。

### 4.3 流式更新：Snapshot + Event + Reconciliation

仅依赖在线 token stream 会导致应用重启、页面重载、断线重连后无法恢复。更成熟的结构是：

1. 加载一次 Run snapshot；
2. 从 `seq/cursor` 继续订阅事件；
3. reducer 按事件更新本地投影；
4. 重连后补拉缺失事件并 reconciliation；
5. delta 按一帧或固定时间窗批量提交 UI。

OpenWork 明确采用 Snapshot + SSE 并以 RAF 合并 delta；Cherry 提供 buffered reconnect；OpenCode 则按 server/directory 维护 bootstrap、重连和事件 reducer。[OpenWork session sync](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/sync/session-sync.ts)、[Cherry transport](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/src/renderer/services/aiTransport/IpcChatTransport.ts)、[OpenCode server sync](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/app/src/context/server-sync.tsx)

### 4.4 Markdown：流式内容与完成内容采用不同策略

Agent Markdown 经常包含未闭合代码块、表格、长代码、公式和图表，不能等同于普通博客 Markdown。样本项目的共同策略包括：

- 流式阶段轻量解析，完成后再做 Shiki 高亮；
- 稳定 block 与正在变化的 tail 分开；
- completed message memo/cache；
- 长列表虚拟化；
- DOMPurify/rehype-sanitize 与严格链接策略。

OpenCode 的 block/tail + Worker + MorphDOM 是高复杂度方案；OpenWork 的快速流式渲染 + 完成后高亮更适合首版；Cherry 和 Jan 使用面向 AI stream 的 Streamdown。[OpenCode markdown stream](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/session-ui/src/components/markdown-stream.ts)、[OpenWork markdown](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/surface/markdown.tsx)、[Jan manifest](https://github.com/janhq/jan/blob/3dcf4cad0124ab72763ac4c5b2edff05b60f81ad/web-app/package.json)

### 4.5 Tool Call：组件本质是状态机

Tool UI 至少需要表达：

```text
queued → running → awaiting_approval → running → succeeded
                 └────────────────────────────→ failed / cancelled
```

每张卡片需要短标题、输入摘要、运行状态、耗时、输出摘要、错误和按需展开的原始详情；对办公用户默认显示“正在下载 8 张图片”比显示函数名和 JSON 更合适。OpenWork、OpenCode、Cherry、Jan 都采用统一外壳 + 专用工具渲染的组合，而不是直接 dump JSON。[OpenWork collapsible tool](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/components/tools/collapsible-tool.tsx)、[OpenCode BasicTool](https://github.com/anomalyco/opencode/blob/b155b15694dbcc6768f11d2f25cc2bdd1f738ab4/packages/session-ui/src/components/basic-tool.tsx)、[Jan Tool Card](https://github.com/janhq/jan/blob/3dcf4cad0124ab72763ac4c5b2edff05b60f81ad/web-app/src/components/ai-elements/tool.tsx)

### 4.6 Artifact：独立工作台而不是消息附件

适合 Work Agent 的 Artifact UI 至少应包含：

- MIME/扩展名驱动的 Preview Registry；
- 文件树、Tabs、预览、打开、下载、Finder 定位；
- Markdown、图片、PDF、HTML 的首期预览；
- 版本、来源 Run、生成状态和验证状态；
- HTML Artifact 的 sandbox iframe；
- 大文件只保存 path/metadata，不进入 React Store。

OpenWork 和 Cherry Studio 已提供完整侧栏式 Artifact 工作台；WorkBuddy 官方产品也采用对话区 + 右侧产物/文件/浏览器/变更区。[OpenWork Artifact Panel](https://github.com/different-ai/openwork/blob/171cf5854a28b53e8d884217ade4fbf208a0e278/apps/app/src/react-app/domains/session/artifacts/artifact-panel.tsx)、[Cherry Artifact Pane](https://github.com/CherryHQ/cherry-studio/blob/1d808f0ceafc13b21c3d09757210d2a61b4b0abe/src/renderer/components/chat/panes/ArtifactPane.tsx)、[WorkBuddy Results](https://www.workbuddy.cn/docs/workbuddy/Results)

### 4.7 测试与打包

新架构项目已普遍转向 Vitest + Testing Library + Playwright；OpenCode、Cherry 还包含 Storybook 或 browser/performance tests。打包方面，本次所有 Electron 开源样本都使用 electron-builder，Jan 使用 Tauri CLI。Electron 官方则推荐 Electron Forge 作为官方工具链整合方案。[Electron Packaging](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)

无论使用 builder 还是 Forge，macOS 对外分发都应从第一版准备 Developer ID 签名、hardened runtime 与 notarization，而不是临发布再补。[Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)

---

## 5. 对本项目的技术建议（与上面的事实分开）

### 5.1 桌面壳：第一版选择 Electron

推荐 Electron，不是因为 Tauri 做不到，而是因为它更符合当前约束：

1. 自研 Agent Loop 首期可全部使用 TypeScript/Node，实现模型流、工具调用、MCP、Git、文件和 Office 脚本编排时语言边界最少。
2. Electron 的 Chromium 渲染一致性更适合复杂 Markdown、文件预览、代码高亮、HTML Artifact 和后续内置浏览器。
3. OpenWork、OpenCode、Cherry Studio 已经验证复杂 Agent 工作台可以采用这条路线。
4. Chrome Extension 的 Native Messaging、外部 engine 子进程和本地 CLI 都能从 Node host 统一管理。

不建议把 Agent Loop 直接放在 Electron Main。Main 只负责窗口、系统菜单、生命周期和安全策略；Loop 放在独立 `utilityProcess`，即使工具执行崩溃或内存泄漏，也不会直接拖死桌面壳。Electron 官方的 `utilityProcess.fork` 提供 Node child process 与 MessagePort。[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)

当下面条件出现时再重新评估 Tauri：Agent Core 已迁为 Rust、安装包/内存成为明确瓶颈，或需要更强的 capability allowlist 且团队愿意长期维护 Rust。

### 5.2 推荐前端组合

| 领域 | 推荐 | 说明 |
|---|---|---|
| Monorepo | pnpm workspace | Desktop、Chrome Extension、contracts、agent-core、UI 可以共享 TS 类型；首期不必立即引入 Turbo |
| Desktop | Electron | macOS-first，同时保留 Windows 扩展路径 |
| UI | React 19 + TypeScript | 办公预览、编辑器、图表和组件生态更丰富；更接近 OpenWork/Cherry/Jan |
| 构建 | electron-vite + Vite | Main/Preload/Renderer 分入口，开发体验直接 |
| 路由 | TanStack Router 或 React Router | Workspace/Task/Run 身份进入 URL，不藏在全局 store |
| 异步数据 | TanStack Query | 加载 Task/Run snapshot、Artifact metadata、Capability 状态 |
| UI 状态 | Zustand | 仅 sidebar、panel、composer draft、selection、scroll 等临时状态 |
| 持久化 | SQLite + repository layer | Task、Run、Event、Approval、Artifact 是事实，不存进 Zustand |
| 校验 | Zod | IPC、RunEvent、Extension、外部 engine 数据都在边界验证 |
| 样式 | Tailwind CSS 4 + Radix + CVA | 用 shadcn 风格复制组件到项目中，并维护自己的 design tokens |
| 图标/通知 | Lucide + Sonner | 简单、成熟、与上述组件体系一致 |
| 长列表 | TanStack Virtual | Transcript、Tool Event、文件树在长任务中必须可虚拟化 |
| Markdown | Streamdown + Shiki | 首版采用现成流式 Markdown；完成后再高亮代码 |
| 编辑器 | CodeMirror 6 | Markdown/文本轻编辑；不要首期引入 Monaco |
| Terminal | xterm.js，后置 | 只有真实问题排查场景需要时再加入 |
| 测试 | Vitest + Testing Library + Playwright | 单元、组件、Electron E2E 三层 |
| 打包 | electron-builder | 与 electron-vite 及参考项目一致；从第一版加入签名/notarization 配置 |

`electron-builder` 是本项目建议，不是唯一正确答案；若更重视 Electron 官方整合和默认安全模板，也可以使用官方推荐的 Electron Forge。[Electron Forge 概览](https://www.electronjs.org/docs/latest/tutorial/forge-overview)

### 5.3 自研 Agent Loop 与前端之间的协议

建议定义产品自己的协议，而不是采用某个模型 SDK 的 message 类型作为领域模型：

```ts
type RunEvent =
  | { type: "run.started"; runId: string; seq: number }
  | { type: "assistant.delta"; messageId: string; delta: string; seq: number }
  | { type: "reasoning.summary.delta"; partId: string; delta: string; seq: number }
  | { type: "tool.queued"; callId: string; tool: string; input: unknown; seq: number }
  | { type: "tool.started"; callId: string; seq: number }
  | { type: "tool.progress"; callId: string; progress: unknown; seq: number }
  | { type: "approval.requested"; approvalId: string; action: unknown; seq: number }
  | { type: "tool.completed"; callId: string; output: unknown; seq: number }
  | { type: "tool.failed"; callId: string; error: unknown; seq: number }
  | { type: "artifact.created"; artifactId: string; path: string; mediaType: string; seq: number }
  | { type: "run.completed"; runId: string; seq: number }
  | { type: "run.failed"; runId: string; error: unknown; seq: number };
```

关键约束：

- 所有事件有 `runId + seq + schemaVersion`，可以持久化、补拉和重放。
- `assistant.delta` 只用于传输；持久层可以定期合并 checkpoint，避免一 token 一行 SQLite。
- Renderer 只消费规范事件，不知道模型供应商，也不知道 Run 来自自研 Loop 还是外部 engine。
- 外部 OpenCode/Codex engine 通过 Adapter 把 SSE/JSON-RPC 转为 `RunEvent`。
- Tool 和 Artifact 使用 renderer registry：未知类型必须有 Generic fallback，新增 Capability 不需要修改 Transcript 主组件。

### 5.4 推荐 UI 信息架构

第一版可以直接采用被 OpenWork、Cherry 和 WorkBuddy 共同验证的三栏结构：

```text
┌──────────────┬───────────────────────────┬──────────────────────┐
│ Workspace    │ Task Transcript           │ Result Workbench     │
│ Task list    │ Plan / Message / Tool     │ Artifact / Files     │
│ Run status   │ Approval / Progress       │ Preview / Manifest   │
└──────────────┴───────────────────────────┴──────────────────────┘
```

首个“网页离线归档”任务应有专门的 Tool Card：

- 打开页面；
- 提取正文；
- 发现媒体数量；
- 图片/视频下载进度；
- 失败媒体清单；
- 生成 Markdown；
- 完整性校验；
- ZIP Artifact。

右侧 Artifact Workbench 首期只实现 Markdown、图片、视频 metadata、JSON manifest 和 ZIP 文件结构预览。Word/Excel/PPT/PDF 预览应通过 Preview Adapter 后续增加，不要把每种格式写进聊天组件。

### 5.5 Chrome Extension

Chrome Extension 建议使用 Manifest V3 + TypeScript；content script 与 service worker 不需要 React，只有设置页或 popup 需要时再复用 React。Extension 与本地应用通过 Native Messaging 通信；Chrome 官方要求 `nativeMessaging` 权限，并规定 content script 需要先把消息转给 extension service worker，再由其连接 Native Host。[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

Native Host 应是独立、最小权限的 helper，而不是给 Extension 暴露通用 shell。通信消息同样经过 Zod 校验，并限制允许的 extension ID、操作类型、URL 和输出目录。

### 5.6 安全基线

Renderer 必须设置：

```ts
{
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true
}
```

Preload 只暴露逐项、typed、校验过的 API，不能把 `ipcRenderer.send/on` 原样交给页面。Electron 官方把 context isolation、sandbox、CSP、验证 IPC sender、限制导航和避免向不可信页面暴露 Electron API列为安全基线。[Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)、[Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)

此外：

- Markdown 在进入 DOM 前清洗；链接统一拦截后交给系统浏览器。
- HTML Artifact 只在单独的 sandbox iframe/WebContents 中运行，不带 Node，不允许继承主页面权限。
- 网页正文、模型输出和 Tool output 都不能产生可执行 IPC。
- Browser preview 与主 Renderer 使用不同 session/partition 和更严格权限。
- Workspace path 在 Main/Agent Core 侧进行 realpath 与 symlink escape 校验，不能依赖前端隐藏按钮实现安全。

这不是理论风险：AnythingLLM 官方安全公告记录过流式 Markdown 清洗不一致导致的 stored XSS，并可在 Electron 环境升级为远程代码执行。[AnythingLLM 官方安全公告 GHSA-rrmw-2j6x-4mf2](https://github.com/Mintplex-Labs/anything-llm/security/advisories/GHSA-rrmw-2j6x-4mf2)

### 5.7 测试与发布基线

第一版就应建立以下测试：

- `RunEvent reducer` 的顺序、重复、缺失、重连与 replay 单测；
- streaming Markdown 的未闭合代码块、表格、超长消息和 XSS fixture；
- Tool Card 各状态与 Approval 交互的组件测试；
- Artifact Preview Registry 与未知类型 fallback 测试；
- Electron E2E：新建 Task → Agent Loop → Tool → Approval → Artifact；
- 网页归档固定样本：公开静态页、动态页、登录页、懒加载图、失败媒体；
- macOS 打包后 smoke test，包括 Chrome Native Host 注册、应用重启恢复和 ZIP 打开。

macOS 分发采用 Developer ID Application、hardened runtime、notarization 和 stapling。Electron 官方文档明确建议分发应用进行代码签名，并提供 Forge/Packager 的 notarization 路径。[Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)

---

## 6. 建议形成的前端技术决策

可以把本轮讨论先收敛为以下 ADR 候选：

1. **ADR-001：桌面壳选择 Electron，Tauri 保留为未来重评项。**
2. **ADR-002：Renderer 使用 React 19 + TypeScript + Vite，不使用 Next.js/SSR。**
3. **ADR-003：Agent Core 运行在独立 utility process，通过版本化 RunEvent 与 UI 通信。**
4. **ADR-004：Task/Run/Event/Approval/Artifact 落 SQLite；TanStack Query 管快照，Zustand 只管临时 UI。**
5. **ADR-005：Transcript、Tool、Approval、Artifact 使用可扩展 Part Registry。**
6. **ADR-006：首版采用三栏 Workbench，Artifact 是一级对象。**
7. **ADR-007：Renderer sandbox、窄 typed IPC、Markdown 清洗和 HTML Artifact 隔离是不可延期的第一版要求。**
8. **ADR-008：Chrome Extension 使用 MV3 + Native Messaging，Native Host 不提供通用命令执行。**

如果以上选择达成一致，下一步就可以进入两项更具体的设计：

- 先定义 `RunEvent / MessagePart / ToolPart / Artifact` 的 TypeScript contract；
- 再基于 contract 搭建 Electron 三进程最小骨架和网页归档纵向切片。
