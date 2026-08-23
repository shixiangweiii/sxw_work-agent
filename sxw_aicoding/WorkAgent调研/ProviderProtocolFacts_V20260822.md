# Provider Protocol Facts

> 文档版本：V20260822
> 性质：**实测事实快照**，不是设计文档。事实会随 Provider 版本变化而过期。
> 来源：Spike 0（`spikes/s0-provider-protocol/`），V03 §28.1
> 证据：`spikes/s0-provider-protocol/raw/*.jsonl`，本文每条结论均标注对应文件
> 用途：解锁 V03 中被挂起的【验】标记与决策点，见 `架构设计/V03_Spike0回填清单.md`

---

## 0. 版本矩阵与部署约束

**没有版本号的证据等于没有证据。** 本文全部结论仅对下表成立。

| 项 | 值 |
|---|---|
| Provider | 阿里云百炼 |
| 模型 | `qwen3.7-plus`（两个形状完全相同） |
| 形状 A | `/compatible-mode/v1`（OpenAI 兼容）· Chat Completions + Responses · SDK `openai` 6.49.0 |
| 形状 B | `/apps/anthropic`（Anthropic 兼容）· Messages · SDK `@anthropic-ai/sdk` 0.65.0 |
| 运行时 | Node v22.22.3 |
| 实测日期 | 2026-08-22 |
| 成本 | 两轮合计约 74 万输入 tokens（其中 60 万来自 §7 的单次超长上下文探针） |

**证据文件命名**：`raw/p<N>-bailian-<shape>-shape-<时间戳>.jsonl`。
第一轮（仅 OpenAI 形状、修复探针缺陷前）的证据归档在 `raw/openai-shape-run/`，其结论文案含已知缺陷，不作引用。

### 0.1 一个必须写在最前面的约束

**本项目的实际运行环境就是第三方 OpenAI 兼容端点，不是 OpenAI 或 Anthropic 官方 API**（官方 API 成本不可承受）。

这不是「测试环境的将就」，而是**部署现实**。它改变了本文多条结论的性质：

- 下文所有「该实现不校验 X」的发现，**不是兼容层的怪癖，而是生产环境的常态**；
- V03 §30 的 D-07（单 Provider 还是双 Provider）问题需要重新表述：真正的抽象风险不是「OpenAI vs Anthropic」，而是**兼容层之间的实现差异**（换模型、换供应商时会遇到）；
- 因此 `ModelProtocolPort` 要吸收的是兼容层差异，而不是官方 API 家族差异。

### 0.2 第二轮：同模型、双 API 形状

初版只测了 OpenAI 兼容形状，因此当时无法给出「协议共性 vs 特性」对照表。

第二轮补测了同一平台的 **Anthropic 兼容形状**（`/apps/anthropic`），构成一个变量隔离得非常干净的实验：

> **同一平台、同一模型（qwen3.7-plus）、同一个 API Key，只有 API 形状不同。**
> 因此任何行为差异都只能归因于**协议形状本身**，而不是模型能力或供应商实现。

这比「换一个模型」更能回答 D-07 重述后的问题（`ModelProtocolPort` 要吸收哪一类差异）。完整对照见 **§9**。

| 项 | 值 |
|---|---|
| 形状 A | `/compatible-mode/v1`（OpenAI 兼容），SDK `openai` 6.49.0 |
| 形状 B | `/apps/anthropic`（Anthropic 兼容），SDK `@anthropic-ai/sdk` 0.65.0 |
| 标签 | `bailian-openai-shape` / `bailian-anthropic-shape` |

Spike 0 的探针内置回归防护：`npm run summary` 会检测结论中是否出现本次未运行的 provider 名，出现即报警。第一轮它抓出了 8 处硬编码跨家断言（已修正）。

**仍未覆盖**：换模型（同形状）的差异。该账号可用 241 个模型（含 MiniMax / GLM / DeepSeek / Kimi 等系列），补测成本极低。

---

## 1. 一次响应最多返回几个 tool call；能否强制单条

> 影响：V03 §8.6 ActionBatch、§30 D-01
> 证据：`raw/p1-bailian-openai-shape-*.jsonl`、`raw/p1-bailian-anthropic-shape-*.jsonl`

