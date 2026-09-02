# LLM 调用级原始请求/返回采集与持久化 · 代码评审报告

> 评审日期：2026-09-02
> 评审对象：`PLAN (1).md`「第一阶段：LLM 调用级原始请求与返回审计（二次修订）」对应的工作区未提交改动（基线提交 `fb4cab1 trace显示代码优化`）
> 评审依据：`PLAN (1).md`、V05 `架构设计/WorkAgent架构设计_V20260823_05.md` §19.4、`阶段roadmap` §6.1.1
> 评审方式：仅评审，未修改任何生产代码
> 评审基线：`npm run typecheck` ✓；`npm run verify:model-audit` 15/15 ✓；`npm run verify:ui` 70/70 ✓；`npm run verify:tools` 16/16 ✓

---

## 1. 评审范围与覆盖文件

| 层 | 文件 | 本批改动内容 |
|---|---|---|
| Runtime 契约 | `packages/harness-runtime/src/types/model-audit.ts`（新增） | `ModelInvocationObserver`、`ModelInvocationAuditStart/End/Writer/ReadResult`、schema 常量、NULL 观察器 |
| Runtime 契约 | `packages/harness-runtime/src/ports/index.ts` | `ModelPort.invoke()` 增加 `observer` 形参、新增 `ModelInvocationAuditStorePort`、`RuntimePorts.modelAudit`（Port 14→15） |
| Runtime 契约 | `packages/harness-runtime/src/types/event.ts` | `ContextFrameCompiled` 补 `frameId/invocationId`；`ModelInvocationCompleted` 补 `invocationId`；`RuntimeErrorOccurred` 补可选 `invocationId`；新增 `ModelInvocationAuditFailed` |
| Runtime 循环 | `packages/harness-runtime/src/loop/run-loop.ts` | 调用前建审计、逐出口 `finish`、fail-open 事件上报、重试自然换帧换文件 |
| Runtime 循环 | `packages/harness-runtime/src/loop/model-audit.ts`（新增） | `FailOpenModelInvocationAudit`：写失败停后续、单次调用只报一次 |
| Adapter | `adapters/shape-anthropic-messages/src/client.ts` | `withResponse()` 取 HTTP 状态/request-id、归一化前逐条转发原始 SSE、原始错误 body、迭代后再判 abort |
| 持久化 | `apps/cli/src/model-audit/file-store.ts`（新增） | 独占创建 JSONL sidecar、私有权限、`readModelInvocationAudit` 四态判读 |
| 组合根 | `apps/cli/src/compose.ts` | `workspaceStorage().modelAuditDir`、默认 `FileModelInvocationAuditStore`、`portOverrides.modelAudit` 旋钮 |
| 观测出口 | `apps/cli/src/render.ts`、`apps/workagent-service/src/projection.ts`、`apps/workagent-ui/public/app.js` | `ModelInvocationAuditFailed` 的 CLI 显眼警告 / UI 诊断通知 / Trace Inspector 展示 |
| 护栏 | `tools/common/src/fs/read-guard.ts` | `.workagent` 进 `DENIED_SEGMENTS` |
| 验收 | `apps/cli/src/verify/model-audit.ts`、`verify/workers/model-audit-crash.ts`（新增）、`verify/ui.ts`、`verify/tools.ts`、`verify/{budget,artifact,harness,reasoning-tokens,requirement-extraction}.ts` | 16 号验收、真 SIGKILL 夹具、主 Trace 不混入审计、读护栏 canary、各 fake ModelPort 补形参 |
| 文档 | `AGENTS.md`、`CLAUDE.md`、`README.md`、V05 §19.4、Roadmap §6.1.1 | 计数 15→16、路径与不变量登记 |

边界核对：`packages/` 与 `adapters/` 未 import 任何 `@workagent/tools-*`；`tools/` 未 import 任何 Case；sidecar 完整内容不进 `RunEvent` / transcript / SQLite / 主 Trace；`/api/runs/:runId/trace` 与最新 Trace 统计口径未动。与 PLAN §「最新 Trace 优化的兼容约束」一致。

