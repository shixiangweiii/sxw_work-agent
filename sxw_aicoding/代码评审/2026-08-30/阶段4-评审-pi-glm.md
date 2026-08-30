# 阶段 4 代码评审（pi / glm）

> 评审日期：2026-08-30
> 评审对象：阶段 4「产品化半边」的**未提交改动**（工作区相对 HEAD `c203643`）：新增 `apps/workagent-service/`（Layer 2 六文件）、`apps/workagent-ui/public/`（Layer 1 三文件）、`apps/cli/src/verify/boundaries.ts` 与 `verify/ui.ts`；修改 `apps/cli/src/compose.ts` / `main.ts` / `verify/tools.ts`、`packages/harness-runtime/src/budget/index.ts`、根 `package.json`；文档回填 Roadmap §6、V05 §5.1 / §27.1 / §27.2 / §28.5、ADR-0009、存量清单 §0.12、CLAUDE.md、README。
> 参照基线：[阶段 4 实施方案 V20260830-01](../实施方案设计/阶段4实施方案_V20260830.md)、[ADR-0009](../ADR/0009-阶段4-UI-不引入前端框架与-Electron.md)、[Roadmap §6](../阶段roadmap/WorkAgent阶段Roadmap_V20260823.md)。
> 评审方式：逐文件精读全部新增代码（service 六文件 100% / app.js 100% / verify/ui.ts 100%）与全部 diff；对照 `facade.start()/resume()`、`run-loop`、`FileTraceSink`、`isInsideWorkspace` 等被依赖方核实时序与判定语义；复跑 `npm run typecheck`（干净）、`npm run verify:ui`（**20 ✓ / 0 ✗**）、`npm run verify:tools`（14 ✓ / 0 ✗）；另写两个 /tmp 复现脚本对两项发现做了实跑取证（仓库零改动，验收 canary 无遗留）。
> 性质：**仅评审，未修改任何代码**。

---

## 0. 总体结论

**工程质量整体高，方案声明的纪律在代码里基本兑现；但「Web 入口 × resume × 服务重启」这条组合路径上有 1 个已复现 bug ＋ 2 个设计缺口，全部落在验收夹具（同进程、单服务、脚本化模型）没有覆盖的地方。**

1. **复验结果**：`typecheck` 干净；`verify:ui` 20/20 全绿（含三条新边界的注入实测、四道闸门含「Host 正确必须 200」的配对判据、真 key 凭证扫描）；`verify:tools` 14/14（边界表迁移后 A 段照常全绿）。文档声明的计数核对无误：verify:ui 恰 20 条判据、115 + 20 = 135、边界表 11 条目编号到 10。
2. **最重要的发现（P1，已复现）**：对终态 Run 点一次 resume（UI 对所有非 live 的 Run 都显示 resume 按钮），`liveInThisProcess` **永久卡在 true**——完成态的 Run 从此挂「在跑」chip、按钮变成取消/插话，直到服务重启。`/tmp` 复现脚本实测输出见 §2.1。
3. **两个跨进程/重启缺口（P2 / P3）**：CLI 崩了在界面上 resume 之后，前段的事件轨道被整段丢弃（`detail()` 在「本进程缓冲」与「trace 文件」之间二选一，注释自己写着 trace 是「历史的全部段」，代码却从不并集）；Web 入口写 trace 只写 event 行不写 footer，服务重启后 Web 完成的 Run 的 outcome 在界面上蒸发。两者都直接削弱 N-1 要支持的场景。
4. **一处安全不一致（P4，一行可修）**：`/api/artifact` 预览只做词法前缀判定，没有 realpath——全仓写路径都是两道判定（R-5），这条读路径绕过了它，workspace 内符号链接可把 workspace 外的文件内容送进浏览器。
5. 其余为 1 个低危竞态（P5）与约 9 条 nits、2 处文档数字漂移，见 §3 / §4。

**处理建议**：P1 修复后再提交（改动很小）；P2 / P3 / P4 修或登记进存量清单均可，但都应在提交前明确处置；P5 与 nits 可随批或登记后处理。

