# 阶段 4 未提交代码评审（Codex）

> 评审日期：2026-08-30  
> 评审对象：当前工作树中与 Atlas 阶段 4 产品化半边有关的全部未提交改动，包含 tracked diff 与 untracked 源码  
> 主要依据：`WorkAgent阶段Roadmap_V20260823.md`、`存量问题清单_V20260824.md`、`WorkAgent架构设计_V20260823_05.md`、`阶段4实施方案_V20260830.md`  
> 评审方式：Service / Runtime、UI / 协议、Trace / 恢复、验收脚本 / 文档声明交叉核对  
> 评审性质：原评审过程严格只读；本文件仅整理评审结果，未修改任何代码、配置或既有报告

---

## 1. 总体结论

**结论：NO-GO。当前不建议把阶段 4 产品化半边标记为达到退出门槛，也不建议直接提交或合并。**

本批已经形成 Layer 2 Application Service、原生 Web 白盒界面、HTTP/SSE、本地鉴权、三条人工通道以及预算、产物、Trace、恢复等视图，TypeScript 与前端 JS 静态检查也能通过。但评审确认存在 **10 项 P1 阻断问题与 5 项 P2 正确性问题**，其中包括：

- `RECOVERY_REQUIRED` 页面丢失真正需要用户确认的副作用项目；
- 旧 Run 可在错误 workspace 下恢复并继续产生副作用；
- UI 可把取消、插话、恢复发送给页面显示之外的 Run；
- “单前台 Run”检查可被并发请求穿透；
- 无效 resume 可把服务内存态锁死至进程重启；
- Ctrl+C 关闭没有等待 Runtime 完成终态持久化；
- Artifact 预览可读取任意 workspace 文件并通过 symlink 越界；
- 跨进程恢复后历史事件消失，Web Trace 又缺少 header/footer；
- 标准 `npm ci` 因 lockfile 缺少两个新 workspace 而失败；
- 审批命令仍可被 Unicode 双向与零宽控制字符视觉伪造。

因此 Roadmap §6.1 中“产品化半边完成”、Trace 每段 provenance、凭证不外泄、SSE 重连不重不漏、无回归等绿色退出声明，目前不能由当前代码和现有验收集合支撑。

---

## 2. 评审范围与判定基准

### 2.1 代码范围

重点覆盖：

- `apps/workagent-service/src/`
  - `api-types.ts`
  - `human-channels.ts`
  - `main.ts`
  - `projection.ts`
  - `run-host.ts`
  - `security.ts`
  - `server.ts`
- `apps/workagent-ui/public/`
  - `index.html`
  - `app.js`
  - `app.css`
- `apps/cli/src/compose.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/verify/boundaries.ts`
- `apps/cli/src/verify/ui.ts`
- `apps/cli/src/verify/tools.ts`
- `packages/harness-runtime/src/budget/index.ts`
- 与上述实现直接关联的 Runtime Facade、Run Loop、SQLite Store、Trace Sink 和根 workspace 配置。

### 2.2 语义与退出依据

1. `sxw_aicoding/架构设计/WorkAgent架构设计_V20260823_05.md`
   - §5 Layer 1 UI 职责、来源追溯与前后端协议；
   - §6 Layer 2 / Runtime Host 与单前台 Run；
   - §18 恢复语义；
   - §22 本地通信、Secret 与不可信内容边界；
   - §23 跨层投影所有权与一致性。
2. `sxw_aicoding/阶段roadmap/WorkAgent阶段Roadmap_V20260823.md`
   - §6.1 产品化半边的视图与退出门槛；
   - Trace 按段展示 commit / gitDirty；
   - SSE 重连不重不漏、凭证不外泄和无回归声明。
3. `sxw_aicoding/存量BUG/存量问题清单_V20260824.md`
   - S4-1 至 S4-4；
   - 特别是 S4-4 所说明的约束：handoff/question 不带 runId，因此 Web 入口必须真正保证单前台 Run。
4. `sxw_aicoding/实施方案设计/阶段4实施方案_V20260830.md`
   - §1 九条结构性退出门槛；
   - §4 边界规则与判别力要求。

