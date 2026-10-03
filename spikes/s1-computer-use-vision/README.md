# Spike 1：computer use 视觉通道现实核对（阶段 0 探针）

> 性质：**一次性、明确可丢弃、不进主干依赖**；阶段 1 不得 import 本目录任何代码
> 时间：2026-10-03
> 依据：[ComputerUse技术方案调研.md](../../sxw_aicoding/WorkAgent调研/ComputerUse技术方案调研.md) 第 7 节「阶段 0：探针」
> 目标模型以根 `.env` 为准：`deepseek-flash`（DeepSeek Anthropic 形状）、`qwen3.8-flash`（百炼北京区 Anthropic 形状）

## 这是什么

调研报告里有一串【验】：截图能放在消息的哪里、模型给的坐标是哪种约定、每张图算多少 token、
服务端会不会再缩放、缩小后小字还认不认得出。这些都是**端点行为**，按 D-07 应当以数据形态
进入端点能力声明 —— 而数据必须来自实测，不能来自文档（本次又一次证明文档与行为不符）。

## 怎么跑

不新增任何依赖：复用根目录的 `@anthropic-ai/sdk`、`dotenv`、`tsx`；合成截图用系统自带的
AppKit 渲染（`render/render.swift`，首次运行时自动用本机 Swift 工具链编译到 `.bin/`）。

```bash
npx tsx spikes/s1-computer-use-vision/src/preview.ts                 # 不花钱：渲染样图到 raw/preview/
npx tsx spikes/s1-computer-use-vision/src/probes/p1-image-channel.ts # 图像通道
npx tsx spikes/s1-computer-use-vision/src/probes/p3-image-tokens.ts  # 图像计费 ＋ count_tokens
npx tsx spikes/s1-computer-use-vision/src/probes/p2-grounding.ts --thinking disabled   # 定位（JSON 形态）
npx tsx spikes/s1-computer-use-vision/src/probes/p2b-toolcall.ts     # 定位（工具调用形态，Atlas 真实路径）
npx tsx spikes/s1-computer-use-vision/src/probes/p5-legibility.ts    # 小字可读性
npx tsx spikes/s1-computer-use-vision/src/rescore-p2.ts              # 不花钱：离线重打分 P-2
```

所有探针都接受 `--endpoint deepseek|bailian`。证据写在 `raw/*.jsonl`：首行 meta（SDK 版本 / 模型 / 日期 / 参数），
图片 base64 换成 sha256，**合成图** PNG 另存 `raw/images/`（`imageBlock`）；
**真实屏幕截图只编码、不归档**（`ephemeralImageBlock`，P-6 用它 —— 2026-10-03 评审 CU-R11 之前 P-6 走的是前者，
把用户桌面存进了 `raw/images/`，已移出并改掉）；Key 不落盘，且发出前断言 Key 只发往它自己那家的主机。
SDK 显式传 `authToken: null`（见文末「顺带发现」）。

## 判别力设计（每条都回答「错的时候会不会被看出来」）

| 探针 | 怎么保证区分得开 |
|---|---|
| P-1 | 验证码只存在于图里；对照组（工具结果不带图）给出「看不到」的基线；**计费 token 差值**是第二个独立信号（静默丢图 → 差值≈0） |
| P-2 | 拟合 `预测 = a·真值 + b`：像素 a≈1、归一化 a≈1000/W（两轴之比 1.6）、缩图帧 a≈r（两轴相同）。**刻意不用 1000×1000**，那里像素与归一化给出同一个数 |
| P-2b | 坐标经工具调用参数产出（Atlas 真实路径）；按工具描述里**声明**的坐标系判 —— 模型不照做就算不中 |
| P-5 | 编码是随机串、去掉易混字形；区分「读对 / 答看不清 / **自信读错**」 |
| 全部 | 标签是随机假词，模型不能靠「File 在最左边」这类先验蒙中；不截用户真实屏幕（隐私外发 ＋ 会触发录屏授权弹窗） |

## 结果（2026-10-03）

### P-1 截图放在哪：两边都收得到的只有「放在 tool_result 里」