---

## 1. 与方案、边界的符合性核对（先说绿的）

| 方案条款 | 核对结果 |
|---|---|
| 决 2「不引入前端框架 / 依赖仍 3 个」 | ✅ `apps/workagent-ui` 无 `src/`、无构建配置、`public/` 三文件零 import；service 只用 node 内置 + 既有 workspace 包，`package.json` 无新依赖 |
| 决 4「三个接口一个字不改」 | ✅ `human-channels.ts` 只实现 `ApprovalDecider` / `HandoffChannel` / `QuestionChannel`，Runtime 侧仅 `budget/index.ts` 新增 `readBudgetAxes`（读数抽取，`checkBudgets` 改为跑在同一张表上，判定逻辑逐行未变——diff 核对过，仅循环变量形态变化） |
| 决 5「投影只合并不推算」 | ✅ `projection.ts` 每个字段可指回事件 payload 或 RUN_META；`budgetAfter` 取轮边界 RUN_META 而非累加（注释把理由写透了）；`detail()` 的 snapshot 原样来自 `inspect()`，C 段判据逐字比对 |
| 决 6「Layer 2 不推进执行语义」 | ✅ 全文件无 `setStatus` / 自建循环 / Effect 解析；「RUNNING 但本进程没在跑」如实分两句显示（但见 §2.1 的反面：失败路径会**伪造** live 标志） |
| 决 7 §22.6 四条 + Host 第五条 | ✅ 只绑 127.0.0.1、默认随机端口、会话 Token（定长比较、不发 Cookie）、Origin + Host 字面量校验；静态壳豁免 Token 的理由（CSS/JS 不带凭据 → 白纸，Cookie / 注 HTML 两条补救都更差）过程留在了注释里 |
| 不得绕过 #8（textContent） | ✅ `el()` 只走 `textContent` / `createTextNode`；边界 10 模式带前导点，散文提及不误报（实测 `public/` 内 2 处提及均为注释） |
| 边界 grep 8 → 10 | ✅ 表迁到 `boundaries.ts` 单一份，两个消费者共用；`verify:tools` A 段跑全表 11 条，`verify:ui` A 段对 8 / 9 / 10 各注入实测且当场翻红 |
| S4-1「Composition Root 不抄第二份」 | ✅ service 相对 import `../../cli/src/compose.js`，与 `eval/suite` 同一条路；`autoGrantVerdict` 从 `main.ts` 闭包提进 compose，E-3 的档位语义（PARTIALLY_REVERSIBLE 放行）原样保留 |
| 工程基线 | ✅ 两空格 / 双引号 / 分号 / 尾逗号 / `.js` 后缀；注释中文带 V05 / 决 N 引用；无 formatter 环境下与邻近代码一致 |

值得单独点名的三个亮点：

- **`readBudgetAxes` 的抽取方式**：提出来的是读数不是判定，`checkBudgets` 仍是唯一判官；「inputTokens 轴读 billed」被 C 段判据钉死。这是「研究问题答案 = 差一处」的模范处置。
- **仪器缺陷的处置**（E 段）：`fetch` 静默丢 `Host` 头 → 裸 socket 重写 + 配对正例「Host 正确必须 200」（否则拒绝一切的服务与正确的服务不可区分）。过程完整留档。
- **D2 段把无判别力的断言降级为 fact 并留全过程**（「结算不是 USER_REJECTED」在注入实测下照样绿 → 降级）。这是阶段 3.5 教训的当场兑现，且诚实记录了「这次抄教训的人是我」。

---

## 2. 主要发现

### 2.1【P1 · 已复现】失败的 resume 把 `liveInThisProcess` 永久卡在 true

**位置**：`apps/workagent-service/src/run-host.ts:428-430`（`drive()`）＋ `beginSegment()`（约 :487）。

