# ADR-0002：恢复可观测性从工具静态字段改为 Action 级事实

> 状态：ACCEPTED
> 日期：2026-08-26
> 对应决策点：存量清单 E-2（复评报告 P1）；阶段 2 实施方案「决 6」
> 影响的架构条款：V05 §18.2【定】（三条恢复分支）、§18.5【定】（TranscriptEntry Contract）、§12.3（ToolDefinition）
> 证据来源：`verify:crash`（真 `kill -9`）；`write_note` 自己的 idempotency 注释

## Problem

§18.2 的三条恢复分支靠 `verification.mode !== "NONE"` 分流，而**那个字段说的是
「执行后能不能验」，被拿来回答「崩溃后能不能观察」。**

两件事真的不同：`append_log` 执行后验不了（验证器不知道「该有几行」），
但崩溃后能不能观察，取决于**执行前有没有留下前置指纹**。

**为什么现在必须决**：阶段 2 的研究问题是「跑够多真实任务，统计有多少次 `resume()`
落进『非幂等且不可观察』那条分支」。分流依据若长在被测对象身上，测的就是它自己。

这不是推断 —— `write_note` 的 idempotency 注释白纸黑字承认过：
**「覆盖写严格说是幂等的，标成非幂等是为了让分支二有工具可测」**。

## Hypothesis

做决策时的认知状态：

- 已知三条分支的处置逻辑是对的（阶段 1 的 B2 段验过），有问题的是**分流依据**；
- 已知依赖方向禁止 Runtime 认识 Case 包，所以「怎么拍指纹」必须留在工具域；
- **当时不知道**的两件事，都是实现时才浮出来的：
  1. 指纹必须在 `AttemptStarted` **之前**拍（第一版放在之后，于是窗口 A 永远拍不到 ——
     而窗口 A 恰恰是最需要它的场景）；
  2. 恢复观察若被记成「失败的 required Verification」，会**永久污染 outcome**
     —— 批 1 实测到两份产物都正确落盘、outcome 却是 `COMPLETED_WITH_LIMITS`。

## Alternatives

| 方案 | 优点 | 代价 | 何时会后悔 |
|---|---|---|---|
| **A. Action 级事实（`ACTION_FACT` ＋ `recoveryObservation`）** | 分流旋钮挪到 Runtime 侧，故障注入可逐次控制；同一个工具能被送进两条分支 | 扩了 `TranscriptEntryKind`（§18.5 的 Contract 变更）；`ToolDefinition` 多一个可选字段 | 若将来出现「指纹本身很贵」的工具 —— 现在拍指纹是一次 `readFile`，那时要重估 |
| B. 只给工具再加一个静态布尔 | 改动最小 | 旋钮**仍在被测对象身上**，研究问题照旧测不准。而且「原则上可观察」与「这次观察到了」的区别表达不出来 | 立刻。第一次想用故障注入控制分支分布时 |
| C. 给 `append_log` 加真实的 Verification | 一行不用改 Contract | 第三条分支在当前工具集下**再次不可达** —— 那正是阶段 1 加 `append_log` 要解决的问题 | 立刻。A-5 的成果会被撤销 |

## Decision

**取 A：分支判据是「这次执行有没有留下可用的前置指纹」，一个 Action 级事实。**

落地形态四件：

1. `TranscriptEntryKind` 扩 `ACTION_FACT`（Contract 变更，冻结范围随之收窄，见 §18.5）；
2. `ToolDefinition.recoveryObservation` 声明「**原则上**能不能观察、要不要前置指纹」；
3. 指纹的拍摄与比对**复用 `VerificationPort`**（新增 `observePre` / `observePost`），
   不新增 Port —— 理由是**前置观察与崩溃后观察必须是同一个实现**，
   否则两次测的不是同一个量，比对没有意义；
4. 拍不拍由 Verifier 决定（`MicroCaseVerifier` 的构造选项），旋钮因此在 Runtime 侧。

一个关键的语义分离：`observePost` 产出的 VerificationResult 标 **`required: false`**。
它不是「这个 Action 的验证」，是「崩溃后对外部世界的一次观察」——
标成 required 会让一次「观察到没发生」永久留在事实表里，
即便模型随后补做成功也翻不了案。

## Consequences

### 接受的代价

- **扩了 §18.5 的 Contract。** 好在 §28.6 本就把 TranscriptEntry 的冻结放在阶段 2，
  扩它在窗口内；但冻结范围必须**收窄**到「resume 真实用到的部分」，
  Replay 相关的语义保持【验】—— Replay 已推到阶段 3，现在冻它的人不知道它会怎么用。
- **指纹有成本。** 现在是执行前一次 `readFile`。对大文件或远程资源，这个成本会变得显著。
- **`recoveryObservation` 声明了不等于观察得了。** 这是刻意的，但它是一个需要读注释
  才能理解的区分 —— 有被误用的风险。

### 适用条件

工具的目标状态可以用一个「拍得下来、比得出来」的指纹描述。
Browser Capability（阶段 3）大概率不满足这个前提。

### 重新评估的触发条件

1. 出现前置指纹成本高到影响主路径的工具（比如需要一次网络往返）；
2. 阶段 3 的真实任务里，分支三占比高到无法忽略 —— 那说明「可观测」的定义本身要重做；
3. `recoveryObservation` 与 `verification` 被证明可以合并（即找到一个同时正确回答
   两个问题的字段）。

## Eval Evidence

`verify:crash`（真 `kill -9`，不是往 transcript 注入）：

| 场景 | 崩溃点 | 拍到指纹 | 分支 |
|---|---|---|---|
| 只读工具执行前崩溃 | `AttemptStarted#1`（窗口 A） | 否 | `IDEMPOTENT_RETRY` |
| 覆盖写执行前崩溃 | `AttemptStarted#1`（窗口 A） | 是 | `OBSERVE_FIRST` |
| 覆盖写**执行后**崩溃 | `AttemptCompleted#1`（窗口 B） | 是 | `OBSERVE_FIRST` |
| 追加 ＋ 关掉指纹 | `AttemptStarted#1` | 否 | `RECOVERY_REQUIRED` |
| **同一个追加 ＋ 开着指纹** | `AttemptStarted#1` | 是 | **`OBSERVE_FIRST`** |

最后两行是本 ADR 的判别力证据：**工具声明一个字没改**，改的是 Runtime 侧的
Verifier 能不能拍指纹。

另一条实测证据（`verify:persistence` A 段）：决 6 落地前，两份产物都正确落盘而
outcome 是 `COMPLETED_WITH_LIMITS`；落地后同一场景变成 `COMPLETED / SUCCESS`。

## Interview Narrative

崩溃恢复时要回答一个问题：那个正在跑的工具，到底跑没跑？消息日志上看不出来 ——
「工具还没开始」和「工具跑完了但结果没落盘」留下的痕迹一模一样。

唯一的出路是去看外部世界。但「看得出来吗」这件事，我们原来是问工具的：
你声明了验证方式吗？没有就说明看不出来。这个问法是错的 —— 它问的是
「执行完能不能验」，而我们要知道的是「崩溃后能不能观察」。追加一行日志就是反例：
执行完验不了（不知道该有几行），但只要执行前拍一张文件尾部的指纹，崩溃后一比就知道。

所以我们把判据从工具的静态声明改成了一个逐次的事实：这次执行前，到底拍到指纹没有。
好处不只是判得更准 —— 阶段 2 要统计「有多少次恢复落进最坏那条分支」，
而原来的分流依据就长在被测对象身上，等于拿它去测它自己。现在旋钮在测量装置这边，
同一个工具可以被送进两条不同的分支，这个统计才有意义。
