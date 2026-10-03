# Atlas 集成 Computer Use（本机 macOS）—— 实施方案、改动点与 Bugfix 记录

> 日期：2026-10-03 · 代码基线：`32827b9`（改动均未提交）
> 目标机器：MacBook Pro 16" 2019 · Intel x86_64 · macOS Tahoe 26.6 · 单屏 1792×1120 pt（缩放 2×）
> 目标模型：`qwen3.8-flash`（百炼 Anthropic 形状）、`deepseek-flash`（DeepSeek Anthropic 形状），以根 `.env` 为准
> 相关决策：[ADR-0013](../ADR/历史归档/0013-本机-computer-use-图像进模型轨道与自建-Swift-助手.md) ·
> [ADR-0014](../ADR/历史归档/0014-观察过期不计失败与只读外部状态不判打转.md) ·
> [ADR-0015](../ADR/历史归档/0015-浏览器可在CLI入口显式放开给GUI操作.md)
> 调研与探针：[ComputerUse技术方案调研.md](../WorkAgent调研/ComputerUse技术方案调研.md) · `spikes/s1-computer-use-vision/`

---

## 0. 一页摘要

**做成了什么**：Atlas 现在能在本机 macOS 上「看屏幕、点屏幕、打字」。两个真实端到端任务在真实桌面 × 真实模型端点上跑通，
并都用独立截图核对过结果：

| 任务 | Run | 结果 |
|---|---|---|
| 计算器点按钮算 37×24，再在文本编辑新建文档写入结果 | `run_800091ccaf65` | ✅ 读出 888；「未命名 2」里是「37 × 24 = 888」 |
| 打开 Google Chrome → 访问 bilibili.com → 主搜索框搜「agent开发面试」 | `run_536c62856c99` | ✅ 到达 `search.bilibili.com/all?keyword=agent开发面试…`，前三条与截图一致 |

**怎么做的**（三层，各管一件事）：

```
Runtime（packages/harness-runtime）   图像作为「模型可见资源」进上下文；不认识屏幕
tools/computer（TS，新包）            工具定义、坐标换算、全部判定（白名单 / 窗口身份 / 画面复核 / 安全输入 / 按键拒绝）
Atlas GUI Helper（Swift，新 .app）    只供原语：截图、窗口表、区域比对、投递事件；独立 TCC 授权身份
```

**数字**：新增 TS 约 2000 行（`tools/computer`）＋ Swift 助手 700 行 ＋ 验收脚本 1325 行；修改 36 个既有文件（+1326 / −59）。
新增验收 `verify:computer` **44 条判据**、`verify:budget` +2 条，边界 grep 扩到 **16 条**（第 15 条）。
全量回归除 HEAD 上就存在的 `verify:resource` F 段崩溃外全部通过。运行期依赖仍是 4 个（未新增 npm 依赖）。

**真实运行抓到的 bug 都不是模型的问题**：截图几何（×1.26 缩放加平移）、桌面图标泄露、前台应用状态陈旧 ——
全部在 Swift 助手里，全部是「喂给判定的事实是错的或多的」，合成界面的探针一个都测不出来。

---

## 1. 背景、研究问题与范围

### 1.1 研究问题

> 在一个所有动作的副作用都无从事先判断、观察只有像素的工具域里，Atlas 的声明纪律与事实表还能不能说真话？

### 1.2 第一阶段范围

| 做 | 不做 |
|---|---|
| 本机 macOS、前台模式、单显示器 | 虚拟机隔离（Intel Mac 跑不了 Apple 的 macOS 虚拟机）、后台操作、多显示器 |
| 截图、点击 / 双击 / 右键、拖拽、滚动、输入、按键、切换应用、等待 | 定位模型（规划与定位分离）、任务级完成判定 |
| 应用白名单 ＋ 硬拒绝名单 ＋ 执行前复核 ＋ 逐次审批 | capability lease（ADR-0005 不动） |
| CLI 与 Web 两个入口 | 私有 API（SkyLight） |

---

## 2. 实施路线

| 阶段 | 内容 | 产出 |
|---|---|---|
| 调研 | 行业方案、两个目标模型、macOS 底座（TCC、ScreenCaptureKit、CGEvent、AX）、逐层差距分析 | 调研报告，【议】CU-1…CU-11 |
| 阶段 0 探针 | 约 290 次真实调用：图像放哪（P-1）、定位（P-2 / P-2b）、计费（P-3）、小字（P-5）、思考参数（P-0） | `spikes/s1-computer-use-vision/`，结论回填调研报告 §10 |
| 方案选型 | 用户拍板「自己写 Swift 小程序」 | CU-6 |
| 实现 | Runtime 图像通道 → 端点视觉声明 → tools/computer → Swift 助手 → 两个入口 → 审计脱敏 → 边界 15 | 见 §4 |
| 验收 | 假驱动驱动的 `verify:computer`；每条判据注入实测 | 见 §7 |
| 真桌面实测 ×4 | 前三次各抓到一个助手 bug，第四次端到端通过 | 见 §6 |
| 规则修订 | 用户拍板「执行前核对没通过的拒绝不计失败；只读外部状态的批不按入参判打转」 | ADR-0014 |
| 浏览器 | 用户要求用 GUI 操作本机 Chrome | ADR-0015，Chrome 实测通过 |

---

## 3. 架构与数据流

### 3.1 一次「截图 → 点击」的完整链路

