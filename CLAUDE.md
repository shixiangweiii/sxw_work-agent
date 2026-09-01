# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目身份

**Atlas**（Project Atlas）是本项目的正式代号，**WorkAgent** 是产品类别与工程命名。

> ⚠️ **Atlas 仅用于项目识别与沟通，不作为任何工程重命名的依据。** 代码、目录、包名、模块、类型一律保持 `workagent` / `@workagent/*` 现状。见 [项目代号.md](sxw_aicoding/项目代号.md)。

定位：**自建生产级 Agent Harness，学习导向，个人使用**。项目第一目标是回答研究问题，不是交付功能——每个阶段结束时应该能说出「我们验证了 X」，而不只是「我们做完了 Y」。

产品语境（[WorkAgent调研.md](sxw_aicoding/WorkAgent调研/WorkAgent调研.md)、[Agent演化发展](sxw_aicoding/WorkAgent调研/Agent演化发展_从ChatAgent到LifeAgent.md)）：Agent 演化路径 ChatAgent → CodingAgent → **WorkAgent** → LifeAgent。本项目不复刻 WorkBuddy / 千问办公这类产品，而是自建它们底下那层 Harness。

## 当前状态

### auto 模式 / 完全权限（2026-09-01）：审批与执行特权拆成两条正交的轴

依据 [ADR-0012](sxw_aicoding/ADR/0012-审批与执行特权是两条正交的档位轴.md)。
起因是**一次真实的实测抱怨**：跑「把 B 站 opus 页的图片下载下来打包成 images.zip」
（Run `run_75f0d6afafa6`）被要求点了十几次确认。

```bash
npm run ui  -- --approval auto                    # 不再问，沙箱仍在
npm run dev -- --approval auto --sandbox off      # 完全权限：**没有任何闸门**
```

`verify:all` **198 → 221 条**。

> ### 【定】逐条回源之后，真正的缺口不是"没有 auto 档"，是**Web 侧一个逃生口都没有**
>
> CLI 一直有 `--yes-all`；Web 的 `RunHost` 把 `autoGrantVerdict` 写死注入，
> service 的参数表里根本没有这个开关。而浏览器任务**必须**用 `npm run ui`
> （MCP 进程绑会话）。**于是用户被逼到了唯一没有逃生口的那个入口上。**
>
> 十几次里 ≈10 次来自 `run_shell`：`analyzeCommand` 判 EXECUTE 的规则是
> 「有任一 shell 元字符」，而那次 10 条命令**每条都含元字符**。
> 其余来自 MCP 浏览器工具（`tierOf` 默认 `execute`）。

> ### 【定】"拆沙箱"底下捆着**七件**事，只拆其中三件
>
> | # | 限制 | 决定 |
> |---|---|---|
> | 1 | `run_shell` 写不出 workspace ＋ `$TMPDIR` | **拆** |
> | 2 | `run_shell` 默认禁网 | **拆** |
> | 3 | 子进程 env 白名单 | 不拆 |
> | 4 | 读不到 `.env` / `.ssh` / `.aws` | 不拆 |
> | 5 | workspace 外的写被 policy `DENY` | **拆**（改走审批） |
> | 6 | `read_file` / `search` 读黑名单 | 不拆 |
> | 7 | `fetch_url` 拒私网 | 不拆 |
>
> **第 5 条真正的消费者是四个路径域的写工具**（`write_file` / `edit_file` /
> `append_log` / `slow_write`），**不是 `run_shell`** —— 二次复核回源更正的：
> `OUTSIDE_WORKSPACE` 只由 `effect-resolver.ts` 为路径域工具产出，
> `ShellEffectResolver` 从不产出它，`run_shell` 一直只被沙箱拦。
> 第 3/4/6 不拆的理由是同一条：对任何真实任务零收益，拆了只增加凭证泄漏面。
> **第 7 条明确不动** —— ADR-0011 刚拍板"两个工具对同一件事给出相反答案是刻意的，
> 否则下一个人会来统一其中一个"，拆它就是那个"下一个人"。

> ### 【定】UNRESTRICTED **不是**「不套沙箱」，是一份只剩凭证读禁的窄 profile
>
> **这一条是被我自己写的判据（`verify:shell` B10）当场逼出来的。**
> 第一版实现的是「档位为 UNRESTRICTED 就直接 `spawn("/bin/bash")`」，
> 理由写得也很像那么回事：「留着 sandbox-exec 给一份 allow-all 的 profile，
> 会让它在 `ps` 里、在读代码的人眼里都还是『跑在沙箱里』」。
>
> 那段话没错，**但它论证的是 allow-all profile，而范围表里凭证读禁是「不拆」的**。
> 直接 spawn 把它一起拆了：`cat .env.local` 当场读到 SECRET。
> 那个看起来"更诚实"的写法，恰恰让实现与**同一批里我自己刚写下的范围表**不符。
>
> 连带：`isSandboxAvailable()` 那道闸门**两档都要过**——
> 少了它，UNRESTRICTED 会在非 darwin 上悄悄退化成"连凭证读禁也没有"。

> ### 【定】两条轴的生命周期不同，这是代码事实不是设计偏好
>
> | | 启动参数 | 提交时选 | 运行中切 | 「本次 Run 不再问」 |
> |---|---|---|---|---|
> | 审批 | ✅ | ✅ | ✅ | ✅ |
> | 执行特权 | ✅ | ✅ | ❌ 只对下一个 Run | 不适用 |
>
> 审批档位住在 `ApprovalDecider` 注入点上，不进 RunSpec —— 技术前提是
> **档位传的是读函数不是值**（传值＝钉死在 compose 那一刻，界面开关会是死的）。
>
> 执行特权不行：`commonTools` 是模块级常量数组，`run_shell` 拿得到的只有执行期
> `ctx`。先例是 `ToolExecutionContext.timezone`（「随 AgentSpec 冻结…Replay 要求
> 时区随 Run 冻结而不是随重放机器变」），而这里的理由更硬：它决定的是
> **那些副作用当时有没有边界**。于是 §18.3 多了**第三维**闸门
> （`assertResumeExecutionPrivilegeMatches`），与端点、workspace 并排。
>
> 【定】旧库缺这个字段时按 `SANDBOXED` 读，而那**不是猜测**：那一档之前不存在。
> 与 workspace 那条 `UNKNOWN_LEGACY` 不同类（那是"我无法核对"，这是"我知道"）。

> ### 【定】必须同时付的账：**谁批的，事后要能区分**
>
> 在此之前 `--yes-all` 的无条件批准与一个人亲手敲 `y`，在 `ApprovalDecided` 上
> **一个字都不差**（都是不带 reason 的 `{approved:true}`）。
> 新增 `decidedBy`：`HUMAN` / `AUTO` / `AUTO_GRANT` / `UNDECLARED`。
>
> **Runtime 不给它兜底成 `HUMAN`** —— 没声明就记 `UNDECLARED`，那是一句真话；
> 记 `HUMAN` 是假话，而假话在事实表里比空白贵得多。
> 「本次 Run 不再问」的**第一次仍记 `HUMAN`**、之后记 `AUTO`：人只看过那一条，
> 都记 HUMAN 等于替他宣称"我逐条批准过全部"。

> ### 【定】AUTO 档下另两条通道的处置**相反**（ADR-0008 的直接后果）
>
> `ask_user`「你来定」→ 没人回答不是失败 → **立刻 NO_ANSWER**；
> `request_handoff`「你去做」→ 没人接管就是失败 → **照样等人**。
> 自动化的是"要不要问你"，不是"要不要有人去做那件事"。
> AUTO 档跑浏览器任务时模型请你去登录，那一停是有价值的。

> ### 【定】UNRESTRICTED 下「这条命令没联网」是一句说不出口的话
>
> `allow_network` 在 SANDBOXED 下是被内核强制的开关，所以「没传＝没联网」是事实；
> UNRESTRICTED 下没有那条 deny，进程无条件有网。照旧只按 `allow_network` 记
> `DATA_LEAVES_HOST` 的话，一条 `curl` 了半个互联网的命令与一条纯本地命令
> 在 `riskFacts` 上**完全一样**。处置是**如实记「无法排除」**
> （先例：`effect-resolver.ts` 对解析不了的 URL 写 `"(无法解析)"`）。

> ⚠️ **五条代价，写在 ADR-0012 里**：① AUTO ＋ UNRESTRICTED 时**没有任何闸门**
> （处置是响一声 ＋ 档位不进任何持久配置，重启回到启动值）；
> ② AUTO 下 `ask_user` 的犹豫对模型是无声的；
> ③ 交付物登记**仍限 workspace 内**（第二层检查读的是 `workspaceRoot` 下那一份）；
> ④ 非 darwin 上 UNRESTRICTED 仍然没有 `run_shell`（工具面那道闸门是模块级的）；
> ⑤ 切 workspace 会把界面上拨过的审批档位弹回启动值（刻意的）。

> ⚠️ **新增 10 条判据每条都做过注入实测**，其中两组是**成对**的：
> `verify:shell` B9/B10（UNRESTRICTED 越界写必须**成功** ＋ 凭证读禁仍在）、
> `verify:ui` D4/D5/J2（AUTO 记 AUTO ＋ 人点记 HUMAN；不再问的 `HUMAN → AUTO`；
> 换档 resume 被拒 ＋ **同档放行**）。
> 少了配对的那一半，「档位根本没接线」「resume 一律拒绝」「`decidedBy` 恒填一个值」
> 三种实现都能全绿 —— 前两种正是 `sandbox.ts` 与 J 段各自记过的教训。
>
> ⚠️ **B9 的探针写临时目录并清理，不写 `$HOME`**：B2 那条的教训是实测出来的
> （故障注入摘掉 `deny file-write*` 那次真的在 `$HOME` 建出文件，判据被永久毒化），
> 而 B9 是**故意**要让写成功的 —— 写 `$HOME` 就不是"万一"，是每次都留痕。

> ### 【定】同日二次复核抓到四条，**三条是我在同一批里自己造的**
>
> | 发现 | 形态 |
> |---|---|
> | policy 放行越界写，而**四个写工具自己那道 `isInsideWorkspace` 没跟着改** | 探针：`policy=REQUIRE_APPROVAL` → 工具 `TOOL_PATH_ESCAPE` → 文件没写出来。**问了人、批了、然后照样失败** —— 比原来的 DENY 更糟 |
> | 我给「第 5 条必须一起拆」写的**因果是错的** | `ShellEffectResolver` 从不产出 `OUTSIDE_WORKSPACE`，run_shell 从来没被那条 policy 拦过。与 M4「清 effect 噪声能减少审批」同形态 |
> | CLI 在「无人应答」时记 `decidedBy: "HUMAN"` | **我自己写的【定】禁止的那句假话**，而 Web 那侧写对了。**一个新字段最容易错的地方是它的缺省分支** |
> | `verify:ui` D4b 第一版是**装饰判据** | 夹具给 `ask_user` 传了数组而它要换行字符串 → 在到达 `QuestionChannel` 之前就报错。摘掉 AUTO 那一支，判据照样绿 —— 与 `read_blob.line_offset` 一字不差：**判据打在下游，跨不过出事的那一跳** |
>
> 处置：四个写工具的边界判定收敛成 `fs-common.ts` 的 `writeBoundaryRefusal()`
> **一份**（各写一遍的后果不是重复，是**分叉**）；两条错误表述都回源改正；
> 顺手删掉两个零消费者的导出。判据 198 → **221 条**。
>
> **第 1、4 两条都是注入实测抓到的，读代码看不出来。**

> ### 【定】二次评审（codex，NO-GO）：6 项 P1 里混着**三类性质不同**的东西
>
> 逐条回源之后成立的全部修完，但**分级重排过** —— 把「我引入的」与
> 「一直如此的」记成一笔，是这个仓库最不愿意留下的账。
>
> | 类 | 项 |
> |---|---|
> | **本批引入（阻断）** | 交付物 containment（P1-1）· CLI 审批面反向保证（P1-4）· elevation 不可撤销（P1-3）· 失败请求改变安全状态（P1-2 / P2-3）· 冻结档位不进审计面（P2-5）· 判据缺口（5.1 / 5.3） |
> | **既有账**（一并修，分开记） | CONFIRM ≠「每一步都问」（措辞，行为是决 3 的设计）· `USER_REJECTED` 归责 · 带值参数缺值 · 自动批准日志不剥字符 |
> | **打折** | P2-2 只采纳「非法值 fail-fast」（缺字段仍按事实读）· P2-7 降 P3 · 「elevation 不覆盖 ask_user」是产品语义不是缺陷 |
>
> **最重的两条都是"我自己写的话被实现推翻"**：
> ① `write_file` 在 UNRESTRICTED 下写到 workspace 外后，产物**通过 hash 检查、
> 进 `deliveredArtifactIds`** —— 检查器算 `resolve(workspaceRoot, path)`，
> 而绝对路径原样返回自己。它直接推翻本文代价③。
> ② CLI 审批面照旧打印「只能写 workspace 与 $TMPDIR」，而**警告就写在那段
> 注释里**（「与 description ①、Web 审批卡是同一句话的三处，必须一起改」）。

> ### 【定】同一天三次「判据落在守卫重叠区」——**注入实测是唯一发现方式**
>
> | 判据 | 症状 |
> |---|---|
> | P2-3（失败请求不留提升） | 单摘 kind 校验不红（回滚兜住），单摘回滚也不红（kind 校验挡住），**两道同摘才红**。两道防的是不同的事（伪造 kind ／ 两步之间被 cancel），只在一个可观察量上重合 —— 已如实写明它测的是合取 |
> | P2-4（带值参数缺值） | 三个用例全被**枚举校验**先接走，缺值检查从没被触发。只有「参数是 argv 最后一项」那种形态它才承重 |
> | 归责（P1-6） | 夹具用了 `append_log`（`requiredForSuccess: false`），拒绝它不产生未完成的必需项，**两侧都判 SUCCESS** |
>
> M4 那条（一条不准的 kills 比没有更糟）在同一天出现三次。
> 结论不是"要记住"，是**每加一条判据就必须做一次注入实测** —— 三次都是跑完才发现的。

> ⚠️ **仍然开着的门槛（要花钱）**：用真实端点在 `--approval auto` 下把那道
> B 站的题跑完。当前证据全部来自脚本化模型，链路形状成立，
> **不证明模型在 UNRESTRICTED 受信事实下的真实行为**（它会不会更爱用 `rm -rf`
> 这类一步到位的写法，只能靠 live 复跑观察）。
>
> ⚠️ **CLI 审批提示里的 `a` 键（本次 Run 不再问）没有机械判据**（S6-6）。
> Web 那一侧有 D5 端到端覆盖，CLI 这条只有代码审读 —— 登记而不是假装它测过。


### 通用 MCP 客户端能力（2026-08-31）：外部工具面接进来了

依据 [ADR-0011](sxw_aicoding/ADR/0011-通过外部-MCP-接入浏览器能力.md)。
起因是**一次真实的内网实测失败**：「访问内网网页 → 归档」第一步就断，
因为它撞上 `fetch_url` 两条已拍板【定】的**交集** ——
护栏 2 拒私网（且 `retryability: NEVER`，模型不会换写法重试）＋「不做登录态、
不做 Cookie、不做浏览器」。这不是修 bug 能解决的，**它要求反转一条已拍板的决定**。

