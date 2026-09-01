# 以 Playwright 为例集成本地 MCP —— 代码评审与实跑 Badcase 分析（Codex）

- **评审日期**：2026-08-31
- **评审对象**：Atlas 本地 stdio MCP 集成的未提交实现，以及两条 Bilibili 图片下载实跑 Run
- **实施记录**：`sxw_aicoding/temp/20260831_MCP集成过程记录与实测问题定位.md`
- **评审结论**：**NO-GO，不建议按当前状态提交或合并**
- **问题统计**：本次 MCP 接入 **6 个 P1、2 个 P2**；实跑另揭出 **1 个既有 Artifact P1**

---

## 1. 结论摘要

真实 Run 已经证明本地 MCP 的主要 happy path：Atlas 能启动 Playwright MCP、取得工具面、把工具桥接进模型协议、走 Action/Policy/Approval、调用浏览器并取得结果；实际 Run 完成了 `navigate → evaluate → read_file → download → zip → close`。分页逻辑在当前源码中存在，既有实施记录声称其验收已通过，但本轮没有重跑 `verify:mcp`。

但“能调用”还没有达到 Atlas 对安全、恢复、可审计和通用性的既有契约。当前阻断项集中在五条主线：

1. MCP 错误原文可绕过强制脱敏并进入 SQLite 与下一轮模型；
2. 合法开放 JSON Schema 参数会被静默丢弃，“换 MCP 只改配置”并未成立；
3. Resume 没有绑定 Browser Session，也没有把冻结工具快照与当前 handler/resolver/server 实现绑定；
4. Web 切换 workspace 后 MCP 仍使用启动 workspace 的 cwd；
5. 子进程启动失败、CLI 退出和宿主信任边界尚未闭合。

两个实跑的归因也需要分层：

- Case B 的**直接原因**确实是模型生成了错误的文件名处理脚本，不是 MCP 返回了异常 URL；
- Atlas/Harness 的责任是没有成员级或任务级证据阻止这份用户不可直接使用的 ZIP 被结算成 `SUCCESS`；
- Case A 最终交付物可用，但它实证了旧版本坏 ZIP 仍被列入交付集合、且旧版本字节无法重取的既有 Artifact 缺陷。

因此，实施记录中“模型行为方差”的直接归因成立，但若只停在这一层，会遗漏 Atlas 为什么无法阻止方差变成用户级 badcase。

---

## 2. 评审范围、权威与证据

### 2.1 权威顺序

1. `sxw_aicoding/架构设计/WorkAgent架构设计_V20260823_05.md`：恢复、安全、数据边界与运行语义；
2. 当前未提交源码：实际实现；
3. `sxw_aicoding/ADR/0011-通过外部-MCP-接入浏览器能力.md`：本批局部设计决定；
4. 实施记录与 `verify:*`：实现说明和验收输入，不作为单独退出证据；
5. 两条 Run 的 Trace、SQLite transcript、Artifact 数据与当前磁盘字节：实际行为证据。

### 2.2 工作树范围

初始只读评审阶段开始与结束时的工作树一致：

- 15 个 tracked 文件被修改；
- 新增 `tools/mcp/`、`apps/cli/src/verify/mcp.ts`、假 MCP server、ADR、实施记录和示例配置等 untracked 文件；
- 没有 staged 变更；
- `.DS_Store` 是范围外的既有 untracked 文件；
- `git diff --stat` 为 `1807 insertions(+), 53 deletions(-)`，其中 `package-lock.json` 增加 1242 行。

### 2.3 实跑证据

**Case A（不走 MCP）**

- workspace：`/Users/shixiangweii/Desktop/atlas_eval/workspace_2`
- runId：`run_fb87b06cca07`
- Trace：`/Users/shixiangweii/Desktop/atlas_eval/workspace_2/.workagent/runs/run_fb87b06cca07.jsonl`
- SQLite：`/Users/shixiangweii/Desktop/atlas_eval/workspace_2/.workagent/runs.db`
- 最终 ZIP：`/Users/shixiangweii/Desktop/atlas_eval/workspace_2/workspace/images.zip`

**Case B（Playwright MCP）**

