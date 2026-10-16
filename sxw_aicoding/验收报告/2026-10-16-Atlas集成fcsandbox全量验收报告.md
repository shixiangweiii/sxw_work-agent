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
| 遗留 | 最重的一条仍是 **S5-7（没有任务级完成契约）**，本批拿到了它的新证据，但它要一份 ADR，不是补丁（见 §5） |

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
| 1 | **S5-7：没有任务级完成契约** | 本批两条新证据：引导面改完仍有 1/15 漏声明交付物；信任声明关闭时模型退回心算、Run 照样 SUCCESS。根治要重开「通用 Completion Gate」那个已拍板的决定（论据曾被探针推翻），**要一份 ADR、要你拍板**，不是补丁 |
| 2 | computer use 真桌面复测（CU-R01 / R03 / R09 / R10 只有假驱动判据） | 会接管你的真实鼠标键盘、把真实屏幕截图发往端点（R11 隐私事故的同一条路），需要你在场授权 |
| 3 | 真实 Playwright MCP（B 站 `--approval auto` 那道题） | `.workagent-state/mcp.json` 未配置；要拉 `@playwright/mcp@latest` 并开真浏览器 |
| 4 | `read_blob` 分页把 token 问题换成 turn 问题；MCP 输出目录不在 workspace | 前几批登记的设计问题，与本批无关 |
| 5 | 云沙箱代价：无成本轴、命令不流式、大输入每次重传、模板定死依赖、池子单模板 | ADR-0016 明确接受的代价 |
| 6 | Volume 做依赖缓存 | 平台挂载 500（疑似邀测未开通） |
| 7 | 小观察：附属 ResourceRefs 很多时，15 字节的工具结果本体也被外置（`approxTokens` 把 refs 算进去了），模型要多一次 `read_resource` | 既有行为、低频、低代价；登记不修 |
| 8 | 云上保留资源：`atlas-pipcache` 存储卷、预装 / 基线模板、`AtlasSandboxOSSVolumeRole` | 删不删由你定（存储卷目前挂不上，没有用途） |
| 9 | **两个仓库都未提交、未推送** | 等你审 |

## 6. 改动清单

Atlas（10 个文件，含本报告，未提交）：

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

fc-sandbox（6 个文件，未提交）：`sandbox_pool/store/repository.py`、`sandbox_pool/core/maintainer.py`、`tests/test_atlas_egress.py`、`README.md`、`docs/sandbox-pool-design.md`、`docs/fc-agent-sandbox-notes.md`。

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