```bash
cp mcp.example.json .workagent-state/mcp.json    # 配好就能用，不用改任何代码
npm run ui                                        # 浏览器任务用这个入口（见下）
```

新增 `tools/mcp/`（`@workagent/tools-mcp`）。运行期依赖 **3 → 4**
（`@modelcontextprotocol/sdk`，17 个直接依赖 / 实测新增 94 个包），
`verify:all` **165 → 198 条**（v1 交付 183，二次评审收口 +10，实测收口 +5），边界 grep 扩到 **13 条**（编号到 12）。

> ### 【定】它的价值不在「能开浏览器」，在**凭证从头到尾不进 Atlas**
>
> 人在浏览器里登录，Atlas 只拿渲染后的内容。给 `fetch_url` 加 cookie 参数则
> 立刻要求一整套凭证解析、脱敏与 Trace 隔离机制 —— 而全仓没有那个东西
> （`SecretResolverPort` 那个空壳刚在 current-only 那批被删掉，
> 注释写着「要做的那天先写实现」）。走 MCP 一行凭证代码都不用写。

> ### 【定】能通用的秘密是**不翻译 schema**，抄自 opencode
>
> 读了 opencode 的 `mcp/catalog.ts`：`convertTool` 是全部抽象、约 40 行 ——
> `inputSchema` 原样交给下游，**从不试图理解它**。
>
> 最自然的处置是「扩校验器支持 array / object / enum」。**不能这么写**：
> 枚举就永远有下一个构造（`$ref` / `oneOf` / `prefixItems`…），
> 而下一个构造就是下一次「接个新 MCP 得改 Atlas 代码」。
> 改成**最小翻译** —— `validateAndNormalize` 变成「认识的照校、**不认识的原样放行**」。
> 失败方向按外部工具定：拒绝一个不认识的构造，后果是**整个工具废掉**
> （模型看得见、调得动、每次被 Runtime 挡在门口，且它无从改对）。
>
> 代价是索引签名让自家工具的关键字拼写错误不再被编译器抓住。
> 对价是 `verify:tools` **B4 段**：自家工具的属性必须是标量、且只带 `type` / `description`。

> ### 【定】二次评审抓到：**「不翻译」这条我只做到了一半**（2026-09-01）
>
> 入参那一侧漏了一个洞，而它恰恰推翻了这一批唯一的卖点。
> `normalizeSchemaShell` 会给没有 `properties` 的 schema **伪造一个空的**，
> 然后 `validateAndNormalize` 按这份伪造把模型入参**整个裁掉** ——
> 校验通过、下游收到 `{}`、零报错。根级 `$ref` / `oneOf` /
> `additionalProperties` / `patternProperties` 的服务器，接上就是坏的。
>
> **成因值得记**：过程记录里我明确论证过「未声明字段仍然丢弃，**这条不用改**」，
> 理由是「模型不该发未声明字段」。那句话只有在 `properties` 完整覆盖所有参数时
> 才成立，而**那是一个解析过 schema 才能下的判断**。
> 我一边写着「从不试图理解那个 schema」，一边用了一个需要理解才成立的假设。
>
> 处置：`properties` 改可选，裁不裁按 **JSON Schema 的标准语义**判
> （缺省允许，只有显式 `additionalProperties: false` 才丢），
> 自家 14 个工具显式写上那一行。两类工具走**同一条规则**，
> Runtime 因此仍然不需要知道「有 MCP 这回事」。
>
> ⚠️ **注入实测推翻了方案里写的靶子**：把伪造 `properties` 的写法加回去，
> 判据**照样全绿** —— 承重的只有 `validateAndNormalize` 一处（`{}` 与
> `undefined` 在那条路径上等价）。那处改动仍然保留（不该向模型谎报 schema），
> 但**不能声称它是守卫**。与阶段 3.5「几条 `kills` 声称的因果不成立」同形态。

> ### 【定】三条 P1 是同一个形态：**说了「理解了才能说的话」**
>
> 这一批的全部前提是「Atlas 不理解 MCP 的参数与返回」，而实现里有三处违反了它：
>
> | | Atlas 说了什么 | 它实际知道什么 |
> |---|---|---|
> | 脱敏 | `safeMessage` 的契约是「**已脱敏**，可展示给用户」 | 塞进去的是未经处理的服务器原文 |
> | 入参 | 按伪造的 `properties` 裁剪 | 服务器没声明 properties |
> | 审计 | `riskFacts` 有、`dataMovement` 无 ＝「没有数据外发」 | 去向完全未知 |
>
> **Case B 的 `SUCCESS` 是第四个实例**：Atlas 宣称成功，
> 它知道的只有「zip 的 PK 魔数与 EOCD 完好」。
>
> 由此得到一个可复用的动作：**凡是 Atlas 对 MCP 说出的每一句话，
> 先问「这句需要理解参数才能成立吗」** —— 需要，就不许说，或者如实说「我不知道」。
>
> `dataMovement` 的处置是**如实记「无法解析」**（先例：`effect-resolver.ts` 对
> 解析不了的 URL 写 `"(无法解析)"`）。**「解析不了」不等于「可以不记」**：
> 一个不存在的字段与「查过、没有外发」在事后完全不可区分。

> ### 【定】审批**不是** MCP server 的安全边界（ADR-0011 已改写）
>
> ADR 原来同时写着「进程能读 `.env`、能联网、能任意写」和「唯一还在的闸门是
> 审批和人」—— **这两句不能同时成立**。`connectMcpServers()` 跑在 compose
> **之前**：在任何 Run、任何 ActionProposed、任何审批之前，那个进程已经以
> 宿主用户身份跑起来了。
>
> 准确表述：**写入或选择 `mcp.json` 的人，已经向那条 command 授予了宿主用户级的
> 代码执行权。** 逐次审批只约束「模型发起的**某一次** tool call」。
> 示例配置因此**锁版本、不用 `@latest`**。

> ### 【定】声明的来源只能是**人**，不读 MCP 的 `annotations`
>
> MCP 协议一个 Atlas 必填字段都不提供，而 `Tool.annotations` 里的
> `readOnlyHint` / `idempotentHint` 看起来正好能填上。**一行都不许读** ——
> 它们是服务器自述的，拿它决定审批档位等于**让被审计方书写自己的审计规则**
> （与 `shouldUseSandbox` 那条「命令名匹配不是安全边界」同源）。
>
> 配置里一个词说三件事：`"read"` = 只读 ＋ 幂等 ＋ 自动放行 ＋ 报错记 `NO_EFFECT`；
> `"execute"`（默认）= 非只读 ＋ 非幂等 ＋ 逐次审批 ＋ 报错记 `UNKNOWN`。
> **用 `read` 不用 opencode 的 `allow`**：`allow` 表达偏好、`read` 表达属性，
> 而从「别问我」推出「所以它只读」是一次不成立的合并 ——
> 那会让 Atlas 在事实表里写假话。

> ### 【定】`execute` 默认档有一个已回源码确认的后果
>
> `sideEffectState: UNKNOWN` → `settle-batch` push RecoveryItem →
> `settle-outcome` 降成 `COMPLETED_WITH_LIMITS`。**不会**触发 `RECOVERY_REQUIRED`，
> 但 **execute 档每报错一次，这个 Run 就再也拿不到 `SUCCESS`**。
> 浏览器自动化里报错很常见，所以跑几次之后**应该**把只读工具标成 `"read"` ——
> 不是嫌审批烦，是不想让那个降级信号变成**一盏永远亮着的灯**。

> ### 【定】不得复用 `scopeKind: "PROCESS"` —— 会让审批面**说假话**
>
> 审批展示按 `scope.kind` 分派，而 `PROCESS` 那一支是 `run_shell` 专属的：
> 它读 `input["command"]`，并打印「沙箱：只能写 workspace 与本次调用的 `$TMPDIR`」。
> **MCP 工具没有任何沙箱** —— 复用它的后果是人在批准的那一刻看到一句
> **方向相反的保证**，而命令原文那栏是「(读不到命令原文)」。
>
> `main.ts` 那句「按 scope.kind 判而不是按工具名判，将来任何一个 PROCESS scope
> 的工具都自动获得同样的展示」**是对的，而这正是它的陷阱**：展示按 scope 泛化，
> 内容却按工具特化。处置是新增 `EffectScope.kind: "EXTERNAL_TOOL"` ＋ 成对的
> CLI / Web 展示（服务器名 ＋ 工具名 ＋ **完整入参 JSON** ＋ 一行「不在沙箱内」）。
> **整份入参、不挑字段** —— Atlas 不解析 MCP 的参数，挑就等于假装看懂了它。

> ⚠️ **四条代价，写在 ADR-0011 里，一条都不许假装没有**：
> ① 沙箱不在（`run_shell` 有 seatbelt，MCP 子进程没有，唯一闸门是审批和人）；
> ② **护栏 2 被绕过 —— 而这正是它有用的原因**（两个工具对同一件事给出相反答案，
> 必须写明是刻意的，否则下一个人会来「统一」其中一个）；
> ③ 登录态是 transcript 之外的隐藏状态（与阶段 3.5 拒绝持久 cwd 同形态，
> 区别是这次那个隐藏状态就是用户要的东西本身）；
> ④ **Atlas 的 workspace 边界对 MCP 子进程不成立** —— 不是弱，是不存在：
> `riskFacts` 永远不会出现 `OUTSIDE_WORKSPACE`，因为没有任何东西在解析那些参数。

> ⚠️ **浏览器任务用 `npm run ui`，不要用 `npm run dev`**。MCP 进程绑 Atlas 会话，
> CLI 单次命令结束即退出 → 浏览器关闭。

> ### 【定】交付集合里只放**最终版本**（2026-09-01 实测逼出来的）
>
> 实测 Run `run_18c20267c1a1`：上一个 Run 在 workspace 留下了 `images.zip`
> （6.25MB / 49 个文件），而 `zip -9 ../images.zip …` 对**已存在的归档是追加**：
>
> | | |
> |---|---|
> | v2 | 6,412,214 B —— 上次的 49 个 ＋ 这次的 2 个，**内容是错的** |
> | v3 | 155,558 B —— 模型看到 stdout 后 `rm` 重做，正确 |
>
> 两个版本**都 `ok`**（v2 确实是个结构完好的 zip，检查器没判错），于是
> `deliveredArtifactIds` 同时列着它们 —— Atlas 宣称交付了**两份同名产物**，
> 而磁盘上只有一份，另一份的 6.4MB 已经不可取回。
>
> 【定】**被后续版本取代的产物不是「交付物」，是中间状态。**
> 它与 §17 已有的两条同源：不许把坏的列进去、不许把 INTERMEDIATE 列进去 ——
> 三条都是「交付集合里不许出现一个对外宣称而实际不成立的东西」。
>
> 失败方向按「最终 / 被取代」分流，**不是一律降级**：
> 最终版本坏 → `FAILED`；被取代的版本坏 → `COMPLETED_WITH_LIMITS`
> （过程有瑕疵，最终交付物是好的）。被取代的失败**不许丢掉** ——
> 丢掉的话「产出过坏产物后来自己修好了」与「一次就做对了」在结算上不可区分。
>
> ⚠️ **两条注入实测缺一不可**：改回「ok 的全收」→ 翻红；
> 退化成「只留全局最后一条」→ 另一条版本链消失，也翻红。
> 少了第二条，一个恒返回单元素的实现照样能让第一条绿。

> ### 【定】ADR-0010 的「旧文件不得冒认」拦不住上面那个，而那是**对的**
>
> 那道守卫问的是「命令碰没碰它」（`mtimeMs + size` **完全没变**才拒），
> 而 `zip` 追加**真的改了**这个文件。它没判错，是问题不在它的射程里。
>
> 真正缺的那一半已补上：`ProducedArtifact.replacedBytes` ——
> 「执行前同名文件有多少字节」。`run_shell` 早就在 `artifactNote` 里说了这句话
> （模型正是靠它发现问题的），但**那条事实只活在 tool result 的文本里**，
> 人在 Trace / 事件流 / 界面上一个字都查不到。形态与 `dataMovement` 那次
> 一字不差：撑着结论的依据从未离开产生它的函数。
>
> 【定】`undefined` 与 `0` 是两件事 —— 后者说的是「执行前那里有一个空文件」。
> ⚠️ 反向判据**必须打在 `run_shell` 上**：我第一版写在 `write_file` 那段，
> 而把 `run_shell` 改成恒填 0（让这个字段彻底失去判别力）时它**照样是绿的** ——
> 靶子与判据不在同一条路径上，`read_blob.line_offset` 那次的同族。

> ### 【定】「不做 `--user-data-dir`」是一句被实测证伪的话（2026-09-01 改）
>
> 这里原来写着「v1 不做 `--user-data-dir` 持久化（那是一份 Atlas 看不见也管不了的
> 凭证存储）」。**盘上的事实相反** —— Playwright MCP 默认就在做：
>
> ```
> --user-data-dir=…/Library/Caches/ms-playwright-mcp/mcp-chrome-d83d3ae
>
> ~/Library/Caches/ms-playwright-mcp/
>   mcp-chrome-aa1e1b6   29M      Default/Cookies                20,480 B
>   mcp-chrome-d83d3ae   34M      Default/Login Data             40,960 B
> ```
>
> **「我们不做」与「它不发生」是两回事。** 不传那个参数并不能阻止服务器用它
> 自己的默认 profile。所以代价 ③ 要按实情升级：登录态**不在内存里，在磁盘上**，
> 在 workspace 之外、跨 Atlas 重启存活，**Atlas 既不会读也不会清理**。
> 想清掉它只能手工删那个目录。
>
> 准确表述是「Atlas **不接管** MCP 服务器的 profile 目录」——
> 而不是「没有那样一份凭证存储」。这一条只改表述、不加功能
> （Browser Session 身份仍不做，2026-09-01 用户决定）。

> ### 【定】判据用**手写的假 MCP 服务器**，不依赖 Playwright
>
> 三条理由，第三条最要紧：拿一个真实服务器当夹具，测的就成了
> 「Atlas 能不能接 **Playwright**」，而这一批要答的是「能不能接**任意** MCP」——
> 用一个真实服务器校准正是本仓反复清理的过拟合形态。
> 夹具刻意造出真实服务器的那些难处：分页、数组参数、嵌套对象、
> `isError`、image 块、运行中的 `list_changed` 通知。
>
> **九条做过外部注入实测**（改坏实现 → 退出码必须非 0 → 改回）。
> 而那一轮抓到了 D 段第一版的真实缺陷：它直接调 `handler.execute`，
> 而 `validateAndNormalize` **根本不在那条路径上** —— 把 array 分支改成
> 无条件报错，那条判据**照样是绿的**。与摸底考试 `read_blob.line_offset`
> 一字不差：判据打在下游，跨不过出事的那一跳。
> **这是「每加一条判据就做一次注入实测」又一次证明自己 —— 读代码看不出来。**