```
模型 ──tool_use: screenshot{}──▶ Runtime ──▶ ComputerToolHandler.screenshot
                                                 │  driver.permissions / resolveApps / capture
                                                 ▼
                                      Atlas GUI Helper（Swift）
                                         ScreenCaptureKit：整块主显示器、只留白名单应用的窗口
                                         返回 png ＋ contentRect ＋ 窗口表 ＋ 前台应用
                                                 │
Runtime ◀── resources:[{kind:"image", png}] ─────┘
  │ settle-batch：落 ResourceStore（kind=image，IMAGE_NOT_REDACTED_SENT_TO_MODEL）
  │ compile：attachLiveImages —— 只装最近几张（3 张、步长 3 成批移出），按端点公式估 token
  │ 形状适配器：图放进 tool_result **之内**（端点声明 vision.imageCarrier）
  ▼
模型 ──tool_use: computer{action:"left_click", x:500, y:250}──▶ Runtime
  │ ComputerEffectResolver：EXECUTE ＋ IRREVERSIBLE ＋ GUI_INPUT_NOT_SANDBOXED
  │ Policy → 审批（describeForApproval：哪个应用 / 窗口 / 控件 / 换算到哪个点）
  ▼
ComputerToolHandler.pointer
  │ toPoints：0–1000 → contentRect 内的逻辑点
  │ checkTarget：① 变没变（窗口身份）② 许不许（白名单 / 硬拒绝）③ 截图仍有效 ④ 区域画面没变
  ▼
Atlas GUI Helper.perform：投递前再判一次硬拒绝 ＋ 白名单（第二道）→ CGEvent
```

### 3.2 三层的职责边界（【定】）

- **判定全在 TS**。判定若写进 Swift，验收脚本只能拿假驱动去模仿它，判据测的就成了假驱动。
- **Swift 只供原语**，但投递前**另外**再判一次硬拒绝名单 —— 与 `run_shell` 两道闸门同构，
  合并成一层的必然写法是「TS 判过了，助手就不用判了」。
- **Runtime 不认识屏幕**。边界 15 守着这条线（见 §4.8）。

---

## 4. 具体改动点（按包 / 文件）

### 4.1 Runtime：图像作为模型可见资源（CU-1 / CU-2 / CU-8）

| 文件 | 改动 |
|---|---|
| `types/resource.ts` | `ResourceKind` 新增 `"image"`；处置标记 `IMAGE_NOT_REDACTED_SENT_TO_MODEL`；`MODEL_IMAGE_MEDIA_TYPES`（PNG / JPEG）；`ModelImage`；`imageDimensions(bytes)` —— **尺寸从字节读，不信工具自报** |
| `types/context.ts` | `ContextFrame.liveImages`；`ContextBudgetPolicy.liveImageLimit / liveImagePruneStep` |
| `budget/index.ts` | 默认活图上限 3、步长 3 |
| `ports/index.ts` | `ResourceStorePort.readImageForModel(ref)` —— 只有 kind=image 才给字节 |
| `context/compile.ts` | `attachLiveImages()`（成帧后、计数前装图，图像 hash 进 item / frame hash）；`liveImageWindowStart()` **成批移出**（逐张移出会每轮改写历史中段，严格前缀缓存每轮失效） |
| `action/settle-batch.ts` | 产物落库的 image 分支；`haltsBatchOnFailure` —— 声明了它的工具失败后，同批剩余调用一律跳过（在**每一条**失败 / 拒绝分支上调用） |
| `types/tool.ts` | `ToolDefinition.haltsBatchOnFailure`、`stateOutsideTranscript`；`EffectScope.kind` 新增 `"GUI"` |
| `facade/index.ts` | resume 时「外部状态核对不了」改由**声明**识别（`stateOutsideTranscript`），不再按 `mcp__` 前缀 |
| `loop/model-audit.ts` ＋ `loop/run-loop.ts` | `omitLiveImageBytes()`：审计里的请求 body **按值**把活图 base64 替换成指回 ResourceStore 的占位（ref ＋ hash ＋ 尺寸）；无图时原样返回同一对象 |
| `types/endpoint.ts` ＋ `model/capability/profile-loader.ts` | `VisionCapability`（imageCarrier / imageTokens 公式 / countTokensIncludesImages / NORMALIZED_1000 / 截图长边）；`parseVision`；`estimateImageTokens()` |

### 4.2 Runtime：ADR-0014 的两条规则

| 文件 | 改动 |
|---|---|
| `types/error.ts` | `Retryability` 新增 `"AFTER_REOBSERVATION"`：观察已过期、**什么都没做**、重新观察再来 |
| `loop/run-loop.ts` | `anyFailed` 豁免 `AFTER_REOBSERVATION` **且** `NOT_STARTED` 的失败（合取：副作用说不清的照常计数）；只影响「+1」，不影响清零条件 |
| `loop/progress-guard.ts` | `ProgressSample.observesExternalState`；全部由「`stateOutsideTranscript` ＋ `isReadOnly`」调用组成的批不判打转、**重置**计数；判定读冻结的工具快照 |

### 4.3 存储、适配器与端点声明