### 2.3 严重度定义

- **P1**：会把副作用作用于错误 Run/workspace、破坏恢复或关键审计事实链、绕过安全边界、锁死服务，或导致可复现安装失败；必须阻断阶段收口。
- **P2**：会造成白盒展示失真、重要事件静默丢失、历史读数不可信、Artifact 证据不一致，或使某项结构性退出门槛缺少真实生产路径证据；应在阶段收口前修复。

---

## 3. P1 阻断问题

### P1-1：`RECOVERY_REQUIRED` 页面丢失真正需要人工确认的项目

**位置**

- `packages/harness-runtime/src/facade/index.ts:588-609`
- `apps/workagent-service/src/run-host.ts:68-77, 189-200, 252-257, 447-452`
- `apps/workagent-ui/public/app.js:645-692`

**问题**

Runtime 在进入 `RECOVERY_REQUIRED` 时返回：

```ts
{ terminal: { reason: "RECOVERY_REQUIRED", recoveryItems } }
```

该状态按设计不是终态，因此没有 `outcome`。但 `RunHost.drive()` 只保存 `terminal.reason`，没有保存 `terminal.recoveryItems`；`detail()` 又仅从 `outcome?.recoveryItems` 构造恢复项。

**影响**

UI 会显示“状态未知、等人确认的副作用：（无）”，同时仍提供 CONTINUE / ABORT 按钮。用户无法知道自己要确认哪些外部状态，最关键的恢复决策失去事实依据和审计意义。

**验收缺口**

现有 Web 恢复验收验证了按钮与 HTTP 路径，没有断言 `recovery.items` 与 Runtime 返回的项目逐项一致。

---

### P1-2：跨 workspace resume 会在当前目录执行旧 Run

**位置**

- `apps/cli/src/compose.ts:74-80, 514-557`
- `apps/workagent-service/src/main.ts:23-38`
- `apps/workagent-service/src/run-host.ts:148-157, 336-346`
- `packages/harness-runtime/src/facade/index.ts:470-485, 614-620, 661-686`
- `packages/harness-runtime/src/types/run.ts:182-208`

**问题**

默认 SQLite DB 与 workspace 分离，同一个 DB 可以保存多个 workspace 的 Run。代码注释明确假设 RunSpec 已保存 workspaceRoot，但实际 `makeRunSpec()` 没有填写已经存在的 `RunSpec.workspace` 字段。

恢复路径始终使用当前服务注入的 `deps.workspaceRoot`；Web 服务同时列出共享 DB 中所有 Run，也没有按 workspace 过滤或在 resume 前比较 workspace 身份。

**最小触发**

1. 在 `/A` 启动一个 Run 并在工具调用附近中断；
2. 使用同一个默认 DB，以 `--workspace /B` 启动 UI；
3. 在页面中恢复旧 Run。

未配对操作的观察、幂等重试和后续相对路径工具调用都会以 `/B` 为根，自动放行判断也基于 `/B`。

**影响**

旧 Run 可无提示读取、写入或覆盖错误工作区，是恢复正确性和副作用安全的直接阻断项。

---

### P1-3：切换 Run 后，命令可发送给与页面内容不同的 Run

**位置**

- `apps/workagent-ui/public/app.js:186-202`
- `apps/workagent-ui/public/app.js:852-880`
- `apps/workagent-ui/public/app.js:897-905`

**问题**

`selectRun(B)` 先把全局 `S.runId` 改为 B，并把 `S.detail` 置空，但没有清除或禁用页面上仍属于 A 的操作栏。取消、插话和 resume 的处理函数最终统一从全局 `S.runId` 取目标。

因此即使不存在网络乱序，在 B 详情返回前点击仍显示为 A 的按钮，命令也会发送给 B。除此之外，`refresh()` 没有捕获请求对应的 runId，也没有 generation guard；A 的慢响应还可以在 B 之后返回并覆盖 `S.detail`。

**影响**

用户可能取消、插话或恢复错误 Run。对于恢复决策与副作用状态，这是高风险跨 Run 误操作。