- workspace：`/Users/shixiangweii/WebstormProjects/sxw_work-agent/.workagent-workspace`
- runId：`run_ffcb0b40f70b`
- Trace：`/Users/shixiangweii/WebstormProjects/sxw_work-agent/.workagent-workspace/.workagent/runs/run_ffcb0b40f70b.jsonl`
- SQLite：`/Users/shixiangweii/WebstormProjects/sxw_work-agent/.workagent-workspace/.workagent/runs.db`
- 最终 ZIP：`/Users/shixiangweii/WebstormProjects/sxw_work-agent/.workagent-workspace/images.zip`

两条 SQLite 均通过 `mode=ro&immutable=1` 只读打开；ZIP 使用独立 `unzip -t`、hash、成员清单与格式识别核对。

---

## 3. 分级评审发现

本报告中：

- **P1**：提交/合并前必须关闭，会破坏安全边界、恢复正确性、workspace 身份、关键通用性或交付事实；
- **P2**：不应长期遗留，需要在本批或紧随其后的明确收口中修复并补证。

### P1-1：MCP 失败原文绕过 Redaction，并进入持久化 transcript 与下一轮模型

- **类型**：本次 MCP 接入触发的既有 Runtime 结算缺口
- **证据状态**：静态调用链闭合；未写盘复现

源码链：

1. `tools/mcp/src/handler.ts:73-104` 在 `isError:true` 时，把服务器自由文本 `r.text` 直接拼入 `error.safeMessage`，同时令 `output: ""`；
2. `packages/harness-runtime/src/action/settle-batch.ts:599-613` 只对 `outcome.output` 运行 Redaction，因此实际脱敏的是空字符串；
3. 同文件 `735-753` 的失败分支不使用 `red.text`，直接调用 `renderError(errorOf(...))`；
4. 同文件 `1089-1096` 把 `safeMessage` 原样放进 tool result；
5. `packages/harness-runtime/src/loop/run-loop.ts:994-1000` 将该 result 持久化到 transcript，并送入下一轮 Context。

触发条件包括：MCP error 含 Cookie、session token、页面敏感文本、服务端诊断内容，或恶意 MCP 主动把敏感数据放进错误文本。

这违反 V05 `§22.2`（`2170-2186`）的强制边界：未脱敏原文不得离开 Adapter，落盘、Context、Trace 和事件中的内容必须已经脱敏。当前 `apps/cli/src/verify/mcp.ts:337` 还把“错误里带服务器原文”作为正向事实，等于反向固化了错误路径。

传输异常也有同族风险：`tools/mcp/src/handler.ts:138-170` 将异常 message 截断后写入 `safeMessage`，仍走相同结算路径。

### P1-2：开放 JSON Schema 的合法参数会被静默丢弃

- **类型**：本次引入
- **证据状态**：源码闭合，并完成纯内存最小探针

`packages/harness-runtime/src/tool-runtime/index.ts:75-103` 的 `validateAndNormalize()` 只遍历 `schema.properties`，返回值只包含这些直接属性；所有其他输入键被无条件丢弃。

`tools/mcp/src/tool-bridge.ts:215-227` 又会为根级 `$ref`、`oneOf` 等形态补出空的 `properties:{}`。因此以下合法 JSON Schema 都可能出现“校验通过，但 handler 收到 `{}` 或残缺对象”：

- `additionalProperties` 定义的动态键；
- `patternProperties`；
- 根级 `$ref`；
- 根级 `oneOf` / `allOf` / `anyOf`；
- 其他不把参数直接展开在根 `properties` 的开放构造。

纯内存探针确认：

- `additionalProperties` schema 加 `{region:"cn"}` → `ok:true, normalized:{}`；
- 根级 `oneOf` schema 加 `{url:"..."}` → `ok:true, normalized:{}`。

这不仅改坏发给 MCP 的参数，还会让 `inputDigest`、Effect、审批展示和 handler 全部基于被静默裁掉的输入。现有 `apps/cli/src/verify/mcp.ts:240-305` 只覆盖显式 `properties` 下的 array、integer、object、enum 与无 type 属性，未覆盖本条失败方向。

本条不是 Case B 文件名 badcase 的直接原因：本次实际命中的 Playwright 工具 schema 使用了显式 properties。但它直接推翻了本批最重要的通用性目标“换一个 MCP 只改配置”。

### P1-3：Resume 没有绑定 Browser Session，也没有绑定冻结工具语义与当前实现

- **类型**：本次引入
- **证据状态**：静态恢复链闭合；未执行真实 crash/restart

