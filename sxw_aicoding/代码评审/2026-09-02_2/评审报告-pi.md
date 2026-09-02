# 代码评审：逐轮 LLM 调用原始请求/返回查看器（阶段 2 + 2.5）

- **评审日期**：2026-09-02
- **评审人**：pi（coding agent）
- **评审方式**：只读评审，未改动任何代码
- **评审范围**：工作区未提交改动（12 文件，+1248/−55），对应 `PLAN.md`（阶段 2：逐轮 LLM 调用审计查看器）与 `PLAN (1).md`（阶段 2.5：模型审计查看器刷新竞态修复）。写入侧（sidecar 持久化）已在上个提交 `6f82bfa` 落地，本次是读取与展示闭环。
- **涉及文件**：
  - `apps/workagent-service/src/api-types.ts`（DTO：`UiModelCall` / `UiModelFrame` / `UiModelInvocationAudit`）
  - `apps/workagent-service/src/projection.ts`（按 invocation 投影模型调用）
  - `apps/workagent-service/src/run-host.ts`（单次调用审计读取 + 归属证明）
  - `apps/workagent-service/src/server.ts`（`GET /api/runs/:runId/model-invocations/:invocationId`）
  - `apps/workagent-service/src/workspace-hosts.ts`（`modelAuditDir` 接线）
  - `apps/workagent-ui/public/app.js` / `app.css`（逐轮解剖内联查看器与竞态防护）
  - `apps/cli/src/verify/ui.ts`（G2 验收段，10 条新判据）
  - `README.md` / `CLAUDE.md` / 架构设计 V05 / 阶段 Roadmap（文档同步）

---

## 一、整体链路梳理（先核实再评审）

### 写入侧（`6f82bfa`，背景）

```text
run-loop.ts 每次模型调用
  └─ FailOpenModelInvocationAudit 包 ports.modelAudit（compose.ts:1019 接线）
       └─ FileModelInvocationAuditStore.open()  ← modelAuditDir（wx 独占, 0600, 目录 0700）
            → <modelAuditDir>/<runId>/<invocationId>.jsonl
              request(含完整 body) → response_metadata → provider_event×N
              → [provider_error] → invocation_end
同时 Trace 事件携带 invocationId：
  ContextFrameCompiled / ModelInvocationCompleted / RuntimeErrorOccurred(可选) / ModelInvocationAuditFailed
```

### 读取展示侧（本次 diff）

```text
① projection.ts  projectTurns()
     按 invocationId 建 UiModelCall：ContextFrameCompiled 即登记（失败/进行中调用不消失），
     completed 补 usage，RuntimeErrorOccurred 标 FAILED+runtimeErrors，AuditFailed 挂 auditFailure
② run-host.ts  modelInvocationAudit()
     ID 白名单 → getRunSpec → 事件轨道归属证明（防文件名 oracle）→ 严格 reader
     → request 身份校验（错配=CORRUPT+contentWithheld）→ DTO 映射
③ server.ts  GET /api/runs/:runId/model-invocations/:invocationId
     runId 形状闸 → invocationId 字符集闸（与 writer safeComponent 同字符集）→ no-store
④ app.js  逐轮解剖下每次调用一行 <details>
     展开才 fetch；缓存 runId:invocationId→entry；竞态防护四重提交条件；
     textContent-only；嵌套 details 懒格式化；派生上下文阅读视图
⑤ verify/ui.ts G2：10 条新判据（253→263，文档数字核对一致）
```

---

## 二、总体评价

**质量高，可以提交。** 三份 PLAN 的每条约束几乎都能在代码里找到落点，且验收有真实判别力。

评审时实际执行核对（均为只读操作）：

- `npm run typecheck` ✅ 通过
- `npm run verify:ui` ✅ **81/81 绿**（与 PLAN(1) 声明的 81 一致）
- `git diff --check` ✅ 干净
- `verify/ui.ts` verdict 计数 ✅ 81（另一处 `verdict(` 出现在注释中，非判据）

安全纵深是这个 diff 做得最好的部分。

---

## 三、逐一核实过、确认正确的关键点

