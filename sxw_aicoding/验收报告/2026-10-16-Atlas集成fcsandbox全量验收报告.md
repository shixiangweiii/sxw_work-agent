# Atlas 集成 fc-sandbox：全量验收报告

- 日期：2026-10-16
- 基线：Atlas `main` @ `d1a6a9e`（本批改动未提交）；fc-sandbox `claude/inspiring-maxwell-n5z73w` @ `21816a5`（本批改动未提交）
- 端点：百炼 Anthropic 形状 `qwen3.8-flash`（主力）；DeepSeek `deepseek-flash`（对照）
- 云沙箱：FC Agent Sandbox（cn-hangzhou），预装模板 `wmvj5ac9g2l0qywo9yrm`
- 流程：二次确认进展 → 修复遗留问题 → 免费全量验证 → 花钱的真实验证 → 修复验证中发现的问题 → 最终回归

## 0. 结论

| | 结果 |
|---|---|
| 免费回归 | `typecheck` 干净；`verify:all` **19 条脚本 / 393 条判据全绿、退出码 0** —— 这条 `&&` 链**第一次**从头跑到尾（此前一直断在 `verify:resource`） |
| fc-sandbox | `pytest` **221 条**全过（原 219 ＋ 本批 2）；pi 桥接 `node --test` 11 条全过 |
| 真实端点 | 场景 / 评测 / 对照端点 / 推理块探针 / Web 入口 / 跨进程 resume 全部跑过，**本批修掉 4 处由真实运行抓出来的问题** |
| 真实云沙箱 | 契约探针 5/5；CLI 三种审批路径与 Web 入口各跑一次，结果与本地真值逐字一致；云上残留 **0 台** |
| 遗留 | 第一轮留下的 S5-7 已由 ADR-0019 处置（第二轮，§8.5–8.8）；**仍需你在场的只剩真桌面 computer use**（§8.4） |
| 第二轮终态 | `verify:all` **19 条脚本 / 402 条判据**全绿；真实 Playwright 跑通 B 站题；ADR-0019 B ＋ C ＋ CG-4 实施，C 经预注册实验采纳；修掉「截断当完成」与 grader 误判 |

关掉的三道「要花钱」的历史门槛：**DeepSeek 对照端点实跑**（此前 401）、**真实端点在 Web 入口跑完一个多轮任务**（阶段 4 起开着）、**跨进程 resume 的真实端点实跑**（阶段 2 起开着）。

## 1. 二次确认的进展

上一个会话（[Atlas 最新开发进展-集成fcsandbox]）交付的 ADR-0016 / 0017 / 0018 三批，逐条回源核对后成立：

- `cloud_shell`：per-call 借用、用完即销毁、依赖烤进模板；出网策略由池子下发、Atlas 读回平台回显核对后才发命令。
- ADR-0017：断网 ＋ 无上传 → 自动放行；ADR-0018：`trustUploadsToPool`（默认关）放开带上传的断网调用。
- fc-sandbox：借用级出网策略、关公网直达、输出上限、超时保留输出、出网策略模块提取 —— **已提交**（`831439c`、`21816a5`），CLAUDE.md 里写的「未提交」是过时的。

二次确认时发现的遗留：`verify:resource` 在 HEAD 上崩在 F 段（导致 `verify:all` 从未跑完）、池子「暂停 → 销毁撞 409」只靠运行参数绕开、若干过时文档。

## 2. 本批修复

### R1　`verify:resource` F 段崩溃（遗留）

| | |
|---|---|
| 现象 | `JSON.parse` 一个按 12000 字符切开的页 → `Unterminated string at position 12000`；`verify:all` 的 `&&` 链因此从没跑到 `verify:scenarios` |
| 根因 | 判据只取第一页就解析，隐含「索引一页装得下」—— 而会被外置的索引按定义就装不下 |
| 实现侧也改了 | ResourceRefs 索引原来是一整行 JSON，`read_resource` 第一页恰好切在某条 ref 的字符串中间，**模型拿到的是半截 JSON**。改为按行写（头一行 ＋ 每行一条 ref，`+jsonl`），分页落在行边界上，每页都由完整条目组成 |
| 判据 | 改走真实的 `read_resource` 工具逐页读回（不直接调 Store），两条**成对**：①条数与索引头一致、夹具 120 条按序一条不少；②跨页切断的行为 0 |
| 注入 | 索引改回单行 → ①②都红；索引少写 21 条 → 只有①红；分页不按行边界切 → 只有②红。三向各自独立承重 |
| 文件 | `packages/harness-runtime/src/action/settle-batch.ts`、`apps/cli/src/verify/resource.ts` |

