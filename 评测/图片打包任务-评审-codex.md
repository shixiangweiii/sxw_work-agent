# 图片打包任务执行评审（Codex）

> 报告整理日期：2026-08-31（Asia/Shanghai）  
> 实际运行日期：2026-08-30（Asia/Shanghai）  
> 被测代码：`e5c8d05829f123a195582433c9b60627842cd758`（运行时 `gitDirty=false`）  
> RunId：`run_75f0d6afafa6`  
> 模型 / 端点：`qwen3.7-plus` / `epcp_bailian_anthropic_qwen37plus@1755907200000`  
> 任务入口：Atlas Web  
> 工作空间：`/Users/shixiangweii/Desktop/temp`  
> 目标产物：`/Users/shixiangweii/Desktop/temp/images.zip`  
> 评审性质：单次真实任务的只读复盘；不是通用网页下载能力榜单，也不是阶段退出验收  
> 变更边界：评审期间未修改产品代码、运行证据或任务工作空间；本文件是本次 Codex 操作唯一新增的正式报告

## 1. 结论摘要

**本次任务的实际结果判定为 PASS；Atlas 的内部 Artifact / Verification 自证链判定为未闭合。**

结论必须拆成三个层次：

| 层次 | 判定 | 含义 |
|---|---|---|
| Runtime 终态 | `COMPLETED / SUCCESS` | 运行正常结束，模型不再请求工具，且没有“已要求但失败”的验证事实 |
| 外部任务结果 | **PASS** | `images.zip` 真实存在、结构安全、11 张图片完整有效，并与目标页面的文章内容图片逐字节匹配 |
| Atlas 内部交付验证 | **未通过** | DB 中没有 Artifact，13 次 Verification 全部 `SKIPPED`，终态 `deliveredArtifactIds=[]` |

因此：

1. 若验收问题是“用户这次是否拿到了正确的 `images.zip`”，可以通过。
2. 若验收问题是“Atlas 的 `SUCCESS` 是否足以证明这个 ZIP 正确”，不能通过。
3. 若要把本次样本作为“通用网页图片下载并打包能力已经稳定、可验证”的阶段退出证据，当前为 **NO-GO**；它只能证明这一次在外部后验审计下结果正确。

本报告不提供通用能力分数。原因是只有 1 次任务样本，没有冻结网页快照、重复 trial 或独立运行时 grader，给出百分制会制造不成立的稳定性含义。

## 2. 任务与评审范围

### 2.1 原始任务

从以下 Bilibili 动态页下载文章内容图片，并打包为 `images.zip`：

- 目标页面：<https://www.bilibili.com/opus/1086460081202003973?spm_id_from=333.1387.0.0>
- 工作空间：`/Users/shixiangweii/Desktop/temp`
- 目标产物：`/Users/shixiangweii/Desktop/temp/images.zip`

页面当前身份为：

- 标题：`rioko凉凉子 - 七省`
- 关联文章：`cv42221352`
- 作者：`椰酥Milk`
- 文章内容图片：1 张封面 + 10 张正文图

### 2.2 本次评审核对的证据

| 证据 | 路径或标识 |
|---|---|
| 运行 Trace | `/Users/shixiangweii/Desktop/temp/.workagent/runs/run_75f0d6afafa6.jsonl` |
| Trace SHA-256 | `253db4ed9feae2fe6e1b6d69b6c21764790f822a2b15f4e1bb25d3243fa001aa` |
| SQLite | `/Users/shixiangweii/Desktop/temp/.workagent/runs.db` |
| SQLite SHA-256 | `595c04d43e17ca4e4448389289c294f8dab86e70a8db61efdd19549960f4ecdd` |
| 目标 ZIP | `/Users/shixiangweii/Desktop/temp/images.zip` |
| ZIP SHA-256 | `a6bd06a4170808eec0207de131071a41556fe1711731263a53cc61003a6a0d0e` |
| 用户事后解压目录 | `/Users/shixiangweii/Desktop/temp/images/` |
| 运行代码 | 当前仓库 HEAD `e5c8d05829f123a195582433c9b60627842cd758` |
| 当前页面对照 | 页面 DOM、Bilibili 动态/文章 API、11 个 CDN 原始图片响应 |

