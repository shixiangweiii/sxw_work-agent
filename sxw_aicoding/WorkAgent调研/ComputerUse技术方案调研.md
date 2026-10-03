# Atlas Computer Use 技术方案调研（第一阶段：本机 macOS）

> 调研时间：2026-10-03 · 代码基线：`32827b9` · 性质：**只调研，不含实现**
>
> **后续（同日）**：第一阶段已按本文推荐实现，【议】CU-1…CU-11 的拍板与代价见
> [ADR-0013](../ADR/历史归档/0013-本机-computer-use-图像进模型轨道与自建-Swift-助手.md)；本文保留为调研时的认知状态，不再更新。
>
> 目标模型以根 `.env` 为准：`deepseek-flash`（DeepSeek Anthropic 形状）与 `qwen3.8-flash`（百炼北京区 Anthropic 形状）
>
> 目标机器：MacBook Pro 16" 2019 · Intel Core i7（x86_64）· macOS Tahoe 26.6 · 单屏 1792×1120 pt，缩放因子 2
>
> 标记沿用仓内约定：**【验】** = 待探针 / 实测确认；**【议】CU-x** = 待决策，拍板前不得在代码中固化任一候选。
> 本文不产生任何【定】。

---

## 0. 一页结论

1. **卡在最前面的不是 GUI 驱动，是「模型看得见图」这条通道。**
   Atlas 的 `tool_result` 只有字符串；二进制按现行设计一律「不进模型」。
   computer use 的每一步都依赖截图回到模型眼前，所以第一件要改的是 Runtime 的观察通道，
   而这会**推翻一条现行设计**（二进制一律不透明）。
2. **两个目标模型都能看图，但都没有公开的 GUI 定位成绩。**
   deepseek-flash 官方只给了 RefCOCO、DocVQA 这类自然图像与文档指标；
   qwen3.8-flash 只有「能操作桌面应用」的宣传。
   **点击能不能落准，是整个方案的第一风险，必须先用探针量出来**（第 7 节 P-2）。
   **阶段 0 已实测（第 10 节）**：在合成界面上、用 0–1000 归一化坐标时，qwen3.8-flash 59/60、
   deepseek-flash 52/60；走工具调用的真实路径时 qwen 10/10、DeepSeek 8/10。定位不是瓶颈。
3. **两个端点都不支持 Anthropic 内置的 `computer_*` 工具类型。**
   Atlas 必须自己定义 computer 工具（普通 function tool），
   也就享受不到 Anthropic 那套服务端截图注入分类器。
4. **截图放在消息的哪个位置，是端点行为。**
   百炼 Anthropic 兼容文档里 `tool_result.content` 只定义了字符串；DeepSeek 文档说「图片只能放在 user 消息里」。
   ~~最可能的形态是「tool_result 之后、同一条 user 消息里追加 image 块」~~ ——
   **阶段 0 实测推翻了这个推测**：放在 `tool_result` 里，两个端点都收得到；
   放在 `tool_result` 之后的 image 块，**百炼返回 200 却静默丢图**（4/4，图贡献 0 token），DeepSeek 正常。
   这正是「文档 ≠ 行为」的又一例，结论必须写进端点能力声明，不能写死在代码里（D-07）。
5. **坐标系有三层：模型看到的图 → 截图像素 → 系统事件用的逻辑点。**
   缩放与反算必须在同一处做。端点还会在服务端二次缩放（DeepSeek 每图 ≤1024 token），
   所以客户端必须预先缩到「端点不会再缩」的尺寸。
   **坐标约定（绝对像素还是 0–1000 归一化）是模型行为**，同样属于能力声明。
   **阶段 0 实测**：0–1000 归一化是两个模型共同的最优解，且它不受服务端缩放影响。
   qwen3.8-flash 在工具描述明写「像素坐标」时**照样输出归一化坐标**（1/10、0/10 命中），
   按像素换算会每一下都点偏、且不报错。
6. **本机模式没有真正的隔离层。**
   seatbelt 只管 Atlas 自己的子进程，而 GUI 动作的副作用发生在别的 App 进程里。
   基于 Apple Virtualization 的 macOS 虚拟机（Lume / Tart）只支持 Apple Silicon，这台 Intel 机器用不了。
   剩下的边界只有四样：应用白名单与分级、窗口级截图、人工审批、执行前 UI 状态复核。
7. **本机模式有一个特有的致命风险：自我审批。**
   Atlas 的审批卡片（浏览器）和 CLI 审批提示（终端）就显示在同一块屏幕上，
   GUI 工具能看见它们，也能点到、敲进去。
   驱动层必须**硬性拒绝**向 Atlas 自己的窗口投递事件。
8. **系统授权（TCC）记在「负责进程」名下。**
   从终端启动的 node 去截屏、点击时，授权会记到终端 App 上 ——
   给终端开「辅助功能」，等于让该终端里启动的一切进程都能操控整台电脑。
   建议用一个独立签名的辅助 App 单独持有授权。
9. **驱动建议：第一阶段自建一个 Swift 小助手**（本机已有 Swift 6.3.3 工具链），
   只用公开 API（ScreenCaptureKit / CGEvent / AXUIElement），前台模式起步。
   **不用** SkyLight 私有 API 做后台操作，它在 Intel 上有已知崩溃。
   Peekaboo（MIT、通用二进制、macOS 15+）适合做快速原型对照。
10. **审批粒度两头为难。** 逐次点击审批没法用；按应用授权在语义上就是 capability lease，
    而仓里 ADR-0005 / 决 5 明确不做 lease —— 需要一份新 ADR。
11. **预算一定撞墙。** GUI 任务的步数是现有任务的数倍
    （OSWorld 2.0 平均约 318 次工具调用；最好的 agent 仍比人多走 2.7–4.3 倍步数），默认 20 轮不够用。
12. **事实表要说真话。**
    - GUI 动作落 §18.2 分支三（崩溃后无从观察）；
    - resume 后必须先重新截图；
    - GUI 状态是 transcript 之外的隐藏状态；
    - 完成判定没有现成 Verifier，「模型说做完了」不能当作事实。

---

## 1. 范围

### 1.1 第一阶段做什么

- 本机 macOS（就是这台机器），单屏，前台操作；
- 两个目标模型：`deepseek-flash`、`qwen3.8-flash`；
- 观察：整屏 / 单窗口截图、窗口列表、辅助功能（AX）树、局部放大；
- 动作：点击、输入、按键、滚动、拖拽、等待。

### 1.2 第一阶段不做什么