### R2　池子：补货目标不数 DESTROYING，容量上限照数（遗留，fc-sandbox）

| | |
|---|---|
| 现象（上一批真实云端） | 暂停后的沙箱归还时销毁撞 `409 PAUSING or RESUMING`，平台状态机滞后 8.5 分钟；`target_size=1` 的池子一台都不补，下一个借用方白等 180s |
| 根因 | `reserve_slot` 用**同一个总数**同时判补货目标与容量上限，卡在 DESTROYING、不可能再借给任何人的沙箱一直「算作库存」 |
| 修法 | 拆成两个数：`cap = max_size` 数全部（它在云上还活着，照样占配额）；`limit = target_size` 不数 DESTROYING |
| 判据 | `tests/test_atlas_egress.py` E 段**成对**：E1 销毁一直失败时仍能补上一台、借得到；E2 `max_size` 用满时照样借不到 |
| 注入 | 补货目标照旧数 DESTROYING → 只有 E1 红；容量也不数 DESTROYING → 只有 E2 红 |
| 不变的 | `POOL_PAUSE_ENABLED=false` 对 per-call 仍然建议（暂停是白付的代价）；默认值 `true` 不动（池子是通用的） |
| 文件 | `sandbox_pool/store/repository.py`、`sandbox_pool/core/maintainer.py`、`tests/test_atlas_egress.py`、README / 设计说明 / 实测笔记 |

### R3　过时文档（遗留）

- CLAUDE.md：fc-sandbox「未提交」→ 已提交；ADR-0016 段「还没有的：真实模型端点 / auto-grant」与「11 个包够不够用没有证据」→ 指向 ADR-0017 的答案；`verify:resource` 崩溃那条 → 已修；`verify:all` 注释；边界 grep 代码块补第 16 条；「16 条」→「编号 1…16、共 17 条」；「A 段机械跑这 14 条」→ 由表推出。
- ADR-0016：代价 ⑧ 与「还没有的」加更正注记（保留原文，不改写历史结论）。

### R4　`probe:reasoning-tokens` 在当前默认端点上误报 ✗（验证中发现）

`qwen3.8-flash` 的声明**刻意**不走远端 `count_tokens`（Context 层用本地估算），探针却打「端点没有返回 count_tokens 结果」并退出 1，读起来像端点坏了。改为如实打印「不适用」退出 0，并加 `--profile` 以便对 `qwen3.7-plus` 那份声明复测（见 §4.4）。

### R5　交付物声明的引导面（验证中发现）

| | live 任务数 | 声明并登记了 DELIVERABLE |
|---|---|---|
| 改前（2 轮 `verify:scenarios --live`） | 6 | **3**（50%） |
| 改后（5 轮） | 15 | **14**（93%） |

漏声明的后果：文件写对了，但第二层 Artifact 检查一项都没跑，`deliveredArtifactIds` 为空，**Run 照样结算 SUCCESS**。处置是 system prompt「收尾」段加一条、`write_file` description 写明「不传就不检查、不算交付」（版本 1.1.0 → 1.1.1，与 `cloud_shell` 1.0.1 同一先例）。
按本仓惯例**不造**「prompt 里必须出现某个词」的机械判据，靠 live 复跑验证。剩下的 1/15 说明引导面兜不了底 —— 根治是 S5-7。

### R6　`verify:scenarios` 第 ③ 项判据与机制工具的【定】自相矛盾（验证中发现）