SQLite `PRAGMA integrity_check` 为 `ok`，外键检查无异常。workspace、Trace、SQLite、RunId 和代码提交可以相互对应。

没有找到独立的 stdout/stderr 日志文件；完整工具参数、返回值和 stdout/stderr 保存在 SQLite transcript 中，Trace 保存高层运行事件。不能把“没有独立日志文件”表述为“日志完全缺失”。

### 2.3 证据边界

1. 页面比对是评审时对当前页面的只读核验。网页内容未来可能变化，因此 ZIP 与页面的严格集合关系是本次评审时点的结论。
2. 运行前没有冻结 workspace 快照，不能严格证明 `images.zip`、`images_dir` 或 `bili_article.html` 在任务开始前一定不存在。
3. 当前 `images/` 目录的创建时间晚于 Run 终态，且 Run 删除的是 `images_dir`，可以判断 `images/` 是用户事后解压结果，不是 Atlas 生成的第二份交付物。
4. 本任务没有触发 Blob、Resume、Handoff 或崩溃恢复，不能用它评价这些机制。

## 3. 运行事实与性能

### 3.1 基本运行数据

| 指标 | 实际值 | 配额 |
|---|---:|---:|
| 总墙钟时间 | 127,832 ms | — |
| Active wall-clock | 103,899 ms | 600,000 ms |
| Turn | 14 | 20 |
| 模型调用 | 14 | 40 |
| 工具调用 | 13 | 100 |
| 计费输入 Token | 144,442 | 1,500,000 |
| 输出 Token | 4,329 | 200,000 |
| Shell 审批 | 10 次，全部批准 | — |
| 审批等待总时长 | 23,932 ms | 不计入 active wall-clock |

模型调用累计约 85.3 秒，工具执行累计约 16.2 秒。审批等待与 active wall-clock 的差值能够解释总体墙钟时间；没有预算软碰撞、硬碰撞、NoProgress 或 RuntimeError。

对一个单页下载打包任务而言，14 次模型调用、13 次工具调用和约 144k 计费输入偏重。主要浪费发生在 API 已经返回文章身份和图片摘要后，仍进行了多轮 HTML 保存及正则试探，并手工组织 11 个 URL。

### 3.2 执行时间线

| 阶段 | 工具与结果 | 评审判断 |
|---|---|---|
| 1 | `fetch_url(raw)` 返回 HTTP 200，但正文是 Bilibili 验证码页 | 正确识别为业务失败，而非把 HTTP 200 当作内容成功 |
| 2 | `fetch_url(markdown)` 仍得到“验证码_哔哩哔哩” | 继续恢复合理 |
| 3 | 动态 API 返回 HTTP 200、业务码 `-352` | 正确区分传输成功与业务失败 |
| 4 | 经审批使用浏览器 UA 的 `curl`，获得文章 ID、标题、封面及正文摘要 | 找到可用公开数据源 |
| 5 | 读取文章 API，确认 10 个正文图片占位和 1 个封面 URL | 已具备直接结构化解析的基础 |
| 6 | `grep -P | sort` 在 macOS 上因 `grep -P` 不支持而报错，但管道最终退出码为 0 | 失败被末端 `sort` 掩盖 |
| 7 | 尝试跨 shell 使用 `/tmp/bili_article.html`，`wc` 返回 exitCode 1 | 每次 shell 使用独立私有 TMPDIR；高层仍按“命令事实已返回”记录 Attempt 成功 |
| 8 | 改在 workspace 保存 `bili_article.html`，大小 53,898 bytes | 模型完成自恢复 |
| 9–11 | 多次 URL 正则试探，最终获得 11 个唯一 `bfs/new_dyn` 图片 URL | 结果正确，但路径冗长 |
| 12 | 循环下载 11 张图片至 `images_dir` | 实际下载结果完整，但命令缺少 fail-fast 和内容校验 |
| 13 | `zip -r ../images.zip *.jpg`，随后删除 `images_dir` 和 `bili_article.html` | ZIP 实际正确；运行内没有执行 ZIP 完整性验证 |
| 14 | 模型输出完成摘要 | Runtime 结算为 `COMPLETED / SUCCESS` |