---

### P1-4：“单前台 Run”检查存在 check-then-await 竞态

**位置**

- `apps/workagent-service/src/run-host.ts:82-109`
- `apps/workagent-service/src/run-host.ts:329-346`
- `apps/workagent-service/src/run-host.ts:393-443`
- `apps/workagent-service/src/human-channels.ts:203-240`

**问题**

`startRun()` / `resumeRun()` 先调用 `assertNoActiveRun()`，但 `currentRunId` 要等 `await gen.next()` 返回首个事件后才设置。两个并发 HTTP POST 可以在任意一个请求完成首次 await 前同时通过检查并启动两个 Runtime Loop。

后写入者会覆盖 `currentRunId`。handoff 与 question 又通过这个全局值绑定 Run，因此另一 Run 可能成为“隐形前台”，人工请求也可能归到错误 Run。

**影响**

这直接破坏 V05 §6.4 与存量问题 S4-4 用来保护无 runId 人工通道的核心前提；服务注释所说的 start/resume “天然幂等保护”也不成立。

---

### P1-5：无效 resume 可把服务锁死到进程重启

**位置**

- `apps/workagent-ui/public/app.js:186-202`
- `apps/workagent-service/src/run-host.ts:393-443, 447-468, 497-503`
- `packages/harness-runtime/src/facade/index.ts:209-260`

**问题**

UI 对所有非本进程活跃的 Run 都显示通用 resume，包括 COMPLETED、FAILED，以及尚未带恢复决策的 RECOVERY_REQUIRED。

`drive()` 在首次 `gen.next()` 前调用 `beginSegment()`，提前把记录设为 `done=false`；而终态、端点不一致、缺恢复决策等异常都会在 Runtime 首次 yield 前抛出。保护后续消费的 `try/finally` 尚未建立，因此状态不会回滚。

当该 Run 仍是 `currentRunId` 时，后续所有 start/resume 都会被误判为已有活跃 Run，只能重启服务。

**影响**

一个正常的错误操作会变成服务级永久不可用；RECOVERY_REQUIRED 页面还同时存在“通用 resume”和“带决策 resume”，触发概率并不低。

---

### P1-6：优雅关闭未等待 Runtime 完成终态持久化

**位置**

- `apps/workagent-service/src/server.ts:81-89`
- `apps/workagent-service/src/run-host.ts:379-384, 447-468`
- `apps/workagent-service/src/main.ts:55-63`

**问题**

关闭路径先关闭 HTTP，再调用 `host.close()`。后者给未完成 Run 发送 cancel/abort 后立即关闭 SQLite；真正消费 generator、合成工具结果并写入终态的后台 Promise 没有保存，也没有 await。

在等待审批时尤其明确：abort 只会让等待 Promise 准备恢复，微任务尚未继续时 DB 已经关闭，随后 Runtime 的 transcript/status 写入会撞上 closed DB；主入口又会立即 `process.exit(0)`。

**影响**

Ctrl+C 被描述为“取消正在运行的 Run”，实际可能留下 WAITING/RUNNING 状态、未配对工具调用或缺少终态事实，削弱阶段 2 已建立的恢复保证。

---

### P1-7：Artifact 预览不是 Artifact 读取，而是任意文件读取接口

**位置**

- `apps/workagent-service/src/server.ts:247-258`
- `apps/workagent-service/src/run-host.ts:314-320`
- `apps/workagent-ui/public/app.js:543-581`
- `apps/cli/src/verify/ui.ts:614-639`

**问题**

`GET /api/artifact?path=`：

- 不要求 runId、artifactId 或 ArtifactStore 中存在对应记录；
- 接受 workspace 内任意存在路径；
- 只做词法 `resolve` / 前缀判断，没有 realpath / symlink containment；
- 直接 `readFileSync`，不经过 RedactionPort；
- 在截断前已经把整个文件读入内存。

当 workspace 是仓库根时，`?path=.env` 可以直接返回真实凭证；workspace 内指向外部的 symlink 也会通过词法前缀检查。

