# WorkAgent

自建生产级 Agent Harness。学习导向，个人使用。

**当前状态：阶段 3（通用能力面）开发完成 ＋ 收口修复批次（2026-08-28）。**
阶段 1 Headless Walking Skeleton → 阶段 2 持久化与预算 → 阶段 3 通用能力面。GUI 在阶段 4，阶段 1–3 全部 headless。

---

## 快速开始

```bash
npm install
npm run typecheck
npm run dev -- --task "看看根目录里有什么，然后写一份 summary.txt"
```

需要根目录 `.env` 提供百炼 Anthropic 形状的凭证（已 gitignore）：

```
dashscope_base_url_Anthropic=...
dashscope_model=qwen3.7-plus
dashscope_api_key=...
```

### 审批档位（阶段 3 决 3 改过默认值）

| 写法 | 含义 |
|---|---|
| （默认） | **自动放行** workspace 内、非 IRREVERSIBLE 的写；`append_log` 这类不可逆操作与 EXECUTE 仍逐次问 |
| `--confirm` | 恢复「每一步都问」 |
| `--yes-all` | 显式的「批准一切」 |

`--yes` 是默认档位的显式写法，保留只为不破坏既有命令行 —— 它不改变任何行为。
**越界写由 Policy 直接拒绝，不给审批机会**：授权边界不该退化成「每次问一下」。

### 其余入口

```bash
npm run dev -- --list-runs                        # 库里有哪些 Run
npm run dev -- --resume <runId>                   # 接上一个没跑完的 Run
npm run dev -- --resume <runId> --recovery-decision CONTINUE --recovery-note "已人工确认"
npm run dev -- --endpoint deepseek --task "..."   # 换对照端点（受枚举约束，拼错立刻失败）
```

`--workspace <path>` 指定工作目录（默认 `.workagent-workspace`）；
`--db <path>` 指定 SQLite 库（默认 `.workagent-state/runs.db`）；
`--trace <file>` 指定事件流落盘位置（默认按 runId 定名，resume 续写同一文件），`--no-trace` 关闭。

**运行期交互**：TTY 下 stdin 是**单一通道**，按「谁在等」分派三种语义 ——
RUNNING 敲一句话回车 = 插话；等审批时回车 = 应答；等接管时回车 = 完成信号。
非 TTY 优雅降级（审批按**拒绝**处置，接管按「没有人」处置，都不挂起）。

---

## 12 条验收脚本 / 86 条判据

不写单测（D-25）。验收以**可运行脚本**交付，输出可读证据供人判断，与 Spike 0 的探针形态一致。

```bash
npm run verify:all                 # 12 条脚本 / 86 条判据
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
| `verify:tools` | 六条边界破了，或工具声明与实现对不上 |
| `verify:artifact` | 大结果外置取不回来，或产物验不出真假 |
| `verify:progress` | 长任务被误杀、原地打转叫不停、人机通道不通 |
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
tools/common/                Case 无关的通用能力面（8 场景 ＋ 2 机制工具）
cases/micro-cases/           append_log 与 slow_write —— **测量工具**，不是能力
apps/cli/                    Composition Root ＋ 入口 ＋ 12 条验收脚本 ＋ 一次性探针
```

默认装配 **12 个工具**（8 场景 ＋ 2 机制 ＋ 2 测量），固定开销起步价 ≈ 2160 token
（§16.1【定·实测】每工具约 180 token）。工具数是随时可读的过拟合警报。

### 六条边界（有机械判据）

```bash
npm run verify:tools      # A 段机械跑这六条，别手工 grep
```

| # | 规则 |
|---|---|
| 1 | Provider SDK 只在形状适配器里 |
| 2 | 端点名不进 Runtime 代码 |
| 3 | 主循环不读端点声明 |
| 4 | Runtime Core 不 import 任何工具实现 |
| 5 | `node:sqlite` 只在 `packages/store-sqlite/` |
| 6 / 6b | Runtime 与适配器不得依赖工具包；**通用工具不得依赖任何 Case 包** |

前两条是研究问题「端点差异能否被完全挡在主循环之外」的机械判据。
判据要区分**注释、类型定义与真实依赖** —— 这些文件里到处在引用规则本身，
所以照抄原始 grep 命令会假红，权威形态是 `verify:tools` A 段（它过滤注释行，
并对第 6b 条做 canary 注入实测）。

---

## 已知限制

| 限制 | 何时解决 |
|---|---|
| 跨进程 resume 与 DeepSeek 对照端点的**真实端点实跑**（要花钱） | 统一评测阶段（决 4） |
| S13 三场景由脚本化模型驱动，证据等级是 **smoke** | 同上，换真实端点跑一遍 |
| `fetch_url` 二进制正文取不回（Blob 只吃文本、工具拿不到 blob 句柄） | 需先扩 Port 与执行上下文 |
| 基于进展的「还活着」判定（进展是批结算时才排空的） | 需先把工具执行改成 generator |
| `requiredCapabilities` 逐工具零消费 | bugfix 阶段接授权层，或删掉 |
| 图形界面 | 阶段 4 |

完整清单见[存量问题清单](sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md)（按阶段追加，§0.7 是收口批）。

---

## 文档

| 文档 | 作用 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | 面向协作的工程说明，**最常读的那份** |
| [架构设计 V05](sxw_aicoding/架构设计/WorkAgent架构设计_V20260823_05.md) | **当前实现依据** |
| [上位基线 v0.4](sxw_aicoding/方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md) | 项目目标与上位原则，与架构设计冲突时以它为准 |
| [阶段 Roadmap](sxw_aicoding/阶段roadmap/WorkAgent阶段Roadmap_V20260823.md) | 各阶段研究问题与退出门槛 |
| [阶段 3 实施方案](sxw_aicoding/实施方案设计/阶段3实施方案_V20260828-02.md) | 当前阶段的实现依据 |
| [存量问题清单](sxw_aicoding/存量BUG/阶段1存量问题清单_V20260824.md) | 按阶段追加，不是只管阶段 1 |
| `sxw_aicoding/ADR/` | 决策记录（6 份） |
| `sxw_aicoding/代码评审/` | 按日期分目录 |
| `sxw_aicoding/WorkAgent调研/ProviderProtocolFacts_*.md` | Spike 0 三轮实测事实（75 份证据 / 4 个端点） |
| `spikes/s0-provider-protocol/` | 一次性探针，已完成，不进主干依赖 |

代码里的实测数字（每工具 180 token 固定开销、每请求底数 5、`count_tokens` 0.00% 误差、
缓存严格前缀等）都来自 Spike 0 的 75 份原始证据，注释中标注了出处。