live 第 1 轮里模型在一个任务中合理地 `ask_user` 了一次，第 ③ 项「独占工具必须是场景工具」就判「能力面被反向定义」。而 `commonMechanismTools` 的【定】写的正是机制工具「过不了三场景常用这一关，这**不是**问题」。脚本化模型从不调机制工具，所以它一直没响。
回源核对：豁免机制工具之后，它剩下能单独触发的只有 tools/common 以外的工具，而那正是第 ② 项（Case 包工具）的射程 —— **整个落在 ② 的覆盖区里，留着只会误报**。处置：从合取里拆除，改为如实打印「独占工具里哪些是机制工具」。

### R7　eval grader 把正确产物判错（验证中发现）

| | pass@1 | pass^5 |
|---|---|---|
| `archive-inventory@1.0.0` | 40%（2/5） | 不成立 |
| `archive-inventory@1.0.1` | **100%（5/5）** | **成立** |

1.0.0 的 3 次失败**全是同一条**「标出空目录『临时』」、都是 25/26。逐份核对 trace：三份清单都写着「临时 … 0 字节（唯一空目录）」，只是目录名**第一次**出现在开头的概览里（「临时、会议纪要、合同、设计稿」），`indexOf` 取到那一处，120 字符窗口里自然没有「空」。这是该文件注释里警告过的同一种错误第二次出现。
修法：看目录名的**每一处**出现。一次性正反检查：首处未标、后处标了 → 过；一处都没标 → 不过；注入「只看第一处」→ 前者翻回不过。
⚠️ 两组 5 次是**两批独立 trial**，不是对同一批产物重新判分；中间还夹着 R5 的 prompt 改动。能确定的是：1.0.0 那 3 次失败是 grader 漏判（看过产物原文）。

## 3. 免费全量验证

`npm run typecheck`：干净（含 `--noUnusedLocals --noUnusedParameters`）。

`npm run verify:all`（最终回归，含本批全部改动）：

| 脚本 | 判据 | | 脚本 | 判据 |
|---|---|---|---|---|
| endpoint-profile | 10 ✓ | | progress | 15 ✓ |
| pairing | 14 ✓ | | shell | 28 ✓ |
| resume | 5 ✓ | | ui | 84 ✓ |
| compact | 10 ✓ | | mcp | 29 ✓ |
| persistence | 8 ✓ | | computer | 57 ✓ |
| budget | 15 ✓ | | cloud | 32 ✓ |
| crash | 3 ✓ | | model-audit | 17 ✓ |
| drift | 6 ✓ | | resource | 10 ✓ |
| tools | 18 ✓ | | scenarios | 5 ✓ |
| artifact | 27 ✓ | | **合计** | **393 ✓ / 0 ✗** |

`eval:suite`（脚本化管路）：3/3 PASS，grader 1.0.1。
fc-sandbox：`pytest` 221 passed（189.9s）；`node --test …/bridge.test.mjs` 11 pass。

## 4. 花钱的真实验证

### 4.1 `verify:scenarios --live`（三场景 smoke）

| 轮 | 代码 | 结果 | 说明 |
|---|---|---|---|
| 0 | 改前 | 3/5 | 任务 C 漏声明交付物 |
| 0′ | 改前 | 2/5 | 任务 B、C 漏声明 |
| 1 | R5 后 | 4/5 | 三个都声明了；红的是第 ③ 项判据误报 `ask_user`（→ R6） |
| 2 | R5 后 | **5/5** | |
| 3 | R5＋R6 后 | 3/5 | 任务 C 漏声明（引导面的残差） |
| 4 | R5＋R6 后 | **5/5** | |
| 5 | R5＋R6 后 | **5/5** | |

### 4.2 `eval:suite --live 5`（归档盘点）

grader 1.0.1 那一组：26/26 × 5；轮次 9–12；token 中位 84,367（min 72,051 / max 124,460）；时延中位 79.6s（min 58.5 / max 113.0）；Runtime 自报与 grader 5/5 一致；无 resume、无未达成必需项。

### 4.3 `verify:drift --live`：7/7

DeepSeek 对照实跑 `COMPLETED / SUCCESS`，漂移事件 0、运行时错误 0 —— 在一个**会真的校验协议**的端点上没有出现配对相关的 400。此前登记的「当前 401」已不复现。

### 4.4 `probe:reasoning-tokens`

