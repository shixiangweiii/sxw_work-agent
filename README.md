# WorkAgent

自建生产级 Agent Harness。学习导向，个人使用。

**当前状态：阶段 4 产品化半边完成（2026-09-02）—— 白盒界面、外部 MCP/浏览器、AUTO 模式与可配置预算已落地。**

阶段 1 Headless Walking Skeleton → 阶段 2 持久化与预算 → 阶段 3 通用能力面 →
阶段 3.5 内置 shell 执行 → **阶段 4 白盒界面**。阶段 1–3.5 全部 headless。
阶段 4 的另一半（Case 02 反证抽象）尚未开始。

---

## 快速开始

```bash
npm install
npm run typecheck

npm run ui        # 白盒界面：打印一个带会话 Token 的 loopback URL，用浏览器打开
npm run dev -- --task "看看根目录里有什么，然后写一份 summary.txt"   # 终端入口
```

两个入口是**同一套装配**：同一个 `compose()`、同一份工具集、同一个自动放行档位、
同一个库、同一个 trace 文件。差别只有一个 —— **「人在哪」**。

左上角可以**选目录、新建 / 切换工作空间**（一个 workspace 一套存储；跨 workspace
恢复旧 Run 会被 Runtime 的一致性闸门拒绝 —— 换根意味着后续所有相对路径的读写
都会落到另一个目录）。

界面默认视图不是聊天气泡，是**一次 Run 的解剖**：时间线（两条轨道按统一序列合并）／
逐轮解剖（帧构成 · usage · stopReason · 具名迁移）／预算八轴／产物（含第二层验证）／
Trace（原始 JSONL 按段分组）／恢复（§18.2 三条分支的命中次数与决策按钮）。

需要根目录 `.env` 提供百炼 Anthropic 形状的凭证（已 gitignore）：

```
dashscope_base_url_Anthropic=...
dashscope_model=qwen3.7-plus
dashscope_api_key=...
```

### 外部 MCP 与 Playwright（ADR-0011）

外部 MCP 是通用能力，不是 Playwright 专用适配：生产代码不认识任何 Playwright 工具名，
工具名、数量和参数 schema 全部来自启动时的 `tools/list`。当前只支持本地 stdio MCP。

```bash
mkdir -p .workagent-state
cp mcp.example.json .workagent-state/mcp.json
npm run ui
```

默认路径是 `.workagent-state/mcp.json`（跨 workspace）；文件不存在不是错误，
`--mcp-config <path>` 可以指定其他位置。示例命令使用
`["npx", "-y", "--registry=https://registry.npmjs.org", "@playwright/mcp@latest"]`，
显式使用公共 npm registry，并在启动时直接获得 Playwright MCP 的最新能力与修复。
代价是服务器代码及工具声明可能随重启变化；Atlas 会把 schema、description 和档位摘要纳入
工具 version，并在 resume 时显式报告外部工具漂移。

MCP 工具档位只能来自人写的配置，不读取服务器自述的 `annotations`；未配置的工具一律落到
最保守的 `execute`：

| 档位 | 含义 |
|---|---|
| `read` | 只读、幂等、自动放行；工具主动报错时记 `NO_EFFECT` |
| `execute`（默认） | 非只读、非幂等、逐次审批；失败可能记 `UNKNOWN` |

> **启用 MCP 配置就是向其中的 `command` 授予宿主用户级代码执行权。** MCP 进程在任何
> Run 和审批之前启动，不受 Atlas 的沙箱或 workspace 边界约束。逐次审批只约束模型请求的
> 某一次 `tools/call`，不是 MCP server 自主行为的安全边界。

浏览器任务推荐使用 `npm run ui`：Service 在多个 Run 和 workspace 切换之间复用同一个 MCP
进程。相应代价是 MCP 的 cwd 固定在 Service 启动时的 workspace；切换 workspace 后，MCP
写出的相对路径文件仍落在原目录。CLI 会在单次命令结束时关闭 MCP。当前工具结果通道只接文本；
image/resource 块不会进入上下文，但会明确提示模型发生了丢弃。

### 两条档位轴（ADR-0012）

它们**正交**，各有一个参数，CLI 与界面同一套。

```bash
--approval confirm|default|auto     # 审批：要不要停下来问人
--sandbox  on|off                   # 执行：跑起来能碰到什么
```

