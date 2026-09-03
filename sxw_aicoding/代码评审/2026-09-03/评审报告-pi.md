# 代码评审报告（pi）

- **日期**：2026-09-03
- **评审人**：pi（Claude Sonnet 4.5）
- **评审对象**：`sxw_work-agent` 全仓生产代码（commit `801b200` 轮次展示）
- **评审重点**（用户指定）：
  1. 过期的代码（死代码、零消费者的声明）
  2. 变量命名与实际代码逻辑语义不一致
  3. 过期的注释（描述已不存在的字段/机制）
  4. 不必要的历史兼容逻辑（个人项目，明确不需要为历史数据保留兼容）
- **性质**：仅评审，未改任何代码。

---

## 一、评审范围与方法

### 1.1 逐文件通读

| 层 | 文件 |
|----|------|
| `packages/harness-runtime` | run-loop / facade / settle-batch / compile / compact / budget / tool-runtime / types 全部（run / tool / event / loop / ids / transcript 等） / ports / workspace / transcript / verification(settle-outcome) / drift-detector / interrupt / progress-guard / model-audit(fail-open) / policy / effect-resolver / profile-loader / trace |
| `packages/store-sqlite` | db / transcript-store / run-repository / artifact-store / blob-store |
| `adapters/shape-anthropic-messages` | client / protocol / credential-guard / error-facts / index |
| `tools/mcp` | client / config / handler / tool-bridge / index |
| `tools/common` | index（Handler/Verifier/工具清单）/ run-shell / fs-common / ask-user 等主要文件 |
| `apps/cli` | compose（Composition Root）/ main / composite / stdin-channel |
| `apps/workagent-service` | run-host / server / projection / api-types / human-channels / workspace-hosts / workspace-registry / security / main |
| `eval` / `packages/testkit` | 抽样通读（suite/index、testkit 各文件头） |

### 1.2 机械扫描

- 自写脚本扫描**全仓未使用导出**（跨文件裸标识符引用检查），对每个候选值导出逐个 `grep` 确认消费者；
- 全仓模式搜索：`deprecat|legacy|兼容|废弃|向后|历史遗留|旧版|TODO|FIXME` 等；
- `npm run typecheck`（`--noUnusedLocals --noUnusedParameters`）：**通过，零报错**。

---

## 二、总体结论

**这个仓的卫生水平远高于常见项目。** 典型死代码形态——只写不读的字段、零消费者的枚举值/事件类型、别名、`UNKNOWN_LEGACY` 降级档、SQLite migration 机制、`schema_version` 逐行版本、注册表 `version` 字段、`CollectingTraceSink` 类的同族残留——均已在 `47b2231`（「代码重构优化，保持简洁，去掉兼容逻辑」）及各 current-only 收口批次中清理，且清理决策都留有注释记录（含「为什么删而不是接上」）。

注释与代码的同步性异常好：抽查了全部「声明与实现不符」历史教训的现场（`MAX_TIMEOUT_MS` vs `timeoutPolicy`、`intervalMs`、`contentHash`、`Omit` 键、`redactionApplied` 等），均已修复且注释已更新。

真正残留的确认问题共 **5 项**（1 项为主的历史兼容链 + 4 项小问题），详见下文。

---

## 三、确认的问题

### 问题 1（主要）：projection 侧的「旧 Trace 缺 invocationId/frameId」历史兼容链

**类别**：历史兼容逻辑（用户明确不需要）。
**位置**：三处联动。

#### 1a. `apps/workagent-service/src/projection.ts:552-563`（`ContextFrameCompiled` 分支）

```ts
// 旧 Trace 没有这两个字段：保留轮级 frame，等 completed 事件创建兼容调用。
const invocationId = typeof ev.payload.invocationId === "string"
  ? String(ev.payload.invocationId)
  : undefined;
if (invocationId) {
  const call = callFor(t, ev.sequence, invocationId);
  call.frame = frame;
  if (typeof ev.payload.frameId === "string") call.frameId = String(ev.payload.frameId);
}
```