### 实验

单句 prompt 要求同时查两个城市的天气和时间（2 城市 × 2 工具）。随后 1 组基线 + 4 组负向。两个形状各跑一遍。

### 观测

| 实验 | OpenAI 形状 | Anthropic 形状 |
|---|---|---|
| 正向 | **4 个 tool_call**，`finish_reason=tool_calls` | **4 个 tool_use**，`stop_reason=tool_use` |
| 强制单条开关 | `parallel_tool_calls:false` **生效**，返回 1 个 | `disable_parallel_tool_use` 被接受但**无效**，仍 4 个 |
| 负向 A：缺 3 个 result | **被接受**（200） | **被接受**（200） |
| 负向 B：逆序回传 | **被接受** | **被接受** |
| 负向 C：call id 篡改 | **被接受** | **被接受** |
| 负向 D：合成「被拒绝」result | 被接受，只能写进 content | 被接受，**可用 `is_error` 带外字段** |

两个形状下模型都正确理解了拒绝语义，在回复中如实说明「北京天气查询被策略拒绝」。

入参形态差异：OpenAI 形状的 `function.arguments` 是**字符串**；Anthropic 形状的 `tool_use.input` 是**对象**。

### 结论

**§8.6 不变量 1（批模型）成立**：多 tool call 是默认行为，必须建模。

**§8.6 不变量 2（每个 call 恰好一个 result）的理据被证伪，但不变量本身更重要了。**

V03 原本隐含的理据是「否则 Provider 会 400」。该实现根本不校验。所以理据必须改写为：

> 否则模型看到的是一个失真的世界——它会以为某个工具没被调用过，或者把 A 的结果当成 B 的。

执行责任 **100% 在 Runtime**，没有任何外部兜底。同理，§12.5 把 `toolCallId` 当锚点，在该实现上只是 Runtime 的自我约定。

**D-01 的协议支持是形状相关的，不能一概而论**：OpenAI 形状的 `parallel_tool_calls:false` 真的生效；Anthropic 形状的 `disable_parallel_tool_use` 被接受但无效，仍返回 4 个。

因此若 v0.1 选择「强制串行」，**不能依赖协议开关**——必须由 Runtime 自己串行化执行，开关只当作可有可无的额外保障。计划中倾向的方案 C（接口按并发设计、v0.1 只实现串行）仍然成立，但理由从「协议支持」退回到「Runtime 自持」。

**§12.2 的 `REJECTED_*` 表达方式也是形状相关的**：Anthropic 形状有 `is_error` 带外字段，OpenAI 形状只能把拒绝语义写进 `content`。Runtime 应约定一个结构化 payload 作为下限，在有带外字段的形状上再额外标记。

### 未解答

`disable_parallel_tool_use` 在该实现上是否有其他生效条件（本次仅测到「被接受但不改变行为」）。

---

## 2. 哪些块必须原样回传；是否有签名校验

> 影响：V03 §11.5 `REQUIRED_VERBATIM`、原则十一、§11.6 Compact 硬约束、`:1505`【验】
> 证据：`raw/p2-bailian-openai-shape-*.jsonl`、`raw/p2-bailian-anthropic-shape-*.jsonl`

### 观测

推理块的**载体形态**因形状而异，但**约束强度完全一致**：

| | OpenAI 形状（Responses API） | Anthropic 形状（Messages） |
|---|---|---|
| 载体 | `reasoning` output item | `thinking` content block |
| 字段 | `id / summary / type / content / encrypted_content / status` | `type / signature / thinking` |
| 签名字段 | `encrypted_content` 全为 **`null`** | `signature` 存在但为 **空串 `""`** |
| 基线（原样回传） | 成功 | 成功 |
| 负向 A：删除推理块 | **被接受** | **被接受** |
| 负向 B：改写推理内容（保留签名字段） | **被接受** | **被接受** |
| 负向 C：删除签名字段 | — | **被接受** |
| 负向 D：多轮中删除较早轮次的推理块 | — | **被接受** |

