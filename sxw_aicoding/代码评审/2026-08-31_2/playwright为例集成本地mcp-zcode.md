# 代码评审：以 Playwright 为例集成通用本地 MCP 能力（ADR-0011）

- **评审日期**：2026-08-31
- **评审人**：ZCode（通读全部未提交 diff 与新增 ADR / 过程记录，独立复核每一条被注释引用的代码路径，实际运行验收命令，解析两个实测 run 的 trace JSONL + runs.db transcript + 落盘产物）
- **评审对象**：MCP 集成批次，git 未提交。15 个修改文件（+1807/−53）＋ 新增 `tools/mcp/`（5 个源文件）＋ `apps/cli/src/verify/mcp.ts`（17 条判据）＋ 手写假 MCP 服务器夹具 ＋ ADR-0011 ＋ CLAUDE.md ＋ `mcp.example.json`
- **关联文档**：ADR-0011（通过外部 MCP 接入浏览器能力）、`sxw_aicoding/temp/20260831_MCP集成过程记录与实测问题定位.md`（下称"过程记录"）
- **评审方式**：只读评审 ＋ 验收命令实证 ＋ 两个实测 case 的原始数据复核；未新增或修改任何仓库文件（verify 脚本仅在系统临时目录工作并自清理）

---

## 总评

**这是一批架构判断全部成立的改动。** 过程记录里每一条被注释引用的代码事实我都回源码独立核实过，无一条虚指；`EXTERNAL_TOOL` 新 kind 在所有 `scope.kind` 分派点都有成对处理；D 段第一版"判据打在下游"的缺陷被注入实测抓住并修正，是本仓判别力要求的正面示范。

**但评审发现三个文档未覆盖或低估的问题**：① 建连失败路径泄漏 MCP 子进程（`withTimeout` 拒绝后 transport 无人收）；② `tools/call` 结果走严格 `CallToolResultSchema`，未知 content 块类型会让工具整个废掉、且错误归因失真（"没收到服务器回话"是假话）；③ 过程记录 6.5 的 cwd 巧合，实际触发条件比文档写的近得多——**在 UI 里切换一次工作空间今天就断，零配置改动**。

**Badcase 归因复核**：6.2"模型行为方差，非 MCP 集成缺陷"成立，且我补了两条文档没写的证据（A 自己也犯过同族错误只是修掉了）；6.3"已有检查器没有触发路径"成立，我把没触发的最后一环定位到 `run_shell` 的 `artifact_path` 只认单个普通文件。

**结论：可以提交。** P1 三项都不阻塞本次交付，但 P1-3 建议立刻写进文档。

---

## 一、实证结果（全部实际运行）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 干净（`-p tsconfig.json`，strict） |
| `npm run verify:mcp` | **17/17 ✓**（手写假服务器夹具，不依赖 Playwright、不联网、不弹窗口） |
| `npm run verify:tools` | **15/15 ✓**，含新增 B4 段与 13 条边界 grep（编号到 12）全部干净 |

B4 的判别力单独核实过：`DEFAULT_TOOLS = commonTools + microCaseTools` 覆盖全部自家工具，判据能同时抓"自家工具用了只给 MCP 的宽口子"和"关键字拼写错误（`descripton`）"——它是索引签名放宽的真实对价，不是装饰。

---

## 二、文档论断的独立复核（逐条回源码）