| 文件 | 改动 |
|---|---|
| `store-sqlite/src/resource-store.ts` | image 入库校验（必须是字节、处置标记、媒体类型、能读出尺寸）；`readImageForModel` |
| `adapters/shape-anthropic-messages/src/protocol.ts` | 只有端点声明了 vision 才装图（与 attach 是两道独立的门）；图在 tool_result 内、文字在前；`countTokens` 在端点不计图时补上公式值（降为 ESTIMATED）；本地估算 `estimateTokens` 计图（不把 base64 当字符） |
| `adapters/endpoint-profiles/bailian-anthropic-qwen38flash.json` | `vision`：32px 块 ＋2，79–2562，count_tokens **不**计图，NORMALIZED_1000，长边 1792 |
| `adapters/endpoint-profiles/deepseek-anthropic-flash.json`（新） | deepseek-flash 独立声明（ASSUMED）：40px 块 ＋2，200–962，count_tokens 计图 |
| `apps/cli/src/compose.ts` | 端点选择登记 `deepseek-flash`；`ComposeOptions.computer`（入口给驱动）；没有 vision 声明时**启动即失败**；GUI 工具追加在 MCP 之后；`COMPUTER_USE_PROMPT` 追加到 system prompt |

### 4.4 `tools/computer`（新包 `@workagent/tools-computer`）

| 文件 | 职责与要点 |
|---|---|
| `config.ts` | `--computer off/view/control` ＋ `--computer-apps` 解析（fail-fast）；**硬拒绝名单**（终端、IDE、Agent 宿主、浏览器、凭证与安全）；`hardDeniedReason(app, {allowBrowsers})`；`allowBrowsers` 只解除浏览器一类（ADR-0015） |
| `definitions.ts` | **两个工具**：`screenshot`（READ、幂等、只读）与 `computer`（EXECUTE、非幂等、`haltsBatchOnFailure`、`requiresPreFingerprint` → 崩溃落分支三）；属性全是扁平标量（x / y，不是数组）；description 随配置变；版本带配置摘要（档位、白名单、allowBrowsers、坐标约定、截图尺寸） |
| `resolver.ts` | 截图：READ ＋ `SCREEN_CONTENT_SENT_TO_MODEL_ENDPOINT` ＋ dataMovement；动作：EXECUTE ＋ IRREVERSIBLE（切应用为 REVERSIBLE）＋ `GUI_INPUT_NOT_SANDBOXED`，输入另加 `KEYBOARD_TEXT_INPUT` |
| `handler.ts` | 截图、指针、键盘、切换应用、等待；`toPoints(p, contentRect)`；`checkTarget`：**先问变没变、再问许不许**；过期类拒绝打 `AFTER_REOBSERVATION`；缺授权时关掉助手（下次重拉读到新授权）；驱动抛异常记 UNKNOWN、返回失败记 NOT_STARTED |
| `keys.ts` | 按键名权威清单；拒绝 Spotlight、切换应用、锁屏、注销、强制退出等系统级组合 |
| `approval.ts` | `describeForApproval`：目标应用 / 窗口 / 控件（AX）、坐标换算、依据哪张截图 —— 只打坐标的审批是盲批 |
| `driver.ts` | 驱动接口；坐标一律逻辑点；`CaptureResult.contentRect`（图实际覆盖的区域）；`perform` 的第二道参数含 `allowBrowsers` |
| `helper-build.ts` | `swiftc` ＋ ad-hoc 签名；**源码 hash 不变就不重建**（重建 = 系统当成新程序 = 授权作废） |
| `helper-driver.ts` | `open -n -g -a` 经 LaunchServices 启动（独立 TCC 身份）；0700 私有目录里的 Unix socket；JSON 行协议；懒启动 |
| `index.ts` | `createComputerUse()`；`ComputerVerifier` 一律 SKIPPED（不假装核实过）；启动提示（预算后果、剩余盲区、放开浏览器的红字） |

### 4.5 Atlas GUI Helper（`tools/computer/helper/AtlasGUIHelper.swift` ＋ `Info.plist`）

- `LSUIElement` 代理应用，bundle id `com.workagent.atlas.gui-helper`，授权记在它名下（**不是终端**）；
- 只接受启动它的那个 Atlas 进程的连接（`LOCAL_PEERPID`）；看门狗：Atlas 进程没了就退出；
- 截图：`SCContentFilter(display:excludingWindows:)` —— 列出包括桌面窗口在内的全部窗口，排除一切不属于白名单应用的窗口；
  `sourceRect` 显式为整块显示器；报回 `contentRect`；
- 前台应用：辅助功能的焦点应用（现查），退路是窗口表最上层普通窗口的主人；
- 窗口表（CGWindowList，现查）、区域灰度差（经 contentRect 换算）、AX 控件描述、CGEvent 投递（键盘用 `postToPid`）；
- 投递前第二道：硬拒绝（浏览器一类可被请求里的 `allowBrowsers` 解除）＋ 白名单。

### 4.6 入口

| 文件 | 改动 |
|---|---|
| `apps/cli/src/main.ts` | `--computer` / `--computer-apps` / `--computer-allow-browsers`；构建助手、建驱动、横幅（放开浏览器时红字）；审批提示的 GUI 分支（「不在沙箱内」）；退出时关驱动 |
| `apps/cli/src/computer-helper.ts`（新） | `npm run computer:build` / `computer:doctor`（`--request` 触发授权、`--apps` 看解析、`--screenshot` 实截、`--allow-browsers`）；默认只读、不弹框 |
| `apps/workagent-service/src/main.ts` | `--computer` / `--computer-apps`；驱动跨 workspace 切换复用（与 MCP 同一条生命周期）；**拒绝 `--computer-allow-browsers`**（那里的审批卡片就在浏览器里） |
| `apps/workagent-service/src/run-host.ts` ＋ `human-channels.ts` ＋ `api-types.ts` | 审批卡的 `gui` 字段（summary ＋ details），晚绑定 `describeForApproval`，**剥双向 / 零宽字符**（窗口标题来自别的应用） |
| `apps/workagent-ui/public/app.js` | 审批卡 GUI 分支（只用 textContent，「不在沙箱内」一行） |
| `package.json` / `tsconfig.json` / `package-lock.json` | `computer:build`、`computer:doctor`、`verify:computer`（进 `verify:all`）；路径别名；工作区登记 |

