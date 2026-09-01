# Auto 模式未提交改动代码评审（Codex）

> 评审日期：2026-09-01  
> 评审基线：`1bb2feed55137be4bac8542486b9619572e3a940`  
> 评审对象：当前工作树中尚未提交的 Auto / ApprovalMode / ExecutionPrivilege 相关改动  
> 评审方式：源码与验收脚本静态追踪、只读类型与语法检查  
> 结论：**NO-GO，暂不建议合并**

## 1. 评审边界

本轮最初按用户要求仅做只读评审，没有修改代码、配置或既有报告。评审结束后，用户单独授权把评审结论整理为新文档，因此当前文件是该只读评审之后新增的唯一产物。

评审开始与结束时，工作树均为：

- 38 个已跟踪文件有未提交修改；
- tracked diff 约为 `+2155 / -172`；
- `sxw_aicoding/ADR/0012-审批与执行特权是两条正交的档位轴.md` 与 `.DS_Store` 已处于未跟踪状态；
- 本轮评审没有创建或修改上述代码、配置和既有文档。

本报告使用以下当前契约作为判断依据：

1. `sxw_aicoding/ADR/0012-审批与执行特权是两条正交的档位轴.md`；
2. `README.md`、CLI 帮助文本与 Web UI 对三档审批模式的公开说明；
3. `sxw_aicoding/实施方案设计/current-only清理实施方案_V20260831.md` 中“不兼容旧业务数据、不保留兼容层、损坏数据 fail-fast”的约束；
4. Runtime 的 RunSpec 冻结、恢复一致性、Artifact provenance 与 terminal cause 约束。

## 2. 总体结论

当前改动已经接通全局 `--approval auto` 的主要 happy path：需要审批的 Action 会自动批准，`ApprovalDecided.decidedBy=AUTO` 能进入事件、投影和 UI；全局 AUTO 下 `ask_user` 会返回 `NO_ANSWER`，而 `request_handoff` 仍等待人。

但本批仍存在 **6 项 P1、7 项 P2**。其中多项不是文案瑕疵，而是安全状态、真实执行、Artifact 归属或 terminal 事实之间的分叉：

- 人看到 CONFIRM，当前 Run 仍可能继续自动批准；
- 人在 CLI 看到“有沙箱、禁止联网”，真实命令却运行在 UNRESTRICTED；
- 失败的启动请求可能悄悄把另一个活跃 Run 切到 AUTO；
- workspace 外文件可以被登记成本 Run 的交付物；
- 没有用户作出拒绝决定，最终状态却可能归责为 `USER_REJECTED`。

这些问题直接影响“无需点击同意批准”的适用边界与事后可审计性，因此当前状态不能作为 Auto 模式收口版本合并。

## 3. P1 阻断项

### P1-1：UNRESTRICTED 可把 workspace 外文件登记成本 Run 的交付物

#### 证据

1. `tools/common/src/fs/fs-common.ts:224-232`：`executionPrivilege === "UNRESTRICTED"` 时，`writeBoundaryRefusal()` 直接放行 workspace 外路径。
2. `tools/common/src/fs/write-file.ts:131-196`：`write_file` 写入成功后，只要 `artifact_role` 合法，就把输入路径原样放入 `ProducedArtifact.path` 和 `logicalId`，没有再次限制路径必须位于 workspace 内。
3. `packages/harness-runtime/src/action/settle-batch.ts:688-733`：Runtime 收到 `outcome.artifact` 后直接登记和验证，没有 Artifact containment gate。
4. `tools/common/src/artifact-checks/index.ts:181-195`：检查器使用 `resolve(workspaceRoot, record.path)` 读取磁盘；当 `record.path` 是绝对路径时，结果仍是 workspace 外的绝对路径，因此外部文件可以通过 hash 检查。
5. `tools/common/src/exec/run-shell.ts:680-683`：同批 `run_shell` 已明确拒绝登记 workspace 外交付物，说明两个工具的交付语义已经分叉。
6. `sxw_aicoding/ADR/0012-审批与执行特权是两条正交的档位轴.md:235-237` 明确规定：UNRESTRICTED 只放宽副作用执行范围，Artifact 登记仍限 workspace 内。

#### 影响

workspace 外文件能够进入 `ArtifactRegistered`、`ArtifactVerified` 与 `deliveredArtifactIds`，被冒认为本 Run 的正式交付物。真实写权限与可交付范围被错误合并，破坏 Artifact provenance 和用户侧交付可信度。

#### 退出条件