**影响**

实施方案“凭证不出现在任何 API 响应体”的退出门槛实际不成立。现有 E 段只扫描 state、detail、trace 三个响应，遗漏了最直接返回文件正文的 artifact 接口。

**附带问题**

Trace 路由同样把 decode 后的 runId 直接拼进路径：`server.ts:149-171`、`run-host.ts:308-311, 559-560`。编码的 `/` 或 `..` 可使 trace 读取越出 `traceDir`，虽然目标仍受 `.jsonl` 后缀限制。

---

### P1-8：跨进程恢复后的白盒历史与 Trace provenance 不成立

**位置**

- `apps/workagent-service/src/run-host.ts:172-205`
- `apps/workagent-service/src/run-host.ts:360-376`
- `apps/workagent-service/src/run-host.ts:493-536`
- `apps/workagent-service/src/run-host.ts:600-621`
- `apps/workagent-ui/public/app.js:586-643`

**问题 A：新内存段会遮蔽全部旧 trace**

`detail()` 和 `eventsSince()` 都在 `live.events` 非空时完全放弃磁盘 trace。进程 B 恢复进程 A 的 Run 后，第一条 Resume 事件进入内存，旧段的 frame、usage、迁移、审批、验证和产物事件便从时间线与 SSE 历史中整体消失；再次重启后又重新出现。

**问题 B：Web Trace 只写 event，不写 header/footer**

Web 入口没有使用 `FileTraceSink` 的 segment header/footer，只追加 `{ kind: "event" }`。因此：

- Web 新建 Run 没有 commit、gitDirty、模型、任务、workspace 和 segmentIndex；
- 服务重启后，Web Run 的 outcome 因没有 footer 而消失；
- CLI Run 经 Web resume 后，新段没有新 header/footer，可能继续展示上一段的旧 outcome，并把新事件错误归到旧 commit/gitDirty 下。

**影响**

Roadmap 所声明的“Trace 按段分组，每段带 commit + gitDirty”以及一个 Run 跨进程仍可完整审计，目前都不成立。

---

### P1-9：新增 workspace 未同步 lockfile，标准安装失败

**位置**

- `package.json:7-12`
- `apps/workagent-service/package.json:1-6`
- `apps/workagent-ui/package.json:1-7`
- `package-lock.json`

**只读复现**

```text
npm ci --dry-run --ignore-scripts --offline
```

结果为退出码 1，npm 明确报告：

```text
Missing: @workagent/service@0.1.0 from lock file
Missing: @workagent/ui@0.1.0 from lock file
```

**影响**

仓库约定的 `npm ci` 无法在干净环境复现。当前 node_modules 上的 typecheck 通过，不能替代可复现安装，也不足以支撑 Roadmap“无回归”退出结论。

---

### P1-10：审批命令仍可被 Unicode 双向与零宽字符视觉伪造

**位置**

- `apps/workagent-service/src/human-channels.ts:145-176`
- `apps/workagent-ui/public/app.js:733-779`
- `apps/cli/src/main.ts:650-683`

**问题**

Web UI 使用 `textContent`，能够阻止 HTML/DOM XSS，但会原样显示 Unicode 双向覆盖、隔离、零宽等控制字符。模型控制的 command、description、scopeValue 和 why 没有经过与 CLI `forTerminal()` 同等级的安全呈现处理。

**影响**

用户看到的命令视觉顺序可能不同于实际提交给 shell 的文本。Approval 是 EXECUTE 的人工安全边界，展示内容本身可被伪造时，该边界不再可靠。

---

## 4. P2 正确性问题

### P2-1：真实 EventSource 自动重连不满足“不重不漏”

**位置**

- `apps/workagent-ui/public/app.js:911-943`
- `apps/workagent-service/src/server.ts:164-166, 267-294`
- `apps/workagent-service/src/run-host.ts:510-522`
- `apps/cli/src/verify/ui.ts:641-657`

**问题**

浏览器创建 EventSource 时把当时的 cursor 固化在 query `since` 中，自动重连会通过 `Last-Event-ID` 发送最新序号。但服务完全不读取该请求头，仍使用旧 query 游标。

