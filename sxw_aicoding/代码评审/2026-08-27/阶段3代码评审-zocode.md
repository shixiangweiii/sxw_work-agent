# 阶段 3 代码评审（zocode）

> 评审日期：2026-08-28
> 评审对象：`阶段3实施方案_V20260828-02.md`（四批 S1–S14 ＋ 14 条不得绕过清单 ＋ 8 条退出门槛）× 当前未提交源码（git 工作区改动：45 文件，约 +2327 / −917 行；含新增 `tools/` 层、4 个新 verify 脚本、3 份新 ADR）。
> 评审方式：主评审人逐文件精读方案全文与关键源码——`tools/common` 全部工具与护栏（read-file / search / edit-file / stat / fs-common / read-guard / url-guard / fetch-url / read-blob / request-handoff / artifact-checks / index）、Runtime 侧（effect-resolver / policy / run-loop / settle-batch / progress-guard / facade.resume / ports / types）、装配侧（compose / composite / stdin-channel / main）、store-sqlite 两份新 store、cases/micro-cases 工具账、四个新 verify 脚本的判据结构；独立运行 `npm run typecheck` 与六条边界 grep。
> 性质：**仅评审，未修改任何文件**。`verify:all` 未复跑（脚本会写临时工作区 / 库文件），其「全绿」结论采信自脚本结构审读与 CLAUDE.md 声明。

---

## 0. 总体结论

**实施完成度很高：方案四批 S1–S14 全部有对应实现，「不得绕过清单」14 条全部落地且多数配有机械判据，S14 文档回写一项不缺。可以收口。**

- 发现 **4 项 P2 偏差**（无 P1 级阻断项）与约 5 项 P3 小瑕疵，见 §3；其中 S13 由脚本化模型驱动一条，直接影响退出门槛「通用性成立」的证据等级，建议在收口文档中如实降级表述。
- 独立机械验证：`typecheck` 干净；六条边界 grep **实际 import 零违规**。
- 本次实施对方案精神（判别力、诚实上报、反过拟合）的执行普遍**超出字面**：E 段用真 `kill -9` 做组合器路由的判别力对比、`search` 黑名单连 `kind:"name"` 也挡、`dataMovement` 只记 host 与参数名避免审计记录自身成为二次泄漏点、`edit_file` 验证器主动处理「锚点插入」误报——这些都不是方案明文要求的。

---

## 1. 逐批对照结果

### 批 1（S1–S5 ＋ verify:tools）✅ 基本落地