- 在统一 Artifact 登记边界处校验 path 的 workspace containment，而不是只修 `write_file` 一个工具；
- 覆盖绝对路径、`..`、symlink/realpath、缺失 path 及四个写工具的正反例；
- 验证 UNRESTRICTED 仍可完成外部副作用，但外部文件不会进入 Artifact 集合。

### P1-2：失败的新建 Run 请求会先改变正在运行 Run 的审批模式

#### 证据

1. `apps/workagent-service/src/server.ts:341-367`：`POST /api/runs` 在 `startRun()` 之前调用 `setApprovalMode()`。
2. `apps/workagent-service/src/run-host.ts:643-645`：`startRun()` 才开始抢占前台 Run。
3. `apps/workagent-service/src/run-host.ts:802-813`：已有前台 Run 时抛错，但不会回滚前面已经修改的审批模式。
4. `apps/workagent-service/src/human-channels.ts:166-179`：活跃 Run 的每次后续审批都会重新读取这个全局 mode。

#### 影响

当 Run A 正在 DEFAULT/CONFIRM 下运行时，另一个窗口提交 Run B 并选择 AUTO：Run B 返回启动失败，但 Run A 已静默变为 AUTO，后续需要审批的副作用会自动放行。这是失败请求改变现有安全边界的原子性缺陷。

#### 退出条件

- 在修改 mode 前完成前台 Run 资格检查，或将“改档＋启动”做成可回滚的原子操作；
- 增加“已有活跃 Run＋新请求携带不同 approvalMode”的验收，断言响应失败且活跃 Run mode 不变。

### P1-3：“本次 Run 不再问”既不可撤销，也不等价于完整 AUTO

#### 证据

1. `apps/workagent-service/src/run-host.ts:258-270`：全局 mode 可修改，但 per-Run elevation 只 `add`、不 `delete`；注释却声称把全局档位拨回去等价于撤销。
2. `apps/workagent-service/src/human-channels.ts:173-179`：决策条件是 `mode === "AUTO" || isElevated(runId)`。因此切回 CONFIRM 不能覆盖已经存在的 elevation。
3. `apps/workagent-ui/public/app.js:1328-1343`：UI 切换全局 mode 后会显示“审批档位已切到 CONFIRM”，但没有显示当前 Run 仍 elevated。
4. `apps/workagent-service/src/run-host.ts:213-223`：elevation 只传给 ApprovalDecider，QuestionChannel 只读取全局 mode。
5. `apps/workagent-service/src/human-channels.ts:308-323`：只有全局 AUTO 才让 `ask_user` 返回 `NO_ANSWER`。
6. CLI 同样在 `apps/cli/src/main.ts:425-455` 只把 runId 加入审批 decider 私有集合，而 `apps/cli/src/main.ts:658-659` 的 QuestionChannel 只读取启动参数。

#### 影响

- 用户点过“本次 Run 不再问”后，即使明确切回 CONFIRM，当前 Run 仍继续自动批准；
- UI 显示的安全状态与真实行为相反，并且没有恢复审批闸门的入口；
- 按钮或终端 `a` 又不能让 `ask_user` 停止提问，因而它既不是完整 AUTO，也不是单纯可见的逐 Run 审批策略。

#### 退出条件

- 明确全局 mode 与 per-Run elevation 的优先级；
- 至少保证 CONFIRM 能恢复当前 Run 的审批闸门，或提供明确的逐 Run revoke；
- 在 Run detail/UI 中投影当前 elevation 状态；
- 统一定义“本次 Run 不再问”是否覆盖 `ask_user`，并让 CLI、Web、ADR 和验收使用同一语义；
- `request_handoff` 继续等待人不属于该缺陷，应保留当前 ADR 语义。

### P1-4：`--sandbox off` 时 CLI 审批面给出反向安全保证

#### 证据

1. `apps/cli/src/main.ts:328-339`：所有 PROCESS 审批都无条件显示“只能写 workspace 与本次调用的 `$TMPDIR`”，并依据 `allow_network` 显示“禁止联网”。
2. `apps/cli/src/compose.ts:325-334` 与 `tools/common/src/exec/sandbox.ts:149-165`：UNRESTRICTED 的真实契约是可以写任意路径、可以联网。
3. 当前 `interactiveApproval` 没有接收本 Run 冻结的 `executionPrivilege`，因此不具备正确展示的输入。
4. Web 审批卡已经按 executionPrivilege 分支展示，说明 CLI 与 Web 的安全语义发生分叉。

#### 影响

DEFAULT/CONFIRM 用户会在审批瞬间基于不存在的沙箱保证批准真实宿主命令。此处是人的最终授权面，方向相反的展示不能由启动横幅补救。

#### 退出条件

