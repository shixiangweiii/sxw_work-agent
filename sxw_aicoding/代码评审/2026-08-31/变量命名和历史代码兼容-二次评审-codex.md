# Atlas 变量命名和历史代码兼容二次评审（Codex）

> 评审日期：2026-08-31  
> 评审基线：`main @ 3d6277e` 加当前未提交工作区  
> 评审方式：只读代码、差异、调用链与静态检查  
> 评审限制：未修改业务代码、测试、配置或已有评审文件

## 1. 结论

本次重构方向总体正确：migration 模块、逐行 `schemaVersion`、零生产者类型、多套 workspace 默认存储路径等历史负担已经开始收敛。

但当前结果仍为 **NO-GO**。现有实现不能证明“重构没有引入隐藏 Bug”，也没有完全满足以下目标：

- 变量名与实际运行语义一致；
- 逻辑直接、状态只有一个权威解释；
- 不保留旧 API、旧数据和旧行为兼容层；
- current-only 数据不匹配时 fail-fast，而不是静默容错、修补或回退。

本轮确认：

| 严重度 | 数量 | 结论 |
|---|---:|---|
| P1 | 4 | 阻断合入，涉及运行段生命周期、Resume 事实、Schema 严格性和 workspace 存储身份 |
| P2 | 5 | 应在本次重构内收口，涉及状态值、终止事件、旧 CLI、Artifact 身份和提交完整性 |
| P3 | 1 | 补丁静态整洁性问题 |

## 2. 评审范围与边界

本轮重点复查了以下链路：

- `HarnessRuntime.start/resume/inspect` 与主循环终止结算；
- `RunHost` 的运行段、前台槽位、取消、关闭及 UI live 投影；
- SQLite Schema、RunSpec、Transcript、Blob 和 Artifact 存储；
- workspace 注册表及 CLI/Web 的统一存储规则；
- CLI 审批参数和旧 `--yes` 行为；
- Action/Artifact Verification 与 `LoopTerminated` 事件；
- 本次删除、移动和新增的 testkit 文件。

当前工作区共涉及 97 个 tracked 文件，差异约为 `+1315/-1563`。本轮仅评审，没有运行会创建 canary、SQLite、Trace 或临时 workspace 的验收脚本。

## 3. P1 问题

### P1-1：`segmentActive` 名称与实际布尔极性完全相反

证据：

- `apps/workagent-service/src/run-host.ts:86-93`：注释定义 `segmentActive` 为“本进程这一段执行还在跑吗”；
- `apps/workagent-service/src/run-host.ts:616`：`segmentActive === true` 时跳过取消；
- `apps/workagent-service/src/run-host.ts:645-651`：`!segmentActive` 才被判断为 live；
- `apps/workagent-service/src/run-host.ts:703-709`：注释写“默认不在跑”，实际赋值 `false`；
- `apps/workagent-service/src/run-host.ts:756,788`：异常或执行结束后赋值 `true`；
- `apps/workagent-service/src/run-host.ts:844-850`：执行段开始时赋值 `false`。

当前实现的真实语义是：

```text
false = 正在执行
true  = 已经结束
```

也就是说字段实质上仍是旧的 `segmentDone`，只把名字和注释改成了 `segmentActive`。这不是单纯的可读性问题：`close()`、workspace 切换、前台槽位、历史 Run live 投影都依赖这一个布尔值。后续任何按变量字面含义维护代码的人，都可能把某一处改成“正确极性”，从而让整体逻辑部分反转。

此外，`drive()` 的 `first.done` 分支只调用 `settleRecord()`，没有显式结束运行段；一旦生成器在首个事件前正常返回，记录会继续保持当前的“false = live”状态。

退出要求：只保留一套语义。建议使用真正的 `segmentActive`：开始为 `true`，异常/完成为 `false`，所有判断都直接读取正向布尔值；不要继续保留旧 `segmentDone` 极性。

### P1-2：所谓“精确 Current Schema 校验”只比较列名，并且校验前先修改数据库

证据：

- `packages/store-sqlite/src/db.ts:262-279`：先对全部表执行 `CREATE TABLE IF NOT EXISTS`，再调用 `assertSchemaShape()`；
- `packages/store-sqlite/src/db.ts:293-312`：只读取 `PRAGMA table_info` 中的 `name` 并比较列名集合；
- `packages/store-sqlite/src/db.ts:314-322`：发现问题后抛错，但没有关闭已经打开的连接。

当前断言不能证明数据库就是当前 Schema：

1. 缺失的当前表会先被自动创建，部分旧库或损坏库可能被隐式“补齐”；
2. 同名列的类型、`NOT NULL`、默认值、主键位置都不校验；
3. 外键、唯一约束和索引定义不校验；
4. 同名但定义错误的索引会被 `CREATE INDEX IF NOT EXISTS` 静默接受；
5. 多余旧表，包括 `schema_migrations`，不会被识别；
6. 检查失败前数据库可能已经发生结构变化。