| 步骤 | 结论 | 依据 |
|---|---|---|
| S1 `--endpoint` ＋ `interject` | ✅（1 处偏差，见 P2-1） | CLI 枚举约束（`--endpoint deepsek` 拼错立刻失败）＋启动只打 host 不打 key（`main.ts:99,435`）；`StdinChannel` 单一 readline、RUNNING / WAITING_FOR_APPROVAL / WAITING_FOR_INTERACTION 三态语义、无 TTY 优雅降级全部落地（`stdin-channel.ts` 文件头把「三条通道抢一个 stdin」的风险写得很清楚） |
| S2 建包＋三迁移＋两条存量 | ✅ | `tools/common` 建包进 workspaces；`list_dir` / `write_file` / `now` 迁移，`cases` 侧 `fs-common / list-dir / now / write-note` 四个旧文件已删；**N-8** 修复为六类有判别力的 errno 分类（EACCES→AUTHORIZATION/AFTER_USER_ACTION 等，`fs-common.ts:108`）；**P3-26** email 正则收进 STRICTEST 档且三条真实凭证形态不动（`compose.ts:563-591` 有取舍说明）；`recoveryObservation` 已去掉类型上的 `?`（`types/tool.ts:173`），「必填」由类型强制 |
| S2.5 prompt / description 重写 | ✅ | system prompt 含工具选择指引（stat vs list_dir、search vs 逐个 read_file、read_blob 取回、request_handoff 使用边界）、外置 stub 用法、不可信内容声明；**无业务场景规则**（不得绕过 #14 守住）；10 个工具的 description 逐个写了返回 JSON 形状与失败诊断形态 |
| S3 `read_file` ＋ `stat` | ✅ | 按行分页＋`startLine/endLine/totalLines/truncated/nextStartLine`；超长单行（>4000 字符）截断且显式列 `truncatedLines`；**读黑名单在打开文件之前判**（内容不进内存）；超 32MB 拒绝整个读并报错（显式拒绝 ≠ 静默截断）；二进制 NUL 字节探测如实警告；`stat` 的 ENOENT 返回 `exists:false` 而非报错——「不存在是一个答案」 |
| S4 `search` | ✅ | 通用 ignore 过滤（.git / node_modules / 编译产物 / 二进制扩展名）；content 匹配带前后各 2 行上下文＋明确行号（可直接接 `read_file` 的 start_line 与 `edit_file`）；cursor 分页；**黑名单在遍历时生效，连 `kind:"name"` 也挡**（「仓库根有个 .env」本身就是线索），`skippedByReadGuard` 如实上报；MAX_DIRS 上限带 `incompleteReason` |
| S5 `edit_file` | ✅ | 唯一匹配替换；结构化诊断三条全齐（零匹配→去空白近似候选行＋CRLF 提示；多重匹配→全部命中行号）；非幂等＋`requiresPreFingerprint:true` 落 §18.2 分支二；验证器主动处理「new_string 包含 old_string 的锚点插入」场景——注释记录这是 S13 实跑撞上的真误报，处理有据 |
| 验收 `verify:tools` | ✅ | A–H 全段齐：A2 做 canary 注入判别力实测（注入即翻红、验完清理）；B 两类声明扫描；C 三个必填项；D/D2 分页≠截断＋edit_file 诊断；**E 段用真 `kill -9` 跑 good / broken 对比**，断言改坏 `observePre` 路由后 `edit_file` 恢复分支从二退化到三并翻红；F 黑名单两工具各一次＋反向（normal.txt 仍可读）；G 固定开销基线；H 段（批 1 已知红）已转绿并保留为防回归线 |

### 批 2（S6–S8 ＋ verify:artifact）✅ 落地

- **S6 Materialization**：`settle-batch.ts` 的 `materialize()` 消费 `inlineToolResultLimitTokens`（原零消费点已接通）；阈值来自上下文预算而非协议上限（注释引用百炼 200KB / 34576 token 实测）；stub 含 status / reason / ref / preview / retrieval 指引，协议合法；**`deps.blobs` 缺席时宁可 inline 也不外置**——与不得绕过 #9「外置必须配取回通路」是同一条不变量的两半；外置失败回退 inline 且说明理由（避免诱导模型重做已完成的副作用）。
- **S6.5 `read_blob`**：分页语义与 `read_file` 逐字一致（按行、显式 truncated）；额外实现**行内偏移**（`lineOffset` / `nextLineOffset`）处理超长单行——工具结果常是一整行 JSON，纯按行分页对它无效，这是方案契约之外的必要补充；`next*` 字段原样透传 store 而不自行计算。
- **S7 `fetch_url`**：SSRF 护栏扎实——DNS 解析后再判（防「指向内网的公开域名」）、IPv4-mapped IPv6 摊平、`.local`/`.internal` 保留域、**重定向终点二次判定**（`redirect:"follow"` 后对 `res.url` 再过一次护栏）；4xx / 5xx 返回结构化结果不抛异常（「服务器说 404 是成功取回的事实」）；错误分类认 `AbortError` / `ENOTFOUND` / `EAI_AGAIN`（N-4 教训落进来了）；二进制只回元数据不进 Context；未内置任何正文提取（决 1 守住，文件头有正面论证）；URL scope 声明 `effectType:"NETWORK"` ＋ riskFact（`EXTERNAL_ENDPOINT` / `URL_CARRIES_QUERY`）＋ `dataMovement`（**只记 host 与参数名，不把 query 值抄进 Trace**——审计记录自身不成为第二个泄漏点）。
- **S8 ArtifactStore 重设计＋第二层验证**：接口确实是重设计（版本链：同 logicalId 内容变化自增 version、去重回存；Tombstone 而非物理删除；`derivedFrom` lineage；来源 Run 关联）；**登记触发源是工具显式声明 `outcome.artifact`**，不扫 workspace 自动派生；检查器只做四项（hash / 编码 / JSON / ZIP），文件头明确不写「Markdown 可解析」并引用 §0.3 反面教材；**role 结算映射正确**——`DELIVERABLE` 失败 → `FAILED`（`settle-outcome.ts:58-71`，先于其他一切判定），`INTERMEDIATE / RESULT` 失败 → `COMPLETED_WITH_LIMITS` ＋ 具名 `incompleteItems`；`deliveredArtifactIds` 只收检查通过的（「把检查失败的产物列进交付等于宣称交付了一份坏东西」）；登记失败不改写工具结果但落一条失败检查事实。
- 验收 `verify:artifact` A–G 全段在（G 反向判别力：正常产物不被误判；F 段两种 role 结算可区分）。