#### Browser Session 身份缺失

V05 `§18.3`（`1928-1963`）明确要求 Resume 检查 Capability Binding、Grant、Secret、**Browser Session**、Lease、输入与外部世界是否仍然有效。

当前实现：

- `tools/mcp/src/index.ts:49-57` 的 `McpRuntime` 没有 server/session/profile/account fingerprint；
- `packages/harness-runtime/src/facade/index.ts:219-236` 的恢复前置检查只有 endpoint 与 workspace；
- ADR 又明确不做 `--user-data-dir`，跨进程后会启动一个新的浏览器。

结果是：Atlas 可在账号、窗口、Cookie、页面和登录状态已经完全变化后继续同一个 Run。若崩溃点是普通消息边界，Runtime 会直接继续；若存在未配对的 read 档调用，还可能在新会话中自动重试。

`execute` 档设置 `requiresPreFingerprint:true` 只能处理“某一次未配对工具到底执行了没有”，不能回答“恢复后的 Browser Session 还是不是原来那个”。ADR 把两者混在了一起。

#### 冻结 ToolSnapshot 与当前 MCP handler/resolver 漂移

- `apps/cli/src/compose.ts:737-787` 把启动时工具快照冻结进 RunSpec；
- `packages/harness-runtime/src/facade/index.ts:423-489` 的 resume registry 读取冻结快照；
- 但 `adapters/shape-anthropic-messages/src/protocol.ts:119-124` 向模型发送的是当前 compose 持有的工具；
- `ports.tools` 与 `ports.effects` 也来自重启后的当前 MCP 连接；
- `tools/mcp/src/tool-bridge.ts:141-146` 的 version 只使用 MCP server 自报版本，不含 schema、description、tier、command、cwd、配置或实现 hash。

因此重启后可能出现：

- 版本变了：冻结 resolverRef 在当前注册表不存在，恢复失败；
- 版本没变但 schema/实现变了：模型看到新 schema、Runtime 用旧 schema 校验、handler 调当前实现，发生静默错配；
- tool 被删除/改名：模型工具面、冻结 registry 与 handler 路由互相不一致；
- tier 改变：审批、幂等与失败副作用语义漂移。

`mcp.example.json:5` 与当前运行配置使用 `npx -y @playwright/mcp@latest`，使这种漂移不是理论边角，而是每次重启都可能发生的常规路径。

### P1-4：Web 切换 workspace 后，MCP 仍固定使用启动 workspace 的 cwd

- **类型**：本次引入
- **证据状态**：静态链闭合；Case B 证明当前 cwd 巧合可用，未执行切换复现

源码链：

1. `tools/mcp/src/config.ts:255-259`：未配置 cwd 时返回建连时的 `workspaceRoot`；
2. `tools/mcp/src/client.ts:98-103`：该值被固定交给 `StdioClientTransport`；
3. `apps/workagent-service/src/main.ts:39-60`：Service 启动时只建立一次 MCP，并跨 workspace 复用；
4. `apps/workagent-service/src/workspace-hosts.ts:145-156`：切换后新 RunHost 使用新的 workspaceRoot，但继续收到同一个 MCP Runtime。

触发：Atlas 在 workspace A 启动，然后 UI 切到 B。

影响：

- Playwright 返回的相对文件链接仍落在 A；
- B 的 `read_file` 无法读取；
- B Run 的 MCP 副作用可能继续写入 A；
- Trace 只知道 `EXTERNAL_TOOL`，无法把 A 中的实际文件变化归因给 B；
- 不同 workspace 的文件与浏览器状态发生串扰。

实施记录 `§6.5` 只指出“显式配置 cwd 后可能断”，漏掉了“默认 cwd + Web workspace 切换”这一确定组合。Case B 能读取 `./all_image_urls.json`，只是因为启动 workspace 与 Run workspace 恰好相同。

### P1-5：initialize 超时或 tools/list 失败会遗留当前 MCP 子进程

- **类型**：本次引入
- **证据状态**：源码与 SDK 关闭语义闭合；未启动进程复现

