# Atlas 集成 Computer Use：未提交代码评审报告

> 评审日期：2026-10-03（Asia/Shanghai）  
> 评审者：Codex  
> 代码基线：`32827b9` 之上的未提交改动，包含未跟踪的新文件  
> 参考记录：[2026-10-03-Atlas集成ComputerUse.md](../../changelog/2026-10-03-Atlas集成ComputerUse.md)  
> 评审约束：仅评审，不修改任何文件或代码；本报告在评审完成后，经用户明确要求单独整理保存。

## 1. 评审结论

本次发现 **12 个需要处理的问题：4 个 P1、7 个 P2、1 个 P3**。建议先处理前 4 项，再把这批实现视为完成集成。

主要问题集中在审批目标绑定、取消后的副作用、截图与动作之间的观察基线，以及截图白名单的实现方式。现有类型检查、边界检查和集成记录中的成功运行，不能覆盖这些路径。

本报告保留前一轮聊天中已经给出的评审结论、复现证据与验证边界，不代表问题已经修复。文件行号对应本次评审时的未提交版本，后续修改可能使行号移动。

| 编号 | 级别 | 问题 | 本次证据 |
|---|---|---|---|
| CU-R01 | P1 | 键盘执行目标没有绑定审批目标，人工审批改变焦点后输入失败或改发其他应用 | 真实 handler＋假驱动内存复现、入口调用链检查 |
| CU-R02 | P1 | 取消发生在执行前复核期间，尚未投递的动作仍继续投递 | 完整 Runtime＋假驱动内存复现 |
| CU-R03 | P1 | 同批截图替换模型已见观察，使旧图动作通过新图复核 | 完整 Runtime 配对内存复现 |
| CU-R04 | P1 | 固定窗口排除列表可能漏过截图前新出现的非白名单窗口 | 源代码＋本地 ScreenCaptureKit SDK 契约；未现场触发 |
| CU-R05 | P2 | 拖拽终点缺少画面复核 | 真实 handler＋假驱动内存复现 |
| CU-R06 | P2 | `vision` 配置未纳入 resume 端点行为指纹 | 真实一致性检查函数内存复现 |
| CU-R07 | P2 | 助手重连保留旧协议缓冲区，吞掉首个新响应 | 真实解析器内存复现 |
| CU-R08 | P2 | CLI 助手构建失败绕过 MCP 与 stdin 清理 | 真实 `main()` 源码内存转译＋依赖替身配对验证 |
| CU-R09 | P2 | 应用启动超时仍报告激活成功 | 静态控制流确认；未启动真实应用 |
| CU-R10 | P2 | CLI 长文本输入审批只能看到前 200 个字符 | 审批生成、CLI 渲染及 Web 展示调用链检查 |
| CU-R11 | P2 | P6 真实屏幕探针会把截图复制进未忽略的仓库目录 | 源码调用链＋合成字节内存探针 |
| CU-R12 | P3 | 干净 checkout 缺少 `.bin`，合成图探针首次编译失败 | 源码、忽略规则及运行说明检查 |

## 2. 评审范围与执行边界

覆盖本批未提交的生产代码、相关验收代码和新增探针源码，包括：

- Runtime 图像资源、上下文装载、token 计数、模型审计、批处理、预算与恢复逻辑。
- `tools/computer` 工具定义、白名单、审批描述、执行前复核、驱动协议及 Swift 助手。
- CLI、Web service、UI 审批流程及 MCP 声明变化。
- 相关端点配置、验收脚本、Spike 1 探针源码与集成记录。

原评审阶段没有修改任何文件或代码。评审前后记录的 **142 个未提交文件内容指纹完全一致**，没有新增文件。本次经用户授权新增的仅为这份评审文档。

没有构建或启动 GUI 助手，没有触发系统授权，没有操作真实桌面，没有调用真实模型端点，也没有打开或输出真实屏幕截图。内存探针使用现有假驱动、脚本模型、内存 SQLite 或内存转译的真实实现；未把探针脚本保存到仓库。

## 3. 详细问题

### CU-R01 · [P1] 键盘输入没有绑定审批时的目标应用

**定位**：

- [tools/computer/src/handler.ts](../../../tools/computer/src/handler.ts)：320–349 行。
- [tools/computer/src/approval.ts](../../../tools/computer/src/approval.ts)：81–90 行。

**问题与触发条件**：

审批展示的是审批生成时的前台应用，执行时却重新读取前台应用，并直接使用新的 PID。审批信息没有把目标应用身份绑定到后续执行。

**内存复现结果**：

```text
screenshot
describeForApproval(type "test") → "type → TextEdit"
frontmost = Calculator
execute(type "test") → ok: true
performed = [{ kind: "type", text: "test", pid: 502 }]
```

已批准发给 TextEdit 的输入，被投递给另一个白名单应用 Calculator。