### 批 3（S9–S11 ＋ verify:progress）✅ 落地

- **S9 Progress Guard**：不基于流式 delta、进展不持久化、只接第一条形态（同工具＋同 normalized inputDigest＋同 effect digest 连续 3 次）；**整批合并比较**避免误判批内合理重复（同批两次 `list_dir` 不同目录不算重复）；阈值取 3 的理由（第二次重试正常、第三次才是没在读反馈）写明；`NO_PROGRESS` 是具名 Terminal，且结局归 `BUDGET_EXHAUSTED` 不归 `FAILED`（「主动资源保护 ≠ 故障」的归类论证成立）。
- **S10 人工接管**：三件全落地，且 resume 闭合的实现比方案更经济——`WAITING_FOR_INTERACTION` 状态由 facade 按 `InteractionRequested / InteractionCompleted` 事件对投影落库（`trackWaitStatus`，写失败不打断 Run）；resume 识别该状态后发 `InteractionResumed`，然后**复用 §18.2 分支一重执行幂等的 `request_handoff`**——其执行语义恰好就是「重新打印引导、重新等待」，不进主循环、不调模型、不写特殊路径；分支一重跑期间状态继续跟踪（「resume 之后再崩一次」不退回未定义窗口）；等待扣除用 `InteractionRequested / Completed` 事件对夹时间，与审批事件对完全同构；**异常路径也闭合**（工具抛异常时补发 `InteractionCompleted(answered:false)`，否则 `waitingSince` 悬着、墙钟从此形同虚设——这个边界被主动堵上）。
- **S11 真实慢工具**：`slow_write` 建在 `cases/micro-cases`，文件头把「慢的写 ≠ 慢的空转」（前者测半截副作用的诚实上报，后者永远 NO_EFFECT）的选型理由写全；`verify:pairing` 的中断判据与抬头说明同步改写为 `slow_write` 载体；步骤级 `AbortSignal.any([runSignal, timeout])` 在真实路径生效，且处理了「工具正常返回但 signal 已因超时 abort」的边角（按失败处置、保留真实 sideEffectState）。
- 验收 `verify:progress` A–G 全段在（A 段断言 ToolProgress ≥3 次＋长任务不误杀；E 段跨进程 kill＋resume 实测）。**G 段有缩水，见 P2-3。**

### 批 4（S12–S14）✅ 落地