### 4.7 其他既有模块

- `tools/common/src/mech/read-resource.ts`：image 资源只返回元数据（不把旧截图重新塞回上下文）；
- `tools/mcp/src/tool-bridge.ts`：MCP 工具声明 `stateOutsideTranscript: true`（resume 识别由名字改为声明）。

### 4.8 验收与边界

| 文件 | 内容 |
|---|---|
| `apps/cli/src/verify/computer.ts`（新） | 44 条判据，A–O 段（见 §7） |
| `apps/cli/src/verify/fixtures/fake-gui-driver.ts`（新） | 假驱动：只供数据（窗口、几何、前台、安全输入、区域差），真 PNG，记录投递与第二道参数 |
| `apps/cli/src/verify/budget.ts` | I 段：三种（retryability × 副作用）组合，两个合取项各自可触发 |
| `apps/cli/src/verify/boundaries.ts` | **边界 15**：`ComputerDriver / HelperDriver / AtlasGUIHelper / ScreenCaptureKit / CGEvent / AXUIElement / toPoints(` 不得进 Runtime / 适配器 |
| `verify/compact.ts`、`verify/resource.ts` | 假 ResourceStore 补 `readImageForModel` |

### 4.9 文档

ADR-0013 / 0014 / 0015；`README.md`（computer use 一节、18 条验收、边界 16 条、已知限制）；`CLAUDE.md`（当前状态三节、命令、目录、边界）；
调研报告加实现指针；spike README 记录 P-6。

---

## 5. 关键设计决策速查

| 编号 | 决定 | 一句话理由 |
|---|---|---|
| CU-1 | 新增 `ResourceKind:"image"`，只对 PNG / JPEG、尺寸从字节读；MCP 的 image 块仍是 binary | 推翻「二进制一律不进模型」，但只推翻一半；不理解的外部图不假装理解 |
| CU-2 | 图放 tool_result **之内**（端点数据） | 百炼对其后的 image 块 HTTP 200 静默丢图（4/4） |
| CU-3 | 坐标 0–1000 归一化，换算在 tools/computer，经 `contentRect` | qwen 无视「像素坐标」声明；换算依赖显示器几何，不是端点行为 |
| CU-4 | 逐次审批 ＋ 启动时静态白名单（不是 lease） | ADR-0005 不动 |
| CU-5 | `--computer` 与 `--sandbox` 正交，riskFact `GUI_INPUT_NOT_SANDBOXED` | GUI 动作在别的应用进程里生效，沙箱对它不成立 |
| CU-6 / 7 | 自建 Swift 助手、独立 .app、公开 API、前台 | 授权不记在终端名下；判定留在 TS 可测 |
| CU-8 | 审计按值替换图像字节 | 不然一个 60 轮任务写几百兆同样几张截图的副本 |
| CU-9 | 不做完成判定，Verifier 如实 SKIPPED | 再截一张图是模型的观察，不是独立证据 |
| CU-10 | 不引入定位模型 | 阶段 0 与 P-6：推荐配置下两模型都够用 |
| CU-11 | AUTO 档允许，白名单 / 硬拒绝 / 执行前复核仍在 | F 段在「审批一律放行」下证明复核照样拦 |
| ADR-0014 | 观察过期的拒绝不计失败；只读外部状态的批不判打转 | 按「谁错了」与「读不读外部状态」区分，合取 / 声明钉边界 |
| ADR-0015 | 浏览器可在 CLI 显式放开，Web 入口拒绝 | 自我审批的风险只对 Web 入口是字面事实 |

---

## 6. Bugfix 关键点（按发现顺序）

每条按「现象 → 根因 → 修复 → 判据 / 证据」写。前 5 条来自真实桌面运行，合成界面的探针一个都测不出来。

### B1 截图几何错：每一下都点偏（第一次真桌面运行，`run_609acf77238c`）

- **现象**：模型要点计算器的按钮，坐标总落在空白处；连续失败 10/10 撞墙。
- **排查**：先怀疑「思考开关」—— P-6 用同一张真截图 ＋ Atlas 真实工具面重放：qwen 默认思考 **13/14**、关闭思考 **1/14**
  （多数给出畸形 x / y），排除。再对比窗口表与图：计算器在窗口表里是 (446,559) 230×408 pt，在图里是 (318,605) 290×515 px。
- **根因**：macOS 26 上 `SCContentFilter(display:including:apps)` 截的**不是整块显示器**，而是白名单窗口的外接矩形、
  再等比放大（×1.26 加平移）；Atlas 按「图 = 整块显示器」换算。**模型读图是对的，换算是错的，且不报错**。
- **修复**：改用排除式过滤器、`sourceRect` 显式为整块显示器、驱动报回 `contentRect`，`toPoints` 与区域比对一律经它换算。
- **判据**：`verify:computer` E 段用偏移的 contentRect 钉住（注入「忽略区域偏移」翻红）。

### B2 截图报 ScreenCaptureKit `-3811`

- **现象**：白名单应用不在当前桌面（用户的 Claude 窗口在全屏 Space）时截图直接失败。
- **根因**：与 B1 同源 —— 外接矩形为空。
- **修复**：排除式过滤器以显示器为内容区，此时得到空白图（handler 如实提示 `activate_app`），不再是错误；
  TS 侧失败信息也补了「先 activate_app」的出路。