- 默认端点（qwen3.8-flash）：不适用（声明不走远端 `count_tokens`）。
- `--profile bailian-anthropic.json`（qwen3.7-plus）：`count_tokens` 含 / 不含 thinking 都是 **5227**，真实 `usage.input_tokens` **5350**，差 123（本地估算 92）—— D-3 结论（count_tokens 忽略推理块）实测复现，与该声明里的 `countTokensExcludesReasoning: true` 一致。

### 4.5 `probe:cloud-live`：5/5（Atlas × 真实池子 × 真实云沙箱）

| | |
|---|---|
| 整条链 | 上传 → 断网下用预装 pandas 算 → 取回 → 按真实字节登记，**1185ms** |
| 断网 | 沙箱里 curl pypi → `000blocked` |
| 白名单 | 放行 200、未放行 000 |
| 护栏 | `inputs=".env"` → `TOOL_READ_DENIED`，一台沙箱都没借 |
| 归还 | 无借出残留；acquire p50 1463ms、create p50 468ms、destroy p50 75ms |

池子参数：`POOL_TEMPLATE=wmvj5ac9g2l0qywo9yrm`、`TARGET_SIZE=1`、`MAX_SIZE=3`、`PAUSE_ENABLED=false`、独立新库、随机生成的访问 key（未入库）。

### 4.6 真实模型 × 真实云沙箱（CLI，`--approval default`，非 TTY）

数据：200 行 `sales.csv`（固定种子生成，本地另算真值）—— 规模刻意大到心算不现实。

| Run | 信任声明 | `cloud_shell` 审批 | 结果 |
|---|---|---|---|
| `run_27dc9813e231` | 开 | `AUTO_GRANT` | `region_totals.json` 与真值**逐字一致**；`riskFacts` 照记 `DATA_LEAVES_HOST`；模型随后的本机 `run_shell` 复核仍被拒 |
| `run_8fc75ecea093` | 关 | 被拒（`UNDECLARED`），终端提示点名 `trustUploadsToPool` | 模型**退回手工累加 200 行**，这次结果碰巧完全正确，并在总结里如实写明「pandas 没有真正跑起来」—— **Run 仍结算 SUCCESS** |
| `run_dccc685dc55b` | 关 | `AUTO_GRANT`（无上传） | `fib.json` 30 个数全对 |

第二行是 ADR-0018 登记的那条风险在更大规模上的复现：这次对了，但「用户显式要求的执行方式没做到」在结算上不可见（S5-7）。

### 4.7 Web 入口（`npm run ui`，`--approval auto`，经会话 Token 走 HTTP API）

`run_f42daf7a8563`：7 轮 / 8 次工具调用（`cloud_shell`、`run_shell`、`read_file`、`write_file`、`stat`）/ 52.9s / 计费输入 57,106 token；`qty_totals.json` 与真值一致、`report.md` 正确指出华北最多；两份 DELIVERABLE 都 `verified=true`；审批 5 次全记 `AUTO`。

### 4.8 跨进程 resume（真实端点）

`run_3415405644f9`：结算 3 批后在第 4 轮 `kill -9` 整个进程树 → 新进程 `--resume`：从 sequence 54 重建 7 条消息，横幅打出冻结预算（maxTurns 30）→ `COMPLETED / SUCCESS`。`owners.md` 9 位负责人、36 条事项逐人核对与真值一致；`progress.md` 6 份全记。

### 4.9 清理

- 池子：建 7、销 7；排空后 `total=0`；**从云平台侧只读列表**核对 `pool=default` 的沙箱为 **0 台**；池子进程已停。
- Web 服务已停；它启动时登记进 `.workagent-state/workspaces.json` 的临时 workspace 已摘除，活动 workspace 恢复为 `.workagent-workspace`。
- 临时目录与日志在 `/tmp/atlas-acceptance/`（含池子访问 key 文件，权限 600）。

## 5. 遗留事项