| `--approval` | 含义 |
|---|---|
| `default`（默认） | **自动放行** workspace 内、非 IRREVERSIBLE 的写；`append_log` 这类不可逆操作与 EXECUTE 仍逐次问 |
| `confirm` | 每一个**需要审批的**操作都问（不做有限自动放行）。注意读操作与 `fetch_url` 在任何档位下都不问 —— 那是决 3 的设计，换来的是三条护栏 |
| `auto` | 所有抵达审批器的操作自动批准，不会停下来问；Policy 的硬拒绝和沙箱边界不因此消失 |

| `--sandbox` | 含义 |
|---|---|
| `on`（默认） | `run_shell` 只能写 workspace 与本次调用的 `$TMPDIR`；**越界写由 Policy 直接拒绝** |
| `off` | 无沙箱：可写任意路径、可联网、越界写改为走审批。**凭证读禁与 env 白名单仍在** |

审批档位**运行中随时可改**（界面上的选择器，或终端审批提示里的 `a` = 本次 Run 不再问）；
执行特权**随 RunSpec 冻结**，改它要重启，换一档 resume 会被 §18.3 第三维闸门拒绝。

AUTO 下 `ask_user` 直接走“无人回答、模型自己定”的正常降级路径；`request_handoff` 仍然等待人，
因为登录这类动作如果没人实际完成，就是真的没有完成。每次审批的来源会记录为
`HUMAN`、`AUTO`、`AUTO_GRANT` 或 `UNDECLARED`，事后可区分。

> **「完全权限」要同时打两个参数**（`--approval auto --sandbox off`），没有 `--yolo` 这种一键预设 ——
> 两条闸门是分开拆的，那个决定应该有两个名字。此时**没有任何闸门**，启动横幅会红字说出来。

> 未知参数一律报错，不维护已删除参数的别名或迁移分支。

### 八条预算轴与最大 token

CLI 和 Service 启动参数可以覆盖新 Run 的默认预算；白盒界面的“新任务 → 预算”可以继续做
逐 Run 覆盖：

```bash
--max-turns <整数>
--max-wallclock <毫秒>
--max-total-wallclock <毫秒>
--max-model-calls <整数>
--max-tool-calls <整数>
--max-billed-input-tokens <整数>
--max-output-tokens <整数>
--max-consecutive-failures <整数>
```

例如：

```bash
npm run ui -- --max-turns 40
npm run dev -- --max-turns 40 --max-output-tokens 300000 --task "抓取网页并整理结果"
```

所有值必须是大于 0 的整数，非法参数会在服务或 Run 启动前失败。合并顺序是
`DEFAULT_BUDGETS ← 启动参数 ← 本次 Run 覆盖`，最终预算随 RunSpec 冻结。因此，给
`--resume` 同时传一个更大的 `--max-turns` 不能挽救已经撞墙的旧 Run；resume 仍使用原预算。

> `--max-output-tokens` 限制的是**整个 Run 累计产生的输出 token**，不是单次模型请求里的
> Anthropic `max_tokens`。单次请求的输出预留目前仍由 Context Policy 决定，没有独立 CLI 参数。

### 其余入口

```bash
npm run dev -- --list-runs                        # 库里有哪些 Run
npm run dev -- --resume <runId>                   # 接上一个没跑完的 Run
npm run dev -- --resume <runId> --recovery-decision CONTINUE --recovery-note "已人工确认"
npm run dev -- --endpoint deepseek --task "..."   # 换对照端点（受枚举约束，拼错立刻失败）
npm run dev -- --mcp-config ./my-mcp.json --task "..."  # 使用其他 MCP 配置
```

`--workspace <path>` 指定工作目录（默认 `.workagent-workspace`）；
`--db <path>` 指定 SQLite 库（默认 `<workspace>/.workagent/runs.db`）；
`--trace <file>` 指定事件流落盘位置（默认按 runId 定名，resume 续写同一文件），`--no-trace` 关闭。

