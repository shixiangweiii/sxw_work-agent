# Trace、Run 界面与预算展示优化 · 代码评审报告

> 评审日期：2026-09-02  
> 评审对象：提交 `23fbfd1`（支持最大轮数自定义）、`233abdb`（优化界面展示）、`1a2e733`（Trace 优化）  
> 评审依据：改动说明文档《20260902_Trace界面与预算展示优化改动说明.md》（`sxw_aicoding/temp/`）  
> 评审方式：仅评审，未修改任何生产代码  
> 评审基线：`npm run typecheck` ✓；`npm run verify:budget` 12/12 ✓；`npm run verify:ui` 67/67 ✓（与改动说明 §9.1 声明一致）

---

## 1. 评审范围与覆盖文件

| 层 | 文件 | 本批改动内容 |
|---|---|---|
| Runtime | `packages/harness-runtime/src/budget/index.ts` | 预算轴单表（`readBudgetAxes`）、`readBudgetLimits`、`applyBudgetOverrides` |
| CLI | `apps/cli/src/compose.ts`、`apps/cli/src/main.ts` | `BUDGET_FLAG_BY_AXIS` 参数表、三层合并、RunSpec 冻结、resume 提示 |
| Service | `apps/workagent-service/src/main.ts`、`api-types.ts`、`run-host.ts`、`server.ts` | 启动档参数、`budgetDefaults` / `budgetAxes` 投影、`POST /api/runs` 预校验 |
| UI | `apps/workagent-ui/public/index.html`、`app.js`、`app.css` | 预算表单、Outcome 中文映射、核心预算摘要、顶栏布局、Trace 双模式检查器 |
| 验收 | `apps/cli/src/verify/budget.ts`、`verify/ui.ts` | 预算链路 G1–G4 段、UI 验收 L / M / N 段 |

边界核对：三个提交均未触碰 Run Loop、Outcome 结算语义、Trace JSONL 格式、SQLite 表结构与 `/api/runs/:runId/trace` 接口；`apps/workagent-ui/public/` 保持零 import、零构建步骤、textContent-only、CSSOM 而非内联 style 属性。与改动说明 §10「没有改动的边界」声明一致。

## 2. 总体评价

这是一批质量很高的改动。三条主线共同遵守了文档声明的核心原则——Runtime 是唯一判官，UI 只做投影。以下设计决策值得肯定：

1. **预算轴单表**（`readBudgetAxes`）：`axis → field → used → limit` 只存在一份，`checkBudgets` 自己也跑在它上面；`BudgetAxisReading.field` 强制住在表里，杜绝了 CLI / HTTP / UI 三处各抄一份映射的经典漂移。
2. **fail-fast 与静默回落分立**（`applyBudgetOverrides`）：缺字段 = 用默认（真话），非法值 = 报错（用户说了听不懂的话），未知轴报错并列出合法值。与 ADR-0012 P2-2 口径一致。
3. **参数表穷举**：`Record<BudgetAxis, string | null>` 让新增预算轴漏入口时编译期报错；`BUDGET_VALUE_FLAGS` 单一来源供两个入口的 `VALUE_FLAGS` 展开。
4. **预校验排位正确**：`POST /api/runs` 的预算校验在 `claimForeground()` 之前，非法值 400 且不留状态残留（verify:ui L2 有专门判据钉住这一点）。
5. **终态预算读数冻结**：`run-host.detail()` 对终态 Run 把 `budgetNow` 冻在最后一条事实时刻，避免「三天后打开显示总墙钟 3 天」。
6. **验收判据有真实失败模式**：L 段成对正反分支（少了正分支「一律 400」全绿，少了反分支「字段没接线」全绿）、G2 端到端无覆盖链路、N 段直接执行 `app.js` 里的真实纯函数而非验收内重写一份。符合 AGENTS.md「每个断言要有区分度」的要求。
7. **文档准确性**：改动说明的文件矩阵、数据流图、已知限制与代码实际逐条对得上；`1a2e733` 混入的 MCP registry 修正已在文档中声明不展开，无隐瞒。

结论：**通过，无阻塞问题**。以下问题按严重程度排列，均不阻塞合入。

## 3. 问题清单

### 中-1：运行中的 Run 会打断 Trace 页的搜索输入

**位置**：`apps/workagent-ui/public/app.js` — `refresh()`（约 2338 行）、`renderView()`（约 638 行）、`renderTrace()`（约 1907 行）。