| # | 事项 | 为什么本批没做 |
|---|---|---|
| 1 | ~~S5-7：没有任务级完成契约~~ | ✅ 第二轮由 ADR-0019 处置（B ＋ C ＋ CG-4 已实施、**待你复核**），见 §8.5–8.8 |
| 2 | computer use 真桌面复测（CU-R01 / R03 / R09 / R10 只有假驱动判据） | 第二轮尝试过，**被 auto 模式的安全检查拦下**（见 §8.4）：R01 / R10 本质上要有人看审批卡，由我写脚本代答等于自己审批自己操作桌面。需要你在场 |
| 3 | ~~真实 Playwright MCP（B 站 `--approval auto` 那道题）~~ | ✅ 第二轮已跑通（§8.1） |
| 4 | `read_blob` 分页把 token 问题换成 turn 问题；MCP 输出目录不在 workspace | 前几批登记的设计问题，与本批无关 |
| 5 | 云沙箱代价：无成本轴、命令不流式、大输入每次重传、模板定死依赖、池子单模板 | ADR-0016 明确接受的代价 |
| 6 | Volume 做依赖缓存 | 平台挂载 500（疑似邀测未开通） |
| 7 | 小观察：附属 ResourceRefs 很多时，15 字节的工具结果本体也被外置（`approxTokens` 把 refs 算进去了），模型要多一次 `read_resource` | 既有行为、低频、低代价；登记不修 |
| 8 | 云上保留资源：`atlas-pipcache` 存储卷、预装 / 基线模板、`AtlasSandboxOSSVolumeRole` | 删不删由你定（存储卷目前挂不上，没有用途） |
| 9 | 推送 | 第一轮已提交（Atlas `810c166`、fc-sandbox `70c4e0b`），**都未推送**；§8 的改动另行提交 |

## 6. 改动清单

Atlas（10 个文件，含本报告，已提交为 `810c166`）：

| 文件 | 改动 |
|---|---|
| `packages/harness-runtime/src/action/settle-batch.ts` | R1：ResourceRefs 索引按行写 |
| `apps/cli/src/verify/resource.ts` | R1：F 段走 `read_resource` 逐页读回，成对判据 |
| `apps/cli/src/compose.ts` | R5：system prompt 收尾段加「交付物要声明」 |
| `tools/common/src/fs/write-file.ts` | R5：description ＋ 版本 1.1.1 |
| `apps/cli/src/verify/scenarios.ts` | R6：拆除与【定】矛盾的第 ③ 项 |
| `eval/graders/archive-inventory.ts` | R7：空目录判据看每一处出现，1.0.1 |
| `apps/cli/src/verify/reasoning-tokens.ts` | R4：不适用时如实说、`--profile` |
| `CLAUDE.md`、ADR-0016 | R3 ＋ 本批记录 |

fc-sandbox（6 个文件，已提交为 `70c4e0b`）：`sandbox_pool/store/repository.py`、`sandbox_pool/core/maintainer.py`、`tests/test_atlas_egress.py`、`README.md`、`docs/sandbox-pool-design.md`、`docs/fc-agent-sandbox-notes.md`。

## 7. 复现

```bash
npm run typecheck && npm run verify:all          # 免费，约 5 分钟
npm run verify:scenarios -- --live               # 花钱
npm run eval:suite -- --live 5                   # 花钱
npm run verify:drift -- --live                   # 花钱（DeepSeek）
npm run probe:reasoning-tokens -- --profile bailian-anthropic.json   # 花钱
# 云沙箱：先在 sxw_fc-sandbox 起池子（见 probe-cloud-live.ts 文件头），再
CLOUD_POOL_URL=http://127.0.0.1:8099 CLOUD_POOL_KEY=<key> npm run probe:cloud-live
```

fc-sandbox：`.venv/bin/python -m pytest`；`node --test sandbox_pool/agent/pi_bridge/test/bridge.test.mjs`。

## 8. 第二轮（同日，补完第一轮留下的事项）

### 8.1 真实 Playwright MCP：B 站图片打包题，`--approval auto`

ADR-0012 起开着的门槛：「用真实端点在 `--approval auto` 下把那道 B 站的题跑完」。
任务页面取自 2026-08-31 二次评审记录的原题（`opus/1086460081202003973`）。