### B3 截图泄露用户桌面上的文件名

- **现象**：修复 B1 后的自检截图里出现了桌面图标（文件夹名、文件名），会被发往模型端点。
- **根因**：「排除其余应用」的过滤器配 `excludingDesktopWindows(true)` 时，桌面图标层不在可共享列表里，也就不会被排除。
- **修复**：按**窗口**排除，桌面窗口一并列入（`excludingDesktopWindows(false)`）：不属于白名单应用的窗口一律排除。
- **证据**：自检截图只剩白名单窗口，菜单栏与桌面图标都不在。

### B4 前台应用状态陈旧：所有键盘输入被拒（第三次运行，`run_73db9f5de54f`）

- **现象**：计算器 6 次真实点击全部成功、读出 888；文本编辑里每一次 `type` / `key` 都被拒：「前台应用是 Claude」。
  每张截图的 `frontmostApp` 也一直是 Claude。
- **根因**：助手跑在 `dispatchMain()` 上，主 run loop 不转，`NSWorkspace.frontmostApplication` 停在第一次被读的那一刻。
  **判定是对的，前台这条事实是旧的**。
- **修复**：改问辅助功能的焦点应用（`kAXFocusedApplicationAttribute`，现查），退路是窗口表最上层普通窗口的主人。
- **证据**：自检中激活计算器 / 文本编辑后前台分别正确报出；第四次运行打字成功。

### B5 `capturedApps` 同病

- **根因**：由 `NSWorkspace.runningApplications` 推出，同样陈旧（助手启动之后才打开的应用看不见）。
- **修复**：改由现查的窗口表推出。

### B6 「连续失败」在 GUI 任务里是累计数（规则修订，ADR-0014）

- **现象**：假驱动夹具里连着造拒绝，第四次就撞墙；默认预算下整个 Run 累计 3 次执行前复核的拒绝就会结束。
- **根因**：连续失败只在「必需验证通过」时清零，GUI 动作没有独立核实；而「屏幕在截图后变了」也被当成了失败。
- **修复**：`AFTER_REOBSERVATION ＋ NOT_STARTED` 的失败不计入；模型自己的错误照常计入。
- **判据**：`verify:computer` N 段五次过期拒绝不撞墙 ＋ 配对三次瞄错撞墙；`verify:budget` I 段两个合取项各自可触发。

### B7 截图轮询被判原地打转（规则修订，ADR-0014）

- **现象**：连截三次（等界面加载）就 `NO_PROGRESS`。
- **根因**：Progress Guard 假设「入参相同 ⇒ 结果相同」，而 `screenshot` 入参恒为空。
- **修复**：全部由只读外部状态调用组成的批不判打转、重置计数；「动作 ＋ 截图」的批照旧判（剩余盲区，提示里写明）。
- **判据**：N 段连截四次完成、点 A / 截图交替完成 ＋ 配对同处滚动三次判打转。

### B8 检查顺序：先问「变没变」，再问「许不许」

- **问题**：截图后冒出一个 Finder 窗口，原来会被记成「模型瞄错了白名单外的窗口」（计入失败）。
- **修复**：`changedSince()` 先于 `targetRefusal()`；拖拽终点同样处理。两种拒绝都不投递，差别只在谁错了。
- **判据**：F 段「截图后才出现的 Finder → STATE_CHANGED；截图时就在的 Finder / Terminal → NOT_ALLOWED / DENIED」。

### B9 判据落在守卫重叠区（本仓第五次）

- **问题**：「端点没有 vision 就一张图都不发」有两道门，端到端判据测的是合取 —— 只摘适配器那道，它照样绿。
- **修复**：补一条直接喂适配器「已带活图的帧」的配对判据，第二道门有了能单独触发它的输入。

### B10 验收夹具：DeepSeek 声明要求推理块

- **现象**：C 段 DeepSeek 那一路跑不到第二帧。
- **根因**：DeepSeek 声明 `VERBATIM_REQUIRED`，脚本化回合没带推理块，帧在发出前被协议校验拦下 —— 夹具问题，不是产品问题。
- **修复**：夹具回合带推理块（真实端点每个回合都会给）。

### B11 清理：`ComputerRuntime.close()` 零消费者

- 驱动生命周期归入口（service 跨 workspace 切换复用同一个驱动），runtime 也能关它的话，切一次目录会关掉别人手里的驱动 → 删除。

### B12 过程教训：被拒的编辑已经落盘

- **经过**：一次被用户中断的命令其实已经改写了 Swift 源码；随后的 `computer:doctor` 触发了重建，用户刚给的授权随之失效。
- **处置**：把源码精确改回 → 确定性重建（同源码、同编译器、ad-hoc 签名）得到与之前逐字节相同的二进制，**原授权当场恢复**。
- **教训**：任何会触发构建的命令之前，先核对源码状态；ad-hoc 签名下授权绑定的是代码 hash。

---

## 7. 验收结果

### 7.1 `verify:computer`（44 条，全程假驱动：不截真屏、不动鼠标、不弹授权框）

