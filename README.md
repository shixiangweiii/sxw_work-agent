# WorkAgent

自建生产级 Agent Harness。学习导向，个人使用。

**当前状态：阶段 1（Headless Walking Skeleton）已完成。**

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

`--yes` 跳过交互式审批，`--workspace <path>` 指定工作目录（默认 `.workagent-workspace`）。

## 三条验收脚本

不写单测（D-25）。验收以**可运行脚本**交付，输出可读证据供人判断，与 Spike 0 的探针形态一致。

```bash
npm run verify:endpoint-profile   # 端点差异能否被挡在主循环之外
npm run verify:pairing            # 批内配对不变量能否守住
npm run verify:resume             # 消息级恢复够不够用
npm run verify:all
```

| 脚本 | 挂了意味着 |
|---|---|
| `verify:endpoint-profile` | 端点能力声明没落地，换端点仍需改主循环 |
| `verify:pairing` | 消息级恢复下的批内配对代价比预估更大 |
| `verify:resume` | 恢复粒度选错了 —— 这是删掉纯 Kernel 的主要理由 |

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

**恢复走 transcript，不走状态快照。** `resume()` = 读 transcript → 重建 messages → 从下一轮继续。

### 目录

```text
packages/harness-runtime/    Layer 3 全部（14 个 Port，阶段 1 实现 10 个）
  src/loop/                  主循环、LoopState、Continue / Terminal
  src/transcript/            消息追加与重建 —— 恢复的唯一来源
  src/context/               ContextFrame 编译与 Compact
  src/action/                Effect 解析、Policy、批结算
  src/model/capability/      端点能力声明的消费与漂移检测
packages/testkit/            fake-endpoint-profile、脚本化 decider 等
adapters/shape-anthropic-messages/   唯一允许 import Provider SDK 的地方
adapters/endpoint-profiles/  端点行为的**数据**形态，不是代码
cases/micro-cases/           两个工具：只读快的 ＋ 可控慢的可验证写的
apps/cli/                    Composition Root ＋ 三条验收脚本
```

### 四条边界（有机械判据，可 grep）

```bash
# 1. Provider SDK 只在形状适配器里
grep -rn "@anthropic-ai/sdk" packages apps cases    # 应无结果

# 2. 端点名不进 Runtime 代码（注释里的实测引用不算）
grep -rn "dashscope" packages/harness-runtime/src   # 应无结果

# 3. 主循环不读端点声明
grep -n "profile\." packages/harness-runtime/src/loop/run-loop.ts   # 代码行应无结果

# 4. Runtime Core 不 import Case Package
grep -rn "micro-cases" packages/harness-runtime/src # 应无结果
```

前两条是研究问题「端点差异能否被完全挡在主循环之外」的机械判据。

---

## 阶段 1 的已知限制

| 限制 | 何时解决 |
|---|---|
| **进程退出即失忆**（transcript 只在内存） | 阶段 2 换 SQLite |
| Compact 写了但没被真跑过（普通任务撞不到上下文墙） | 阶段 2 造超长输入 |
| Artifact 登记、Blob 外置、Capability lease、Secret 解析 | 阶段 2–3 |
| 图形界面 | 阶段 4 |

---

## 文档

| 文档 | 作用 |
|---|---|
| [架构设计 V05](sxw_aicoding/架构设计/WorkAgent架构设计_V20260823_05.md) | **当前实现依据** |
| [阶段 Roadmap](sxw_aicoding/阶段roadmap/WorkAgent阶段Roadmap_V20260823.md) | 各阶段目标与判据 |
| [阶段 1 实施方案](sxw_aicoding/实施方案设计/阶段1实施方案_V20260823.md) | 本阶段的分步计划 |
| [上位基线 v0.4](sxw_aicoding/方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md) | 项目目标与上位原则 |
| `sxw_aicoding/WorkAgent调研/ProviderProtocolFacts_*.md` | Spike 0 三轮实测事实 |
| `spikes/s0-provider-protocol/` | 一次性探针，已完成，不进主干依赖 |

代码里的实测数字（360 tokens 固定开销、每请求底数 5、`count_tokens` 0.00% 误差、缓存严格前缀等）都来自 Spike 0 的 75 份原始证据，注释中标注了出处。