另注：OpenAI 形状的 Chat Completions 下，推理以 `message.reasoning_content` 字段返回——这是 OpenAI 规范里没有的字段，属该实现自加。

### 结论

**在当前部署下，§11.5 的「带签名、必须逐字回传」这一类约束在两个形状上都不存在。** 推理块可删、可改、可去签名；多轮场景下较早轮次的推理块也可以整体丢弃。

关键的负向 D 结论：**`irreducibleTokens` 不会随轮数累积。** Compact 只需保护最近轮次的协议组，不必为历史推理块永久预留预算——这让 §11.6 的压缩策略简单很多。

**但 `protocolRole` / `REQUIRED_VERBATIM` 字段应当保留**：

1. tool_call/tool_result 的配对约束依然需要它（两个形状都不强制，Runtime 必须自持）；
2. 两个形状都**保留了签名字段位**（`encrypted_content` / `signature`），只是当前为空。这说明协议层预留了该能力，换端点或换模型时可能启用。

### 未解答

**加密/带签名推理块的校验行为** —— 两个形状都不产出非空签名，无法在此回答。

对应 V03 `:1505` 的【验】标记**部分解除**：当前部署下可按「无 verbatim 约束」实现，且这一结论在两个形状上都成立（比单形状证据强）；但因签名字段位存在而内容为空，标记不能整体升【定】。

---

## 3. 流式中断后已产出部分的结构；已闭合的 tool call 是否可用

> 影响：V03 §8.5 中断规则、`:906`【验】
> 证据：`raw/p3-bailian-openai-shape-*.jsonl`、`raw/p3-bailian-anthropic-shape-*.jsonl`

### 实验

流式请求，在收到第 6 个**工具参数增量**后 abort。两个形状用同一计数口径（只数工具参数增量，不数推理块增量），否则中断点落在不同阶段，结果不可比。

### 观测

**OpenAI 形状**：无闭合事件。

```
累积参数：{ "0": "{\"city\": \"北京\"}", "1": "" }
中断时 finish_reason：null
```

| index | 参数可解析 | 后继 index 已开始 |
|---|---|---|
| 0 | 是 | **是** |
| 1 | 否（空串） | 否 |

**Anthropic 形状**：有显式闭合事件。

```
已开始内容块：thinking(0) / text(1) / tool_use(2) / tool_use(3)
已闭合内容块 index：[0, 1, 2]
是否收到 message_stop：否（被中断）
```

### 结论

**闭合判据是形状相关的，强度差别很大：**

| 形状 | 判据 | 强度 |
|---|---|---|
| Anthropic | **`content_block_stop` 显式事件** | 协议保证 |
| OpenAI | ① 参数 JSON 可解析 ② `index N+1` 出现 ⟹ `index N` 已闭合 | Runtime 推断 |

`index N+1` 这条比「JSON 可解析」更强：流式增量按 index 顺序推进，后继 index 一旦开始，前面的必然已收完。

**两个形状都支持把 §8.5 从「整体丢弃」放宽为「保留已闭合的块」**，因此 `:906` 的【验】可升【定】。但落地时必须区分依据：

> 在有 `content_block_stop` 的形状上依据协议事件；
> 在没有的形状上依据上述两条推断判据。
> `ModelProtocolPort` 需要暴露「本形状如何判定块已闭合」这一能力，而不是让 Context 层自己猜。

**另一个负向结果**：把参数为空的 `tool_use` 当完整送回，**被接受**。Provider 不校验入参完整性，完整性判定同样 100% 是 Runtime 的责任。

### 未解答

SDK 的 partial message 累积 API 在 abort 后的行为（需查对应 SDK 版本文档后补测）。

---

## 4. Token 计数口径：预估 vs 实际、误差范围

> 影响：V03 §11.6 阈值精度、§16.1 预算、`ModelProtocolPort`、`:2383`【验】
> 证据：`raw/p4-bailian-openai-shape-*.jsonl`、`raw/p4-bailian-anthropic-shape-*.jsonl`

### 观测

**预估端点的有无，是本次最重大的形状差异：**

| 形状 | 预估端点 | 实测误差 |
|---|---|---|
| OpenAI | **无**（`/tokenize` 404） | 无法量化 |
| Anthropic | **有 `count_tokens`** | **5/5 项全部 0.00%** |