结果是非流式事件从旧位置重放；`ModelStreamDelta` 又被明确排除出 live replay buffer，断线窗口中的增量无法补发，只能等后续全量刷新恢复最终 transcript。

现有 F 段测试是手工创建第二个 `?since=mid` 请求，不经过浏览器原生自动重连，也没有发送 `Last-Event-ID`，因此无法证明 Roadmap 的“不重不漏”。

---

### P2-2：投影契约与来源证据弱于实施方案和 V05 声明

**位置**

- `apps/workagent-service/src/api-types.ts:33-59, 82-109`
- `apps/workagent-service/src/projection.ts:57-67, 127-135, 170-225, 545-561`
- `apps/cli/src/verify/ui.ts:482-533`
- `sxw_aicoding/实施方案设计/阶段4实施方案_V20260830.md:143-155`

**问题**

实施方案要求“两段独立投影后按 id 合并，与一次全量投影逐字一致”。当前代码明确不实现 merge，B 段只验证同一输入投影两次相同，以及前缀 id/sequence 稳定；Roadmap 又把原退出门槛改弱成了后者。

此外，一个 `UiToolActivity` 同时合并 transcript 入参/结果与 event 的 effect、状态、审批、验证，但类型只有单个 source。工具调用会先把整个 activity 标成 TRANSCRIPT，随后继续写入 event-only 字段，最终这些字段看起来像来自一个并不包含它们的 transcript sequence。`UiSource` 也没有 V05 要求的 `sourceRunId`。

**影响**

当前生产路径依赖全量重取，尚不会直接触发 split/merge 数据损坏，但“投影幂等、至少一次、每句话可追溯”的退出证据被明显高估。

---

### P2-3：预算视图存在两个独立失真

**位置**

- `apps/workagent-ui/public/app.js:500-519`
- `apps/workagent-service/src/security.ts:137-143`
- `packages/harness-runtime/src/budget/index.ts:146-224`
- `apps/workagent-service/src/run-host.ts:224-232`

**问题 A：CSP 阻断进度条比例**

进度条通过内联 `style="width:..."` 设置比例，而 CSP 是 `style-src 'self'`，未允许 inline style。真实浏览器最小探针确认该动态宽度不会作为有效样式应用，预算条退回 CSS 默认表现，无法反映真实比例。

**问题 B：终态 total wall clock 继续增长**

`readBudgetAxes()` 的 `totalWallClockMs` 恒为 `now - startedAt`，RunHost 每次详情请求传当前时刻。已经结束的 Run 仍会随刷新不断增加，甚至在终态之后才显示越过预算墙。

**正向结论**

`checkBudgets()` 与 UI 共用同一张轴表的方向正确；input 轴仍使用 `billedInputTokens`，本次静态检查未发现该映射回归。

---

### P2-4：白盒时间线会遗漏关键失败与模型重试事实

**位置**

- `packages/harness-runtime/src/action/settle-batch.ts:200-260`
- `apps/workagent-service/src/projection.ts:170-199, 434-499`
- `packages/harness-runtime/src/loop/run-loop.ts:790-821`

**问题 A：提案前的 ActionRejected 消失**

未知工具、schema 校验或 Effect Resolution 失败可在 `ActionProposed` 之前产生 `ActionRejected`。投影只有收到 `ActionProposed` 才建立 actionId → toolCallId 映射，因此此类拒绝事件被静默忽略。

**问题 B：同一 turn 的多次模型调用被覆盖**

输出预算恢复会在同一 turn 触发多次 `ModelInvocationCompleted`，但 `UiTurn` 只有一个 `model` 字段，后一次会覆盖前一次的 tokens、duration 和 stopReason。累计预算仍包含所有调用，逐轮视图却无法解释那部分消耗。

**影响**

最需要白盒解释的“为什么被拒绝”和“预算为什么增加”反而可能缺失。

---

### P2-5：Artifact 的已验证记录与预览字节没有一致性保证

**位置**

