# 图片打包任务问题优化二次代码评审

## 1. 评审信息

- 评审日期：2026-08-31
- 评审对象：针对“下载指定 Bilibili 动态页面全部图片并打包为 `images.zip`”评测问题所做的未提交代码优化
- 原任务页面：`https://www.bilibili.com/opus/1086460081202003973?spm_id_from=333.1387.0.0`
- 原任务工作空间：`/Users/shixiangweii/Desktop/temp`
- 原任务产物：`/Users/shixiangweii/Desktop/temp/images.zip`
- 代码仓库：`/Users/shixiangweii/WebstormProjects/sxw_work-agent`
- 评审基线 HEAD：`e5c8d05829f123a195582433c9b60627842cd758`
- 评审方式：仅审查当前源码、未提交 diff、验证脚本和文档；不修改代码，不运行会创建工作区、SQLite、Trace 或 canary 文件的验收脚本
- 前次评审材料：`/Users/shixiangweii/WebstormProjects/sxw_work-agent/评测/图片打包任务-评审-codex.md`

## 2. 总体结论

**结论：有实质改进，但若目标是关闭前次图片打包评测暴露的关键问题，当前仍为 NO-GO。**

本批修改已经接通最小正向链路：

```text
run_shell
  → 声明 artifact_path / artifact_role
  → 读取真实 Uint8Array 字节
  → SqliteArtifactStore 计算字节 hash / size
  → CommonArtifactChecker
  → ArtifactVerified
  → deliveredArtifactIds
```

因此，不能再把当前实现评价为“ZIP 完全游离在 Artifact/Verification 体系之外”。但当前闭环仍是**有条件的正向闭环**：只要模型正确声明路径、命令返回 0、目标文件恰好是本次生成且之后不再变化，系统就能登记和验证；一旦产物遗漏、声明失败、复用旧文件、跨 Run 去重、验证后漂移或 ZIP 内部损坏，终态仍可能被错误地判为 `SUCCESS`。

本次评审区分两个层次：

1. 原始外部任务是否产出了用户可用的 `images.zip`：前次人工检查结果符合预期。
2. Atlas 是否能从机制上证明“这是本 Run 新生成、完整、可解压、最终未漂移且应当交付的 ZIP”：当前仍不能完整证明。

## 3. 已确认有效的优化

### 3.1 二进制 Artifact 字节通道已经接通

`ArtifactContent` 已从纯字符串扩展为 `string | Uint8Array`，`run_shell` 能读取声明文件的真实字节并返回 `ProducedArtifact`；SQLite Store 和 ArtifactChecker 也改为基于真实字节计算大小与 SHA-256。

主要证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/harness-runtime/src/ports/index.ts`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/store-sqlite/src/artifact-store.ts`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/artifact-checks/index.ts`

这项修改解决了 ZIP 不能通过字符串通道可靠保存、计算 hash 和验证的核心类型墙问题。

### 3.2 正向 ZIP Artifact 链路具备真实判别力

新增 H1 验证不是简单的 mock 或字符串计数：它通过真实 `run_shell`、真实 `zip`、沙箱路径和磁盘文件，比较磁盘字节、Artifact Store 字节、hash 与 size。该验证能够证明正向通路确实已接通。

主要证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/cli/src/verify/artifact.ts`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/index.ts`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/harness-runtime/src/action/settle-batch.ts`

### 3.3 Web 起跑的 task 与 origin 修复有效

Web 启动时，`pendingTask` 在首个 Trace 事件前已经可用，避免 trace header 写入 `task:"(未知)"`；RunSpec 的 `origin.kind` 也能写为 `WEB`。新增 UI 验证覆盖了真实 HTTP、数据库和 Trace 文件。