`types/event.ts` 里 `ContextFrameCompiled.invocationId` / `frameId` 均为**必填**（`invocationId: ModelInvocationId`），生产路径（`run-loop.ts` 的 `emit("ContextFrameCompiled", …)`）恒有值。`typeof … === "string"` 防御**只在读旧 trace JSONL 文件时触发**——注释自己也承认这一点。

#### 1b. `projection.ts`（`ModelInvocationCompleted` 分支）

同样的 `typeof ev.payload.invocationId === "string" ? … : undefined` 防御；该字段在事件类型上同样必填。

#### 1c. 配套的 fallback 结构

- `appendCall` 的**可选** `invocationId?` 参数；
- `model-event:${sequence}` fallback id——`api-types.ts` 的 `UiModelCall.id` 注释原文：「只用于投影与 DOM 的稳定 id；**旧 Trace 没有 invocationId 时由事件 sequence 推出**」；
- `api-types.ts:187`：`UiTurn.frame` 的注释「**兼容主行**：同一轮有重试时是最后一次编译帧；精确帧在 modelCalls[].frame」。

#### 1d. `apps/cli/src/verify/ui.ts:1605-1634`

专门构造的判据段：把真实事件的 `invocationId` / `frameId` 删掉再喂给 `projectTurns`，断言「旧 Trace 缺少 invocationId 时仍保留 usage」。**它测的是这条兼容行为本身**——若删除兼容，此判据一并删除。

#### 处置建议

仓里已确立的对应纪律是：SQLite「schema 变了就删库重建」（`db.ts` 文件头【定】），workspace 注册表「格式变了就重新选一次目录」。trace JSONL 是诊断轨道（`loadTraceEvents` 的调用方注释：事件轨道缺失时「如实降级，不猜」），旧文件同样可以删。建议整链删除：

1. 两处 `typeof === "string"` 防御（`ContextFrameCompiled`、`ModelInvocationCompleted`）；
2. `appendCall` / `callFor` 的 `invocationId?` 可选路径与 `model-event:` fallback id；
3. `UiTurn.frame` 注释改写（轮级 frame 字段本身可保留，理由改为「主行显示最后一次编译帧」）；
4. `verify:ui` 的 `legacyTurns` 判据段。

#### ⚠️ 必须区分保留的相邻代码

`RuntimeErrorOccurred` / `ModelInvocationAuditFailed` 分支的同类检查**不是**历史兼容：

- 前者的 `invocationId` 在事件类型上本就**可选**（`invocationId?: ModelInvocationId`）；
- 后者的检查动机（注释原文）是「事件由本地 JSONL 读回后只做了类型断言；**损坏或未来旧形状不能被 `String(undefined)` 投影成一个可点击的 `model:undefined` 假调用**」——`readJsonl` 静默跳过坏行，但半好行可能通过，这是**损坏数据防御**，应保留。

---

### 问题 2：`settleWallOutcome` 的 `handoff` 死参数 + 「DETERMINISTIC handoff」过期注释

**类别**：死代码 + 过期注释。
**位置**：`packages/harness-runtime/src/verification/settle-outcome.ts:255-271`。

```ts
 * outcome 由墙决定，DETERMINISTIC handoff 负责把「做到哪了」讲清楚。
 ...
export function settleWallOutcome(
  kind: …,
  input: SettleInput & { handoff?: string },
): RunOutcome {
  ...
  summary: input.handoff ?? input.summary,
```

全仓仅两个调用点：

- `run-loop.ts:323`：传 `settleInput`，只带 `summary: lastAssistantText`；
- `facade/index.ts:473`（RECOVERY ABORT 分支）：显式传 `summary: "用户对上次崩溃时…"`。

**`handoff` 零生产者，`input.handoff ??` 左分支不可达**；注释引用的「DETERMINISTIC handoff」机制在仓里不存在（`grep handoff:` 的命中全部是 `ComposeOptions.handoff`（HandoffChannel 注入）与 `terminalHandoff`，与该参数无关）。