| 过程记录 / 注释论断 | 核实结果 |
|---|---|
| read 档 → Policy `ALLOW`（`effectType: READ` 不在 `requiresApprovalFor`） | ✅ `packages/harness-runtime/src/action/policy.ts:34`；execute 档 `EXECUTE` → `REQUIRE_APPROVAL` 同支确认 |
| execute 档报错 `UNKNOWN` → push RecoveryItem → Run 降级 `COMPLETED_WITH_LIMITS`，且**不**触发 `RECOVERY_REQUIRED` | ✅ `action/settle-batch.ts:590`、`verification/settle-outcome.ts:77`；`UNKNOWN` 不自动重试由不变量 10 兜底（settle-batch:556） |
| `canObserve` 恒假 → execute 档落 §18.2 分支三，与 `run_shell` 同档 | ✅ `facade/index.ts:460-463`（`requiresPreFingerprint && pre === undefined` → false） |
| `TrustedEffectResolver.resolve` 拿不到 toolName → 必须逐工具一个 Resolver 实例 | ✅ `ports/index.ts:312` 签名只有 `(normalizedInput, workspaceRoot)`；按 `id@version` 注册一工具一条确实是这套机制支持的用法 |
| `EXTERNAL_TOOL` 不并进 `PROCESS`（审批面会说方向相反的保证） | ✅ 三处展示成对：CLI `main.ts`、Web `human-channels.ts`（`stripUnsafeDisplayChars` 剥控制字符）、`app.js`（`textContent` 渲染，无 XSS 面）；`api-types.ts` 补 `externalArgs` |
| `autoGrantVerdict` 不需要为 MCP 改 | ✅ 按 `effectType` 判（EXECUTE 不放行），read 档 `READ + REVERSIBLE + scope.kind 非 FILE/DIRECTORY` → 自动放行，语义正确 |
| `run-host.ts` 的 `info()` 第二出处修复 | ✅ `composed.tools` 唯一出处成立；compose.ts:513 注释把"数字偏小但看起来合理"这种错误的隐蔽性说透了 |
| `getDefaultEnvironment()` 是白名单、`.env` 凭证不进子进程；`environment` 必须合不能换 | ✅ SDK 源码核实（POSIX 仅 HOME/LOGNAME/PATH/SHELL/TERM/USER） |
| `resolveServerCwd` 缺省 = workspaceRoot → `browser_evaluate` 结果靠 `read_file` 相对路径接上 | ✅ 成立，但触发条件被低估，见 P1-3 |

---

## 三、发现的问题

### P1-1【中·真实缺陷】建连失败路径泄漏 MCP 子进程

`tools/mcp/src/client.ts` 的 `connectServer()`：

- `withTimeout(client.connect(transport), startup, …)` 超时时，race 拒绝、函数抛出，但**底层 transport 已 spawn、stdin 仍开着**，没有任何人收它。已核实 SDK：`Protocol.request` 对 initialize 不设默认超时（`shared/protocol.js` 的 `_setupTimeout` 只在显式传 timeout 时生效），`withTimeout` 是唯一防线——而它拒绝后不清理。
- `listAllTools` 失败（request 超时、分页 cursor 异常）同理：连接已建、`conn` 对象尚未入列。
- `index.ts` 的 `closeAll()` 只遍历 `conns`（**已完整连上的**），失败中的那个 transport 永远不在名单里。

后果：一个启动卡住的 MCP（`npx` 首次下载超时是常见场景）留下孤儿进程；用户重试一次多一个。`service/main.ts` 停机注释担心"浏览器窗口越来越多"，这是通往同一症状的**第二条路径**。修法方向：`connectServer` 内 try/catch，失败时先 `await transport.close()`（SDK 的 close 同步前缀会 `stdin.end()`）再 rethrow。

### P1-2【中·健壮性 + 错误归因失真】`tools/call` 结果走严格 `CallToolResultSchema`

已核实 SDK 1.30 源码：

```js
export const CallToolResultSchema = ResultSchema.extend({
  content: z.array(ContentBlockSchema).default([]),   // ContentBlock = 五种已知类型的 union
  ...
})
```

服务器返回一个 SDK 不认识的 content 块类型（协议在演进——这正是过程记录细节② `outputSchema` 的同族问题）→ 整个 `callTool` 抛异常 → `handler.ts` 落进 `classify()` → 报 **`MCP_CALL_FAILED` / UNAVAILABLE："没有收到服务器回话，副作用是否已发生无从判断"**。

两层问题：① 那个工具整个废掉——与放宽 JsonSchema 要避免的失败形态（"模型看得见、调得动、每次被挡在门口、无从改对"）一模一样；② **错误归因是假的**——服务器明明回话了，只是回话的形状 SDK 不认识；`sideEffectState: UNKNOWN` 的理由（"请求可能已生效但结果没回来"）在这种情形下不成立。宽容处置（`TolerantListToolsResultSchema`）只做在了 `tools/list` 那条路上，`tools/call` 漏了。而 `renderContent` 本来就是按开放对象读 `block.type` 的——严格 schema 是唯一逼死它的东西。建议给 call 结果配宽松 schema（`content: loose {type:string} 数组 + isError? + structuredContent?`），与 tools/list 的处置对称。

### P1-3【中·比过程记录写的触发条件更近】6.5 的巧合在"切换 workspace"时**今天就断**

这是对过程记录 6.5 的直接反驳性补充。`apps/workagent-service/src/main.ts`：

