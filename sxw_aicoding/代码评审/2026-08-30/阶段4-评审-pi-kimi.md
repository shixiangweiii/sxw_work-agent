# 阶段 4 代码评审（pi · kimi）

> 日期：2026-08-30
> 评审对象：阶段 4 产品化半边全部未提交变更（git status：新增 `apps/workagent-service/` 8 文件、`apps/workagent-ui/` 4 文件、`verify/boundaries.ts` 217 行、`verify/ui.ts` 664 行；修改 `compose.ts` / `main.ts` / `verify/tools.ts` / `budget/index.ts` / `package.json` / README / CLAUDE.md；文档回填 Roadmap §6、V05 §27.1/27.2/28.5、存量清单 §0.12、ADR-0009、阶段 4 实施方案）
> 依据：`阶段4实施方案_V20260830.md`、`存量问题清单_V20260824.md` §0.12、`WorkAgent阶段Roadmap_V20260823.md` §6
> 评审方式：全量源码与 diff 阅读 ＋ 独立复跑 `typecheck` / `verify:tools` / `verify:ui` ＋ 对疑点做行级实测核对（grep 真实命中、双轨 sequence 来源、多段 trace 读取路径）。
> 评审期间未改动任何仓库文件。

---

## 〇、结论摘要

| 维度 | 结论 |
|---|---|
| 架构骨架 | **成立**。决 5 双轨合并（只有 D-2 统一序列能对齐两条轨道）经实测数字坐实；决 6「投影不修正事实，它转述事实」在代码里落地干净；三个 Port 注入点一字未改即接上浏览器 —— 阶段 4 研究问题的判别力是真的 |
| 独立复跑 | `typecheck` 干净；`verify:tools` **14/14**；`verify:ui` **20/20**（本机 darwin） |
| Runtime Core 改动 | 仅 `readBudgetAxes` 提取一处，且 `checkBudgets` 跑在同一张表上 —— 「唯一的判官」成立，§5.2 未松动 |
| 报告改动 vs 实际 diff | 数字一致（14 脚本 / 135 判据 / verify:ui 20 判据 / 边界 11 条编号到 10），一处例外见 L2 |
| 确认的问题 | **中 1（F1）＋ 低 3（F2、F3、L1）＋ 打磨 2（L2、L3）** |

**提交前建议处理（2 条，均为一行小改）：** L1、L2（交叉引用与数字失修）。
**本阶段内登记即可：** F1、F2、F3、L3。

---

## 一、中严重度

### F1【中】跨段 trace 文件会让历史 Run 的事件被读入两遍——「两个入口写同一文件」的刻意设计缺了去重那一半

`run-host.ts` 的 `appendTrace` 注释写明并论证了「**两个入口写同一个文件是刻意的**」（CLI 跑段 1、崩了、界面 resume 段 2，两段接进同一 JSONL）。但读取侧 `loadTraceEvents()`（`run-host.ts:601-611`）把文件里**所有** `kind:"event"` 行原样读回，不过滤、不去重：

- **触发路径**：CLI 跑段 1（事件 1..57 已落文件）→ 界面 resume 段 2。界面进程里 `LiveRun.events` 只缓冲**本段**新事件；`onEvent` 对每个新事件再 `appendTrace` 一行。段 2 跑完后文件 = 段 1 的 57 行 ＋ 段 2 的 57 行 = 114 行。
- **当下不炸**是因为 `detail()` 的取值优先级是「本进程缓冲 > trace 文件」（`live?.events.length ? live.events : loadTraceEvents(...)`，`run-host.ts:191-193`），resume 这一段的界面读的是缓冲，正常。
- **会炸的路径**：服务**重启之后**再打开这个 Run 的历史。新进程 `LiveRun` 为空 → `live.events.length === 0` → 走 trace 分支 → `loadTraceEvents` 读回 **114 条**，其中段 1 的 57 条与段 2 的 57 条 sequence 重叠（段 2 从 57 继续编号，但段 1 的 1..57 与文件里段 2 追加的同段事件并不重叠；真正的重叠发生在「同一进程 resume 后、再重启服务、文件被整读」以及「同一文件被多个段各写一遍公共前缀」的场景）。`projectTimeline` 的 `out` 按 id 覆盖兜住了大部分幂等，但：
  - `tracks.events`（`run-host.ts:276`）数字虚高；
  - `eventsSince` 的 trace 分支（`run-host.ts:375`）会给 SSE 重连客户端重放重复事件；
  - **F 段「不重不漏」判据（`verify/ui.ts`）只覆盖了单进程缓冲路径，没有覆盖「读多段 trace 文件」这条路径** —— 它是 `since` 游标正确性唯一真正可能被破坏的地方。