按本仓自己的纪律（`Continue` 值域那条【定】：「值域 == 循环里真的存在的站点，一个不多」；`UnmetCause`「只放有明确事实来源的成因」），这是该删的残留：删参数、删 `?? input.handoff`、改注释。

---

### 问题 3：`run-shell.ts` 的 `maxAttempts` 过期注释块

**类别**：过期注释（描述已删除的字段）。
**位置**：`tools/common/src/exec/run-shell.ts:272-278`。

```ts
  redaction: { profile: "STANDARD" },
  /**
   * 【定】maxAttempts: 1 —— 不重试。
   *
   * 其他工具重试是安全的，因为它们幂等。一条 shell 命令不是：
   * 自动重试一次 `rm -rf build && make install` 意味着那条命令真的跑了两遍。
   * 重试与否交给模型，它至少知道自己刚才想干什么。
   */
  /**
   * 【定】说实话：既不幂等也不只读。
   * ……
   */
  idempotency: { isIdempotent: false, isReadOnly: false },
```

`ToolDefinition` 上不存在任何 `maxAttempts` / `retryPolicy` 字段——`types/tool.ts` 的【定】明确记录：「此前还有 `requiredCapabilities` / `retryPolicy` / `cancellation` / `concurrency` 四项……Runtime 侧零消费点」已删。全仓 `grep maxAttempts` 仅此一处注释。

这是 `idempotency` 字段上方**连续两个 JSDoc 块中的第一个**：描述一个已删除字段，且挂在别的字段声明上。处置：删除第一个注释块（「不重试」的语义已由第二个块的幂等性讨论完整覆盖）。

---

### 问题 4：`run-host.ts` 末尾的 `export { REPO_ROOT }` 死导出

**类别**：死代码。
**位置**：`apps/workagent-service/src/run-host.ts:1404`。

文件把从 `../../cli/src/compose.js` 导入的 `REPO_ROOT` 重新导出，但 `workagent-service` 内**没有任何消费者**从 `./run-host.js` 导入它：

- `main.ts:22` 直接 `import { REPO_ROOT, … } from "../../cli/src/compose.js"`；
- `server.ts:34` 只从 `./run-host.js` 导入 `RunHost` / `RunHostOptions`；
- `workspace-hosts.ts:27` 同上。

处置：删除该行（以及文件头部 import 中随之失去用途的 `REPO_ROOT`）。

---

### 问题 5：`VersionedRef<_T>` 的装饰性泛型（命名与语义不一致）

**类别**：命名/语义不一致。
**位置**：`packages/harness-runtime/src/types/ids.ts:53-56`。

```ts
export interface VersionedRef<_T> {
  id: string;
  version: string;
}
```

类型参数 `_T` 在接口体内**零引用**；全仓唯一用法是 `types/tool.ts:80` 的 `resolverRef: VersionedRef<unknown>`。这个泛型是纯签名装饰——读者会以为这个 ref 携带某种类型化载荷，实际上它只装 `id@version` 两个字符串。

同文件自己声明的纪律是「这里只放**有生产者**的 ID 类型。凭空预留一个 branded type 不会有任何东西提醒你它从来没被用过」——装饰性泛型是同精神的漏网。处置二选一：

- 删掉泛型：`export interface VersionedRef { … }`（改动最小，`types/tool.ts` 同步去掉 `<unknown>`）；
- 或真的类型化载荷（如 `interface VersionedRef<T> { id: string; version: string; payload?: T }`）——不推荐，属于为改而改。

---

### 附：格式微瑕（不计入问题）

- `packages/harness-runtime/src/facade/index.ts` 末尾 `tallyUnmetCauses` 与 `terminalToStatus` 之间有一个多余空行；
- `packages/harness-runtime/src/action/settle-batch.ts` 的 `renderError` 与 `ev` 之间同。

纯格式，无语义影响，顺手改即可。

---

## 四、查过、判定为「不是问题」的项（口径备查）