### 3.3 恢复与交互表现

本次模型连续遇到了验证码、API `-352`、`grep -P` 兼容性错误和 `/tmp` 跨调用不可见，最终都完成恢复，没有陷入重复循环。

10 条 shell 命令均进入人工审批。Web 审批界面展示经过控制字符清理的完整命令、说明和联网状态，因此本次不是“只看到抽象 effect 的盲批”。外部网页内容进入上下文后，后续 13 个 Turn 均带有 `hasExternalUntrusted=true`，不可信来源标记正常。

## 4. 产物独立审计

### 4.1 ZIP 结构与安全性

| 检查项 | 结果 |
|---|---|
| ZIP 文件大小 | 58,684,991 bytes |
| 条目数量 | 11 |
| 条目名称 | `image_01.jpg` 至 `image_11.jpg` |
| 解压后总字节数 | 60,949,629 bytes |
| CRC | `unzip -t` 11/11 通过 |
| JPEG 完整解码 | 11/11 通过 |
| JPEG EOI | 11/11 存在 |
| 文件权限 | 均为普通 `0644` 文件 |
| 加密 | 无 |
| 路径安全 | 无绝对路径、`..`、反斜杠、控制字符或嵌套路径 |
| 特殊文件 | 无软链接、目录项或非图片项 |
| 内容唯一性 | 文件名 11/11 唯一，内容 SHA-256 11/11 唯一 |
| ZIP 与用户解压目录 | 11/11 逐字节一致 |

压缩率约 3.72%，与已经压缩过的 JPEG 再归档相符；不存在异常高压缩率或 ZIP bomb 迹象。

### 4.2 与页面内容的严格对应

当前页面 DOM 共有 20 个 `<img>`：

- 11 个属于文章内容图片：1 张封面、10 张正文图；
- 另外 9 个是头像、等级 SVG、投币动画等页面 UI 或评论资源。

ZIP 与 11 个文章内容图片严格集合相等。逐一获取当前 CDN 原始 JPEG 并计算 SHA-256 后，11/11 均且仅匹配 ZIP 中的 11 项，没有遗漏、多抓、转码或截断。

页面位置与 ZIP 文件的映射如下：

| 页面位置 | ZIP 文件 |
|---|---|
| 封面 | `image_07.jpg` |
| 正文 1 | `image_11.jpg` |
| 正文 2 | `image_09.jpg` |
| 正文 3 | `image_06.jpg` |
| 正文 4 | `image_05.jpg` |
| 正文 5 | `image_01.jpg` |
| 正文 6 | `image_08.jpg` |
| 正文 7 | `image_04.jpg` |
| 正文 8 | `image_02.jpg` |
| 正文 9 | `image_10.jpg` |
| 正文 10 | `image_03.jpg` |

编号没有保持页面展示顺序，容易让使用者误以为 `image_01.jpg` 是第一张正文图。任务没有要求顺序，因此不判为任务失败；若未来要求可复核顺序，应生成 URL、页面位置、文件名、字节数和哈希 manifest。

“网页下的图片”存在语义边界：如果按正常内容任务理解为“文章图片”，本次完整；如果极端字面理解为“DOM 中全部图片，包括头像和页面 UI”，则还缺 9 个站点资源。结合任务上下文、产物用途和用户初步验收，本报告采用“文章内容图片”口径。

## 5. 正向评价

### 5.1 任务结果真实正确

产物不是只做了文件存在性检查，而是通过了 ZIP 结构、CRC、JPEG 全量解码、路径安全、内容唯一性、用户解压目录比对，以及页面原始图片逐字节集合比对。就本次外部终态而言，任务完成质量高。

### 5.2 对网站限制具备有效恢复能力

模型没有停留在验证码或 API `-352`，而是切换到经审批的浏览器请求头与公开 API，最终定位到正确图片源。两次 shell/命令层错误也没有导致假内容直接交付。

### 5.3 安全边界有若干有效防线

- shell 默认禁网，只有明确 `allow_network=true` 且人工批准后才联网；
- Web UI 展示完整命令和联网提示；
- shell 子进程环境使用白名单，没有继承 `.env` 中的端点凭证；
- 写入范围由 sandbox 限制在 workspace 和本次工具私有临时目录；
- 超时会终止整个子进程组；
- 本次访问目标仅为公开 Bilibili 页面/API/CDN，没有观察到凭证泄露或静默越权。