- CLI 审批展示读取 RunSpec 冻结的 executionPrivilege；
- SANDBOXED 与 UNRESTRICTED 分别显示真实的写入、网络和凭证读限制；
- 新增从 CLI 参数到审批展示的生产链验收，不能只直接调用 `executeRunShell()`。

### P1-5：CONFIRM 实际不等于公开契约中的“每一步都问”

#### 证据

1. `README.md:51-55`、`apps/cli/src/compose.ts:284-315`、`apps/workagent-ui/public/index.html:71-75` 均明确承诺 CONFIRM“每一步都问”。
2. `packages/harness-runtime/src/action/settle-batch.ts:296-375`：只有 Policy 返回 `REQUIRE_APPROVAL` 时才调用 ApprovalDecider。
3. `packages/harness-runtime/src/action/policy.ts:124-139`：当前 preset 仅对 WRITE、DELETE、EXECUTE 返回 `REQUIRE_APPROVAL`。
4. `apps/cli/src/main.ts:447-458` 与 `apps/workagent-service/src/human-channels.ts:182-184` 的 CONFIRM 分支位于 decider 内，因此 READ、NONE、NETWORK 根本不会到达该分支。

#### 影响

用户选择最保守档位后，`read_file`、目录读取、搜索、`fetch_url` 等仍可能无提示执行。无论产品真正想表达的是“每个工具调用都确认”还是“每一个策略要求审批的操作都确认”，当前实现与公开契约至少有一边是错的。

#### 退出条件

- 先确定 CONFIRM 的唯一产品语义；
- 若确实“每一步都问”，应让 mode 参与 Policy 或在 ALLOW 后增加模式提升逻辑；
- 若只问风险动作，应统一收回 README、UI、类型注释和帮助文本中的“每一步”；
- 验收必须至少覆盖 READ、NONE、NETWORK、WRITE、EXECUTE 五类动作。

### P1-6：`decidedBy=UNDECLARED` 仍被一律归责为 `USER_REJECTED`

#### 证据

1. `packages/harness-runtime/src/action/settle-batch.ts:348-355`：事件层对缺少来源的决定正确记录 `UNDECLARED`。
2. `packages/harness-runtime/src/action/settle-batch.ts:357-367`：紧接着所有 `approved:false` 都无条件写入 cause `USER_REJECTED`，并生成“用户拒绝了这个操作”。
3. `packages/harness-runtime/src/action/settle-batch.ts:1158-1183`：审批超时会返回没有 `decidedBy` 的 false 决定。
4. `packages/harness-runtime/src/types/tool.ts:462-490`：类型契约明确要求 `USER_REJECTED` 必须有用户明确拒绝事实。
5. `packages/harness-runtime/src/verification/settle-outcome.ts:110-133`：错误成因最终可以上升为 terminal `USER_REJECTED`。

#### 影响

无人应答、非交互环境、中断和审批超时均可能被错误归责给用户。事件事实、verification cause 和 terminal outcome 相互矛盾，破坏恢复决策和事后审计。

#### 退出条件

- 只有 `decidedBy=HUMAN` 的明确否决才能产生 `USER_REJECTED`；
- 为 timeout、cancel、no-channel/undeclared 分配独立且诚实的原因；
- 从 `ApprovalDecided` 一直验证到 unmet cause 与 terminal，覆盖四种来源。

## 4. P2 重要问题

### P2-1：`HarnessRuntime.start(spec)` 缺少 executionPrivilege 一致性闸门

`packages/harness-runtime/src/facade/index.ts:132-161` 直接冻结并执行调用方传入的 spec；`packages/harness-runtime/src/facade/index.ts:253-280` 只在 resume 路径检查当前 composition privilege 与 RunSpec 冻结值是否一致。

Resolver 使用 composition 构造期档位，Policy、上下文和 ToolExecutionContext 使用 RunSpec 档位。公共 `start(spec)` 因而允许两者分叉。当前 CLI/Web 的 `makeRunSpec()` 能保持一致，但 Facade 自身没有守住公开不变量。

退出条件：start 与 resume 在产生任何 Run 事实前执行同一 privilege assertion，并增加不匹配双向拒绝测试。

### P2-2：损坏或缺失的 executionPrivilege 被静默当成 SANDBOXED

`packages/harness-runtime/src/types/run.ts:50-65` 把除精确 `UNRESTRICTED` 外的缺字段、`null`、拼写错误和任意非法值都折叠为 SANDBOXED；`packages/store-sqlite/src/run-repository.ts:80-107` 只做 `JSON.parse as AgentSpecSnapshot`，没有运行时 schema 校验。