> ⚠️ **v1 全程用假服务器验证，没有跑过真实 Playwright。** 四件事等实测回填：
> 有几个工具的 schema 装不上 · 审批问得烦不烦 · 模型会不会主动
> `request_handoff` 请人登录（摸底考试 B 组的结论是它**倾向零调用**）·
> 归档产物有没有被脱敏打花（脱敏选的是 `STANDARD`，与 `fetch_url` 一致 ——
> `STRICTEST` 的高熵串正则会把网页快照打成一片 `[REDACTED]`，
> **而模型没有办法发现自己拿到的内容被改过**）。

### Current-only 清理（2026-08-31）：兼容层、死面与命名一次性拆干净

依据 [current-only 清理实施方案 V20260831-01](sxw_aicoding/实施方案设计/current-only清理实施方案_V20260831.md)，
来源是三份评审（codex / zcode / claude）交叉核验后的合并结论。
**`typecheck` 现在含 `--noUnusedLocals --noUnusedParameters`**；`verify:all` **165 条判据**全绿。

> ### 【定】二次评审抓到两条**这一批自己引入的回归**，都在判据照不到的地方
>
> | | 形态 |
> |---|---|
> | `Terminal.incompleteItems` 被填成 `[]` | `LoopTerminated` 同时装 `terminal` 与 `outcome`，于是同一行 JSONL 里两份「未完成项」**必然不同**。我为了消一次重复结算写的它，旁边的理由还写着「两份必然相同」。处置：**删掉这个字段**（零消费者），不是填回真值 |
> | `segmentActive` 名字换了、极性没换 | 六处读写里**五处保持旧 `done` 极性**，只有 `aborterFor` 被我翻了 —— 字段自相矛盾。处置：统一为正向，并补一条**跑动中必须 `true`** 的配对判据 |
>
> **为什么 163 条全绿**：`terminal.incompleteItems` 零消费者 —— 任何判据都不会碰它，
> 而正因为零消费者，它才能被填成 `[]` 而不响。跑了全套判据的那份评审没发现，
> 只读代码的那份发现了。
>
> 这是决 6（没有消费者就删）的又一条论据：**留着一个没人读的字段，
> 等于留着一块判据照不到的地方。**
>
> 同批还修了：`run-host` 的 `?? "CREATED"`（已删枚举值，落在 typecheck 盲区）·
> transcript payload 解析失败静默吞成 `{}`（与删 `schemaVersion` 跳过同一形态，同文件另一处漏了）·
> 注册表落盘派生路径让「唯一出处」有了第二个出处 ·
> schema 断言先建表再检查（「声明强于实现」）· `--yes` 只删了一半。
> 逐条见[存量清单 §0.17](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)。

> ### 【定】不再有 migration 机制。schema 变了就删库重建
>
> 那套 runner（`schema_migrations` 记账表 ＋ 版本号 ＋ 逐条事务 ＋ 回滚）
> 三条 migration 的 DDL **全是 `CREATE TABLE IF NOT EXISTS`** —— 它从来没有
> 真的迁移过任何东西，只是把「按顺序建表」包了三层。
> 换成一份当前 Schema ＋ 一道**形状断言**：列集合不符就抛，并打印 `rm <path>`。
> **空库才建；非空库在动任何 DDL 之前先完整验**（表集合 ＋ 列 ＋ 索引名，
> 缺表/多表/多余的 `schema_migrations` 都报），失败关连接再抛。
> 第一版是「无条件建表再断言」，那仍是隐式修补：缺表的旧库会被**先补上**再检查。
> 判据在 `verify:persistence` D 段（原来那段测的是 transcript 逐行版本降级，
> 一个**为不存在的数据**维护的证据），注入实测过：摘掉断言当场翻红。

> ### 【定】存储位置只剩一条规则：`<workspace>/.workagent/`
>
> 此前有两套 —— CLI 固定用 `.workagent-state/runs.db`，界面新建的 workspace
> 用 `<ws>/.workagent/`，而服务启动时还专门把注册表的默认值**覆盖回** CLI 那条，
> 注释写着「换成新默认等于让已有的 Run 一夜之间从界面上消失」。
> 那是为历史数据保留的第二套规则。现在 `workspaceStorage()` 是唯一出处，
> 两个入口共用；`.workagent-state/` 只剩跨 workspace 的注册表。

> ### 【定】被删掉的不是「没用的字段」，是**会误导的承诺**
>
> | 删的 | 它承诺了什么，而实际没有 |
> |---|---|
> | `hasUntrustedContext` | 三跳传到 `evaluatePolicy` 并落地，而函数体**从未解构过它** —— 读代码的人会以为 trust 参与了 Allow/Deny |
> | `ToolSnapshot.contentHash` / `AgentSpecSnapshot.contentHash` | 名字是 hash，值是 `name@version` 与人工常量 `"micro@0.1.0"`，零读取点；真 hash 由 `run-repository` 现算 |
> | `retryPolicy` / `cancellation` / `requiredCapabilities` / `observationCost` / `intervalMs` | 14 个工具逐个认真填，Runtime 零消费 —— 工具作者会以为 Harness 提供了重试、能力校验、协作式取消 |
> | `LoopPolicySnapshot.maxTurns` / `maxConsecutiveFailures` | 与 `RunBudgets` 同名字段重复、零读取点 → 「改哪个才生效」有两个答案 |
> | `irreducibleExceedsHardLimit` | 带一整段「两种处置在 D-05 里是分开的」，而主循环只读 `status`，第二种处置不存在 |
> | `ContextItem.redactionApplied` | 恒 `true`，而它是不变量 13 的名义载体 |
> | `--yes` | 文档里承诺、`parseArgs` **从来没解析过** —— 能用只因为默认档位本来就是它 |
>
> 连带删掉的还有：`CapabilityLeasePort` / `SecretResolverPort` 两个空壳 Port
> （注释自己写着「明确不做」）、`InMemoryTranscriptStore`（自述「历史证物」）、
> `MIGRATED_TOOL_NAMES`（服务对象是**空集** —— 那些 Run 本来就不能 resume）、
> `STAGE1_ACTIVE_*` 别名、`RegistryFile.version` 半套 schema 门、
> 以及一批零生产者的枚举值（`WAITING_FOR_USER`、`CREATED`、4 个 `Continue` reason、
> 8 个 `ContextItemKind`、`BLOB_REF`、`CACHE_BREAKPOINT` …）。

> ### 【定】接线的两条比删掉的三十条重要
>
> **`observePairingError` 接上了生产路径。** 三条漂移规则里唯一 FAIL_FAST 的那条，
> 此前**只有 `verify:drift` 调得到** —— 因为它的签名是 `(httpStatus, message)`
> 而主循环只有归一化后的 `RuntimeErrorRecord`。判别式换成 Runtime 自己的词汇
> （`source === "MODEL_PROVIDER" && category === "PROTOCOL"`）之后，
> 循环纪律第 5 条仍然成立，而规则第一次真的能在运行中触发。
>
> **`riskFacts` / `dataMovement` 上了 `ActionProposed` 事件，并接到投影与界面。**
> `policy.ts` 把「让外发在 **Trace 上**可审计」列为「越界读放行」的三条护栏之一，
> 而此前它们**从未离开过 Resolver 的返回值**；`verify:artifact` D 段更是直接
> 调 Resolver 取值——**判据绕过了它声称在测的那条链路**。一条撑着已生效决定的依据，
> 在盘上和界面上都查不到。判据已改为读事件，注入实测过。

> ⚠️ **本批修掉一个还没引爆的雷**：`ACTIVE_ERROR_CATEGORIES` 写着
> 「QUOTA / RATE_LIMIT **刻意不登记**：当前没有任何代码路径产生它们」，
> 而形状适配器的 429 分支两个都产生、`run-loop` 还专门读 `category === "QUOTA"`。
> 也就是说一次真实限流会在开发期被 `assertActiveErrorDomain()` 抛成
> 「错误值域越界」。**又一处写在权威位置、与它声称描述的代码不符的话。**

**阶段 4 产品化半边完成（2026-08-30）：Atlas 有白盒界面了。**
依据 [阶段 4 实施方案 V20260830-01](sxw_aicoding/实施方案设计/阶段4实施方案_V20260830.md)。

```bash
npm run ui        # → http://127.0.0.1:<随机端口>/?t=<会话 Token>
```

`apps/workagent-service`（Layer 2）＋ `apps/workagent-ui`（Layer 1）。
六个视图：时间线 / 逐轮解剖 / 预算 / 产物 / Trace / 恢复；审批 · 提问 · 接管三条通道
在浏览器里应答，用的是**与 CLI 同一批注入点**（`ApprovalDecider` / `HandoffChannel` /
`QuestionChannel` 接口一个字没改）。左上角可以**选目录、新建 / 切换 workspace**。`verify:all` 涨到 **14 条脚本 / 163 条判据**（阶段 4 交付时是 151，2026-08-31 图片打包任务评审批 +6，二次评审批 +6），
边界 grep 扩到 **12 条**（编号到 11）。**Case 02 不在本批**（决 1）。

> ### 【定】研究问题的答案是「几乎能，差一处」，那一处比一屏绿判据重要
>
> 问的是：执行事实能不能只靠既有的事件流、transcript 与三个 Port 注入点投影成
> 白盒界面，而 **Runtime Core 一行不改**？
>
> 差的是**八条预算轴的 `axis → [used, limit]` 对应表** —— 它只在撞墙时对外说一句话
> （`Budget*LimitReached` 各带一条轴），没撞墙的轴在 Runtime 之外完全不可见；
> 而「八条轴现在各自离墙有多远」是白盒最基本的一屏。
> 处置：从 `checkBudgets()` 里把表提成 `readBudgetAxes()`，**`checkBudgets` 自己跑在它上面**。
> 提出来的是**读数**不是判定 —— §5.2「合法状态迁移不由 UI 拥有」不因此松动。
>
> **不让 Layer 2 自己拼这张表的理由：它拼不对，而且错了不会有任何征兆。**
> `inputTokens` 轴读的是 `billedInputTokens`，照字段名拼的人一定拼成 `inputTokens` ——
> 界面显示「用了 3 万」而真正会撞墙的是 42 万（主循环那条 1482% 假漂移的同族）。

> ### 【定】D-2 是这个界面的前提，实测数字在这里
>
> 只喂事件流投影 → 3 条工具活动、**有入参 0 条**（`ActionProposed` 只有 toolName/effect）；
> 只喂 transcript 投影 → **0 轮**逐轮解剖（没有 stopReason / usage / 帧构成）。
> 两条轨道各缺一半，能对齐它们的**只有 D-2 那条统一序列** ——
> 阶段 2 把它列为开工前置时写的理由是「§23.2 的 Layer 2 投影游标没法收拾」，
> **这个界面就是那个投影**。当初若是两个计数器，合并根本写不出来。

> ⚠️ **一条仪器缺陷，记在这里因为它比它修掉的问题更值得记**：
> `verify:ui` E 段「非 loopback Host 应当被拒」第一次跑打了 200，而 curl 打同一个服务是 403 ——
> `Host` 是 fetch 规范里的 **forbidden header**，Node 的 `fetch` **静默丢掉**它。
> **代码是对的，仪器是坏的**：那条判据连错误的值都送不出去，它只可能是绿的。
> 改用裸 socket，并补一条「Host 正确时必须 200」的配对判据 —— 少了它，
> 一个拒绝一切的服务与一个正确的服务不可区分（阶段 3.5 的沙箱栽过同一跤）。

> ⚠️ **仍然开着的门槛（要花钱）**：用真实端点在界面上跑完一个多轮任务。
> D 段是脚本化模型驱动的，证据等级是 **smoke**（链路形状成立，不证明真实体验）。

### 阶段 4 收口：四份评审的处置（2026-08-30）

四份独立评审（zcode / pi-kimi / pi-glm / codex），**codex 给的是 NO-GO**。
逐条回源码复核 ＋ 能实测的都实测之后：**绝大多数成立，其中 7 条推翻了我自己
上一轮打的绿勾**。修完 24 项，见[存量清单 §0.13](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)。

> ### 【定】被证伪的门槛比任何单条 bug 重要
>
> | 上一轮宣布的 | 实情 |
> |---|---|
> | 「凭证不外泄 —— 扫所有响应体」 | E 段扫了 state/detail/trace，**漏了唯一直接返回文件正文的 `/api/artifact`**。实测：workspace 内一个指向 `.env` 的 symlink，接口返回 **592 字节含真 key** |
> | 「SSE 重连不重不漏」 | 判据测的是手工 `?since=`，真实 UI 走原生重连 ＋ `Last-Event-ID`，而**服务从不读那个头** |
> | 「预算八轴」 | **从来没有正确渲染过** —— CSP `style-src 'self'` 吃掉内联 style，八条轴全是满格 |
> | 「Trace 按段带 commit/gitDirty」 | 对 **Web 段**不成立（只写 event 行） |
> | 边界 8 有判别力 | 实测证明的是「往 `public/` 放文件会红」，**不是** ADR 声称的「加构建步骤会红」 |
> | 「自动放行两入口共用」 | 共用了，但**正分支零判据** —— 回退成 E-3 那个 bug，全套验收照样绿 |
>
> 共同形态还是那一条：**判据测的不是它声称在测的东西**。
> 上一轮我刚为此拆掉一条自己写的装饰判据，然后在另外六处犯了同一类错。

**修掉的四条安全项**（都实测复现过，也都实测复验过）：

| 项 | 发现时 | 现在 |
|---|---|---|
| `/api/artifact` 是任意文件读 ＋ symlink 逃逸 | 返回 `.env` 真 key | 按 **runId ＋ artifactId** 取，走 `isInsideWorkspace` 的 realpath |
| trace 路由 `%2f` 穿越（`[^/]+` 拦不住 percent-encoded 斜杠） | 逃出 traceDir 返回 367 行 | 路由层 runId 形状白名单 |
| 审批面板不剥 Unicode 双向/零宽 | RLO/PDF/ZWSP **3 个原样进 DOM** | `stripUnsafeDisplayChars()` 提到 compose，两入口共用 |
| 失败的 resume **锁死服务** | 终态 Run resume → 后续 start/resume 全 500，只能重启；而报错还让用户「取消它」，取消不管用 | 首事件 try/catch ＋ 前台槽位同步占位/释放 |

> ### 【定】最危险的那条是语义的，不是安全的
>
> **`RECOVERY_REQUIRED` 的 `recoveryItems` 被丢掉了。** 那个状态按 §10.4 是
> **非终态、按定义没有 outcome**，而 `detail()` 只从 `outcome.recoveryItems` 取 ——
> 于是界面显示「状态未知的副作用：（无）」，同时照常给出 CONTINUE / ABORT 按钮。
> 仓里有【定】说「只有显式决策能销账」，而**一个盲着做出的决策不是决策**。
> 修法是优先从 transcript 的 RUN_META 读（跨进程仍在的权威副本）。