CLI 与 Web 的每次模型推理还会默认写一份敏感调用审计：
`<workspace>/.workagent/model-invocations/<runId>/<invocationId>.jsonl`。它包含实际请求 body、
SDK 解码后的 Provider 事件、独立的流内错误和规范化结果，不含认证头/API key，
也不受 `--no-trace` 影响。SDK 的 ping 不记录，SSE error 进入 `provider_error`；
这里不承诺 wire-level 字节还原。
这些文件不得提交或随意分享；`count_tokens` 与 EVAL 不采集。
Web 界面的「逐轮解剖」会按每次 `invocationId` 显示查看入口；只有展开某次调用时，
才从受本地会话 Token 保护的单调用接口读取该文件。实际请求体、派生的上下文阅读视图、
Provider 原始事件与 Runtime 结果彼此分开展示，不会并入 Run 详情或 Trace。
Run 刷新会把审计请求结果交给该调用当前的面板挂载点；旧 DOM 或旧 Run 的延迟响应不会回写。

**运行期交互**：TTY 下 stdin 是**单一通道**，按「谁在等」分派三种语义 ——
RUNNING 敲一句话回车 = 插话；等审批时回车 = 应答；等接管时回车 = 完成信号。
非 TTY 优雅降级（审批按**拒绝**处置，接管按「没有人」处置，都不挂起）。

---

## 16 条验收脚本

不写单测（D-25）。验收以**可运行脚本**交付，输出可读证据供人判断，与 Spike 0 的探针形态一致。

```bash
npm run verify:all                 # 16 条脚本；每条打印可读证据与判据合计
```

| 脚本 | 挂了意味着 |
|---|---|
| `verify:endpoint-profile` | 端点能力声明没落地，换端点仍需改主循环 |
| `verify:pairing` | 消息级恢复下的批内配对代价比预估更大 |
| `verify:resume` | 恢复粒度选错了 —— 这是删掉纯 Kernel 的主要理由 |
| `verify:compact` | Compact 有实现但没真跑过 |
| `verify:persistence` | 真 `kill -9` 之后只凭 SQLite 接不上 |
| `verify:budget` | 八条预算轴有一条撞不到墙，或墙钟没扣掉等待 |
| `verify:crash` | 三个崩溃窗口 × 三条恢复分支有缺口 |
| `verify:drift` | 端点漂移检测或 resume 端点一致性闸门失效 |
| `verify:tools` | 边界破了，或工具声明与实现对不上 |
| `verify:shell` | `run_shell` 的两道闸门破了（只读判定放宽 / 沙箱失效） |
| `verify:artifact` | 大结果外置取不回来，或产物验不出真假 |
| `verify:progress` | 长任务被误杀、原地打转叫不停、人机通道不通 |
| `verify:ui` | ★阶段 4：Layer 2 开始推进执行语义、投影自己算数、本地通信边界破了、自动放行的正分支回退、失败的 resume 留幻影、或 RECOVERY_REQUIRED 的项看不见 |
| `verify:mcp` | ★ADR-0011：MCP 跑进 Runtime、默认档不保守、开放 schema 被裁剪、分页/失败分流/生命周期/resume 漂移处理失效 |
| `verify:model-audit` | 实际请求、SDK 解码 Provider 事件或独立错误没有落盘，或审计故障改变了 Run |
| `verify:scenarios` | 三个场景不再共用同一套工具（过拟合警报） |

`verify:scenarios -- --live` 与 `verify:drift -- --live` 用真实端点跑，**花钱，不在 `verify:all` 里**。

**判据必须有判别力。** 一条永远成立的断言不是判据，是装饰 —— 这是收口批的主要教训：
84 条全绿里有 4 条什么都没测（详见 CLAUDE.md「收口修复批次」）。新增判据要能指出
「改坏哪一行会让它翻红」，并在实施时真跑一次。

Eval 层（不复用生产结算路径，§24.1【定】）：

```bash
npm run eval:suite                 # 脚本化，不花钱，验管路（夹具→Run→manifest→grader→报告）
npm run eval:suite -- --live 5     # 真实端点跑 5 次，出 pass@1 / pass^5 / token 与时延分布
npm run eval:suite -- --endpoint deepseek
```

---

## 架构一句话

> 单进程、消息级持久化的 Agent Harness：主循环驱动模型与工具，端点差异以数据形式隔离在外，协议不变量 100% 由 Runtime 自持。

### 执行模型