这会掩盖数据库损坏，并可能让历史 Run 的执行语义静默漂移。它也直接违反 `sxw_aicoding/实施方案设计/current-only清理实施方案_V20260831.md:3-17` 已确认的不兼容旧数据、删除兼容层和 fail-fast 原则。

退出条件：读库/冻结 RunSpec 时做严格枚举校验，缺失或非法值携带 runId/specId 明确失败，不保留旧字段 fallback。

### P2-3：错误 pending kind 可在返回 409 前留下 elevation

`apps/workagent-service/src/server.ts:392-429` 在 `alwaysForRun=true && approved=true` 时，先按 pendingId 找任意 pending 并 elevate，之后才调用会校验 kind 的 `answerPending()`；`apps/workagent-service/src/human-channels.ts:82-89` 在 kind 不匹配时返回 false。

因此向 HANDOFF/QUESTION pending 发送伪 APPROVAL 请求会得到 409，但目标 Run 已进入后续审批自动放行状态。

退出条件：先原子校验 pending 存在、kind=APPROVAL、runId 匹配且应答仍有效，再执行 elevation 与 resolve；失败不得留下任何状态变化。

### P2-4：带值参数位于末尾但缺值时静默使用默认档

CLI 的 `apps/cli/src/main.ts:129-176` 和 service 的 `apps/workagent-service/src/main.ts:48-79` 在识别 VALUE_FLAG 后盲目跳过下一项，没有断言值存在。参数位于末尾时，`--approval` 会回落 DEFAULT，`--sandbox` 会回落 SANDBOXED。

这与同批“错误配置立即失败”的设计目标相反，也会让自动化任务以为启用了 AUTO，实际中途停下来等待人。

退出条件：所有 VALUE_FLAG 都必须有非 flag 的下一项；缺值、重复值和把另一个 `--flag` 当值都应明确报错。

### P2-5：冻结的 executionPrivilege 没进入独立审计面

1. `apps/cli/src/trace/file-sink.ts:30-49` 的 Trace header 没有 executionPrivilege；
2. `packages/harness-runtime/src/types/event.ts:18` 的 `RunStarted` 事件也不携带它；
3. `apps/workagent-service/src/run-host.ts:463-486` 构造 Run detail 时遗漏该字段；
4. `apps/workagent-service/src/api-types.ts:393-410` 的 UI 契约没有对应字段；
5. UI 只能展示当前服务档位，无法独立回答历史 Run 当时是否有沙箱。

SQLite RunSpec 目前保存了权威值，但独立拿到 JSONL 或 Web 白盒详情时无法完成审计。重启换档后，当前 service 值更可能被误认为历史 Run 值。

退出条件：Trace/Run detail 投影冻结值，并将“当前服务档位”与“所选 Run 冻结档位”分栏展示。

### P2-6：自动批准日志绕过终端字符净化

`apps/cli/src/main.ts:449-463` 的 AUTO/elevated 和 DEFAULT 自动批准分支直接输出模型可控的 `e.scope.value`；同文件 `apps/cli/src/main.ts:382-395` 的人工审批路径已经明确使用终端净化函数。

带 ANSI、双向或零宽控制字符的路径/作用域可以清屏、覆盖或伪造自动批准日志，甚至掩盖启动时的红色警告。

退出条件：所有终端输出统一经过 `stripUnsafeDisplayChars`/`forTerminal`，并加入 ANSI、Bidi、零宽字符回归测试。

### P2-7：Web 审批状态缺少 revision 和跨标签广播

1. `apps/workagent-service/src/server.ts:199-218` 的 `/api/state` 先读取 `host().info()`，再 await `listRuns()`；期间全局 mode 可以改变。
2. `apps/workagent-ui/public/app.js:1176-1184` 的并发 `refresh()` 没有请求代次或单调 revision，晚到旧响应可以覆盖新状态。
3. `apps/workagent-ui/public/app.js:1328-1343` 修改 mode 后会再触发 refresh；SSE 也会调度 refresh。
4. mode route 没有发送 config 事件，另一个标签页可以长期停留在旧徽章。

影响是服务已经 AUTO，某个页面仍显示 DEFAULT/CONFIRM，用户据此误以为下一次会询问。

退出条件：给审批配置增加单调 revision，前端丢弃旧响应；mode 变化广播配置事件，或统一序列化/取消旧 refresh。

## 5. 验收证据缺口

### 5.1 `verify:shell` 宣称覆盖四个写工具，实际只测 `write_file`

`apps/cli/src/verify/shell.ts:665` 的注释点名 `write_file`、`edit_file`、`append_log`、`slow_write`，但 `apps/cli/src/verify/shell.ts:690` 的夹具硬编码 `toolName: "write_file"`。另外三个 handler 任一漏掉 `writeBoundaryRefusal()`，当前判据仍会全绿。