1. **路径安全闭环**：`[^/]+` 捕获后 `decodeURIComponent`（编码斜杠→400）、字符集 `[A-Za-z0-9_-]+` 排除 `/ . \`、路径只能由三个白名单组件拼接。归属证明先于碰文件，接口不是文件名 oracle——`run-host.ts:629` 注释把理由讲透了。
2. **投影语义**：`callsByInvocation` 按 invocationId 全局去重，同轮重试天然分开；completed 事件按 sequence 排序必在下一个 TurnStarted 前，不会挂错轮；旧 Trace 缺 invocationId 时回退 sequence id 且不给读取入口（验收判据 6 覆盖）。
3. **竞态防护**：`modelAuditResponseCanCommit` 四条件（viewer 对象身份 + `S.runId` + map 身份 + revision）+ `finally` 双条件不清新 controller + abort 后不提交；验收 ①②③ 分别对应三条负向注入，且 ② 特意用「假 API 无视 AbortSignal」把防护逼到对象身份校验上——这是真判别力。
4. **细节正确性**：
   - `el()` 初始 `open` 属性可能排队 toggle 事件，但 handler 的 `status === "idle"` 守卫与同步置 loading 防止了双发请求；
   - `wx` 排他创建防止并发写同名文件；
   - workspace storage override 的 `modelAuditDir ?? defaultStorage.modelAuditDir` 保证 writer/reader 恒同目录；
   - 四态（COMPLETE/INCOMPLETE/CORRUPT/NOT_CAPTURED）经真实 HTTP 不失真，身份冲突只报损坏行号、不返回敏感前缀（验收判据 4 覆盖）。

---

## 四、问题清单（按严重程度，均不阻塞提交）

### 中

**M1. projection.ts `ModelInvocationAuditFailed` 分支缺 `typeof` 守卫**

`apps/workagent-service/src/projection.ts` 该分支直接 `String(ev.payload.invocationId)`，而相邻三个分支（`ContextFrameCompiled` / `ModelInvocationCompleted` / `RuntimeErrorOccurred`）都先验 `typeof === "string"`。事件来自盘上 JSONL，类型是 cast 出来的（`loadTraceEvents` 里 `as unknown as RunEvent`）。若某版本事件缺该字段，`String(undefined)` → `"undefined"`，会投影出一条 invocationId 为 `"undefined"` 的假调用行，UI 还会给出读取入口（点击后 404）。当前 Runtime 必填该字段、老 trace 无此事件，所以只是防御不一致，但正是其它三处都防了才显得这处是漏网。

**M2. 字符集白名单三处复制，长度约束不一致**

- `safeComponent`（`apps/cli/src/model-audit/file-store.ts:36`，writer 侧）
- `isSafeModelAuditId`（`apps/workagent-service/src/server.ts:645`，长度 ≤128）
- `SAFE_MODEL_AUDIT_ID`（`apps/workagent-service/src/run-host.ts:1384`，无长度限制）

字符集相同，但若未来 writer 放宽（例如 id 生成器引入 `.`），读路径三处要同步改，漏一处就是静默 400/读不到。建议收敛为单一导出常量（如从 model-audit 模块导出）——这符合本项目「闸门在分叉之前」的一贯立场。

**M3. 同步 I/O 阻塞事件循环**

`modelInvocationAudit` 里 `readModelInvocationAudit`（readFileSync + 逐行 JSON.parse，真实请求体可达数 MB）和 `eventsFor`（全量 trace 读盘合并）都在 async handler 的同步段执行，而服务同时承载 SSE 流——一次点击数 MB 解析会卡住所有连接的推送。本地单用户白盒可接受（`readJsonl` 既有同款模式），但值得在方法注释里记一笔这个取舍，避免后续有人在高频路径上复用。

### 低

**L1. 验收的 `new Function` 源码切片较脆**

verify/ui.ts 用 `indexOf("\nfunction bindModelAuditView(")` 到 `"\n\nfunction renderModelAuditPanel("` 切片注入。它隐含约束：这四个函数相邻、顺序固定、自由变量只有 `S`/`api`/`renderModelAuditPanel`。重排函数或引入第四个依赖（如 `toast`）会让 makeLifecycle 运行时炸或悄悄漏测。这是刻意的同步约束，但建议在 app.js 该区间加一行「此区间被 verify:ui 切片引用」注释，防止无意重排。

**L2. `createModelAuditUi(runId)` 的 runId 字段是死字段**

提交条件用的是 `S.runId === entry.runId`（entry 自带）与 viewer 对象身份比较，构造参数 runId 从未被读取。删掉或留对称均可，现状有轻微误导性。

**L3. 404 文案语义混用**

`modelInvocationAudit` 返回 `undefined` 有三种含义（run 不存在 / invocation 不属于 run），统一报「调用 X 不属于 Run Y」。故意不做存在性 oracle 是对的，但 run 不存在时该文案有误导（同 runId 的 detail 接口会报「找不到 Run」）。

**L4. Run 刷新后嵌套 `<details>` 折叠态丢失**

外层调用行的 open 由 `ui.expanded` 恢复，但「拼接上下文」「Provider 事件」等嵌套懒加载 details 每次重渲染都回到折叠。Run 运行中每次 SSE 刷新会把用户刚展开的 provider 事件合上。PLAN 未要求保留，列已知 UX 项即可。

**L5. `invocationIdOf` 四个 case 函数体完全相同**

`run-host.ts:1387` 可合并为一张事件类型表查一次，减少样板。

### 已知边界（PLAN 明确接受，评审确认实现一致）

- 内存缓存无上限：同 Run 内每个展开过的 invocation 全量 data 驻留至切 Run，大 Run 逐个点开可累积几十 MB——与「缓存只存在内存中」的声明一致。
- `--no-trace` 且已结束的 Run 无事件轨道，归属证明失败 → 404，符合「不扫描 sidecar 目录补造轮次」。
- INCOMPLETE 不自动轮询；`count_tokens`/EVAL 不采集；不承诺 wire-level 还原。

---

## 五、结论

改动忠实实现了两份 PLAN，安全边界（四道 ID 闸门、归属证明、身份冲突隐藏正文、no-store、textContent-only）与竞态收口（四重提交条件）是亮点，验收判据经负向注入验证过判别力、文档数字（263 总判据 / verify:ui 81）核对无误。

建议在后续小提交处理 **M1**（一行守卫）与 **M2**（常量收敛），其余按优先级排入已知项。