- `tools/mcp/src/client.ts:98-106` 在 connect 前创建 stdio transport 并启动进程；
- `client.ts:147-153` 只有完整 connect 后才进入 `tools/list`；
- `client.ts:311-323` 的 `withTimeout()` 仅做 `Promise.race`，没有 abort、close 或 kill；
- `tools/mcp/src/index.ts:102-134` 只有 `connectServer()` 完整返回后才把连接 push 进 `conns`；
- catch 内的 `closeAll()` 因而只能关闭此前已经成功的服务器，关闭不到正在失败的当前服务器；
- `required:false` 时 Atlas 还会继续运行，使泄漏更隐蔽。

此外，`tools/mcp/src/config.ts:47-51` 声称 startup 是“建连 + initialize + tools/list 的总上限”，实现却只包住 `client.connect()`。`listAllTools()` 最坏可执行 1000 页，每页各用一次 request timeout，启动时间不受 startup 总预算约束。

结果可能是后台遗留浏览器、npx 或任意无沙箱 MCP 子进程；下次启动再开一份，形成幽灵进程与会话串扰。

### P1-6：per-call Approval 不是 MCP Server 的安全边界，示例又使用未锁定的 @latest

- **类型**：本次设计边界；若决定接受，必须改成明确的宿主完全信任前提
- **证据状态**：静态链闭合

`tools/mcp/src/client.ts:74-151` 会在 Atlas 启动阶段执行 `config.command`。CLI 的调用点在 `apps/cli/src/main.ts:488-508`，Service 的调用点在 `apps/workagent-service/src/main.ts:39-60`，都发生在任何 Run、ActionProposed 和逐次 Approval 之前。

该进程：

- 没有 seatbelt 或 workspace 沙箱；
- 能读取宿主文件，包括通过 HOME/cwd 定位敏感文件；
- 能联网和外发；
- 能在 initialize、notification、后台定时器或启动脚本中自主写盘；
- 完全不需要等待一次 `tools/call`。

所以 Approval 只能约束“模型请求 Atlas 发起的某一次 MCP tool call”，不能约束 MCP server 本身。ADR-0011 `139-151` 已承认进程可以读 `.env`、联网和任意写，却又称“唯一还在的闸门是审批和人”，这两句话不能同时成立。

准确的安全模型应是：**有权写入/选择 `mcp.json` 的人，已经向该 command 授予宿主用户级代码执行权；逐次 Approval 只是工具调用层的人机确认，不是 server 安全边界。**

`mcp.example.json:5` 使用 `npx -y @playwright/mcp@latest`，会在上述完全信任的启动路径上解析并执行可漂移版本。即使保留 npx，也不能把 `@latest` 当成可恢复、可审计的版本身份。

### P2-1：CLI 的 async exit 清理不是有效生命周期保证

- **类型**：本次引入
- **证据状态**：静态证据

`apps/cli/src/main.ts:504-505` 注册：

```ts
const closeMcp = () => void mcp.close();
process.once("exit", closeMcp);
```

而正常完成在 `main.ts:660` 直接 `process.exit(0)`；异常出口同样直接 exit。Node 的 exit listener 不能等待 Promise，SDK close 又可能需要 stdin end、等待、SIGTERM 和 SIGKILL。因此“回调开始执行”不等于“子进程已经收掉”。部分 server 可能因 EOF 碰巧退出，但实现没有建立保证。

对照正面项：`apps/workagent-service/src/main.ts:89-95` 的 SIGINT/SIGTERM 路径会真实 `await svc.close()` 和 `await mcp.close()`。

### P2-2：MCP 外发行为没有 dataMovement 审计事实

- **类型**：本次引入
- **证据状态**：静态证据

`tools/mcp/src/tool-bridge.ts:73-107` 的 `McpEffectResolver` 只记录：

- `EXTERNAL_PROCESS`；
- `NO_SANDBOX`；
- execute 档的 `MUTATES_EXTERNAL_STATE`、`IRREVERSIBLE`。

它不产生 `dataMovement`，也没有 `DATA_LEAVES_HOST`。当通用 MCP 把本地文本、文件、表单值、剪贴板内容或页面数据发给外部网站时，ActionProposed/Trace 里只有 `server/tool`，无法回答数据去了哪里、范围是什么。

这违反 V05 `§22.3`（`2191-2195`）“向外发送本地数据时 ResolvedEffect 明确记录 data movement、目的地和数据范围”的要求。通用 MCP 无法理解所有参数，是这个能力的真实限制；但不能用“无法解析”推导出审计事实可以缺席。最低限度也应如实记录“目的地/范围无法解析”，而不是让字段不存在。