> ### 【定】又一条装饰判据，又是注入实测当场拆掉的
>
> D3 段第二条第一版写的是 `kind !== "USER_REJECTED" && approvals.every(...)`。
> 注入实测（把档位改回 E-3 那个写法）时第一条如期翻红，**这一条照样绿** ——
> 那时 Run 挂住了，一个审批事件都没有：**空数组的 `every()` 恒真**。
>
> 这是连续第二批出现同一形态。结论不是「要记住这条教训」——
> **是每加一条判据就必须做一次注入实测**，靠记是记不住的：两次我都是写完之后才发现的。

### Workspace 选择与切换（2026-08-30，同批关闭 S4-5）

界面左上角选目录、新建 / 切换工作空间。**做的顺序是反过来的：先关安全闸门，
再放开切换** —— 倒过来等于把一个已登记的坑（S4-5）做成一键可达。

> ### 【定】§18.3 的执行条件有**两维**，两条闸门并排
>
> | 维 | 闸门 | 换掉之后会怎样 |
> |---|---|---|
> | 端点 | `assertResumeEndpointMatches` | 协议校验强度、推理块档位、token 口径与 §18.2 三条分支的判定全变 |
> | **workspace** | `assertResumeWorkspaceMatches` | 未配对工具的观察、幂等重试、后续所有相对路径的读写、自动放行的判定，**全部换一个根** |
>
> 第二条到现在才有：`RunSpec.workspace` 从阶段 1 起就在类型里、**一直是 undefined**，
> 而 `resume()` 用的 workspaceRoot 来自当前 compose。CLI 时代它不易触发（要手打 runId），
> **界面把它变成了列表里一个按钮**。
>
> **身份由 realpath 推出**（`ws_<sha256(realpath)[0:12]>`）—— `isInsideWorkspace`
> 与 seatbelt 沙箱都按真实路径判，三处口径必须一致。
>
> **缺失那一档返回 `UNKNOWN_LEGACY` 不抛**：硬拒会把存量 Run 一次性变成不可恢复，
> 但要发一条事件说出「我无法核对」—— 一条放行了却没验过的闸门如果不说话，
> 与「验过并通过」事后不可区分。

> ### 【定】两道防线缺一不可
>
> **存储隔离**：一个 workspace 一套 `<ws>/.workagent/{runs.db,runs/}`，
> 于是「A 的 Run 出现在 B 的列表里」物理上不成立。
> **闸门**：万一有人显式共用一个库（`--db` 仍支持，阶段 2 的默认行为就是共用），
> 照样拦得住。
>
> 只做隔离不够 —— 共用库是**合法用法**，不能靠「大家都不这么干」保证正确性；
> 只做闸门也不够 —— 那样每次切目录都靠一条报错教育用户，而正确的默认
> 应该是**根本不会撞上**。
>
> ~~【定】启动时用 CLI 参数登记的那个 workspace 保留旧路径~~
> **这一条已于 2026-08-31 作废**：它是为历史数据保留的第二套存储规则，
> 而本仓不再兼容旧数据。现在只有 `workspaceStorage()` 一条规则。

有 Run 在跑时切换返回 **409**（不排队也不强杀：强杀会把正在写文件的 Run 停在半路 →
§18.2 第三条分支 → 要人来销账）。移除 workspace **只摘登记、不删文件**（§22.5）。

**阶段 3（通用能力面）开发完成（2026-08-28）。** 依据
[阶段 3 实施方案 V20260828-02](sxw_aicoding/实施方案设计/阶段3实施方案_V20260828-02.md) 四批 S1…S14。

> **范围在开工前被决 1 改写过**：原计划是「Case 01 网页归档」，改成**通用能力面**，
> 网页归档移出本阶段（Case 是尺子，不是模具）。评测与 Eval 按决 4 统一推到开发完成之后。

- **13 条验收脚本 115 条判据全绿**（**那是当时的数**；阶段 4 后是 14 条 / 163 条，见本文件开头），`tsc --noEmit` 干净
  （摸底考试 bugfix 批后 86 → 91；阶段 3.5 累计 +24：`verify:shell` 19、
  `verify:progress` +3、`verify:tools` +1、`verify:pairing` +1）
- 新增 `tools/` 层，默认装配 **14 个工具**（9 场景 ＋ 3 机制 ＋ 2 测量）；固定开销起步价 ≈ 2520 token
  （`fixedOverheadTokens()` = 工具数 × 180。此前各处文档写的「11 个 / 1980」是同一处算术错误：
  8＋2＋2 = 12，收口批统一更正。阶段 3.5 加 `run_shell` ＋ `ask_user` 后是 9＋3＋2 = 14）
- `BlobStorePort` ＋ 外置 ＋ `read_blob` 取回；`ArtifactStorePort` **重设计** ＋ Artifact 级 Verification
- Progress Guard（只做「在原地打转」检测）；人工接管全链路（`WAITING_FOR_INTERACTION` 的持久化 / resume / 等待扣除）
- 边界 grep 全部守住 —— **编号 1…7、共 8 条规则**（6b 算第 6 条的同族；**那是当时的数**，阶段 4 扩到 11 条）。
  阶段 3 新增第 6 / 6b 条，阶段 3.5 新增第 7 条；6b 与 7 都做过判别力实测。
  【定】打印的条数由 `BOUNDARIES.length` 推出，不写死 —— 这个表在阶段 3.5 之前
  就已经是「7 个条目被称作六条」，写死的数字不会随表增长

**阶段 3 关掉了哪些存量**：P1-1 / `interject` CLI 入口 / N-8 / P3-26 / U-3 / U-8 / R-2 派生缺口。
**明确不做**：`CapabilityLeasePort`（决 5，见 [ADR-0005](sxw_aicoding/ADR/0005-PARKED-lease-不做的理由.md)）、
`SecretResolverPort`、`cases/web-archive/`（决 1）、Eval 与 Replay（决 4）、
Planner / Memory / Sub-agent（决 6）、通用 Completion Gate（论据被探针推翻）。

> ⚠️ **两条退出门槛仍开着，都要花钱**（属评测范围，按决 4 不阻塞阶段 3）：
> 跨进程 resume 的真实端点实跑、DeepSeek 对照端点实跑（当前 401，已核实是端点侧拒绝）。

> ⚠️ **一条新登记的欠账**：`requiredCapabilities` **逐工具零消费** ——
> 14 个工具全都声明了它，无人读。已在每个声明处留注释，走 bugfix 阶段。
> 见[存量清单 §0.6](sxw_aicoding/存量BUG/存量问题清单_V20260824.md) 的 S3-1。

### 图片打包任务实测评审的处置（2026-08-31，M1…M5）

真实端点 ＋ Web 入口跑「把 B 站 opus 页的图片下载下来打包成 images.zip」
（Run `run_75f0d6afafa6`）。**产物完全正确**（11 项、CRC 通过、与页面内容图逐字节匹配），
问题全在「Harness 知不知道它是对的」这一侧。两份评审（zcode / codex）＋ 逐条回源复核，
修 5 项、新登记 5 项，见[存量清单 §0.15](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)。
`verify:all` **151 → 157 条**，新增 6 条**每条都做过注入实测**。
**二次评审又修 8 项、登记 8 项，157 → 163 条**，见[存量清单 §0.16](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)。

> ### 【定】最重要的发现是一条**收益为零的处方**，不是任何一个 bug
>
> 一份评审说「只读管道被迫审批是因为 `extractPrograms` 把引号碎片当成了程序名，
> 清干净噪声就能少问几次」。回源：**`analyzeCommand` 的只读判定从不读 `programs`**
> —— 那个文件自己就写着「只服务展示与审计，不服务任何判定」。
> 真因是元字符 `|`，而 10 条 shell 命令**每条都含元字符**。
>
> 噪声最后确实清了（M4），但理由换成了「泄漏面」，**并明确写了它减不掉任何一次审批**。
> 一条不成立的因果比一个没修的 bug 更贵：它导出的处方做完之后没有人会回头量。
>
> 同批还推翻两条：「心跳在下载期间持续可见」（实测三条 `ToolProgress` 全落在命令结束**之后**）、
> 「`/tmp` 失败是跨调用 TMPDIR 隔离」（curl 与 wc 在**同一条命令**里，解释不了）。

> ### 【定】M1：模型是按文档办事的，错的是文档
>
> `run_shell` 的 description 写着「只能写 workspace 和**系统临时目录**」，
> 而 R-8 早已把 tmp 收窄成 per-call `mkdtemp` ＋ `TMPDIR` 指过去 —— **那句话没跟着改**。
> 模型照着写 `/tmp`，沙箱拒、`curl -s` 吞掉错误，白花一轮。
>
> 这是「声明与实现不符」的又一形态：上次藏在 `MAX_TIMEOUT_MS` 与 `timeoutPolicy`
> 两个常量之间，这次藏在**一次正确的收窄修复留下的一句旧承诺**里 ——
> 收窄的人不会想到去改文案，而模型是这句话唯一的读者。
> 四处口径（description / 沙箱 / CLI 审批 / Web 审批卡）已统一。

> ### 【定】M2：省事的那个修法会**把做对了的 Run 判成 FAILED**
>
> 详见 [ADR-0010](sxw_aicoding/ADR/0010-二进制交付物走字节通道与按路径声明.md)。
> 根因不在 shell 工具，在类型签名：`ProducedArtifact.content` 是 `string`，
> 二进制在类型层就进不去 —— 连带**`kind:"zip"` 那个检查器从上线起没有任何生产者**。
>
> 「给 `run_shell` 加个 artifact 字段、内容按字符串传」的注入实测原始输出：
>
> ```text
> 磁盘上 out.zip 的真实字节数   166
> 登记的 sizeBytes            184      ← UTF-8 往返
> outcome.kind                FAILED   ← zip 其实完全正确
> ```
>
> 因为登记侧算 `sha256(content,"utf8")`，而第二层检查读的是**磁盘字节**。
> 处置：`content` 放宽为 `string | Uint8Array`，hash/size 按真实字节算；
> `run_shell` 新增 `artifact_path` ＋ `artifact_role`（**执行前**声明，进审批面 ——
> 人批准的不只是「跑这条命令」，还有「它自称要交付这个文件」）。

> ### 【定】M4 的判据我写错了**两次**，两次都是注入实测拆掉的
>
> 第一版用真实运行里那条命令的形态 —— 摘掉任一道守卫**都不红**（两道互相遮蔽）；
> 第二版换了形态，仍然不红 —— 那条 URL 带 `?sig=`，被一句**与本次修复无关的老逻辑**
> （跳过含 `=` 的 token）先吃掉了。最终用两条实测确认过「各自只被一道守卫挡住」的形态。
>
> 形态还是那条「判据测的不是它声称在测的东西」，但这次不是断言写错，
> 是**用例落在了守卫的重叠区** —— 读代码看不出来，只能靠注入。

> ⚠️ **M5（下载不 fail-closed）故意没有机械判据**：落点在 `run_shell` 的引导面，
> 只能靠 live 复跑验证。不加「description 里必须出现某个词」的判据（B 组已拒绝过），
> 也**不在 Runtime 里替模型加 `set -e`** —— 那是替用户改写他已经审批过的命令，
> 审批看到的与真正执行的从此不是同一条。

### 上一批的二次代码评审处置（2026-08-31，R1…R8）

两份评审（zcode / codex），**codex 给的是 NO-GO**。逐条回源后：修 8 项、登记 8 项，
`verify:all` **157 → 163 条**，见[存量清单 §0.16](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)。

> ### 【定】最值钱的两条是**上一批我自己引入的回归**，两份评审各抓到一条
>
> **R1 —— 一次「改进」把失败方向从看得见翻成了静默通过。** ADR-0010 那批加了
> `BINARY_EXTENSIONS`，把 jpg/png/pdf 路由到 `kind:"binary"`，而检查器对 binary
> **一项结构检查都没有**：
>
> | | `.jpg` 的处境 |
> |---|---|
> | 改之前 | 落 `text` → 编码检查 → **翻红**（看得见） |
> | 改之后 | 落 `binary` → 只有 hash → **静默通过** ＋ 进 `deliveredArtifactIds` |
>
> 而当时那段注释亲手写着「默认 binary（什么都不检查、静默通过）更糟」——
> **那句话恰好论证了它自己为已知扩展名移除掉的性质。**
> 处置把两件事绑死：`binary` 由**魔数表的键**推出，没有魔数的扩展名不算 binary。
>
> **R2 —— 我在修「声明与实现不符」的同一批里造了一个新实例。**
> `artifact_path` 的 description 我写的是「zip **能不能解开**」，而检查器自己的
> 【定】写着「只做结构判定，不真的解压」。形态与 M1 一字不差，读者同样是模型。

> ### 【定】R3：内容去重不得吃掉 provenance
>
> `ArtifactStore` 的去重只比 `content_hash`，查询也不按 runId 过滤 ——
> 旧记录会**连同它的 `run_id` 与 `role`**被当成本次登记的结果返回。
> 最容易撞上的不是跨 Run，是**同 Run 内 role 晋升**：先 INTERMEDIATE
> 后 DELIVERABLE 登记同一份内容 → 永远停在 INTERMEDIATE，于是
> §1.2 第 3 条「DELIVERABLE 检查失败判 FAILED」那条**强制力被静默降档**。
> 注入实测两半各自独立翻红，其中一半原样复现了「Run B 名下 0 条、
> 交付集合里躺着 Run A 的 artifactId」。

> ### 【定】R6 的夹具刻意用一个**结构完好**的真 zip
>
> 「把执行前就在那的旧文件冒认成本 Run 产物」交出去的不是坏产物，
> 是**别人的好产物** —— 它能过 zip-opens、能过磁盘 hash、能进交付集合，
> **既有判据一条都拦不住**。处置是执行前拍 `mtimeMs + size` 快照。
> 指纹**不用**仓里 `FileFingerprint` 的内容 hash：要答的是「命令碰没碰它」，
> 而内容 hash 会把「重新生成出逐字节相同的产物」误判成「没生成」。

> ### 【定】一条被推翻的机制判断，值得与被采纳的并排记
>
> 评审说「工具版本未升 → 旧 Run Resume/Replay **无法检测语义漂移**」。
> 回源：`ToolSnapshot.contentHash` 在 Runtime 里**零消费者** ——
> 根本没有那个检测器可被打败。版本仍然升了（免费），但**真正的缺口是
> 那个字段没接线**（S3-1 同族，登记 S5-8）。
> 同批还有两条后果被高估（zip 深度校验、timeout 生命周期），逐条见 §0.16。

> ⚠️ **一条成立但不能当 bug 修的**：「不声明 `artifact_path` 就没有交付物、
> 仍结算 SUCCESS」。它的退出条件「RunSpec 表达『必须交付 Artifact』的契约」
> **就是通用 Completion Gate**，而仓里记着它论据被探针推翻。
> 登记为 S5-7，**要一份重开那个决定的 ADR，不是补丁**。

### 阶段 3.5：内置 shell 执行（2026-08-30）