```ts
const workspaceRoot = resolve(arg(argv, "workspace") ?? resolve(REPO_ROOT, ".workagent-workspace"));
const mcp = await connectMcpServers({ configPath, workspaceRoot });   // ← cwd 固化在这里，一次
```

MCP 子进程的 cwd = **service 启动时的默认根**，且连接跨 workspace 复用（为保登录态，设计如此，评审认可这个设计）。Case B 能跑通的唯一原因是：当时 UI 的活跃 workspace 恰好就是 `.workagent-workspace` 本身（已核实 `.workagent-state/workspaces.json`，`activeId` 指向它，run 的 workspace 与 MCP cwd 是同一目录）。

**用户在 UI 里切到 workspace_1（Desktop）再跑同一句话任务**：`browser_evaluate` 把 `image_urls.json` 写进 MCP cwd（`.workagent-workspace`），模型的相对路径 `read_file("image_urls.json")` 按 run 的 workspaceRoot（Desktop/workspace_1）解析 → NOT FOUND，模型只能瞎猜路径（实测它用的就是相对路径，见 badcase 复核）。

过程记录 6.5 说触发条件是"用户在 mcp.json 里配了 `cwd`，或 Playwright 改了默认输出目录"——**实际触发条件是零配置改动地切一次工作空间**。建议把待处置 2 的优先级提高：至少在 `notices` / ADR / `mcp.example.json` 里显式声明"MCP 输出目录 = service 根，与活跃 workspace 无关"。同时 `config.ts` 里"相对路径按 workspace 解析"的注释在 service 语境下与行为不符（实际是按 service 启动时的默认根解析一次）。

### P2 级（低，列出供权衡）

1. **CLI `process.once("exit", () => void mcp.close())`**：exit 钩子里跑 async close 是反模式。核实过 SDK：`Protocol.close()` → `transport.close()` 的同步前缀会执行 `stdin.end()`，MCP 服务器收到 EOF 通常自行退出，**实践中大概率没事**；但依赖的是这个实现细节，值得一行注释钉住（"SDK 若把 stdin.end 挪到 await 之后，这里立即失效"）。
2. **`renderContent` 全空返回**：content 缺失且无 structuredContent 时 `ok:true, output:""`（zod `default([])` 把缺失 content 变成 `[]` 走进这个分支），模型拿到一个空成功。低危，可考虑补一句"服务器没有返回任何内容"。
3. **isError 时 `[Atlas]` 丢弃说明会混进 `safeMessage`**（texts 里已含说明文本，随错误原文一起上报）。极低。
4. **边界 12 的 grep 射程**：pattern 只抓 `modelcontextprotocol` / `StdioClientTransport` 字样；**手写 JSON-RPC over `node:child_process` 进 packages 不会被抓**。边界注释把定位写成"防搬 SDK 进 Port"，这个定位下 grep 是对的，但手写客户端这条盲区建议在注释里如实写明。
5. `tools/mcp/package.json` 不声明对 SDK 的依赖——与 `tools/common` 惯例一致（依赖基线记在根 package.json，3→4），不算缺陷，仅提示。

### 做得好的（值得保持）

- **isError（服务器回话说失败）与传输异常（没收到回话）的 `sideEffectState` 分流**：read 档传输异常也记 `UNKNOWN`——"请求已经发出去过了"，与 `fetch_url` 重定向终点那次的理由一字同源，诚实且正确。
- **配置 UX 三条**：文件不存在不是错误（绝大多数用户没有 MCP）/ 拼错工具名报错**并列出服务器真实工具名**（否则那行配置"看起来生效了、实际什么都没变"）/ `required:false` 放行但响亮地说。都是 M-5 教训的正确落地。
- **判据的正反两侧设计**：C 段"只验 execute 要审批会被全拒绝实现骗绿"、E 段"只验抛会被永远抛骗绿"、F 段"成功也要验否则恒 UNKNOWN 实现照样绿"——注释自己把每个单侧判据的漏洞说清楚了。
- **D 段修复**：显式走 `validateAndNormalize` 两跳、两跳都断言——注入实测抓住第一版"判据打在 Port 上、跨不过出事那一跳"，修法正确。

---

## 四、Badcase 分析评审

### Case A（回归）——结论：无回归；归因复核通过，附两条文档没写的补充证据