### Existing-P1：同一 logicalId 的旧 Deliverable 版本仍被交付，但旧字节没有保留

- **类型**：既有 Artifact 缺陷，由 Case A 实跑揭出
- **证据状态**：真实 Trace、SQLite 与当前磁盘字节闭合

Case A 先后登记：

- v1：`art_workspace_images_zip_v1_82cf3c8b`，错误文件名 ZIP，SHA-256 前缀 `82cf3c8b`；
- v2：`art_workspace_images_zip_v2_14b83fec`，修复后 ZIP，SHA-256 前缀 `14b83fec`。

Trace 物理行 `196-197` 显示 v1 被 `ArtifactVerified ok=true`；`256-257` 显示 v2 也通过；物理行 `413` 的 `LoopTerminated` 同时列出两个 `deliveredArtifactIds`。

源码原因：

- `packages/harness-runtime/src/verification/settle-outcome.ts:143-180` 把每一个成功的 DELIVERABLE artifactId 加入交付集合，没有按 logicalId 只保留最终有效版本；
- `packages/store-sqlite/src/artifact-store.ts:65-139` 只保存 metadata、hash 与 path，不保存每个版本的不可变字节；
- 两个版本都指向 `workspace/images.zip`；
- `apps/workagent-service/src/run-host.ts:479-520` 预览旧 Artifact 时重新读取当前 path，只能报告 hash 是否仍匹配，无法返回旧版本登记时的内容。

当前磁盘 ZIP 的 SHA-256 为：

`14b83fec96fa09e5df2a49dc37cb2a149c5a38f90733b4badee51bcc9e21c07e`

它只匹配 v2；v1 字节已经丢失。V05 `§22.5`（`2203-2208`）要求 Deliverable Artifact 内容永久保留，因此这不是界面展示问题，而是交付事实与保留语义不成立。

---

## 4. 实跑 Case A：最终可用，但过程与交付版本暴露既有缺陷

### 4.1 结果事实

- Runtime：`COMPLETED / SUCCESS`；
- 16 turns、15 tool calls；
- 调用：`fetch_url ×2 → run_shell ×13`；
- 没有 MCP 工具；
- 15 条 Action verification 全部 `SKIPPED`；
- 最终 v2 ZIP 含 14 个成员，独立 `unzip -t` 全部通过；
- 当前 ZIP hash 与 SQLite v2 完全一致。

如果验收口径是“服务端初始 HTML 中的唯一原图 + 可用 ZIP”，最终结果符合用户复核。

如果把“网页上所有图片”解释为浏览器完成渲染、滚动并触发懒加载后的集合，则 Case A 不能判硬通过：冻结工具面没有浏览器，只能处理静态 HTML。之后 91 秒启动的 Case B 得到 49 个 URL/图片，这构成强反证，但页面会动态变化、两次没有冻结同一 external-world snapshot，因此不能把 49 当作 Case A 的严格同源金标准。

### 4.2 模型层直接问题

1. 模型知道 `read_blob` 可读取已外置 HTML，却改用 `run_shell + curl` 重新访问动态网页；
2. 持久化 raw blob 与后续重抓结果只有 13/14 base image 重合，轮播图发生漂移，破坏输入来源绑定；
3. 模型第一次重命名生成 `.jpg.png.ico`、`.png.png.jpg.png.ico` 等错误成员名；
4. 它随后从 stdout 自己发现问题，继续花轮次修名并运行 `file *`；
5. 修复来自模型自检，不是 Atlas Artifact checker。

最强反事实是：如果模型在 v1 登记后直接停止，现有源码仍会得到 `SUCCESS` 并交付成员名错误的 ZIP。Case A 最终成功只能证明这一次模型继续检查了，不能证明 Harness 能阻止同方向 badcase。

### 4.3 系统层问题

- ZIP checker 只检查登记 hash、PK 魔数与 EOCD，不检查成员名、成员 CRC、可解码性或任务语义；
- v1 与 v2 都通过检查并进入最终交付集合；
- v1 旧字节无法重取；
- “Runtime SUCCESS”“最终 v2 正确”“Harness 交付事实正确”是三个不同问题，本 Run 只能确认前两项。

### 4.4 归因结论