### 5.4 运行与当前代码可对应

Trace 记录的 commit 与评审时 HEAD 都是 `e5c8d05829f123a195582433c9b60627842cd758`，运行时 `gitDirty=false`，当前仓库在报告新增前也为干净状态。本次结论不是拿旧代码推断新运行。

## 6. 问题与严重度

### P1-1：Shell 生成的二进制 Artifact 无法进入登记与验证链

这是本次最核心的机制缺口。

`run_shell` 的工具定义明确声明：

- `verification: NONE`；
- `requiredForSuccess: false`；
- 返回 shell 事实，但不返回 `artifact`。

Runtime 只有在 `ToolExecutionOutcome.artifact` 存在时才登记 Artifact，并明确不扫描 workspace 猜测交付物。当前唯一能主动发出 Artifact 的通用文件工具是 `write_file`，但它接收并写入 UTF-8 字符串，不能承载本次 58 MB 的真实二进制 ZIP。

仓库虽然已经有 ZIP `PK` 头、EOCD 和结构检查器，但 shell ZIP 无法到达该检查器。实际运行结果为：

```text
artifacts = 0
ArtifactRegistered = 0
ArtifactVerified = 0
VerificationCompleted = 13 次，全部 SKIPPED / required=false
deliveredArtifactIds = []
Outcome = SUCCESS
```

这符合当前 `settle-outcome` 语义：没有“已要求且失败”的验证事实，就不会因验证失败终止。但它不能证明 ZIP 存在、可解压、恰好 11 项或与来源一致。

代码证据：

- [`tools/common/src/exec/run-shell.ts`](../tools/common/src/exec/run-shell.ts)，约第 179–197、436–466 行；
- [`packages/harness-runtime/src/action/settle-batch.ts`](../packages/harness-runtime/src/action/settle-batch.ts)，约第 657–708 行；
- [`tools/common/src/fs/write-file.ts`](../tools/common/src/fs/write-file.ts)，约第 134–201 行；
- [`tools/common/src/artifact-checks/index.ts`](../tools/common/src/artifact-checks/index.ts)，约第 73–123、172–195 行；
- [`packages/harness-runtime/src/verification/settle-outcome.ts`](../packages/harness-runtime/src/verification/settle-outcome.ts)，约第 42–108 行。

**影响：** 本次“任务正确”来自报告阶段的外部后验审计，不是 Atlas 自己证明出来的。即使 ZIP 缺失、损坏或装入错误页，现有事实链仍可能结算为同样的 `SUCCESS`。

### P1-2：`fetch_url` 重定向 SSRF 校验发生在请求之后（本次未触发）

当前 `fetch_url` 使用 `redirect: "follow"`，完成自动重定向后才对 `res.url` 执行最终公共地址校验。若公开 URL 返回 302 到内网，内部 GET 可能已经发生，之后拒绝返回只能阻止结果进入模型，不能阻止请求本身。DNS guard 的检查解析与实际连接也没有固定为同一 IP，仍有 rebinding / TOCTOU 风险。

代码证据：

- [`tools/common/src/net/fetch-url.ts`](../tools/common/src/net/fetch-url.ts)，约第 193–229 行；
- [`tools/common/src/net/url-guard.ts`](../tools/common/src/net/url-guard.ts)，约第 99–147 行。

本次目标为公开 Bilibili 及其 CDN，没有证据表明该缺陷被利用，因此它不改变产物 PASS；但本任务不能作为网络安全退出证据。

### P2-1：下载过程不是 fail-closed，也没有内容级验证

主下载命令使用 11 个 URL 的循环：

```text
curl -s -L ... -o image_N.jpg
```

缺少：

- `--fail` / `--fail-with-body`；
- `set -e` 和 `pipefail`；
- 每个响应的 HTTP 状态、Content-Type 和长度检查；
- JPEG magic、解码或哈希检查；
- “恰好成功 11 项”的断言；
- URL → 页面位置 → 文件名 → SHA-256 的来源 manifest。