## 2. 总体评价

实现忠实于 PLAN，质量较高。关键设计决策值得肯定：

1. **调用身份复用**：不造第二套 ID，`invocationId` 随 `compileFrame`（`compile.ts:318`）每次编帧新生成；重试走 `continue` 重新编帧，天然产生新 `invocationId` 与新文件（verify C/D 各以「两个文件」钉住）。
2. **原始事实在归一化前离开适配器**（`client.ts:76`），与 PLAN「不能再把拼装结果称作原始返回」一致；`invocation_end` 保留 Runtime 规范化结果供二者对照。
3. **fail-open 契约**（`loop/model-audit.ts`）：观察器对所有写路径 try/catch，从不向 adapter 抛错，避免本地审计故障伪装成模型故障；`takeFailure` 闩锁保证每调用只报一次；各出口 `finish`/`closeIncomplete` 收敛，无 fd 泄漏（`store.open` 内部先 `closeIncomplete` 再抛）。
4. **reader 四态**（`file-store.ts:123`）：`COMPLETE/INCOMPLETE/CORRUPT/NOT_CAPTURED` 显式区分，坏行进 `errors` 不静默；真 SIGKILL worker 证明进程死亡留下的完整前缀判为 INCOMPLETE。
5. **abort 权威再判**（`client.ts:162`）：SDK 不保证抛 AbortError、可能让迭代正常结束，循环后再对 `signal.aborted` 补判，修掉「半截流误报 COMPLETED」。
6. **持久化与文件卫生**：`openSync(path,"wx",0o600)` 独占不覆盖、`mkdirSync(...,0o700)`、`safeComponent` 文件名守卫、`.workagent/` 已在 `.gitignore`。
7. **读护栏闭环**（`read-guard.ts:52`）：`.workagent` 纳入黑名单（连旧缺口的 `.workagent/runs` trace 一并挡住），并在 `verify:tools` 用 canary 加了带判别力的正反分支。

结论：**基本通过**。第 3 节「需要修」两项建议在合并前处理，其余为非阻塞建议。

## 3. 需要修的问题

### 中-1：HTTP-200-后的流内 `error` 事件会被误标成 TRANSPORT

**位置**：`adapters/shape-anthropic-messages/src/client.ts:191`（`providerFailureOf`）。

**现象**：分类仅凭 `status === undefined ? TRANSPORT : PROVIDER`。但 SDK 在流内收到 `event: error` 时抛的是 `new APIError(undefined, …)`（`node_modules/@anthropic-ai/sdk/src/core/streaming.ts:83`），`status` 恒为 undefined。此时 `withResponse()` 已成功，`response_metadata(200)` 与部分 `provider_event` 已写入，随后 `provider_error` 却标为 `TRANSPORT` 且带着 `errorBody`——与 PLAN「TRANSPORT＝无 Provider 响应的网络错误」自相矛盾，产出一份内部冲突的 sidecar。

**判据缺口**：verify 未覆盖此路（只测了 `socket.destroy` 真断连与 429 JSON 两种端点行为）。

**建议**：按错误身份而非仅 `status` 分流（如 `APIConnectionError`/`AbortError`＝TRANSPORT，带 `errorBody` 的 `APIError`＝PROVIDER），并补一条「200 后发 `event: error`」夹具，使该形态有独立判据。

**区分度实验**：若把 `providerFailureOf` 的 `kind` 硬编码成 `TRANSPORT`，现有 D 段仍绿、A/C 段仍绿——即当前无任何断言能翻红这一误标，属需补的判据。

### 过程-2：PLAN 明确要求的两处负向注入未落证

**位置**：`apps/cli/src/verify/model-audit.ts`（PLAN §验收末条、AGENTS.md「每个断言要有区分度并实际跑一次」）。