Anthropic 形状的逐项对照（预估 vs 实际）：

| payload | 预估 | 实际 | 偏差 |
|---|---|---|---|
| 纯文本，无 tool 定义 | 15 | 15 | 0.00% |
| 同样文本 + 2 个工具定义 | 374 | 374 | 0.00% |
| + system prompt | 394 | 394 | 0.00% |
| + 一轮完整 tool_use/tool_result 往返 | 459 | 459 | 0.00% |
| 长文本（5200 字符） | 2810 | 2810 | 0.00% |

**计费口径本身在两个形状上完全一致**（tool 开销 359、200KB result 计 34576，分毫不差）——差的只是「有没有一个接口能提前告诉你」。

usage 字段形态则不同：

```
OpenAI 形状 ： prompt_tokens / completion_tokens / total_tokens
               prompt_tokens_details{cached_tokens, text_tokens}
               completion_tokens_details{reasoning_tokens, text_tokens}
Anthropic 形状：input_tokens / output_tokens
               cache_creation_input_tokens / cache_read_input_tokens
```

### 结论

**tool 定义的固定开销是 359 tokens（2 个只有一个字符串参数的工具）**，两个形状一致。折合每工具约 180 token，20 个工具就是约 3600 token 的起步价。

**§16.1 需要一个当前没有的预算轴**：tool schema 开销是每次请求的固定成本，与任务内容无关。`RunBudgets` 与 §11.6 的阈值都必须扣除它，否则「还剩多少上下文可用」的计算是错的。

**每请求固定底数约 11 token**（chat 模板开销）。本地估算必须叠加这个常量。

**`:2383`【验】的处置是形状相关的：**

- **Anthropic 形状：可解除。** `countTokens()` 精确到 0%，§11.6 的 soft/hard 阈值可以精确判定，`estimated` 恒为 false；
- **OpenAI 形状：维持【验】。** 无端点可对标，只能本地 tokenizer 估算，误差未量化。

这也是 §9.3「优先走 Anthropic 形状」建议的最强单条理由。

### 未解答

OpenAI 形状下本地 tokenizer 的选型与误差量级 —— 需在阶段 1 补测（可用 Anthropic 形状的 `count_tokens` 作为对标基准，因为两形状计费口径一致）。

---

## 5. 错误响应的结构与可区分性

> 影响：V03 §13.1 错误分类、§13.2 ErrorDisposition
> 证据：`raw/p6-bailian-openai-shape-*.jsonl`、`raw/p6-bailian-anthropic-shape-*.jsonl`

### 观测

**OpenAI 形状**：

| 触发 | status | errorClass | `type` | `code` |
|---|---|---|---|---|
| 无效模型名 | 404 | `NotFoundError` | `invalid_request_error` | `model_not_found` |
| 无效 API Key | 401 | `AuthenticationError` | `invalid_request_error` | `invalid_api_key` |
| 请求体缺 messages | 400 | `BadRequestError` | `invalid_request_error` | `invalid_parameter_error` |
| **tool 定义 schema 非法** | **200** | — | — | — |

**Anthropic 形状**：

| 触发 | status | errorClass | `code` |
|---|---|---|---|
| 无效模型名 | **400** | `BadRequestError` | `InvalidParameter` |
| 无效 API Key | 401 | `AuthenticationError` | `InvalidApiKey` |
| 请求体缺 max_tokens | 400 | `BadRequestError` | `InvalidParameter` |
| **tool 定义 schema 非法** | **400** | `BadRequestError` | `InvalidParameter`，message 给出精确诊断 |
| max_tokens 超上限 | — | `AnthropicError` | **SDK 层拦截，未发出请求** |

### 结论

**判别式在两个形状上完全不同，且都不能只看一个字段：**

- OpenAI 形状：`type` 恒为 `invalid_request_error`，**无区分度**；`code` 有区分度（`model_not_found` / `invalid_api_key` / `invalid_parameter_error`）；
- Anthropic 形状：`code` **粒度太粗**——`InvalidParameter` 同时覆盖「模型不存在」「请求体格式错」「tool schema 非法」三种性质完全不同的错误，只能靠 status + message 文本进一步区分。