- **S12**：`policy.ts` 写越界一律 DENY（不给审批机会，理由：授权边界不能变成「每次问一下」）、读放行且注释写明「改这段之前先确认三条护栏还在」；三条护栏总校验进了 `verify:scenarios` 尾部（S12 段）；`requiredCapabilities` 每个工具声明处都有一行「本字段当前零消费，授权层推到 bugfix 阶段」注释——按方案「写明比默默留着诚实」执行。
- **S13**：三任务（办公 A / 代码 B / 聊天 C）＋四层判据（具名 Terminal 与配对不变量、产物**存在且非空**、任务点名对象最小有效性、不做质量评分）＋「三个场景用的是同一套工具」总判定（含「都用到」与「专属工具」检查）。任务 A 不用 `append_log` 收尾、任务 C 补聊天场景，均按方案执行。**但见 P2-4 的证据等级问题。**
- **S14 文档回写：一项不缺**——AGENTS.md（S2 当批：`tools/` 层、依赖方向 `apps → packages / adapters / cases / tools`、两类声明义务、`verify:tools`）；Roadmap §5；V05（§28.4 / §27.2 目录树 / §12.3 recoveryObservation 必填）；**阶段 2 回归评测报告 §5.1 口径更正**（Trial 1 是 grader 误判，§0.3 的结论回写）；存量清单；探针脚本与原始输出入库（`probe:requirement-extraction` 已注册进 package.json）；ADR 0004（通用工具归属与两类分拣）/ 0005（PARKED lease 不做的理由）/ 0006（读放开的护栏边界）三份正好对应方案 §7 列的三个候选题。U-6 的 `expectedBaseUrlHost` 改为 `maas.aliyuncs.com`，且把「闸门排在闸门后面等于没有闸门」的教训写进了声明注释。

---

## 2. 机械验证（本次独立运行）

- `npm run typecheck`：**干净**（`tsc --noEmit -p tsconfig.json` 无输出）。
- 六条边界 grep（按方案 §2.3）：**实际 import 零违规**。两点说明：
  1. 边界 6 / 6b 的字面 grep 会命中**注释**（如 `policy.ts:47`、`ports/index.ts:550`、`tools/common/src/index.ts:17` 等引用规则本身的文字）；`verify:tools` 的 `grepBoundary` 对「引用边界规则本身的文件」做了豁免并写明理由——调整合理，但意味着**仓库外手工照抄方案 §2.3 的原始命令会假红**，判据的权威形态以 `verify:tools` A 段为准。建议在方案或 AGENTS.md 里把这一点记一笔，避免后人误判。
  2. A2 段的 canary 注入实测证明第 6b 条**有判别力**（注入 `import … from "@workagent/micro-cases"` 当场翻红并指认行号）。
- 脚本注册：`verify:tools / artifact / progress / scenarios` 均已注册，`verify:all` 链含全部 12 条脚本；`probe:requirement-extraction` 已入库。

---

## 3. 发现的问题

### P2 级（与方案字面偏差，应登记处置）

**P2-1　S1 的「`eval/suite` 加 `--endpoint`」未做。**
`eval/suite/index.ts` 的参数处理只有 `--live` / `-n`，`compose()` 调用未传 `endpoint`（默认 bailian）。CLI 侧完整。按决 4 不阻塞收口，但这是方案字面上的未完成项：要么补上（成本极低），要么在存量清单登记处置。

**P2-2　`fetch_url` 的 `MAX_REDIRECTS = 5` 声明未接线。**
实际请求用 `redirect:"follow"`（`fetch-url.ts:134`），重定向上限来自 undici 内部默认（20），常量定义并 export 后**零消费**。「有上限」成立、终点私网再判也仍然有效，但一个定义了不生效的常量正是本项目反复批评的「未接线比不写更糟」形态——建议要么删掉常量，要么改成 manual 重定向循环让 5 跳上限真的生效。

**P2-3　`verify:progress` G 段判据缩水。**
方案 G 段要求「三种 stdin 语义各触发一次且互不串台」；实现只实测了 interject 进入下一轮 ContextFrame。D 段的接管用的是注入的 fake `HandoffChannel`（不走 `StdinChannel`），审批应答走 CLI 层（验收脚本的 approvalDecider 是函数注入，同样不走 stdin）。也就是说 `StdinChannel` 的 **waiter 仲裁逻辑**（真正防「三态互不串台」的代码，包括 abort 时清 waiter 防止插话被吃掉那条）没有任何机械判据保护——它恰好是最难复现的那类 bug 的所在。

**P2-4　S13 由 `ScriptedModelPort` 驱动，「真实任务跑通」的证明力度受限。**
工具与文件系统是真实执行的，产物存在性 / 点名对象断言也真实成立，但「模型」是脚本。它证明的是「**同一套工具能支撑三类任务的链路形状**」，不证明「**真实模型能自主用这套工具端到端完成三类任务**」。决 4 之下这个取舍可辩护（真模型跑分属统一评测），但 §5.2 退出门槛「通用性成立」当前的证据等级应如实写成 **smoke 级**，留给评测阶段升级——否则会与 CLAUDE.md「开发完成」的表述叠加出超出证据的读法。

