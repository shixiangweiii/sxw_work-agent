# 阶段 4 代码评审（zcode）

> 评审日期：2026-08-30
> 评审对象：阶段 4 产品化半边（git 未提交改动：10 个已跟踪文件 ＋ 新增 `apps/workagent-service/`、`apps/workagent-ui/`、`verify/boundaries.ts`、`verify/ui.ts`、ADR-0009、实施方案）
> 实施方案：[阶段4实施方案_V20260830.md](../../实施方案设计/阶段4实施方案_V20260830.md)（V20260830-01，§0 七个决定、§1 九条退出门槛、§3 十条不得绕过、§4 边界 grep 8→10）
> 评审依据：上述方案 ＋ [ADR-0009](../../ADR/0009-阶段4-UI-不引入前端框架与-Electron.md) ＋ [WorkAgent架构设计_V20260823_05.md](../../架构设计/WorkAgent架构设计_V20260823_05.md)（V05 §5 / §5.4 / §22.6 / §23 / §27.1）＋ [存量问题清单_V20260824.md](../../存量BUG/存量问题清单_V20260824.md) §0.12 ＋ Roadmap §6.1
> 评审方式：全量 diff ＋ 新增 14 个源文件逐个走读 ＋ 关键声明独立复验（typecheck、verify:tools、verify:ui、verify:all 全量重跑），非纸面核对
> 性质：**仅评审，未修改任何代码**

---

## 0. 总体结论

**这是一批质量很高、可以提交的工作。** 研究问题（"Runtime 一行不改能否投影出白盒界面"）的答案在代码与文档里自洽：

1. 唯一的 Runtime 改动（`checkBudgets` 提出 `readBudgetAxes`）确实是**读数不是判定**——`checkBudgets` 自己跑在它上面，仍是唯一的表、唯一的判官；
2. 三条等人通道（`ApprovalDecider` / `HandoffChannel` / `QuestionChannel`）接口一个字没改，浏览器侧换实现即通——决 4 的判别力主张成立；
3. 十条不得绕过逐条核对无违反；边界 8 / 9 / 10 的判别力实测真实有效（见第 2 节复验）；
4. 新代码的注释纪律（中文、理由与失败模式、V05/清单条目引用）高于仓内平均水准，多处长注释记录的是「为什么这么定」而非「这行干什么」。

发现 **1 项 P1（应在提交前修）＋ 2 项 P2（修或登记欠账）＋ 7 项 P3 ＋ 2 处文档数字失准**，详见第 3–6 节。

---

## 1. 评审范围

| 层 | 文件 | 内容 |
|---|---|---|
| Runtime（唯一改动） | `packages/harness-runtime/src/budget/index.ts` | `readBudgetAxes()` 八条轴读数表；`checkBudgets` 改跑在它上面 |
| Composition Root | `apps/cli/src/compose.ts` | `autoGrantVerdict()` 从 `main.ts` 闭包提升为两入口共用 |
| CLI 入口 | `apps/cli/src/main.ts` | `autoGrant` 改为委托 `autoGrantVerdict`；判定逻辑与理由随之搬迁 |
| 验收脚本 | `apps/cli/src/verify/boundaries.ts`（新增） | 边界表**唯一**一份（11 条目、编号到 10）＋ `grepBoundary` |
| 验收脚本 | `apps/cli/src/verify/ui.ts`（新增） | A–F 六段 20 条判据；`verify/tools.ts` 改为只负责跑表 |
| Layer 2 | `apps/workagent-service/src/`（新增 7 文件） | projection / run-host / human-channels / security / server / api-types / main |
| Layer 1 | `apps/workagent-ui/public/`（新增 3 文件） | index.html / app.js（978 行）/ app.css；纯静态、无构建、无 import |
| 文档 | CLAUDE.md、README、Roadmap §6、存量清单 §0.12、架构设计 §5.1/§27.1/§27.2/§28.5、ADR-0009、实施方案 | 回填 |

