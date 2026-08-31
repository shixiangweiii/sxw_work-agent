# 二次代码评审：图片打包任务评审批次的优化实现（M1–M5 / ADR-0010）

- **评审日期**：2026-08-31
- **评审人**：ZCode（二次评审：通读全部 20 个文件的未提交 diff 与新增 ADR，独立复核代码路径，实际运行验收命令）
- **评审对象**：针对首轮实测评审（`评测/图片打包任务-评审-zcode.md`）问题的处置批次，git 未提交
- **关联文档**：ADR-0010（二进制交付物走字节通道与按路径声明）、存量问题清单 §0.15（M1…M5）、`评测/图片打包任务-评审-codex.md`
- **评审方式**：只读评审 + 验收命令实证；未新增或修改任何仓库文件（verify 脚本仅在系统临时目录工作）

---

## 总评

**这是一批质量很高的修复。上轮 P1（产物链路断裂）被正确地连根修掉——不是打补丁，而是先用 ADR 承认根因在类型签名、预演出"省事修法会把正确的 Run 判 FAILED"之后才动手；上轮 P2 部分闭环；并且这批改动对上轮评审里两条不成立的因果做了有证据的推翻——独立复核后确认反驳成立。全仓 typecheck 干净，四个受影响验收脚本 53 条判据全绿。残余问题集中在 binary 类产物无结构检查（F1）和 S5-4 已登记的"声明落空不进结算"两点，另有一条失联项（P4）。**

## 一、实证结果（全部实际运行）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 干净 |
| `npm run verify:tools` | 14/14 ✓（边界 grep 未受影响） |
| `npm run verify:artifact` | 10/10 ✓，含新增 H 段 |
| `npm run verify:shell` | 22/22 ✓，含新增泄漏判据与 B7/B8 |
| `npm run verify:ui` | 37/37 ✓，含新增三轨身份判据 |

H 段的判据设计值得单独点名：它不满足于"登记成功了"，而是拿**磁盘上那份的真实字节**独立算 sha256 和 size 与登记值逐位比对——被 ADR 否决的"字符串传二进制"修法在这条上必然翻车（存量清单保留了注入实测的原始输出：`sizeBytes 184 vs 磁盘 166 → FAILED`，而 zip 本身完全正确）。

## 二、上轮问题的处置对照

### P1（产物链路断裂）→ 已闭环，且是正确层面的修复

ADR-0010 先证明了根因在 `ProducedArtifact.content: string` 这条类型层通道（连带 `kind:"zip"` 检查器从上线起零生产者），再否决方案 A（字符串传二进制，会把正确的 Run 判 FAILED）、方案 D（自报 hash，同源恒真），选 B（`string | Uint8Array`）。实现侧逐段核实：

- `tools/common/src/exec/run-shell.ts` 的 `collectDeclaredArtifact`：执行前声明、命令成功后读回字节；五种拿不到产物的情形（非零退出码 / 越界 / 非普通文件 / 超 256MiB / 读不到）**每条都产出 `artifactNote`**，无静默分支。逐支检查过：`safeRealpath` 对不存在路径返回 undefined 不抛、stat/readFile 已包 try/catch。
- `packages/store-sqlite/src/artifact-store.ts`：hash/size 改按真实字节，且**字符串档保持 UTF-8**——既有版本链的 hash 不因升级作废。
- `kindOf` 收敛为 `artifact-checks/artifactKindOf` 唯一一份（`write-file.ts` 只留转发），两个工具不会对同一扩展名跑不同检查器。
- `tools/common/src/index.ts` 补上 handler 参数透传——存量清单记载摘掉这两行的注入结果正是"声明了交付物、产物表 0 行、没有任何报错、结算 SUCCESS"。
- 审批面（CLI `main.ts` + Web `human-channels.ts` / `app.js`）都显示"声明的交付物（角色）"——ADR 里"人批准的不只是命令，还有交付声明"这半个理由兑现了。
- 存储层只持久化 hash+size，不存内容本身：58MB 不进上下文（工具结果里只有 artifactNote）、不胀 DB。设计干净。

### P2（验证层全程旁路）→ 部分闭环

声明了 `artifact_path` 的产物现在有第二层检查（zip-opens / json-parses / 文本编码 / 磁盘 hash 复核），DELIVERABLE 检查失败先于一切判 FAILED（§1.2 第 3 条）。残余见 F1、F2。

### P3（效应分类噪声）→ 我的因果被推翻，处置仍正确

见第三节。噪声本身修了（M4）：`extractPrograms` 先抹引号内容再切分，`couldBeProgramName` 过滤 `://` 与纯标点碎片；`verify:shell` A 段实测两种形态的 scope.value 都只剩 `programs:curl`。这个修复的真实收益比首轮预期的大——它堵住的是**11 个完整 CDN URL 被持久化进 Trace** 的泄漏路径（今天泄公开 URL，明天泄带 `?sig=` 的签名 URL），与同文件 dataMovement"不记命令原文"的自家规则打架。

### P4（fetch_url 无浏览器指纹）→ 失联

既没修，也不在存量清单"明确不做"表里。这是本批处置表上唯一的空洞，建议至少补一条登记（哪怕结论是"不修"）。

### P5（长批下载超时组合风险）→ 明确缓期

"真实风险但没有明确修法"成立。同时 M5 把 `set -euo pipefail` / `curl --fail` / 结尾数量断言写进了 description 引导面，并明确拒绝了两类错误做法：措辞判据（测的是词在不在，不是行为）、Runtime 替模型注入 `set -e`（那是改写用户已审批过的命令，审批看到的与执行的从此不是同一条）。两个拒绝都对。