**起因是实测，不是路线图。** 用真实端点跑「访问网页 → 归档成含 markdown 与
images 目录的 zip」（Run `run_9610d44d3a62`）：**19 轮（预算 20）、6.5 分钟、
结算 `SUCCESS`，而 zip 不存在**。8 次 `write_file` 里 5 次在写模型自己跑不了的
打包脚本；模型三次明说「我没有 shell 执行能力」。而 `grep -rn '"EXECUTE"' tools cases`
当时是**零命中** —— Policy、`autoGrant`、`EffectScope.kind: "PROCESS"` 三处
早就为 EXECUTE 写好了分支，没有任何工具能触发它们。

新增 `run_shell`，并打通 `effectResolution` 的 `RESOLVER` 分支 —— 它从阶段 1 起就在类型里、一直抛错。

> ### 【定】两道闸门，职责不能混
>
> | 层 | 文件 | 判什么 | 判错的代价 |
> |---|---|---|---|
> | 一 | `tools/common/src/exec/command-analysis.ts` | 要不要**停下来问人** | **多问一次** |
> | 二 | `tools/common/src/exec/sandbox.ts` | 跑起来**能碰到什么** | **真的没有边界** |
>
> Claude Code 为第一层写了约 8500 行（`bashSecurity.ts` 2629 ＋ `bashPermissions.ts` 2621
> ＋ `readOnlyValidation.ts` 1990 ＋ `pathValidation.ts` 1303），因为它必须在**无人值守**下
> 决定 allow/deny。而它自己在 `shouldUseSandbox.ts` 文件头写着：命令名匹配是
> 「用户便利功能，**不是安全边界**」。
>
> 本仓有人在回路里，所以第一层可以只有 ~150 行：**判不出来就落 EXECUTE → 审批**。
> 失败方向固定在保守侧，规则就能粗暴到显然正确（有任一 shell 元字符 → EXECUTE）。
> **合并这两层必然出现的写法是「既然解析说它只读，那就不用沙箱了」—— 那正好把边界拆掉。**

四个决定：① RESOLVER 解析 ＋ `sandbox-exec` 真沙箱两道；② cwd / env **不跨调用持久**
（持久 cwd 是 transcript 之外的隐藏状态，resume 后 `cd` 的效果会丢且盘上看不出）；
③ 判定为只读的命令自动放行 —— 走的是**既有 Policy 的原生行为**，`policy.ts` 一行没改
（READ 不在 `requiresApprovalFor` 里）；④ 只加这一个工具，不加 zip / mkdir / rm / mv
四个专用工具（那会是 +720 token），把「一个通用 EXECUTE 能替掉多少专用工具」当研究问题。

**复跑同一道题**：zip 真的生成（`release-notes.md` 12039 字节 ＋ `images/`），
轮数 19 → 12，没有再出现写打包脚本的绕行。

> ⚠️ **实测撞出的两个坑，都记在代码注释里**：
> ① macOS `tmpdir()` 是 `/var/folders/…` 符号链接而 seatbelt 按**真实路径**匹配 subpath ——
> 沙箱一度把 **workspace 内的写也一起拒了**。它只在「验了能写的那一侧」时才暴露：
> 一个拒绝一切的沙箱与一个正确的沙箱，在「越界写被拦」那条判据下**不可区分**。
> ② 故障注入期间 `deny file-write*` 被摘掉那一次，真的在 `$HOME` 建出了探针文件，
> 之后每次 `existsSync` 都为真，判据被**永久毒化**。仪器不得在被测系统之外留痕。

> ⚠️ **默认档位下无人值守跑批时 EXECUTE 全灭**（非 TTY 审批按拒绝处置）。
> 这是 E-3 那个坑的形状，本批**不新增 `--yes-exec` 档位**去绕它 ——
> 那会又造一条没有证据支撑的闸门。复跑用 `--approval auto`，
> **此时沙箱是唯一还在的闸门 —— 这就是决 1 坚持要真沙箱的全部价值。**
>
> **2026-09-01 收口**：那条「等复跑数据说话」等到了数据（十几次点击），
> 处置见 [ADR-0012](sxw_aicoding/ADR/0012-审批与执行特权是两条正交的档位轴.md) ——
> 不是加第三条闸门，是把审批做成一条有名字的轴。上面那句
> 「沙箱是唯一还在的闸门」在 `--sandbox off` 下**不再成立**，见下。

### 阶段 3.5 的另两个工具（同批，2026-08-30）

**`ask_user`（机制工具）—— 问用户一道选择题。** [ADR-0008](sxw_aicoding/ADR/0008-ask-user-与-request-handoff-是两个洞.md)

> ### 【定】它与 `request_handoff` 是**两个**洞，不是一个
>
> `request-handoff.ts` 原本写着「它同时是 U-8 的落点 —— 两个洞是同一个」，
> 存量清单也据此把 U-8 记为阶段 3 已关。**回源核对 U-8 原文后：那句话对了一半。**
> U-8 说的是 `WAITING_FOR_USER` 这个枚举值零产出点 —— 状态机那一半确实关了。
>
> | | `request_handoff` | `ask_user` |
> |---|---|---|
> | 语义 | **你去做**一件我做不了的事 | **你来定**一个我定不了的事 |
> | `expected_completion` | **必填**，做完要能被观察到 | 不存在 —— 没有可观察的结果 |
> | 之后 | 必须重新 Observation（§20.3） | 直接用答案往下走 |
> | 没人时 | **失败**（那件事真的没做） | **不失败**，返回 NO_ANSWER 让模型自己定 |
>
> 硬要用 handoff 问偏好，模型必须为 `expected_completion` **编造**一个可观察结果 ——
> 而那个字段的全部意义就是「别信口头声明，去核实」。
>
> **教训比结论重要：「两个洞是同一个」这类合并判断必须回源核对原文**，
> 不能因为两件事表面上都「停下来等人」就合并。而这次的合并恰恰写在一处
> 看起来很权威的**文件头注释**里，它比清单本身更容易被后人当作依据。

触发它的实测：网页归档任务三次复跑对「`images/` 目录该放什么」给出**三种不同结构** ——
页面根本没有图片、任务本身有歧义，而模型没有任何办法问一句。三次都结算 SUCCESS。

**`fetch_url` 的 `as` 参数 —— HTML 默认转 Markdown。** [ADR-0007](sxw_aicoding/ADR/0007-html-结构转换可内置语义挑选不可.md)

> ### 【定】结构转换可以内置，语义挑选不可以
>
> 阶段 3 那条「不得内置任何正文提取逻辑」**一个字没改**。ADR-0007 划的是它内部的线，
> 判据是**换一个 Case 结论会不会变**：
>
> - `<h1>` 该变成 `#` —— 三个场景都一样 → **结构转换**，可以内置
> - 导航栏要不要留 —— 归档要丢、盘点站点要留 → **语义挑选**，仍然不做
>
> `verify:tools` I 段有一条判据钉住它：**转换后导航与页脚文本必须仍然在**。
> 它红了说明有人加了 readability 那类规则，从内部把决 1 绕过去了 ——
> 这件事此前「只有人读代码时守得住」，现在有机械判据了。

实测：`pi.dev/news/releases/0.84.3` **38280 → 13023 字符（削减 66%）**，
≈15312 → ≈5210 token。原链路上那 3 次 `read_blob` 直接消失。
**默认值是 `markdown` 不是 `raw`** —— 一个需要模型主动选择才生效的优化，
在真实运行里等于不存在（摸底考试题 3 的教训）。

### 阶段 3.5 收口：三份评审的处置（2026-08-30）

三份独立评审（zcode / pi / codex）逐条回源码复核，**codex 给的是 NO-GO**。
关掉 20 项、新登记 12 项，见[存量清单 §0.10](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)。

> ### 【定】最刺眼的一条：判定层的**失败方向反了**
>
> `command-analysis.ts` 的文件头写着「保守方向是 EXECUTE，判不出来就问」，
> 而实现**只看 `argv[0]`**。三份评审各自实测，得到同一批反例：
>
> ```
> READ ← 自动放行   find . -delete                  递归删除，不含任何元字符
> READ ← 自动放行   rg --pre 'touch /tmp/x' pat f   任意命令执行
> READ ← 自动放行   git reflog expire --all         摧毁仓库全部恢复元数据
> ```
>
> **元字符表挡住 `find -exec` 是偶然，不是设计** —— 它靠的是要写分号或大括号，
> 而 `rg --pre` 什么特殊字符都不带。「多问一次」这个自我安慰在**参数**这一层
> 不成立：错误方向恰好是**少问一次**。
>
> 处置是**两道**：白名单砍到只剩恒只读程序（`git` 整个移出 —— 它在沙箱里
> 本来就跑不了，读黑名单 deny `.git`），再加一道**写出口参数嗅探**。

另外三条安全项也在这一批修掉：

| 项 | 实测证据 |
|---|---|
| **子进程继承全部 env，含真实端点凭证** | `printenv dashscope_api_key` → `sk-ws-…`。改环境**白名单** ＋ 显式清 `BASH_ENV` |
| **审批界面可被 ANSI / CR / 零宽字符伪造** | 它是 EXECUTE 唯一的人工边界，而展示内容全由模型给 |
| **SSRF：`http://[::ffff:7f00:1]/x` 原本放行** | URL 解析器**总是**把 mapped 地址规范化成十六进制，而原规则只认点分十进制 —— 那条规则从没在真实链路上生效过 |

> ### 【定】我自己犯的那条，比上面几条更值得记
>
> A 段每条用例都带 `kills`（改坏哪里会让它翻红）。修完白名单后按惯例做
> 判别力实测 —— 把 `find`/`sort`/`rg` 加回白名单，**没有翻红**：
> 它们都带写出口参数，被第二道挡住了。
>
> **那几条 `kills` 声称的因果不成立。** 一条不准的 `kills` 比没有更糟 ——
> 它让人以为某处改坏会被抓住，而真去改的时候不会。
> 处置：按**真正的守卫**把用例分三组，对前两组各做独立注入实测。
>
> 同批还有一条同源的：`verify:shell` E2 那个「已改成断言关系而非常数」的
> 修复本身是**恒真式**（`overhead` 就是用 `names.length * 180` 算的），
> 而它已经被当成教训写进了实施记录。**记进教训里的装饰会被抄到第二处去。**

### 同批顺带修掉的一条崩溃路径

`settle-batch.ts` 的 `renderError(outcome.error!)` —— 一个非空断言掩着真洞：
**任何工具返回 `ok:false` 而忘了带 `error`，整个 Run 抛 TypeError 崩掉，
且批内配对被破坏（不变量 8）**。而 `tools/` 这一层的全部意义就是让工具包
能被独立地写、独立地接进来。已改为合成 `TOOL_CONTRACT_NO_ERROR`（点名违约，
不伪装成普通工具失败）。判据在 `verify:pairing`，判别力实测过。

它是改 `ask_user` 的 NO_ANSWER 分支做故障注入时撞出来的 ——
**故障注入的价值不止于验证判据，它还会撞出判据之外的东西。**

### 收口修复批次（2026-08-28）

三份独立评审（kimi / zocode / pi）逐条回源码复核后，**已确认成立的全部修完**，
见[存量清单 §0.7](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)。它关掉的两类：

1. **4 条判据自身没有判别力** —— Artifact 的 hash 检查是**内存自比**（恒真）、
   `verify:artifact` C 段、`verify:progress` D 段、`verify:scenarios` 总判定。
   后三条的共同形态是**抬头换了、verdict 没换**：段标题写着新判据，断言还是旧的那个。
2. **7 条声明与实现不符** —— `write_file` 的 `isIdempotent: false` 是为测量而标的
   （`types/tool.ts` 自己拿它当反面教材，见下）、`read_file`/`search` 的 HEARTBEAT 死声明、
   Guard「还活着」半边只写不读、`MAX_REDIRECTS` 死常量、README 停在阶段 1 口径等。

**三条判别力实测在实施时真跑过并翻红**：把 hash 检查改回内存自比、删掉 `search` 的
`onProgress`、删掉 `StdinChannel` abort 时清 waiter 那一行 —— 各自对应的判据当场变红。

### 摸底考试 Bugfix 批次（2026-08-28，A / A′ / B / C 四组）

[办公任务考卷 V1](考卷/V1/Atlas阶段3_办公任务考卷_V1_20260828.md) 实测 pass@1 = 4/9、NO-GO。
逐条回源码核对后的结论：**挂掉的不是能力面，是接线和仪器。**
题 2 三次全过说明工具面够用；题 1、题 3 各三次全灭，各由一条可定位的缺陷解释。
详见[存量清单 §0.8](sxw_aicoding/存量BUG/存量问题清单_V20260824.md)。

> ### 【定】为什么 86 条判据全绿而实测 4/9 —— 记住这一条就够了
>
> **每一处出事的地方，夹具都让「正确值」与「错误值」恰好相等。**
>
> - `read_blob` 的取回判据调的是 `ports.blobs.get()`，**从没经过工具那一跳** ——
>   而 `line_offset` 正是在 handler 里被丢掉的（`tools/common/src/index.ts` 只转发了三个参数）；
> - `makeUsage()` 把 `billedInputTokens` 直接赋成 `inputTokens`、cache 计数恒 0，
>   于是主循环把漂移观测点传成 `inputTokens` 也测不出来（真实端点上是 1482% 假漂移）；
> - `verify:budget` 给每条轴都注入 `Partial` 覆盖，证明的是**读取点**能用，
>   而 `DEFAULT_BUDGETS` 里两条 token 轴根本没值 —— 生产里八条轴只有五条活着。
>
> **所以新增判据时先问：这条判据要区分的两个值，在夹具里相等吗？**
> 相等就先去改夹具，再写断言。然后当场做一次「改坏 → 翻红」实测 ——
> 本批 8 条新判据每条都做过，其中 `maxTotalWallClockMs` 那条两个方向都试了。

四组修的东西：**A** 接线断（`read_blob` 参数透传、外置提示、漂移比错字段、
并行开关规则方向、两条 token 轴默认值）；**A′** 前缀缓存断点前移到 messages 末尾
（U-9 后半，原理由「messages 每轮都在变」在 `STRICT_PREFIX` 下不成立 —— transcript 是只追加的）；
**B** `request_handoff` 的引导面措辞（题 3 的模型分析全对却零调用，
被 system prompt 收尾那条更便宜的出口接走了）；**C** 在途模型调用挂预算 deadline
＋ 软限进模型上下文。

> ⚠️ **B 组在 `verify:all` 里拿不到判据**，这是边界不是遗漏：脚本化模型不会替你选工具。
> 它只能靠 live 复跑验证（题 3 × 3，`InteractionRequested ≥ 1`）。
> 不要为它硬造「description 里必须出现某个词」的机械判据。

### 改验收脚本前必读

**【定】退出码由 `harness.ts` 的判据登记表推出，不得手写布尔表达式。**
每次 `verdict()` 自动计入，`runVerify()` 负责收尾（并保证 `finally` 的清理先于退出跑完）。

理由是实测：阶段 2 期间有**四条判据算出来了、打印了，却没接在退出码上** ——
其中一条正是被实施记录列为「最有价值的发现」的那条。手写表达式漏一项不会有任何征兆。
D-25 决定不写单测，这些脚本就是本项目唯一的测量仪器；**仪器上有一根线没接，比没有那根线更糟，它还会打绿勾。**

