# Agentic UI 协议调研

> 调研快照：2026-08-21  
> 调研范围：Agent 与用户界面交互层面的开放协议生态，重点回答两个问题：(1) 除 AG-UI 与 A2UI 之外，还有哪些相对成熟的 agentic UI 层协议；(2) 在事件流传输层，AG-UI 是否已是当下最主流的协议。  
> 信息来源：四路并行网络检索（webSearchPro / webSearchQuark / webSearchSogou / webSearchStd，合计约 180 条结果）。采纳数据多为厂商自述口径，已在文中标注可信度；仅收录协议层信息，排除纯 Agent-to-Agent（A2A、ANP 等）与纯工具层（MCP 本体）协议。

---

## 一、结论先行

- **Agentic UI 协议栈已清晰分层，三者互补而非竞争**：AG-UI 管事件流传输（"快递公司"），A2UI / Open-JSON-UI 管声明式 UI 描述（"包裹里的东西"），MCP Apps / MCP-UI 管工具侧 UI 交付，ACP 管编辑器宿主与 coding agent 的通信。
- **除 AG-UI / A2UI 外，值得关注的协议共 6 个**：MCP Apps、MCP-UI、Open-JSON-UI（OpenAI）、ACP - Agent Client Protocol（Zed）、WebMCP（提议中）、Vercel AI SDK Data Stream Protocol（事实性厂商标准）；另有 OpenAI Apps SDK（MCP Apps 模式的 SDK 实现）。
- **在"开放、跨框架的 agent 后端 ↔ 自有前端事件流传输"这一细分层，AG-UI 确实是当前最领先、最接近事实标准的协议**：Microsoft / Google / AWS / Oracle 四大厂一方集成，几乎所有主流 Agent 框架官方适配。
- **但放到整个 agent-UI 流量盘子，AG-UI 还称不上无争议的最主流**：核心数据（400 万周下载、多数 Fortune 500 生产使用）均为 CopilotKit 自述且未经独立验证；Vercel AI SDK 私有流协议占据 Next.js 存量生态；MCP Apps（Anthropic/OpenAI 维护者主导）正从宿主侧侵蚀独立 UI 协议层的必要性；治理上仍由单一商业公司主导。
- **社区选型共识**：*"Use AG-UI when you own the frontend. Use MCP Apps when someone else's chat host is the frontend."*（自有前端用 AG-UI，别人的宿主做前端用 MCP Apps）

---

## 二、协议全景：分层定位

| 层 | 协议 | 提出方 | 一句话定位 |
|---|---|---|---|
| 工具层（参照） | MCP | Anthropic → Linux Foundation/AAIF | Agent 连接工具与上下文，已捐赠中立基金会，生态最成熟 |
| Agent 间（参照） | A2A | Google → Linux Foundation | Agent 之间协作，已捐赠中立基金会 |
| **事件流传输层** | **AG-UI** | CopilotKit | Agent 后端与前端之间的双向事件流（SSE 为主，传输无关），16+ 标准事件类型 |
| 事件流传输层（厂商私有） | Vercel AI SDK Data Stream Protocol | Vercel | Next.js 全栈场景事实标准，服务端 tool call 直接绑定 React state |
| **声明式 UI 描述层** | **A2UI** | Google | Agent 输出声明式组件树 JSON，客户端原生渲染，v0.9 / v1.0 RC，early-stage |
| 声明式 UI 描述层 | Open-JSON-UI | OpenAI | OpenAI 内部声明式 Generative UI schema 的开放标准化 |
| **工具侧 UI 交付层** | **MCP Apps** | MCP 官方（Anthropic 起源，现 LF/AAIF） | MCP server 通过 `ui://` 资源向宿主交付交互式 UI，沙箱 iframe 渲染，2026-01 官宣、规范已达 Final |
| 工具侧 UI 交付层 | MCP-UI | Microsoft + Shopify（社区） | 在 MCP Tool Result 中加 `UIResource` 字段返回 UI 片段；已被标记 legacy，导向 MCP Apps |
| 工具侧 UI 交付层 | OpenAI Apps SDK | OpenAI | MCP Apps 模式在 ChatGPT 侧的 SDK 实现 |
| **编辑器宿主层** | **ACP (Agent Client Protocol)** | Zed Industries（联合 JetBrains） | 编辑器 ↔ coding agent 的 JSON-RPC 2.0 over stdio 协议，"AI 编辑器界的 LSP"，已发 v1 stable |
| 浏览器层 | WebMCP | 浏览器厂商 + AI 从业者（Alex Nahas 等） | 提议中的 Web 标准，通过 HTML 声明式属性 / `navigator.registerTool` 把 MCP 引入浏览器 |
| 应用 UI 控制层 | ACP (Agent Control Protocol) | agent-control-protocol 开源项目 | Agent 通过结构化 manifest 理解并操作现有应用 UI |