**§13.1 的映射必须基于 HTTP status + code + SDK 异常类名的组合，且映射表按形状分别维护。**

**tool 定义 schema 的校验是形状差异，不是平台属性：** 同一个非法 schema，OpenAI 形状返回 200，Anthropic 形状返回 400 并给出精确诊断（`'properties' should be a dict but got str`）。

**但 tool 入参的校验是共性：** 两个形状都放行了不合 schema 的入参——诱导模型产出 `{cityName: "北京"}`（schema 要求 `city`），Provider 均未报错。

> 因此 §13.1 中 `source: TOOL_INPUT` 的错误**永远不会**来自 Provider。
> 入参校验 100% 是 Runtime 职责；工具**定义**校验在部分形状上有兜底，但不能依赖。

**一个 V03 没有的错误来源：SDK 层。** `max_tokens: 99999999` 被 Anthropic SDK 自己拦截（提示需要流式），根本没发出请求。§13.1 的 `source` 枚举需要能表达「错误来自 SDK 而非 Provider 或 Runtime」，否则这类错误会被误归类为 `MODEL_PROVIDER`。

### 未解答

429 rate limit 的错误体（难以主动触发，V03 §28.1 已允许记为未解答）。

---

## 6. 缓存断点的放置约束

> 影响：V03 §11.8、§11.6 Compact 策略、`:1594`【验】
> 证据：`raw/p5-bailian-openai-shape-*.jsonl`、`raw/p5-bailian-anthropic-shape-*.jsonl`

### 实验

约 8000 字符的固定前缀 + 可变尾部，连续三次请求：写入 → 前缀不变 → **改写前缀**。

### 观测

| 请求 | prompt_tokens | cached_tokens |
|---|---|---|
| 1 写入 | 4892 | 0 |
| 2 前缀不变，只改尾部 | 4892 | **4224（86%）** |
| 3 **改写前缀**（`背景资料` → `背景材料`） | 4892 | **0** |

无显式断点参数，走自动前缀匹配。

### 结论（**已修订，见下方更正说明**）

**§11.8 的「Compact 破坏稳定前缀」只得到一次干净观测的支持，未能稳定复现。`:1594`【验】维持【验】，不升【定】。**

多次采样后的真实情况：

| 形状 | 基线（前缀不变，4 次采样） | 改写前缀后**第一次** |
|---|---|---|
| OpenAI 形状 · 运行 A | `4352 / 4224 / 4224 / 4352`（4/4 命中） | **0** → 支持 §11.8 |
| OpenAI 形状 · 运行 B | `0 / 4224 / 4224 / 4352`（基线就不稳定） | 无法判定，探针拒绝下结论 |
| Anthropic 形状 | `378 / 378 / 378 / 378`（稳定） | **378，仍命中** → 不支持 §11.8 |

三点事实：

1. **该端点的缓存在连续相同请求之间就已非确定。** 运行 B 的基线第一次采样直接是 0。基线都不稳定时，任何关于「改写前缀是否失效」的结论都不成立；
2. **Anthropic 形状的显式 `cache_control` 断点基本没起作用。** 命中恒为 378 tokens，远小于约 4900 token 的前缀——被缓存的只是 tools + system 这段固定小前缀，断点标记的正文根本没进缓存。改写前缀也不影响它；
3. **只有 OpenAI 形状的运行 A 给出了教科书式的结果**（基线 4/4 稳定、改写后首次为 0）。它支持 §11.8，但一次观测不足以升【定】。

**对架构的实际输入**（比原结论更重要）：

> **缓存命中在该端点上不可预期，因此不能把它当作延迟或成本的可依赖假设。**

这反而降低了 §11.8 张力的严重性——如果缓存本来就不稳定，Compact 是否破坏它就不是首要顾虑。§11.6 的「追加式外置优于重写式压缩」仍然是合理倾向，但**其理据要从「保住缓存」改为「减少重复计费的确定性收益」**。

### 更正说明

