# 评审报告：逐轮 LLM 调用审计查看器（阶段 2 + 2.5 刷新竞态修复）

- 评审日期：2026-09-02
- 评审对象：工作区未提交改动（基线提交 `6f82bfa` 之上），约 1248 行新增 / 55 行删除
- 依据文档：`PLAN.md`（阶段 2.5 竞态修复）、`PLAN (1).md`（阶段 2 审计查看器）
- 已执行命令：`npm run typecheck`（通过）、`git diff --check`（干净）
- 范围约束：仅评审，未改动任何代码

## 一、整体链路

sidecar（`apps/cli/src/model-audit/file-store.ts` writer）
→ `RunHost.modelInvocationAudit()`（`apps/workagent-service/src/run-host.ts:636`：ID 白名单 → RunSpec 存在性 → 事件轨道归属证明 → 严格 reader → request 身份比对）
→ `GET /api/runs/:runId/model-invocations/:invocationId`（`apps/workagent-service/src/server.ts:314`，`Cache-Control: no-store`）
→ 投影 `projectTurns()` 按 invocationId 建/补 `UiModelCall`（`apps/workagent-service/src/projection.ts:490` 起）
→ UI `renderModelCallRow` 折叠行 + 懒加载 + viewer/revision 双闸提交（`apps/workagent-ui/public/app.js:995–1100`）。

链路设计与两份 PLAN 一致：归属校验先于碰盘、身份冲突 `contentWithheld`、canary 隔离等关键约束都已落实。

## 二、评审发现

### M1 · 事件循环同步读大文件

`run-host.ts:649` 及 `readModelInvocationAudit` 用 `existsSync` + `readFileSync` 全量读多 MB sidecar。`verify/ui.ts` G2 自己测了 >256KB 的单调用响应；大 sidecar 读取会阻塞整个 service（含 SSE 推流和其他 Run 的事件落盘回调）。本地白盒可接受，但建议至少在注释里声明该代价，或后续换 `fs.promises.readFile`（reader 本身可保持同步，仅 IO 层异步化）。

### M2 · ID 白名单三处副本

- `server.ts:645` `isSafeModelAuditId`
- `run-host.ts:1384` `SAFE_MODEL_AUDIT_ID`
- `file-store.ts:321` `safeComponent`

三处各自硬编码 `/^[A-Za-z0-9_-]+$/`。`run-host.ts:649` 的注释声称"读取必须使用 writer 同一规则"，但这是靠人肉同步的三份字面量。正确性目前安全（reader 不比 writer 宽即 fail-closed），建议从 `file-store` 导出单一谓词消除漂移风险。

### M3 · verify:ui 用源码切片测提取件，而非交付件

`apps/cli/src/verify/ui.ts:1647–1649` 用 `indexOf("\nfunction bindModelAuditView(")` 定位再 `new Function` 执行。两个问题：

1. 标记找不到时 `indexOf` 返回 -1，`slice(start, -1)` 会静默切出残缺代码，最后以难诊断的 SyntaxError/TypeError 爆掉，而不是"app.js 结构变了"的明确失败。应显式 `if (lifecycleStart < 0 || lifecycleEnd < 0) throw`。
2. 它验证的是被提取函数的行为；真实文件里 toggle→load 的接线（`app.js:1031–1038`）若被改坏，这三条竞态判据仍全绿。PLAN 靠人工浏览器复核兜底，但建议加一条便宜的接线判据（如 `uiSrc.includes("loadModelInvocationAudit(entry, false)")`）。

### L1 · 归属判据与投影逻辑重复

`run-host.ts:1386` `invocationIdOf` 枚举的事件集与 `projection.ts` 的 case 分支是同一份知识的两份拷贝。将来若有新事件类型携带 invocationId，两处需同步改，漏改 `invocationIdOf` 会让合法调用 404。可考虑共享一个 helper。

### L2 · UI 细节

- `app.js:995` 的遗留调用行（`!call.invocationId` 分支）没有 `data-turn` 属性，与 `app.js:1046` 的正常行不一致；当前无代码消费该属性，纯观感。
- 审计缓存 `entry.data` 每 Run 上不设上限（`app.js:1069` 起），多次大调用展开后驻留内存直到切 Run——PLAN 明示"阶段 2 不分页、只存内存"，属已接受边界，不再赘述。

### L3 · CORRUPT withholding 路径写死 `line: 1`

`run-host.ts:657` 身份冲突时报告的损坏行号是硬编码值，丢失 reader 实际发现位置的信息。语义上 request 只可能在第 1 行（reader 已强制），可接受，仅提示。

## 三、值得肯定的点

- `belongsToRun` 先于碰盘、`contentWithheld` 不返回任何前缀正文、runId 经 `isSafeId`（允许 `.`）后再过更窄的 `SAFE_MODEL_AUDIT_ID`（拒绝 `..`）——两层闸门把 path oracle 和跨 Run 读取都堵住了，且 G2 用真实 HTTP + canary 做了负向验证。
- 提交四条件守卫（`app.js:1062`，viewer 对象身份 + runId + map 身份 + revision）配合 finally 里的双条件 controller 清理（`app.js:1096`），正确解决了"旧响应不清新 controller"这个经典竞态；三条注入实验注释与 AGENTS.md 的判别力要求吻合。
- `workspace-hosts.ts:188` 的 storageOverride 合并保留了 `modelAuditDir` 默认值，避免验收脚本覆盖 traceDir 时 writer/reader 目录劈叉。

## 四、结论

无阻断性问题，可提交。建议合入前顺手处理：

1. M2：从 `file-store` 导出单一 ID 谓词，三处引用同一实现；
2. M3-1：源码切片定位失败时显式抛错。