注意同名歧义：共有 3 个 "ACP"——Zed 的 Agent Client Protocol（UI 层 ✅）、Agent Control Protocol（应用 UI 控制 ✅）、IBM BeeAI 的 Agent Communication Protocol（纯 A2A 层 ❌，已并入 A2A）。

---

## 三、各协议调用情况详解

### 3.1 AG-UI（事件流传输层领跑者）

**协议要点**：事件驱动、传输无关（主流实现基于 SSE，支持 WebSocket/HTTP）；约 16-30 种标准事件类型，覆盖生命周期（RunStarted/Finished）、流式文本（TextMessage 系列）、工具调用（ToolCall 系列）、状态同步（StateSnapshot/StateDelta，基于 JSON Patch RFC 6902）、人机协同中断（human-in-the-loop）。

**采纳情况**：

| 维度 | 事实 | 可信度 |
|---|---|---|
| 云厂商一方集成 | Microsoft Agent Framework（Build 2026 原生支持）、Google ADK、AWS Strands Agents / Bedrock AgentCore（专用端点 + FAST 模板）、Oracle Agent Spec（2026-03） | 高（有微软官方文档佐证 learn.microsoft.com） |
| 框架集成 | LangGraph、CrewAI、Mastra、Pydantic AI、Agno、LlamaIndex、AG2、Google ADK、AWS Strands、Microsoft Agent Framework、Claude Agent SDK、Langroid | 高 |
| 进行中/社区 | Vercel AI SDK、OpenAI Agent SDK、Cloudflare Agents（官方 README 标注 In Progress / Open to Contributions） | 高 |
| GitHub | ag-ui 仓库约 15k stars（该层协议最高，MCP-UI 约 5k） | 中（不同来源口径 13k-15k） |
| 下载量 | 官方宣称全家桶 400 万周下载；第三方口径 npm `@ag-ui/core` 约 17.9 万周下载、Python `ag-ui-protocol` 约 62 万周下载 | **低（自述，未独立验证，口径混乱）** |
| 商业动力 | CopilotKit 2026-05 融资 $27M（Glilot/NfX/SignalFire），估值约 $380M | 高 |
| 行业评级 | Thoughtworks 技术雷达 2025-11 Assess → 2026-04 Trial；TechCrunch 称 "widely adopted" | 高 |
| 宿主生态外溢 | Slack/Teams（Channels SDK）、TDesign Chat（腾讯）提供 AG-UI 集成、DeepLearning.AI 课程 | 中-高 |

**弱点与风险**：

1. 生产采用数据不透明：stars 反映关注度 ≠ 生产使用率，云厂商集成公告更多是战略布局信号。
2. 生态偏 React：Vue / Svelte / 原生移动支持弱（"If your host app is Vue, Svelte, or native mobile, you are out of luck"）。
3. 治理单点：MCP 捐了 AAIF、A2A 捐了 Linux Foundation，AG-UI 仍由 CopilotKit 单一商业公司主导；破坏性变更决策机制未正式化。
4. 协议仍在快速演进（2025-05 才开源），事件类型增删、字段调整时有发生，长期 API 稳定性存疑。
5. Thoughtworks 公开质疑：随着 MCP Apps / MCP-UI 把 UI 打包进 MCP server，"是否还需要独立的 UI 协议层"正被行业审视。