| 层级 | 结论 |
|---|---|
| 模型行为 | v1 错名与重新抓取造成漂移，是直接问题；模型后来自愈 |
| MCP | 排除；RunSpec 无 `mcp__*` 工具 |
| 任务口径 | “所有图片”没有冻结静态/动态/懒加载/CSS/去重标准 |
| Harness | 未阻止坏 v1 被验证和交付；旧 Deliverable 字节未保留 |
| 最终用户产物 | 按静态 HTML 口径通过；按完整浏览器页面口径证据不足 |

---

## 5. 实跑 Case B：模型写错文件名，Harness 将其结算为用户级 false-success

### 5.1 结果事实

- Runtime：`COMPLETED / SUCCESS`；
- 12/20 turns、11/100 tool calls；
- 活跃墙钟约 91/600 秒；
- 自然停止时仍剩 8 轮、89 次工具调用和约 508 秒；
- Trace 物理行 `158-159`：只登记/验证 `images.zip`；
- Trace 物理行 `265`：`LoopTerminated outcome.kind = SUCCESS`；
- 当前 ZIP size：6,256,678 bytes；
- SHA-256：`daf443004d3c19c823cb05c89b9663c3b6b9a54ca1f97d96463578616873db8f`；
- 与 SQLite `art_images_zip_v1_daf44300` 完全一致；
- ZIP 49 个成员，`unzip -t` 全部通过；
- 逐个识别为 39 JPEG、8 PNG、2 GIF，图片字节并未损坏；
- 只有 2/49 文件名以可识别图片扩展名结束，47/49 的最终 suffix 是 `png_3840w...`、`jpg_672w...` 等。

所以准确描述是：**图片内容有效，但 47/49 文件名没有有效最终扩展名，导致用户无法按常规文件关联直接打开。**

### 5.2 直接主因：模型生成的文件名处理脚本错误

SQLite `transcript_entries.sequence=154` 的核心逻辑是：

```python
base = url.split('?')[0].split('/')[-1]
if '.' not in base:
    base = base + '.jpg'
filename = f'img_{i:03d}_{base}'
filename = filename.replace('@', '_').replace('!', '_')
```

对于：

`632eff....png@3840w_360h_1c`

脚本没有在 `@` 前截断，而是把 `@` 换成 `_`，于是最终文件名变成：

`632eff....png_3840w_360h_1c`

操作系统看到的最终扩展名是 `png_3840w_360h_1c`，不是 `.png`。

Case A 的 transcript 中也存在相同形态的 hdslb URL，包括同一张 `632eff...png@3840w...` 图片。因此：

- 不是 live DOM 才带 CDN 参数；
- 不是 Playwright MCP 修改了 URL；
- 不是 MCP bridge 损坏参数；
- 文件名完全由模型后续脚本推导。

Case A 后续运行了修名和 `file *`；Case B 没有。两次都没有撞预算，所以“模型行为方差”是直接原因层的高置信度结论。

### 5.3 Atlas 为什么仍然 SUCCESS

1. 11 个 Action verification 全部 `SKIPPED`；
2. 49 张图片没有任何一张被登记为 Artifact；
3. 唯一登记的是最终 `images.zip`；
4. `tools/common/src/artifact-checks/index.ts:223-227,303-382` 的 ZIP 检查只看 hash、PK 与 EOCD；
5. 即使把检查升级为真实 `unzip -t`，本例仍会通过，因为成员 CRC 和字节都是好的；
6. 没有成员名/MIME/最终扩展名一致性证据，也没有任务级 grader；
7. `packages/harness-runtime/src/verification/settle-outcome.ts:5-23` 明确以“模型不再请求工具”作为正常完成点。

实施记录 `§6.3` 认为“已有 checker，只缺触发路径”，这个判断不完整：

- `packages/harness-runtime/src/ports/index.ts:208-228` 的 `ToolExecutionOutcome` 只有单个 `artifact?: ProducedArtifact`；
- `tools/common/src/exec/run-shell.ts:618-645` 的 `artifact_path` 只接受一个普通文件，目录会被拒；
- 因此当前一个批量 shell 调用没有可用接口把 49 个成员逐个登记。

这不只是“模型少填一个字段”，而是产物契约目前缺少批量/manifest/member 级证据通道。解决时仍应保持 Case-agnostic：不应硬编码“ZIP 成员必须是图片扩展名”，而应在批量产物声明、通用 manifest、声明式成员检查或独立任务 grader 之间做明确设计。