主要证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/workagent-service/src/run-host.ts:493`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/cli/src/compose.ts:617`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/cli/src/verify/ui.ts`

### 3.4 `$TMPDIR` 描述与沙箱事实已经统一

工具说明明确了 `/tmp` 在沙箱内不可直接写、应使用 `$TMPDIR`，且 `$TMPDIR` 不跨 tool call 共享。相关 shell 验证同时检查了允许路径与拒绝路径，具备双向判别力。

主要证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:134`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/cli/src/verify/shell.ts`

### 3.5 审批展示和 effect 摘要有所改善

CLI/Web 审批面已展示完整命令、联网标志、`artifact_path` 与 role；命令分析也会过滤典型引号碎片、纯标点和带 `://` 的 URL token，原任务中的 CDN URL 不再污染 effect scope。

这项结论仅适用于 Action/Approval 的 effect 摘要，不代表完整 tool input 已从 Transcript 中脱敏。

主要证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/cli/src/main.ts:219`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/workagent-service/src/human-channels.ts`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/command-analysis.ts`

## 4. 阻断性问题

### P1-1：Artifact 缺失或声明失败，Run 仍可能返回 SUCCESS

#### 证据

- `artifact_path` 仍是可选参数：
  `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:168-201`
- 未声明路径时直接返回空 Artifact 结果：
  `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:583-584`
- 路径不存在、目录、越界或过大时只返回 `artifactNote`：
  `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:591-620`
- Runtime 只在 `outcome.artifact` 存在时登记 Artifact：
  `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/harness-runtime/src/action/settle-batch.ts:669`
- 没有 Artifact 检查且没有其他 required failure 时，结算仍可成功：
  `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/harness-runtime/src/verification/settle-outcome.ts:94-98`

#### 可触发场景

用户要求生成 `images.zip`，模型执行下载/打包命令但没有提供 `artifact_path`，随后直接停止。Runtime 得不到 ArtifactFact，也没有 required check 失败，最终仍可能得到：

```text
artifacts = 0
deliveredArtifactIds = []
outcome = SUCCESS
```

#### 评审判断

这是前次评测“Runtime SUCCESS 不等于任务正确完成”的核心问题，当前只解决了模型正确声明时的正向路径，没有关闭失败出口。

#### 退出条件

- 任务或 RunSpec 能表达“本 Run 必须交付 Artifact”的契约；
- 声明缺失、读取失败、越界、过大等情况产生结构化失败事实；
- 结算阶段在 required deliverable 缺失时不能返回 `SUCCESS`；
- H2 必须断言最终 Outcome，而不只是断言“未登记 + 有提示”。

### P1-2：运行前已存在的旧文件可以被冒认为本 Run 产物

#### 证据

`collectDeclaredArtifact` 只在命令退出后检查文件是否存在、大小是否合法并读取内容，没有执行前快照、前置 hash 或本次写入归因：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:578-630`

#### 可触发场景

1. workspace 中已经存在上一次任务留下的合法 `images.zip`；
2. 本次命令执行 `true`，或前段失败但最终退出码为 0；
3. 声明 `artifact_path:"images.zip"`；
4. 旧 ZIP 被登记、验证并交付为本 Run 的新产物。

这意味着原评审指出的固定名称碰撞、残留目录和旧 ZIP 复用风险仍然存在。

#### 退出条件

- 明确区分“生成新 Artifact”与“交付现有 Artifact”两种语义；
- 对“生成新 Artifact”记录执行前不存在证明或前后指纹变化；
- 验证失败命令、部分下载、旧文件复用和同名覆盖场景。

### P1-3：Artifact 验证后仍可漂移，结算前没有最终复验

#### 证据

- 结算只汇总历史 `ArtifactCheckFact`：
  `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/harness-runtime/src/verification/settle-outcome.ts:42-97`
- UI 预览时才重新计算路径、大小和 hash 漂移：
  `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/workagent-service/src/run-host.ts:451-470`

#### 可触发场景

第一步生成并验证 `images.zip`；第二步通过未声明 Artifact 的 shell 修改或删除同一路径。最终结算仍可能交付旧 ArtifactId 并返回成功，直到用户手工打开预览才发现漂移。