---

## 2. 独立复验结果（非复述文档声明）

| 验证项 | 命令 / 方法 | 结果 |
|---|---|---|
| 静态 | `npm run typecheck` | ✅ 干净 |
| 边界全表 | `npm run verify:tools` | ✅ A 段 11 条规则真实依赖零命中；第 6b 条 canary 实测在场 |
| 阶段 4 验收 | `npm run verify:ui` | ✅ 20 条判据全绿（A 段三条新边界注入即翻红并指出行号；D 段三条通道走真实 HTTP；E 段四道闸门 401/401/403/403 ＋ Host 正确 200；F 段 SSE 游标逐条相同） |
| 回归 | `npm run verify:all` | ✅ 退出码 0；13 条脚本打印「判据合计」共 129 条 ＋ `verify:resume`（不走 runVerify 合计打印，自带输出）——与「14 脚本 / 135 判据」的声明能对上 |
| 判据账目 | CLAUDE.md 声明 115 → 135 | ✅ 增量 20 与 `verify:ui` 实际判据数一致 |
| 边界条数声明 | 「11 条（编号到 10）」 | ✅ `boundaries.ts` 实际 11 个条目，最大 id 为 10 |
| 幻影事件检查 | verify:ui B 段输出（事件 41 条、序号 1…57） | ✅ 缓冲区无同号重复（空洞为 ModelStreamDelta 占号），D-2 序列在两条轨道上成立 |

---

## 3. P1 问题（建议提交前处理）

### P1-1　`resume()` 抛错路径留下幻影「在跑」记录——投影断言了假事实

**位置**：`apps/workagent-service/src/run-host.ts:428`（`beginSegment`）＋ `run-host.ts:430`（第一次 `await gen.next()`）＋ `run-host.ts:447-468`（后台循环的 try/catch）

**机理**：`drive()` 在第一次 `gen.next()` **之前**就 `beginSegment(runId)` 建好 `LiveRun`（`done: false`）。如果第一次 `gen.next()` 抛错——正是 `run-host.ts:454` 注释自己列举的「端点不一致、**终态 Run**、缺恢复决策」——异常直接穿出 `drive()`，而后台那个带 `finally`（置 `done = true`）的 try/catch 根本还没启动。后果：

- `record.done` 永远为 `false` → `isLive()` 返回 true → Run 列表显示「在跑」chip、详情页显示取消/插话按钮而不是 resume，**直到进程重启**；
- `record.error` 也未设置 → `serviceError` 为空，错误原文只在那次 POST 的 500 响应里出现过一次，界面上不留痕迹。

**可达性**：界面两步可达——对一个 COMPLETED 的 Run 点 resume（按钮可见，因为 `!liveInThisProcess`）→ Runtime 生命周期闸门抛错 → 该 Run 从此显示「在跑」。

**为什么是 P1 而不是显示瑕疵**：决 6 的纪律是「投影不修正事实，它转述事实」，而这里投影**凭空断言了一个假事实**（本进程里没有任何循环在跑它，界面却说在跑），恰好是本批自己列的边界 9 要防的那类「盘上看不出来」的形态的反向版本。且 `verify:ui` D2 段只测了「取消 → resume 成功」路径，「resume 被闸门拒绝」路径没有判据覆盖。

**同根因**：`cancel()`（`run-host.ts:349`）对不在跑的 Run 也会经 `aborterFor()`（`run-host.ts:402`）凭空创建 `done: false` 的记录（`facade.cancel` 对无中断记录的 Run 是 no-op，不抛错）。

**修法建议**（十行以内）：`drive()` 里把 `await gen.next()` 包进 try/catch，失败时 `record.done = true; record.error = (err as Error).message` 再重新抛出；`aborterFor` 拆成「查询」与「创建」两个语义，`cancel` 只查不建。

---

## 4. P2 问题（提交前修掉，或登记为欠账）

