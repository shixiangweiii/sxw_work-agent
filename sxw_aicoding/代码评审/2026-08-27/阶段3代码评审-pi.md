# 阶段 3 代码评审（pi）

> 评审日期：2026-08-28
> 评审对象：阶段 3（通用能力面）全部实施改动 —— **工作区未提交快照**（`git status`：45 文件修改，`tools/` 层、`composite.ts`、`stdin-channel.ts`、`blob-store.ts`、`artifact-store.ts`、`progress-guard.ts`、4 个新 verify 脚本、ADR×3、探针记录等新增），基线 HEAD 为 `bb27709`。
> 评审基准：《阶段3实施方案_V20260828-02.md》全文（§0–§8、S1–S14、不得绕过清单 14 条、§5.2 退出门槛 8 条）。
> 评审方式：独立逐条核源码与 `git diff`（与同目录 kimi / zocode 两份评审互不共享草稿），并实跑验证。
> 实跑记录：`npm run typecheck`（EXIT=0）；六条边界 grep 无真实违规；`verify:tools` 11/11、`verify:artifact` 8/8、`verify:progress` 9/9、`verify:scenarios` 5/5、`verify:persistence` 8/8、`verify:pairing` 11/11、`verify:endpoint-profile` 5/5、`verify:resume` 5/5、`verify:compact` 6/6、`verify:budget` 6/6、`verify:crash` 4/4、`verify:drift` 6/6 —— **12 条脚本 84 判据全绿**。
> 性质：**仅评审，未修改任何源文件。**

---

## 0. 总体结论

**实施与方案高度一致，四批 S1–S14 主体全部落地，退出门槛 8 条成立，可以收口。但存在 2 条 P1 判据质量问题（均为「恒真闸门 / 死声明」形态，恰好踩中方案 §8 风险表点名的形态）与 4 条 P2 偏离，建议处置后归档。**

1. 四批落地情况：批 1（S1–S2.5）工具面与装配、批 2（S6–S8）外置/产物/护栏、批 3（S9–S11）Guard/接管/取消、批 4（S12–S14）策略/场景/回写 —— 全部在场，且每条机制都有对应的 verify 段。
2. 实跑全绿：typecheck EXIT=0；六条边界 grep 无真实违规（第 6b 条注入判别力实测当场翻红）；12 条脚本 84 判据全过。
3. 不得绕过清单 14 条逐条可核实成立（§5）；退出门槛 8 条成立（§4）。
4. **两条 P1 的共同形态：新增校验/声明没有一条能单独触发它的判据，或者判据本身恒真。** 这与本阶段自己披露的 `verify:compact` C 段教训（存量清单 §0.6）同源 —— 说明「判据打绿勾 ≠ 在测它声称在测的东西」这条纪律在**新写的判据**上仍有两处漏网。

---

## 1. P1 问题（2 条，建议提交前处置）

### P1-1　`CommonArtifactChecker` 的「hash 与登记一致」检查恒真 —— 检查器从不读磁盘，宣称要抓的场景永远抓不到

- 方案 §1.2 首批四项检查之一：「hash 与登记一致」。**【定】检查器必须有判别力**，且把「Markdown 可解析」当永远绿灯的反例排除。
- 实际链路：`settle-batch.ts`（⑦.5 段）`register({ …content: a.content })` 先按这份 content 算出 `record.contentHash`，紧接着 `check(record, a.content)` **把同一份内存字符串再传进去**。检查器 `artifact-checks/index.ts` 用同一 content 重算 sha256，与 `record.contentHash` 对比 —— **必然相等**。
- 检查器自己的失败消息写的是「产物在登记之后被改过，或登记的不是这份内容」—— 但代码里没有读 `record.path` 的磁盘文件，这条失败路径**在当前实现下不可能发生**。它就是方案反复警告的「永远绿灯的闸门」形态，而 `verify:artifact` F 段判别力实测只测了坏 ZIP / 非法 JSON / 坏编码三种，**没有测 hash 不一致**，所以恒真没有被发现。
- 连带：方案跨批小步第 3 条「每条新增校验必须有一条能单独触发它的判据」在此项上不成立。
- 处置方向（二选一）：
  1. 让检查器真正读盘：`ArtifactCheckerPort.check` 增加读盘能力（workspaceRoot 或注入 readFile），从 `record.path` 读回文件内容算 hash 与登记值对比 —— 这才是「产物在登记之后被改过」的语义；
  2. 或按方案 §1.2 的诚实口径，把该项从首批四项中降级/删除并登记欠账（「未接线比不写更糟」，恒真闸门比没有闸门更糟）。