本节初版写的是「§11.8 被证实，且是全量失效」「`:1594` 可升【定】」。那是**单次采样的结论**，改用多次采样后无法复现。

成因是探针设计的两个缺陷，都已修复：

1. 前缀内容每次运行相同，第二次跑时「改写后的前缀」已被上一次跑热 —— 已加 per-run nonce；
2. 「改写前缀」条件下的第 2~4 次采样命中的是新前缀**自己**的缓存条目，与「旧缓存是否失效」无关 —— 现在只取改写后第一次请求作为判据。

探针现在会在基线不稳定时主动拒绝下结论并登记未解答项。这条修正是本次 Spike 方法论上最有价值的一课：**在抖动信号上，单次采样会给出自信的错误答案。**

### 未解答

- **改写前缀是否稳定地导致缓存失效**（基线不稳定，当前设计不足以定论）；
- 该实现的显式 `cache_control` 断点是否真正生效（命中恒为固定小前缀）；
- 缓存 TTL（需间隔重跑才能测）。

---

## 7. 上下文超限的报错形态；能否提前判定

> 影响：V03 §11.6 `COMPACTION_INSUFFICIENT`、§10.1 `CONTEXT_EXHAUSTED`、§30 D-05
> 证据：`raw/openai-shape-run/p7-bailian-qwen-*.jsonl`（第一轮；本轮未重跑，见下）

### 观测

送出 120 万字符（估算约 65 万 token）：

```
实际计费 prompt_tokens: 600,010
finish_reason: length
是否静默截断: 否（实际计费与估算同量级，专门做了比对）
```

请求**被接受**，未报错。

### 结论

**该模型上下文窗口 ≥ 600,010 token，且不做静默截断。**

「未静默截断」这一点是专门验证的，因为静默截断比报错危险得多：模型看到残缺输入，而 Runtime 完全无从察觉。本实现不存在这个风险。

**但 §11.6 的 `COMPACTION_INSUFFICIENT` 缺少可靠触发点：**

- 无预检端点（第 4 节）；
- 窗口极大且未实测到上界；
- 因此「即将超限」只能靠 Runtime 本地估算判定，而估算误差又无法量化（第 4 节的未解答项）。

**D-05 的候选 A（先做更激进的 Compact）缺少可靠触发信号。** 在当前部署下，更现实的策略是按「本地估算 + 保守阈值」提前 Compact，而不是等待 Provider 报错。

### 未解答

- 上下文超限的**错误形态**（未能触发，窗口太大）；
- 接近但未超限时输出是否被截断。

---

## 8. 计划外发现：推理吃光输出预算

> 影响：V03 §16.1 `reservedOutputTokens`
> 证据：`raw/p4-…`、`raw/p7-…`（两个探针独立复现）

这一条不在 §28.1 的七问之列，是探针跑出来后从数据里发现的。

### 观测

```
max_completion_tokens: 64
finish_reason: "length"
content: ""                        ← 正文为空
completion_tokens: 66
completion_tokens_details.reasoning_tokens: 64   ← 预算全被推理吃掉
```

在 P4 和 P7 两个独立探针中复现。

### 结论

**推理型模型下，`max_completion_tokens` 会被推理优先消耗，可能导致正文为空。**

对 §16.1 的直接影响：`reservedOutputTokens` 必须**同时覆盖推理与正文**。若只按正文长度预留，Run 会拿到一个 `finish_reason=length` 且 `content` 为空的响应——而如果 Runtime 只检查「有没有报错」，它会把空回复当成模型的正常回答，产生一次静默的错误决策。

**建议**：Kernel 消费 `ModelInvocationResult` 时，把「`finish_reason=length` 且无内容且无 tool call」识别为一个明确的错误条件（`source: MODEL_PROVIDER, category: CAPACITY`），而不是当成正常完成。

---

## 9. 协议形状对照：同模型、双形状

> 这是本文最重要的一节。它回答 D-07 重述后的问题：`ModelProtocolPort` 要吸收哪一类差异。
> 证据：`raw/p*-bailian-anthropic-shape-*.jsonl` 与 `raw/p*-bailian-openai-shape-*.jsonl`

### 9.1 对照表