### P2-1　SSE 的 Last-Event-ID 断言不成立，「不重不漏」只对了一半

**位置**：`apps/workagent-service/src/server.ts:288-291`（写 `id:` 行并注释「重连游标这件事连代码都不用写」）＋ `server.ts:165`（只读 `?since=`）＋ `apps/workagent-ui/public/app.js:941`（`es.onerror` 什么都不做）

**机理**：服务端从不读 `last-event-id` 请求头；而 UI 完全依赖 EventSource 原生重连——原生重连复用**连接时的旧 URL**，`since` 停留在 connect 时刻的值，所以每次自动重连都会从旧游标整段重放。现在界面没出问题，仅仅因为「全量重取」把重复事件消化掉了，**不是因为游标在干活**。F 段判据测的是手动带 `since` 重连，而真实 UI 从不走那条路。

**修法建议**：一行——`Number(url.searchParams.get("since") ?? req.headers["last-event-id"] ?? 0)`。不修的话至少把 `server.ts:289` 与 `app.js:942` 两处注释改成实话，否则下一个人会以为这条通路是通的。

### P2-2　Web 入口的 trace 没有 header/footer，进程重启后 outcome 从界面消失

**位置**：`apps/workagent-service/src/run-host.ts:533-541`（`appendTrace` 只写 `{kind:"event"}` 行）＋ `run-host.ts:529`（注释「header / footer 由 CLI 写」）＋ `run-host.ts:614`（`loadTraceOutcome` 读 footer）

**机理**：`FileTraceSink` 的格式契约是 header/event/footer 三种行（`apps/cli/src/trace/file-sink.ts:26-31`）；注释说 header/footer「由 CLI 写」，但**纯 Web 起跑、纯 Web 跑完的 Run 没有任何人写这两种行**。后果链：

- `loadTraceOutcome` 读的是 footer → 进程重启后 `detail()` 的 `outcome` 为 undefined → runbar 的 outcome chip、恢复视图的未完成项、`outcome.summary` 全部消失；
- 而 `LoopTerminated` 事件（就在同一个 trace 文件里）的 payload 明确带着 outcome——那是一个可以**如实转述**的事实（不违反不得绕过 #6），现在没被用上；
- Trace 视图的「段 N / commit / gitDirty」分组对 Web 段永远缺失。

**修法建议**：二选一——`drive()` 收尾时补写 footer 行（对齐 CLI 契约）；或 `detail()` 在 footer 缺席时从 `LoopTerminated` 事件转述 outcome，并把这条登记为事件流缺口的消费方式。

---

## 5. P3 问题（记录即可，可进存量清单）