#### 退出条件

- 在 Outcome 落定或交付前复验 deliverable 的当前字节/hash；或
- Artifact 登记后复制到不可变、内容寻址的受控存储，交付物不再依赖可变 workspace 路径。

### P1-4：Artifact Store 跨 Run、跨 role 复用旧记录

#### 证据

Artifact Store 按 `logical_id` 查询最新记录，并在 content hash 相同时直接返回旧记录；判断没有包含当前 `runId`、`role`、`kind`、`path` 或 `derivedFrom`：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/store-sqlite/src/artifact-store.ts:65-80`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/store-sqlite/src/migrations/index.ts:190-210`

Runtime 随后使用 Store 返回记录的 role 和 ID 生成事实：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/harness-runtime/src/action/settle-batch.ts:669-707`

#### 影响

- 第二个 Run 生成相同路径和内容时可能获得第一个 Run 的 ArtifactId；
- 当前 Run 的 `listByRun` 查不到交付物；
- UI 因 Artifact 不属于当前 Run 而拒绝预览；
- 同一 Run 将相同字节从 `INTERMEDIATE` 晋升为 `DELIVERABLE` 时，可能继续保留旧 role。

#### 退出条件

- 将“内容相同”与“Run 内 Artifact 实例身份”分开建模；
- 内容 blob 可以按 hash 去重，但 Artifact record 必须保留本 Run、本 role 和本路径的独立 provenance；
- 增加跨 Run 相同内容、同 Run role 晋升的回归测试。

### P1-5：`zip-opens` 没有证明 ZIP 真能解压

#### 证据

当前检查只验证：

1. 文件前两个字节为 `PK`；
2. 最后约 66 KiB 中存在 EOCD 签名。

位置：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/artifact-checks/index.ts:233-252`

它没有验证 local header、中央目录、entry 偏移、压缩数据、CRC、条目数量或路径安全。

#### 影响

`PK + 任意垃圾数据 + 伪造 EOCD`、压缩数据损坏或 CRC 错误的文件仍可能通过 `zip-opens`，被标记为 Verified 并进入交付结果。工具说明宣称“zip 能不能解开”，高于实际保证。

#### 退出条件

- 使用可靠 ZIP 解析/解压实现逐条读取并验证 CRC；
- 加入损坏压缩数据、伪造 EOCD、目录偏移错误、路径穿越条目等负例；或
- 在实现真正解压验证前降低检查名称和对外承诺。

### P1-6：`fetch_url` 重定向 SSRF 仍未关闭

#### 证据

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/net/fetch-url.ts:193-229`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/net/url-guard.ts:71-87`

当前 `redirect:"follow"` 会先跟随并发送请求，之后才检查 `res.url`：

- `public → private`：内网 GET 已发生，之后拒绝已经太晚；
- `public → private → public`：最终 URL 是公网地址，中间内网请求完全不可见；
- Guard 与 fetch 分别解析 DNS，仍存在 rebinding/TOCTOU 窗口；
- 已经发生请求的拒绝分支仍可能标记 `sideEffectState:"NO_EFFECT"`。

该问题虽然不是本次 Artifact 正向链路的新增回归，但仍是前次安全评审的未关闭 P1，不能随本批优化一起宣告关闭。

## 5. 其他高优先级残余问题

### P2-1：下载失败关闭仍主要依赖工具说明

`run_shell` 描述增加了 `set -euo pipefail`、`curl --fail`、下载数量断言等建议，这是有价值的模型引导，但并非 Runtime 机制：模型仍可以忽略，系统也不会自动证明页面图片数与成功下载数一致。

当前缺少以下验收场景：

- HTTP 404/403/5xx；
- shell loop 或 pipeline 前段失败、最终退出 0；
- 部分图片下载成功后仍生成 ZIP；
- workspace 中存在旧图片目录或旧 ZIP；
- 同名产物复用与覆盖；
- 页面发现数量、下载成功数量、ZIP entry 数量三方不一致。