这仍是一种隐式兼容/修补机制，与“非空数据库必须精确匹配当前 Schema，否则删库重建”的 current-only 目标不一致。

退出要求：先区分空库和非空库。空库可以创建当前 Schema；非空库必须在任何 DDL 之前校验完整表集合、列定义、约束、外键和索引，失败时关闭连接并提示删除数据库。这里不需要 migration。

### P1-3：Transcript JSON 损坏仍被静默吞掉，Resume 会把关键事实当成空值

证据：

- `packages/store-sqlite/src/transcript-store.ts:131-158`：`payload_json` 解析失败后回落为 `{}`，随后返回一条没有 payload 的记录；
- `packages/harness-runtime/src/facade/index.ts:287-298`：Resume 从这些记录重建消息和事实，缺失的 `verifications`、`recoveryItems`、`artifactChecks` 全部回落为空数组；
- `packages/harness-runtime/src/facade/index.ts:790-802`：Inspect 对缺失 RUN_META 继续回落到零计数和空预算。

被静默丢弃的 payload 可能是：

- `MESSAGE`：恢复上下文缺消息；
- `RUN_META`：预算、验证事实、恢复项和序号下界被重置；
- `ACTION_FACT`：执行前指纹消失，Resume 三分支选择发生变化；
- `COMPACT_BOUNDARY`：压缩后的上下文重建不完整。

因此，一条损坏的当前数据不会明确失败，而会被解释成“这些事实从未存在”。这比直接报错更危险，也与本次删除逐行版本兼容层的理由相冲突。

退出要求：current-only 模式下解析失败必须携带 `runId`、`sequence`、`kind` 立即抛错。不要跳过坏行，也不要为其构造空 payload。

### P1-4：workspace 注册表仍会保留旧 `dbPath/traceDir`

证据：

- `apps/workagent-service/src/workspace-registry.ts:221-226`：加载时只检查 `workspaces` 是数组，旧 `version` 和其他额外字段都会被接受；
- `apps/workagent-service/src/workspace-registry.ts:152-158`：已有 workspace 再次登记时只更新时间和名称，不按 `workspaceStorage()` 重算存储路径；
- `apps/workagent-service/src/workspace-hosts.ts:138-145`：创建 RunHost 时直接使用注册表中的 `dbPath/traceDir`。

因此，旧 `workspaces.json` 中指向 `.workagent-state/runs.db` 或其他历史路径的记录仍会继续生效，绕过新的唯一规则：

```text
<workspace>/.workagent/runs.db
<workspace>/.workagent/runs/
```

删除 `version` 校验并没有让格式更 current-only，反而让旧注册表更容易被接受。

退出要求：注册表是可重建产品状态，不需要迁移。应严格验证当前形状并拒绝旧格式，或者忽略持久化的派生路径、始终由 `realPath` 重新计算当前存储位置。

## 4. P2 问题

### P2-1：已经删除的 `CREATED` 状态仍由服务层伪造

证据：

- `packages/harness-runtime/src/types/run.ts:240-258`：`RunStatus` 明确删除 `CREATED`；
- `apps/workagent-service/src/run-host.ts:267`：详情接口仍使用 `getStatus(id) ?? "CREATED"`；
- `apps/workagent-service/src/api-types.ts`：服务 API 将 status 放宽为 `string`，所以类型检查无法发现非法状态。

这既是旧状态兼容残留，也会掩盖“RunSpec 存在但状态行缺失”的数据库不一致。`detail()` 此前已经获得 `runtime.inspect()` 的 snapshot，没有必要第二次查询并发明一个默认状态。

退出要求：直接使用 `snapshot.status`；若权威状态缺失则显式报数据库不一致，不得再产生 `CREATED`。

### P2-2：`COMPLETED_WITH_LIMITS` 的 Terminal 与 Outcome 相互矛盾

证据：

- `packages/harness-runtime/src/loop/run-loop.ts:874-885`：先调用 `settleOutcome()` 取 kind，随后为 Terminal 写入 `incompleteItems: []`；
- `packages/harness-runtime/src/loop/run-loop.ts:300-310`：`finish()` 又调用一次 `settleOutcome()`，生成真正带未完成项的 Outcome；
- `packages/harness-runtime/src/types/event.ts:21`：两者被同时放入同一条 `LoopTerminated` 事件。

结果可能是：

```text
terminal.reason = COMPLETED_WITH_LIMITS
terminal.incompleteItems = []
outcome.incompleteItems = [真实未完成项...]
```

注释声称是在消除重复计算，但当前仍然结算两次，同时制造了两个互相矛盾的事实载体。

退出要求：只保留一个权威结构。若未完成项属于 Outcome，就从 Terminal 类型中删除；若 Terminal 必须携带，则必须传入同一份结算结果，不能填空数组。