注释里 N-1 的教训（「一个 Run 跨三个进程变成三份互不相干的记录」）说的是**写入侧**要接得上；本发现是**读取侧**没做对应的合并。这不是反对「写同一文件」，是说那一半设计还差一个去重。

**建议（二选一，或先登记）：** ① `loadTraceEvents` 按 `sequence` 去重（保序取首见）；② 登记存量清单 S4-5，并在 F 段补一条「多段 trace 文件读取去重」的判据。倾向 ①，成本一行。

---

## 二、低严重度

### F2【低】`loadTraceOutcome` 只认 footer，与「两个入口写同一文件」存在读取不对称——纯 Web 段的历史 Run 取不到 outcome

`detail()` 的 outcome 来源：`live?.outcome ?? loadTraceOutcome(traceFile)`（`run-host.ts:200`）。`loadTraceOutcome`（`run-host.ts:614-622`）只读 `kind:"footer"` 行。footer 只有 CLI 的 `FileTraceSink` 写；Web 入口的 `appendTrace` 只写 event 行。

于是「**纯 Web 入口跑完、进程已退出**」的 Run，重开服务后 `outcome` 取不到（尽管盘上 status 是 COMPLETED、`LoopTerminated` 事件也在文件里）。界面上 outcome chip 不显示，其余正常 —— 属于**如实降级**，且 README 已说明 CLI 段才有 header/footer。但「两个入口写同一文件」这条【定】在 outcome 这个字段上并没有兑现，注释也没说破这一层。

**建议：** 在 `loadTraceOutcome` 注释补一句「纯 Web 段的 Run 没有 footer，outcome 靠 status + LoopTerminated 如实降级，这是已知且刻意的」；或从 `LoopTerminated` 事件的 payload 反填 outcome（`projection.ts` 的 `asNotice` 已经在解析这个 payload）。只改注释即可接受。

### F3【低】审批等待没有跨 Run 的全局可见信号——单 Run 视图内链路完整，视图外靠刷新兜底

`connectSSE` 里审批到达靠 `event: pending` 推给**当前选中该 Run** 的客户端；`renderPending` 只渲染 `S.pending`（当前 Run 的等待）。若用户停在别的 Run 或首屏，审批卡片要等下一次 `refresh()` 才出现（审批本身是 RunEvent，通常会触发 350ms 去抖刷新，链路实际可达 —— D 段验证了 HTTP 应答）。

阶段 4「明确不做多客户端 / 通知」的范围内**可接受**，但「有一个 Run 在等人」这件事在界面上没有跨 Run 的常驻角标。建议记入「下一个人会问」清单，不必本批做。

---

## 三、打磨项（提交前顺手改，一行一处）

### L1【极低·文档】`projection.ts:78` 交叉引用失修——「§0.11」应为「§0.12」

```
界面会把插话显示成系统提示。**如实降级，不猜** —— 缺口登记在 §0.11。
```

存量清单里该缺口（S4-3：transcript 分不开「用户插话」与「系统提示」）登记在 **§0.12**；§0.11 是「考卷 V1 快速回归评测」那一节。改一个数字。

### L2【极低·文档】存量清单 §0.12 两处写「比 **19** 条绿判据有价值」——实际合计 **20** 条

`存量问题清单_V20260824.md:749`「它比 19 条绿判据有价值」。`verify:ui` 判据合计 **20 条**（复跑输出末行「判据合计 20 条：20 ✓」），Roadmap §6 与 CLAUDE.md 写的也是 20。同一节内数字不一致——这正是 ADR-0008 自己警告过的形态（一处改了、另一处没跟上）。

### L3【极低】F 段判据文案与覆盖面的落差已存在但未登记

F 段第二条判据文案「重连游标是 transcript sequence（D-2 那条统一序列）—— 一个数字同时定位两条轨道」，实际断言行是 `tail.every(s => s > mid)`——它验证的是「游标过滤正确」，不是「两条轨道被同一个数字定位」。后者在 C 段（双轨合并）已被覆盖，所以**功能上不缺判据**，只是这一条文案读起来像是在测 D-2 本身。与 F1 一并登记即可，不必改文案。