这也影响正常人工审批：CLI 用户切回终端输入确认，Web 用户切到浏览器点击批准，都会改变前台。终端和浏览器属于硬拒绝应用，批准后的 `type/key` 因此会被拒绝。把前台改为 Chrome 的探针确实得到 `TOOL_GUI_TARGET_DENIED`。

**影响**：审批看到的目标与真正执行的目标可以不同；正常 CONFIRM/DEFAULT 使用流程也会被自身审批交互阻断。集成记录中的真实运行使用 AUTO，现有 Web 审批验收主要验证点击，没有覆盖这种焦点变化。

**修复方向**：绑定审批时的预期应用/PID及必要的焦点身份，并明确处理审批界面与目标应用之间的焦点切换；不能在执行时重新选择任意当前前台应用。

### CU-R02 · [P1] 取消请求后仍开始投递 GUI 动作

**定位**：[tools/computer/src/handler.ts](../../../tools/computer/src/handler.ts)：214–251 行，共同投递点 402–405 行。

**问题与触发条件**：

`ctx.signal` 只用于等待动作和动作投递后的等待，没有在权限检查、画面复核等异步操作完成后、实际投递前再次检查；驱动投递也没有接收取消信号。

**完整 Runtime 内存复现结果**：

在假驱动 `probe()` 返回前调用 `runtime.cancel(runId)`，得到以下时间线：

```text
probe resolved / cancel requested
perform after cancel request
AttemptCompleted { status: "SUCCEEDED", sideEffectState: "APPLIED" }
terminal { reason: "ABORTED_TOOLS" }
```

**影响与表述边界**：证明的是“取消请求之后，仍开始执行本来尚未发生的副作用”，不是“数据库已经落成 CANCELLED 后才投递”。Runtime 会等待 handler 返回，再结算取消。步骤超时也只能在 handler 返回后修正结算，无法阻止这段后续投递。

**修复方向**：在所有异步等待后的副作用边界重新检查中断状态，并将中断传播到驱动请求和投递层。

### CU-R03 · [P1] 同批截图替换模型已见观察，绕过旧画面检查

**定位**：[tools/computer/src/handler.ts](../../../tools/computer/src/handler.ts)：124–133 行；动作读取和复核发生在 193、214 行附近。

**问题与触发条件**：

`screenshot` 一完成就无条件更新 `observations`，同批后续点击立即使用这张新图作复核依据。但模型在生成整批调用时尚未看到新图，点击参数仍来自旧画面。

**完整 Runtime 配对内存复现结果**：

共同前提：首轮截图把 TextEdit（窗口 ID 11）交给模型；第二轮模型调用前，屏幕换成同在白名单内的 Calculator（窗口 ID 22）；两组点击参数均为 `left_click(x=100, y=100)`。

| 第二轮工具批 | 结果 | 投递记录 |
|---|---|---|
| `[click]` | `TOOL_GUI_STATE_CHANGED`、`NOT_STARTED` | 零投递 |
| `[screenshot, click]` | 点击成功，`target.app = "Calculator"` | 投递一次点击 |

第二组截图尚未交给模型时，点击参数已经在同一模型响应内固定。因此新截图把复核基线从 TextEdit 换成 Calculator，使按旧图生成的动作通过了新图检查。

**修复方向**：将动作复核基线绑定到生成该调用时模型已经收到的观察，或阻止同批动作使用尚未交给模型的新截图。

### CU-R04 · [P1] 固定窗口排除列表漏过枚举后新出现的窗口

**定位**：[tools/computer/helper/AtlasGUIHelper.swift](../../../tools/computer/helper/AtlasGUIHelper.swift)：248–262 行，关键过滤器构造在 253–254 行。

**问题与触发条件**：

当前先异步获取窗口列表，再把当时所有非白名单窗口传给 `SCContentFilter(display:excludingWindows:)`，之后异步执行截图。列表生成后新出现的非白名单窗口或通知，没有进入这个固定排除集合。

本地 ScreenCaptureKit SDK 的 `SCStream.h` 第 149–154 行明确：该过滤器捕获整个显示器，仅排除传入的窗口。核对的本地文件为：

```text
/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/SCStream.h
```

**影响**：新出现的非白名单内容仍可能进入截图，并作为模型可见 `image` 资源发送。这与“其他应用、桌面与通知不会进图”的保证不一致。

**证据边界**：源代码与本地 SDK 契约确认；未通过真实桌面现场触发，也没有采集或外发截图来验证。

**修复方向**：采用能够持续限定允许内容的采集方式，或增加采集后的可靠过滤，不能把一次窗口枚举形成的排除表当作持续成立的应用白名单。

### CU-R05 · [P2] 拖拽终点没有画面复核