因此，单张请求返回 404/5xx 错误页或中途失败时，后续循环和最后的 `ls` 仍可能把整条 shell 命令结算为 exitCode 0。实际轨迹中已有一个判别样本：`grep -P` 报错后，末端 `sort` 把管道最终退出码变成 0。

归档命令使用 `&&`，所以 `zip` 自身非零时不会继续清理，失败传播比下载命令好；但没有执行 `zip -T` / `unzip -t`、条目数量检查或 JPEG 内容检查。

**影响：** 本次实际文件全部正确，但成功高度依赖外部服务当时正常返回，过程本身无法可靠识别部分下载失败。

### P2-2：固定临时名称与清理命令存在覆盖、误删和旧条目残留风险

运行使用固定名称：

- `images_dir`；
- `bili_article.html`；
- `images.zip`。

最后在同一条已审批命令中执行：

```text
rm -rf images_dir bili_article.html
```

运行前没有快照，也没有检查这些名称是否已经存在。因此不能严格证明：

- 没有复用或覆盖旧 `images_dir`；
- 没有删除用户原有的同名 HTML 或目录；
- 旧 `images.zip` 不含本轮未覆盖的历史条目。

`zip -r` 更新已存在归档时，未被本次 glob 命中的旧条目可能继续保留。本次独立审计确认最终 ZIP 恰好只有正确的 11 项，所以风险没有在该样本中兑现。

### P2-3：Web Trace 与 RunSpec 的运行身份不一致

Trace header 记录 `entry="web"`，但 `task="(未知)"`；下一行 `RunStarted` 和 SQLite 才保存正确任务。代码中，Web `startRun()` 在 `drive(gen)` 返回后才写 `taskCache`，而 Trace sink 在第一个事件到达时已经生成 header。

此外，公共 `makeRunSpec()` 当前硬编码 `origin.kind="CLI"`，导致 Web 运行在 RunSpec 中被记为 CLI。

代码证据：

- [`apps/workagent-service/src/run-host.ts`](../apps/workagent-service/src/run-host.ts)，约第 480–488、849–892 行；
- [`apps/cli/src/compose.ts`](../apps/cli/src/compose.ts)，约第 600–603 行。

**影响：** 不影响 ZIP 字节，但会降低 Trace、DB、前端入口之间的身份一致性，给回放、归档、跨工作区 Resume 和正式评测归因造成歧义。

### P2-4：Shell 联网权限粒度较粗

`fetch_url` 有 URL scheme、DNS 和私网地址检查；`run_shell` 一旦经人工批准 `allow_network=true`，则允许该进程访问任意网络目标，不复用 `fetch_url` 的逐 URL 防线。shell 读取策略也是敏感路径黑名单，而不是只允许 workspace；理论上，经批准命令可以读取未列入黑名单的主机文件并外发。

本次每条命令都向用户展示完整内容并得到批准，且实际目标仅为公开 Bilibili/CDN，所以属于已授权风险而非静默越权。它说明当前人工审批仍是 shell 网络访问的主要安全边界。

### P3-1：Effect 的 program 提取结果噪声大并可能扩大持久化泄露

`extractPrograms` 只是按空白和 shell 分隔符做尽力切分。本次下载 Action 的 effect scope 把 11 个完整 CDN URL、注释词和部分 shell 关键字都当成“programs”写入 Trace。

这既让审批/审计摘要难以阅读，也与 effect resolver “不保存完整命令以避免二次泄漏”的目标不一致。若 URL 将来包含签名或 token，可能在 effect 中额外持久化敏感参数。

代码证据：

- [`tools/common/src/exec/command-analysis.ts`](../tools/common/src/exec/command-analysis.ts)，约第 194–210 行；
- [`tools/common/src/exec/shell-effect-resolver.ts`](../tools/common/src/exec/shell-effect-resolver.ts)，约第 79–88 行。

Web 审批本身仍会展示完整命令，因此不能通过完全隐藏命令解决；正确方向是把“用户审批正文”和“持久化结构化 effect”分开建模。

### P3-2：执行路径可以显著缩短

第 4、5 个工具调用已经取得文章 ID、封面和正文 API 数据。更直接的路径应是：

