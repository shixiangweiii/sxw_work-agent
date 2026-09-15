# 全量代码评审报告（2026-09-05）

- **日期**：2026-09-05
- **评审人**：pi
- **评审基线**：Git commit `d0cb270`（`源码指南`），HEAD 干净、无未提交改动
- **评审对象**：全仓生产代码 + 验收脚本 + Eval 套件。重点覆盖最近三个提交引入的变更：
  - `9a62f26`（基于评审结果代码评审和修复：Atlas 通用 ResourceRef 与可恢复 Context，62 文件，+4132/−659）
  - `b677f74`（支持使用 qwen3.8-flash，改进后评测分 90 分）
  - `d0cb270`（源码阅读指南，仅文档）
- **对照材料**：`sxw_aicoding/源码阅读指南/`（01–09 全部章节）、`sxw_aicoding/代码评审/2026-09-03/第3次评审报告-根据评测结果优化-pi-glm.md` 的遗留问题清单
- **性质**：仅评审，未改任何代码

---

## 一、验证基线（本次实测）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✓ 通过（含 `--noUnusedLocals --noUnusedParameters`） |
| `npm run verify:tools` | ✓ 18 条判据全绿（边界 grep 走 checker，未手抄） |
| `npm run verify:compact` | ✓ 10 条全绿 |
| `npm run verify:endpoint-profile` | ✓ 10 条全绿（含 qwen3.8-flash ASSUMED 声明判据） |
| `npm run verify:mcp` | ✓ 29 条全绿（fake stdio server，未联网） |
| `npm run verify:ui` | ✓ 84 条全绿 |
| `npm run verify:budget` | ✓ 13 条全绿 |
| `npm run verify:resume` | ✓ 5 条全绿 |
| `npm run verify:scenarios` | ✓ 5 条全绿 |
| `npm run verify:resource` | **✗ F 段未捕获异常崩溃**（详见 P1-1），G/H 段未执行 |
| `npm run verify:all` | **红**（停在 `verify:resource` F 段） |

---

## 二、上轮评审（2026-09-03 第 3 次，pi-glm）遗留问题核销核对

| 上轮编号 | 问题 | 本次核销结论 |
|---|---|---|
| P2-1 | fetch_url 文本 Resource 的 mediaType 与内容形态不一致 | **已修**。`tools/common/src/net/fetch-url.ts`：`resourceMediaType` 在 `rendered.format === "markdown"` 时写 `text/markdown; charset=utf-8`，`suggestedFilename` 同步改 `.md`（`markdownFilename()`）。**但注意：该修复的唯一判据（verify:resource G 段）因 F 段崩溃不可达**，见 P1-1 —— 修复本身正确，判据覆盖为零。 |
| P2-2 | Compact 持久化成功但帧未提交时产生"无事件孤儿引用" | **已修**。`packages/harness-runtime/src/context/compile.ts` 新增 `stagedCompactionRefs` + `discardPreparedCompaction()`：countTokens 失败、硬限超标、validateFrame 抛异常 / 失败四条路径都会回滚暂存 Resource（`ResourceStorePort.discardUncommitted`，含共享 blob 的 `stillUsed` 检查）。进程内失败路径已闭环；崩溃窗口的残余见 P3-1。 |
| P2-3 | `CompactResult.summary` 已成死字段、注释漂移 | **已修**。字段删除，摘要改由 `compile.ts` 在持久化成功后构造，经 COMPACT_BOUNDARY 原子提交。 |
| P2-4 | 外置 stub 与计划描述的轻微偏差（无 preview） | **已消解**。stub 现含 `totalLines` + 20 行 preview（1200 字符）；`packResourceReferences` 的 notice 含前 3 个 ref 的 preview。README §ResourceRef 写明口径。 |

上轮 4 个 P2 全部处置，且修法方向与本仓纪律一致（回滚优于事后声明、删字段优于改注释、修入口优于修注释）。上轮 P3-1/P3-4/P3-7 记录项状态不变（见第三节 P3）。

---

## 三、问题清单

### P1（应立即处理）

#### P1-1 `verify:resource` F 段崩溃：G/H 段判据全部不可达，`verify:all` 红

**位置**：`apps/cli/src/verify/resource.ts:338`

**现象**：F 段（ResourceRefs 元数据超限形成可恢复索引）抛出
`SyntaxError: Unterminated string in JSON at position 12000`，脚本以未捕获异常终止，稳定复现。

**根因**：F 段夹具 `runManyResourcesBatch` 一次产出 120 个带 180 字符 label 的二进制 Resource。`packResourceReferences` 将超过 inline 上限的 ResourceRefs 列表外置成单行 JSON 索引。验证脚本随后：