```text
while (true) {
  ⓪ 排空 Interject 队列
  ① 编译 ContextFrame（外置 → Compact → 协议校验）
  ② 调模型（流式，delta 直接 yield）
  ③ 无 tool call → 结算 outcome，具名 Terminal 退出
  ④ 执行 ActionBatch（串行，每个 call 恰好一个 result）
  ⑤ 构造完整的下一个 LoopState，写明 transition.reason
}
```

**恢复走 transcript，不走状态快照。** `resume()` = 从 `RunStorePort` 读回**启动时冻结的** RunSpec
→ 读 transcript → 重建 messages ＋ 从 RUN_META 读回累计事实 → 按 §18.2 三条分支处置末尾
未配对的 tool_use → 从下一轮继续。

### 目录

```text
packages/harness-runtime/    Layer 3 全部
  src/loop/                  主循环、LoopState、Continue / Terminal、Progress Guard
  src/transcript/            消息追加与重建、逐 Action 事实 —— 恢复的唯一来源
  src/context/               ContextFrame 编译与 Compact
  src/action/                Effect 解析、Policy、批结算
  src/verification/          Verifier 与 outcome 结算
  src/model/capability/      端点能力声明的加载、冻结与漂移检测
  src/facade/                HarnessRuntime：start / resume / cancel / interject / inspect
packages/store-sqlite/       唯一允许 import node:sqlite 的地方（transcript / run / blob / artifact）
packages/testkit/            fake-endpoint-profile、fake-clock、crash-harness（真 kill -9）
eval/                        graders / suite / fixtures —— 只经 Facade
adapters/shape-anthropic-messages/   唯一允许 import Provider SDK 的地方
adapters/endpoint-profiles/  端点行为的**数据**形态，不是代码
tools/common/                Case 无关的通用能力面（9 场景 ＋ 3 机制工具）
tools/mcp/                   通用本地 stdio MCP 客户端；配置、生命周期、工具桥接与 handler
cases/micro-cases/           append_log 与 slow_write —— **测量工具**，不是能力
apps/cli/                    Composition Root ＋ 终端入口 ＋ 16 条验收脚本 ＋ 一次性探针
apps/workagent-service/      ★阶段 4。Layer 2：投影 / Runtime Host / 三条人机通道 / HTTP ＋ SSE
apps/workagent-ui/public/    ★阶段 4。Layer 1：**没有 src/、没有构建、没有一行 import**
```

不配置 MCP 时默认装配 **14 个工具**（9 场景 ＋ 3 机制 ＋ 2 测量），固定开销起步价 ≈ 2520 token
（§16.1【定·实测】每工具约 180 token）。启用 MCP 后会追加服务器在启动时声明的工具，
固定开销随工具数线性增加；工具数是随时可读的过拟合警报。

### 边界 grep：编号 1…13、共 14 条规则（有机械判据）

```bash
npm run verify:tools      # A 段机械跑这 14 条，别手工 grep（表在 apps/cli/src/verify/boundaries.ts）
```

| # | 规则 |
|---|---|
| 1 | Provider SDK 只在形状适配器里 |
| 2 | 端点名不进 Runtime 代码 |
| 3 | 主循环不读端点声明 |
| 4 | Runtime Core 不 import 任何工具实现 |
| 5 | `node:sqlite` 只在 `packages/store-sqlite/` |
| 6 / 6b | Runtime 与适配器不得依赖工具包；**通用工具不得依赖任何 Case 包** |
| 7 | 阶段 3.5：沙箱与命令解析不得进 Runtime / 适配器 |
| 8 | ★阶段 4：**UI 不得依赖任何后端模块**（它是浏览器资源，边界因此是物理的） |
| 9 | ★阶段 4：**Layer 2 不得推进执行语义**（不写状态、不起循环、不结算 outcome） |
| 10 | ★阶段 4：**模型产出不得走 `innerHTML`**（审批面板是 EXECUTE 唯一的人工边界） |
| 11 | ★阶段 4 收口：**界面不得用内联 `style` 属性** —— 它会被自己的 CSP 静默丢弃，八条预算轴曾因此全部渲染成满格 |
| 12 | ★ADR-0011：**MCP 客户端不得进 Runtime / 适配器**；协议与进程管理属于工具域 |
| 13 | ★阶段 4：界面高度不得用“视口减写死常数”计算；MCP notice 让顶栏换行后该假设会失效 |