调用序列（trace 复核）：`fetch_url ×2 → run_shell ×13`，16 轮 COMPLETED/SUCCESS，`workspace/images.zip` 两个版本链，产物 14 张图命名正常。

**补充证据，进一步支持"模型行为方差"论**（过程记录 6.2）：

1. A 的 seq175 第一版下载脚本 URL 拼接是错的——`full_url="https:${url#//}"` 把 `//host/path` 剥掉前导 `//` 后拼出 `https:host/...`，seq195 才修成 `https:${url}`；
2. A 自己也产出过 `.jpg.jpg` 双扩展名（seq218 修）和 3 个错扩展名文件（seq267 手工 `mv img_02_...jpg img_02_...png` 等 ＋ `file *` 终验）。

即：**同一模型、同一 URL 形态，两次运行都犯了同族错误，区别只在 A 花了 4 轮自我修正、B 一轮都没做**。6.2 的归因成立。

### Case B（MCP）——证据链完整复核 + 三条补充

完整链路（transcript 复核）：

```
navigate(seq6) → evaluate 收 26 URL(seq31) → read_file("image_urls.json")(seq46)
→ evaluate 滚动+收 49 URL(seq66) → read_file("all_image_urls.json")(seq81)
→ python json 解析失败浪费一轮(seq104, exitCode 1) → SSL 全军覆没(seq133, 49/49
CERTIFICATE_VERIFY_FAILED) → 关 SSL 校验重跑(seq156, 49/49 OK 但文件名污染)
→ zip(seq179) → close(seq200) → 总结"49/49 全部下载成功"
```

落盘物证复核：`images/` 49 个文件内容全部有效（`img_000` 是真 PNG 2560×240 RGBA），坏的只有扩展名（`png_3840w_360h_1c`——`replace('@','_')` ＋ `replace('!','_')` 两个 sanitize 都留着）；zip 内同名；`.playwright-mcp/` 两个文件 ＋ `image_urls.json` / `all_image_urls.json` 躺在 workspace 根。全部与过程记录一致。

**补充发现（过程记录未写）：**

1. **审批负担的实测数字**：B 共 **8 次审批**（navigate 1、evaluate 2、run_shell 4、close 1）——mcp.json 没配 `tools` 段，全部落 execute 档逐次问。这是待处置 4 的第一条实测数据。
2. **B 不是零试错，是缺终验**：它实际浪费了 2 轮（json 解析 ＋ SSL），说明轮次预算并不紧张；缺的是 A 做过的那步 `file *` 终验。这对"待处置 1 该怎么触发"有参考意义（见第五节问题 2）。
3. **P1-3 的实测印证**：seq15 navigate 返回的 snapshot 链接 `.playwright-mcp/page-….yml`、seq40/75 的 `[Evaluation result](./image_urls.json)` 都是**相对 MCP cwd 的路径**，模型两跳跟进（seq46/seq81 都是相对路径调用）全靠 cwd 与 run workspace 重合这一次巧合。

### 6.3 / 6.4 复核——成立，且"没触发"的机制死穴定位到最后一环

`artifactKindOf()`（`tools/common/src/artifact-checks/index.ts:159`）：未知扩展名 → `text` → UTF-8 编码检查 → PNG 二进制必翻红——检查器在、判别力在、失败方向看得见。

没跑的最后一环：`run_shell` 的 `collectDeclaredArtifact`（`exec/run-shell.ts:631` 一带）**只认单个普通文件**（目录声明直接"不是一个普通文件，未登记"），`images/` 目录从类型上就不可能被声明；49 个中间文件没有任何登记入口 → `ArtifactRegistered` 只发生在 zip 一步 → 第二层检查没有触发点。zip 检查只验结构（`zip-opens`：PK 魔数 ＋ EOCD），不看成员——ADR-0010 已声明的边界，非回归。

**"一个 49 张全有效的 zip 和一个全是坏文件名的 zip，在事实表里完全不可区分"——这个具体化判断准确。**

---

## 五、对过程记录第八节四个点名问题的回答

**1. 6.2 归因是否成立？** 成立，且补了两条证据（A 的 URL 拼接 bug ＋ A 自己的坏文件名被修正）。没有别的解释能同时覆盖"两次 URL 形态相同"（已核实 B 的 `image_urls.json` 与 A 的 `img_urls_full.txt` 提取正则——A 的 seq131 正则 `(?:[?@]\S*)?` 显式处理过 `@` 参数）和"A 犯过同族错误但修掉了"。