```ts
const indexPage = indexRef ? await resources.getTextPage(indexRef) : undefined;
const indexPayload = indexPage ? (JSON.parse(indexPage.content) as ...) : undefined;
```

`getTextPage()` 默认 `maxChars = 12_000`，120 个 ref（每个 label 200 字符 + ref/hash/元数据）的索引 JSON 远超一页 → 拿到的是截断页 → `JSON.parse` 崩溃。

**后果链**（比"一个测试 bug"重）：

1. F 段之后的 **G 段（fetch_url 转换后 MIME / filename —— 正是上轮 P2-1 修复的判据）与 H 段永远不执行**。P2-1 的修复因此处于"改了但没有判据盯着"的状态。按本仓自己的标准（AGENTS.md：每条断言须有判别力、提交前跑相关 verify），这是把一个已修复项重新置于无人看管。
2. `verify:all`（README 承诺的 17 条）当前跑不完，提交时是**带着已知红**的状态。源码阅读指南 README §8 如实记录了它 —— 文档记录是诚实的，但"记录"不能替代"修复"。
3. 顺带暴露 verify harness 的一个结构性弱点：**未捕获异常直接崩掉整个脚本**，后续段落静默消失，而不是以 ✗ 收尾。这与"绿灯必须有判别力"的立场相悖 —— **判据不可达与判据不存在等价**（本仓 D-22 同族）。

**修法建议**（未实施）：
- F 段按 `nextStartLine` / `nextLineOffset` 循环取页直到 `truncated === false` 再 parse（顺带把 `read_resource` 的单行续页语义测上了）；或 `getTextPage(ref, { maxChars: 8_000_000 })` 一次取全。
- 建议 `verify/harness.ts` 把未捕获异常记为一段失败并继续后续段落，而不是让整个脚本崩掉。

### P2（建议下一批收口）

#### P2-1 MCP 每次调用都复制全文进 resources，事件与存储引用线性膨胀

**位置**：`tools/mcp/src/client.ts` `renderContent()`

每个 text block 都额外 push 一条 `MCP text block N` 文本 Resource；`structuredContent` 更是**每次调用**都 stringify 存一份（哪怕 content 块已含同样内容，两份都会落库）。字节有内容寻址去重，但 `ResourceStored` 事件与 UI INFO 通知**不去重**。一次 Playwright 长会话会产生数百条几乎相同的资源事件，Trace / 界面信息流被稀释。

上轮 P3-2 原样存在；随外部 MCP 成为 Stage 4 主路径（`npm run ui` 常驻 + Playwright），建议升为 P2。处置方向：对"content 已含、structuredContent 仅为副本"的场景免存；或按 `(toolCallId, contentHash)` 对事件去重。

#### P2-2 token 估算系数 `/2.5` 三处手抄

**位置**：
- `packages/harness-runtime/src/action/settle-batch.ts` `modelVisibleTokens()`
- `packages/harness-runtime/src/context/compact.ts` `estimate()`
- `adapters/shape-anthropic-messages/src/protocol.ts` `estimateTokens()`

三处各写一遍 `Math.ceil(chars / 2.5)`，靠注释约定一致（settle-batch 注释明确写"与 Context 层的 estimatedTokens 同一个系数"）。改任何一处（例如为 qwen3.8-flash 校准系数，或引入语种差异化系数）会让三处口径悄悄分叉 —— 而批外置判定（settle-batch）、Compact 收敛目标（compact）、协议估算（adapter）**必须同单位**，这正是 compile.ts 里那段"帧级/消息级预算单位错配"教训的潜在复发点。建议在 harness-runtime 导出单一常量（如 `CHARS_PER_TOKEN_ESTIMATE`）三处引用。

#### P2-3 qwen3.8-flash 声明缺 `limits`，本地上下文硬限对它不设防

**位置**：`adapters/endpoint-profiles/bailian-anthropic-qwen38flash.json`

该声明无 `limits` 字段 → `compose.ts` 的 `endpointContextLimit` 收缩逻辑（`profile.limits?.maxContextTokens`）不生效，沿用 `DEFAULT_CONTEXT_POLICY` 的 60k/100k。若 qwen3.8-flash 真实窗口小于 100k，本地 `COMPACTION_INSUFFICIENT` 判定失效，改靠 Provider 400 兜底。

缓解因素（非隐瞒）：profile 注释与 `confidence: "ASSUMED"` 已如实声明证据债，每次装配产生 SYSTEM_NOTICE（`warnIfAssumed`），`verify:endpoint-profile` 有对应判据；qwen3.7-plus 声明同样只有 `quotaBeforeContextLimit`。**但**：评测分 90 已建立在该模型之上，probe 收口应排期 —— 至少先补 `limits.maxContextTokens` 的保守值。`_comment_context` 自己写着"完整 probe 后必须用实测值替换并提升 confidence"。