同源的一条：`run-loop` 的 `persistFacts()` 每轮**整体重写** RUN_META，
漏写一个字段 ≠「这条没有」，而是**整个 Run 的那个累计量被抹掉**（`readRunFacts` 只读最后一条）。
`lastSequence` 和 `resumeBranchCounts` 都在这里栽过。加字段时必须同时改它。

> ⚠️ **`.env` 的 `dashscope_model` 与端点声明不一致会在启动时被挡下**（M-5）。
> 这个值在阶段 1 一直被静默忽略（实际用的是声明里的），阶段 2 把它变成了显式错误。
> 二选一：把 `.env` 改成声明里的 modelId，或为你想用的模型补一份端点能力声明。
>
> **同族的第三条，阶段 3 撞到的**：E-3 的自动放行规则要求 `REVERSIBLE`，
> 而 `write_file` 声明 `PARTIALLY_REVERSIBLE` —— **那条规则从来没覆盖过它唯一为之而写的工具**。
> 真实端点实跑才撞出来：模型正确做完了全部工作，两次写入被「无人应答」挡掉，
> 结算 `USER_REJECTED`，而全程没有任何人拒绝过任何东西。
> **一条闸门排在另一条后面，等于没有闸门** —— 新增校验都要有能单独触发它的判据。

GUI 在阶段 4（已交付，见本文件开头），阶段 1–3 全部 headless。
**终端与浏览器是同一套装配**：同一个 `compose()`、同一份工具集、同一个自动放行档位
（`autoGrantVerdict`）、同一个库、同一个 trace 文件。两个入口的差别只有一个：**「人在哪」**。

> ### 【定】浏览器与终端在「没有人」这件事上语义相反，不得抹平
>
> | | 无 TTY | 浏览器没连 |
> |---|---|---|
> | 含义 | **真的没有人** | 人可能只是关了标签页，**稍后回来** |
> | 审批 | 按**拒绝**处置 | **一直等**，直到有人应答或 Run 被取消 |
>
> 把两者做成同一种处置，会让「关掉标签页」变成「拒绝了这次写入」——
> 那正是 E-3 那条教训的形状（结算 `USER_REJECTED`，而没有任何人拒绝过任何东西）。
> 代价如实记：**无人值守跑批不要用 Web 入口，用 CLI** —— 那里的非交互降级是为它设计的。

## 常用命令

```bash
npm install                        # Node 24＋（.nvmrc / engines 都写了）
npm run typecheck                  # tsc --noEmit ＋ noUnusedLocals/Parameters，必须干净
npm run ui                         # ★阶段 4：白盒界面。打印一个带会话 Token 的 loopback URL
npm run ui -- --port 7788 --endpoint deepseek      # 端口/端点与 CLI 同一套参数
npm run ui -- --approval auto                      # ★ADR-0012：不再逐次确认（沙箱仍在）
npm run dev -- --approval auto --sandbox off --task "..."   # ★完全权限：**没有任何闸门**
npm run dev -- --task "看看根目录里有什么，然后写一份 summary.txt"
npm run dev -- --list-runs         # 库里有哪些 Run
npm run dev -- --resume <runId>    # 接上一个没跑完的 Run
npm run dev -- --resume <runId> --recovery-decision CONTINUE --recovery-note "已人工确认"
npm run dev -- --endpoint deepseek --task "..."   # 换对照端点（受枚举约束，拼错立刻失败）
```

**外部 MCP（ADR-0011）**：`cp mcp.example.json .workagent-state/mcp.json` 就能用，
不改任何代码；`--mcp-config <path>` 可换位置。配置文件不存在**不是错误**。

```jsonc
{ "servers": { "playwright": {
    "type": "local",
    "command": ["npx", "-y", "@playwright/mcp@latest"],
    "environment": { "PLAYWRIGHT_HEADLESS": "false" },
    "tools": { "browser_snapshot": "read" }   // 可选。不写 = 全部 execute（最保守）
} } }
```

> ⚠️ **`mcp.json` 放 `.workagent-state/`，跨 workspace** —— 与库、trace 的规则刻意不同。
> 理由是进程生命周期：MCP 绑 Atlas 会话、跨 Run 存活（登录态在浏览器进程里），
> 放进 workspace 目录的话切一次目录就等于**关掉浏览器**，而用户不会把这两件事联系起来。
>
> ⚠️ **连不上就抛，Atlas 起不来**（`"required": false` 可逐服务器放宽）。
> 降级成「少几个工具」的失败形态特别难查：同一句任务昨天能开浏览器今天不能，
> 而 Run 照常跑到底，最后告诉你「我访问不了那个页面」。
>
> ⚠️ **`tools` 段里的工具名拼错会报错**，并列出服务器真实提供的工具 ——
> 不这么做的话 `tierOf()` 会静默落回默认档：那行配置**看起来生效了**、实际什么都没变。

**两条档位轴（ADR-0012）**：它们**正交**，各一个参数，CLI 与界面同一套。

```bash
--approval confirm|default|auto     # 审批：要不要停下来问人（运行中可改）
--sandbox  on|off                   # 执行：跑起来能碰到什么（随 Run 冻结）
```

`default`（默认）＝ 决 3 那一档：自动放行 workspace 内、非 IRREVERSIBLE 的写；
不可逆操作与 EXECUTE 逐次问；**越界写由 Policy 直接拒绝**。
`auto` ＝ 一律自动批准。`--sandbox off` ＝ 无沙箱、可写任意路径、越界写改走审批。

> **没有 `--yes` / `--confirm` / `--yes-all` / `--yolo`**，而且**未知参数一律报错**
> （service 入口这条是 ADR-0012 补的，它此前是裸 `indexOf`）：一个被静默吞掉的参数
> 与一个生效的参数，在用户那里完全不可区分（M-5 那条教训的形态）。
> 【定】改这段前先读 `main.ts` 里 `autoGrant` 的注释 —— 那条规则曾经因为
> `REVERSIBLE` vs `PARTIALLY_REVERSIBLE` 的一字之差，从来没覆盖过 `write_file`。

**运行期交互**：TTY 下 stdin 是**单一通道**，按「谁在等」分派三种语义 ——
RUNNING 敲一句话回车 = 插话；等审批时回车 = 应答；等接管时回车 = 完成信号。
非 TTY 优雅降级（审批按**拒绝**处置，接管按「没有人」处置，都不挂起）。
`--workspace <path>` 指定工作目录（默认 `.workagent-workspace`）。
**【定】存储位置由 workspace 唯一推出**：库 `<ws>/.workagent/runs.db`、trace `<ws>/.workagent/runs/`，
CLI 与界面同一条规则（`workspaceStorage()`）。`--db` / `--trace` 仍可显式覆盖，`--no-trace` 关闭。
`.workagent-state/` 只剩跨 workspace 的注册表。

> ⚠️ **没有 migration**：库的表结构与当前 Schema 不符时 `openDb()` 直接抛，
> 并打印 `rm <path>`。删库重建，trace 的 JSONL 是独立轨道不受影响。

```bash
npm run verify:endpoint-profile    # 端点差异能否被挡在主循环之外
npm run verify:pairing             # 批内配对不变量能否守住（三条中断路径各一条真注入 ＋ R-4 四条 Port 异常 ＋ orphan 反向注入）
npm run verify:resume              # 消息级恢复够不够用；C 段判据已收紧到「产物与基线逐字一致」
npm run verify:compact             # Compact 是否真的落地（R-6）
npm run verify:persistence         # 跨进程恢复：真 kill -9 之后能不能只凭 SQLite 接上
npm run verify:budget              # 预算八轴逐条撞墙 ＋ 墙钟拆分 ＋ 时间事实段级冻结
npm run verify:crash               # 三个崩溃窗口 × 三条恢复分支（决 6 的判别力在这里）
npm run verify:drift               # 端点漂移检测 ＋ 对照端点装配 ＋ resume 端点一致性闸门（U-1 / U-6 / P1-1）
npm run verify:tools               # 批 1：边界 grep（1…7 共 8 条） ＋ 两类声明 ＋ 分页非截断 ＋ 组合器三方法路由 ＋ 读黑名单
npm run verify:artifact            # 批 2：外置与逐字取回 ＋ URL 护栏 ＋ 产物登记与第二层验证 ＋ role 分流
                                   #   ＋ ★H 段：run_shell 产出的**二进制** zip 走完整条产物链（ADR-0010）
                                   #   ＋ ★H3 文件头魔数（404 页伪装成 .jpg）／H4 旧文件不得冒认／I 段 identity
npm run verify:progress            # 批 3：进展 ＋ 无进展 ＋ 真实慢工具取消 ＋ 人工接管三条状态闭合
npm run verify:scenarios           # S13：三场景 smoke（决 7 的判据）＋ 三条护栏在场性总校验
npm run verify:shell               # ★阶段 3.5：两道闸门 ＋ 沙箱实测 ＋ 分支三 ＋ 边界 7
                                   #   ＋ ★$TMPDIR/tmp 双侧 ＋ effect 不得抄进 URL
                                   #   ＋ ★ADR-0012 B9/B10：UNRESTRICTED 越界写必须**成功**
                                   #     （B2 的配对）＋ 凭证读禁与 env 白名单仍在
npm run verify:ui                  # ★阶段 4：边界判别力 ＋ 投影幂等 ＋ 三条等人通道走 HTTP ＋ 自动放行正分支
                                   #   ＋ 失败 resume ＋ 恢复项可见 ＋ **跨 workspace 闸门** ＋ workspace 隔离 ＋ §22.6 ＋ SSE 游标
                                   #   ＋ ★ADR-0012 D4/D5：AUTO 档不弹卡片**且动作真的执行了** ＋
                                   #     decidedBy 的 AUTO / HUMAN **成对** ＋「本次 Run 不再问」的 HUMAN→AUTO
                                   #   ＋ ★J2：换执行特权档 resume 被拒 ＋ **同档放行**（§18.3 第三维）
npm run verify:mcp                 # ★ADR-0011：通用 MCP 客户端。边界 12 判别力 ＋ 默认最保守档
                                   #   ＋ read/execute 两侧 ＋ array/嵌套 object 逐字送达 ＋ 分页
                                   #   ＋ isError 分流 ＋ image 块不假装 ＋ list_changed 必须被忽略
                                   #   ★二次评审收口：服务器原文不得进 safeMessage（走脱敏管道）
                                   #   ＋ 四种**开放 schema**（additionalProperties/patternProperties/
                                   #     根 $ref/根 oneOf）的参数逐字送达 ＋ dataMovement 如实记
                                   #   ＋ 未知 content 块不得废掉工具 ＋ 握手卡住不留孤儿进程
                                   #   ＋ resume 说出「外部工具核对不了」＋ 示例配置必须真能解析
                                   #   用**手写的假 MCP 服务器**，不依赖 Playwright、不联网、不弹窗口
npm run verify:all                 # 15 条脚本 / 221 条判据
```

> **【定】`verify:ui` 必须真的起 HTTP 服务**，不能直接调 `PendingHub` 的方法测。
> 后者测的是那个类；真实链路上还夹着路由、鉴权、JSON 编解码与 `pendingId` 的往返，
> 而 E-3 那条教训说的就是中间任何一层出错、前面的绿灯都不作数。

`verify:scenarios -- --live` 用真实端点跑同样三个任务（**花钱，不在 verify:all 里**）。

Eval 层（不复用生产结算路径，§24.1【定】）：

```bash
npm run eval:suite                 # 脚本化，不花钱，验管路（夹具→Run→manifest→grader→报告）
npm run eval:suite -- --live 5     # 真实端点跑 5 次，出 pass@1 / pass^5 / token 与时延分布
npm run verify:drift -- --live     # DeepSeek 对照端点实跑（§24.6）
```

一次性探针，**要花钱、发真实请求，不在 `verify:all` 里**（上面带 `--live` 的两条同理）：

```bash
npm run probe:reasoning-tokens     # D-3：count_tokens 算不算推理块
```

**不写单测、不引入测试框架**（D-25）。验收以**可运行脚本**交付，打印可读证据供人判断，而不是断言绿灯——与 Spike 0 的探针形态一致。新增验证时按这个形态写，放进 `apps/cli/src/verify/`，用 `harness.ts` 里的 `banner/section/fact/verdict` 输出。

工程基线：**Node 24 ＋ npm workspaces，不引入 pnpm / turbo / nx**。运行期依赖 **4 个**：
`@anthropic-ai/sdk`、`dotenv`、`turndown`、`@modelcontextprotocol/sdk` —— **SQLite 用内置 `node:sqlite`，不新增依赖**；`tsx` 直接跑 TS，无构建步骤。

> ⚠️ **`@modelcontextprotocol/sdk` 是 ADR-0011 破的基线**（3 → 4）。
> **17 个直接依赖**（`express@5` · `hono` · `jose` · `ajv` · `zod` · `cors` ·
> `express-rate-limit` · `pkce-challenge` …），实测 `npm install` 新增 **94 个包**。
> 诚实记账：**stdio client 这条路上用得到的只有 `cross-spawn` 与 `zod`**，
> 其余全是给 MCP **server 端** HTTP 传输与 OAuth 用的，而 npm 不管 import 哪个入口都全装。
> 采纳理由是一条读协议想不到的坑：真实服务器发得出 SDK 解不开的 `$ref` outputSchema，
> 手写客户端会以「某个 server 一接就崩」的形态失败。
>
> ⚠️ **`turndown` 是阶段 3.5 破的基线**（原本只有 2 个，见 [ADR-0007](sxw_aicoding/ADR/0007-html-结构转换可内置语义挑选不可.md)）。
> 磁盘 208K ＋ 传递依赖 `@mixmark-io/domino` 8.6M。
> 换来的是抓网页时 66% 的 token 削减（实测 38280 → 13023 字符）。
> 不手写的理由：手写要在没有 DOM 的 Node 里解析任意 HTML，而**「差不多能解析」的
> HTML 处理正是最容易出静默错误的一类代码** —— 它不报错，只在某些页面上少转一块，
> 而模型没有办法发现自己拿到的不完整。

### 凭证

根 `.env`（已 gitignore）提供百炼 Anthropic 形状的凭证：

```
dashscope_base_url_Anthropic=...
dashscope_model=qwen3.7-plus
dashscope_api_key=...
```

`compose.ts` 用 `override: true` 加载 dotenv 是刻意的——shell 里 export 过的 `ANTHROPIC_BASE_URL` 会把第三方 Key 发往官方端点（Spike 0 期间真实踩过）。`credential-guard.ts` 在启动前断言凭证去向，不是出错后记录。

> 阶段 2 起：用 `modelPortOverride` 时不再要求真凭证（存量清单 §4.5 已关）。
> 验收脚本一律用 `dbPath: ":memory:"` —— 同一条 SQLite 代码路径，但每次 compose 都是干净的一份。

## 架构

> **单进程、消息级持久化的 Agent Harness：主循环驱动模型与工具，端点差异以数据形式隔离在外，协议不变量 100% 由 Runtime 自持。**