### P1-2　Progress Guard 的「还活着」一侧只有记录没有判定；`read_file` / `search` 的 HEARTBEAT 声明是死声明 —— verify:progress A 段后半判据恒真

- 方案 S9：「Progress Guard 消费它判定『还活着』」「`fetch_url` 与大文件读取周期性回报（低频，30s 量级）」。
- 实际三处断裂：
  1. **无判定**：`progress-guard.ts` 的 `lastProgressTime()` 全仓**零消费**（grep 证实，唯一写入点是 run-loop 的 `noteProgress`）。没有任何基于进展的「卡死检测」逻辑 —— 方案承诺的「还活着吗」这个问题只做了记录侧，判定侧不存在。§16.2 明确推后的是第二种无进展形态，不是这一侧；这一侧的缺失至少应被如实登记。
  2. **死声明**：`read_file`（`read-file.ts:106`）与 `search`（`search.ts:130`）声明 `progressReporting: { mode: "HEARTBEAT", intervalMs: 30_000 }`，但 `executeReadFile` / `executeSearch` 体内**零 `ctx.onProgress` 调用**（grep 证实：全仓 onProgress 调用点只有 `fetch-url.ts:129` 开头一次与 `slow-write.ts` 每段一次）。「大文件读取周期性回报」没有实现 —— 声明与实现不符，读代码的人会以为大文件读取是被监控的。
  3. **判据恒真**：`verify:progress` A 段的「长任务不被误杀」断言 —— 因为**没有任何杀长任务的逻辑存在**，误杀在结构上不可能发生，这条断言没有判别力。（A 段前半「ToolProgress 真的发出、Guard 真的消费」是实的，有判别力；后半是恒真。）
- 处置方向：二选一。① 实现 `read_file` 的真实回报（受 settle-batch 中 generator 挂起限制，「执行前后各回报一次」是可行的最低形态，并把声明里的 intervalMs 语义如实改写）；② 把 `read_file` / `search` 的 `progressReporting` 改回 `NONE`，把「还活着」判定的缺失作为已知欠账登记（方案 S9 本来就只承诺「本批只接第一条」无进展形态，这样声明才是诚实的）。

---

## 2. P2 问题（4 条，建议归档前处置）

### P2-1　`write_file` 的 `isIdempotent: false` 是为测量而标的谎言 —— 与本阶段自己的纪律自相矛盾

- `write-file.ts` 注释自认：「覆盖写严格说是幂等的……这里标成非幂等，是为了让『非幂等但可观察』这条路径有**通用工具**可测」。
- 这与本阶段把 `delay_ms` 赶出 `write_file`、把 `slow_write` 留在 cases 的理由（「能力面被测量需求反向定义」，方案 §2.1、micro-cases 包头）**直接自相矛盾**：同样的逻辑，`write_file` 的幂等性声明也被测量需求反向定义了，只是换了个字段。
- 实际后果：
  - resume 时覆盖写本应走分支一（`IDEMPOTENT_RETRY` 直接重跑，安全），现在落分支二（`OBSERVE_FIRST`，多一次观察 ＋ 一轮模型调用）—— 行为无害，但**系统性偏移 `resumeBranchCounts`**（阶段 2 研究问题「resume 落进哪条分支的分布」的数据被这个不诚实声明污染）；
  - 方案 §2.2【定】「`idempotency` —— 消息级恢复下它**是恢复正确性的前提**，不是可选优化」，声明应当诚实。