1. **大量类型导出无外部消费者**（`PolicyVerdict`、`BatchDeps`、`CompileDeps`、`BudgetAxisReading`、`RunLoopDeps` 等）——多为包公共 API 形态 + `index.ts` barrel `export *`，`verify:tools` 的边界检查也依赖包导出面；对个人项目属可接受设计，不算死代码。
2. **`parseProfile` / `maskKey` / `safeRealpath` / `outsideWorkspaceError` / `EMPTY_MCP_CONFIG` / `EMPTY_MCP_RUNTIME` / `ACTION_PRE_FINGERPRINT_KIND` / `ACTIVE_ERROR_SOURCES` 等值导出**——逐个 grep 确认均在同文件内使用，只是 `export` 关键字冗余（导出面过宽），无行为影响。不值得为它们做一轮清理。
3. **`McpServerConfig.type: "local"` 单值联合**——注释明确「v1 只有 `"local"`（stdio）。字段先留着，加 remote 时不是破坏性变更」，是协议形状预留，与 `ActionBatch.executionMode: "SEQUENTIAL"` 的【定·D-01】同一模式，不是死分支。
4. **`executionPrivilegeOf` 缺字段回落 `SANDBOXED`**——注释已论证这是「事实而非猜测」（`UNRESTRICTED` 档在该字段之前不存在），且非法值 fail-fast。与 `UNKNOWN_LEGACY`（已删）不同类，保留正确。
5. **`findOrphanResults`**——verify 脚本（pairing / progress / compact / artifact / persistence / scenarios）大量消费，非死代码。
6. **`CollectingTraceSink.byType`**——verify 脚本普遍使用，非死代码。
7. **`adapters/client.ts` 的 `readUsagePartial` / `mergeUsage` / `emptyUsage` 导出**——`verify:endpoint-profile` 在用。
8. **`store-sqlite/db.ts` 无 migration、`workspace-registry` 无 version 字段、`workspaceStorage` 唯一规则**——均为 `47b2231` 批已完成的去兼容决策，本次评审确认其落地一致（CLI 与 Web 两入口走同一条 `workspaceStorage()` 规则，无第二套路径残留）。
9. **`verify:ui` 的 `legacyTurns` 判据**——本身是「测兼容行为」的判据，随问题 1 一并处置，不单列。

---

## 五、优先级与改动量建议

| 优先级 | 问题 | 位置 | 类别 | 改动量 |
|--------|------|------|------|--------|
| P1 | 旧 Trace 兼容链（invocationId/frameId 防御 + `model-event:` fallback + 判据） | projection.ts / api-types.ts / verify/ui.ts | 历史兼容（明确不需要） | 中：三文件联动 + 判据同删 |
| P2 | `settleWallOutcome` 的 `handoff` 参数与注释 | verification/settle-outcome.ts | 死参数 + 过期注释 | 小 |
| P3 | `maxAttempts` 注释块 | tools/common/exec/run-shell.ts | 过期注释 | 极小 |
| P3 | `export { REPO_ROOT }` | apps/workagent-service/run-host.ts | 死导出 | 极小 |
| P4 | `VersionedRef<_T>` 装饰性泛型 | types/ids.ts + types/tool.ts | 命名/语义 | 极小 |

改动后建议跑：`npm run typecheck` + `npm run verify:ui`（问题 1 涉及其判据段）+ `npm run verify:scenarios`（settle-outcome 行为兜底）。

---

## 六、覆盖度声明

- `packages/`、`adapters/`、`tools/mcp/`、`apps/` 的**生产代码已逐文件读过**；
- `tools/common` 的 fs/net 细节文件（read-file / search / stat / list-dir / edit-file / write-file / fetch-url / url-guard / html-to-markdown / read-blob / request-handoff / read-guard / now / command-analysis / shell-effect-resolver / sandbox / artifact-checks）与 `eval/`、`apps/cli/src/verify/`（16 个验收脚本）为**抽样通读**——这些文件与已读部分遵循同一套注释/命名纪律，且被 `verify:tools` B 段的机械判据（文件头声明扫描、`ctx.onProgress(` 调用点扫描、schema↔handler 参数透传扫描等）覆盖，残留同类问题的概率评估为低。
- `spikes/` 按仓规不评。