三层：Layer 1 UI（阶段 4）→ Layer 2 Application Service（未实现）→ **Layer 3 Harness Runtime（阶段 1 的全部）**。

### 主循环（`loop/run-loop.ts`）

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

**循环纪律五条**（改这个文件前先读文件头注释）：

1. 每个 `continue` 站点必须构造完整的 `LoopState`——由 `nextState()` 强制；
2. 每个 `continue` 带具名 `Continue.reason`，每个 `return` 是具名 `Terminal`；
3. 消息先落盘再进 `messages` 数组——由 `appendAndPush()` 强制；
4. 流式 delta、进度、心跳不进 `LoopState`，直接 yield；
5. **循环不读取端点能力声明**（本文件出现 `profile.` 即违规）。

阶段 2 在第 ① 步之前多了一次 `checkBudgets()`（八条轴一次判完，R-1），
在第 ② 步之后多了一次漂移观测（U-1）；阶段 3 在第 ④ 步之后多了一次
Progress Guard 判定（U-3，无进展 → 具名 Terminal `NO_PROGRESS`），
并在批事件流上多了两个消费点（`ToolProgress` → Guard；
`InteractionRequested/Completed` → 等待时间扣除）。

**三次扩展都收在纯函数/独立类里，循环只消费判定结果，纪律五条一条没动。**
【定】允许动的是「新增等待分支 / 新增事件消费点 / 新增等待扣除的事件对」，
每一处都必须由 `nextState()` 构造完整 `LoopState`、带具名 reason、在 verify 段里有判据。

`Terminal` ≠ Run 终结：`RECOVERY_REQUIRED` 是明确的**非终态**，不结算 outcome，`StartResult.outcome` 为 `undefined`。

### 恢复走 transcript，不走状态快照

`resume()` = **从 `RunStorePort` 读回冻结的 RunSpec** → 读 transcript → 重建 messages ＋ 从 `RUN_META` 读回累计事实 → 按 §18.2 三条分支处置末尾未配对的 tool_use → 从下一轮继续。

【定】RunSpec 必须是**启动时冻结的那一份**（深冻结，M-4）。三条分支的判定读的是
`spec.agentSpec.toolSnapshots`——用今天 compose 出来的工具声明去判一条昨天的 transcript，
改一次工具声明就会让同一条记录走进不同分支，而盘上看不出来。读不到就抛，**不回退到当前配置**。

`LoopState` 因此**不需要可序列化**（可以放 Promise / AbortController / 完整 Message[]）——这是删掉纯 Kernel 后剩下的唯一自由度。代价：崩溃时正在执行的工具会重跑，「工具跑没跑」在 transcript 上不可区分。**这把「Tool 是否幂等」从可选属性变成了恢复正确性的前提。**

三条分支与工具形态的对应（阶段 3 后）：

| 工具 | 包 | 性质 | 分支 |
|---|---|---|---|
| `list_dir` / `stat` / `read_file` / `search` / `now` / `fetch_url` / `read_blob` | tools/common | 只读、幂等 | 一：真的重新执行 |
| `write_file` | tools/common | **幂等**（覆盖写同样内容两次 == 一次） | 一 |
| **`edit_file`** | tools/common | **真的非幂等** ＋ 相对操作（`requiresPreFingerprint: true`） | 二：**唯一天然落在分支二的场景工具** |
| `request_handoff` / **`ask_user`** | tools/common | 只读、幂等；`waitsForHumanInteraction` | 一 |
| `append_log` | cases/micro-cases | 非幂等、执行后不可验、**相对**操作 | 二或三：**取决于有没有拍到执行前指纹** |
| `slow_write` | cases/micro-cases | 可控慢的**写**（`delay_ms`） | 一（幂等，与 `write_file` 同理） |
| **`run_shell`** | tools/common | 既不幂等也不只读；**崩溃后无从观察** | 三：**第一个天然落分支三的场景工具** |

> `run_shell` 那一行是诚实的结果，不是字段填错：崩在 `zip -r` 中途，
> 半个 zip 与没有 zip 在磁盘上都可能长得像成功。它声明
> `requiresPreFingerprint: true` 而 `CommonVerifier` 给不出指纹 → `canObserve` 恒假。
> **副产品**：分支三此前只有 `append_log` 这个**测量工具**做载体，
> 而用测量工具去测分支分布，正是阶段 2 决 6 要防的「旋钮长在被测对象身上」。

> **收口批改过 `write_file` 那一行。** 它此前声明 `isIdempotent: false` 落分支二，
> 而注释自己承认那是「为了让分支二有**通用工具**可测」—— 与把 `delay_ms` 赶出这个工具
> 是同一条纪律（能力面不得被测量需求反向定义），只是藏在一个布尔字段里。
> 后果不是纸面的：`facade` 的分支判定里 `isIdempotent` 是**第一个**判别项，
> 于是最常用的写工具会把 §18.2 的分支分布系统性带偏。
> `verify:crash` / `verify:resume` 的分支二载体同批换成 `edit_file`。

`edit_file` 让 §2.4 的组合器路由第一次被**真正需要**：`CompositeVerifier` 漏路由
`observePre`，它会静默从分支二退化到分支三，**盘上看不出来、没有任何报错**。
`verify:tools` E 段对这条做判别力实测（改坏路由必须翻红）。

**【定】阶段 2 起，分支判据是 Action 级事实，不是工具的静态声明（决 6）。**
阶段 1 用 `verification.mode !== "NONE"` 回答「崩溃后能不能观察」，而那个字段说的是
「执行后能不能验」。两者不同：`append_log` 执行后验不了（不知道该有几行），
但崩溃后能不能观察，取决于**执行前有没有留下指纹**（`ACTION_FACT` 条目）。
拍不拍由 Runtime 侧的 Verifier 决定——这样测量的旋钮才不长在被测对象身上。

停在 `RECOVERY_REQUIRED` 后，**再次 `resume()` 必须带 `recoveryDecision: "CONTINUE" | "ABORT"`**，否则抛错——不然「交用户决定」会退化成「停一次，下次自动放行」。

### 端点行为是数据，不是代码（原则十四 / D-07）

判据：**如果换一个端点这条结论可能变，它就是数据。**

理据是实测：Spike 0 第二轮的十条结论，第三轮重测有**六条换端点就不成立**，而变量隔离已经做得很干净（同平台、同模型、同 Key，只换 API 形状）。

落地形态是 `adapters/endpoint-profiles/*.json` ＋ `ModelProtocolPort`：

```text
buildRequest      形状提供请求结构      端点提供常量
validateFrame     形状提供协议规则      端点提供校验强度
protocolRoleOf    形状提供载体          端点提供约束档位
countTokens       形状提供端点路径      端点提供精度
classifyError     —                    端点提供判别式
isBlockClosed     形状提供事件          端点提供有无
```

主力端点是**百炼 Anthropic 形状 `qwen3.7-plus`**（D-16）。选它而不是评分更高的 DeepSeek，因为它**零协议兜底**（缺 tool_result、错 tool_call_id 一律 200 放行）且服务端无状态——用一个什么都不校验的端点开发，能逼出自持逻辑的全部漏洞。`compose.ts` 是全仓唯一写死端点名的地方。

### 边界 grep：编号 1…12、共 13 条规则（有机械判据，改动后复核）

**【定】表在 `apps/cli/src/verify/boundaries.ts`，不要在别处抄第二份。**
从阶段 4 起有两个消费者（`verify:tools` 跑全表、`verify:ui` 对新增几条做判别力实测），
抄一份的后果是「加了一条规则、只有一个脚本认识它」，而两个脚本都是绿的。

```bash
grep -rn "@anthropic-ai/sdk" packages apps cases tools      # 1. Provider SDK 只在形状适配器里
grep -rn "dashscope" packages/harness-runtime/src            # 2. 端点名不进 Runtime 代码
grep -n "profile\." packages/harness-runtime/src/loop/run-loop.ts   # 3. 主循环不读端点声明（仅注释命中）
grep -rnE "micro-cases|tools-common" packages/harness-runtime/src   # 4. Runtime Core 不 import 任何工具实现
grep -rn "node:sqlite" packages apps cases adapters tools    # 5. 只允许 packages/store-sqlite/ 命中
grep -rnE "@workagent/tools-|tools/common" packages adapters # 6. ★阶段 3：Runtime 与适配器不得依赖工具包
grep -rnE "@workagent/micro-cases|cases/" tools/             # 6b. ★阶段 3：通用工具不得依赖任何 Case 包
grep -rnE "sandbox-exec|analyzeCommand|sbpl" packages adapters # 7. ★阶段 3.5：沙箱与命令解析不得进 Runtime
grep -rn "@workagent/" apps/workagent-ui/public              # 8. ★阶段 4：UI 不得依赖任何后端模块
grep -rnE "\.setStatus\(|runLoop\(|executeBatch\(|settleOutcome\(" apps/workagent-service/src  # 9. ★阶段 4：Layer 2 不得推进执行语义
grep -rnE "\.(inner|outer)HTML|insertAdjacentHTML" apps/workagent-ui/public  # 10. ★阶段 4：模型产出不得走 innerHTML
grep -rnE 'style: "|style="' apps/workagent-ui/public       # 11. ★阶段 4 收口：不得用内联 style（被自己的 CSP 丢弃）
grep -rniE "modelcontextprotocol|StdioClientTransport" packages adapters  # 12. ★ADR-0011：MCP 客户端不得进 Runtime
```

> **第 12 条与第 7 条同源但更隐蔽。** MCP 的诱惑**不需要 import 任何工具包** ——
> 把 `StdioClientTransport` 搬进 `packages/harness-runtime/src/ports/` 就行，
> 那里本来就叫 Port，一个「MCP Port」看着天经地义。搬进去之后 Runtime 就认识了
> JSON-RPC 与子进程管理，而**边界 4 / 6 / 7 一条都不会响**。
> 判别力实测在 `verify:mcp` A 段（注入一行 SDK import，必须当场翻红）。

阶段 4 三条各自的「违反了会怎样」：

| 条 | 违反的形态 | 后果 |
|---|---|---|
| **8** | 给界面加个构建步骤，然后 import 一个 Runtime 类型 | §5.5 保留的那条约束（UI 经 RunEvent 流驱动、不直接读 Runtime 状态）从**物理事实**退回君子协定 |
| **9** | 服务里补一句 `setStatus` 去「修正」看起来不对的状态 | Layer 2 成为**第二个状态推进者**，§23.1 的裁决规则不成立，而界面看起来更「对」了 |
| **10** | 审批面板用 `innerHTML` 拼命令原文 | 模型可以在命令注释里塞 HTML 把上面几行盖掉 —— 与 ANSI 伪造是同一件事，换了个渲染器 |
| **11** | 用 `style="width:…"` 设进度条比例 | **被自己的 CSP（`style-src 'self'`）静默丢弃** —— 属性进了 DOM、声明是空的，八条预算轴全部渲染成满格。一个说假话的白盒，而且**在截图里看不出来** |

> **第 8 条不是恒真式。** 它成立靠的是「UI 没有构建步骤」这个物理事实，
> 而这个事实随时会被一次改动破坏 —— 那一刻它是唯一会说话的东西。
> 判别力实测过：注入一行 import，当场翻红并指出行号。
> **收口批把它的扫描范围从 `public/` 放宽到整个 `apps/workagent-ui/`** ——
> 只扫 `public/` 的话，「加了打包器之后会红」这句 ADR 主张并不成立
> （源码会在 `src/`，产物里包名已被消解）。豁免用**行级** `exceptLines`
> 只放行本包自己的 `name` 声明，而不是豁免整个 `package.json`。
>
> **第 10 条的模式带前导点**（`\.innerHTML`），因为**散文里也会提到这个词** ——
> 这几个文件的文件头就在讲这条规则。第一次跑时第 8 条就抓到了我自己写在
> `index.html` 注释里的模式串。

**`verify:tools` A 段机械跑这 13 条**，不要手工 grep 了事 —— 它还会过滤注释行
（这些文件里到处在引用边界规则本身），并在 A2 段做**判别力实测**：
往 `tools/common` 注入一行对 Case 包的 import，第 6b 条必须当场翻红并指出行号。

第 5 条是阶段 2 新增：`node:sqlite` 是 Node 22.5 才引入的年轻 API，调用面收在一个包里，将来 API 变了只改一处。

第 4 条阶段 3 从「不 import Case Package」推广为「**不 import 任何工具实现**」。
第 6b 是「通用」这个词的机械含义：**通用工具一旦依赖某个 Case，它就不通用了**，
而这件事从代码上看不出来。注意它的模式**不是**方案里写的 `"cases/"` ——
那个抓不到 `import … from "@workagent/micro-cases"`，而包名 import 恰恰是最典型的违规形态。

第 7 条守的是「沙箱是工具域知识」。它与第 4 / 6 条同源但**形态不同**：
`run_shell` 的诱惑不是 import 工具包，而是把命令解析和沙箱 profile 生成搬进
`packages/harness-runtime/src/action/` —— 那里本来就叫 effect-resolver，看着天经地义。
搬进去之后 Runtime 就认识 shell 了，而第 4 / 6 条**一条都抓不到**（它没 import 任何工具包）。
Runtime 侧允许存在的只有 `TrustedEffectResolver` 这个类型。

前两条是研究问题「端点差异能否被完全挡在主循环之外」的机械判据。判据要区分**注释、类型定义与真实依赖**——`ApiShape` 这类类型定义命中不算违规。

### 不变量 8：批内每个 Tool Call 恰好一个 result

理据不是「否则 Provider 会 400」——选定端点上缺 result、错 id 一律 200 放行。理据是**否则模型看到的是一个失真的世界**，而且没有任何外部兜底会替你发现违反。

`action/settle-batch.ts` 是这条不变量的**单点收敛**：所有出口都经过 `finally` 里的 `finalize()` 补齐缺失 result，`recordUnmetRequired()` 同时补齐事实表。改这个文件时保持这个结构——重复结算直接抛错，不静默覆盖。

### outcome 结算只查事实表

**循环终止条件严格是「模型不再请求工具」**，没有独立的声明式验收机制。但结算 `outcome.kind` 时**必须查一次 required Verification 的结果**（`verification/settle-outcome.ts`）：Verification 已经跑过、扣了 token、结果已在表里，忽略它等于花钱测出一个事实然后扔掉。

典型场景：工具报错，模型总结里写「已完成，其中一项已跳过」——此时应结算 `COMPLETED_WITH_LIMITS`，不是 `SUCCESS`。

### 目录