| 段 | 内容 |
|---|---|
| A | 边界 15 当前零命中；两种诱惑（Runtime 里的「屏幕 Port」、适配器里的坐标换算）各注入一次翻红 |
| B | 9 种非法 / 硬拒绝配置启动即拒、合法配置照常解析；没有 vision 启动失败；control / view 装的工具；操作守则进 system prompt |
| C | 图在 tool_result 之内、只出现在产出它之后那帧；无 vision 不发但保留引用；处置标记如实；token 两条路径差值恰为 1962 / 962；适配器那道门单独成立 |
| D | 窗口起点成批前移；端到端活图数 1 2 3 4 5 3 4、七帧只改写一次历史、留下最近的 |
| E | 截图长边来自声明；五种指针动作的点数换算；**contentRect 偏移时的换算**；审计事实上事件流 |
| F | 执行前复核：窗口身份、画面、截图失效、变没变先于许不许、拖拽终点；被拒动作零投递 |
| G | 失败即中止本批 ＋ 配对 |
| H | 没截图不许点 ＋ 配对；缺授权具名失败、关助手、授权后同 Run 恢复 |
| I | 安全输入、前台不在白名单、系统级组合键 ＋ 配对 |
| J | Web 审批通道端到端：截图不问、点击要问；卡片给出控件与换算；剥 RLO（成对）；批准后执行、记 HUMAN |
| K | 审计不落图像字节 ＋ 无图帧逐字相同 |
| L / M | resume 说出「外部状态核对不了」；截图落分支一重做、点击落分支三停下；白名单变了算漂移 |
| N | ADR-0014 两条规则各自成对，并核对启动提示与行为一致 |
| O | ADR-0015：只解除浏览器、仍要进白名单、助手收到放开标记、Web 入口拒绝 |

### 7.2 注入实测

首轮 19 处 ＋ ADR-0014 的 7 处 ＋ ADR-0015 的 2 处 ＋ 适配器门 1 处：每处把实现改坏 → 对应判据翻红 → 改回全绿。

### 7.3 全量回归

```
endpoint-profile 10 · pairing 14 · resume 5 · compact 10 · persistence 8 · budget 15 · crash 3 · drift 6 ·
tools 18 · artifact 24 · progress 15 · shell 28 · ui 84 · mcp 29 · computer 44 · model-audit 17 · scenarios 5
```

全部通过。唯一失败的 `verify:resource` 在干净 HEAD 上同一行（`resource.ts:338`）就崩，与本批无关，按「暂时不修」未动。
`npm run typecheck`（含 noUnusedLocals / noUnusedParameters）干净。

---

## 8. 真实运行记录

| # | Run | 白名单 | 结果 | 结论 |
|---|---|---|---|---|
| 1 | `run_609acf77238c` | 计算器、文本编辑 | ✗ 连续失败 10/10 | B1 截图几何、B2 `-3811` |
| 2 | `run_34dbd38e0d79` | 同上 | ✗ 连续失败 10/10 | 几何已对；模型瞄偏，且中途用户动过鼠标；系统设置窗口上的误点全部被硬拒绝 |
| 3 | `run_73db9f5de54f` | 同上 | 计算器 ✅ / 打字 ✗；结算 `SUCCESS` | B4 前台陈旧。模型如实说「没做成」、请人接管、不绕过；**结算的 SUCCESS 是假话**（无任务级完成契约，登记不修） |
| 4 | `run_800091ccaf65` | 同上 | ✅ 端到端 | 计算器读出 888、文本编辑写入；模型**自发**把截图落盘做像素分析定位按键，完成后删除临时文件 |
| 5 | `run_536c62856c99` | Google Chrome（`--computer-allow-browsers`） | ✅ 端到端 | 新标签、自己删掉 Chrome 的历史补全、B 站搜索；不登录、不点视频、不关标签 |

全部使用 `qwen3.8-flash`、`--approval auto`（运行环境非交互）、`--max-consecutive-failures 10`。
每次成功都用独立截图核对过最终状态，核对用的截图事后已删除。

---

## 9. 使用方法

```bash
npm run computer:build                       # 构建助手（需 Xcode Command Line Tools）
npm run computer:doctor -- --request         # 触发「录屏与系统录音」「辅助功能」授权提示
```

授权对象是 **Atlas GUI Helper**（`.workagent-state/computer/AtlasGUIHelper.app`），不是终端。
**助手每重建一次都要重新授权**：在系统设置里用「−」删掉旧条目、再用「+」添加，只把开关关了再开往往不生效。

```bash
npm run dev -- --computer control --computer-apps "Calculator,TextEdit" \
  --max-turns 60 --max-consecutive-failures 10 --task "..."

npm run dev -- --computer control --computer-apps "com.google.Chrome" --computer-allow-browsers \
  --max-turns 50 --max-consecutive-failures 10 --task "..."

npm run ui -- --computer view --computer-apps TextEdit      # Web 入口（不接受 --computer-allow-browsers）
npm run verify:computer                                     # 验收（假驱动）
```

运行时请不要同时使用鼠标键盘（前台模式）。

---

## 10. 安全与隐私代价（一条都不许假装没有）

1. **没有隔离层**：一次误点就是真实后果；
2. **截图发往模型端点、无法脱敏**：只截白名单窗口是减法；放开浏览器时，标签页标题、书签栏、登录头像都会进图（Chrome 实测确认）；
3. **提示注入**：屏幕上的文字可能是指令，两个端点都没宣称对截图做注入检测；
4. **护栏被绕过**：凭证读禁、私网拒绝在 GUI 面前不成立；
5. **AUTO 档下没有人**：剩下白名单、硬拒绝、执行前复核三道；
6. **浏览器放开**：登录态在模型可点范围内；若另有 Atlas 白盒界面开在同一浏览器里，那里的审批按钮也在射程内。

---

## 11. 已知限制与后续