| | |
|---|---|
| Run | `run_348754def81c`，CLI，`--approval auto`、沙箱开 |
| MCP | `@playwright/mcp@latest --headless --isolated`（不弹窗口、浏览器 profile 只在内存，不碰已有登录态目录）；配置放临时目录，没动 `.workagent-state/` |
| 过程 | 10 轮；`fetch_url` 被 B 站拦成验证码页 → 模型改用 `browser_navigate` ＋ `browser_evaluate` 从 DOM 区分正文图与封面 / 头像，`run_shell` 下载原图并打包 |
| 结果 | `COMPLETED / SUCCESS`；`images.zip` 58MB 进 `deliveredArtifactIds` |
| 独立核对 | `unzip -t` 无错；10 个文件头全是 `ffd8ff`；3024×4028 原图 |
| ADR-0012 的观察项 | 整个运行**没有一次 `rm -rf`** |

模型自己在总结里说明了两个取舍（封面图不算正文、文件名按顺序编号）—— 与 2026-08-31 那次 11 张的差别就在封面图。

### 8.2 真实运行抓到的第五处：`run_shell` 审计串的噪声

8.1 那次的审计串是 `programs:-H,-o,0f38…196213921,…,do,done,i+1,d[i+5:i+7],0xC4,import,PY,…`，
真程序名不到一半。`extractPrograms` 只服务展示与审计、不影响任何判定，但这一行是 EXECUTE 的人工边界，
噪声会稀释人对它的信任（该文件里的原话）。五个来源各对应一条 bash 语法，按语法剥掉，不做启发式：

| 噪声 | 来源 | 处置 |
|---|---|---|
| `-H` `-o` | 反斜杠续行 | `\` ＋ 换行直接删掉 |
| `import` `print` `PY` | here-doc 正文 | 正文行清空（**必须在抹引号之前**，否则 `<<'PY'` 的结束标记先被抹掉） |
| 资源 ID | 数组字面量 `ids=( … )` | 整段剥掉 |
| `i+1` | 算术展开 `$(( … ))` | 整段剥掉 |
| `for` `do` `done` | 保留字 | 前缀保留字跳过取下一个词；`for` / `case` / `done` 等整段不是命令 |

判据 `verify:shell` A 段：照真实形态写的一条命令，审计串必须**恰好等于** `cd,continue,curl,ls,mkdir,python3,set,wc`
（多一项＝某条规则没生效，少一项＝剥过了头）。**八处注入各自只翻红对应那一条**：五条新规则、保留字的两半各一次，
外加原有的 `://` 过滤与引号抹除。原「裸 URL」用例改成命令位置上的一行 URL —— 数组规则会把旧形态整段剥掉，
让它落进重叠区。

### 8.3 回归

`typecheck` 干净；`verify:all` **19 条脚本 / 394 条判据**全绿、退出码 0（`verify:shell` 28 → 29）。

### 8.4 computer use 真桌面：被安全检查拦下，需要你在场

计划是测 CU-R01 / R10：Web 入口 `--approval default`、白名单只放计算器（文本编辑里有你打开的文档，所以换了目标），
审批卡出现时读出描述（R10），**批准前先把 Finder 推到前台**模拟「审批界面抢走焦点」，看 Atlas 会不会切回计算器再打字（R01）。

写驱动脚本那一步被 Claude Code 的 auto 模式安全检查拒绝（Create Unsafe Agents）。这个判断是对的：
脚本经 HTTP 替人应答桌面操作的审批卡，事实表会把它记成 `HUMAN` —— 等于我自己审批自己操作你的桌面。
R01 / R10 本来就是「有人看审批卡」才成立的路径，**这一项需要你在场**：

```bash
npm run ui -- --computer control --computer-apps Calculator --approval default
# 在界面里提交：用键盘在计算器里算 123*45，把结果写进 calc.txt
# 每张审批卡核对描述是否完整（R10）；批准前先点一下别的应用（R01：应当切回计算器再输入，而不是打进别处）
```

授权状态已核对：`computer:doctor` 显示录屏与辅助功能均已授权、助手是最新的。

### 8.5 S5-7 → ADR-0019：草稿、离线回放、B

另开的会话起草了 [ADR-0019](../ADR/0019-任务级完成契约-重开通用Completion-Gate.md)，推荐「先做 B、C 做预注册实验、A 暂缓」。照推荐实施：

