# 第3次评审报告（根据评测结果优化）

- **日期**：2026-09-03
- **评审人**：pi（GLM）
- **评审对象**：工作区全部未提交改动（45 个文件改动 + 10 个新增文件，+1455/−591），对照实施计划 `~/Downloads/PLAN.md`（Atlas 通用 ResourceRef 与可恢复 Context 修复方案）
- **性质**：仅评审，未改任何代码
- **验证**：`npm run typecheck` 通过（含 `--noUnusedLocals --noUnusedParameters`）；按计划约定本轮不执行 `verify:*` / `verify:all` / Eval 回归

---

## 一、总体结论

实现与计划高度一致，四个 Key Changes（统一 Resource 数据通道 / 通用资源工具 / 批量结果与 Compact / 验证交接与防过拟合）全部落地，且质量纪律（具名错误、事件可审计、判别力实测、边界扫描、文档同步）保持到位。**未发现 P1 级正确性缺陷**；有 4 个 P2 级问题与若干 P3 级记录项，均不阻塞提交，建议在下一批收口。

---

## 二、计划逐项对照

| 计划项 | 落点 | 状态 |
|---|---|---|
| `ResourceKind` / `ProducedResource` / `ResourceReference` / `ModelContent.tool_result.resourceRefs` | `packages/harness-runtime/src/types/resource.ts`、`ports/index.ts`、`types/context.ts` | ✅ |
| `ResourceStorePort`（文本分页 + 物化读取 + 内容寻址去重、独立 `res_*`） | `ports/index.ts`、`store-sqlite/src/resource-store.ts` | ✅ |
| `resource_blobs` / `resource_refs` 表；旧 schema 不兼容、显式拒绝 | `store-sqlite/src/db.ts`（`assertSchemaShape` 沿用"删库重建"策略；`redaction_disposition` 为计划字段的超集） | ✅ |
| 文本 Resource 过 Redaction 后才持久化 | settle-batch ⑥.5（正文+元数据均脱敏）；Compact 再持久化的是已脱敏 ledger 内容；外置存 `red.text` | ✅ |
| 二进制不透明：不扫描、不进模型/Transcript/Trace/审计、事件记录 `OPAQUE_BINARY_NOT_TEXT_SCANNED`、批准后才物化 | `ResourceStored.redactionDisposition` + `verify:resource` D 段哨兵判据 | ✅ |
| 单 Resource 8 MiB 上限；超限只返回元数据与明确失败说明、不产生不可用引用 | store `put` 校验 + `materializeToolResult` 的 `RESOURCE_TOO_LARGE` stub（含 1200 字符 preview） | ✅ |
| `read_resource` 替换 `read_blob`（行号 + 字符偏移分页；二进制只回元数据、绝不 base64） | `tools/common/src/mech/read-resource.ts`；`read-blob.ts` 已删除、全仓无残留代码引用 | ✅ |
| `materialize_resource`（role 必填、WRITE/FILE、原子写、写后复读校验 hash、自动登记 Artifact、`sourceResourceRef`、魔数检查） | `tools/common/src/mech/materialize-resource.ts` + `verify:resource` B/C 段 | ✅ |
| 工具数 14→15、固定开销 2520→2700 token | compose.ts 注释、README、CLAUDE.md 三处同步 | ✅ |
| `fetch_url` 2.0.0：2xx 文本产转换后正文 Resource、2xx 二进制产不透明 Resource、非 2xx 不产 | `tools/common/src/net/fetch-url.ts`；`FetchTransport` 注入点供密封 Eval | ✅ |
| MCP 桥接：text/structuredContent→文本、image/audio/embedded→二进制、link 仅元数据、未知块明确报告、版本含桥接协议版本 | `tools/mcp/src/client.ts`、`tool-bridge.ts`（`mcp-resource-v1-…`）、`handler.ts`；`verify:mcp` I/I1 段 + fake server 新夹具 | ✅ |
| `inlineToolResultsPerBatchLimitTokens` 默认 12,000（单条 8,000，按调用顺序、不看工具名） | `settle-batch.ts` ledger 补齐后的二次遍历 + `budget/index.ts`；`verify:resource` E 段 4400×3 判据 | ✅ |
| Compact 拆"纯选择 / 持久化后提交"；索引含 turn/toolCallId/toolName/resultRef/resourceRefs；Store 失败不提交 boundary，具名 `CONTEXT_MATERIALIZATION_FAILED` | `compact.ts`（`dropped`）+ `compile.ts`（`persistCompactionRecoveryIndex`）+ `run-loop.ts`；`verify:compact` D2/H/I 段 | ✅ |
| Compact 摘要措辞（移出数、索引 ref、协议单元整体、近两轮保留）；`ContextCompacted` 事件新字段；UI 只展示元数据 | `compile.ts` 摘要、`event.ts`、projection/app.js/render.ts | ✅ |
| Adapter 渲染 / Context hash / token 估算统一含 `resourceRefs` 确定性表示 | `protocol.ts`（toBlock + estimateTokens）、`compile.ts` renderText、`compact.ts` estimate 三处同走 `renderToolResultForModel`（固定键序） | ✅ |
| Artifact 结构检查保持 Case 无关；`sourceResourceRef` 贯穿 Registration/存储/事件 | `artifact-store.ts`（含补首次来源的 UPDATE）、`ports/index.ts`、`event.ts`、UI | ✅ |
| 硬限制 handoff 措辞收敛（"未登记到…"+"无任务级完成契约"） | `settle-outcome.ts` + `verify:budget` 新判据 | ✅ |
| 系统提示只加两条通用指引 | compose.ts（materialize 边界 + Compact 索引指引，恰好两条） | ✅ |
| 边界 14：Runtime 与 tools/common 不得含 Eval 夹具词 | `boundaries.ts` pattern + `verify:tools` A3 canary 判别力实测 | ✅ |
| Eval 冻结合成归档 Case（假 HTTP、多页、图片、强制 Compact、独立 grader） | `eval/fixtures|graders|suite/resource-archive*`；`eval:resource-archive` 注册 | ✅ |
| 三场景各加一个 Resource 物化用例、不新增场景专用工具 | `verify:scenarios.ts`（同一机制工具、同一形状） | ✅ |
| 本轮只执行 `npm run typecheck` | 已确认通过 | ✅ |