| 不做 | 理由 |
|---|---|
| 虚拟机隔离 | 用户决定第一阶段只考虑本机；且 Lume / Tart 的 macOS 虚拟机要求 Apple Silicon |
| 后台操作（不抢鼠标） | 依赖 SkyLight 私有 API（`SLEventPostToPid`）；cua-driver 在 x86_64 上有可稳定复现的 SIGSEGV（[cua#2688](https://github.com/trycua/cua/issues/2688)） |
| 多显示器 | 本机只有一块屏；多屏的坐标原点与缩放因子各不相同，是独立问题 |
| 手机、远程桌面 | 不在本阶段 |
| 本地 GUI 定位模型（UI-Venus、Holo 等） | 本机为 Intel 集成显卡，7B 以上的视觉模型跑不动；定位只能交给 API 模型 |

---

## 2. 行业现状（2026-10）

### 2.1 三家闭源 API 的形态

| | Anthropic | OpenAI | Google Gemini |
|---|---|---|---|
| 工具形态 | `computer_toolset_20260801`：一个条目带 17 个成员工具，已 GA；Claude 5.5 起拒收旧版 `computer_20251124` | `{"type":"computer"}`；`computer_call` 里是**批量的** `actions` 数组 | Computer Use 工具：预定义 UI 动作（`click_at`、`type_text_at` 等），可排除预定义函数、追加自定义函数 |
| 坐标 | 截图像素坐标；`zoom` 之后仍按全屏帧计 | 截图像素 | **0–1000 归一化**，由客户端反算 |
| 截图尺寸 | Claude 5 系长边 ≤2576 px、约 3.75 MP；更早型号 ≤1568 px、约 1.15 MP；每张约 1000–1800 token | `detail: "original"` 保持原分辨率 | 由客户端决定 |
| 一批多个动作 | **按序执行，遇到第一个失败就停**，其余回 `Not executed` | 批量 actions 依次执行 | 一次可返回多个函数调用 |
| 安全机制 | 截图自动过提示注入分类器；建议专用 VM、域名白名单、后果性操作人工确认 | 建议白名单；购买、外发、破坏性操作前确认 | 每个动作可带 `safety_decision`（允许 / `require_confirmation` / 阻止），用户确认后回传 `safety_acknowledgement` |
| 上下文管理 | 每请求超过 20 张图后限制变严；建议保留最近 3 张全分辨率截图，旧图**成批**替换成文字占位（间隔约 25 轮），以保持缓存前缀稳定 | `previous_response_id` 续接；文档明说「续接不会恢复浏览器会话、登录态或运行时变量」 | — |
| 另一种形态 | `zoom`：取局部原分辨率 | **代码即动作**：`exec_py` 在持久桌面里跑 pyautogui 脚本，一次调用可以包含循环和条件 | 新版本宣称支持「基于意图的动作」与可配置安全策略（细节未核实） |

Anthropic 还有几条可直接借鉴的工程经验（[best practices](https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude)）：

- **文字指令放在截图之前**，点击更准；
- 小目标用 `zoom`，或改用键盘操作；
- 内部测试里**没有稳定收益**的做法：切图、叠加坐标网格、换缩放算法。这是对 Claude 的结论，对两个目标模型是否成立【验】；
- 参考实现自带三件调试工具：轨迹查看器、单工具调试面板、「定位试验场」（拿一张图测点击预测）。

### 2.2 与 Atlas 两个模型相关的模型与服务

| 模型 / 服务 | 要点 | 与 Atlas 的关系 |
|---|---|---|
| 百炼 GUI-Plus（`gui-plus-2026-02-26`） | 专用 GUI 模型，有思考 / 非思考两种模式；动作 15 种（含 `answer` / `interact` / `terminate`）。官方示例只保留最近 4 轮截图，更早的压成文字摘要；示例里 7750 个输入 token 中有 6743 个是图片。坐标约定文档前后不一致：一处说统一按 1000×1000 归一化，示例输出却出现了 2530 | **只提供 OpenAI 兼容与 DashScope 原生接口，不支持 Anthropic 兼容**。Atlas 只有 Anthropic 形状适配器，用它要新写一个形状适配器 |
| Qwen-UI-Agent（2026-07 技术报告，27B） | OSWorld-Verified 79.5%，仅次于 Claude Opus 4.8 的 83.4%；动作空间混合 GUI 与命令行，超过 40% 的输出是一批多个动作；ScreenSpot-Pro 76.6%（开 zoom 81.5%） | 证明「GUI 与 CLI 混用、一批多个动作」能显著缩短轨迹；**权重与 API 可用性未确认** |
| Qwen3.7-Plus（2026-06） | 原生多模态，宣传桌面 / 移动界面理解与多步操作；ScreenSpot-Pro 68.9%（UI-Venus-2 报告中的对比数字） | Atlas 原主力模型；同族模型的定位能力有公开数字可参考 |
| **qwen3.8-flash** | 多模态（图、文、视频输入，文字输出），1M 上下文；北京区可用；宣传「操作桌面应用」，**无公开 GUI 分数** | 目标模型之一 |
| **deepseek-flash**（V4.1-Flash，2026-09-10） | 视觉并入主模型；Anthropic 兼容接口支持 image 块；每图 ≤1024 token；**无公开 GUI 分数**（官方给的是 RefCOCO 86.0、DocVQA 95.6） | 目标模型之一 |
| UI-TARS-2 / UI-Venus-2 / Holo / GTA1 / GroundNext | 开源 GUI 专用模型；UI-Venus-2-9B 在 ScreenSpot-Pro 达 73.0% | 本机跑不动。只在「规划与定位分离」时作为远程定位器备选（【议】CU-10） |

### 2.3 开源框架与本机工具

| 项目 | 做法 | 对 Atlas 的启发 |
|---|---|---|
| [Anthropic computer-use-demo](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo) | Docker ＋ Xvfb 桌面、全部动作的工具实现、采样循环、调试界面 | 白盒界面可以借鉴「定位试验场」与轨迹查看器 |
| [Agent S3](https://github.com/simular-ai/Agent-S)（Simular） | 规划模型与专用定位模型分离（GPT-5 ＋ UI-TARS-1.5-7B）；行为最优 N（bBoN）：多次完整尝试后，按「行为叙述」选最好的一次，OSWorld 72.6%，超过人类的 72.36% | bBoN 需要可并行的独立环境，本机模式做不到；「规划 / 定位分离」是 deepseek-flash 定位不足时的退路 |
| [UFO2](https://github.com/microsoft/UFO)（微软） | Windows UIA 结构化控件 ＋ OmniParser 视觉检测融合；能用应用原生 API 就不点界面；画中画虚拟桌面不打扰用户；危险动作暂停确认 | **API / CLI 优先，GUI 兜底** |
| [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop)（字节） | Operator 抽象只有 `screenshot()` 与 `execute()` 两个方法；每步带最近 5 张截图 | 驱动层接口可以同样窄 |
| [cua](https://github.com/trycua/cua)（trycua） | Driver（后台操作，靠 SkyLight 私有 API）、Lume（Apple Silicon 虚拟机）、Bench | 后台模式与虚拟机都不适用于本阶段 |
| [Peekaboo](https://github.com/openclaw/Peekaboo)（MIT） | ScreenCaptureKit 截屏（整屏 / 应用 / 窗口三种）＋ AX 元素 ID；有 CLI 与 MCP；macOS 15+；通用二进制，支持 Intel | 最成熟的本机驱动，适合做原型对照 |
| [macos-computer-use-kit](https://github.com/Sur-Cai/macos-computer-use-kit)（pyobjc） | AX 优先定位；结果区分 `action_sent` 与 `verified`；**重复有副作用的动作之前必须重新观察**，拒绝盲目重试；拒绝向密码管理器、钥匙串、安全对话框、登录窗口输入；拒绝向安全输入框打字 | 与 Atlas「动作级事实」「执行后核实」的思路高度一致，值得照抄规则 |
| Claude Code 内置 computer-use（2026-03 起研究预览，macOS） | 按应用分三档且不可改：浏览器与交易平台**只能看**，终端与 IDE **只能点**，其他应用完全控制。每个应用每个会话单独批准，终端与 IDE 标注「等同 shell 权限」，Finder 标注「可读写任意文件」。优先级是 MCP → shell → 浏览器自动化，**屏幕操作是最后手段**；操作时隐藏未批准的应用；同一时刻只允许一个会话使用 | 应用分级、按应用授权、「GUI 是兜底」都可直接借鉴 |
| [Playwright MCP](https://playwright.dev/mcp/vision-mode) `--caps=vision` | 在快照（无障碍树）工具之外，加 `browser_mouse_click_xy` 等坐标类工具；`browser_take_screenshot` 是核心工具 | Atlas 已接 Playwright MCP。浏览器里的视觉操作不需要 computer 工具，**只缺图像通道** |

### 2.4 基准与「现在做到什么程度」

- **OSWorld**（2024）：369 个任务，在真实 Ubuntu 虚拟机里按执行结果判分；人类 72.36%，当时最佳模型 12.24%。
- **OSWorld-Verified**：据 2026-07 的论文，前沿 agent 已超过 85%，高于人类基线。但同一模型在不同评测设置下会差好几个百分点，跨来源的数字不能直接比。
- **OSWorld 2.0**：108 个长任务，人类中位耗时约 1.6 小时，agent 平均约 318 次工具调用；发布时最好的配置完整完成率只有 20.6%。
- **OSWorld-Human**（MLSys 2026）：
  - 最好的 agent 仍比人多走 2.7–4.3 倍步数；
  - 规划调用占总时延一半以上，最高约 75%；
  - 越往后每步越慢，最多慢到 3 倍，主要花在上下文预填充上；
  - 23% 的错误来自视觉定位。
- **观察方式消融**：对通用模型，「截图＋无障碍树」通常最好，纯截图最差（Gemini 2.5 Pro：纯截图 5.3%，截图＋无障碍树 25.6%）；标记集（SoM）的效果因模型而异；LibreOffice 这类应用的无障碍树有上千个节点，会推高 token 与步数。
- **评测本身也会错**：复核 150 条被判失败的轨迹，15.3% 判错（10.7% 是评估器漏判，4.7% 是任务本身坏了）；真实失败里，「验证与反馈」「规划」两类问题多于「执行与定位」。
- **验证器的设计比模型更重要**：Universal Verifier 把误判成功率从 ≥45%（WebVoyager）、≥22%（WebJudge）降到接近 0，而给基线换同一个更强的模型只带来小幅改善。

### 2.5 安全研究：提示注入、时间窗与恢复

**提示注入**

- 弹窗攻击（ACL 2025）：平均攻击成功率 86%，任务成功率降 47%；「让 agent 忽略弹窗」这类提示词防御无效。
- VPI-Bench（ICLR 2026）：电脑操作 agent 最高 51% 被骗，浏览器 agent 在部分平台达到 100%。
- OS-Harm（NeurIPS 2025）：o4-mini 在 20% 的情况下执行了基础注入。
- StepJack（2026-08）：把注入拆成多步，成功率最多再升 31.2 个百分点。
- 系统级防御 CaMeL-CUA（2026-01）：可信规划器在看到任何不可信内容之前，一次性产出带分支的完整计划；执行器只跑预先批准的函数，隔离的感知模型只负责填坐标。代价是只保留前沿模型最多 57% 的成绩。
- **共同结论：只靠提示词的防御一贯失效。** 有效的是架构隔离、权限收窄和后果性动作的人工确认。
  **DeepSeek 与百炼都没有宣称对截图做注入检测**（Anthropic 有）。

**时间窗（TOCTOU）**

- 在 OSWorld 上实测，截图到执行之间平均隔 6.51 秒。在这个窗口里切换窗口焦点，100% 能把动作重定向到别处，而截图上没有任何痕迹。
- 防御方法 PUSV：执行前重新比对目标区域像素（掩码 SSIM）、全局截图差异和窗口快照差异，开销不到 0.1 秒；但对纯 DOM 注入几乎无效。
- **对 Atlas 的含义**：人批准的是「在 T0 的截图上点这里」，执行却发生在 T1。
  审批必须绑定到具体的窗口与目标区域，执行前必须复核，不一致就具名拒绝。
  这是 M5 那条「审批看到的与真正执行的必须是同一件事」在 GUI 上的版本。

**恢复**

- ACRFence：从检查点恢复后，agent 会重新生成「略有不同」的请求，服务端把它当成新请求，造成重复支付、重复提交（10 次试验 10 次重复提交）。
- Safe to Resume?：一个被正确恢复的检查点，也可能进入一个在任何合法历史里都没同时存在过的状态。
- Recoverability as a System Primitive：「保存过的状态不自动是好的恢复点，复用它应是一次显式、经过检查的决定，并允许拒绝自动继续」。
  **这正是 Atlas 的 `RECOVERY_REQUIRED` ＋ 显式 CONTINUE / ABORT**，外部研究独立得出了同一结论。
- Atomix：可逆副作用回滚，不可逆副作用在闸门处拦住，解决不了的记下来交人处理 —— 与 §18.2 三条分支同构。

---

## 3. 两个目标模型：已知与未知

> 下表是**调研时**的已知与未知。其中的【验】项已由阶段 0 实测回答，结果见第 10 节；
> 保留原表是为了让「推测」与「实测」并排可比。

| | deepseek-flash | qwen3.8-flash |
|---|---|---|
| 背后的模型 | DeepSeek-V4.1-Flash（2026-09-10；旧名 `deepseek-v4-flash` 已被服务端路由到它） | Qwen3.8-Flash（2026-08，Qwen4 架构预览） |
| Atlas 用的接口 | DeepSeek Anthropic 兼容地址 | 百炼北京区 Anthropic 兼容地址 |
| 图片输入 | ✅ Anthropic image 块（base64 / url / file） | ✅ 模型支持图、文、视频输入；兼容接口定义了 image 块 |
| 图片能否放进 `tool_result` | 文档说图片「只能放在 user 消息里」，放进 system / assistant 会返回 400；`tool_result` 内嵌图片没有说明 →【验】 | 文档里 `tool_result.content` 只定义了字符串 →【验】。**风险：零协议兜底的端点可能 200 放行却静默丢图** |
| 单图计费 | 自动缩放，每图上限 1024 token；`detail` 可选 low（512×512）/ high / original / auto | 未公开；Qwen-VL 系通常按像素块计，受 `min_pixels` / `max_pixels` 约束 →【验】 |
| 单请求图片上限 | 600 张；单边 ≤8192 px（≥15 张时 ≤4096） | 未公开 →【验】 |
| 坐标约定 | 未公开，也没有 GUI 指标 →【验】 | Qwen3-VL 系是 0–1000 归一化；3.8 是否沿用未确认 →【验】 |
| GUI 定位成绩 | 无公开数字 | 无公开数字（同族 Qwen3.7-Plus 的 ScreenSpot-Pro 是 68.9%） |
| Anthropic 内置 computer 工具 | ❌ | ❌ |
| 其他协议差异 | `disable_parallel_tool_use` 与 `cache_control` 被忽略 | 支持显式缓存断点（3.7-plus 已实测；3.8 的声明是 ASSUMED） |
| 价格参考 | — | 北京区输入 0.8 元 / 百万 token，输出 2.7 元 / 百万 token |

> ⚠️ **顺带发现的配置不一致（本次不修）**
>
> - 根 `.env` 写的是 `deepseek_model=deepseek-flash`，而 `compose.ts` 的选择表只登记了 `deepseek-v4-flash`
>   （[compose.ts:226](../../apps/cli/src/compose.ts#L226)）。按 M-5 规则，`--endpoint deepseek` 现在会在启动时被拒。
> - 那份 `PROBED` 的 DeepSeek 声明是对 V4-Flash 实测的，而服务端已把这个名字路由到 V4.1-Flash ——
>   **声明背后的模型换了，实测结论可能已经漂移**。
> - 接入 computer use 之前，两份 flash 声明都需要重跑 probe。

---

## 4. 本机 macOS 技术底座

### 4.1 本机事实（2026-10-03 只读核对）

| 项 | 值 | 含义 |
|---|---|---|
| 架构 | x86_64（Intel Core i7） | Apple Virtualization 的 macOS 虚拟机不可用；SkyLight 后台注入在 Intel 上有已知崩溃 |
| 系统 | macOS Tahoe 26.6（25G72） | 这款机型升不了 macOS 27，Tahoe 只再提供安全更新（预计到 2027–2028）。**26.7.1（2026-09-28）修复了一个已被在野利用的 CoreGraphics 越界写漏洞**；当宿主机直接被 agent 操作时，补丁等级就是安全边界的一部分 |
| 显示 | 单屏；面板 3072×1920；「看起来像」1792×1120 pt；缩放因子 2 | 全屏截图是 3584×2240 px（约 800 万像素）；系统事件坐标用 pt |
| 工具链 | Xcode Command Line Tools，Swift 6.3.3 | 可以本地编译 Swift 辅助程序，不引入 npm 依赖 |
| Node | v24.19.0 | — |
| 系统自带命令 | `/usr/sbin/screencapture`、`/usr/bin/osascript` | 可做零依赖原型 |

同一个点在三层坐标里的样子：

```text
模型看到的图     1280 × 800    （示意：按 16:10 等比缩小，确保端点不再二次缩放）
截图像素         3584 × 2240   （= 逻辑点 × 2）
系统事件逻辑点   1792 × 1120   （CGEvent 用这一层）

模型说点 (640, 400)        → 截图 (1792, 1120) → 逻辑点 (896, 560)
若模型用 0–1000 归一化 (500, 500) → 逻辑点 (896, 560)
```

### 4.2 观察手段

| 手段 | 说明 | 适用 |
|---|---|---|
| ScreenCaptureKit | 可按整屏 / 某应用 / 某窗口过滤内容；需要「录屏与系统录音」权限 | **推荐只截被授权应用的窗口**：既减少隐私外发，也减少其他窗口带来的注入面 |
| `screencapture -x [-l <窗口ID>]` | 系统自带命令，可以截单窗口 | 零依赖原型 |
| AX 树（`AXUIElement`） | 角色、标题、值、位置、尺寸、可执行的动作；需要「辅助功能」权限 | 原生 AppKit 应用质量高；Electron / Chromium、画布类（Figma、游戏）往往残缺 |
| Vision 框架 OCR | 本地文字识别，Intel 可用 | 按文字定位目标，不依赖模型的定位能力 |

### 4.3 动作手段

| 手段 | 行为 | 风险与限制 |
|---|---|---|
| `CGEventPost`（HID 事件流） | 和真鼠标一样，**会移动光标、抢焦点** | 用户不能同时使用电脑；最通用、最稳 |
| `CGEventPostToPid` | 投给指定进程，光标不动 | Chromium 会静默丢弃这类点击；事件不带窗口时 AppKit 不路由 |
| SkyLight `SLEventPostToPid`（私有 API） | 真正的后台点击（cua-driver 与 Codex 的做法） | 私有 API；**x86_64 上会崩溃**（cua#2688）；系统更新可能让它失效 |
| AX 动作（`AXPress`、`AXSetValue`） | 按语义操作控件，不依赖坐标；原生控件可在后台执行 | 依赖应用的无障碍实现质量 |
| AppleScript / JXA（应用脚本字典） | Finder、Mail、备忘录、Safari 等可以按语义驱动 | 「API 优先」的落点；需要「自动化」（Apple Events）授权 |
| 安全输入（Secure Event Input） | 密码框激活时，系统挡住合成的键盘事件 | 应当**拒绝**，而不是想办法绕过 |

### 4.4 权限（TCC）

- **需要哪些授权**：「辅助功能」负责点击、输入、读 AX 树；「录屏与系统录音」负责截图；用脚本控制其他应用还需要「自动化」。
- **授权记在「负责进程」名下**：
  - 从终端启动的命令行工具，授权算在终端 App 头上；从 Finder 或 `open` 启动的 App 自己负责；
  - 可以用未公开的 `responsibility_spawnattrs_setdisclaim` 让子进程自担授权
    （[disclaim](https://github.com/torarnv/disclaim)）。Claude 桌面版就用 `Contents/Helpers/disclaimer` 启动子进程，
    本次调研会话的父进程正是它。
- **TCC 怎么认人**：按「bundle ID ＋ 代码签名要求」识别客户端。
  **没有稳定签名身份的工具，每次重新编译都可能被当成新程序**，授权随之失效。
- **生效时机**：授权之后要重启进程才生效。
- **按月重新确认**：Tahoe 保留了 Sequoia 引入的**录屏授权按月重新确认**弹窗，只能用 MDM 键关闭；
  无人值守的任务可能卡在这里。
- **推荐形态**：做一个独立的 `Atlas GUI Helper.app`（固定 bundle ID，ad-hoc 或开发者签名），
  由它持有两项授权，Atlas 通过本地管道或 socket 与它通讯。
  这样授权范围是「这个助手」，而不是「整个终端」。

### 4.5 驱动选型对比

| 方案 | Intel | 依赖基线 | 后台 | AX | 授权主体 | 评价 |
|---|---|---|---|---|---|---|
| A. 自建 Swift 助手（只用公开 API） | ✅ 本机可编 | 不增加 npm 依赖；新增一个需要编译、签名的原生组件 | 第一阶段不做 | ✅ | 独立 .app | **推荐**。坐标反算、执行前复核、窗口过滤、硬拒绝规则都在可控范围内；接口可以窄到「截图 / 执行」两件事 |
| B. Peekaboo（CLI / MCP） | ✅ 通用二进制 | 外部 brew / npm 工具 | 部分支持 | ✅ | 取决于启动方式 | **推荐做原型对照**：功能最全。但它是外部演进的工具，Atlas 不应为它解析参数（ADR-0011 的约束） |
| C. cua-driver | 官方支持，有 x86_64 崩溃记录 | 外部守护进程 | ✅（私有 API） | ✅ | 守护进程 | 不适合本阶段 |
| D. macos-computer-use-kit | ✅ | 引入 Python 运行时 | ✅ | ✅ | 调用方 | 设计规则值得抄，形态不合（Atlas 是 Node 单进程） |
| E. JXA / `osascript` ＋ `screencapture` | ✅ | **零新依赖** | ❌ | 有限 | 终端 | 适合阶段 0 的手工探针；不适合产品形态（授权落在终端上，每步都要起进程） |
| F. nut.js 分支（`@computer-use/nut-js`） | ✅ | 新增原生 npm 依赖 | ❌ | ❌ | 终端 | 上游预编译包已转为付费私有仓库，开源分支停在 2025-01；不推荐 |

---

## 5. 映射到 Atlas：逐层差距分析

### 5.1 模型轨道（Runtime ＋ 形状适配器）

**现状**

- `ModelContent` 只有 text / reasoning / tool_call / tool_result 四种，`tool_result.content` 是字符串
  （[context.ts:62](../../packages/harness-runtime/src/types/context.ts#L62)）；
- 形状适配器把它渲染成纯文本（[protocol.ts:578](../../adapters/shape-anthropic-messages/src/protocol.ts#L578)）；
- 本地 token 估算按「字符数 ÷ 2.5」（[protocol.ts:617](../../adapters/shape-anthropic-messages/src/protocol.ts#L617)），图片没法这样估。

**需要**

- 一种「图像引用」内容块：transcript 只存引用与哈希，编译上下文时再取字节；
- 形状适配器按端点声明，决定图片放在 tool_result 内还是尾随的 user 块里（【议】CU-2）。

**注意**：图片进入请求后，同一张图每一轮的 base64 必须逐字节相同，
否则帧哈希与前缀缓存每轮都会失效。

### 5.2 Resource 分类：推翻一条现行设计

**现状**

- `ResourceKind` 只有 text 与 binary 两类（[resource.ts:9](../../packages/harness-runtime/src/types/resource.ts#L9)）；
- 二进制一律标 `OPAQUE_BINARY_NOT_TEXT_SCANNED`，注释写明「禁止 base64 穿过模型通道」；
- `verify:resource` D 段专门断言二进制不进入 transcript、trace 与模型审计；
- MCP 返回的图片块被转成不透明 Resource，只在结果里留一句「没有进入上下文」
  （[client.ts:380](../../tools/mcp/src/client.ts#L380)）。

**需要**

- 第三类「模型可见图像」，带自己的处置标记。它**无法做文本脱敏**，只能如实记录「图像未脱敏、已外发至端点」；
- 这是对一条现行设计的反转，按仓内规矩要有 ADR（【议】CU-1）。

**连带好处**：Playwright MCP 的 `browser_take_screenshot` 立刻能用，
浏览器里的视觉任务不需要等 computer 工具。

### 5.3 端点能力声明

**现状**：`EndpointCapabilityProfile` 只有 protocol / context / tokens / errors / limits 五组
（[endpoint.ts:104](../../packages/harness-runtime/src/types/endpoint.ts#L104)），没有任何视觉字段。

**建议新增一组 `vision`**（字段名只是示意）：

- `acceptsImageInput`；
- `imageInToolResult`：`SUPPORTED` / `REJECTED` / `SILENTLY_DROPPED` / `UNKNOWN`，以及实际采用的 `imageCarrier`；
- `maxImageLongEdgePx`、`maxImagePixels`、`maxImagesPerRequest`、`imageTokenFormula`；
- `serverSideResize`：服务端会不会二次缩放；
- `groundingCoordinateSpace`：`IMAGE_PIXELS` / `NORMALIZED_1000` / `UNDECLARED`。

阶段 0 又实测出两条必须进声明的差异（第 10.1 节）：`count_tokens` 算不算图（DeepSeek 算、百炼不算），
以及 `tool_result` 之后的 image 块会不会被静默丢弃（百炼会）。

**循环纪律第 5 条不受影响**：主循环仍然不读声明。读它的是 Context 编译、形状适配器与 compose；
compose 再把「显示规格」随 RunSpec 冻结后交给工具，先例是 `ToolExecutionContext.timezone`。

### 5.4 Context 与 Compact

- **截图是上下文里最贵、过期最快的东西。** 可参考的保留策略：
  - Anthropic 保留最近 3 张全分辨率，旧图**成批**替换（间隔约 25 轮，保护缓存前缀）；
  - GUI-Plus 示例保留最近 4 轮；
  - UI-TARS 每步带最近 5 张。
- **与现有机制的关系**：旧截图移出时留下「文字占位 ＋ 图像引用」，和 Compact「移出但可恢复」的模型一致。
  但对图片来说，「恢复」意味着把图重新放回上下文（需要一个只读的「查看图像」工具），
  而不是 `read_resource` 那种文本分页。
- **成批还是逐张**：逐张移出会让前缀缓存每轮失效（STRICT_PREFIX）。
  移出节奏是与端点缓存能力相关的取舍，应当是数据，不是写死的常数。

### 5.5 动作、策略与审批

**现状**：`EffectScope.kind` 只有 FILE / DIRECTORY / URL / PROCESS / EXTERNAL_TOOL / NONE
（[tool.ts:37](../../packages/harness-runtime/src/types/tool.ts#L37)），审批展示按 scope 分派。
GUI 动作没有合适的 kind；复用 PROCESS 或 EXTERNAL_TOOL 会让审批面说出不相干、甚至相反的话
（ADR-0011 里 `scopeKind: "PROCESS"` 那条教训）。

**建议**

- **新增 GUI 专用 scope**（如 `GUI_TARGET`：应用 bundle ID ＋ 窗口 ＋ 目标区域）。审批卡展示：
  - 应用名与窗口标题；
  - **以目标点为中心的截图裁片（带十字准星）**；
  - 动作类型，以及要输入的文本。
- **审批粒度**（【议】CU-4）：逐次点击会让人疲劳（ADR-0012 的起因就是十几次确认）；
  按应用、按 Run 授权在语义上就是 capability lease，而 ADR-0005 / 决 5 明确不做 lease。
  要重开就需要新 ADR，并说清这次的证据是什么。
- **TOCTOU**：审批绑定到「窗口 ID ＋ 目标区域图像哈希」，执行前复核；不一致就具名拒绝，并要求重新观察。
- **两道闸门的对应**（沿用 `run_shell` 的分层）：

  | 层 | GUI 里对应什么 | 判错的代价 |
  |---|---|---|
  | 一 | `ComputerEffectResolver` ＋ Policy：按应用分级与动作类型，决定要不要问人 | 多问一次 |
  | 二 | Helper 内的硬规则：不在白名单的应用、Atlas 自己的窗口、密码管理器与钥匙串、系统安全对话框、安全输入 → 直接拒绝 | 真的没有边界 |

  合并这两层时必然出现的写法是「既然审批过了，硬规则就不用了」—— 那正好把边界拆掉。

### 5.6 ActionBatch：「遇错即停」还没有接线

- GUI 的一批动作往往前后依赖（点开对话框 → 输入 → 回车）。点击失败后继续输入，字会打进错误的窗口。
  Anthropic 明确要求「按序执行、遇到第一个失败就停、其余回 Not executed」。
- **现状**：`BatchSettlementPolicy` 有 `SKIP_REMAINING` 和 `ABORT_BATCH` 两个分支，
  但**全仓没有任何生产代码或验收脚本传入非默认值**，默认始终是 `CONTINUE_REMAINING`
  （[tool.ts:391](../../packages/harness-runtime/src/types/tool.ts#L391)）。
  按「未接线比不写更糟」的纪律，这两个分支目前是没有判据覆盖的代码。
- **需要**：让「遇错即停」成为可以按工具（或按「这一批里有没有 GUI 动作」）生效的真实路径，并补上判据。

### 5.7 恢复（§18.2）

- GUI 动作既不幂等，崩溃后也无从观察 → 落分支三 → `RECOVERY_REQUIRED`，与 `run_shell` 同类。
- GUI 状态是 transcript 之外的隐藏状态，与阶段 3.5 拒绝持久 cwd、ADR-0011 的登录态同形。处置：
  - resume 后的第一个动作必须是重新观察；
  - 恢复横幅如实写明「屏幕状态在 transcript 之外，以下是恢复时的新观察」。
- 登录、二次验证、验证码这类事交给 `request_handoff`（「你去做」）：人在同一块屏幕上做完后，Atlas 重新观察。
  验证码不得由 agent 自己去解。
- ACRFence、Recoverability as a System Primitive 等外部研究独立得出「恢复必须是显式决定」，与 Atlas 现行设计一致，**不需要改方向**。

### 5.8 预算

- 默认 `maxTurns: 20`（[budget/index.ts:56](../../packages/harness-runtime/src/budget/index.ts#L56)）、`maxToolCalls: 100`。
  GUI 任务的步数完全是另一个量级（OSWorld 2.0 平均约 318 次工具调用），20 轮一定撞墙。
- 图片 token 计入 `billedInputTokens`。deepseek-flash 每张 ≤1024 token，保留 3 张约 3k token / 轮，可控。
  真正的成本是越来越长的上下文预填充（OSWorld-Human：越往后每步越慢，最多 3 倍）。
- 轮数轴可以靠「一批多个动作」缓解（Qwen-UI-Agent 超过 40% 的输出是批量动作）。
  Atlas 的批执行本来就支持一轮多个 tool_call，前提是 5.6 的「遇错即停」接上。

### 5.9 Progress Guard

「动作前后截图几乎没变」是一个**由 Runtime 计算、不依赖模型自述**的无进展信号（比如感知哈希距离），
可以直接接进现有的 Guard。Desktop-Delta Bench、用「动作引起的视觉差异」做反思的研究，用的都是这个信号。

### 5.10 完成判定

- Atlas 的结算只查事实表（Verification 结果），而 GUI 动作没有现成的 Verifier。
  「模型截图后说做完了」是自述，不是事实。
- 外部证据：评测里约 15% 的失败判定是错的；Universal Verifier 能把误判成功率从 ≥45% 降到接近 0。
  说明 GUI 结果的核实是一个独立的工程问题。
- 第一阶段比较诚实的候选处置：GUI 任务默认最多结算到 `COMPLETED_WITH_LIMITS`，
  除非有可核实的事实（例如产出了文件并通过产物检查）。
  这会碰到「通用 Completion Gate」（S5-7，需要 ADR 才能重开），列为【议】CU-9。

### 5.11 执行特权轴（ADR-0012）

- `SANDBOXED` 对 `run_shell` 有真实含义（seatbelt），对 GUI 没有：GUI 动作在别的进程里生效。
- 候选：`SANDBOXED` 下 GUI 工具只开放只读观察，动作类只在 `UNRESTRICTED` 下可用；或者给 GUI 单独开一条轴。
- 无论选哪个，**都不能**让 `SANDBOXED` 下的 GUI 动作看起来像「跑在沙箱里」（【议】CU-5）。

### 5.12 现有护栏会被 GUI 绕过（必须写成代价）

- **凭证读禁（护栏 1）**：GUI 可以用文本编辑器打开 `.env`，截图随即发往第三方端点。
- **`fetch_url` 拒私网（护栏 2）**：GUI 可以用浏览器访问内网（ADR-0011 对 MCP 已经接受了同样的代价）。
- **数据外发**：每次模型调用就是一次数据外发（§22.7）。整屏截图会把通知、其他窗口、聊天记录一起发出去；
  窗口级截图是第一道减法。
- **自我审批**：Atlas 的审批卡片在浏览器里、CLI 审批在终端里，都在同一块屏幕上。
  GUI 工具必须在驱动层硬性拒绝向 Atlas 自己的窗口（以及承载它们的终端与浏览器）投递事件，并把它们排除在截图之外。
  可参考 Claude Code：浏览器只能看、终端只能点。
- **模型审计会被撑大**：审计文件记录完整请求体（[file-store.ts:51](../../apps/cli/src/model-audit/file-store.ts#L51)），
  每一轮都会把保留的几张截图再写一遍 base64。需要按哈希去重存储（【议】CU-8）。

### 5.13 白盒界面

- 界面的 CSP 已允许 `img-src 'self' data:`（[security.ts:139](../../apps/workagent-service/src/security.ts#L139)），
  显示截图缩略图不需要放宽安全策略。
- 「逐轮解剖」里应该能看到：模型这一轮看到的截图、它点的位置（叠加标记）、执行前复核的结果。
  这是白盒界面对 computer use 最有价值的一屏（Anthropic 参考实现也专门做了定位试验场与轨迹查看器）。

---

## 6. 方案选项与推荐

| 选项 | 做法 | 优点 | 卡在哪 |
|---|---|---|---|
| ① 外接 MCP（Peekaboo / cua-driver 等） | 写进 `mcp.json`，不写工具代码 | 最快 | 仍要先打通图像通道；**坐标缩放与反算需要理解参数**，与 ADR-0011「Atlas 不解析 MCP 参数」冲突；审批面只能显示整份 JSON，看不出点的是哪；没法做执行前复核 |
| ② 原生 `computer` 工具（纯截图＋坐标） | Atlas 自定义 function tool，驱动走 Swift 助手 | 坐标、复核、审批展示都在 Atlas 手里 | 完全依赖模型的定位精度，而两个模型都没有公开数字 |
| ③ AX 优先（无障碍树＋元素 ID） | 动作以元素 ID 为目标 | 精确、便宜；审批可读（「点『邮件』里的『发送』按钮」）；执行时按元素身份重新解析，天然防 TOCTOU | Electron、画布类应用的树残缺；树大时 token 暴涨 |
| ④ **混合（推荐）** | ②＋③：观察给截图＋精简 AX 树，动作优先用元素 ID，退回坐标 | 文献里对通用模型效果最好（截图＋无障碍树） | 实现量最大 |
| ⑤ 代码即动作 | 让模型写脚本（OpenAI `exec_py` 的思路），或走 AppleScript / `run_shell` | 一轮做很多事，最省轮数 | 审批只能看到脚本，看不到屏幕上的后果；和 ④ 是互补，不是替代 |

**推荐**：

- **以 ④ 为目标形态**，按「先看 → 再点 → 再放开」分阶段推进；
- **① 只作为原型对照**；
- **⑤ 落成工具描述与系统提示里的「API / CLI 优先，GUI 兜底」**，不新增机制。

```text
模型（deepseek-flash / qwen3.8-flash）
   ▲  截图按端点声明放置：tool_result 内，或尾随的 user image 块
形状适配器 ── 只按 profile.vision 渲染图像；不认识坐标
Context 编译 ── 保留最近 N 张、成批移出、按声明估算图像 token
Runtime ── ModelContent 增加图像引用；ResourceKind 增加「模型可见图像」；审计按哈希存
─────────── 候选新边界：GUI 驱动 / AX / CGEvent / ScreenCaptureKit 不得进入 Runtime
            （与第 7 条沙箱、第 12 条 MCP 同形；编号接在现有第 14 条之后）
tools/computer（@workagent/tools-computer）
   · computer 工具：screenshot / zoom / click / type / key / scroll / drag / wait / ui_tree / act(elementId)
   · DisplaySpec：compose 从声明推出，随 RunSpec 冻结后放进 ctx（目标图像尺寸、坐标约定）
   · 坐标反算：模型坐标 → 截图像素 → 逻辑点
   · 执行前复核：前台窗口是否仍是被授权的那个；目标区域有没有变化
   · ComputerEffectResolver：scope = 应用 ＋ 窗口 ＋ 区域；riskFacts = 应用分级、安全输入、数据外发
   ▲ 本地管道 / socket
Atlas GUI Helper.app（Swift，只用公开 API；独立 bundle ID 与签名，单独持有两项 TCC 授权）
   · 硬规则：不向 Atlas 自己的窗口、终端、浏览器投递事件；
            密码管理器、钥匙串、系统安全对话框、安全输入一律拒绝
```

---

## 7. 建议路线：每一段都要能说出「我们验证了什么」

### 阶段 0：探针（花钱但很少；不进 `verify:all`）

> **状态：已完成（2026-10-03）**，代码与证据在 `spikes/s1-computer-use-vision/`，结果见第 10 节。

| 探针 | 要回答的问题 | 判别力怎么保证 |
|---|---|---|
| P-1 图像通道 | 图片放进 tool_result、或尾随在 user 块里，各端点是收下、报错，还是静默丢掉？ | 在图里放一个随机口令（任何文本里都没有），要求模型复述；复述不出就是被丢了。**200 放行不等于收到** |
| P-2 坐标约定与命中率 | 模型给的是图像像素还是 0–1000？在合成界面上能点中多少？ | 合成截图**不能是 1000×1000**，否则两种假设算出同一个数；目标框随机分布、大小分档（含 16 px 级小图标） |
| P-3 图像计费 | 每张图算多少 token？和尺寸是什么关系？ | 发送几种已知尺寸，读 usage 里输入 token 的差值 |
| P-4 服务端缩放 | 端点会不会二次缩放？临界尺寸是多少？ | 由 P-2 的偏差模式与 P-3 的计费曲线共同推断 |
| P-5 真实屏幕可读性 | 本机 3584×2240 的截图缩到端点尺寸后，菜单文字还认不认得出？要不要 zoom？ | 用本机真实截图，问菜单项上的文字 |

### 阶段 1a：观察通道（Runtime 能力，不碰桌面）

- **做什么**：图像内容块、第三类 Resource、端点声明的 vision 组、适配器渲染、Compact 保留策略、审计去重、界面缩略图。
- **第一个消费者**：Playwright MCP 的 `browser_take_screenshot`（已配置，风险最低）。
- **要验证的问题**：端点在图像上的差异，能否像协议差异一样只以数据形态存在、主循环一行不改？

### 阶段 1b：只看不动（本机）

- **做什么**：Swift 助手只实现截图、窗口列表、AX 树；GUI 工具全部是 READ（但带「数据外发」风险事实）。
- **要验证的问题**：模型能不能看懂我的屏幕 —— 读出窗口内容、指出某个按钮在哪（只报坐标不点击）。
  在不产生任何副作用的前提下，把定位精度量出来。

### 阶段 1c：受控操作（本机）

- **做什么**：只放开一个白名单应用（例如文本编辑、备忘录、计算器），前台模式，逐次或按应用审批；
  执行前复核、遇错即停、自我审批防护、拒绝安全输入。
- **要验证的问题**：人工审批作为唯一边界，能不能既好用、又不说假话（TOCTOU）？

### 后续（不在第一阶段）

后台操作、更多应用分级、规划与定位分离（如果 deepseek-flash 定位不足）、
虚拟机隔离（如果将来换 Apple Silicon）、多显示器。

### 判据原则（沿用仓内教训）

- **`verify:*` 不碰真实桌面。** 做一个**假的显示驱动**：渲染确定性的合成界面、记录收到的动作 ——
  与 `verify:mcp` 用手写的假 MCP 服务器同理。真机只在 live 探针里跑。
- **夹具的缩放因子必须是 2。** 缩放因子是 1 时逻辑点等于像素，漏掉一次「÷2」不会有任何征兆 ——
  正是「夹具让正确值与错误值恰好相等」那条教训。
- **合成截图的尺寸不能是 1000×1000，也不能等于目标图像尺寸**，否则漏掉一次缩放同样看不出来。
- **每加一条判据，做一次注入实测**：把反算改错、把复核摘掉、把「遇错即停」改回「继续」，判据都必须翻红。

---

## 8. 待决策清单

| 编号 | 问题 | 候选 | 影响 |
|---|---|---|---|
| 【议】CU-1 | 图像能否进入模型轨道 | 新增「模型可见图像」类（推翻「二进制不进模型」）／维持现状（等于不做 computer use） | 需要 ADR；`verify:resource` D 段要拆成两类断言 |
| 【议】CU-2 | 截图放在哪 | tool_result 内／尾随 user 块／按端点声明二选一 | **P-1 已回答**：tool_result 内两端点都支持；尾随 image 块在百炼被静默丢弃 |
| 【议】CU-3 | 坐标反算放在哪 | 工具层（DisplaySpec 随 RunSpec 冻结）／形状适配器 | 放适配器就要让适配器认识工具参数，违反分层 |
| 【议】CU-4 | 审批粒度 | 逐次／按应用、按 Run／按计划（CaMeL 式） | 按应用即 lease，要重开 ADR-0005 |
| 【议】CU-5 | 与执行特权轴的关系 | SANDBOXED 只读、UNRESTRICTED 可操作／新增独立轴 | 修改 ADR-0012 |
| 【议】CU-6 | 驱动形态 | 自建 Swift 助手／Peekaboo／其他 | 依赖基线；新增编译与签名流程 |
| 【议】CU-7 | TCC 授权主体 | 独立 .app／终端／disclaim 子进程 | 授权范围与用户的心智模型 |
| 【议】CU-8 | 模型审计里的截图 | 全量 base64／按哈希去重／不落盘 | 审计体积与隐私 |
| 【议】CU-9 | GUI 任务的完成判定 | 默认 COMPLETED_WITH_LIMITS／引入 GUI 核实／维持现状 | 碰 S5-7（通用 Completion Gate） |
| 【议】CU-10 | 定位不足时，是否允许「工具内调用模型」 | 允许（规划与定位分离）／不允许 | 新模式：工具里的模型调用怎么进预算与审计。**阶段 0：推荐配置下两个模型都够用，第一阶段可以不做** |
| 【议】CU-11 | AUTO 档下能否操作本机 GUI | 允许／禁止／仅限白名单应用 | AUTO ＋ 本机 = 没有任何闸门 |

---

## 9. 代价与风险（一条都不许假装没有）

1. **没有隔离层**：一次误点就是真实后果（删邮件、发消息、改设置）。
2. **提示注入**：屏幕上的任何文字都可能是指令；两个目标端点都没宣称对截图做注入检测；文献表明提示词防御无效。
3. **隐私外发**：截图会发往 DeepSeek / 百炼。窗口级截图只能减少，不能消除。
4. **护栏被绕过**：凭证读禁与私网拒绝在 GUI 面前不成立（见 5.12）。
5. **抢占桌面**：前台模式下用户不能同时使用电脑；用户的输入会和 agent 的动作交错。
6. **授权弹窗**：录屏授权按月重新确认，可能打断无人值守的任务。
7. **平台寿命**：这台 Intel 机器停在 Tahoe，只剩安全更新。不要依赖 macOS 27 才有的能力，也不要依赖私有 API。
8. **成本与时延**：步数多、上下文长、每步越来越慢。
9. **判据覆盖有限**：判据只能覆盖确定性的部分；模型定位精度和真实应用的行为，只能靠 live 探针与评测。
10. **新的编译步骤**：Swift 助手需要编译与签名，打破「`tsx` 直接跑、无构建步骤」的现状；签名身份不稳定会让 TCC 授权反复失效。

---

## 10. 阶段 0 实测结果（2026-10-03）

代码、复现命令与原始证据：`spikes/s1-computer-use-vision/`（README 里有完整表格）。
约 290 次真实调用；百炼 141 次约 0.41 元，DeepSeek 147 次（单价未核实，量级同样很小）。
全部用合成界面（系统字体渲染、随机假词标签），不截用户的真实屏幕。

### 10.1 回答了哪些【验】

| 问题 | deepseek-flash | qwen3.8-flash |
|---|---|---|
| 截图放进 `tool_result` | ✅ 4/4 | ✅ 4/4（文档只定义了字符串，实际支持） |
| `tool_result` 之后再跟 image 块 | ✅ 4/4 | ❌ **HTTP 200 静默丢图** 0/4 |
| `tool_result` 之后跟文字块 | ✅ | ✅（Atlas 现有的插话与 SYSTEM_NOTICE 不受影响） |
| 1280×800 截图的计费 | ≈642 token | ≈1002 token |
| 服务端缩放封顶 | ≈962 token（约 1792×1120 起） | ≈2562 token（约 2560×1600 起） |
| `count_tokens` 算不算图 | 算，且与计费一致 | **不算**（带图只多 3 token，实际多 1000） |
| 不说明单位时的坐标习惯 | 像素；**大图时用的是服务端缩小后的帧**（客户端无从得知） | 0–1000 归一化 |
| 明确要求归一化 | 照做 | 照做 |
| 明确要求像素（工具描述里写明） | 照做 | **不照做**，仍输出归一化 |
| 推荐配置的定位命中（JSON 形态） | 52/60（≥1792 时 39/40） | 59/60 |
| 工具调用形态命中（归一化，1792×1120） | 8/10 | 10/10（关闭思考） |
| 小字可读性（≥1792×1120 发送） | 9–15 pt 全对 | 9–15 pt 全对 |
| 1280×800 上的小字 | 9 pt 错 1（自信读错） | 9、11 pt 各错 1（自信读错） |
| 默认思考的代价 | JSON 形态下 14/24 次把 8192 输出额度烧光、零作答 | 3/24 次 |
| 关闭思考参数 | 接受 | 接受 |

### 10.2 由此确定的工程选择（仍需在阶段 1a 以 ADR 落定）

1. **截图一律放进 `tool_result`**。这是两端点唯一都可靠的放法；「尾随 image 块」必须在端点声明里标成 `SILENTLY_DROPPED`（百炼），不能作为通用形态。
2. **坐标一律用 0–1000 归一化**。它对两个模型都最准，而且不受服务端缩放影响 ——
   第 0 节第 5 条担心的「客户端不知道模型看到的图有多大」被这个选择整体绕开。
   反算只剩一步：归一化坐标 → 逻辑点（× 1792/1000、× 1120/1000）。
3. **发送尺寸 1792×1120**（恰好等于本机的逻辑点尺寸）：DeepSeek 在这个尺寸上最准（低于它，图片额度没用满）；两个模型的小字都能读对；放大不是必需品。
4. **GUI 任务的思考设置是一项端点数据**：qwen 关闭思考最准；DeepSeek 在工具调用形态下默认思考正常、在自由 JSON 形态下会烧光额度。Atlas 目前不发送任何思考参数，需要新增「按任务类型配置思考」的能力。
5. **上下文预算不能依赖百炼的 `count_tokens`**：它对图片计 0。图片 token 要按端点声明里的公式本地估算（百炼 ≈ 像素数 / 1024，封顶 2562；DeepSeek 封顶 962）。

### 10.3 被实测修正的判断

| 调研时的说法 | 实测 |
|---|---|
| 「最可能的放法是 tool_result 之后追加 image 块」 | 在百炼上恰好是静默丢图的那种 |
| 「坐标约定要靠探针确定是像素还是归一化」 | 不只是「确定」：qwen 会**无视**像素声明，所以约定只能选归一化，否则是静默的系统性偏移 |
| 「deepseek-flash 定位能力未知，可能需要规划/定位分离」（【议】CU-10） | 在推荐配置下 39/40（≥1792），第一阶段**不需要**额外的定位模型 |
| 「可能需要局部放大（zoom）」 | 发送 ≥1792×1120 时 9 pt 以上全部读对；zoom 降为可选 |

### 10.4 仍未回答的

- 真实应用（暗色模式、密集表格、无文字图标、Electron 应用）上的定位与可读性；
- 多步任务：截图保留策略、错误恢复、长上下文下的退化；
- `output_config.effort` 对定位的影响；
- 两个模型对屏幕上提示注入的抵抗力（OS-Harm / 弹窗攻击那一类）。

---

## 11. 参考资料

**官方文档**

- [Anthropic：Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Anthropic：Best practices for computer and browser use](https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude)
- [Anthropic：computer-use-demo](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo)
- [OpenAI：Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Google：Gemini Computer use](https://ai.google.dev/gemini-api/docs/computer-use)
- [百炼：用多模态模型实现 UI 交互自动化](https://help.aliyun.com/zh/model-studio/gui-automation)
- [百炼：GUI-Plus API 参考](https://help.aliyun.com/zh/model-studio/gui-plus-interface-interaction-model)
- [百炼：Anthropic 兼容 Messages](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)
- [百炼：qwen3.8-flash 模型信息](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)
- [DeepSeek：Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/)
- [DeepSeek：Vision](https://api-docs.deepseek.com/guides/vision/)
- [Playwright MCP：Vision mode](https://playwright.dev/mcp/vision-mode)
- [Claude Code：Desktop（computer use 应用分级）](https://code.claude.com/docs/en/desktop)
- [Qwen3-VL：agent_function_call.py](https://github.com/QwenLM/Qwen3-VL/blob/main/cookbooks/utils/agent_function_call.py)

**开源项目**

- [trycua/cua](https://github.com/trycua/cua) · [cua#2688（x86_64 崩溃）](https://github.com/trycua/cua/issues/2688) · [macOS 窗口内部机制](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)
- [Peekaboo](https://github.com/openclaw/Peekaboo)
- [macos-computer-use-kit](https://github.com/Sur-Cai/macos-computer-use-kit)
- [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop)
- [Agent S](https://github.com/simular-ai/Agent-S)
- [Microsoft UFO](https://github.com/microsoft/UFO)
- [disclaim](https://github.com/torarnv/disclaim)
- [nut.js：I'm giving up — on open source](https://nutjs.dev/blog/i-give-up)

**论文：基准、模型与系统**

- [OSWorld（NeurIPS 2024）](https://proceedings.neurips.cc/paper_files/paper/2024/file/5d413e48f84dc61244b6be550f1cd8f5-Paper-Datasets_and_Benchmarks_Track.pdf)
- [OSWorld-Human](https://arxiv.org/abs/2506.16042) · [OSWorld 2.0](https://arxiv.org/pdf/2606.29537)
- [How Benchmarks Mis-Score Computer-Use Agents](https://arxiv.org/abs/2607.28367)
- [The Art of Building Verifiers for Computer Use Agents](https://arxiv.org/abs/2604.06240)
- [Qwen-UI-Agent](https://arxiv.org/abs/2607.28227)（[项目页](https://tongyi-mai.github.io/Qwen-UI-Agent/)）
- [Agent S3 / bBoN](https://arxiv.org/abs/2510.02250) · [UFO2](https://arxiv.org/abs/2504.14603) · [UI-TARS-2](https://arxiv.org/abs/2509.02544) · [UI-Venus-2](https://arxiv.org/abs/2609.00028)
- [ScreenSpot-Pro](https://arxiv.org/abs/2504.07981) · [GroundCUA](https://arxiv.org/abs/2511.07332)
- [Agent-Computer Observation Interfaces](https://arxiv.org/abs/2606.29472)
- 综述：[Agents for Computer Use](https://arxiv.org/abs/2501.16150) · [JARVIS or Ultron?（安全）](https://arxiv.org/abs/2505.10924) · [Securing Computer-Use Agents](https://arxiv.org/abs/2605.07110) · [Efficient GUI Agents](https://arxiv.org/abs/2609.02309)

**论文：安全与恢复**

- [Attacking VLM Computer Agents via Pop-ups](https://arxiv.org/abs/2411.02391) · [VPI-Bench](https://arxiv.org/abs/2506.02456) · [OS-Harm](https://arxiv.org/abs/2506.14866) · [StepJack](https://arxiv.org/abs/2608.06477)
- [TOCTOU Attacks on Computer-Use Agents](https://arxiv.org/abs/2604.18860) · [CaMeLs Can Use Computers Too](https://arxiv.org/abs/2601.09923)
- [ACRFence](https://arxiv.org/abs/2603.20625) · [Safe to Resume?](https://arxiv.org/abs/2608.29381) · [Recoverability as a System Primitive](https://arxiv.org/pdf/2609.13672) · [Atomix](https://arxiv.org/abs/2602.14849) · [TClone](https://arxiv.org/abs/2605.17320) · [Crab](https://arxiv.org/abs/2604.28138)

**macOS 平台**

- [Eclectic Light：Permissions, privacy and TCC](https://eclecticlight.co/2025/11/08/explainer-permissions-privacy-and-tcc/)
- [Qt：The Curious Case of the Responsible Process](https://www.qt.io/blog/the-curious-case-of-the-responsible-process)
- [9to5Mac：Sequoia 录屏授权按月确认](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/) · [Tahoe 上反复出现的录屏授权弹窗](https://beekeepers.beyondtrust.com/general-45/beyondtrust-remote-support-customer-client-repeated-screen-capture-permission-pop-ups-on-macos-tahoe-7998)
- [Tahoe 是最后一个支持 Intel 的版本](https://www.thurrott.com/apple/321965/macos-26-tahoe-will-be-the-last-release-to-support-intel-based-macs) · [Intel 机型的安全更新期限](https://www.heise.de/en/news/macOS-Apple-announces-Intel-security-update-duration-11328845.html)
- [Apple 对 macOS 虚拟机数量的限制](https://eclecticlight.co/2022/08/04/virtualisation-on-apple-silicon-macs-8-how-apple-limits-vms/)
- [CoreGraphics 在野利用漏洞（26.7.1 修复）](https://www.techtimes.com/articles/328261/20260930/apple-patches-exploited-coregraphics-zero-day-macos-tahoe-sequoia.htm)

**排行榜**

- [ScreenSpot-Pro（BenchLM）](https://benchlm.ai/benchmarks/screenspot-pro) · [Pointer：OSWorld-Verified SOTA](https://www.pointer.ai/blog/sota)