| # | 位置 | 问题 |
|---|---|---|
| P3-1 | `run-host.ts:375`＋`app.js:925-929` | **历史 Run 的 SSE 重放包含 ModelStreamDelta**。缓冲区刻意排除 delta（`run-host.ts:520`），但 `eventsSince` 的 trace 文件回退路径里 delta 全在（`appendTrace` 全量落盘）。点开历史 Run（`selectRun` 固定 `since=0`）后，客户端把整场历史的 delta 逐条 `S.stream +=` 并**每条全量重渲一次时间线**，还会先闪一个写着全部历史正文的「正在输出」框。`loadTraceEvents` 按缓冲区同一条规则跳过 delta 即可对齐 |
| P3-2 | `run-host.ts:393`＋`run-host.ts:443` | `assertNoActiveRun` 是 check-then-act：`currentRunId` 到第一个事件才赋值，两个几乎同时的 `POST /api/runs` 理论上都能过闸。实际上 RunStarted 大概率同步 yield，窗口微秒级，但 §6.4 这条不变量目前靠时序而不是结构——一个同步置位的 `starting` 标志就够 |
| P3-3 | `run-host.ts:227-232` | 终态 Run 的预算轴数字随刷新增长：`detail()` 用 `clock.now()` 算 `totalWallClockMs`，Run 结束后每次刷新「总墙钟」都在涨，不再是任何时点的冻结事实。终态 Run 可以不显示这条轴，或改用事件时间 |
| P3-4 | `run-host.ts:315-321` | `artifactPath` 是纯词法判定，不查 realpath：workspace 内指向外部的符号链接可经 `/api/artifact` 越界读。`autoGrantVerdict` 走的是 `isInsideWorkspace` 的 realpath 判定——同一个「在 workspace 内」两处深度不一致 |
| P3-5 | `run-host.ts:209` | `getStatus() ?? "CREATED"` 是无中生有的状态兜底，与「转述事实」口径不合——宁可显式标「未知」 |
| P3-6 | `server.ts:66-69` | 兜底 catch 里 `sendJson` 会在响应头已发出时（SSE 中途出错）再抛，成为未处理的 rejection——Node 默认崩进程。加 `if (res.headersSent) return` 即可 |
| P3-7 | `verify/ui.ts:56-70` | 注入 canary 写进 `public/`，若进程被硬杀在 finally 之前，残留文件会让下一次 `verify:tools` 第 8 条变红——「可见地坏」可接受，但这是一个脚本对另一个脚本的隐式耦合，值得知道 |

---

## 6. 文档数字失准（不需要改代码，下次顺手更正）

1. **ADR-0009 两处过期**：「verify:ui（19 条判据全绿）」——实际 **20** 条（Roadmap §6.1 写对了）；「app.js 现在 700 行左右」——实际 **978** 行。后者值得写准：离 ADR 自己定的 1500 行重评触发线只剩 1.5 倍空间。
2. 其余回填（CLAUDE.md / README / Roadmap §6.1 / 存量清单 §0.12 / 架构设计 §27.1、§27.2、§28.5）与代码互相一致，包括「14 脚本 / 135 判据」「11 条（编号到 10）」、S4-1…S4-4 四条欠账、§0.12 的仪器缺陷与装饰判据记录，均逐项核对过。

---

## 7. 值得肯定的部分

- **`security.ts` 是这批最扎实的文件**：五条闸门的顺序（先 Host/Origin 后 Token，401 与 403 语义分明）、`timingSafeEqual`、拒绝 Cookie、CSP 与 `textContent` 并联两道、拒绝发 CORS 头——每条都带「为什么」。E 段「Host 正确时必须 200」的配对判据意识（拒绝一切的服务与正确的服务不可区分）尤其好。
- **`readBudgetAxes` 的设计干净**：billed 那一行的注释点名了「整张表里唯一字段名与读数不同名的地方」，`checkBudgets` 跑在同一张表上，C 段判据钉得住。
- **D2 段把装饰判据的判别力实测过程原样留在脚本里**（降级成 fact 而不是悄悄删掉）——这是本批最符合仓内纪律的动作。
- **`beginSegment` 换 AbortController** 的修复配了专门的第二段判据，挡住了一个「只在第二段出现、第一段全绿」的真实 bug。
- **「故意没有」系列注释**（`notifyDone`、`mergeTimeline`）记录了不做什么与为什么，能防止第二个人把已经想清楚的坑重新挖开。

---

## 8. 处置建议

- **P1-1 修掉**（十行以内）后即可提交；建议同时给「resume 被闸门拒绝」补一条 D3 段判据（resumable 夹具 ＋ 终态后再 resume → 断言 `liveInThisProcess` 恢复 false 且 `serviceError` 在场）。
- **P2-1 / P2-2 二选一**：修（各 ≤ 十行），或按仓内惯例登记为存量欠账（S4-5 / S4-6）并在 §0.12 追加。
- P3 各项建议随下批进存量清单；P3-1 与 P2-1 同修最省（都在 SSE 一条链路上）。
- ADR-0009 的两处数字下次触碰该文件时更正即可，不必为它单开一批。