**机理**：resume 路径在 `drive()` 一进来就 `beginSegment(runId)`（置 `done=false`、清 error），然后 `await gen.next()`。而 `facade.resume()` 的三道闸门——端点不一致（facade/index.ts:221）、终态 Run（:231）、缺恢复决策（:255）——**全部在第一个 yield 之前 throw**（resume 内部先要 `readAll` / `rebuildMessages` / `lastSequence` 三次 await 才 yield `ResumeStarted`）。异常直接冒出 `drive()`，没有任何路径把 `record.done` 复位或记 `record.error`（那段 try/catch 只包**首个事件之后**的后台循环）。

**触发面**：UI 对所有 `liveInThisProcess === false` 的 Run 显示 resume 按钮——**包括 COMPLETED / FAILED**（`renderRunbar` 的 else 分支）。点一次就中。

**实测取证**（/tmp 脚本，起真服务走 HTTP）：

```
完成后        status=COMPLETED liveInThisProcess=false
resume 响应   500 {"error":"Run run_dbb62e27d33e 已处于终态 COMPLETED，拒绝 resume。…"}
resume 之后   status=COMPLETED liveInThisProcess=true  ← 卡住了
runlist       COMPLETED/live=true
```

**后果**：完成态的 Run 在列表里挂「在跑」chip、runbar 变成取消/插话按钮，直到服务重启。`cancel()` 也清不掉（cancel 不写 `done`）；只有再次成功的 resume 跑完一段才顺带复位。这与决 6 的精神**反向**违例：投影在伪造「本进程在跑」这个第二事实——而且正是因为正常路径「如实显示两个事实」做对了，这个失败路径的伪 live 才更迷惑。

**修法方向**（任选其一，改动都很小）：
1. `drive()` 里对 `const first = await gen.next()` 包 try/catch：失败时 `record.done = true; record.error = message`（正好喂给已有的 `serviceError` 字段）；
2. 或 resume 路径不预置 record，`beginSegment` 推迟到首个事件成功到达（与 startRun 对称）。

顺带：`renderRunbar` 对终态 Run 不该显示 resume 按钮（COMPLETED/FAILED 点了必错），这一半属于 §3 的 nits，但它与 P1 叠加成了最容易踩到的路径。

### 2.2【P2 · 代码可证】跨进程 resume 后，前段事件轨道被整段丢弃

**位置**：`run-host.ts:192-193`（`detail()`）与 `eventsSince()`（约 :370）。

```ts
const fromTrace = live?.events.length ? [] : loadTraceEvents(traceFile);
const events = live?.events.length ? live.events : fromTrace;
```

`detail()` 的注释自己写着：「缓冲是**这一段**正在发生的事，trace 是**历史的全部段**」——但代码是**二选一**，不是并集。场景：CLI 跑到一半崩了（A 段事件在 trace 文件里）→ 界面上 resume（B 段事件进本进程缓冲）→ `detail()` 只用 B 段缓冲，**A 段的 ApprovalRequested / AttemptCompleted / TurnStarted / Budget* 全部不进时间线与逐轮解剖**。transcript 轨道是全的（SQLite `readAll`），所以表现为「前几轮长得像 --no-trace 跑的」——effect、审批、逐轮帧构成对前段全部隐身。`eventsSince()` 同样，SSE 回放同样缺前段。

**为什么验收没抓到**：D2 段是**同进程** cancel → resume，缓冲跨段累积（`beginSegment` 刻意不清缓冲），恰好掩盖了这个缺口；而跨入口（CLI 崩 → UI resume）正是 N-1 修完之后明确要求支持的路径——「两段轨迹在同一个文件里接上」目前只在**文件**里接上了，**投影**里没有。

**修法方向**：按 sequence 去重合并 `buffer ∪ trace`（D-2 全局单调序列保证去重安全；当前段的事件本来就同时写进了文件，天然同号）。这条值得配一条跨进程夹具的判据（两个服务、同一个 db 文件 + trace 目录），否则修没修都看不出来。

（评审注：我尝试过写双服务跨进程夹具复现，脚本卡死——疑似两个进程同时打开同一个 SQLite 文件的行为问题，见 §3 最后一条 nit。机理本身由代码直读可证。）