**同一平台、同一模型、同一个 Key，只有 API 形状不同。**

| 维度 | OpenAI 形状 | Anthropic 形状 | 性质 |
|---|---|---|---|
| 一次响应的 tool call 数 | 4 | 4 | **共性** |
| **强制单条的开关** | `parallel_tool_calls:false` **生效**（返回 1 个） | `disable_parallel_tool_use` 被接受但**无效**（仍 4 个） | **形状差异** |
| 缺失部分 tool result | 200 接受 | 200 接受 | **共性** |
| 错误的 tool call id | 200 接受 | 200 接受 | **共性** |
| result 顺序打乱 | 接受 | 接受 | **共性** |
| **拒绝语义的带外字段** | 无，只能写进 content | **有 `is_error`** | **形状差异** |
| **token 预估端点** | **无**（`/tokenize` 404） | **有 `count_tokens`，5/5 项误差 0.00%** | **形状差异（最重大）** |
| **tool 定义 schema 校验** | **不校验**（非法 schema 返回 200） | **校验**（400 + 精确诊断信息） | **形状差异** |
| tool **入参** schema 校验 | 不校验 | 不校验（模型产出 `{cityName}` 被放行） | **共性** |
| 无效模型名 | 404 / `code=model_not_found` | 400 / `code=InvalidParameter` | **形状差异** |
| **错误判别式** | `code` 有区分度，`type` 恒为 `invalid_request_error` | `code` 粒度粗（`InvalidParameter` 覆盖 3 类不同错误），须靠 status + message | **形状差异** |
| **流式闭合事件** | **无**，靠「JSON 可解析 + 后继 index 出现」推断 | **有 `content_block_stop`** | **形状差异** |
| 推理块载体 | Responses API 的 `reasoning` item，`encrypted_content: null` | `thinking` 块，`signature: ""`（空串） | 形状差异 |
| 推理块可删 / 可改 | 可 / 可 | 可 / 可（删 signature 也可） | **共性** |
| 较早轮次推理块可删 | — | 可 | — |
| tool 定义固定开销 | 359 tokens | 359 tokens | **共性** |
| 200KB tool result | 接受，34576 tokens | 接受，34576 tokens | **共性** |
| 缓存机制 | 自动前缀匹配，行为不稳定 | 显式 `cache_control`，实测只缓存固定小前缀（378） | **形状差异** |

### 9.2 结论一：差异的主体是 API 形状，不是模型家族

**共性集中在「模型/平台层面」**：多 tool call 是默认行为、协议校验普遍宽松、推理块可删可改、token 计费口径完全一致（359 与 34576 两个数字在两个形状上分毫不差）。

**差异集中在「协议形状层面」**：有没有 token 预估端点、有没有流式闭合事件、有没有带外拒绝字段、tool 定义是否被校验、强制单条开关是否真的生效、错误判别式怎么写、缓存怎么控制。

换句话说：**同一个模型换一个 API 形状，`ModelProtocolPort` 需要处理的东西几乎全变了；而换一个模型（同形状），大概率只影响能力，不影响协议。**

这直接给出 D-07 的答案：

> `ModelProtocolPort` 的抽象边界应当按 **API 形状**切分，而不是按模型家族切分。
> 一个「形状适配器」对应一套 `countTokens / validateFrame / identifyProtocolElements / normalize` 实现；
> 同形状下换模型，只需替换**能力声明**（见 §12），不需要换适配器。

### 9.3 结论二：同一个模型，Anthropic 形状严格更适合做 Harness

在四个对 V03 直接有利的维度上，Anthropic 形状都更强：

| 能力 | 对 V03 的价值 |
|---|---|
| `count_tokens` 精确（0.00% 误差） | §11.6 的 soft/hard 阈值可以精确判定，`:2383`【验】在此形状上可解除；D-05 的候选 A 重新具备触发点 |
| `content_block_stop` 显式闭合事件 | §8.5 可从「整体丢弃」放宽为「保留已闭合的块」，且依据是协议事件而非推断 |
| 校验 tool 定义 schema | Runtime 少一类自持责任，错误能以 `source=MODEL_PROVIDER` 归类 |
| `is_error` 带外字段 | §12.2 的 `REJECTED_*` 可以用结构化字段表达，不必把拒绝语义混进 content |