证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:134-165`

### P2-2：provenance 只修好了纯 Web start

Web start 的原始 task 和 `origin.kind="WEB"` 已修复，但更一般的执行段 provenance 尚未完整建模：

- CLI trace header 没有 `entry` 字段；
- CLI Resume 的 header task 仍可能来自 `args.task` 默认值，而非原 RunSpec；
- RunSpec origin 表示 Run 的创建入口，Trace entry 表示当前执行段入口，跨入口 Resume 时两者本来就可以不同；
- 现有 UI 验证只覆盖纯 Web start，没有覆盖 CLI 创建、Web Resume 或 CLI/Web 跨入口恢复。

证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/cli/src/main.ts:368-385`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/cli/src/trace/file-sink.ts:34-53`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/workagent-service/src/run-host.ts:883-900`

### P2-3：role 与交付集合没有完整贯通 UI/Outcome

当前结算会把通过检查的 Artifact 加入 `deliveredArtifactIds`，没有依据 `INTERMEDIATE`/`DELIVERABLE` 明确过滤；另一方面，服务端暴露给 UI 的 Outcome 又没有包含精确的 `deliveredArtifactIds`，UI 只能列出 Run 下全部 Artifact，不能可靠区分 Runtime 最终交付集合。

证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/packages/harness-runtime/src/verification/settle-outcome.ts:152-155`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/workagent-service/src/api-types.ts:371-376`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/workagent-service/src/run-host.ts:350-360`

### P2-4：工具协议变化但版本未升级

`run_shell` 新增 Artifact schema 和字节产物行为，`write_file` 的 Artifact kind 行为也发生变化，但工具版本仍为 `1.0.0`。ToolSnapshot 仍记录为旧版本，旧 Run Resume/Replay 无法检测语义漂移。

证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:108-110`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:686-690`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/fs/write-file.ts`

### P2-5：CLI 最终审批提示仍未清洗

CLI 已清洗命令和描述，但真正等待用户输入的最后一行仍直接插入原始 `e.scope.value`。模型生成的 token 如果包含 ANSI、光标或双向文本控制符，仍可能在净化后的命令展示之后清屏、覆盖或重排审批内容。Web 入口已经清洗，两个入口的安全语义不一致。

证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/cli/src/main.ts:219-241`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/apps/workagent-service/src/human-channels.ts:171-184`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/command-analysis.ts:250-259`

### P2-6：大 Artifact 读取期间的 timeout/cancel 生命周期不严谨

shell `close` 后会异步读取 Artifact；timer 和 abort listener 要到 `finish()` 才清理。命令临近超时退出时，读取大文件期间 timer 仍可能对已经退出的负 PID 调用 `killTree()`，且读回过程不响应取消。当前 256 MiB 上限还会产生多次整块读取/复制，峰值内存明显高于文件本身。

证据：

- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:415-450`
- `/Users/shixiangweii/WebstormProjects/sxw_work-agent/tools/common/src/exec/run-shell.ts:470-566`

## 6. 验证脚本覆盖评审

### 6.1 有效覆盖

- H1 使用真实 shell/zip 和磁盘字节，能够证明二进制正向链路；
- `$TMPDIR` 测试包含允许和拒绝两侧；
- Web origin/task 测试经过真实 HTTP、DB 和 Trace，而非纯 helper 测试；
- effect parser 覆盖了原任务中典型 CDN URL 和引号碎片。

### 6.2 仍缺少的判别性断言

- H1 没有完整断言注册、验证、存储和最终交付使用的是同一个 ArtifactId；
- 没有断言 `logicalId`、role、Store 数量和数据库 verified 状态；
- H2 没有断言最终 Run Outcome 必须失败；
- 没有预先存在文件、验证后覆盖/删除、跨 Run 相同内容、role 晋升测试；
- ZIP 负例只覆盖缺 EOCD，没有覆盖伪 EOCD、CRC 和压缩数据损坏；
- CLI/Web 审批展示新增了 artifact 声明，但 H1 使用自动批准 stub，没有覆盖真实交互展示；
- 没有本次 Bilibili 下载任务的二次实跑证据，无法证明提示词在真实模型下会稳定执行 fail-closed 流程。