### 2.3【P3 · 缺口】Web 入口写 trace 只写 event 行，不写 header / footer

**位置**：`run-host.ts` 的 `appendTrace()`（注释自陈「header / footer 由 CLI 写」），后果未登记：

1. **服务重启后，Web 完成的 Run 的 outcome 蒸发**。`detail()` 里历史 Run 的 outcome 唯一来源是 `loadTraceOutcome()`（只认 `kind:"footer"` 行）。进程活着时靠 `live.outcome`；重启后 footer 不存在 → `outcome` / `recovery.items` 全空（runs.status 还在，但 kind / summary / incompleteItems 没了）。实测复现里 Web 驱动的 Run footer 0 行、outcome 为 `(无)`。
2. Trace 视图「按段分组、每段带 commit + gitDirty」对 Web 段无段头——分段的叙事对 Web 段断掉；CLI 之后若再 resume，`FileTraceSink` 的 segmentIndex 按 header 行计数，Web 段不计入（段号仍唯一，只是叙事缺一块）。

**修法方向**：`drive()` 收尾处补写 footer（outcome / terminal 都已在手上）；header 可以不做（Web 段的身份可由 event 行自带的字段推），但 footer 是结算事实，建议至少登记存量清单。

### 2.4【P4 · 安全不一致】`/api/artifact` 预览缺 realpath，绕过 R-5 两道判定

**位置**：`run-host.ts:315-319`（`artifactPath`）。

```ts
const target = resolve(this.opts.workspaceRoot, rel);   // 只做词法归一
if (target !== root && !target.startsWith(`${root}/`)) return undefined;
```

全仓**写**路径的边界是 `isInsideWorkspace` 的两道判定（词法 + realpath，`tools/common/src/fs/fs-common.ts:34`，注释明确「两道都不能省」）；`run_shell` 沙箱只限制**写**落在 workspace 内——在 workspace 里 `ln -s ~/.ssh/id_rsa link.txt` 是一次合法写，随后这个**读**端点会把 workspace 外的文件内容送进浏览器。读工具那条线本来有 read-guard 三条护栏（ADR-0006），这个预览端点是唯一没走护栏的读路径。`security.ts` 自己声明这个服务代理的是「能读你磁盘、能跑 shell 的 Agent」，这条口子与之不符。

**修法**：一行——换成 `isInsideWorkspace(workspaceRoot, target)`（或等价 realpath 判定）。注意 `isInsideWorkspace` 对不存在的目标走「最近已存在祖先」的 realpath，正好适配预览场景。

### 2.5【P5 · 低危竞态】`assertNoActiveRun` 的 TOCTOU

**位置**：`run-host.ts:330`（`startRun`）＋ `drive()` 里 `this.currentRunId = runId` 的时机。

`currentRunId` 要等**第一个事件**才置位，而 `facade.start()` 在首个 yield 前有 `await createRun`（SQLite I/O，facade/index.ts:118）——这个窗口里第二个 `POST /api/runs` 能通过闸门，两个 Run 并发，handoff / question 会挂到错误的 Run 上（`currentRunId` 被后到者覆盖）。UI 提交按钮 disabled 有缓解，但 API 层面这道闸门在窗口期名存实亡——正是本仓反复记的「一条闸门排在另一条后面等于没有闸门」的形状。S4-4 登记了「两个 Channel 接口不带 runId」，但这个具体竞态没登记。单人本地风险低；建议登记，彻底修需在 start 时同步占位（如先置 `currentRunId = "pending"` 再 await）。

---