- 处置方向：标回 `isIdempotent: true`。分支二的可测载体本来就有 `slow_write` 与 `append_log`（都在 cases 里，为测量而生是它们的本职）。

### P2-2　`fetch_url` 二进制响应不按方案外置 Blob —— 方案 S7 白纸黑字，实现没做且没说明

- 方案 S7 契约：「二进制响应（PDF / ZIP / 图片）**不进 Context，只返回元数据并外置 Blob**」。
- 实现（`fetch-url.ts`）：二进制响应返回 `content: ""` ＋ note 说明，**没有外置 Blob**。方向比方案更保守，但存在一个真实缺口：模型想分析一个 PDF 时**既无正文也无取回通路** —— 这是「外置必须配对取回通路」（不得绕过 #9）同族的信息阻断，只是程度轻。
- 结构原因：`BlobStorePort` 是 TEXT 存储，二进制本来存不进去。说明方案这条与实现能力有 gap，需要一个明确处置：要么扩展 blob 存储支持二进制（超出本阶段成本），要么把方案口径修订为「二进制响应只回元数据、不外置」，并登记为已知差异 —— 而不是让代码与方案各说各话。
- 另注：`MAX_BODY_BYTES` 检查发生在 `Buffer.from(await res.arrayBuffer())` **之后**，响应体已整个缓冲进内存；一个数百 MB 的快速响应会全部读入（受 30s 超时保护，但内存不受限）。建议对 `res.body` 流式限量累积。P3 附记，不单列。

### P2-3　方案 §2.5 迁移代价 1 的「明确错误信息」没有专门实现

- 方案：「不做别名表，接受『迁移前的 Run 不能 resume』，**给一条明确的错误信息**」。
- 实际：旧 Run resume 时，冻结快照里的 `write_note` 会走到组合器 `TOOL_NOT_FOUND`：「没有任何已注册的工具包认领 write_note」。有错误，但不是「迁移前 Run 不能 resume」的明确说明 —— 用户看到的是工具名冲突，排查方向会指向装配而不是迁移。
- 处置方向：resume 入口加一次工具快照与当前装配工具名的比对，命中旧名时给出「这是阶段 3 迁移前的 Run，工具已改名，本版本不支持 resume 它」的明确错误。

### P2-4　verify:artifact C 段判据恒真（与 kimi 评审 P1-1 独立复核一致）

- 方案批 2 验收 C 明确要求换掉恒真断言，改成「`hasExternalUntrusted` 为 true 时 Trace 里出现对应事实」。
- 实际 `artifact.ts:329` 的 verdict 是 `untrustedFlowed && frames.length >= 2`：脚本化夹具 5 个工具调用 ＋ 两轮编帧下**必然为真**（`untrustedFlowed` 只要有一个 tool_result 就成立；`frames.length >= 2` 只要 Run 没崩就成立）。对 `EXTERNAL_UNTRUSTED` 标记值、`trustSummary` 汇总数字**一条都没有断言**（`:321` 只是 fact 打印）。
- 与 P1-1 同族：抬头（脚本头注释）换了，判据没换。处置方向：断言帧内 trust 分布（`hasExternalUntrusted === true` 且 counts 与 tool_result 数一致），或断言 `ContextFrameCompiled` 载荷里的 trust 摘要。

---