### P2-3：旧 `--yes` API 仍被兼容、宣传并保留旧变量名

证据：

- `apps/cli/src/main.ts:92-135`：参数解析器没有允许参数集合，也不拒绝未知参数，因此 `--yes` 会被静默忽略；
- `apps/cli/src/main.ts:145-147`：默认有限自动放行仍命名为 `autoYes`；
- `apps/cli/src/main.ts:276-286`：终端输出继续显示 `(--yes)` 和“`--yes` 不覆盖这一步”；
- `README.md:50`：明确写着“`--yes` 保留只为不破坏既有命令行”。

这正是本次要求删除的旧 API、旧行为和旧命名兼容层。当前实际档位是：默认有限 auto-grant、`--confirm` 逐次询问、`--yes-all` 无条件放行，与 `--yes` 已没有关系。

退出要求：删除 README 和运行输出中的 `--yes`；把 `autoYes` 改为描述真实策略的名字；解析器应拒绝所有未知参数，使旧命令明确失败。

### P2-4：Artifact 去重身份仍缺少 `kind` 和 `path`

证据：

- `packages/store-sqlite/src/artifact-store.ts:65-105`：复用旧 Artifact 时只比较 `content_hash`、`run_id` 和 `role`；
- `packages/harness-runtime/src/action/settle-batch.ts:676-694`：调用方传入 `kind/path`，随后使用 Store 返回的 record 决定检查器和磁盘路径。

同一 Run、同一 logicalId、同一 role、同一字节，如果 `kind` 或 `path` 被更正，Store 会返回旧记录。后续 ArtifactChecker 将继续按旧 kind 或旧路径检查，登记事件也会继续报告旧元数据。

退出要求：会改变验证语义的 `kind` 和 `path` 必须参与复用判定；不同则形成新版本。相应验收应覆盖“字节相同但 kind/path 改变”的反例。

### P2-5：当前变更集尚未形成可提交的自洽补丁

证据：

- tracked 删除：`packages/testkit/src/fake-clock/index.ts`；
- tracked 删除：`packages/testkit/src/deterministic-id-generator/index.ts`；
- `packages/testkit/src/index.ts` 已改为导出 `./clock/index.js` 和 `./id-generator/index.js`；
- 新实现 `packages/testkit/src/clock/index.ts`、`packages/testkit/src/id-generator/index.ts` 当前仍是 untracked。

当前工作区类型检查通过，是因为两个 untracked 文件确实存在；但若使用 `git commit -a`，提交不会包含它们，得到的仓库会直接编译失败。

退出要求：在提交前确保新增替代文件进入同一个变更集，并以提交候选快照重新运行类型检查。

## 5. P3 问题

### P3-1：补丁静态整洁性检查未通过

`git diff --check` 报告：

```text
eval/graders/archive-inventory.ts:218: new blank line at EOF.
```

这不是运行时缺陷，但说明当前补丁尚未达到干净可提交状态。

## 6. 无写入检查结果

### 6.1 通过

```text
npm run typecheck
> tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json
exit 0
```

该结果证明当前工作区在 untracked 新文件存在的情况下通过 TypeScript 与 unused 检查；它不能证明布尔极性、SQL Schema、Resume 事实和兼容层行为正确。

### 6.2 未通过

```text
git diff --check
eval/graders/archive-inventory.ts:218: new blank line at EOF.
exit 2
```

### 6.3 未执行

为遵守“仅做评审，不新增修改任何文件”，本轮未执行会创建或修改以下内容的验收：

- SQLite 数据库；
- Trace JSONL；
- canary 文件；
- 临时 workspace 或产物文件。

因此，本报告没有把现有文档中“所有 verify 全绿”的陈述当作本轮独立验证结果。

## 7. 建议退出顺序

1. 统一 `segmentActive` 的正向语义，并覆盖开始、首事件异常、首个 `done`、后台完成、取消和 `close()`；
2. 把 SQLite 打开流程改为“空库创建、非空库先完整验证”，删除任何隐式补库行为；
3. Transcript payload 解析失败直接 fail-fast，不再构造空记录；
4. workspace 注册表不再信任旧派生路径，确保存储位置只有一个计算来源；
5. 删除服务层 `CREATED` 回退和 CLI `--yes` 兼容面；
6. 收敛 Terminal/Outcome 与 Artifact identity；
7. 补齐 tracked 新文件，重新执行 `typecheck`、`git diff --check` 和相关判别力验收。

## 8. 最终判定

当前重构已经显著减少死字段和历史设计空壳，但仍存在“名称换了、旧极性没换”“声称严格校验、实际继续容错”“声称删除旧 API、文档与解析仍保留”等典型半清理状态。

在 4 个 P1 完成修复并通过有判别力的反例验证前，本轮建议维持 **NO-GO**，不要把当前工作区作为 current-only 清理完成版合入。