### P6（观测面小项）→ 一条观察被实测推翻（见下），心跳实时化的既有登记（S3-12/S3-22）未变

### 批外收获：修了两个首轮没抓到的真 bug

- **M1（description 对模型说假话）**：R-8 把 tmp 收窄成 per-call `mkdtemp` 后，description ① 仍写"系统临时目录"——模型照文档写 `/tmp` 被沙箱拒、`curl -s` 吞掉错误，正是首轮 T7 白花一轮的根因。"模型是按文档办事的，错的是文档。"四处口径（description / 沙箱 / CLI 审批 / Web 审批卡）统一，B7 双侧判据（`$TMPDIR` 写得进、`/tmp` 写不进）钉住。
- **M3（运行身份三轨分叉）**：Web 起的 Run 在 RunSpec 里自称 CLI（`makeRunSpec` 写死、字段一个生产者零消费者），trace header 的 task 恒"(未知)"（`taskCache.set` 排在 `await drive` 之后，而 header 在第一个事件时就生成）。修复带三轨一致判据（`verify:ui` G 段）。

## 三、首轮评审被推翻的两条——独立复核后接受

1. **"清噪声能减少审批"——因果错误。** 重读 `command-analysis.ts` 确认：`analyzeCommand` 的只读判定走"无元字符 + argv[0] 白名单"路径，**从不读 `programs`**（文件里明确写着"只服务展示与审计，不服务任何判定"）；T11 落 EXECUTE 是管道符 `|` 命中元字符黑名单，与引号碎片无关，且该 Run 的 10 条 shell 命令每条都含元字符——清噪声确实一次审批也减不掉。首轮把"噪声稀释审批串信任"（对）和"噪声造成审批打断"（错）捆在了一起。
2. **"心跳在 18 秒下载批期间持续可见"——事实错误。** 重查 JSONL 时间戳：三条 ToolProgress（含"已 5 秒""已 10 秒"）全部落在 AttemptStarted 后 **+11.458 秒**、AttemptCompleted 前 1 毫秒——是结算时一次性吐出的，执行期间不可见；批耗时也是 11.46s 而非首轮所说的 18s。这是工具非 generator 的已知限制（S3-12），首轮把队列里的信号误读成了实时信号。

存量清单"一条不成立的因果比一个没修的 bug 更贵"这条元教训，是本批最有价值的记录。

## 四、本轮新发现（按优先级，均仅建议、未执行）

### F1｜binary 类 kind 没有任何结构检查——已登记项之外的残余缺口

`artifact-checks` 对 `kind=binary`（jpg/png/pdf 等全部常见二进制扩展名）只跑磁盘 hash 一项。hash 只证明"登记时的字节 = 磁盘字节"，不证明"它是图片"。本任务族的典型失败形态——curl 无 `--fail` 把 404 错误页存成 `image_NN.jpg` 再声明——若交付物是**散图**而非 zip，仍然畅通且 SUCCESS。zip/json/text 各有结构检查，唯独 binary 没有。存量清单 S5-3 登记的是"未知扩展名落 text 会误伤"，未覆盖此条。建议：对高频二进制扩展名加魔数抽查（jpg `FFD8`、png `8950`、pdf `%PDF`，与 zip 检查器同为无依赖实现），或登记为 S5-6。

### F2｜S5-4 的后果值得标更高优先级："声明了却没产出"不进结算

`artifactNote` 只进工具结果（模型看得见），不进 `artifactChecks` 事实表（结算看不见）——模型声明了 DELIVERABLE、命令成功、文件不存在，Run 仍结算 SUCCESS。这正是 P2 要消灭的"静默成功"形状的缩小版。已登记为 S5-4，认同登记，但建议排期靠前：修法方向现成——把"声明落空"push 成一条 `ok:false` 的 DELIVERABLE 检查事实，即可复用现有结算通道。

### F3（低）｜settle 回调里的 `void (async () => …)` 没有整体 try/catch

`collectDeclaredArtifact` 当前所有路径确实不抛（逐支验证过），但未来任何人在其中加了 try/catch 之外的 IO，一次意外 reject 会变成 unhandledRejection（Node 默认直接崩进程）且 settle 永不回调——外层 `await deps.tools.execute()` 没有 race 兜底，abort 监听在子进程已退出后也不再触发 resolve。一条 `try/catch → settle(错误)` 的保险带很便宜。

### F4（微）｜`logicalId` 用原始入参字符串，未归一化

`artifact_path` 传 `images.zip`、`./images.zip`、或 workspace 内绝对路径，会形成三条不同的版本链。与 write_file 语义一致（一致性成立），但 run_shell 的这个参数更依赖模型自由发挥，建议归一化（剥 `./`、拒绝绝对路径或折叠为相对）。

## 五、结论

- **方向与深度**：P1 的修复走对了层面（类型通道而非工具补丁）。ADR 的方案对比每一条都能指到证据；否决方案 A 的那次"预演"尤其有价值——把一个看似省事、实测会把正确 Run 判 FAILED 的修法钉死在文档里。
- **工程纪律**：新增 6 条判据全部做过注入实测；`verify:shell` 里"判据写错两次被当场拆掉"的记录（最终用两条各自只被一道守卫挡住的形态，避免守卫互相遮蔽）是 AGENTS.md 判别力要求的范本执行。
- **透明度**：对两份外部评审（含本评审首轮的错误）逐条回源、公开推翻，并把"不修什么"写进明确不做表——这个习惯比任何单个修复都值钱。
- **待办**：F1（binary 魔数检查）、F2（S5-4 提优先级）、F3/F4（便宜保险）、P4（fetch_url UA 至少补登记）。