代价只有一个：`disable_parallel_tool_use` 在此形状上**被接受但无效**，而 OpenAI 形状的 `parallel_tool_calls:false` 是真的生效的。这直接影响 D-01——若选择「v0.1 强制串行」，Anthropic 形状拿不到协议层保障，必须完全靠 Runtime 自己串行化。

**可执行建议**：v0.1 优先走 Anthropic 形状端点。这不是偏好，是上面四条能力的直接后果。

### 9.4 结论三：宽松校验是平台属性，不是形状属性

两个形状**都**接受：缺失 tool result、错误的 call id、乱序 result、不合 schema 的 tool 入参。

这条共性比任何单点差异都重要，因为它把 V03 的一条推论钉死了：

> **协议不变量（§8.6 不变量 2、§11.5 配对、§12.5 锚点）在两种形状上都没有外部兜底，必须由 Runtime 100% 自持。**
> 换形状不能解决这个问题，只能减轻（Anthropic 形状多校验一项 tool 定义）。

---

## 10. 面试叙事

> V03 §28.1 要求的学习产出：解释「为什么 Agent Harness 的 Context 层不能与 Provider 解耦得太干净」。

做 Harness 时最容易犯的错，是把 Provider 当成一个「发消息、收消息」的纯管道，然后在上层设计一套干净的 Context 抽象。我用两天时间对一个真实端点做了协议核对，结论是这个假设在三个层面同时不成立。

**第一，Provider 不校验你以为它会校验的东西。** 我故意只回传了 4 个工具调用里的 1 个结果、故意把 tool_call_id 改错、故意传了非法的 JSON Schema——全部返回 200。这意味着协议不变量没有任何外部兜底，Runtime 必须 100% 自持。更重要的是它改变了不变量的**理据**：不是「否则接口会报错」，而是「否则模型看到的世界是错的」。理据变了，错误分类和执行位置也要跟着变。

**第二，上下文治理的代价是 Provider 定价的。** 我实测两个只有一个字符串参数的工具，固定开销 359 token；改写缓存前缀里的两个字，86% 的缓存命中直接归零。这两个数字都不是上层抽象能推导出来的，但它们直接决定 Compact 策略该「重写中部」还是「追加到尾部」——答案是后者，因为重写会让整段前缀作废。

**第三，有些失败根本不表现为失败。** 推理型模型会优先消耗输出预算，我实测到 `finish_reason=length` 加空正文的响应：接口成功、没有错误码、内容为空。如果 Harness 只检查「有没有异常」，它会把这个当成模型的正常回答继续往下走。

所以 Context 层可以和 Provider **解耦调用方式**，但不能解耦**协议知识**。这正是 V03 把 `ModelPort`（网络）和 `ModelProtocolPort`（协议知识）拆成两个 Port 的原因——前者可以换，后者必须知道自己在跟谁说话。

---

## 11. 方法论复盘

Spike 0 的自检标准是「至少有一个 V03 条款被证伪或需要改写」。实际结果是 **5 条**（§8.6 理据、§12.5 锚点假设、§11.8 张力程度、§16.1 缺两个轴、§11.5 在当前部署下部分为空）。

但更值得记录的是**第一版探针差点让这些发现失真**：

- 有 8 处结论硬编码了「与 Anthropic 一致」「在 OpenAI 侧不成立」，而 Anthropic 根本没跑、测的也不是 OpenAI 官方——照抄进本文就是伪造对照；
- P6 的一条分支只在报错时记录结论，导致「非法 tool schema 被 200 接受」这个发现完全没出现在结论里，是人工翻原始日志才捞到的；
- P7 把「窗口 ≥ 60 万 token」这个确定事实写成了「探针失败，请重跑」。

修正后加了两道机器防护：`npm run summary` 会检测结论中是否提到本次未运行的 provider；「意外成功」在两条路径上对称记录。

**教训**：Spike 的产出不是代码也不是日志，是**结论**。结论文案本身需要被当成代码来评审——它比代码更容易出错，也更容易被下游直接采信。