- `apps/workagent-service/src/run-host.ts:194, 251, 566-597`
- `apps/workagent-service/src/server.ts:247-258`
- `apps/workagent-ui/public/app.js:541-581`

**问题**

详情展示 Artifact 登记时保存的 `contentHash` 和 `verified`，预览接口却按 path 读取当前磁盘字节，不按 artifactId/version 取值，也不重算 hash。

验证完成后若该路径被用户、工具或另一 Run 修改，页面可同时显示旧 hash、“已验证”和已经变化的新内容。

**影响**

产物视图无法回答阶段 4 明确提出的“hash 与当前磁盘内容是否一致”，Artifact 的第二层验证也可能被误读为对当前字节仍然有效。

---

## 5. 验收脚本与文档声明缺口

### 5.1 现有绿色结论未覆盖真实失败路径

| 声明 | 当前证据 | 缺口 |
|---|---|---|
| Projection 分段合并等于全量 | 两次全量投影相同；前缀 id 稳定 | 没有 split + merge，代码也明确无 merge |
| SSE 重连不重不漏 | 手工构造第二个 `?since=mid` 请求 | 不走 EventSource 自动重连，不发送 `Last-Event-ID` |
| 所有 API 响应不泄漏凭证 | 只扫 state/detail/trace | 未扫 artifact、错误响应和 pending；无 key 时是空集合 |
| 单前台 Run | 单请求 happy path | 没有并发 start/resume 竞态 |
| Resume 在浏览器可达 | 成功恢复路径 | 没有终态 resume、缺决策 resume、首个 yield 前抛错 |
| Trace Inspector 按段可审计 | 只读取/展示已有行 | 没断言 Web header/footer、段号、commit/gitDirty 与最后 outcome |
| 优雅关闭会取消 Run | 无关闭期间持久化判据 | 没有等待 background generator 与 DB 收尾 |
| Artifact 安全预览 | happy-path artifact path | 未测任意文件、`.env`、symlink、hash 漂移和大文件 |

### 5.2 边界 8 的声明大于实际扫描范围

`apps/cli/src/verify/boundaries.ts:119-139` 只扫描 `apps/workagent-ui/public`。若未来引入 bundler，后端依赖通常出现在 `src/*` 或 `package.json`，产物中包名又可能被消解，因此该规则不能证明 ADR 所说的“加构建步骤并 import Runtime 会立刻翻红”。

### 5.3 V05 的完成声明与实际范围不一致

V05 §5.1 声称除 Eval Inspector 外其余 UI 职责均已落地，但当前没有完整的 Workspace / Session / 配置管理、重新执行、Artifact 交付标记等能力；§5.4 仍要求所有命令携带 idempotency key，而 server 文件头明确说明 start/resume/cancel 没有 key。

这些可以是合理的阶段裁剪，但应在权威文档中如实改为“本阶段范围外/待验证”，不能同时保留“其余全部落地”和当前实现。

### 5.4 真实端点 UI 多轮任务仍未验证

Roadmap 已将“真实端点在界面跑完一个多轮任务”列为仍开放门槛。当前评审没有运行真实模型、网络或正式评测，因此不能把脚本化模型的 D 段 smoke 外推成真实交互质量或稳定性证据。

### 5.5 两条已有判据仍缺少判别力

1. **`autoGrantVerdict()` 缺少 `PARTIALLY_REVERSIBLE` 正向回归。**
   `apps/cli/src/compose.ts:242-256` 已正确允许 workspace 内的 `PARTIALLY_REVERSIBLE` 覆盖写，CLI 与 Web 也共用该函数；但 `verify:ui` D 段刻意用 `append_log` 触发审批，没有让 `write_file` 走自动放行正分支。若实现回退成旧错误 `reversibility !== "REVERSIBLE"`，当前阶段 4 验收仍可能全绿。