| 放法 | deepseek-flash | qwen3.8-flash |
|---|---|---|
| V0 普通 user 消息里放图 | ✅ 4/4 | ✅ 4/4 |
| V1 `tool_result` 内 [文字, 图] | ✅ 4/4 | ✅ 4/4（文档只定义了字符串，实际支持） |
| V2 `tool_result` 之后再跟 image 块 | ✅ 4/4 | ❌ **0/4，HTTP 200 静默丢图**：计费只比对照组多 7 token（= 提示文字的差值），图贡献 0 |
| V3 对照：不带图 | 「看不到」4/4 | 「看不到」4/4 |
| V4 `tool_result` 内只有图 | ✅ 4/4 | 3/4（1 次图已送达但把 9 读成 Q） |
| V5 `tool_result` 之后跟**文字**块 | ✅ 2/2 | ✅ 2/2（百炼只丢图，不丢文字 —— Atlas 现有的插话与 SYSTEM_NOTICE 不受影响） |

1280×800 截图的成本：DeepSeek ≈ 642 token，百炼 ≈ 1002 token。

### P-3 图像计费与服务端缩放

| 尺寸 | deepseek-flash | qwen3.8-flash |
|---|---:|---:|
| 256×160 | 200（下限） | 79 |
| 1024×640 | 418 | 642 |
| 1280×800 | 642 | 1002 |
| 1792×1120 | **962（封顶）** | 1962 |
| 2560×1600 | 962 | **2562（封顶）** |
| 3584×2240 | 962 | 2562 |

- 两家都会在服务端把大图缩小：DeepSeek 约 1792×1120 起封顶，百炼约 2560×1600 起封顶（≈ 每 1024 像素 1 token）。
- **`count_tokens` 两家相反**：DeepSeek 把图算得分毫不差（689 = 实际计费 689）；**百炼完全不算图**（带一张 1280×800 的图只多 3 token，实际多 1000）。

### P-2 定位（JSON 形态）：归一化坐标是两边共同的最优解

推荐配置（`0–1000 归一化`、尺寸 ≥1280×800、关闭思考）下按控件类别的命中：

| | 菜单 | 工具栏 | 小图标 18pt | 侧边栏行 | 复选框 14pt | 输入框 | 主按钮 | 合计 |
|---|---|---|---|---|---|---|---|---|
| qwen3.8-flash | 6/6 | 12/12 | 12/12 | 6/6 | 12/12 | 6/6 | 5/6 | **59/60** |
| deepseek-flash | 4/6 | 12/12 | 10/12 | 5/6 | 9/12 | 6/6 | 6/6 | **52/60**（≥1792 时 39/40） |

- **qwen 的默认坐标习惯是 0–1000 归一化**：不说明单位时 15/16 次用归一化；关闭思考后**明确要求像素也照样给归一化**（命中 3/80）。
- **DeepSeek 发大图且不说明单位时，在服务端缩小后的帧上给像素坐标**（3584×2240 时斜率 0.537，即它看到的是约 1925 宽的图，而客户端不知道这个尺寸）→ 0/10。
- **DeepSeek 默认思考会把输出额度烧光**：8192 上限时 14/24 次一个字没答（全在思考）；放到 32768 后能答完，但准确率没有提高（归一化 15/20），每次 22–48 秒。
- 640×400 对两个模型都太小。
- qwen 关闭思考时自由输出的 JSON 有 3/24 次不合法（`"x": 85, y": 149` 之类）。

### P-2b 定位（工具调用形态，Atlas 真实路径）：截图放 tool_result，1792×1120

| | 归一化·默认思考 | 归一化·关闭思考 | 像素·默认思考 | 像素·关闭思考 |
|---|---|---|---|---|
| qwen3.8-flash | 9/10（2.2pt） | **10/10**（2.4pt） | **1/10** | **0/10** |
| deepseek-flash | 8/10（5.8pt） | 8/10（15.1pt） | 9/10（5.4pt） | 6/10（19pt） |

- **工具调用参数 40/40 合法**：自由 JSON 的格式问题在函数调用形态下消失。
- **工具描述里写明「像素坐标，截图 1792×1120」，qwen 照样输出归一化坐标**（右下角按钮回答 [902, 897]），开不开思考都一样。按像素换算的话每一下都点偏、且没有任何报错。
- 单次点击很便宜：中位输出 50–120 token，1–3 秒。

### P-6 真实屏幕 × Atlas 真实工具面（2026-10-03，第一次真桌面运行之后补的）

`npx tsx src/probes/p6-real-screen.ts --endpoint bailian <截图> <每格次数>`（不加 `--endpoint` 两个端点都跑）。
截图是那次运行的真实截图（只含计算器与文本编辑的窗口，**不进仓库**：走 `ephemeralImageBlock`，只编码不归档）；工具与 system prompt 由 compose 导出，
即 Atlas 的 `screenshot` ＋ `computer`（**x / y 两个标量**，不是 P-2b 的 coordinate 数组）。7 个按钮 × 2 次：