### 3.2 MCP Apps（工具侧 UI 交付层，最强竞争路线）

- **提出方**：MCP 官方规范体系（Anthropic 起源，现 Linux Foundation/AAIF 治理），由 MCP 核心维护者（OpenAI 与 Anthropic）作者化，整合了 MCP-UI 与 OpenAI 的前期工作。
- **机制**：把 UI 当作一种"资源"——server 通过 `ui://` URI 返回预构建 HTML 交互界面，客户端在沙箱 iframe 中渲染，经 postMessage/JSON-RPC 桥双向通信。
- **成熟度**：2026-01-26 官宣进入 standards-track；规范已达 Final 状态并已在 Claude 生产上线；宿主覆盖 ChatGPT、Claude、Goose、VS Code 等。
- **与 AG-UI 关系**：官方口径互补——MCP Apps 定义 UI surface，AG-UI 负责实时状态/工具生命周期/UI 事件同步的编排层；AG-UI 官方提供 `@ag-ui/mcp-apps-middleware` 桥接，CopilotKit 博客有 "Bring MCP Apps into your OWN app" 方案。
- **威胁性**：若 ChatGPT/Claude/IDE 等宿主生态普遍内建 MCP Apps，AG-UI 的地盘将被压缩到"自有前端"场景；微软 23 万 Copilot Studio 客户意味着宿主侧体量可能远超自有前端。

### 3.3 MCP-UI（先行者，已让位）

- **提出方**：Microsoft + Shopify 主导的社区开源项目（非官方标准）。
- **机制**：不另起新协议，在 MCP Tool Result 中添加 `UIResource` 字段，三种渲染模式：Raw HTML / External URL / Remote DOM（基于 Shopify remote-dom 技术），iframe 沙箱安全模型。
- **现状**：已被标记 legacy（`UIResourceRenderer` 废弃），推荐实现 MCP Apps 标准的 `AppRenderer`；standards-track 目标即 MCP Apps。约 5k stars。

### 3.4 Open-JSON-UI（OpenAI 声明式 UI 规范）

- **提出方**：OpenAI，对其内部声明式 Generative UI schema 的开放标准化。
- **定位**：AG-UI 官方文档将 A2UI、MCP-UI/MCP Apps、Open-JSON-UI 并列为三大 generative UI 规范；公开资料相对较少，处于标准化早期。

### 3.5 A2UI（声明式 UI 描述层，参照项）

- **提出方**：Google（2025 Q4 发布，仓库已从 google/A2UI 迁移至 a2ui-project/a2ui）。
- **机制**：Agent 输出声明式组件树 JSON（Card/Button/TextField/DatePicker 等白名单），客户端用原生组件 1:1 渲染——"safe like data, but expressive like code"；framework-agnostic，同一份 JSON 可映射 Web Components / Flutter / React / SwiftUI（React 支持 2026 Q1 才推出）。
- **成熟度**：early-stage public preview，稳定线 v0.9，v1.0 规范处于 release candidate；Google 配套 GenUI SDK（Flutter）。
- **与传输层关系**：A2UI JSON payload 可通过 A2A、AG-UI、SSE、WebSocket 等多种方式传输——它是内容格式，不是传输协议。

### 3.6 ACP - Agent Client Protocol（编辑器宿主层）

- **提出方**：Zed Industries（2025-08 发布，LinkedIn 帖称系 Zed 与 JetBrains 联合努力），Apache-2.0，官网 agentclientprotocol.com。
- **机制**：受 LSP 启发，JSON-RPC 2.0 over stdio，标准化代码编辑器（Zed、JetBrains 等）与 AI coding agent（Claude Code、Codex CLI、Gemini CLI、Cursor 等）之间的通信。
- **成熟度**：已发布 v1 stable，提供 TypeScript/Python/Rust/Java/Kotlin SDK；被多篇 2026 年度协议盘点列入核心协议（与 MCP/A2A/AG-UI 并列四巨头）。
- **适用边界**：仅 dev-tools / IDE 场景，不面向通用 agent 前端。