| 限制 | 后续 |
|---|---|
| 没有任务级完成判定：第三次运行没做成也结算 SUCCESS | 需要重开 S5-7（通用 Completion Gate）的 ADR |
| 「动作 ＋ 截图」完全相同地连做三批仍判 `NO_PROGRESS`（例如同处连滚三次） | 需要「观察结果有没有变」一类判据（V05 §16.2 第二形态） |
| 模型自己的错误在 GUI 任务里是累计数（成功的 GUI 动作不清零） | 启动提示建议 `--max-consecutive-failures 10` |
| 只支持主显示器、前台模式 | 有真实需求时 |
| 不发送思考参数 | P-6 表明对 qwen 的 x / y 标量形态，默认思考反而是对的；保持现状 |
| 助手 ad-hoc 签名：每次重建都要重新授权 | 稳定签名身份需要动钥匙串，本批不做 |
| CLI 审批提示的 GUI 分支、Swift 助手本身没有机械判据 | `computer:doctor` 人工核对 ＋ live 运行（第 13 节的 R04 / R09 也在此列，尚未真机复跑） |
| Web 入口没有放开浏览器的能力 | 刻意的（ADR-0015） |
| `verify:resource` F 段在 HEAD 上就崩 | 既有问题，按用户要求暂不修 |

---

## 12. 文件清单

**新增**

```
tools/computer/package.json
tools/computer/src/{index,config,definitions,resolver,handler,keys,approval,driver,helper-build,helper-driver}.ts
tools/computer/helper/{AtlasGUIHelper.swift,Info.plist}
apps/cli/src/computer-helper.ts
apps/cli/src/verify/computer.ts
apps/cli/src/verify/fixtures/fake-gui-driver.ts
adapters/endpoint-profiles/deepseek-anthropic-flash.json
spikes/s1-computer-use-vision/（探针 P-0 … P-6 与原始证据）
sxw_aicoding/ADR/历史归档/0013-…、0014-…、0015-…
sxw_aicoding/WorkAgent调研/ComputerUse技术方案调研.md
sxw_aicoding/changelog/2026-10-03-Atlas集成ComputerUse.md（本文）
```

**修改**

```
packages/harness-runtime/src/types/{resource,context,endpoint,error,event,tool}.ts
packages/harness-runtime/src/{budget/index,ports/index,context/compile,action/settle-batch,facade/index}.ts
packages/harness-runtime/src/loop/{run-loop,model-audit,progress-guard}.ts
packages/harness-runtime/src/model/capability/profile-loader.ts
packages/store-sqlite/src/resource-store.ts
adapters/shape-anthropic-messages/src/protocol.ts
adapters/endpoint-profiles/bailian-anthropic-qwen38flash.json
apps/cli/src/{compose,main}.ts
apps/cli/src/verify/{boundaries,budget,compact,resource}.ts
apps/workagent-service/src/{main,run-host,human-channels,api-types}.ts
apps/workagent-ui/public/app.js
tools/common/src/mech/read-resource.ts
tools/mcp/src/tool-bridge.ts
package.json · package-lock.json · tsconfig.json · README.md · CLAUDE.md
```

---

## 13. 代码评审的处置（2026-10-03，codex 评审 CU-R01 … R12）

评审报告：[Atlas集成ComputerUse未提交代码评审-codex.md](../代码评审/2026-10-03/Atlas集成ComputerUse未提交代码评审-codex.md)。
先只读复核（12 项全部存在），再按「隐私 → 审批与复核能不能成立 → Swift 一次重编 → 其余」的顺序修。

### 13.1 逐项处置

| 项 | 评审级别 → 复核后 | 根因 | 修法（文件） | 判据 |
|---|---|---|---|---|
| **R11** 探针把真实截图存进仓库 | P2 → **P1（已发生）** | P-6 走了会归档的 `imageBlock` | 拆出只编码不归档的 `ephemeralImageBlock`，P-6 改用它；两张真实截图移到废纸篓；README / 探针文件头改正（`spikes/…/harness.ts`、`p6-real-screen.ts`） | 无（spike 不在验收里） |
| **R03** 同批截图顶替复核依据 | P1 → P1 | 截图一完成就覆盖 `observations` | 两槽：`seen`（更早批截的，模型看过）／`fresh`（本批截的）；动作与审批描述都用 `baselineFor(action)`；工具描述与 prompt 改成「已经看到结果的那张」（`handler.ts`、`approval.ts`、`definitions.ts`、`compose.ts`） | P 段 3 条；F 段 f6–f8 拆成两批 |
| **R01** 键盘目标没绑定审批 | P1 → P1 | 执行时现读前台 | `describeForApproval` 记下人看到的目标（键盘：前台进程；指针：目标窗口）；焦点被审批界面拿走 → 切回并整套复核重来；被另一个白名单应用拿走 → `TOOL_GUI_FOCUS_CHANGED`（`handler.ts`、`approval.ts`） | Q 段 4 条（终端拿走 → 切回执行；Calculator 拿走 → 零投递；切回没生效 → 零投递；没有审批描述 → 不切） |
| **R02** 取消后仍投递 | P1 → P2 | 复核等待之后不看 signal | `perform` 入口检查 `ctx.signal`，记 `TOOL_CANCELLED` / `NOT_STARTED` | R 段（点击、打字各一次） |
| **R04** 排除表漏掉新窗口 | P1 → P2 | 排除表是截图前的快照 | 截完再列一次窗口，有新的白名单外窗口就重截，三次不干净抛 `CAPTURE_UNSTABLE`；只查发给模型的那张（`AtlasGUIHelper.swift`） | 无（Swift，待真机） |
| **R05** 拖拽终点不比画面 | P2 → P2 | 终点只查窗口与白名单 | 终点走同一个 `checkTarget`（`handler.ts`） | S 段 2 条（成对） |
| **R06** `vision` 不在 resume 指纹里 | P2 → P3 | 加 `vision` 段时指纹没跟着改 | 指纹加 `vision`（`profile-loader.ts`） | T 段（公式 / 计图各改一处 → 拒绝；只改日期 → 放行） |
| **R07** 重连保留旧缓冲 | P2 → P3 | 缓冲是实例字段 | 缓冲跟着连接走；旧连接迟到的 close 不判死新连接的请求；`launch` 注入点（`helper-driver.ts`） | T 段：node 假助手，第一代传半条就断，第二代必须秒回 |
| **R08** 构建失败不清理 | P2 → P2 | 构建排在 MCP / stdin 之后 | 构建挪到一切资源获取之前（`apps/cli/src/main.ts`） | 无（见 13.3） |
| **R09** 激活超时报成功 | P2 → P2/P3 | 丢弃了 `sem.wait` 的返回值 | 超时抛 `ACTIVATE_TIMEOUT`，TS 侧记 `UNKNOWN`（`AtlasGUIHelper.swift`） | 无（Swift，待真机）；Q 段「切回没生效」覆盖了 TS 侧的后果 |
| **R10** 审批只给前 200 字 | P2 → P2 | `text.slice(0, 200)` | 全文，JSON 字符串形态，不可见字符转成 `\uXXXX`（`approval.ts` 的 `visibleText`） | S 段（600 字带换行与 RLO） |
| **R12** 干净 checkout 首次编译失败 | P3 → P3 | 没建 `.bin/` | `mkdirSync(dirname(BIN))`（`spikes/…/scenes.ts`） | 无 |

