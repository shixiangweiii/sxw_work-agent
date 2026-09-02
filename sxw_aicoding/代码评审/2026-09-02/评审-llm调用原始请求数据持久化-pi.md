# 评审：LLM 调用级原始请求与返回审计（第一阶段：调用级采集与持久化）

- **评审对象**：工作区未提交改动（基线 `fb4cab1 trace显示代码优化`），对应《第一阶段：LLM 调用级原始请求与返回审计（二次修订）》（PLAN）
- **评审日期**：2026-09-02
- **评审方式**：只读源码走查 ＋ 计划逐条核对 ＋ 本地取证运行；**未修改任何代码**
- **取证命令与结果**：
  - `npm run typecheck` ✓
  - `npm run verify:model-audit`：15/15 ✓
  - `npm run verify:tools`：16/16 ✓
  - `npm run verify:ui`：70/70 ✓

---

## 一、评审范围

| 文件 | 角色 |
|---|---|
| `packages/harness-runtime/src/types/model-audit.ts`（新增） | 跨层契约：Start / End / Observer / Writer / Reader 四态 |
| `packages/harness-runtime/src/loop/model-audit.ts`（新增） | `FailOpenModelInvocationAudit` fail-open 包装器 |
| `packages/harness-runtime/src/loop/run-loop.ts` | 审计接线、既有事件扩充、全出口收尾 |
| `packages/harness-runtime/src/ports/index.ts` | `ModelPort.invoke` 增加 observer 参数；新增 `ModelInvocationAuditStorePort` |
| `adapters/shape-anthropic-messages/src/client.ts` | `withResponse()` 取状态/request-id；原始事件先转发再归一化；`providerFailureOf` |
| `apps/cli/src/model-audit/file-store.ts`（新增） | 文件实现（0700/0600、`wx` 独占）＋ 四态 reader |
| `apps/cli/src/verify/model-audit.ts` ＋ `verify/workers/model-audit-crash.ts`（新增） | 15 条判据验收（真 SIGKILL 夹具） |
| `tools/common/src/fs/read-guard.ts` | `.workagent` 进读黑名单 |
| 其余 | compose 装配（`modelAuditDir`、`portOverrides.modelAudit`）、render / projection / UI 展示诊断事件、AGENTS/README/V05 §19.4 文档、`verify:all` 注册 |

## 二、与 PLAN 的符合度

逐条核对，绝大部分承诺已落地且被验收钉住：

- **调用身份**：复用 `frame.invocationId`，没有第二套调用 ID；`ContextFrameCompiled`＋`frameId/invocationId`、`ModelInvocationCompleted`＋`invocationId`、`RuntimeErrorOccurred`＋可选 `invocationId`——只扩字段不加行，与计划一致（A 段验证 sidecar 文件名后缀与事件里的 invocationId 同源）。
- **采集链路**：
  - `request.body` 在 `buildRequest` 之后、`invoke` 之前同步序列化落盘——崩溃前缀保证从第一行就成立；
  - 适配器「先 `observer.providerEvent(ev)`，再做自己的归一化」顺序正确，Provider-only 字段（`audit_raw_canary`）实测完整保留；
  - `count_tokens` 与 EVAL 不采集（B 段判据有判别力：count 实际发生过 ≥1 次而 sidecar 只有 1 份；`evalFiles.length === 0`）。
- **持久化与故障语义**：路径 `<ws>/.workagent/model-invocations/<runId>/<invocationId>.jsonl`、六类记录顺序（request → response_metadata → provider_event×N → [provider_error] → invocation_end）、每条记录 `schemaVersion: 1`、`wx` 独占创建、0700/0600 权限、四态 reader（COMPLETE / INCOMPLETE / CORRUPT / NOT_CAPTURED，含真 SIGKILL 前缀判 INCOMPLETE）全部落实。
- **fail-open**：`FailOpenModelInvocationAudit` 首败即停（`writer = undefined`）＋ `takeFailure()` 单次消费去重；F 段验证「provider_event 写失败 → 恰好一条 `ModelInvocationAuditFailed`、模型调用照常、Run 结算 SUCCESS」。
- **边界**：文件实现放在 `apps/cli`（Composition Root），Runtime 只认 Port；无 SDK / 工具越界（`verify:tools` 绿）；`/api/runs/:runId/trace` 未动，service 无任何读 sidecar 的路由；`.gitignore` 已覆盖 `.workagent/`。

另外，`client.ts` 新增的「迭代结束后再对一次 `signal.aborted`」是对一个真实潜在缺陷的修复——SDK 在 abort 时可能让迭代器**正常结束**而非抛 AbortError，半截流会被误报成 COMPLETED。E 段（用户取消 / 预算 deadline）覆盖了它。这是一处超出计划文本但方向正确的改动。

## 三、发现的问题

### P1（验收缺口）：verify:ui 未按计划补两条判据

计划「验收方案」明确要求扩充 `verify:ui`：

1. **正常调用不会增加主 Trace 行数**；
2. **`/trace` 中不存在请求和响应 canary**。

实际只加强了「未知行」判据（`kinds.every(header|event|footer)`，`apps/cli/src/verify/ui.ts:1124`）。canary 检查只存在于 `verify:model-audit` A 段，且比对对象是 `CollectingTraceSink` 的内存事件——**不是 `/api/runs/:runId/trace` 的 HTTP 响应，也不是 `FileTraceSink` 落盘的 JSONL**。「行数不增」这条则完全没有判据。