**现象**：`refresh()` 尾部无条件调用 `renderView()`，而 `renderView()` 先 `clear(view)` 再整页重建，包括 `renderTrace()` 新造的搜索框。SSE 每个非流式业务事件（ContextFrameCompiled、AttemptStarted……）都触发 350ms 去抖的 `refresh()`。于是：**Run 正在跑 + 用户正在 Trace 搜索框打字时，每个业务事件到达都会销毁并重建输入框**——文字虽经 `ui.query` 恢复，但焦点、光标位置丢失，中文输入法的 composition 过程被打断。分类筛选按钮与轮次展开后的滚动位置同理。

**定性**：用户可直接感知的 UX 缺陷。改动说明 §11 已登记「无增量分页/虚拟列表」，但焦点保持是另一个独立缺口，未登记。

**建议方向**：`renderTrace` 内部做局部 repaint（只重建 `content` 容器，工具栏与输入框保活）；或 `refresh()` 时若 `document.activeElement` 位于 trace 工具栏内则推迟重绘。

### 中-2：预算预校验的 base 与真正合并的 base 不是同一份

**位置**：`apps/workagent-service/src/server.ts`（约 411 行，`applyBudgetOverrides(DEFAULT_BUDGETS, budgets)`）vs `apps/cli/src/compose.ts` `makeRunSpec()`（`applyBudgetOverrides(startupBudgets, budgetOverrides ?? {})`）。

**现象**：预校验用 `DEFAULT_BUDGETS` 试算，真正生效的一跳用 `startupBudgets`。注释断言「用的是同一个 `applyBudgetOverrides`，所以两次判定不可能分叉」——**当前**成立（未知轴集合与数值校验都不读 base 的值），但该断言依赖「`applyBudgetOverrides` 的报错行为与 base 无关」这一实现细节。将来若加入任何 base 相关校验（例如「覆盖值不得低于当前值的一半」），预校验会漏放，回到它要防的形态：以一个已经跑起来的 Run + 500 返回。

**同根症状**：`run-host.ts` `info()`（约 381 行）为读启动档预算构造假 RunSpec——`this.composed.makeRunSpec("(预算探针)")`，只为取 `.budgets`。`RandomIdGenerator` 无全局计数副作用，目前无害，但每次 `/api/state`（即每次去抖刷新）都做一轮完整冻结（profile、workspace、budgets 拷贝），且「造了一个会被误读为真的假事实」正是本仓反复猎杀的模式的温和版。

**建议**（后续批即可）：`Composed` 直接暴露只读 `startupBudgets`，server 预校验与 `info()` 两处同时变干净，本条两个症状一起关掉。

### 低-1：UI 硬编码 0.8 软限阈值，`softLimitRatio` 未投影

**位置**：`app.js` — `coreBudgetPresentation()` 与 `renderBudget()` 各有一处 `ratio >= 0.8 ? "soft" : ...`。

**现象**：Runtime 侧这是 `RunBudgets.softLimitRatio`（可配置字段，`checkBudgets` 逐 Run 读它），但 `budgetAxes` 没带该值，UI 拿不到，只能抄常量。当前所有 Run 的 ratio 都是默认 0.8，显示不会错；但这是与本批自己立下的「UI 只解释已有事实」原则的轻微背离。

**建议**：后续给 `UiRunDetail` 带上 frozen `softLimitRatio`，前端两处改为读值。

### 低-2：未知 Trace 行的统计口径在页面上无法自洽

**位置**：`app.js` — `buildTracePresentation()`（`stats.unknownLines`）、`renderTrace()` 统计 chips、`renderTraceTurns()` 段级显示条件。

**现象**：
1. `stats.unknownLines` 有统计但顶部 chips 只展示五项（业务事件/流式增量/轮次/执行段/原始行），hint 文案也只解释 header/footer。当 `readJsonl` 产出非 event/header/footer 行时，「业务事件 + 流式增量 + 边界 = 原始行」的等式悄然不成立，页面上没有任何数字能解释差额（要去原始模式自己数）。
2. 逐轮检查器模式下 `segment.unknownLines` 完全不渲染（只有原始事件模式渲染），而 `renderTraceTurns` 的段显示条件又引用了 `segment.unknownLines.length`——条件里出现了一个不会被渲染的事实。