### 13.2 两条【定】

1. **复核依据是「模型已经看到的」截图，不是「最近截的」。** 一批调用对应模型的一次回复，模型生成第 N 批时，
   第 N 批之前所有批的结果都已在它的上下文里 —— 所以「不是本批截的」就等于「看过的」，用批次号推出，不用时间。
2. **切回焦点是「还」，不是「替模型多做一步」。** 只在有人看过审批描述、批准的窗口就是截图里那一处、
   挡在那里的是 Atlas 碰不了的东西时才切；切完整套复核重来。被另一个白名单应用拿走时拒绝 ——
   那是世界变了，不是审批界面造成的。

### 13.3 验证

- `verify:computer` 44 → **57 条**全绿；新增 13 条与 F 段改写都做了注入实测（12 处改坏 → 各自翻红 → 改回）。
  其中一处第一次没有翻红：「切回之后不再核对前台」—— 假驱动里激活总是成功，那道检查不可观察。
  补了「切回没生效」的配对判据后翻红。**又一次只有注入实测发现得了。**
- 全量回归：17 条脚本全绿；`verify:resource` 仍崩在 F 段（HEAD 上就有，未动）。`npm run typecheck` 干净；
  Swift `swiftc -typecheck` 零告警。
- **没有机械判据**：R04 / R09（Swift，要真桌面）；R08（判据要跑一次失败的 swiftc，而成功的构建会让授权作废）；
  CLI 审批的 GUI 分支（与 Web 卡片同一个 `describeForApproval` 给内容，Web 那半有 S 段）。
- **助手已重建一次**（R04 ＋ R09），用户重新授权后做了两条真桌面回归（qwen3.8-flash、`--approval auto`）：

  | Run | 任务 | 结果 | 独立核对 |
  |---|---|---|---|
  | `run_6b779ff203fe` | Chrome → bilibili.com → 主搜索框搜「agent开发面试」（与 `run_536c62856c99` 同一任务文本） | ✅ `SUCCESS`，27 轮 | 最后一张截图：地址 `search.bilibili.com/all?keyword=agent开发面试…`，前三条与模型回答一致（第三条带「广告」） |
  | `run_2c0d8f313032` | 计算器点按钮算 99+88+66，结果存进 workspace 的 `calc-result.txt` | ✅ `SUCCESS`，23 轮 | 计算器历史行 `99+88+66`、结果 253；文件内容 `99 + 88 + 66 = 253`（模型用 `write_file` 写、`read_file` 回读） |

  15 次成功截图零次 `CAPTURE_UNSTABLE` —— R04 担心的「截图本身冒出新窗口、每次都判不干净」没有发生。
  覆盖面如实说：这两条只走到了 R04；R01 / R10（要有人看审批描述）、R03（两次运行都是一批一个调用）、R09（要一次超时的激活）
  都只有假驱动判据。
- 两条真机观察，都不是本批引入的：① 两次运行的第 1 轮截图都是 `-3811`（上一轮同一任务也是）——
  白名单应用不在当前桌面时排除式过滤器也会报错，ADR-0014「得到空白图而不是错误」的说法不成立；模型按提示 `activate_app` 后恢复。
  ② Chrome 地址栏的历史补全把输入的网址补成了用户浏览记录里的一个视频页并打开了它（截图随之发往端点）；
  模型没点视频，发现后点 logo 回首页 —— ADR-0015 代价 ① 的又一个实例，上一轮模型自己删掉了补全，这一轮没有。

### 13.4 更正

本文与前文对话里有两处说法当时不成立：「截图不进仓库」（P-6 实际把两张真实截图存进了 `raw/images/`）、
「核对用的截图都已删除」（只删了 `/tmp` 里的那份）。13.1 R11 一行是处置。