| | 默认思考（Atlas 实际发出的） | 关闭思考 |
|---|---|---|
| qwen3.8-flash | **13/14** | **1/14**（多数给出畸形 x / y：缺 y、或 y 是数组） |
| deepseek-flash | 11/14 | 8/14 |

**修正了 P-2b 的一条结论**：「qwen 关闭思考最准」只对 coordinate 数组形态成立；
换成 Atlas 的 x / y 标量形态，关闭思考几乎不可用。Atlas 不发思考参数（＝默认）是对的。
那次运行点偏的真正原因是截图几何（见 ADR-0014「附带修复」），不是模型。

### P-5 小字可读性（关闭思考）

| 字号 | 3584×2240 | 1792×1120 | 1280×800 | 局部放大 |
|---|---|---|---|---|
| 9 pt | 两边 4/4 | 两边 4/4 | 各 3/4（**各错 1**） | 2/2 |
| 10–15 pt | 全对 | 全对 | qwen 11pt 错 1，其余全对 | 全对 |

- 发送尺寸不低于逻辑点尺寸（1792×1120）时，9 pt 以上的界面文字全部读对；局部放大不是必需品。
- 1280×800 上的错误全是**自信地读错**（9→8、D→O、J→U），没有一次回答 null —— 不能指望模型自报「看不清」。

### P-0 思考控制参数

两个端点都接受 `thinking: {type: "disabled"}`（之后不再产生思考块）与 `output_config.effort`。

## 对 Atlas 端点能力声明的含义（建议值，供阶段 1a 落地）

| 字段（示意） | deepseek-flash | qwen3.8-flash | 证据 |
|---|---|---|---|
| `vision.acceptsImageInput` | true | true | P-1 V0 |
| `vision.imageInToolResult` | SUPPORTED | SUPPORTED | P-1 V1/V4 |
| `vision.trailingImageAfterToolResult` | SUPPORTED | **SILENTLY_DROPPED** | P-1 V2 |
| `vision.imageTokenCap`（服务端缩放封顶） | ≈962（约 1792×1120 起） | ≈2562（约 2560×1600 起） | P-3 |
| `vision.countTokensIncludesImages` | true | **false** | P-3 |
| `vision.groundingCoordinateSpace` | NORMALIZED_1000（也能照做像素） | **NORMALIZED_1000（不服从像素声明）** | P-2 / P-2b |
| `vision.preferredScreenshotSize` | 1792×1120 | 1280×800 或 1792×1120 | P-2 / P-5 |
| GUI 任务的思考设置 | 默认思考在 JSON 形态下会烧光额度；工具调用形态下正常 | 关闭思考最准 | P-2 / P-2b |

**统一的工程选择**：截图放进 `tool_result`；坐标一律用 0–1000 归一化（不受服务端缩放影响，
正好绕开「客户端不知道模型看到的图有多大」）；发送 1792×1120（= 本机逻辑点尺寸）。

## 顺带发现（都没修）

1. **SDK 会自动带上 `ANTHROPIC_AUTH_TOKEN`**：`@anthropic-ai/sdk` 构造时默认读这个环境变量，
   并作为 `Authorization: Bearer` 与 `x-api-key` 一起发出（SDK `client.js:49/117`）。
   Atlas 的 `adapters/shape-anthropic-messages/src/client.ts` 没有传 `authToken`，
   shell 里设了这个变量时它会被发往 DeepSeek / 百炼。`credential-guard` 只校验 baseURL，挡不住这一条。
2. 根 `.env` 是 `deepseek_model=deepseek-flash`，而 `compose.ts` 只登记了 `deepseek-v4-flash`，
   `--endpoint deepseek` 现在会在启动时被 M-5 拒绝；且服务端已把旧名路由到 V4.1，
   那份 PROBED 的 DeepSeek 声明背后的模型已经换了。

## 局限（如实记）

- 合成界面，不是真实应用；真实应用的视觉多样性（暗色模式、密集表格、图标无文字）更难。
- 每个格子样本小（10–20 个目标）；结论看的是「量级与方向」，不是精确百分比。
- 只测了单步点击，没有测多步任务、错误恢复与长上下文下的退化。
- `output_config.effort` 只验证了「被接受」，没有扫它对定位的影响。
- DeepSeek 的单价未核实，未折算金额（百炼 141 次调用约 0.41 元）。
- `deepseek-flash` 是别名，背后模型会换；这些数字有保质期 —— 正因如此要进声明并能重跑。