### P3（记录，不要求改动）

1. **Compact 提交前的崩溃窗口仍可留孤儿 ref**：`persistCompactionRecoveryIndex` 成功 → run-loop `append(COMPACT_BOUNDARY)` 之间进程死亡，暂存 ref 留在库里、无事件点名。进程内失败路径已回滚（P2-2 上轮已修）；崩溃窗口的 ref 无害（内容寻址、不占上下文），建议在源码阅读指南 05 篇作为已知残留写一句。
2. **`read_resource` 对单行索引的模型侧摩擦**：Compact 恢复索引与 ResourceRefs 索引都是单行 JSON，12k 字符/页意味着模型要多次续页才能读完"索引本身"；Compact 摘要与 `packResourceReferences` 的 notice 都只说"用 read_resource 读取索引"，未提示"索引本身可能多页"。P1-1 的事故侧面证明了这一点 —— 连测试脚本作者都会漏。
3. **`server.ts readJsonBody` 把非法 JSON 静默变成 `{}`**：POST /api/runs 发坏 body 与发空对象都表现为"任务为空"。可接受，但"故意发坏 body"与"漏写 task"在日志上不可区分。
4. **`serveStatic` 无 symlink 防护**：静态目录是仓库自己的 `public/`，路径 `startsWith` 检查足够；仅当未来允许 workspace 内自定义 UI 时需要 realpath 判定。
5. **`estimateTokens`（adapter）与 `computeIrreducible`（compile）各自处理 `fixedOverheadTokens`**：两处口径目前一致（EXACT 不加 / ESTIMATED 加），判定表注释清楚；风险仅在将来有人改一处判定表忘另一处。
6. **MCP 兜底 MIME `image/unknown` / `audio/unknown`** 非合法 IANA 类型（上轮 P3-3，仍为哨兵字符串，可接受）。
7. **`decodeBase64` 宽松解码**（上轮 P3-4）：正则预检 + `Buffer.from(base64)`，非规范 base64 按 Node 语义静默解码。字节不透明且按实测 hash 记账，无安全后果。
8. **`finish()` 内 `persistFacts` 与事件号**：`lastSequence` 是下界而非精确高水位，resume 侧 `max(transcript 末尾号, facts.lastSequence)` 已覆盖 —— 既有设计，注释自洽，无新问题。

---

## 四、分层评审结论

### packages/harness-runtime（Layer 3 核心）

- **run-loop.ts**：五条循环纪律、`emit → persistFacts` 顺序（D-2）、墙钟 active/waiting 分流（R-2 / S10）、`deadlineHit()` 判别式（用户取消 vs 预算 deadline）、`billedInputTokens` 口径（U-1）、空输出恢复走 `maxOutputTokensOverride` —— 抽查全部成立，历史修复点无回退。
- **settle-batch.ts**：不变量 8 的三重收口（`finalize()` + `recordUnmetRequired()` + port guard）结构清晰；批量 inline 预算放在 ledger 补齐**之后**统一执行是对的 —— 失败、拒绝、CANCELLED 补齐的结果都逃不过同批累计上限；`TOOL_CONTRACT_NO_ERROR` 兜底、超时后保留 `artifact`、InteractionCompleted 的 `answered` 语义修正、失败分支带脱敏后 output（不变量 13 的洞）均保持。
- **compile.ts / compact.ts**：协议单元并查集聚类（传递性正确）、`targetTokens` 单位换算（帧级预算扣除 Compact 够不到的部分）、Compact"纯选择 → 持久化 → 提交"三段式与失败回滚、`freedTokens` 用真实差值 —— 实现与源码阅读指南 04 篇陈述一致。
- **facade / transcript**：§18.2 三分支判定读 `ACTION_FACT` 前置指纹（决 6）、RECOVERY_REQUIRED 双闸门（状态 + 显式决策）、`observe()` 的 `required: false` 语义、resume 三道一致性闸门（端点 / workspace / 执行特权）排序 —— 与文档一致，**未发现新的"声明存在、机制未接线"实例**。

### packages/store-sqlite

`openDb` 空/非空库分流 + `ddl`/`columns`/`indexNames` 三份手写清单互为判据；`resource_refs`/`resource_blobs` 内容寻址去重（同字节多 ref）；`getTextPage` 的行内偏移分页实现正确（纸面推演了三个边界：首行超长、startLine 越界、limit 到达，均正确）；`discardUncommitted` 对共享 blob 的 `stillUsed` 检查正确；`select(ref, true)` 读取时 hash/size 复核在位。

### adapters