### 3.7 Vercel AI SDK Data Stream Protocol（存量厂商标准）

- **提出方**：Vercel（AI SDK，25.9k stars，体量大于 ag-ui 本身）。
- **机制**：自有 data stream 协议 + UI hooks，服务端 tool call 直接绑定 React state 与 App Router，模型输出自定义对象并触发客户端函数执行。
- **地位**：当前 Next.js 全栈场景事实上的 agent→前端流式标准；TechCrunch 将其点名为 CopilotKit 三大竞品之一（另两家 assistant-ui、OpenAI Apps SDK）；对 AG-UI 的集成至今仍是社区/进行中状态。

### 3.8 其他补充

- **WebMCP**：提议中的 Web 标准，网站通过表单上的声明式 HTML 属性或 `navigator.registerTool` JS 调用显式声明工具，agent 从"抓 DOM 猜按钮"变为直接执行类型化命令，并继承浏览器 SSO/session cookie。尚在孵化，未落地。
- **OpenAI Apps SDK**：MCP Apps 模式的 SDK 实现，让工具结果以 widget 形式渲染进 ChatGPT 宿主，与 MCP Apps、mcp-ui 同属一个家族。
- **ACP - Agent Control Protocol**：agent 通过结构化 manifest 理解现有应用 UI 并像人类一样执行操作，面向对话式应用控制与 UI 自动化，规模较小。

---

## 四、焦点问题：AG-UI 是否是事件流传输层最主流的协议？

### 支持方证据

1. **采纳名单无同量级竞品**：四大云厂（Microsoft/Google/AWS/Oracle）+ 几乎所有主流框架的一方或官方集成，在该层是独一份。
2. **微软深度背书**：Build 2026 原生支持进 Microsoft Agent Framework，Agent Framework / Copilot Studio / CopilotKit React 组件同说一种协议；有评价称 "AG-UI 之于 agentic UX，如同 HTTP 之于 1995 年的 Web"。
3. **AWS 生产化信号**：Bedrock AgentCore 专用 AG-UI 端点 + FAST 全栈模板。
4. **第三方定性**：TechCrunch "widely adopted"；Thoughtworks 雷达升至 Trial；多份独立对比称其为该层 "de facto standard" / "default interaction protocol"。
5. **生态聚合势能**：开放标准一旦第一批重量级玩家采纳，其余跟进（不跟进即不兼容）；OpenAI 将于 2026-08-26 关闭 Assistants API，进一步推动社区向标准协议迁移。

### 反对方证据

1. **数据可信度**：400 万周下载 / Fortune 500 穿透率均为 CopilotKit 自述，第三方明确指出未经独立验证；npm `@ag-ui/core` 周下载（约 18 万）比官方口径小一个数量级，说明大头是 CopilotKit 包而非协议本身；GitHub stars 各来源口径 13k-40k 混乱。
2. **Vercel AI SDK 存量优势**：Next.js 生态大量团队已用其私有流协议；迁移成本可能超过标准化收益；且 AG-UI 生态明显偏 React。
3. **MCP Apps 路线侵蚀**：Thoughtworks 公开质疑独立 UI 协议层的必要性；MCP Apps 规范已 Final 且在 Claude 上线，宿主侧生态（ChatGPT/Claude/VS Code）体量可观。
4. **标准之战未定局**：LinkedIn 分析原话 "Neither has won... the standard has not landed, and the industry is genuinely picking right now"；petervanhees 建议"保持渲染层薄、放在适配器后面"以对冲。
5. **成熟度评级**：多篇独立对比将 AG-UI 评为三大协议中采纳最少、"早期但发展迅速"（对比 MCP "非常成熟"、A2A "快速成熟"）；MindStudio 称 "AGUI is the newest of the three and has the least adoption so far"。
6. **治理风险**：单一商业公司主导，协议中立性与商业化存在张力；未像 OpenAPI 那样正式化治理模式。