前两条是研究问题「端点差异能否被完全挡在主循环之外」的机械判据。
判据要区分**注释、类型定义与真实依赖** —— 这些文件里到处在引用规则本身，
所以照抄原始 grep 命令会假红，权威形态是 `verify:tools` A 段（它过滤注释行，
并对第 6b 条做 canary 注入实测）；MCP 边界的判别力由 `verify:mcp` A 段验证，
阶段 4 的 UI 边界由 `verify:ui` A 段验证。

第 7 条与第 4 / 6 条同源但形态不同：`run_shell` 的诱惑不是 import 工具包，
而是把命令解析和沙箱 profile 生成搬进 `packages/harness-runtime/src/action/` ——
那里本来就叫 effect-resolver。搬进去之后 Runtime 就认识 shell 了，
而第 4 / 6 条**一条都抓不到**（它没有 import 任何工具包）。

---

## 已知限制

| 限制 | 何时解决 |
|---|---|
| 跨进程 resume 与 DeepSeek 对照端点的**真实端点实跑**（要花钱） | 统一评测阶段（决 4） |
| S13 三场景由脚本化模型驱动，证据等级是 **smoke** | 同上，换真实端点跑一遍 |
| `fetch_url` 二进制正文取不回（Blob 只吃文本、工具拿不到 blob 句柄） | 需先扩 Port 与执行上下文 |
| 基于进展的「还活着」判定（进展是批结算时才排空的） | 需先把工具执行改成 generator |
| `requiredCapabilities` 逐工具零消费 | bugfix 阶段接授权层，或删掉 |
| **在界面上用真实端点跑完一个多轮任务**（要花钱；当前 D 段由脚本化模型驱动，证据等级 smoke） | 统一评测阶段 |
| Web 入口同时只允许一个前台 Run（接管/提问通道不带 runId） | 需先扩 Runtime 侧接口，等真实并发场景 |
| MCP 仅支持本地 stdio；resources/prompts/OAuth 与远程传输未实现 | 出现真实服务器需求时扩协议面 |
| MCP image/resource 块不能进入当前字符串结果通道 | 需先扩工具结果与 Blob/Artifact 字节通道 |
| MCP 登录态、cwd 与磁盘残留位于 transcript/workspace 边界之外 | 保持显式提示；需要会话身份与清理需求时再建机制 |
| Eval Inspector 独立视图（Trace Inspector 已做） | 评测阶段有多份报告要横向比时 |
| Session 与配置管理（无 Session 概念，`SESSION_MESSAGE` 至今零产出点） | 有真实多轮会话需求时 |
| Case 02 反证抽象 | 阶段 4 的另一半 |

完整清单见[存量问题清单](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)（按阶段追加，**§0.12 是阶段 4**）。

---

## 文档

| 文档 | 作用 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | 面向协作的工程说明，**最常读的那份** |
| [架构设计 V05](sxw_aicoding/架构设计/WorkAgent架构设计_V20260823_05.md) | **当前实现依据** |
| [上位基线 v0.4](sxw_aicoding/方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md) | 项目目标与上位原则，与架构设计冲突时以它为准 |
| [阶段 Roadmap](sxw_aicoding/阶段roadmap/WorkAgent阶段Roadmap_V20260823.md) | 各阶段研究问题与退出门槛 |
| [阶段 4 实施方案](sxw_aicoding/实施方案设计/阶段4实施方案_V20260830.md) | **当前阶段的实现依据** |
| [阶段 3 实施方案](sxw_aicoding/实施方案设计/阶段3实施方案_V20260828-02.md) | 通用能力面那一阶段 |
| [存量问题清单](sxw_aicoding/存量BUG/存量问题清单_V20260824.md) | 按阶段追加，不是只管阶段 1 |
| `sxw_aicoding/ADR/` | 决策记录（ADR-0001…0012，另有模板） |
| `sxw_aicoding/代码评审/` | 按日期分目录 |
| `sxw_aicoding/WorkAgent调研/ProviderProtocolFacts_*.md` | Spike 0 三轮实测事实（75 份证据 / 4 个端点） |
| `spikes/s0-provider-protocol/` | 一次性探针，已完成，不进主干依赖 |

代码里的实测数字（每工具 180 token 固定开销、每请求底数 5、`count_tokens` 0.00% 误差、
缓存严格前缀等）都来自 Spike 0 的 75 份原始证据，注释中标注了出处。