### P3 级（小瑕疵，顺手修或记录）

1. **CLAUDE.md 数字自相矛盾**：「新增 `tools/` 层与 11 个工具（8 场景 ＋ 2 机制 ＋ 2 测量）」——8+2+2=**12**（`DEFAULT_TOOLS` 实为 12；`tools/common` 10 个），应改 12 或改口径为「新增 9 个＋迁移 3 个」。
2. **「84 条判据全绿」未经独立复跑**：本次评审为守「不修改任何文件」未运行 `verify:all`；建议收口提交前完整重跑一次并留存输出。
3. **`ProgressGuard.lastProgressAt` 被写入但无判定逻辑消费**：`noteProgress()` 在 run-loop 有调用点，但 `lastProgressAt` 没有任何终止 / 判定逻辑读取（当前没有「久即杀」机制，属防御性存在）。这是又一个准「零消费」字段——建议在文件头标注「当前无消费者，为未来误杀防护预留」，或等第一个真实消费者出现。
4. **DNS rebinding TOCTOU**：`url-guard` 先 `lookup` 判定、`fetch` 内部会再解析一次，两次之间记录可变。方案 §8 已声明「单人本地开发期接受残余风险」，重定向终点再判补了大半，记录在案即可。
5. **S12 末条「`--yes` / `--yes-all` 语义与文档同步」的口径未写死**：实际入口一直是 `--confirm`（AGENTS.md 同步为 `--confirm`），未见 `--yes` 形态。多半是「沿用 `--confirm`」的意思，但建议在存量清单把这条口径明确写死，避免下阶段有人按方案字面去找一个不存在的参数。

---

## 4. 退出门槛对照（方案 §5.2）

| 门槛 | 判定 | 说明 |
|---|---|---|
| 能力面成立 | ✅ | 10 个工具（8 场景＋2 机制）齐；`verify:tools` A–H 段结构与判别力实测齐备 |
| 通用性成立（S13） | ⚠️ | 判据齐但脚本化模型驱动，证据等级为 smoke（见 P2-4） |
| 不过拟合 | ✅ | 六条 grep＋canary 判别力实测＋prompt 无业务规则（本次独立验证） |
| 机制被真需求逼出 | ✅ | BlobStore＋取回 / ArtifactStore＋二级验证 / Progress Guard / 人工接管各有 verify 段，且每条有判别力实测（E 段真 kill good/broken 对比是范本） |
| 状态闭合 | ✅ | `WAITING_FOR_INTERACTION` 的持久化 / resume / 等待扣除三条都有判据（progress D / E / F 段） |
| 数据边界护栏 | ✅ | 读黑名单（两工具各一次）、私网拒绝、URL scope riskFact 三条都有判据＋S12 总校验 |
| 无回归 | ✅/△ | `typecheck` 干净（独立验证）；`verify:all` 全绿采信自脚本结构与 CLAUDE.md 声明，未复跑 |
| 编排层未膨胀 | ✅ | 未新增 Planner / Memory / Sub-agent；固定开销基线在 `verify:tools` G 段打印 |

---

## 5. 收尾建议

1. **可以收口提交**。四处 P2 均不阻断：P2-1 / P2-2 是低成本顺手修；P2-3 / P2-4 属判据与证据等级的登记问题，写进存量清单即可。
2. 收口提交信息建议按仓库惯例用短中文，例如「阶段3通用能力面实施完成（含评审处置）」，并在提交说明中登记 P2-1…P2-4 的处置去向。
3. 统一评测阶段（决 4）开工时，第一件事应是把 S13 三个任务换成真实端点跑一遍——它同时回答「通用性成立」的证据升级与 §8 风险表「新射程上思考短板暴露」两个问题。

---

*本报告由 zcode 于 2026-08-28 生成；评审期间未修改任何仓库文件。*