**定位**：[tools/computer/src/handler.ts](../../../tools/computer/src/handler.ts)：224–227 行。

起点调用完整的 `checkTarget()`，终点却只调用 `probe({ x, y })`，既不提供 `screenshotId/radiusPt`，也不检查区域差异，只核对窗口身份与白名单。

**内存复现结果**：起点区域差为 0、终点区域差为 200、窗口身份保持不变，拖拽仍返回成功并投递。实际复核请求为：

```json
[
  { "x": 153.6, "y": 96, "screenshotId": "shot_1", "radiusPt": 24 },
  { "x": 1382.4, "y": 96 }
]
```

**影响**：页面滚动、列表重排等变化能把释放点换成另一目标，却不会触发工具描述承诺的画面变化拒绝。

**修复方向**：拖拽终点经过与起点相同的完整画面复核。

### CU-R06 · [P2] `vision` 未纳入 resume 端点一致性检查

**定位**：[packages/harness-runtime/src/model/capability/profile-loader.ts](../../../packages/harness-runtime/src/model/capability/profile-loader.ts)：225–234 行。

`behaviorFingerprint()` 仍然只计算 `protocol/context/tokens/errors/limits`，遗漏本批新增的 `vision`。图像 token 公式或 `countTokensIncludesImages` 变化，不会被恢复检查发现；这些字段也不在 GUI 工具版本摘要内。

**内存复现结果**：直接调用真实 `assertResumeEndpointMatches()`，修改视觉计数配置后仍然允许恢复。探针还确认移除 `vision` 不会被该函数识别；实际 GUI 装配另有 vision 必需检查，因此主要影响场景是修改计数公式等仍可合法装配的字段。

**影响**：后续编译上下文使用当前 protocol 的视觉配置，旧 Run 会静默换用新的图像计数规则，违反恢复使用启动时冻结行为的约束。

**修复方向**：把 `vision` 纳入端点行为指纹，并覆盖只改变视觉计数字段的恢复一致性判据。

### CU-R07 · [P2] 助手重连保留旧协议缓冲区

**定位**：[tools/computer/src/helper-driver.ts](../../../tools/computer/src/helper-driver.ts)：165–172 行；解析消费点为 176–186 行。

连接关闭时清理了 `pending`，却没有清空 `this.buffer`。助手在传输较大的截图 JSON 中途退出后，残留的半条 JSON 会与重连后的第一条完整响应拼接，解析失败后整行被丢弃。

**内存复现结果**：向真实解析器注入截断的截图响应，再模拟重连后的完整 `permissions` 响应，最终得到：

```text
GUI 助手请求 permissions 超时
```

生产默认会额外等待 30 秒。该探针使用真实源码的内存转译版本与假 socket，没有创建真实 socket 或助手进程。

**修复方向**：解析缓冲区随连接生命周期重置，避免混合两代连接的数据。

### CU-R08 · [P2] CLI 助手构建失败绕过资源清理

**定位**：[apps/cli/src/main.ts](../../../apps/cli/src/main.ts)：773–777 行。

`ensureHelperBuilt()` 位于 MCP 连接成功之后，却在清理钩子及 `try/finally` 之前。首次使用时缺少编译器、Swift 编译失败或签名失败，异常会直接进入最外层 catch；那里只设置退出码，已建立的 MCP 连接和交互 stdin 仍存活，可能令命令挂住。

**内存配对验证结果**：

```text
助手构建失败：MCP connected=1 / closed=0，stdin closed=0，exit hooks=0
后续 compose 失败：MCP closed=1，stdin closed=1，helper closed=1，exit hooks=2
```

探针从真实 `main()` 源码提取函数并在内存转译，外部依赖替换为计数 fake，没有真正构建助手或启动 MCP。

**修复方向**：把构建步骤纳入已取得资源的清理范围。服务入口已有对应失败清理，CLI 需要一致处理。

### CU-R09 · [P2] 应用启动超时仍报告激活成功

**定位**：[tools/computer/helper/AtlasGUIHelper.swift](../../../tools/computer/helper/AtlasGUIHelper.swift)：508–511 行。

`sem.wait(timeout: .now() + 10)` 的返回值被丢弃。完成回调尚未执行时，`box.value == nil` 被当作“没有错误”，随后直接返回成功，TS 层记录 `APPLIED` 并告诉模型“已切到前台”。

**影响**：慢启动或卡住的应用会被错误结算，后续批内动作还可能继续作用于原前台应用。

**证据边界**：静态控制流确认，未启动真实应用验证。

**修复方向**：区分“回调已成功完成”和“等待超时、结果未确认”，超时不能进入成功分支。

### CU-R10 · [P2] CLI 长文本审批缺少全文

**定位**：[tools/computer/src/approval.ts](../../../tools/computer/src/approval.ts)：86 行。