### 综合判断

| 场景 | 主流选择 |
|---|---|
| 自有应用内嵌 agent、需要跨框架/跨云的可移植事件流 | **AG-UI（该层事实标准头号候选，当下默认选择）** |
| Next.js 单体全栈、纯聊天类轻量场景 | Vercel AI SDK（存量事实标准） |
| 别人的宿主（ChatGPT/Claude/IDE）内渲染 UI | MCP Apps / OpenAI Apps SDK |
| 声明式跨平台 UI 描述（与传输层配合） | A2UI（v1.0 RC，early-stage） |
| IDE ↔ coding agent | ACP - Agent Client Protocol（该细分已稳定 v1） |

**一句话结论**：在"开放、跨框架的 agent 后端 ↔ 自有前端事件流传输"这一精确赛道上，AG-UI 是当下最主流的协议；但该层整体仍处于与 MCP Apps 路线的"未决标准之战"早期，"最主流"需加口径（自述数据未验证）、场景（仅自有前端）、时间（趋势进行时而非既成事实）三重限定。

---

## 五、对本项目的启示

1. **架构对齐行业分层**：本项目自研 Agent Loop 已采用"独立进程 + 版本化 RunEvent 协议向 UI 输出事件"的设计，与 AG-UI 所在层定位一致；若未来需要接外部 engine 或被外部前端消费，AG-UI 事件语义（生命周期/文本 delta/工具调用/状态快照+增量/中断审批）是现成的对齐参照。
2. **事件协议设计参照 AG-UI 语义**：StateSnapshot + StateDelta（JSON Patch）、ToolCall 生命周期四段事件、human-in-the-loop 中断，均是经过大规模生产验证的事件建模。
3. **渲染层保持薄与可替换**：标准之战未定局，UI 渲染应放在适配器后面，避免与任一协议深度耦合（petervanhees 建议）。
4. **关注 MCP Apps 演进**：若未来 WorkAgent 需要向第三方宿主（IDE、聊天客户端）交付 UI 能力，MCP Apps 是绕不开的路线。
5. **警惕宣传口径**：AG-UI 生态数据多为 CopilotKit 融资叙事的一部分，选型时应以本团队 POC 实测与微软/AWS 官方文档为准。

---

## 附：关键来源

- AG-UI 官方文档（协议定位与 generative UI 规范对比）：docs.ag-ui.com/concepts/generative-ui-specs、docs.ag-ui.com/agentic-protocols
- AG-UI GitHub 仓库（集成矩阵）：github.com/ag-ui-protocol/ag-ui
- Microsoft Learn 官方集成文档：learn.microsoft.com/zh-cn/agent-framework/integrations/ag-ui/
- CopilotKit $27M Series A 官宣：copilotkit.ai/blog/series-a
- TechCrunch 报道：techcrunch.com（CopilotKit raises 27M）
- Thoughtworks 技术雷达：thoughtworks.com/radar/platforms/ag-ui-protocol
- MCP Apps 官宣与对比：d4b.dev/blog/2026-03-20-agentic-ui-comparing-ag-ui-mcp-ui-and-a2a-protocols
- Google A2UI 官方博客：developers.googleblog.com（Introducing A2UI）
- A2UI vs AG-UI：a2ui.sh/articles/a2ui-vs-ag-ui
- Agent Client Protocol：agentclientprotocol.com、blog.agentailor.com/posts/top-ai-agent-protocols-2026
- 标准之战分析：linkedin.com/pulse/the-interface-problem-when-agents-outgrow-chat-window（Srini Karlekar）、petervanhees.com/ai-native-apps-are-not-a-chat-box
- 协议全景盘点：solenya.ai/blog/20-agent-protocols、casys.ai/blog/mcp-a2a-acp-agent-protocols
