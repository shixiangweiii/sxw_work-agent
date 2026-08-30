/**
 * 「当前在哪个 workspace 里干活」——  Layer 2 的 workspace 生命周期。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】**同时只有一个活着的 `RunHost`**，切换 = 关旧的、开新的。
 *
 * 一个 `RunHost` 背后是一次 `compose()`：一个 SQLite 句柄、一套 Port、
 * 一个冻结的 workspaceRoot。它不是可以中途换根的东西 —— 换根意味着
 * `autoGrantVerdict` 的判定基准、沙箱的可写范围、`isInsideWorkspace` 的
 * 参照全都要跟着变，而它们分散在三个包里。**把「换 workspace」实现成
 * 「换一个 RunHost」，是唯一不需要在那三处各开一个后门的做法。**
 *
 * 为什么不同时留着 N 个（每个 workspace 一个常驻 host）：
 *   · N 个 SQLite 句柄 ＋ N 套 Port，而其中 N−1 个永远不会被用到；
 *   · §6.4 本来就只允许一个前台 Run —— 留着别的 host 只是让「谁在跑」
 *     这个问题多出 N−1 个答案。
 *
 * ── 【定】有 Run 在跑时**拒绝**切换，不排队也不强杀 ──────────────────────
 *
 * 强杀会把一个正在写文件的 Run 停在半路（副作用状态 UNKNOWN → §18.2 第三条
 * 分支 → 要人来销账）；排队则会让用户点完切换之后界面停在一个说不清的中间态。
 * 拒绝是三者里唯一能一句话说清楚的：「先取消它，或者等它跑完」。
 * ══════════════════════════════════════════════════════════════════════
 */

import { RunHost, type RunHostOptions } from "./run-host.js";
import { WorkspaceRegistry, type CreateResult, type WorkspaceEntry } from "./workspace-registry.js";

export interface WorkspaceHostsOptions {
  /** 注册表文件（Layer 2 产品状态，不进 Layer 3 的库）。 */
  registryFile: string;
  endpoint: RunHostOptions["endpoint"];
  composeOverrides?: RunHostOptions["composeOverrides"];
  /**
   * 首次启动时用命令行参数登记的那一个。
   *
   * 【定】它**保留 CLI 传进来的 dbPath / traceDir**，而不是套用
   * 「一个 workspace 一套存储」的新默认。理由：库里已经躺着用旧默认
   * （`.workagent-state/runs.db`）跑出来的 Run —— 换成新默认等于让它们
   * 一夜之间从界面上消失。新建的 workspace 才走新默认。
   *
   * 这是「新约定只对新东西生效」的一次具体应用：**迁移的代价不该由
   * 已经存在的数据来付**。
   */
  bootstrap: { path: string; dbPath: string; traceDir: string };
}

export class WorkspaceHosts {
  private readonly registry: WorkspaceRegistry;
  private current: { id: string; host: RunHost } | undefined;

  constructor(private readonly opts: WorkspaceHostsOptions) {
    this.registry = new WorkspaceRegistry(opts.registryFile);

    /**
     * 启动时把命令行指的那个 workspace 登记 ＋ 激活。
     *
     * 【定】显式传了 `--workspace` 就以它为准；没传则沿用注册表里上次用的那个。
     * 「没传时不要改变用户上次的选择」是这条的重点 —— 一个每次启动都跳回
     * 默认目录的界面，会让「切换」这个功能形同虚设。
     */
    const created = this.registry.create(opts.bootstrap.path);
    if (created.ok && created.entry) {
      const e = created.entry;
      // 保留 CLI 给的存储位置（见 bootstrap 的说明）。
      e.dbPath = opts.bootstrap.dbPath;
      e.traceDir = opts.bootstrap.traceDir;
      this.registry.activate(e.id);
    }
  }

  list(): WorkspaceEntry[] {
    return this.registry.list();
  }

  activeEntry(): WorkspaceEntry | undefined {
    return this.registry.active();
  }

  /** 当前 workspace 的 RunHost。**懒创建** —— 没人访问就不开库。 */
  host(): RunHost {
    const entry = this.registry.active();
    if (!entry) throw new Error("没有激活的 workspace（注册表是空的）");
    if (this.current?.id === entry.id) return this.current.host;
    // 走到这里说明注册表被改过而 host 还没跟上（正常路径由 switchTo 收口）。
    this.current = { id: entry.id, host: this.spawn(entry) };
    return this.current.host;
  }

  create(path: string, name?: string): CreateResult {
    return this.registry.create(path, name);
  }

  /**
   * 切到另一个 workspace。
   *
   * 返回 `{ ok: false }` 而不是抛：这是一个**用户可以理解并自行解决**的拒绝
   * （「有 Run 在跑」），不是程序错误。抛出去会走进 500 那条通用路径，
   * 而那条路径的措辞是给「不该发生的事」准备的。
   */
  async switchTo(id: string): Promise<{ ok: boolean; entry?: WorkspaceEntry; error?: string }> {
    const entry = this.registry.get(id);
    if (!entry) return { ok: false, error: `没有这个 workspace：${id}` };
    if (this.current?.id === id) return { ok: true, entry: this.registry.activate(id) };

    if (this.current?.host.hasLiveRun()) {
      return {
        ok: false,
        error:
          "有 Run 正在这个 workspace 里跑，不能切换。\n" +
          "先取消它，或者等它跑完 —— 中途换根会让它后面的读写落到另一个目录里。",
      };
    }

    // 【定】先关旧的再开新的。两个 host 同时活着，就会有两个「当前 workspace」。
    if (this.current) await this.current.host.close();
    this.current = undefined;

    const activated = this.registry.activate(id)!;
    this.current = { id, host: this.spawn(activated) };
    return { ok: true, entry: activated };
  }

  /** 从列表里摘掉。**不删文件**（见注册表的 remove）。当前这个不许摘。 */
  remove(id: string): { ok: boolean; error?: string } {
    if (this.registry.activeId() === id) {
      return { ok: false, error: "不能移除当前正在用的 workspace，先切到别的再移除。" };
    }
    return this.registry.remove(id)
      ? { ok: true }
      : { ok: false, error: `没有这个 workspace：${id}` };
  }

  async close(): Promise<void> {
    if (this.current) await this.current.host.close();
    this.current = undefined;
  }

  private spawn(entry: WorkspaceEntry): RunHost {
    return new RunHost({
      workspaceRoot: entry.realPath,
      dbPath: entry.dbPath,
      traceDir: entry.traceDir,
      endpoint: this.opts.endpoint,
      ...(this.opts.composeOverrides ? { composeOverrides: this.opts.composeOverrides } : {}),
    });
  }
}