- **离线回放（不花钱）**：27 个真实 Run，B1 只在「清单写对了、没声明」的 6 个上触发，B2 只在没人接的 2 个上触发；
  E4、真桌面、跨进程 resume、Web、B 站、云沙箱这些**正确完成的 Run 一个都没触发**。
- **B1 / B2**：工具陈述完成信号 → 进 RUN_META → 结算吸收。`verify:artifact` K 段，8 处注入各自翻红。
- **live**：`run_52bcc91a28ef`，合同编号只在内部系统、非 TTY —— 两次 `request_handoff` 没人接 → `COMPLETED_WITH_LIMITS`（以前是 SUCCESS）。
- **预期变更**：`verify:pairing` 基线、`verify:ui` D3、`verify:resume`、脚本化 eval 四处夹具改成声明交付物。

### 8.6 CG-4 ＋ grader 1.1.0

eval 的「一致」拆成偏宽 / 偏严。B 生效后的 `eval:suite --live 5`：pass@1 4/5，偏宽 1、偏严 1。
**偏严**是 trial 5（清单正确、没声明 → B1，按设计）。**偏宽是假的**：trial 3 只差「合计字节数 20223」——
2026-08-28 探针早判为 grader 误判（任务原文只要「每个子目录的」总大小），文件一直没改。
`archive-inventory@1.1.0`：全局合计降软判据，补「每个子目录的总大小」硬判据（正反两个方向一次性检查过）。

### 8.7 C：预注册实验 → 采纳

判据先写进 ADR 再跑（违约侧 ≥4/5 且点名 pandas / 云沙箱；守约侧 ≤1/5）。池子重新拉起，同一道 200 行的题：

| | 结果 |
|---|---|
| 违约侧（信任声明关，百炼 ×5） | **4/5** 调了 `declare_unmet`，都引用「请在云沙箱里用 pandas…」→ `COMPLETED_WITH_LIMITS` |
| 守约侧（信任声明开，百炼 ×5） | **0/5**，5 次结果都与真值一致 |
| DeepSeek 各 1 次 | 违约侧声明、守约侧没声明 —— 方向一致 |
| 旁证 | C 生效下 `verify:scenarios --live` 3 个场景 0 次误声明、全部 SUCCESS |

`verify:artifact` K 段第 4 条（声明→降级、写错的声明被拒、只降不升），3 处注入各自翻红。

### 8.8 实验抓到的缺陷：被截断的工具调用被结算成「完成」

违约侧唯一没声明的那次（`run_9862d3f92cf9`）：模型写一个巨大的工具调用时撞上 8192 的单次输出上限，端点报 `stop_reason=tool_use`，
块没写完 → 适配器按 §8.4 丢掉 → 主循环看到 0 个 tool call → **SUCCESS，没有交付物、没有总结**。

修法：适配器报出丢弃数（`droppedToolCalls`）；主循环把「0 个 tool call 但有丢弃」走「抬高输出上限重试」那条既有的路，
用完 → `CONTEXT_EXHAUSTED`。判据 `verify:model-audit` I 段（真实适配器 ＋ 真 SSE），两处注入各自翻红。
⚠️ 第一版夹具用了 `stop_reason=max_tokens`，与既有的「推理吃光输出预算」守卫重叠 —— 注入时「一直截断」那条照样绿；
改成 live 原样的 `tool_use` 才有判别力。这条 live 复现靠模型行为、不可强制，判据用的是 live 那次的原样形态。

### 8.9 证据入库与清理

- ADR-0019 要求拍板前把仓外的 trace 摘录进仓：[附录](2026-10-16-附录-ADR-0019证据摘录.md)（脚本机械摘录，16 个 Run）。
- 云：第二轮池子建 12 销 12，平台侧只读列表 **0 台**，池子已停。

### 8.10 第二轮终态回归

`typecheck` 干净；`verify:all` **19 条脚本 / 402 条判据**全绿、退出码 0（第一轮 393 → 第二轮：`verify:shell` +1、`verify:artifact` +6、`verify:model-audit` +2）；
脚本化 `eval:suite` 3/3，偏宽 0、偏严 0。fc-sandbox 第二轮无改动（第一轮 221 条单测、11 条桥接测试照旧）。