## 3. P3 问题（记录即可，不阻塞收口）

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| P3-1 | `MAX_REDIRECTS = 5` 死常量 | `fetch-url.ts:26` | `redirect: "follow"` 实际走 Node/undici 默认（20 次），常量只被 export 无消费。功能上满足方案「重定向有上限」，但常量 5 误导读者。删掉或真正用它 |
| P3-2 | CLAUDE.md / Roadmap 回写数字错误 | `CLAUDE.md`、Roadmap §5 | 「11 个工具（8 场景＋2 机制＋2 测量）」实际 **12 个**（8+2+2=12）；「起步价 ≈ 1980 token」实际 **2160**（verify:tools G 段实测）；「11 个工具全都声明了 requiredCapabilities」同理应为 12 |
| P3-3 | 读黑名单 `.envrc` 漏网 | `read-guard.ts` 前缀匹配 | `DENIED_BASENAME_PREFIXES` 匹配 `.env` 与 `.env.` 前缀，`.envrc`（direnv 配置，常含环境变量）不以 `.env.` 开头，漏网。建议收紧前缀或明确记录不挡的理由 |
| P3-4 | URL guard 的 DNS rebinding TOCTOU 未记录 | `url-guard.ts` | `assertPublicUrl` 用 `lookup` 判公网，`fetch` 内部再次解析，两次解析间攻击者可控 DNS 可切换。方案 §0.1 修订 2 说「接受残余风险，但 Trace 可审计」——风险可接受，但文件头应补一句已知限制，否则读代码的人以为护栏是完整的 |
| P3-5 | blob / artifact 无清理机制 | `blob-store.ts`、migrations M003 | 内容寻址去重了同内容，但跨 Run 无限累积（几百 KB/条）。开发期可接受，建议在欠账清单记一笔 |
| P3-6 | `list_dir` schema `required: ["path"]` 与 handler 默认值 `.` 冗余 | `list-dir.ts` | schema 强制必填，`input.path ?? "."` 是死分支（validation 先挡）。无害，清理即可 |
| P3-7 | verify:scenarios「无专属工具」判据强度有限 | `scenarios.ts` 总判定 | 脚本化模式三场景合计 6 工具、共享仅 `write_file`。判据「没有任何一个场景需要专属工具」实际只要求「每场景用到的工具都出现在合计里」，照场景 A 长的工具若被场景 B 用一次也能绿。方案 S13 判据表本来就这个强度，提示不改 |

---

## 4. 退出门槛 §5.2 八条核对

| 门槛 | 结论 | 关键证据 |
|---|---|---|
| 能力面成立（10 工具） | ✅ | `tools/common/src/index.ts` 场景 8 ＋ 机制 2；verify:tools 11/11 |
| 通用性成立（三场景） | ✅ | verify:scenarios 5/5：任务 A/B/C 各自结构、产物存在性、最小有效性三层过，无专属工具 |
| 不过拟合 | ✅ | 六条 grep 全过、6b 注入翻红（A2 段）；prompt 通读无业务规则（`compose.ts` DEFAULT_SYSTEM_PROMPT） |
| 机制被真需求逼出 | ✅ | 外置/取回（artifact A 段逐字比对）、ArtifactStore＋第二层验证（E/F/G 段）、Guard（progress A/B 段）、接管（D/E/F 段）各有 verify 段；多数含判别力实测。**例外见 P1-1 / P1-2** |
| 状态闭合 | ✅ | `WAITING_FOR_INTERACTION` 持久化（facade `trackWaitStatus`）、resume 重新发起接管不调模型（progress E 段真 kill -9）、等待扣除（F 段 1200ms → 4ms） |
| 数据边界护栏 | ✅ | 读黑名单双工具（tools F 段）、私网拒绝（artifact D 段）、URL scope riskFact＋dataMovement（D 段） |
| 无回归 | ✅ | 12 条脚本 84 判据全绿 ＋ typecheck EXIT=0 |
| 编排层未膨胀 | ✅ | 无 Planner/Memory/Sub-agent；固定开销实测 12 工具 → 2160 token（低于方案预估 1800×12/10 的线性外推，方案原估按 10 个通用工具计） |

---

## 5. 不得绕过清单 14 条核对

