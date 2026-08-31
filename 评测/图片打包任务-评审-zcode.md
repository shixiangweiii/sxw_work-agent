# Atlas 实测任务评审：B 站 opus 图片下载打包（run_75f0d6afafa6）

- **评审日期**：2026-08-31
- **评审人**：ZCode（结合最新代码实现 + 实际执行轨迹与日志的独立核验）
- **任务原文**：把 `https://www.bilibili.com/opus/1086460081202003973` 这个网页下的图片都下载下来，并打包成 images.zip
- **运行环境**：endpoint `ep_bailian_anthropic`，模型 `qwen3.7-plus`，工作空间 `/Users/shixiangweii/Desktop/temp`
- **证据来源**：`.workagent/runs/run_75f0d6afafa6.jsonl`（230 行事件流）、`.workagent/runs.db`（42 条完整消息：reasoning / 工具入参 / 工具结果原文）、产物实测（zip、11 个 JPEG）

---

## 总评

任务本身成功且无水分——终局总结里的每个数字都经独立核实；模型在 13 轮内的策略切换和环境适应质量不错。但这次运行也清晰暴露了一个架构级问题：**整个任务的最终交付物（58MB 的 images.zip）完全游离在产物登记与验证体系之外，"SUCCESS" 的判定 100% 依赖模型自述，Harness 承诺的 "verified outcomes" 在这类任务上没有兑现。**

## 一、结果独立核实（不信任模型自述）

| 检查项 | 结果 |
|---|---|
| zip 完整性 | `unzip -t` 通过，11 个条目 |
| 文件真实性 | 11 个全部为真 JPEG（`file` 确认），10 张 3024×4028、1 张 3024×1693 |
| 数量正确性 | 1 封面 + 10 正文 = 11，与文章 API 元数据一致 |
| 总结数字 | "642KB~6.6MB / 约 56MB" 与实际（657,592B ~ 6,894,765B / 55.97MiB）吻合 |
| 原图质量 | 确实去掉了 `@1192w` 压缩后缀，拿到 3024px 原图 |

运行指标：14 轮模型调用 / 13 次工具调用 / 活跃耗时 103.9s + 审批等待约 24s ≈ 总时长 128s / 计费输入 144,442 tokens（缓存读取从 4,612 增长到 16,425，缓存生效）/ 零连续失败。

## 二、执行轨迹还原与模型行为

13 轮动作链：`fetch_url`×3 → `run_shell`×10。关键转折点时间线：

| 轮次 | 动作 | 结果 |
|---|---|---|
| T1–T2 | `fetch_url` opus 页（raw / markdown） | 1374 字节验证码页（Dejavu 风控），正确识别 |
| T3 | `fetch_url` polymer 动态 API | `code:-352`（无 cookie 风控） |
| T4 | `run_shell` curl 带 UA+Referer 调 polymer API | 成功，识别为 DYNAMIC_TYPE_ARTICLE → cv42221352 |
| T5 | curl 调 article/view API | `image_urls` 仅 1 张，正确推断正文 10 图在 HTML 里 |
| T6 | `grep -P` 提取图片链接 | macOS BSD grep 不支持 `-P`，失败 |
| T7 | curl 下载 HTML 到 `/tmp` | seatbelt 沙箱拦截写入，失败 |
| T8 | curl 下载 HTML 到工作区 | 成功（53,898 字节） |
| T9–T10 | grep 图片后缀正则 ×2 | 均空结果（正文图 URL 在 HTML 里是 JSON 转义形式） |
| T11 | 放宽为裸 `hdslb.com` 匹配 | 命中 11 张 `@1192w` 图 URL |
| T12 | 循环下载 11 张（剥掉 `@1192w` 取原图） | 成功，约 18 秒，58MB |
| T13 | `zip` 打包 + `rm -rf` 清理临时目录 | images.zip 生成于工作区根 |

### 做得好的

- **风控诊断准确**。opus 页验证码只重试一次就换路径；`-352` 后立刻转 curl 带浏览器头，第 4 轮打通。
- **T5 的判断力**。article API 只回 1 张图，模型正确推断"正文 10 图在 HTML 里"而不是拿 1 张凑数交差。
- **T12 的筛选判断**。排除了默认头像 `noface.jpg@96w_96h_1c`，剥掉尺寸后缀取原图，编号 `image_01~11` 规范化——这些都没有人教。
- **终局诚实**。总结无任何夸大或虚构，全部可验证。

