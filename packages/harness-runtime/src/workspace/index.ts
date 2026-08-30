/**
 * Workspace 身份：冻结与 resume 一致性闸门（V05 §7.1 / §7.7 / §18.3）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它与 `assertResumeEndpointMatches` 是**同一类**闸门，形状照抄。
 *
 * §18.3 说的是「外部世界重新校验」：恢复一条旧 transcript 之前，要先确认
 * **当时的执行条件今天还成立**。端点是其中一维（换端点 → 协议校验强度、
 * 推理块档位、token 口径全变），**workspace 是另一维，而它此前完全没有守卫**。
 *
 * ── 这个洞长什么样（S4-5，四份评审里 codex P1-2 报的）─────────────────
 *
 * `--db` 与 `--workspace` 是**分开**的两个参数，同一个库里可以躺着来自不同
 * 目录的 Run。而 `resume()` 用的 `workspaceRoot` 来自**当前 compose**，
 * 不是 RunSpec 里冻结的那个 —— 因为 `makeRunSpec()` 压根没填 `spec.workspace`
 * （那个字段从阶段 1 起就在类型里，一直是 undefined）。
 *
 * 后果：在 `/A` 起的 Run，用 `--workspace /B` 恢复，**未配对工具的观察、
 * 幂等重试、后续所有相对路径的读写、以及自动放行的 workspace 判定，
 * 全部以 /B 为根**。旧 Run 会在错误的目录里继续产生副作用，而盘上看不出来。
 *
 * 阶段 4 之前它「不易触发」：CLI 要手打 runId。**白盒界面把它变成了列表里
 * 一个按钮** —— 所以「选目录 → 切换 workspace」这个功能必须先有这道闸门，
 * 否则等于把一个已知的坑做成一键可达。
 *
 * ── 【定】为什么身份是 realpath 而不是用户敲的那个字符串 ─────────────────
 *
 * macOS 上 `/tmp` 是 `/private/tmp` 的链接、`tmpdir()` 是 `/var/folders/…`
 * 的链接。用字面量比，同一个目录换个写法就会被判成两个 workspace；
 * 而 `isInsideWorkspace` 与 seatbelt 沙箱都按**真实路径**判定
 * （沙箱那次一度把 workspace 内的写也拒了，就是这个坑）。两处口径必须一致。
 * ══════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WorkspaceId } from "../types/ids.js";
import { asId } from "../types/ids.js";
import type { WorkspaceExecutionSnapshot } from "../types/run.js";

/**
 * 目录的真实路径。目标不存在时向上找**最近一个存在的祖先**再拼回去 ——
 * 与 `tools/common` 的 `isInsideWorkspace` 是同一套解析语义（那边的注释
 * 写着「对不存在的目标走最近已存在祖先的 realpath」）。
 *
 * 两处必须一致：一个判「这个 Run 属于哪个 workspace」，一个判「这次写在不在
 * workspace 内」。口径不同的话，会出现「闸门放行了、写入却被拒」这种
 * 谁都解释不了的状态。
 */
export function canonicalWorkspacePath(root: string): string {
  const abs = resolve(root);
  let probe = abs;
  const suffix: string[] = [];
  for (;;) {
    try {
      return [realpathSync(probe), ...suffix].join("/").replace(/\/+/g, "/");
    } catch {
      const parent = dirname(probe);
      // 到根了还解析不了：如实返回词法路径，不猜。
      if (parent === probe) return abs;
      suffix.unshift(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}

/**
 * workspace 的稳定身份。
 *
 * 【定】由**真实路径**推出，不接受外部传入 —— 身份必须能从事实重算，
 * 否则「同一个目录被登记成两个 id」这类问题只会在事后才暴露。
 */
export function workspaceIdOf(root: string): WorkspaceId {
  const real = canonicalWorkspacePath(root);
  return asId<WorkspaceId>(`ws_${createHash("sha256").update(real).digest("hex").slice(0, 12)}`);
}

/** 冻结进 RunSpec 的那一份（§7.6）。 */
export function freezeWorkspace(root: string): WorkspaceExecutionSnapshot {
  const real = canonicalWorkspacePath(root);
  return {
    workspaceId: workspaceIdOf(root),
    /**
     * 单一 mount，可写。
     *
     * 【定】这里**不**造出多 mount 的假象。§7.1 的 mounts 是为「一个 workspace
     * 挂多个目录」准备的，而当前实现只有一个根 —— 填一个长度为 1 的数组是事实，
     * 填多个是凭空发明一个没人实现的能力（本仓「未接线比不写更糟」的形态）。
     */
    mounts: [{ mountId: "root", absolutePath: real, writable: true }],
  };
}

/**
 * resume 前的 workspace 一致性闸门。
 *
 * 【定】排在**端点闸门之后、生命周期闸门之前** —— 与 §18.3 同一档：
 * 换了执行条件之后，连「这个 Run 现在是什么状态」都该被怀疑。
 *
 * ── 三档处置，中间那档是这条闸门最需要解释的地方 ──────────────────────
 *
 * | RunSpec 里的 workspace | 处置 |
 * |---|---|
 * | 与当前一致 | 放行 |
 * | 与当前**不一致** | **拒绝** |
 * | **缺失**（本闸门上线前创建的 Run） | 放行，但由调用方发一条可见的降级事实 |
 *
 * 第三档不能硬拒：那会把库里所有存量 Run 一次性变成不可恢复，而它们
 * 当初并没有做错什么。也不能静默放行 —— 那正是这个洞原来的样子。
 * 所以返回值是**三态**，让调用方把「不知道」如实说出来（见 facade 的调用点）。
 */
export type WorkspaceMatch = "MATCHES" | "UNKNOWN_LEGACY";

export function assertResumeWorkspaceMatches(
  frozen: WorkspaceExecutionSnapshot | undefined,
  currentRoot: string,
): WorkspaceMatch {
  if (!frozen) return "UNKNOWN_LEGACY";

  const current = canonicalWorkspacePath(currentRoot);
  const was = frozen.mounts[0]?.absolutePath ?? "(未记录)";
  const currentId = workspaceIdOf(currentRoot);

  if (String(frozen.workspaceId) === String(currentId)) return "MATCHES";

  throw new Error(
    `拒绝 resume：workspace 与这个 Run 启动时不是同一个。\n` +
      `  Run 冻结的是   ${was}\n` +
      `                （${frozen.workspaceId}）\n` +
      `  当前服务指向的 ${current}\n` +
      `                （${currentId}）\n` +
      `在另一个目录下恢复一条旧 transcript，未配对工具的观察、幂等重试、` +
      `后续所有相对路径的读写、以及自动放行的 workspace 判定，全部会以新目录为根 ——` +
      `**旧 Run 会在错误的地方产生副作用，而盘上看不出来**。\n` +
      `要么把服务切回原 workspace，要么另起一个新 Run。`,
  );
}