`type` 允许最多 2,000 个字符，审批却只展示 `text.slice(0, 200)`。CLI 的 GUI 审批分支只打印这些 details，普通动作展示也没有补出全文。用户无法核对剩余内容，批准后却全部输入。

**影响边界**：主要结论针对 CLI。Web 审批卡自身同样只展示截断文本，但 Web 通用时间线的“入参与结果”折叠区仍能看到完整输入，不能说 Web 整个界面都没有全文。

**修复方向**：提供完整、可审查的输入内容，或把操作限制在已经展示并批准的内容内。

### CU-R11 · [P2] P6 真实屏幕探针将截图复制进仓库

**定位**：

- [spikes/s1-computer-use-vision/src/probes/p6-real-screen.ts](../../../spikes/s1-computer-use-vision/src/probes/p6-real-screen.ts)：91 行。
- [spikes/s1-computer-use-vision/src/harness.ts](../../../spikes/s1-computer-use-vision/src/harness.ts)：85–88 行。

P6 文件头明确承诺“截图不进仓库，证据只记坐标与命中”，但真实截图传给 `imageBlock(png)` 后，该函数会写入 `raw/images/<hash>.png`。该目录没有被根目录或 spike 的忽略规则排除。

**影响**：删除 `/tmp` 原图不会清除这份副本，后续正常添加文件到 Git 就可能把屏幕内容带进提交。对含真实桌面内容的探针而言，“JSONL 不存 base64”不能替代“不持久化真实截图”。

**证据**：源码调用链及使用合成字节的内存探针均确认写入行为。本次没有打开、输出或分析真实截图，也未让探针实际写入文件。

**修复方向**：真实屏幕探针使用只编码、不归档的图像路径；若确有留存需求，应单独明确其目录、忽略规则和保留范围。

### CU-R12 · [P3] 干净 checkout 无法首次构建合成图 renderer

**定位**：[spikes/s1-computer-use-vision/src/scenes.ts](../../../spikes/s1-computer-use-vision/src/scenes.ts)：62–66 行。

`ensureRenderer()` 发现 `.bin/render` 不存在后，直接让 `swiftc` 输出到该路径，没有先创建 `.bin`。而 `.bin/` 被忽略，干净 checkout 不会带这个目录，首次运行相关探针会因输出目录不存在而失败。

已有本地构建目录会掩盖这个问题。此项影响一次性探针的可重跑性，不影响已经构建好助手的生产入口。

**修复方向**：编译 renderer 前创建输出目录。

## 4. 本次实际验证结果

| 检查 | 结果 | 边界 |
|---|---|---|
| `npm run typecheck` | 通过 | `--noEmit`，没有输出构建文件 |
| `git diff --check` | 通过 | 仅检查差异格式 |
| 仓库现有 `BOUNDARIES` / `grepBoundary` | 16 条全部通过 | 直接调用现有检查函数，保留注释过滤；没有手写替代 grep，也没有运行整套会写文件的验收 |
| 关键路径内存探针 | 复现结果见各问题 | 真实实现＋假驱动／内存 SQLite／内存转译；未调用真实模型或 GUI |
| 原评审前后内容指纹 | 142 个未提交文件一致 | 原评审没有新增、修改文件；不包括之后经授权新增的本报告 |

没有复跑 `verify:all`、`verify:computer` 或完整 `verify:tools`。这些脚本会创建文件，其中部分判别力验证还会向仓库写入临时源码，与原评审“任何文件都不改”的要求冲突。

因此，集成记录里的 44 条验收、全量回归和既有 `verify:resource` 失败，均未被当作本次重新验证的结果。内存探针不是对真实桌面、系统授权、ScreenCaptureKit 行为或真实模型端点的全面验收。

## 5. 未重复计入本次问题的已知限制

以下事项已在集成记录中明确接受或登记，没有重复作为本次新发现：

- 缺少任务级完成判定，模型未完成任务仍可能结算 `SUCCESS`。
- 成功的 GUI 动作不清零连续失败计数。
- 相同混合动作／截图批仍可能被判 `NO_PROGRESS`。
- 只支持单显示器、前台模式。
- Web 入口刻意不提供放开浏览器的能力。
- 助手 ad-hoc 签名及重建后的系统授权问题。
- 记录中说明的既有 `verify:resource` 失败；本次未独立复核其基线归属。

## 6. 后续验证建议

修复后的验收应优先覆盖本报告中的成对路径：审批目标不变／改变、复核期间不中断／取消、仅点击／同批先截图再点击、拖拽终点画面不变／改变、视觉配置不变／仅修改视觉计数规则、完整响应／截断后重连，以及助手构建成功／失败。

这些是后续修复时应补充的验证方向，本次没有新增验收脚本，也没有执行修改实现的故障注入。真实桌面与系统 API 项仍需要在明确授权的条件下补充现场验证。