```text
动态/文章 API
  → 结构化解析 data.content
  → 提取 1 个封面 + 10 个 native-image
  → 批量下载并逐项验证
  → 生成 manifest
  → 打包并验证
```

当前实现经过 6 轮 HTML 保存和正则试探后才得到同一组 URL。它没有导致预算失败，但增加了调用数、审批数、计费上下文和错误面。

### P3-3：Shell 心跳不是实时交付

`run_shell` 会在执行中产生 5 秒 heartbeat，但进展先在工具上下文中排队，等 `tools.execute()` 返回后主循环才统一 yield。本次主下载约 11.5 秒，用户在执行期间不会实时看到中间 heartbeat。

代码证据：

- [`packages/harness-runtime/src/action/settle-batch.ts`](../packages/harness-runtime/src/action/settle-batch.ts)，约第 489–503 行；
- [`packages/harness-runtime/src/loop/run-loop.ts`](../packages/harness-runtime/src/loop/run-loop.ts)，约第 921–928 行。

## 7. `SUCCESS` 为什么没有证明任务正确

本次终态非常适合说明 Atlas 的完成语义边界：

```text
模型不再请求工具
  + 没有 RuntimeError
  + 没有 required verification 失败
  = Runtime SUCCESS
```

但由于 shell ZIP 根本没有被登记为 Artifact，也没有 required verification，所以“ZIP 缺失/错误”的否定事实并不存在于 Runtime 中。`SUCCESS` 在这里准确表达了“运行顺利收敛”，不能扩展解释为“自然语言任务及交付物已经通过外部语义验收”。

本次真正支撑任务 PASS 的证据来自：

```text
最终文件盘面
  + ZIP CRC 与结构
  + JPEG 全量解码
  + 用户解压目录逐字节比对
  + 当前页面 11 个内容图片逐字节集合比对
```

两种结论不矛盾：Atlas 运行成功，产物也恰好正确，但后者不是由前者证明的。

## 8. 与当前设计及 Stage 3.5 目标的关系

Stage 3.5 引入 `run_shell`，解决了专用工具缺位时无法运行 `curl`、`zip` 等通用程序的问题。本次任务证明：

- 通用 shell 能实际跨过 Bilibili 验证页限制；
- 经人工审批后可以下载二进制图片并生成真实 ZIP；
- shell sandbox、环境白名单和命令展示在正常样本中可用。

但“能生成 ZIP”不等于“以 V05 Artifact 语义交付并验证 ZIP”。当前生产链缺少：

```text
run_shell 生成二进制文件
  → 显式声明 Artifact
  → ArtifactStore 登记
  → ZIP / 内容检查器验证
  → verified deliverable
  → deliveredArtifactIds
```

因此，本次不应被用来关闭 Artifact 交付与验证的阶段退出门。

当前代码中，历史 Stage 3 的 `read_blob.line_offset` 路由缺失和在途模型调用 active deadline 已修复；本任务没有消费 Blob，也没有碰到模型 active budget，不能将这些源码修复扩展为本次行为证据。工具执行期间的 active budget 仍主要依赖工具自己的 timeout，本次没有触发该边界。

## 9. 建议的验收修复方向

本节只给验收方向，不在本报告中实施修改。

### 9.1 P1：补齐真实二进制 Artifact 链

至少满足以下一种生产路径：

1. 增加“登记 workspace 中已有文件”的受控工具，并冻结路径、大小、MIME、SHA-256 和 producer toolCallId；或
2. 提供通用下载/归档工具，直接返回 Blob / Artifact，而不是让二进制只存在于 shell 副作用中；或
3. 扩展 `run_shell` 的受控输出声明，让用户/模型在执行前声明预期产物，执行后由 Runtime 按冻结路径登记，而不是扫描整个 workspace 猜测。

ZIP 交付应至少验证：

- 文件存在且位于 workspace 内；
- magic / EOCD / CRC 正常；
- 条目路径安全；
- 条目数量和类型符合任务事实；
- 每个图片可以完整解码；
- `deliveredArtifactIds` 引用已验证 Artifact；
- required Artifact 缺失或验证失败时，不得结算为任务交付成功。

### 9.2 P1/P2：下载及归档 fail-fast

推荐验收形状：

