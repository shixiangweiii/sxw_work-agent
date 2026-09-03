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
 * 不是 RunSpec 里冻结的那个 —— 当时 `makeRunSpec()` 没有填 `spec.workspace`，
 * 该字段虽然已在类型里，却没有生产者。
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
import type { ExecutionPrivilege, WorkspaceExecutionSnapshot } from "../types/run.js";

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
 * 这个路径落在 workspace 内吗 —— **Artifact 归属判定专用**（ADR-0012 收口）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它与 `tools/common` 的 `isInsideWorkspace` **不是重复的两份**，
 * 因为它们问的不是同一个问题，而且从 ADR-0012 起会**刻意给出不同答案**：
 *
 *   tools/common  「这个工具能不能往这里写？」→ UNRESTRICTED 下**能**
 *   这里           「这份东西算不算本 Run 的交付物？」→ 任何档位下**都不算**
 *
 * 把两者合成一个函数，等于把 ADR-0012 刚刚分开的两件事重新并回去 ——
 * 那正好是本仓反复清理的形态（一个函数同时回答两个问题，
 * 改其中一个语义时另一个静默跟着变）。
 *
 * 【定】它住在 Runtime 侧而不是工具侧，因为它守的是一条 **Runtime 不变量**：
 * `deliveredArtifactIds` 里不许出现 Atlas 无法证明其归属的东西（§17）。
 * 工具侧那道（`run_shell` 早就有）是第二道，两道都不能省（V05 §22.1）。
 *
 * 【定】解析走 `canonicalWorkspacePath`，**不新写一套 realpath**。
 * 词法前缀不够：`effect-resolver.ts` 的 `riskFactsFor` 就是纯词法的，
 * 而一个 workspace 内指向外面的符号链接能从那里一路走到底。
 * ══════════════════════════════════════════════════════════════════════
 */
export function isPathInsideWorkspace(root: string, target: string): boolean {
  const realRoot = canonicalWorkspacePath(root);
  const realTarget = canonicalWorkspacePath(resolve(root, target));
  return realTarget === realRoot || realTarget.startsWith(`${realRoot}/`);
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
 * ── 两档处置。此前有第三档，那是历史数据的代价 ────────────────────────
 *
 * `RunSpec.workspace` 曾经是可选的，于是这条闸门有一个 `UNKNOWN_LEGACY`
 * 档：放行 ＋ 发一条降级事件。它只服务闸门上线之前创建的 Run。
 * 字段改必填之后，那一档在类型上就不可达了 —— 一条**只能放行**的分支
 * 不再存在，闸门只有「一致」与「不一致」两种答案。
 */
export function assertResumeWorkspaceMatches(
  frozen: WorkspaceExecutionSnapshot,
  currentRoot: string,
): void {
  const current = canonicalWorkspacePath(currentRoot);
  const was = frozen.mounts[0]?.absolutePath ?? "(未记录)";
  const currentId = workspaceIdOf(currentRoot);

  if (String(frozen.workspaceId) === String(currentId)) return;

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

/**
 * §18.3 的**第三维**：执行特权档位（ADR-0012）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它与端点、workspace 两道并排，理由同构：恢复一条旧 transcript 之前，
 * 要先确认「当时的执行条件今天还成立」。而这一维守的是最硬的那件事 ——
 * **那些副作用当时有没有边界**。
 *
 * 不守会怎样，两个方向都很难看：
 *
 *   冻结 UNRESTRICTED → 今天用 SANDBOXED 接
 *     模型接着上一轮的计划往下写（它在受信事实里被告知过没有沙箱），
 *     命令突然开始被内核拒 —— 而拒绝理由指向一条它读不到的规则。
 *
 *   冻结 SANDBOXED → 今天用 UNRESTRICTED 接
 *     更糟：一条**在有沙箱的前提下被批准过**的计划，后半段跑在没有沙箱的
 *     机器上。人当时批准的那次审批，批的不是这件事。
 *
 * 【定】没有未知或缺省档。RunSpec 缺失/损坏该字段时在读取处 fail-fast；
 * 到这里的两侧都必须是可直接比较的确定值。
 * ══════════════════════════════════════════════════════════════════════
 */
export function assertResumeExecutionPrivilegeMatches(
  frozen: ExecutionPrivilege,
  current: ExecutionPrivilege,
): void {
  if (frozen === current) return;
  throw new Error(
    `拒绝 resume：执行特权档位与这个 Run 启动时不是同一档。\n` +
      `  Run 冻结的是   ${frozen}\n` +
      `  当前进程装配的 ${current}\n` +
      (frozen === "UNRESTRICTED"
        ? `这个 Run 是在**无沙箱**下跑的，现在的进程有沙箱：后半段会开始撞上一条` +
          `模型读不到的规则，而它已经按无沙箱规划过命令。\n` +
          `  用 --sandbox off 恢复它。\n`
        : `这个 Run 是在**沙箱内**跑的，现在的进程没有沙箱：一条在有边界的前提下` +
          `被批准过的计划，后半段会跑在没有边界的机器上 —— 人当时批准的不是这件事。\n` +
          `  用 --sandbox on 恢复它（那是默认值，去掉 --sandbox off 即可）。\n`) +
      `要么换回原来那一档，要么另起一个新 Run。`,
  );
}