- `protocol.ts`：D-07"形状提供结构、端点提供常量"的分工表成立；错误分类用 SDK 构造器名判别（N-4 教训）、SSE provider error 单独分类、429 的 quota/限流分流 —— 无发现。
- `renderToolResultForModel` 作为 adapter 渲染 / Context hash / token 估算三处唯一出口的设计被遵守（三处均调用它，固定键序）。
- 端点选择表 `ENDPOINT_SELECTIONS`（b677f74）：modelId → 独立声明的映射 + 未知模型回退 fallback profile + M-5 真实请求前硬失败、错误信息列出已登记模型 —— 闭环设计好，`resolveEndpointProfilePath` 的回退仅用于生成可解释错误，注释明确"不是运行时降级"。

### tools/

- `fetch_url` 2.0.0：流式 8MiB 上限（Content-Length 预判 + 逐块累计 + cancel）、重定向终点复判（注释如实承认残余 SSRF 面）、`UNKNOWN` 副作用状态、4xx/5xx 结构化返回 —— 质量高。
- `materialize_resource`：`wx` + `rename` 原子写、写后独立复读 hash、store 读取时二次 hash 校验、越界/非法 role/缺失 ref 全部具名失败 —— 防御纵深完整，与 verify:resource C 段四类失败码一一对应。
- `read_resource`：`line_offset` 透传已修（handler 层），注释链完整记录了 2026-08-28 事故。
- MCP client：tools/list 分页 + 重复 cursor 抛错、tolerant schema 回退、`ResultSchema` 宽松解析（未知块类型不废工具）、握手失败自收子进程、`resetTimeoutOnProgress` + 空 `onprogress` 成对 —— 实战细节到位。工具面冻结纪律（`tools/list_changed` 只警告不重列）正确。

### apps/

- `compose.ts`：Composition Root 单一出处纪律（工具清单、档位描述、预算参数表、脱敏实现）执行到位；`SimpleRedaction` 两档差异（M-6）与 P3-26 email 挪档在位。
- `run-host.ts`：同步占位前台槽（TOCTOU）、首个 `gen.next()` 的 try/catch（resume 闸门抛错不悬挂段状态）、`pump` await 后关库（codex P1-6）、跨段换新 AbortController（E-3 同形坑）、`close()` 超时如实告警 —— 历史坑的修复都在位。
- `server.ts`：percent-encoded runId 白名单收口在路由层、artifactPreview 三道判定（登记 + 登记路径 + realpath）、P1-2 / P2-3 的"失败请求不留状态变化"纪律（档位先校验后起 Run、提升先验 kind 后 elevate、失败回收 elevation）执行到位；SSE `Last-Event-ID` 优先 + NaN 防护。
- UI（app.js 3235 行）：无 innerHTML，统一 DOM 工厂走 textContent；两条事件读取路径（内存缓冲 / trace 文件）对 `ModelStreamDelta` 的排除规则一致。

### eval / cases / testkit

`resource-archive-case` 用动态脚本模型真实经历 fetch → 强制 Compact → read_resource 恢复索引 → materialize 原样落盘链路，grader 独立从真值、文件字节与来源记录判定，`FetchTransport` 注入点密封 —— 符合边界 14（生产模块不含 Eval 夹具词，grep 干净）。`cases/micro-cases` 仍只含 `append_log` / `slow_write` 两个测量工具，Case 02 反证抽象仍待做（与 README 声明一致）。

---

## 五、总体结论

**代码质量整体过硬，可以继续在其上开发。**

1. 上轮 4 个 P2 全部核销，修法符合本仓纪律；
2. 注释文化（失败案例、反例、判别力声明、端点实测数据）在生产代码里保持一致，本次全量扫描**未发现新的"未接线比不写更糟"实例**；
3. 边界体系（依赖方向、MCP 协议位置、node:sqlite 收口、UI 无模块依赖）经 `verify:tools` 与手工抽查全部成立。

**唯一必须立即处理的是 P1-1**：`verify:resource` F 段崩溃使 `verify:all` 红，并让上轮 P2-1 的修复（fetch_url mediaType）失去判据覆盖。源码指南如实记录它是诚实的，但记录不等于豁免 —— 按本仓自己的验收纪律，这属于"提交了已知红的验收套件"。

建议处理顺序：**P1-1（F 段取页 + harness 异常兜底）→ P2-1（MCP 资源副本膨胀）→ P2-2（估算系数单一出处）→ P2-3（qwen3.8-flash probe / limits 补齐，随下一次评测）**。

---

## 附：本报告的证据等级说明

- "实测"指本次评审期间实际执行的命令（见第一节验证基线）；
- 代码结论均给出具体文件与方法级定位，可按"符号名 + 不变量"复核；
- 行号以 `d0cb270` 为基线，漂移后请用符号名检索。