**现象**：PLAN 要求对「漏转发 Provider 事件」和「审计写失败被静默吞掉」各做一次负向注入、确认翻红。静态看二者有杀伤力（删 `client.ts:76` 使 `providerRecords` 为空→A 红；令 `takeFailure` 失效使 F 的 `length===1`→0 红），但仓库纪律要求实际执行一次并留证据，本次未见记录。

**建议**：合并前补跑这两次注入（临时改→跑→还原，不改提交），把证据贴进 PR/验收记录。

## 4. 非阻塞建议

- **4-1（性能权衡未登记）**：`file-store.ts:119` 每条 SSE 走同步 `writeSync`＋`JSON.stringify`，落在流式热路径；`readModelInvocationAudit` 又整文件 `readFileSync`。Stage 1 可接受，但属已知取舍，建议在文件头注释显式记一笔，避免日后被当成可扩展实现沿用。
- **4-2（文档计数漂移）**：`CLAUDE.md` 写「16 条脚本 / 250 条判据」，而 `AGENTS.md`/`README` 已去掉判据总数。手维护的精确总数会失真，建议统一为不写死数字。
- **4-3（测试排序稳健性）**：`verify/model-audit.ts:447` `auditFilesFor` 仅按 `startedAt`（毫秒）排序，同毫秒的两次调用可平票；建议加文件名/ids 序作二次排序。
- **4-4（类型弱化）**：`event.ts` 新事件 `payload.stage: string`，把 `ModelInvocationAuditWriteStage` 联合降级为 `string`；跨 Trace 序列化可理解，仍可保留字面类型。

## 5. 与 PLAN 逐条对照

| PLAN 条款 | 落实 | 备注 |
|---|---|---|
| 复用 `invocationId`/`frameId`，不造第二套 ID | ✓ | `compile.ts:316-318`、事件与文件名共用 |
| 重试换帧→新 `invocationId`/文件 | ✓ | verify C/D 各 2 文件 |
| 采集 CLI/Web，排除 `count_tokens` 与 EVAL | ✓ | `run-loop.ts:618` `origin.kind!=="EVAL"`；`countTokens` 无 observer |
| 保存实际 `request.body` | ✓ | `run-loop.ts:615`，verify A 逐字比对 |
| 逐条原始 SSE、保持顺序与字段 | ✓ | `client.ts:76` 先转发后归一化；⚠ 见中-1 的 error 事件分流 |
| Provider 错误 body / 网络错误标 TRANSPORT | ⚠ | 429/断连正确；200-后-SSE-error 误标 TRANSPORT（中-1） |
| `invocation_end`＝状态/耗时/规范化结果或错误 | ✓ | `ModelInvocationAuditEnd` |
| schemaVersion、私有权限、独占不覆盖 | ✓ | 常量 1、0600/0700、`wx` |
| reader 四态不静默 | ✓ | 含真崩溃夹具 |
| 新 Port + fail-open 包装 | ✓ | Port 14→15 |
| 只报一条 `ModelInvocationAuditFailed` + CLI 警告 + Inspector 展示 | ✓ | 闩锁 + render/projection/app.js |
| 成功路径不新增 Trace 行；完整内容不进 transcript/SQLite/主 Trace | ✓ | verify A/G + ui 收紧「只有 header/event/footer」 |
| `--no-trace` 与审计独立 | ✓ | 默认恒开，独立目录 |
| 不进入 HTTP API、不得提交 | ✓ | 无读取接口；`.workagent/` gitignore |
| 旧 Run 显示 NOT_CAPTURED | ✓ | reader 分支（UI 属第二阶段） |

## 6. 建议后续动作

1. 处理中-1（错误身份分流 + 200-后-error 夹具），这是唯一会产出内部矛盾文件且当前无判据覆盖的真实形态。
2. 补跑过程-2 的两处负向注入并留证据。
3. 酌情吸收第 4 节非阻塞建议（其中 4-1、4-2 建议至少登记）。