**建议**：chips 补一项「未知行」（为 0 时不显示）；或在逐轮段卡里给未知行一个折叠入口。注意这与改动说明 §5.3 第 7 条「未识别事件……必须保留原始内容」并不冲突（未识别 **type** 的 event 在逐轮模式走「其他事件」分组，已覆盖），缺口仅在未识别 **kind** 的行。

### 低-3：`UiBudgetDefault.field` 是宣称「界面只用来显示」但界面没显示的字段

**位置**：`apps/workagent-service/src/api-types.ts`（约 366 行）与 `app.js` `renderBudgetFields()`。

**现象**：注释说 field「界面只用来显示」，但 `renderBudgetFields()` 只消费 axis / unit / limit，field 的唯一消费者是 `verify:ui` L4。要么让预算 Tab 顺带显示字段名（它本来就是给人核对 RunSpec 的锚点），要么把注释改为「当前仅供验收核对」。

### 低-4：`renderTraceSegmentHeader` 与 `renderTraceBoundary` 重复实现 header chips

**位置**：`app.js`（约 1643 行与 1819 行）。

**现象**：两处各自拼 entry / modelId / executionPrivilege / commit / gitDirty 五件套。将来 header 加一个字段，一处改了另一处没改，逐轮模式与原始模式会给出不同的段头——又一个「两处对同一事实给出不同答案」。建议抽一个 `traceHeaderChips(line)` 共用。

### Nit（不要求处理，仅记录）

1. `applyBudgetOverrides` 对字符串走 `Number(raw.trim())`：`"0x10"`→16、`"1e2"`→100 会被接受，值与用户字面预期不同。CLI 入口几乎不会这么传。
2. 预算表单 `type=number step="1"`：毫秒轴按秒展示，用户想填 0.5 秒（→500ms）时浏览器给伪验证黄框（值仍能读取），与「秒」展示单位有轻微摩擦。
3. Trace 搜索 `input` 事件无防抖即全量重建 content（与中-1 同根；209 行示例无感，数千事件时会卡）。
4. `verify:ui` M 段给被测函数注入的 `AXIS_LABEL` 是验收里手写的 4 条副本而非从 `app.js` 抓取——判据恰好不检查 label 字段，无实害，但与 L3 / N 段「测真实函数」的自我要求有细微不一致。
5. `23fbfd1` 把 `sxw_aicoding/实际测试案例/ata_download2/image_urls.txt`（32 行 URL 清单）提交进仓库。目录定位是设计证据，可接受，但 temp 性质夹具建议后续清理，避免成为惯例。

## 4. 已知限制的补充确认

对改动说明 §11 已登记限制的独立核对，均属实且与代码一致：

- Trace 每次业务事件刷新读取整份文件（`traceLines()` 无缓存增量），默认隐藏流式增量确实显著降低了 DOM 量（`traceEventMatches` 对 `ModelStreamDelta` 先行短路）。
- `maxTotalWallClockMs` 默认留空语义被 `verify:budget` G4 专门钉住（「开了参数 ≠ 有默认值」），`BUDGET_FLAG_BY_AXIS` 处的注释也明确区分了这两件事。
- artifact 与 action 不建推断关系：`finalizeTraceTurn` 中 `artifacts` 与 `actions` 分别按各自 id 聚合，verify:ui N2 有「act_one 不含 Artifact 事件」判据。
- 异步防旧请求：`renderTrace` 返回后核对 `S.runId` / `S.tab` / `body.isConnected`，防护正确。

## 5. 结论与建议跟进顺序

| 优先级 | 事项 | 对应条目 |
|---|---|---|
| 1 | Trace 搜索焦点保持（局部 repaint） | 中-1 |
| 2 | `Composed.startupBudgets` 只读暴露，统一预校验与 `info()` 的 base | 中-2 |
| 3 | `softLimitRatio` 随 RunSpec 投影到 UI，替换硬编码 0.8 | 低-1 |
| 4 | 未知行统计 chip + 逐轮模式可见性；`field` 字段去留；段头 chips 去重 | 低-2 / 低-3 / 低-4 |

三项「低」可合并为一个收尾批处理。所有建议均不改变既有 RunSpec / Trace / HTTP 契约，属展示层与服务端投影层内部收敛。

---

*评审执行记录：基线命令于 2026-09-02 在仓库根目录实际运行（typecheck、verify:budget、verify:ui），全部通过；问题清单中的行号为评审当日 `main` 分支位置，仅供定位参考。*