### 5.4 次生问题

1. 模型第一次把相对路径误写成 `workspace/all_image_urls.json`，随后通过 `stat` 自修；
2. Python TLS 校验失败时，批处理 catch 异常但没有 `sys.exit(1)`，所以 0/49 仍返回 exitCode 0；
3. 下一轮模型关闭 `check_hostname` 和证书校验，最终下载成功但带来 MITM 风险；
4. 最终摘要没有披露关闭 TLS 校验；
5. 它没有运行 `file`、解码或 MIME ↔ suffix 一致性检查，尽管预算充足。

TLS 问题不是文件名根因，也不能归因给 MCP。当前证据只能确认 Python trust validation 失败；在本轮禁网边界下，不重新声称具体 CA 安装原因。

### 5.5 对实施记录的两处纠偏

#### “零 ActionProposed、零审批”不准确

实施记录 `§6.6` 写 MCP 写出的四个文件“零 ActionProposed、零审批、零 artifact 登记”。Trace 证明 `browser_evaluate` 等 MCP 调用确实产生 ActionProposed、ApprovalRequested，并经过批准；Web 审批也显示完整 externalArgs。

准确说法应是：

> MCP 调用本身有 Action 与审批，但 MCP 子进程在调用内部写出的 `.playwright-mcp/*.yml`、console log、`image_urls.json`、`all_image_urls.json` 没有 FILE scope、逐文件 Artifact 记录或清理事实。

#### “已有机制只缺触发点”低估了接口缺口

如 `§5.3` 所述，单个 `artifact?` 与只接受普通文件的 `artifact_path` 目前无法表达 49 个成员。需要先明确批量产物契约，不能仅靠提示模型“记得登记”。

### 5.6 归因结论

| 层级 | 结论 |
|---|---|
| 模型行为 | **直接主因**：错误 sanitize 逻辑；有预算但未自检；TLS 失败未令脚本失败 |
| MCP Server | navigation/evaluate 工作正常；URL 有效；排除为文件名主因 |
| MCP Bridge | 不参与本地文件名推导；排除为本 badcase 直接原因 |
| Harness | **系统放大因素**：Action verification 全跳过，只有 ZIP 结构事实，无成员/任务级证据 |
| Artifact | ZIP 字节与登记一致，结构有效；不代表用户语义正确 |
| Grader | 缺失；没有冻结预期 URL、成员 manifest 或可用性验收 |
| Runtime SUCCESS | 只证明循环与当前必需事实收敛，不证明 49 个文件可按用户预期打开 |

---

## 6. 正面实现方向

以下方向值得保留：

1. MCP SDK 仅存在于 `tools/mcp/`，没有侵入 `packages/` / `adapters/`，新增边界检查方向正确；
2. 默认 `execute`、默认 `required:true`，失败方向保守；
3. 不信任 MCP `annotations` 来决定审批、幂等或副作用语义；
4. 使用 SDK 的默认环境白名单并与显式 environment 合并，没有直接继承整个 `process.env`；
5. 工具名带 `mcp__<server>__` 前缀，审批面容易识别外部工具；
6. `EXTERNAL_TOOL` 独立于 `PROCESS`，不会向用户展示不存在的 run_shell 沙箱承诺；
7. CLI/Web 审批展示完整参数，并剥除危险显示控制字符；
8. sanitize 后重名、配置中工具名拼错、required server 连接失败都会显式报错；
9. `tools/list` 分页、重复 cursor、outputSchema 宽容回退、structuredContent 兜底等协议细节方向正确；
10. `isError` 与传输失败的 sideEffectState 分类总体保守；
11. Service 的 SIGINT/SIGTERM 正常路径会 await MCP close；
12. 实际 Playwright MCP 的 navigate、evaluate、close 已经走通 Action/Approval/handler 链路。

这些正面项证明实现不是推倒重来，但不能抵消 P1。

---

## 7. 验收与证据缺口

### 7.1 已执行

- `git diff --check`：通过；
- `npm run typecheck`：通过；当前脚本为 `tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json`；
- 两个纯内存 schema 探针：确认动态键/根 oneOf 会静默归一化为 `{}`；
- 两条 Trace、SQLite、Artifact 只读审计；
- Case A/B ZIP 独立 hash、成员、CRC/结构与格式核对；
- 结束时 Git 状态与评审开始一致。