| # | 结论 | 关键证据 |
|---|---|---|
| 1 六条边界 grep | ✅ | verify:tools A 段实跑无违规；边界 1/5 用拆串规避自查污染（`lit()`，注释解释了为什么不加白名单） |
| 2 两类工具声明 | ✅ | B 段扫描 10/10：场景 8 各有三场景用例，机制 2 各有「服务的机制＋不做会怎样」 |
| 3 三个必填项 | ✅ | C 段全齐；`recoveryObservation` 已在类型上必填（`tool.ts` 去掉 `?`） |
| 4 不新增编排层 | ✅ | 无新增模块；ProgressGuard 是事件消费点不是编排 |
| 5 不建 web-archive | ✅ | 无 `cases/web-archive/` |
| 6 工具不得静默截断 | ✅ | D 段实测：list_dir 250→200＋nextCursor；read_file 5000 行分页；超长单行显式 `truncatedLines`；`materialize()` 外置 stub 保留协议合法形态 |
| 7 fetch_url 不内置正文提取 | ✅ | `fetch-url.ts` 只有取回＋类型/大小上报 |
| 8 检查器无任务级规则、有判别力 | ⚠️ | 无任务规则 ✅；四项检查中 ZIP/JSON/编码三项有判别力，**hash 一项恒真（P1-1）** |
| 9 外置配对取回通路 | ✅ | 无 blobs 时 `materialize()` 宁可 inline 不外置；`read_blob` 装配缺失返回明确错误 |
| 10 组合器三方法路由 | ✅ | `composite.ts` 三方法全路由；E 段判别力实测：改坏路由 edit_file 从 OBSERVE_FIRST 退化 RECOVERY_REQUIRED 并翻红 |
| 11 主循环纪律 | ✅ | NO_PROGRESS 走 `finish()` 具名 Terminal；Interaction 事件对是新增等待分支；进展不进 LoopState；run-loop 无 `profile.` |
| 12 persistFacts 整体带过 | ✅ | `artifactChecks` 在 run-loop 累计、facade resume 重建、settleInput 全链路带过（逐行核对） |
| 13 读黑名单双工具 | ✅ | `read-guard.ts` 单份常量表，read_file 与 search 共用；F 段各试一次 |
| 14 prompt 无业务规则 | ✅ | 通读 DEFAULT_SYSTEM_PROMPT：只有选择指引与安全约束 |

---

## 6. 与 kimi / zocode 评审的关系

本评审为独立完成，草稿不与另两份共享。交叉核对后发现：

- **与 kimi 的 P1-1 独立重合**：verify:artifact C 段判据恒真（本文 P2-4，独立核实成立 —— 我把它列 P2，因为该判据的**前半**「外部内容进入上下文」至少有 smoke 意义，且 D 段补了 riskFact 断言；kimi 定 P1 也有道理，建议合并处置）。
- **kimi 的 P1-2（progress D 段未断言「观察真的发生」）我独立复核成立**：D 段 ok 判据只断言状态流转与措辞，脚本里的 h2 `stat` 观察调用没有进判据；若脚本删掉 h2 直接收尾，D 段照样绿。本文不再单列，与 kimi 合并处置（一行级修复：`ok` 加 terminal 或断言 h2 的 tool_result 存在）。
- **本评审独有的两条 P1**（kimi / zocode 均未报）：hash 检查恒真（P1-1）、Progress Guard「还活着」半实现 ＋ HEARTBEAT 死声明（P1-2）。
- **本评审独有的 P2**：write_file 幂等性声明为测量而标（P2-1）、fetch_url 二进制不外置 Blob（P2-2）、迁移前 Run 的明确错误信息缺失（P2-3）。

---

## 7. 结论

**准予收口，附两条处置要求：**

1. **提交前必改（P1 × 2）**：给 `hash-matches-registration` 检查装上真实读盘或按诚实口径降级（P1-1）；`read_file`/`search` 的 HEARTBEAT 声明与实现对齐，或登记「还活着」判定缺失为欠账（P1-2）。两条都是「把恒真闸门拆掉或变成真的」，与本阶段自己立下的纪律一致。
2. **归档时改（P2 × 4）**：write_file 幂等性标回诚实值；fetch_url 二进制处置与方案口径对齐并登记；resume 入口补迁移提示；artifact C 段判据换真断言。

其余 P3 记录即可。实跑证据：12 条脚本 84 判据全绿、typecheck 干净、六条边界 grep 无违规 —— 本阶段的结构性判据是可靠的，问题集中在「新写的判据自身有没有判别力」这一层。