## 3. 次要问题（nits，按文件）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `projection.ts` `touch()` 的 tool_result 分支 | 若某 TOOL_ACTIVITY 由 tool_result 先创建（跨窗口 / 缺前段 transcript 时的现实形态），`source.track` 保持 `"EVENT"` 而序号是 transcript 的——证据等级标错。api-types 特意声明两轨可靠性不同（「事件流的证据等级低一档」），这条标注恰好失真 |
| 2 | `server.ts:165` | `Number(since)` 无 NaN 防护：`?since=abc` 静默变成「无回放」，SSE 连上了但什么也不补发 |
| 3 | `server.ts` `readJsonBody` | 超限抛通用 Error → 500，语义应为 413 / 400（外层 catch 统一回 500） |
| 4 | `server.ts` pending 路由 | kind 与等待中不符时返回的文案「这个请求已经不在等待中」对 kind 错配略误导（409 本身是对的） |
| 5 | `run-host.ts` `info().approvalMode` | 硬编码描述串是 `autoGrantVerdict` 的第二事实来源——档位改了它会悄悄漂移，而它正是给用户看的那句 |
| 6 | `verify/ui.ts` | `const { mkdirSync } = await import("node:fs")` 多余——顶部已静态导入同模块的四个函数 |
| 7 | `app.js` SSE `onerror` | 服务重启（Token 轮换）后 EventSource 带旧 token 永远 401，错误被静默，页面无任何提示；加一个「连接已断，请用新 URL 重开」的 toast 很便宜 |
| 8 | `run-host.ts` `LiveRun.events` | 无上限增长（长跑 Run 内存）。本地单人可接受，宜注释登记上限策略 |
| 9 | CLI 与 UI 并存 | 两个进程打开同一个 SQLite 文件的行为（锁 / WAL）未见任何说明；我的跨进程复现脚本卡死疑似与此有关。CLAUDE.md 的「同一套装配」段落值得补一句「不要同时开两个入口指同一个库」或说明为什么可以 |
| 10 | `app.js` `renderRunbar` | 终态 Run 也显示 resume 按钮（与 P1 叠加成最易踩路径；且 COMPLETED/FAILED 点了必错，按生命周期语义应只对 RUNNING / CANCELLED / RECOVERY_REQUIRED / WAITING_* 显示） |

## 4. 文档数字漂移（小，但本仓的数字一向是硬承诺）

| 位置 | 问题 |
|---|---|
| ADR-0009「Eval Evidence」、存量清单 §0.12 开头 | 都写「**19** 条判据」，`verify:ui` 实际 **20**（Roadmap / CLAUDE 的 20 / 135 是对的，115 + 20 = 135 吻合） |
| ADR-0009「重新评估的触发条件」 | 说 app.js「现在 700 行左右」，实际 **978** 行（离 1500 阈值仍远，但数字该准） |

---

## 5. 证据与限度

- 复跑命令：`npm run typecheck`（干净）、`npm run verify:ui`（20 ✓ / 0 ✗）、`npm run verify:tools`（14 ✓ / 0 ✗）。`verify:all` 未整跑（14 条脚本全量耗时长；改动面已由上述三条覆盖：typecheck 覆盖全部新代码，verify:ui 覆盖新增服务与验收，verify:tools 覆盖边界表迁移）。提交前建议整跑一次。
- 两项实跑取证均为 /tmp 一次性脚本（P1 的完整输出见 §2.1；P3 的 footer=0 顺带取自同一脚本），已删除，仓库工作区与验收 canary 均确认零残留。
- P2 的双进程夹具未跑通（§3 第 9 条），其结论基于代码直读 + `detail()` 单进程行为旁证；置信度高，但修复时应配跨进程判据。
- 本评审**未评审** `app.css` 的视觉细节与真实浏览器交互（无头环境），界面可用性以 ADR-0009 记录的人工视觉核对为准。

## 6. 处理顺序建议

1. **P1**（必修，小改）：`drive()` 首事件失败路径复位 record——修完顺手把 §3-10 的 resume 按钮条件收紧。
2. **P4**（必修，一行）：`artifactPath` 换 `isInsideWorkspace`。
3. **P2 / P3**（修或登记，二选一但必须显式处置）：buffer ∪ trace 按 sequence 去重合并；`drive()` 收尾补 footer。若本批不修，登记存量清单时建议注明「D2 夹具为同进程，掩盖了跨入口形态」——这是夹具设计本身的教训。
4. **P5** 与 §3 nits：随批或登记后处理；§4 两处文档数字提交前顺手改掉。