---

## 四、正面确认（评审后依然成立，值得保持）

1. **决 5 的双轨合并有真实判别力**。C 段两个实测数字（只喂事件流 → 3 条工具活动**有入参 0 条**；只喂 transcript → **0 轮**解剖）把 D-2 从「阶段 2 的洁癖」变成「这个界面的开工前提」。`projection.ts` 只做合并与转述、不做推算，每条投影都带 `source.track + sequence`，C 段「序号真实存在于某条轨道」判据成立。
2. **E-3 形状的 bug 在第二段被抓住并修掉**（`aborterFor` 复用已 abort 的 controller → resume 后审批闸门死亡）。`beginSegment` 每段换新 controller、事件缓冲不清，D2 段专门跑「取消 → resume → 再要审批」；且注入了实测验证第一条判据能红、**当场拆掉第二条装饰判据**（「结算不是 USER_REJECTED」在本夹具下不可能为假，降级为 fact 并把过程留在脚本里）。这是 AGENTS.md「绿色断言必须能失败」的教科书执行。
3. **仪器缺陷被记录为头等公民**：fetch 静默丢 `Host` 头 → 改裸 socket ＋ 补配对判据「Host 正确必须 200」。「代码是对的，仪器是坏的」这条记录比它修掉的问题更值钱；E 段四道闸门（无/错 token 401、跨 Origin 403、非 loopback Host 403）＋ 真 .env key 扫响应体，全部独立复核通过。
4. **决 6 在代码里落地干净**：`liveInThisProcess` 与盘上状态分开展示、`serviceError` 原文透传不翻译成 outcome.kind、`verified` 三态（undefined ≠ false）、工具外置 / 恢复分支如实标注、artifact 预览截断要说出。边界 9（Layer 2 不推进执行语义）真实命中复核为零。
5. **安全层比 §22.6 原文多做一条且理由正确**：Host loopback 字面量挡 DNS rebinding；token `timingSafeEqual` 定长比较；明确拒绝 Cookie（CSRF 载体）；静态壳公开的理由链（首屏鉴权翻车实测）完整留在注释里。边界 8 / 10 真实命中复核为零，`app.js` 全文 `textContent` 渲染。
6. **`readBudgetAxes` 的提取方式正确**：`checkBudgets` 跑在同一张表上（唯一判官），`inputTokens` 轴读 `billedInputTokens` 那一行带【定】注释钉死（1482% 假漂移的同族坑），C 段判据断言该轴 used 等于 `budgetUsage.billedInputTokens`。

---

## 五、处置优先级（最终）

**提交前顺手改（2 条，一行一处）：**

1. **L1**——`projection.ts:78` 的「§0.11」改「§0.12」；
2. **L2**——存量清单 §0.12 的「19 条」改「20 条」。

**本阶段内登记 / 小改（4 条）：**

3. **F1**——`loadTraceEvents` 按 sequence 去重（或登记 S4-5 ＋ F 段补多段文件判据）；
4. **F2**——`loadTraceOutcome` 注释补「纯 Web 段无 footer 的如实降级」；
5. **F3**——「有 Run 在等人」跨 Run 可见性，记入待问清单；
6. **L3**——与 F1 一并登记。

整体 **GO（可提交）**。

---

## 附：评审方法与可复现证据

- 通读全部新增 / 修改源码与 diff（service 8 文件、ui 4 文件、verify 两文件、compose/main/budget 三处 diff、四份文档回填）。
- 独立复跑：`npm run typecheck`（干净）；`npm run verify:tools`（末行「判据合计 14 条：14 ✓」）；`npm run verify:ui`（末行「判据合计 20 条：20 ✓」，D2 / E / F 段逐项绿）。
- 行级实测：边界 9 模式在 `apps/workagent-service/src` 的真实命中为零（仅注释）；边界 10 在 `apps/workagent-ui/public` 的真实命中为零（`app.js` 全 `textContent`）；`ModelStreamDelta` 的 sequence 确认走 transcript 统一取号（`run-loop.ts:627` 经 `emit` → `nextSequence`），SSE 游标与 transcript 同源成立。
- 未改动任何仓库文件。