---

## 三、值得肯定的设计点

1. **批量预算放在 ledger 补齐之后统一执行**（`settle-batch.ts`）：失败、拒绝、CANCELLED 补齐的结果都逃不过同批累计上限；`modelVisibleTokens` 与协议真实渲染同源（`renderToolResultForModel`），三处估算（adapter / frame hash / compact estimate）不会各说各话。
2. **`materialize_resource` 的防御纵深**：store 读出后先验 hash、`wx`+`rename` 原子写、写后独立复读校验、越界/非法 role/缺失 ref 全部具名失败——与 `verify:resource` C 段四类失败码一一对应。
3. **元数据也走脱敏**：`persistProducedResources` 对 label/mediaType/filename 先脱敏再截断入库，且失败分支不回退用原始 label（注释明确说明了原因）。
4. **外置失败回退 inline 而非报失败**：避免模型重做非幂等工具导致双写，这一取舍被完整保留并注释；同时新增 `ResourcePersistenceFailed` 事件让回退可见。
5. **`freedTokens` 改为真实差值**：compile.ts 用 `beforeCompactionTokens - count.tokens`（含摘要与 ResourceRef 的新帧）替换"只算 kept"的估算，并在注释中说明理由。

---

## 四、问题清单

### P2（建议下一批处理）

**P2-1 fetch_url 文本 Resource 的 mediaType 与内容形态不一致**（`tools/common/src/net/fetch-url.ts`）
HTML 响应默认转 Markdown，但 Resource 的 `mediaType` 仍写原始 `text/html; charset=utf-8`，内容却是转换后正文。若模型按 `suggestedFilename`（如 `page.html`）物化，落盘的是 Markdown 字节。资源自身字节保真没有破（物化的就是 Resource 字节），但元数据失真会误导模型选文件名与后续处理。建议 mediaType 反映转换后格式，或在外置 note 中说明。——唯一可能影响模型行为的语义问题，优先排期。