**2. 待处置 1 怎么触发？** 倾向**先不改 `run_shell` 契约**。目录/glob 声明会改工具契约，且"目录里旧文件冒认本次产物"的 mtime 判定会复杂化；引导面又无机械判据（B 组已拒绝过"description 里必须出现某个词"）。诚实的现状是：真正缺的一跳是"模型对交付物做终验"，而 B 证明模型有轮次（12/预算，还浪费过 2 轮）却不自发做。符合仓里"不为没量过的问题先建机制"的处置是：**把 6.3 作为已知缺口登记进 ADR-0010 族谱**（与二进制通道同列），等下一次真实失败带数据再决定。若一定要机械触发，最小改动是 zip 检查器加"成员扩展名与 magic 交叉校验"——但过程记录已正确指出它滑向任务级规则，不推荐。

**3. "一个词说三件事"是否过度耦合？** 同源论证成立（三个推论都以"它只读"为前提），但要补一条文档没写的警告：**`browser_evaluate` 不是只读工具**——它在页面上下文执行任意 JS，可发请求、可点按钮、可改 DOM。用户若图省事把它标 `read`，三件事一起错且零提示。建议在 ADR-0011 或 `mcp.example.json` 里给一张 Playwright 工具推荐档位表（`browser_snapshot` 等纯读取 → read；`evaluate` / `click` / `type` / `navigate` → execute）。

**4. 依赖基线 3→4 是否值得？** 值得，且 P1-2 恰好是追加论据：`outputSchema` 会解析失败、`CompatibilityCallToolResultSchema` 的存在本身（SDK 要兼容旧形态的 call 结果）、以及严格 union 面对新块类型会咬人——这些坑的地图是 SDK 给的，手写 200 行 stdio client 不会预见。宽容面需要自己掌握（P1-2 就是没掌握完的那一角），但代价远小于手写。

---

## 六、待处置清单的优先级建议（供决策，本次评审未动手）

| 优先级 | 事项 | 理由 |
|---|---|---|
| ↑ 提前 | 待处置 2（cwd 耦合） | P1-3：触发条件比过程记录写的近得多——切一次 workspace 就断，零配置改动 |
| ↑ 提前 | P1-1 建连失败收子进程 | 一次性小改（`connectServer` 内 try/catch ＋ `transport.close()`），防止孤儿浏览器进程——与 service 停机注释担心的是同一症状 |
| 新增 | P1-2 call 结果宽松 schema | 与细节②同族，且当前错误归因失真（"没收到回话"是假话，`sideEffectState: UNKNOWN` 的理由在该情形下不成立） |
| 新增 | `mcp.example.json` / ADR 补 Playwright 推荐档位表 | 第五节问题 3 的 `browser_evaluate` 陷阱 |
| 维持 | 待处置 1（中间产物触发路径） | 按问题 2 的立场：登记为缺口，不急着改契约 |
| 维持 | 待处置 3、4 | 过程记录判断正确；待处置 4 现在有实测数据了（B：8 次审批/run） |

**一句话结论：这批代码可以提交**——架构判断、边界纪律、判据质量都在线；P1 三项值得放进下一个小批次（P1-3 至少先落文档），三项都不阻塞本次交付。

---

## 附：评审中核实过的关键文件

| 主题 | 文件 |
|---|---|
| 新包源码 | `tools/mcp/src/{config,client,tool-bridge,handler,index}.ts` |
| Runtime 两处类型改动 | `packages/harness-runtime/src/types/tool.ts`、`src/tool-runtime/index.ts` |
| 入口接线 | `apps/cli/src/{compose,main}.ts`、`apps/workagent-service/src/{main,run-host,human-channels,api-types}.ts`、`apps/workagent-ui/public/app.js` |
| 判据与夹具 | `apps/cli/src/verify/mcp.ts`、`apps/cli/src/verify/fixtures/fake-mcp-server.ts` |
| 被引用的 Runtime 路径 | `action/policy.ts`、`action/settle-batch.ts`、`verification/settle-outcome.ts`、`facade/index.ts`、`ports/index.ts`、`action/effect-resolver.ts` |
| Badcase 原始数据 | 两个 workspace 的 `.workagent/runs/*.jsonl` ＋ `runs.db`（`transcript_entries` 表）＋ 落盘产物（`images/` 49 文件、`images.zip`、`.playwright-mcp/`） |
