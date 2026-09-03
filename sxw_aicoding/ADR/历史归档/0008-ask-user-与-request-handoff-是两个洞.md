# ADR-0008：`ask_user` 与 `request_handoff` 是**两个**洞

> 状态：ACCEPTED
> 日期：2026-08-30
> 对应决策点：阶段 3.5 决 3（没人回答时返回 NO_ANSWER 而不是失败）
> 影响的架构条款：V05 §20（人工接管）、§20.3（完成信号 ≠ 任务成功）
> 修订的既有结论：存量清单 **U-8**「不存在的 ask-user 工具」被记为**已关**（2026-08-28）
> 证据来源：Run `run_9610d44d3a62` 三次复跑；`verify:progress` H 段

## Problem

`tools/common/src/mech/request-handoff.ts` 的文件头写着：

> 它同时是 U-8 那个「不存在的 ask-user 工具」的落点 —— 两个洞是同一个。

而存量清单 §0.6 把 U-8 记为阶段 3 关掉的 7 项之一。

**那句话对了一半。** 回源核对 U-8 的原文（清单 line 656）：

> `WAITING_FOR_USER / USER_REJECTED` ——「两个值都只有类型定义、零产出点。
> 前者对应的 ask-user 工具不存在。」

U-8 说的是**枚举值没有产出点**这个状态机的洞。`request_handoff` 确实关掉了它：
现在有工具能把 Run 推进 `WAITING_FOR_INTERACTION` 了。

没关掉的是另一半 —— **「问一个没有外部动作的问题」这件事本身**。

## Hypothesis

做决策时的认知状态：两个工具都「停下来等人」，看起来可以合并。
真正把它们分开的是 `expected_completion` 这个**必填**字段。

## 两者的差别不是措辞，是语义

| | `request_handoff` | `ask_user` |
|---|---|---|
| 语义 | **你去做**一件我做不了的事 | **你来定**一个我定不了的事 |
| 外部世界 | 人真的去动了它 | 什么都没动 |
| `expected_completion` | **必填**，做完要能被观察到 | 不存在 —— 没有可观察的结果 |
| 之后 | **必须重新 Observation**（§20.3） | 直接用答案往下走 |
| 没人时 | **失败**（那件事真的没做） | **不失败**（模型可以自己定） |

硬要用 `handoff` 问一个偏好问题，模型必须为 `expected_completion` **编造**一个
可观察结果 —— 而那个字段的全部意义就是「别信人的口头声明，去核实」。
让它编，等于把 §20.3 那条纪律教成一句可以糊弄的话。

## 触发它的实测

2026-08-30 网页归档任务三次复跑，对「`images/` 目录该放什么」给出**三种不同结构**：

| 复跑 | 产物结构 |
|---|---|
| 1 | `pi-release-0.84.3/release-notes.md` ＋ `images/.gitkeep` |
| 2 | `release-0.84.3.md` ＋ `images/`（空目录条目） |
| 3 | `README.md` ＋ `images/README.md` |

页面**根本没有图片**，任务本身有歧义，而模型没有任何办法问一句。
三次都结算 SUCCESS，三次的产物不一样，而没有任何记录说明它做过选择。

## Alternatives

| 方案 | 优点 | 代价 | 何时会后悔 |
|---|---|---|---|
| A. 继续用 `request_handoff` 问 | 零新增工具 | 逼模型编造 `expected_completion`，把 §20.3 教成可糊弄的 | 第一次看到一个编出来的「预期结果」时 |
| B. 给 `handoff` 加一个 `kind` 字段 | 一个工具两用 | 两者**失败语义相反**，第一个写实现的人必然把两种失败处置成同一种 | 第一次无人值守跑批、一问就挂时 |
| **C. 独立机制工具（选中）** | 语义清晰；两条失败路径各自正确 | +180 token 固定开销 | 若实测显示模型从不调它 —— 那说明引导面有问题，不是工具有问题 |

## Decision（阶段 3.5 决 3）

**没有人回答时返回 `ok: true` ＋ `status: "NO_ANSWER"`，不是失败。**
这与 `request_handoff` 的处置**刻意相反**。

理由是实测过的形态：`request_handoff` 在非交互环境下报 `ok: false`，
于是 2026-08-30 那次跑批里模型一问就挂。但两件事的性质不同 ——

- handoff 缺的是**一个真实发生过的外部动作**，没发生就是没发生，报失败是诚实的；
- ask_user 缺的只是一个偏好，模型完全可以自己定一个走完。

报失败等于让一次**本可以完成**的任务因为旁边没人而中止。

同源的三条小决定：

1. **通道不注入不是装配错误。** `request_handoff` 不注入通道会报
   `TOOL_HANDOFF_NO_CHANNEL`（「能发起接管却无人接收 = 把 Run 挂死」），
   而 `ask_user` 不注入就走 NO_ANSWER。
2. **`QuestionChannel` 与 `HandoffChannel` 是两个接口，不合并。**
   合并意味着一个 `kind` 字段和两条 if 分支，而两者失败语义相反。
3. **`options` 是换行分隔的字符串，不是数组。** 本仓 `JsonSchemaProperty`
   只支持 string / number / boolean（极简子集，D-25 精神）。要传数组就得改
   `validateAndNormalize()` —— 那是**每一次工具调用**都要走的代码，
   为一个工具动它不划算，而 D-25 之下没有单测兜底。
   代价：格式靠工具自己校验，所以对数量（2–5）做了显式检查并给结构化错误。

## Consequences

### 好的

- 三条等待链路（审批 / 插话 / 接管）已经存在，`ask_user` **复用**它们：
  `waitsForHumanInteraction: true` 一行就拿到 `WAITING_FOR_INTERACTION`
  ＋ 等待时间从 active 墙钟扣除。Runtime 一行没改。
- 无人值守时不再中止。

### 坏的 / 要盯的

- **固定开销 +180 token**（13 → 14 个工具，2340 → 2520）。
- **「模型必须在总结里交代它选了什么」拿不到机械判据。**
  这条只能靠 description 与 system prompt 的引导面守（摸底考试 B 组那一类）。
  【定】不要为它硬造「description 里必须出现某个词」的判据 —— 那种判据没有判别力。
- **U-8 的记账要更正**：它关掉的是状态机那一半，另一半到阶段 3.5 才关。
  这本身是一条教训：**「两个洞是同一个」这种判断要回源核对原文**，
  而不是看它们表面上都「停下来等人」。

### 判据

`verify:progress` H 段三条，都做过判别力实测：

1. 有人时 → `WAITING_FOR_INTERACTION` ＋ 答案原样回到模型；
2. 没人时 → `ok:true` ＋ NO_ANSWER ＋ Run 照常 SUCCESS
   （**改成 `ok:false` 会让整个 Run 崩** —— 见下）；
3. 选项数非法 → 结构化错误，不静默按 1 个选项去问。

> 第 2 条的故障注入顺带撞出一个**独立的真 bug**：`settle-batch.ts` 里
> `renderError(outcome.error!)` 这个非空断言 —— 任何工具返回 `ok:false`
> 而没带 `error`，整个 Run 抛 TypeError 崩掉，且批内配对被破坏（不变量 8）。
> 已修（合成 `TOOL_CONTRACT_NO_ERROR`），判据在 `verify:pairing`。