### 7.2 未执行

- 未运行 `verify:mcp`：它会创建临时 workspace/canary、拉起子进程，并在 cleanup 中执行 `pkill -f fake-mcp-server`；不符合本次严格只读边界；
- 未重跑 `verify:all`；实施记录中的 15 条脚本 / 183 条判据仅作为既有声明；
- 未触发真实 LLM、网络或浏览器任务；
- 未复现 initialize timeout/process leak；
- 未执行 Web 跨 workspace 动态复现；
- 未执行 MCP crash/restart/Browser Session 漂移；
- 未写入新的 SQLite、Trace、canary 或临时 workspace。

### 7.3 Provenance 限制

两条 Trace header 都记录当前 commit `47b223...` 且 `gitDirty:true`，但没有未提交 diff 的 content hash。因此：

- 两个 badcase 的行为归因由运行当时的 transcript、Trace 和 Artifact 自证；
- 当前源码评审针对现在的未提交工作树；
- 不能严格声称运行时未提交源码与当前工作树逐字节完全相同。

---

## 8. 建议退出门槛

在重新申请评审前，至少需要满足：

1. MCP `isError`、传输异常与其他失败文本经过同一强制 Redaction，再进入 safeMessage、transcript、Context、Trace 和 UI；
2. 新增真实 `schema → validateAndNormalize → Effect → Approval → handler → fake server echo` 全链判据，覆盖 `additionalProperties`、`patternProperties`、根 `$ref/oneOf/allOf`；
3. 冻结 MCP 的 command/config/schema/description/tier/server 实现身份，并在 resume 前与当前实现显式比较；
4. Browser Session 有可核对身份与失效策略；跨进程变化时必须阻断、重新授权或进入明确恢复状态；
5. Web workspace 切换后，MCP 相对路径与文件副作用不会继续落旧 workspace；若能力明确跨 workspace，也必须有可审计的资源归属模型；
6. initialize、tools/list、bridge、配置校验和入口异常的所有出口都能关闭当前及既有子进程；startup 成为真正的总 deadline；
7. CLI 正常/异常退出可等待 MCP close，且有可判红的残留进程测试；
8. 明确写出“配置 MCP command = 宿主用户级代码执行授权”，示例和实际配置不使用 `@latest` 作为恢复身份；
9. MCP 外发至少留下如实的 `dataMovement` 事实，即使 destination/scope 只能标为无法解析；
10. Artifact 同 logicalId 版本链明确哪些版本属于最终交付，所有被列入交付的版本都能按登记 hash 重取不可变字节；
11. 对批量产物建立 Case-agnostic 的 manifest/member/批量 Artifact 或独立 grader 证据路径；
12. 新判据逐条完成故障注入，证明破坏目标代码时会翻红，而不是只检查字符串、数量或下游 helper。

退出证据应至少包括：typecheck、`verify:mcp`、相关 `verify:*`、子进程泄漏注入、跨 workspace、真实 crash/resume/Browser Session 漂移，以及一个能让错误成员交付物终态非成功的独立验收样例。

---

## 9. 最终判断

本批实现已经跨过“Atlas 能否调用本地 MCP”的功能门槛，但尚未跨过“该能力是否符合 Atlas 的安全、恢复、workspace、审计与交付事实纪律”的合并门槛。

Case B 的文件名错误不应错误归因给 MCP；它是模型直接失误。但一个 Agent Harness 的价值正是在模型出现方差时，仍能用独立事实阻止错误交付被宣告为成功。当前 Atlas 对这条失败方向没有机械证据，因此不能用“模型行为方差”作为关闭结论。

**最终结论维持：NO-GO。先关闭 6 个 P1（其中 P1-6 可通过明确宿主完全信任前提、锁定可审计版本并纠正 Approval 边界表述来收口），再把既有 Artifact P1 单独收口，然后进行二次评审。**

---

## 10. 本报告的写入边界

初始代码评审阶段严格只读，没有修改任何代码、配置或已有报告。用户随后明确授权将结果整理为本文件，因此本阶段只新增：

`sxw_aicoding/代码评审/2026-08-31_2/playwright为例集成本地mcp-codex.md`

Codex 本次没有修改或新增其他文件。同目录另有 `playwright为例集成本地mcp-zcode.md`，该文件不属于本次 Codex 写入范围，未作任何改动。