### 5.2 当前新增验收未覆盖本报告的关键失败方向

至少缺少：

- 已有前台 Run 时，失败启动请求不能改变全局 mode；
- elevated Run 切回 CONFIRM 后必须恢复审批，或明确展示不可撤销；
- `elevated → ask_user` 的既定语义；
- 错误 pending kind 不得留下 elevation；
- CONFIRM 下 READ、NONE、NETWORK 是否真的询问；
- UNRESTRICTED 外部写可以执行，但外部 Artifact 不得登记；
- CLI 审批文案必须与 RunSpec 冻结的 sandbox 档位一致；
- `UNDECLARED/timeout/cancel/HUMAN` 到 terminal cause 的完整归因链；
- Trace 与 Run detail 能显示历史 Run 的冻结 executionPrivilege；
- Web 并发 refresh 与多标签 mode 同步。

### 5.3 验收脚本自身的验证边界

现有 B9/B10 直接构造 ToolExecutionContext 调用 handler，能够验证工具局部行为，但不能证明：

`CLI parser → compose → RunSpec → Runtime/Policy → approval display → handler → Artifact/Trace/UI`

这条生产链上的字段和值没有分叉。Auto 和执行特权属于跨层契约，收口验收不能只覆盖 helper 或 handler。

## 6. 已确认的正向方向

1. `--approval confirm|default|auto` 与 `--sandbox on|off` 已拆成两条独立轴；运行期没有提供修改 executionPrivilege 的 HTTP 开关。
2. 全局 AUTO 下需要审批的 Action 会自动放行，并记录 `decidedBy=AUTO`。
3. 全局 AUTO 下 `ask_user` 走 `NO_ANSWER`，`request_handoff` 继续等待人，符合当前 ADR。
4. `ApprovalDecided.decidedBy` 已进入事件、投影和 UI，能够表达 `HUMAN/AUTO/AUTO_GRANT/UNDECLARED`。
5. executionPrivilege 已随 AgentSpec/RunSpec 冻结，并进入上下文、Policy 和 ToolExecutionContext。
6. resume 对合法 SANDBOXED/UNRESTRICTED 的双向漂移已经设置拒绝闸门。
7. UNRESTRICTED 的 shell effect resolver 会记录“无法排除网络外发”，没有把网络能力静默隐藏。
8. UNRESTRICTED 仍保留凭证文件读禁和环境变量白名单，没有直接退化为裸 bash。
9. `run_shell` 已正确限制 Artifact 只能登记 workspace 内路径。

这些正向结果说明总体分轴方向成立，但不能抵消前述安全状态与交付事实分叉。

## 7. 本轮执行的检查与未验证边界

### 已执行

- `git status --short --untracked-files=all`：锁定评审前后工作树范围；
- `git diff --check`：通过；
- `npm run typecheck`：通过；
- `node --check apps/workagent-ui/public/app.js`：通过；
- 目标文件源码、相关 ADR、current-only 方案和验收脚本的只读交叉追踪。

### 未执行

为遵守原始“仅做评审，不要做任何改动”的边界，没有运行会创建 workspace、SQLite、Trace、canary 或临时产物的：

- `verify:ui`、`verify:shell`、`verify:all` 及其他 `verify:*`；
- 真实 CLI/Web Run；
- 真实 LLM、网络、浏览器或 MCP 调用；
- SQLite/resume、Artifact 外部路径和审批超时的动态复现；
- macOS seatbelt profile 的真实内核行为验证。

因此本报告对运行行为的判断来自当前源码端到端静态追踪；`typecheck` 与语法通过不能替代上述动态证据。

## 8. 建议的收口顺序

1. 先修 P1-1、P1-2、P1-3、P1-4：恢复 Artifact、审批状态与人机展示的真实边界；
2. 再统一 CONFIRM 和 `USER_REJECTED` 契约，避免验收建立在错误语义上；
3. 补齐 start privilege 闸门、current-only fail-fast 和 pending 原子性；
4. 把 executionPrivilege 投影到 Trace/Run detail，并修复终端净化与 Web 配置版本；
5. 最后补跨层验收，必须逐条证明本文失败方向会由修复前红、修复后绿；
6. 完成后再运行 `typecheck`、相关 `verify:*` 与 `verify:all`，并单独记录真实执行/网络/MCP 未覆盖边界。

在 6 项 P1 全部关闭、7 项 P2 有明确处置且验收具备判别力之前，建议继续保持 **NO-GO**。