## 7. 前次问题关闭矩阵

| 前次问题 | 本次状态 | 二次评审判断 |
|---|---|---|
| `$TMPDIR` 与沙箱口径不一致 | 已修 | 文案、审批和测试基本一致 |
| ZIP 未进入 Artifact 字节链路 | 部分关闭 | 正向路径已接通，缺失/失败出口未闭环 |
| Runtime SUCCESS 与交付正确性脱节 | 未关闭 | required deliverable 缺失仍可能成功 |
| 固定文件名和旧文件碰撞 | 未关闭 | 没有执行前指纹与本次生成证明 |
| ZIP 是否真正可解压 | 未关闭 | 当前只做 magic/EOCD 浅检查 |
| Web task/origin 错误 | 部分关闭 | 纯 Web start 已修，跨入口 Resume 未完整覆盖 |
| effect 摘要包含 URL 噪声 | 基本关闭 | 典型 URL 已清理，但不等于 Transcript 脱敏 |
| 下载失败仍继续打包 | 未关闭 | 主要依赖提示词，没有机制性闸门 |
| `fetch_url` 重定向 SSRF | 未关闭 | 请求后检查最终 URL，无法阻止中间私网访问 |

## 8. 验证边界

本次执行了以下不落盘检查：

```text
./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
git diff --check
```

结果均通过：

- TypeScript 当前源码可以完成无输出编译；
- 当前 diff 没有空白符错误。

遵照“仅做评审，不要新增修改任何文件”的原始评审约束，本轮代码评审期间没有运行 `verify:*`，因为相关脚本会创建临时 workspace、SQLite、Trace、artifact 或安全 canary。因此：

- 本报告确认的是源码链路、schema、终态语义和验证脚本设计；
- 不把 noEmit 编译视为真实模型、真实网络、真实浏览器或正式验收通过；
- 不把新增验证脚本的源码存在等同于本轮已经实际执行通过。

## 9. 建议的退出门槛

在把本次问题标记为“已关闭”之前，至少需要满足：

1. required deliverable 缺失、读取失败或声明失败必然导致非 SUCCESS；
2. Artifact 能证明是本 Run 新生成，不能复用运行前旧文件冒认；
3. Artifact identity 与内容去重拆分，跨 Run 和 role provenance 正确；
4. 最终交付前复验，或将交付字节固化到不可变存储；
5. ZIP 检查真实解析/解压并校验 CRC、目录和路径安全；
6. 下载发现数、成功数和 ZIP entry 数具备结构化一致性证据；
7. 覆盖 HTTP 失败、部分下载、旧文件、后续覆盖和跨 Run 复用负例；
8. `fetch_url` 手动逐跳处理重定向，每一跳在发请求前完成目标与 DNS 校验；
9. CLI/Web/Resume 的 origin、entry、task 语义分别建模并完成跨入口测试；
10. 使用真实 Atlas 再执行一次同类图片打包任务，审计 Trace、Artifact、Outcome、ZIP 内容与最终工作空间状态。

## 10. 最终意见

本批代码不是表面修补：二进制 Artifact 通道、真实字节 hash、正常 ZIP 正向链、Web 起跑 provenance、`$TMPDIR` 口径和审批展示都有明确进展。

但当前系统仍然只能证明“在模型正确声明且文件状态理想时，某个 ZIP 可以进入 Artifact 链”，还不能证明“用户要求的 ZIP 必须存在、确由本次 Run 生成、内容真实可解压、最终没有漂移且 provenance 属于本 Run”。因此本次二次评审维持：

> **有实质进展；正向链路通过；关键失败出口与交付语义未闭环；暂不建议关闭前次评测问题。**