结构上目前确实不会混入（trace 只收 `RunEvent`，本批新增的只有 id / 数值字段），但按本仓「绿灯判据必须能翻红」的纪律，这两条属于**计划声明了、验收没交付**的项。建议：补判据，或在计划收口时显式修订验收口径并记录理由。

### P2（行为面扩大）：read-guard 挡掉整个 `.workagent/`

`tools/common/src/fs/read-guard.ts` 把 `.workagent` 加入 `DENIED_SEGMENTS`，理由（防审计内容回灌上下文、上下文自引用膨胀）成立，且会自动翻译进 `run_shell` 的 sandbox deny 规则。但它同时挡掉了 `<ws>/.workagent/runs/` 的 **trace JSONL** 与 `runs.db`——这些在此前是模型可读的。

这是一个超出审计计划范围的工具面收紧：类似「让模型总结上一个 Run 的 trace」的任务会从可行变为被拒。收紧方向大概率是对的（与既有的 `.workagent-state` 对齐），但属于应当显式拍板并记录的行为变更，目前只藏在 read-guard 的注释里。建议至少在提交说明 / ADR 里点明「模型从此读不到自己的 trace 与库文件」这一后果。

### P3（性能权衡，记录即可）：流式热路径上逐事件同步写

`FileModelInvocationAuditWriter.providerEvent` 对每条 SSE 做一次 `JSON.stringify` ＋ `writeSync`；`run-loop` 的流循环里每个 chunk 还多一次 `await auditFailureEvent()`（`takeFailure` 短路，开销可忽略）。

同步写是崩溃前缀保证的正确选择（SIGKILL 不丢内核已收的字节），且最大的单次开销（完整 request）每次调用只写一次；但长回复（数百事件）会把延迟串到事件循环上，而 service 同时还承载 UI SSE。第一阶段可接受，建议第二阶段做 UI 懒加载时顺手量化一次（事件数 × 单事件字节的分布）。

### P3（健壮性边角）：审计 fd 的生命周期挂在 generator 推进上

审计 writer 依赖「本次调用的所有出口都 `finish()` / `closeIncomplete()`」这一约定闭合。当前 facade 与 run-host 都会把 generator 驱动到 done，正常路径无泄漏。但若将来有人**抛弃**一个悬在模型调用中的 runLoop generator（不驱动到完成也不 `return()`），fd 会一直开到进程退出——这是之前 trace（emit 即忘）不具备的新形态。建议在 `FailOpenModelInvocationAudit` 或 run-loop 的注释里把「调用方必须把 generator 驱动到 done」这条约定写明。

### P3（权限细节）：中间目录不是私有权限

`workspaceStorage` 的 `.workagent/` 由 `mkdirSync(dirname(dbPath))` 以默认 mode 创建（可能 0755），审计只保证自己创建的 `<runId>` 目录 0700、文件 0600。由于所有敏感内容都被 runId 目录包住，保密性实际成立，只是「目录使用私有权限」这句承诺对**中间目录**不严格成立。验收判据也只查了 runId 目录与文件两级。

### P3（流程项）：负向注入实验无留档

AGENTS.md 要求对「漏转发 Provider 事件」「审计写失败被静默吞掉」各做一次翻红实验。两条判据本身都有判别力：

- A 段 `JSON.stringify(providerRecords.map(r => r.event)) === JSON.stringify(provider.eventsByMessage[0])`——适配器漏转发任一条事件即红；
- F 段 `auditFailures.length === 1 && stage === "PROVIDER_EVENT"`——警告被吞掉（0 条）或重复（≥2 条）或 stage 错标即红。

但仓库里没有红→绿实验的记录。提交前建议把证据落到 `评测/` 或提交说明，与 2026-08-28 收口批的做法对齐。

## 四、其他观察（不构成问题）

- `providerFailureOf` 对 SDK `APIError` 的 `status / requestID / error` 映射与实测一致（C 段 429 证据完整：原始 errorBody ＋ Runtime 归类的 `MODEL_RATE_LIMIT` 同文件共存）；abort 不记 `provider_failure`、以 `INTERRUPTED` 收尾，与计划一致。
- `ModelInvocationCompleted.durationMs` 从 `now() - startedAt` 改为 `invocationFinishedAt - startedAt`，语义更准（不含审计收尾耗时），无消费者受损。
- `eval/suite` 走 `makeRunSpec(ARCHIVE_TASK, "EVAL")`，EVAL 排除自动生效；resume 读冻结 RunSpec，EVAL 排除跨段一致。
- DEADLINE 抛 AbortError 的 catch 分支里 `audit.finish` 不带 result，与 `ModelInvocationAuditEnd` 注释「某些 ModelPort 在 deadline 时会抛 AbortError，此时没有可用的归一化结果」一致。
- 文档同步质量好：V05 §19.4、README、AGENTS、UI 三层（render / projection / app.js）都补了；`.DS_Store` 在未跟踪列表里，注意不要一起提交。

## 五、结论

**实现与计划高度一致，架构落点干净**——Port 定义在 Runtime、文件实现归 Composition Root、fail-open 语义完整、四态 reader 诚实；两条核心不变量（「审计故障不得改变 Run 结果」「完整请求与原始流不得污染主 Trace」）都有可翻红的判据钉住，本地取证全绿。

建议提交前处理：

1. **P1**：补 verify:ui 的两条判据，或显式修订计划的验收口径并记录理由；
2. **P2**：把 read-guard 挡掉整个 `.workagent/` 的行为变更显式拍板留档；
3. **P3 流程项**：负向注入实验补一次留档。

其余为记录性事项，不阻塞提交。