2. **`verify:tools` B3 只能证明参数名出现在 handler 源码。**
   `apps/cli/src/verify/tools.ts:353-386` 通过 `seg.includes("参数名")` 判断“参数已透传”；把真实值换成常量、错误字段或无效读取仍会通过。正向补充是：此前真实发生过的 `read_blob.line_offset` 丢失，已经由 `verify:artifact` 的完整 assembly 路径覆盖——它实际经过 `read_file → externalization → CommonToolHandler → read_blob → transcript`，并断言分页互异和全文逐字重组。因此该历史回归已有较强证据，B3 的问题是对其他参数的泛化结论过强。

---

## 6. 已确认的正向项

以下结论在本次只读范围内成立，但不抵消前述阻断项：

1. `packages/harness-runtime/src/budget/index.ts` 将八轴表提成 `readBudgetAxes()`，且 `checkBudgets()` 复用同一张表；input 轴继续读取 `billedInputTokens`。
2. 基础本地通信实现采用 loopback 监听、会话级随机 Token、Host/Origin 校验和 timing-safe token 比较；未发现这些基础分支本身存在直接绕过。
3. UI 的模型文本主要通过 `textContent` 渲染，未发现直接 DOM-XSS sink；Unicode 视觉欺骗是另一条独立边界。
4. CLI 与 Web 复用同一个 `compose()` 和 `autoGrantVerdict()`，避免复制两份放行档位的方向正确。
5. TypeScript、前端 JS 语法与 diff 格式的只读检查均通过。

---

## 7. 验证记录与边界

### 7.1 已执行的只读检查

```text
./node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.json
node --check apps/workagent-ui/public/app.js
git diff --check
npm ci --dry-run --ignore-scripts --offline
git status --short
```

结果：

- TypeScript：通过；
- `app.js` 语法：通过；
- `git diff --check`：通过；
- `npm ci --dry-run --ignore-scripts --offline`：失败，lockfile 缺少两个新 workspace；
- 原只读评审结束时，`git status --short` 与评审开始时一致；本次仅新增当前报告文件。

### 7.2 未执行的检查

未运行：

- `npm run verify:tools`
- `npm run verify:ui`
- `npm run verify:all`
- `npm run ui`
- 真实模型、真实网络与正式评测

原因：`verify:ui`、`verify:tools` 等脚本会在工作区固定路径写入并删除 canary，其他验证还会创建临时 workspace、SQLite、Trace 或运行产物，不符合原评审“不得新增修改任何文件”的约束。

静态通过只证明类型、语法和 diff 格式，不证明真实浏览器重连、并发、跨进程恢复、关闭持久化、模型行为或正式评测结果。

---

## 8. 退出建议

当前建议保持 **NO-GO**。至少满足以下条件后，再讨论阶段 4 产品化半边收口：

1. 关闭全部 P1，并为每项补充可单独翻红的生产路径判据；
2. 将 Run 的 workspace 身份冻结进 RunSpec，并在 Web 列表、详情和 resume 上形成一致约束；
3. 把 RunHost 的“占用前台槽位、首事件、后台完成、关闭等待”收敛成一个可原子获取、可回滚、可 await 的生命周期；
4. 保存并展示 `RECOVERY_REQUIRED.terminal.recoveryItems`，确认 UI 决策前能看到完整项目；
5. Artifact 预览必须绑定具体 ArtifactRecord/version，做 realpath containment，并验证当前字节与登记 hash；
6. Web Trace 写完整 segment header/event/footer，并将历史 trace 与当前内存段合并去重；
7. 用真实 EventSource 自动重连路径验证 `Last-Event-ID`，并与权威事件集合比较；
8. 更新 `package-lock.json`，从干净安装开始重跑 typecheck、相关 verify 与 `verify:all`；
9. 对修改后的关键判据逐项做一次故障注入，记录“破坏哪一行会翻红”；
10. 同步 Roadmap、V05、实施方案和存量问题清单，使“已完成/未完成/证据等级”与当前实现一致；
11. 最后再执行 Roadmap 已登记的真实端点 UI 多轮任务，并将 smoke 与正式评测结论分开记录。

在这些条件满足前，当前成果更准确的定位是：**阶段 4 白盒界面已形成可运行的结构性原型，但恢复、安全、跨段审计与验收证据尚未闭环。**