```text
set -euo pipefail
curl --fail-with-body --location ...
逐项检查 HTTP 2xx / Content-Type / 长度 / JPEG 解码
断言成功项数等于来源清单项数
生成 URL → 页面位置 → 文件名 → 字节数 → SHA-256 manifest
使用全新临时目录和全新 ZIP
zip -T 或 unzip -t
```

不要只用“命令 exitCode 0”和“最终 `ls` 能看到文件”作为内容正确性证明。

### 9.3 P2：保护 workspace 历史内容

- 使用 RunId 或 `mktemp` 生成专属临时目录；
- 创建前确认目标不存在，或把覆盖作为单独 Effect 请求审批；
- 不对通用固定名称执行 `rm -rf`；
- 对最终 `images.zip` 明确选择“必须不存在”“覆盖”或“原子替换”语义；
- 正式评测保留 before/after 文件集合及哈希快照。

### 9.4 P2：修复 provenance

- 在首个 Trace header 写入前冻结 task；
- Web RunSpec 使用真实 `origin.kind`；
- Trace、RunSpec、SQLite、UI 保持同一 task、workspace、entry、模型和 profile 身份；
- 对网页来源清单及最终 Artifact manifest 保存可审计关联。

### 9.5 P1：逐跳处理重定向安全

- 使用 `redirect: "manual"`；
- 每一跳先解析并校验目标 URL，再发起下一跳；
- 限制跳数；
- 将校验得到的 IP 与实际连接绑定，避免 DNS rebinding / TOCTOU；
- 增加公开 URL → 127.0.0.1、私网、link-local 和 mapped IPv6 的真实重定向测试。

### 9.6 推荐的最小回归判据

应设计可判别的反例，至少覆盖：

1. 第 6 张图片返回 HTTP 404，下载批次必须失败；
2. HTTP 200 但正文为 HTML，图片验证必须失败；
3. 11 张中缺 1 张，完整性断言必须失败；
4. ZIP CRC 损坏，Artifact 验证必须失败；
5. 预先放置包含旧条目的 `images.zip`，不得把旧条目带入新产物；
6. workspace 预先存在 `images_dir`，不得删除用户内容；
7. shell 生成正确 ZIP 但未登记 Artifact，终态不得把它作为已交付产物；
8. 公开 URL 重定向到私网，内部请求必须在发出前被阻断；
9. Web Run 的 Trace header、RunSpec 和 SQLite origin/task 必须一致。

每条判据都应实际运行一次破坏实验，证明它在对应缺陷出现时会变红。

## 10. 最终退出建议

### 对本次用户任务

**PASS。** `images.zip` 可以作为正确产物接受：内容完整、ZIP 结构安全、11 张图片有效，并与目标文章的 1 张封面和 10 张正文图逐字节匹配。

### 对 Runtime 运行

**COMPLETED / SUCCESS，记录为运行层成功。** 模型完成了多轮恢复，所有人工审批都被正确消费，没有预算、RuntimeError 或中断问题。

### 对 Atlas 自验证能力

**不通过。** 本次没有 Artifact 登记、没有 required verification、没有 delivered Artifact；Runtime 无法从自身事实链证明 ZIP 正确。

### 对能力稳定性与阶段退出

**有条件、不可外推。** 当前只能把它记为一个结果正确的真实样本，不能据此宣称：

- 网页图片下载对网站变化稳定；
- 部分下载失败能被可靠识别；
- 二进制 Artifact 已实现可验证交付；
- shell 联网和重定向安全已经通过；
- 同任务重复运行具备 `pass^k` 稳定性。

建议先补齐 P1 Artifact 链和 fail-closed 内容验证，再使用冻结页面夹具、故障注入和至少 5 次真实端点重复运行进行正式回归。

## 11. 变更声明

评审阶段仅执行只读的源码、Trace、SQLite、ZIP、JPEG、文件元数据和当前网页/API 检查，没有修改产品代码、运行数据库、Trace、任务产物或用户工作空间。

用户在评审完成后明确授权整理正式报告。本次 Codex 操作只新增：

```text
/Users/shixiangweii/WebstormProjects/sxw_work-agent/评测/图片打包任务-评审-codex.md
```

其余代码、配置、历史报告和运行证据均保持不变。