**P2-2 Compact 持久化成功但帧未提交时产生"无事件孤儿引用"**（`compile.ts`）
`persistCompactionRecoveryIndex` 成功后，若后续 `countTokens` 仍超硬限（`COMPACTION_INSUFFICIENT`）或 `validateFrame` 失败（`PROTOCOL_INVALID`），恢复索引与被移出结果已入库，但 `ContextCompacted` 不会发出（run-loop 只在 boundary 提交后发事件）——Trace 里没有任何事件点名这些 ref。无害（内容寻址、不占上下文），但审计上"库里有的东西 Trace 查不到来源"，与本项目可解释性纪律有缝隙。

**P2-3 `CompactResult.summary` 已成死字段，注释漂移**（`packages/harness-runtime/src/context/compact.ts`）
`compactMessages` 现在从不给 `summary` 赋值（摘要改由 `compile.ts` 在持久化成功后构造），但 `CompactResult.summary` 的注释仍写着"run-loop 要把它放进 COMPACT_BOUNDARY…"，暗示由 compact 层提供。后续调用方若按注释消费该字段会拿到 undefined 而误判"没丢消息"。建议删字段或改注释。

**P2-4 外置 stub 与计划描述的轻微偏差**
计划第 3 节写"模型只收到 preview、结果ref和附属ResourceRefs"；实现中只有 8 MiB 超限 stub 带 preview，常规 token 超限外置的 stub 只有 ref + 分页取回指引（无 preview）。检索语义完整、可接受，但与计划文字不一致，应在计划或 README 补一句口径。

### P3（记录，不要求改动）

1. `ResourcePersistenceFailed` 事件被两种不同失败面复用（⑥.5 工具附属资源 vs `materializeToolResult` 整条结果外置失败），靠 label（`resource #n` vs `完整工具结果`）区分，事件消费者需感知该约定。
2. MCP `structuredContent` 现在**每次调用**都生成一条文本 Resource（即使已有 content 块），`ResourceStored` 事件与 UI INFO notice 随调用量线性增长；存储有内容寻址去重，事件量没有。
3. MCP 兜底 `image/unknown` / `audio/unknown` 不是合法 IANA 类型，仅为哨兵字符串。
4. `decodeBase64` 的正则预检 + `Buffer.from(base64)` 宽松解码，非规范 base64 会按 Node 语义静默解码——字节不透明且按实测 hash 记账，无安全后果，仅记录。
5. `verify:resource` D 段把 `modelAuditDir` 放在 workspace 内（`resource-audit/`），当前无自咬判据，但该 workspace 后续若加物化判据需注意。
6. 边界 14 pattern（`hugozhu|博客文章|images/|…`）依赖 `grepBoundary` 的注释过滤；生产注释里的 `images.zip`、`images/` 已同步改写为中性词（run-shell.ts、ask-user.ts），属双重保险，OK。
7. 未跟踪文件里有 `.DS_Store` 两处（根目录与 `sxw_aicoding/代码评审/`），提交前记得排除。

---

## 五、验证状态与移交提醒

- `npm run typecheck`：**通过**。
- `verify:*` / `eval:*`：按计划约定本轮未执行（由用户在全新 workspace + 新库 + 换模型后跑）。`package.json` 已注册 `verify:resource`（`verify:all` 更新为 17 条）与 `eval:resource-archive`。
- 判别力抽查（静态）：`verify:compact` H 段注入 store 故障、`verify:resource` E 段 4400×3 批量判据、`verify:tools` A3 边界 14 canary 均满足"删掉对应逻辑必翻红"的要求；真正的翻红实验需随 verify 一并执行。
- 旧库兼容提醒：旧库（含 `blobs`/`blob_refs`、旧 `artifacts` 无 `source_resource_ref`）会在 `openDb` 处被显式拒绝并提示删库，符合"无 migration、旧库保留"策略，但会打断现存工作流；`run_d27b38c8ebff` 所在旧库不受影响的前提是**不要用新代码打开它**。

---

## 六、结论

**可以提交。** P2-1（mediaType 失真）是唯一可能影响模型行为的语义问题，建议优先排进下一批；P2-2/P2-3/P2-4 为可解释性与文档口径收尾项。