### 可改进的

- **约 5 轮消耗在环境适应上**：`grep -P`（T6）、`/tmp` 被沙箱拦（T7）、两次 grep 空转（T9/T10，先看数据再写正则本可避免）。对 13 轮总量可接受，但说明 shell 环境差异的处理可以沉淀进提示词。
- **编号顺序是哈希序不是文章序**：提取时 `sort -u` 后才编号，B 站文件名哈希不编码正文顺序，`image_01~11` 与阅读顺序无关。本次需求"都下载下来"不要求顺序，算轻微瑕疵。
- **T12 下载命令的静默失败风险**：`curl -s -L` 无 `-f`，若某 URL 404，错误页会被存成 `image_NN.jpg` 且循环照样打印 "Done downloading"。本次 11 个 URL 恰好全部有效（已逐个验证文件类型），属于**侥幸无恙而非机制保证**——直接引出第三节 P2。

## 三、Harness 机制评审

### 按设计正常工作的部分

1. **效应分类与审批门**。`fetch_url` 判为 NETWORK，不在 `TRUSTED_PERSONAL` 审批清单内（`packages/harness-runtime/src/action/policy.ts:87-89`，`requiresApprovalFor: ["WRITE","DELETE","EXECUTE"]`），自动放行；`run_shell` 判为 EXECUTE+IRREVERSIBLE，10 次全部走了人工审批。审批延迟 0.8–5.3 秒（首次 5.3s 是人在读命令），确认是真人交互而非 `--yes-all`——CLI 的"EXECUTE 不在自动放行范围"（`apps/cli/src/compose.ts:244-259`）守住了。
2. **seatbelt 沙箱真实拦截**。T7 写 `/tmp/bili_article.html` 静默失败，模型下一轮自行改写工作区。这正是 `tools/common/src/exec/sandbox.ts` 文件头声明的分工在生产中兑现："command-analysis 决定要不要问人，沙箱决定跑起来能碰到什么"。
3. **不可信内容标记**。每个 `tool_result` 被标为 `EXTERNAL_UNTRUSTED`（`packages/harness-runtime/src/context/compile.ts:362-367`），`untrustedItems` 随轮次 1→13 线性增长并进入策略输入作为风险信号。本次外部内容里没有注入攻击，防御未被考验但姿态正确。
4. **双层持久化分工清晰**。JSONL 事件流（230 行，轻量审计轨道）+ runs.db `transcript_entries`（42 条，含完整 reasoning、工具入参、结果原文）——本次评审能完整还原全靠后者。工具调用入参确实持久化了（`packages/harness-runtime/src/loop/run-loop.ts:830-834`）。
5. **预算与观测**。RUN_FACTS 逐轮落盘，ToolProgress 心跳（"仍在执行，已 5/10 秒"）在 18 秒的下载批期间持续可见，ContextFrameCompiled 全程 3→42 项、4.6k→17.6k tokens、未触发压缩。

### 发现的问题（按严重度排序）

#### P1｜产物链路对 shell 产物完全断裂 —— 本次最重要的架构发现

`run_shell` 的 outcome 从不携带 artifact（`tools/common/src/exec/run-shell.ts` 无任何 artifact 引用），唯一能登记产物的路径是 `write_file` 且要求模型显式传 `artifact_role`（`tools/common/src/fs/write-file.ts:179-201`）。结果：58MB 的交付物 zip → `artifacts` 表 0 行 → 终局 `deliveredArtifactIds: []`。`packages/harness-runtime/src/action/settle-batch.ts:657-661` 的注释表明这是刻意设计（"不扫 workspace、不从 output 里猜"），方向本身对——但代价是**现实中最常见的交付物产生方式（shell 产出二进制）在产物体系里不存在**：无哈希、无 zip 校验、无版本链、无"检查通过才计入交付"的闭环（`packages/harness-runtime/src/verification/settle-outcome.ts:49-53`）。SUCCESS 与交付物之间没有任何机械纽带。

#### P2｜验证层全程旁路

