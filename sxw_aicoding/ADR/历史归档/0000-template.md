# ADR-NNNN：<决策标题>

> 状态：PROPOSED | ACCEPTED | SUPERSEDED by NNNN | DEPRECATED
> 日期：YYYY-MM-DD
> 对应决策点：V03 §30 D-xx（若有）
> 影响的架构条款：V03 §x.y、§z.w
> 证据来源：Spike N / Micro Case / 故障注入用例编号 / Eval 实验编号

## Problem

要解决的 Harness 问题是什么。**为什么现在必须决**——它阻塞了什么。

如果这个问题可以推迟，就不该写 ADR，直接记进 backlog。

## Hypothesis

对原因和方案的假设。写下**做出决策时的认知状态**，包括当时不知道的东西——
这一段是日后 Postmortem 判断「决策错了还是信息错了」的唯一依据。

## Alternatives

至少两个候选方案。每个写清：

| 方案 | 优点 | 代价 | 何时会后悔 |
|---|---|---|---|
| A. | | | |
| B. | | | |

「何时会后悔」一列不能空。想不出来说明候选没想清楚。

## Decision

选了哪个，**一句话**。

然后是理由。理由必须引用证据，不能只有推理。如果没有证据，状态只能是 PROPOSED。

## Consequences

### 接受的代价

明确列出。「没有代价」意味着这不是一个决策。

### 适用条件

这个决策在什么前提下成立。前提变化时必须重新评估。

### 重新评估的触发条件

具体、可观测。例如「当第二个 Case 需要 X 时」「当 Eval 显示 Y 退化超过 Z% 时」。

## Eval Evidence

可重复的结果与失败样本。指向 raw 日志、GoldenTrace fixture 或 Eval 实验编号。

没有证据的 ADR 不能是 ACCEPTED。

## Interview Narrative

能向他人清晰解释的版本：问题是什么、为什么难、权衡在哪、依据是什么。

三到五句话。写不出来说明自己还没真的想清楚。