```text
packages/harness-runtime/    Layer 3 全部
  src/loop/                  主循环、LoopState、Continue / Terminal、interrupt
  src/transcript/            重建与配对扫描（存储实现在 testkit / 阶段 2 换 SQLite）
  src/context/               ContextFrame 编译与 Compact
  src/action/                Effect 解析、Policy、批结算
  src/verification/          Verifier 与 outcome 结算
  src/model/capability/      端点能力声明的加载、冻结与漂移检测
  src/ports/                 14 个 Port，**全部有实现**（不留空壳接口）
  src/loop/progress-guard.ts ★阶段 3。只回答「在原地打转吗」；「还活着吗」那半边
                             收口批删了（进展是批结算时才排空的，时间戳判不了存活）
  src/facade/                HarnessRuntime：start / resume / cancel / interject / inspect
  src/workspace/             ★workspace 身份冻结 ＋ resume 一致性闸门（§18.3 第二维，S4-5）
packages/store-sqlite/       ★阶段 2。唯一允许 import node:sqlite 的地方
  src/db.ts                  **一份当前 Schema ＋ 形状断言**，没有 migration
  src/transcript-store.ts    TranscriptStorePort 的 SQLite 实现（接口一字未改）
  src/run-repository.ts      RunStorePort：RunSpec / AgentSpecSnapshot / status
  src/blob-store.ts          ★阶段 3。内容寻址；get 按行**且按字符**分页（见下）
  src/artifact-store.ts      ★阶段 3。版本链 / Tombstone / lineage / role
packages/testkit/            fake-endpoint-profile、clock、id-generator、crash-harness（真 kill -9）
                             【定】只留有使用者的夹具 —— FakeClock / DeterministicIdGenerator /
                             alwaysApprove 全仓零调用，2026-08-31 删
eval/                        ★阶段 2。graders / suite / fixtures
                             【定】只经 Facade，不依赖 Runtime 私有类，不读 RunOutcome 判成败
adapters/shape-anthropic-messages/   唯一允许 import Provider SDK 的地方
adapters/endpoint-profiles/  端点行为的**数据**形态，不是代码
tools/common/                ★阶段 3。Case 无关的通用能力面（@workagent/tools-common）
  src/fs/                    list_dir stat read_file search write_file edit_file
  src/fs/fs-common.ts        **唯一一份**边界判定与 fs 错误分类（cases/ 反过来 import 它）
  src/fs/read-guard.ts       读黑名单（决 3 护栏 1，**必须同时覆盖 read_file 与 search**）
  src/net/                   fetch_url ＋ url-guard（私网拒绝，DNS 解析后判 ＋ 重定向终点再判）
                             ＋ html-to-markdown（★3.5，只做结构转换，见 ADR-0007）
  src/mech/                  read_blob / request_handoff / ask_user（★3.5）—— 机制工具，声明义务不同
                             【定】request_handoff 与 ask_user 的 description 是**成对**的，
                             只改一边会让模型在两者之间随机选（ADR-0008）
  src/exec/                  ★阶段 3.5。run_shell（＋ ADR-0010 的 artifact_path 声明）
                             ＋ 两道闸门，职责不得合并：
                             command-analysis.ts 判「要不要问人」（判错＝多问一次）
                             sandbox.ts          判「能碰到什么」（判错＝没有边界）
                             shell-effect-resolver.ts 住这里而不是 Runtime 的 action/
                             —— 边界 7 抓的就是这一条
  src/artifact-checks/       JSON / ZIP / 编码 / hash 四项。**不做「Markdown 可解析」**（恒绿）
                             【定】`artifactKindOf`（扩展名 → kind）**唯一一份**住在这里 ——
                             kind 的全部意义就是决定跑哪些检查器；抄第二份的后果是
                             两个工具对同一个扩展名跑不同检查器，而两边都是绿的（ADR-0010）
tools/mcp/                   ★ADR-0011。通用 MCP 客户端（@workagent/tools-mcp）
  src/config.ts              mcp.json 解析。【定】**不读 MCP 的 annotations** —— 那是
                             服务器自述的，拿它决定审批档位＝让被审计方写自己的审计规则
  src/client.ts              stdio ＋ 生命周期。分页 / outputSchema 宽容 / progress→超时重置
                             【定】`tools/list_changed` 登记 handler 但**只记日志不重新 list**
                             （工具面已冻结进 RunSpec，跟着改会破坏 §18.2 分支判定前提）
  src/tool-bridge.ts         MCP Tool → ToolSnapshot。inputSchema **原样搬**，一个字不解析
                             McpEffectResolver **逐工具一个实例**（Resolver 接口拿不到 toolName）
  src/handler.ts             isError 按档位分流：read→NO_EFFECT，execute→UNKNOWN
                             【定】成功时 execute 档记 APPLIED，不是 UNKNOWN ——
                             否则每次正常调用都 push RecoveryItem，降级信号变成永远亮的灯
cases/micro-cases/           只剩 append_log 与 slow_write —— **测量工具**，不是能力
apps/cli/                    Composition Root（compose.ts）＋ 终端入口 ＋ 14 条验收脚本 ＋ 一次性探针
  src/composite.ts           ★阶段 3。工具包组合器。【定】必须路由 Verifier 的**三个**方法
  src/stdin-channel.ts       ★阶段 3。**单一** readline，按「谁在等」分派三种语义
  src/trace/file-sink.ts     事件流落 JSONL（header / event / footer 三种行）
  src/verify/boundaries.ts   ★阶段 4。边界表**唯一**一份（tools 跑全表、ui 做判别力实测）
apps/workagent-service/      ★阶段 4。Layer 2 Application Service（@workagent/service）
  src/projection.ts          纯函数投影。【定】只合并与转述，**不推算**（决 5）
  src/run-host.ts            §6.6 Runtime Host。【定】不推进执行语义 —— 边界 9 抓的就是这里
  src/human-channels.ts      「人在浏览器里」的三条通道。**接口一个字没改**
  src/workspace-registry.ts  ★workspace 注册表（Layer 2 产品状态，**不进 Layer 3 的库**）
  src/workspace-hosts.ts     ★选目录 / 切换。【定】同时只有一个活着的 RunHost
  src/security.ts            §22.6：随机端口 / 会话 Token / Origin ＋ **Host** 校验
  src/server.ts              HTTP ＋ SSE。游标是 transcript sequence（D-2）
  src/api-types.ts           线上契约。**不是** Runtime 类型的再导出
apps/workagent-ui/public/    ★阶段 4。Layer 1。**没有 src/、没有构建、没有一行 import**
                             【定】边界 8 与 10 守的就是这个目录（判别力实测过）
```

> **【定】Composition Root 只有一份**，住在 `apps/cli/src/compose.ts`；
> `workagent-service` 与 `eval/suite` 都 import 它，**不抄第二份** ——
> 抄一份的后果是两个入口的工具集 / 端点枚举 / system prompt / 审批档位迟早不一致，
> 而那种不一致在绿灯下看不出来。
>
> 它为什么不搬进 `packages/`：**边界 6 会当场翻红**（compose 必须 import 工具包）。
> **那条 grep 反过来正好证明了 Composition Root 属于 app 层。**
> 名字里带 `cli` 是历史不是设计，登记为欠账 S4-1。

**`read_blob` 为什么要按字符分页**：被外置的是**工具结果**，而工具结果几乎都是
**一行 JSON** —— 一个 64KB 的 `read_file` 结果 `totalLines` 就是 1。只按行分页的话，
模型请求 100 行会拿回整整 64KB，**刚外置掉的东西原样搬回上下文，外置等于白做**。
所以还有一层字符预算，超长单行按字符切片并给 `nextLineOffset`。这仍然是分页，不是截断。

单向依赖（`tsconfig.json` 的 paths 是它的编译期表达）：`apps → packages/adapters/cases`，`Runtime → Ports → Adapters`。禁止反向，禁止 Runtime → Case Package、主循环 → Provider SDK、Context 模块 → Provider SDK、形状适配器 → 端点特定常量。

## 文档

`sxw_aicoding/` 是本项目的主要产出之一，**不是附属说明**。

| 文档 | 作用 |
|---|---|
| [架构设计 V05](sxw_aicoding/架构设计/WorkAgent架构设计_V20260823_05.md) | **当前实现依据**。代码注释里的 `V05 §x.y` 都指向它 |
| [上位基线 v0.4](sxw_aicoding/方案讨论/WorkAgent目标定位与技术架构三次对焦讨论进展.md) | 项目目标与上位原则，**与架构设计冲突时以它为准** |
| [阶段 Roadmap](sxw_aicoding/阶段roadmap/WorkAgent阶段Roadmap_V20260823.md) | 各阶段研究问题与退出门槛 |
| [存量问题清单](sxw_aicoding/存量BUG/存量问题清单_V20260824.md) | **按阶段追加，不是只管阶段 1**。§0.4 阶段 2、**§0.5 阶段 2.5 收口、§0.6 阶段 3**（关 7 项、不做 4 项、新登记 S3-1…S3-5） |
| [Atlas 阶段 1 Agent 评测报告](评测/Atlas阶段1_Agent评测报告_20260824.md) | 真实端点单任务评测（84/100）。它暴露的四项已于 2026-08-25 修完 |
| [阶段 1 Bugfix 批次评审](sxw_aicoding/代码评审/2026-08-25/阶段1Bugfix批次评审-zcode.md) | 对上述修复批次的评审。逐条复核结论见存量清单 §0.2 追补 |
| [阶段 1 实施方案](sxw_aicoding/实施方案设计/阶段1实施方案_V20260823.md) | 分步计划与不得绕过清单 |
| [**阶段 2 实施方案 V20260826-03**](sxw_aicoding/实施方案设计/阶段2实施方案_V20260826.md) | **阶段 2 的实现依据**。§0 七个决定、§0.3 十七条修订记录、§7 的 36 项处置映射 |
| [阶段 2 方案评审](sxw_aicoding/方案评审/2026-08-26/阶段2实施方案评审-zcode.md) | 逐条核源码的评审，P1 四条已吸收进方案 §0.3 |
| [**阶段 3 实施方案 V20260828-02**](sxw_aicoding/实施方案设计/阶段3实施方案_V20260828-02.md) | **阶段 3 的实现依据**。§0 七个决定（决 2 / 决 3 有修订）、§4 十四条不得绕过、§5 结构性退出门槛 |
| [**阶段 4 实施方案 V20260830-01**](sxw_aicoding/实施方案设计/阶段4实施方案_V20260830.md) | **阶段 4 产品化半边的实现依据**。§0 七个决定、§1 研究问题与九条退出门槛、§3 十条不得绕过、§4 边界 grep 扩到 10 |
| [阶段 3 方案评审](sxw_aicoding/方案评审/2026-08-28/) | 两份（zcode / pi）。含一条**被驳回**的：pi 维度 6 说 R-1 / R-2 未修是事实错误，但它指向的后果成立，已并入 S10 |
| [探针记录](sxw_aicoding/WorkAgent调研/探针记录/) | 花钱探针的**原始输出**。`probe-requirement-extraction` 推翻了回归评测 §5.1 的归因 |
| `WorkAgent调研/ProviderProtocolFacts_*.md` | Spike 0 三轮实测事实（75 份证据 / 4 个端点） |
| `代码评审/` | 按日期分目录。`2026-08-24/` 两份阶段 1 评审；`2026-08-25/` 一份 Bugfix 批次评审 |
| [ADR-0011 外部 MCP](sxw_aicoding/ADR/0011-通过外部-MCP-接入浏览器能力.md) | **通用 MCP 客户端能力的实现依据**。四条代价、与 opencode 的对照、为什么不读 annotations |
| [ADR-0012 两条档位轴](sxw_aicoding/ADR/0012-审批与执行特权是两条正交的档位轴.md) | **auto 模式与完全权限的实现依据**。七条限制只拆三条、两条轴的生命周期为何不同、`decidedBy` 那笔账 |
| `ADR/` | 决策记录。阶段 2 三份（[0001](sxw_aicoding/ADR/0001-outcome-kind-不区分是谁没做成.md) / [0002](sxw_aicoding/ADR/0002-恢复可观测性改为-action-级事实.md) / [0003](sxw_aicoding/ADR/0003-受信时间事实冻结到执行段.md)）＋ 阶段 3 三份（[0004 工具归属](sxw_aicoding/ADR/0004-通用工具归属与两类分拣标准.md) / [0005 lease 不做](sxw_aicoding/ADR/0005-PARKED-lease-不做的理由.md) / [0006 读放开的护栏](sxw_aicoding/ADR/0006-读放开的护栏边界.md)）＋ **阶段 3.5 两份**（[0007 结构转换 vs 语义挑选](sxw_aicoding/ADR/0007-html-结构转换可内置语义挑选不可.md) / [0008 ask_user 与 handoff 是两个洞](sxw_aicoding/ADR/0008-ask-user-与-request-handoff-是两个洞.md)）＋ **阶段 4 一份**（[0009 UI 不引入前端框架与 Electron](sxw_aicoding/ADR/0009-阶段4-UI-不引入前端框架与-Electron.md)）＋ **2026-08-31 两份**（[0010 二进制交付物走字节通道与按路径声明](sxw_aicoding/ADR/0010-二进制交付物走字节通道与按路径声明.md) / [0011 通过外部 MCP 接入浏览器能力](sxw_aicoding/ADR/0011-通过外部-MCP-接入浏览器能力.md)）＋ **2026-09-01 一份**（[0012 审批与执行特权是两条正交的档位轴](sxw_aicoding/ADR/0012-审批与执行特权是两条正交的档位轴.md)）；**阶段 1 的四份欠了三个阶段了** |
| `spikes/s0-provider-protocol/` | 一次性探针，已完成，不进主干依赖（`tsconfig.json` 已 exclude） |

V04 及更早的架构设计、`V03_Spike0回填清单.md` **不再作为实现依据**，只作过程记录。

### 状态标记

文档与代码注释共用一套标记，含义是硬的：

| 标记 | 含义 |
|---|---|
| **【定】** | 已拍板不变量，跨端点成立。实现违反即架构错误，变更需独立 ADR |
| **【验】** | 当前方向，待 Micro Case / Eval 确认后才能冻结 |
| **【议】D-xx** | 待决策，拍板前不得在代码中固化任一候选 |
| **【端点】** | 仅对特定端点成立，必须写明对哪个端点；不得编译进代码，只能进端点能力声明 |

## 写代码时

- **注释解释「为什么」和「违反了会怎样」，不解释「做了什么」。** 现有注释大量引用 V05 章节号、实测数字（360 tokens 工具固定开销、每请求底数 5、`count_tokens` 0.00% 误差、缓存严格前缀）和它们的证据出处——新增代码保持这个密度和风格，中文。
- **规格纪律**：任何 Contract 冻结前必须能指出证据来源；拿不出证据就标【验】或【议】。反向同样成立——「必须存在某个机制」也需要证据，V03 的 15 个决策点里有 3 个被证明**问题本身不该问**。
- **未接线比不写更糟**：类型、事件、类都在但运行时从不执行，会让人以为问题已经解决了（存量清单 §2 列了 8 项这种）。要么接线，要么删掉。
- 阶段 1 只实现能被当阶段 Micro Case 覆盖的最小面。新增 Port 时必须同时指出强制它存在的不变量。
- 提交前跑 `npm run typecheck` ＋ 相关的 `verify:*`，并复核边界 grep（12 条，`verify:tools` A 段机械跑）。
- **不留「声明了但没人读」的字段、枚举值、Port 或参数。** 要么接线，要么删 ——
  一个没有消费者的声明会让下一个人以为那件事已经有人管了。2026-08-31 那一批
  拆掉的三十多项，每一项当初都是「先声明着，将来会用」。