13 次 VerificationCompleted 全部 SKIPPED，原因在 `tools/common/src/index.ts:399` 的 `OBSERVED_TOOLS = {write_file, edit_file}`——只观察文件写入。对"下载并打包"任务，没有任何机制检查：文件魔数、zip 可解性、下载数 vs 提取数。叠加 T12 的 `curl` 无 `-f`，一个部分失败的任务（404 错误页被当 jpg 打包、或 120s 步超时砍掉后半批下载）依然会是 SUCCESS。本次是靠人工核验补上的这道关。建议方向：任务级交付物校验钩子，或给 `run_shell` 增加可选的"期望产物"声明让验证层有东西可查。

#### P3｜效应分类噪声造成真实的审批误伤

T11 的纯只读管道 `grep … | sort -u | head -50` 被判 EXECUTE+不可逆，被迫走了一轮人工审批。原因是 `extractPrograms`（`tools/common/src/exec/command-analysis.ts:201-211`）按 `|&;()` 切段后取"第一个不含 = 的 token"，把正则里的引号碎片 `'` 当成了程序名（效果串为 `programs:',gif,grep,jpeg,jpg,png,sort,webp`），含未知"程序"即不满足只读白名单。同理 UA 串碎片（`AppleWebKit/537.36`、`Chrome/120.0.0.0`、`Win64`、`x64`）常年混进效果串。代码注释明说这是"尽力而为、只服务展示与审计"——但它恰恰是**审批时人看到的东西**：噪声既造成本不该有的审批打断（10 次审批约 24s，占时长 19%），也稀释了人对 reason 串的信任。T13 的 `cd,ls,rm,zip` 至少是诚实的，人确实据此放行了 `rm -rf`——这个案例说明该串有真实价值，值得把噪声清干净。

#### P4｜fetch_url 无浏览器指纹，把可免审的读取推入了审批区

同一 API：`fetch_url` 请求 → 验证码页/`-352`；`run_shell` curl 带 UA+Referer → 成功。`tools/common/src/net/fetch-url.ts` 请求侧不带浏览器 UA 是直接嫌疑。后果有二：多耗 2 轮 + 把后续所有网络读取逼进 EXECUTE 审批通道。若 fetch_url 默认带浏览器式头，T4/T5 本可走免审批的 NETWORK 路径。（另一个角度：模型用 curl 伪装 UA 绕过 B 站风控本身是灰色操作，本次由人工审批把关——**人决定、Harness 守边界**，这个形状是对的。）

#### P5｜长批下载与超时的组合风险

11 张图串行下载 58MB 共用一个 120s 步超时（`tools/common/src/exec/run-shell.ts`：`DEFAULT_TIMEOUT_MS = 120_000`，文件头注明 MAX 必须等于 timeoutPolicy 的 2026-08-30 评审修复）。本次 18 秒完成；网络稍慢就会在第 N 张处整批超时，无断点、无部分产物语义，叠加 P2 后依然是 SUCCESS。方向：逐项下载或检查点。

#### P6｜观测面小项

JSONL 事件流不含工具入参/出参原文（设计如此，"事件不是持久化轨道"），仅靠 JSONL 做事后复盘是有损的——只要团队知情即可；`ModelStreamDelta` 58 条全部来自终局轮，中间轮的可见文本不在事件流里（reasoning 在 DB 中有），影响不大。

## 四、结论

- **模型侧**：合格偏好。风控对抗策略正确、无幻觉、终局诚实、筛选判断（取原图/排除头像）超出预期；扣分在环境适应消耗和下载命令无防御性校验。
- **Harness 侧**：审批门、沙箱、不可信标记、双层持久化、预算观测全部按设计兑现，其中沙箱对 `/tmp` 的拦截和 10 次真实人工审批是本次最有价值的实证。**核心短板集中且明确：交付物由 shell 产生时，产物登记与验证双缺席（P1+P2），SUCCESS 判定退化为模型自述。** 这不是本任务的偶然，而是"下载-打包"这类任务的原生形状，建议作为阶段 3 收尾或阶段 4 的优先议题——哪怕先做最小闭环（run_shell 声明期望产物 → 终局 zip 魔数+条目数检查 → 通过才进 deliveredArtifactIds）也能把"可验证结果"的承诺落回地面。
