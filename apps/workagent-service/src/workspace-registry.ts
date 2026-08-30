/**
 * Workspace 注册表（V05 §7.1、§26.1 的 `workspaces` 那一张表）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它是 **Layer 2 的产品状态**，不进 Layer 3 的库。
 *
 * §26.3 白纸黑字：「Layer 3 不查询 Layer 2 表，**Layer 2 不修改 Layer 3 表**」。
 * 而 workspace 的名字、什么时候加进来的、上次用的是哪个 —— 这些是
 * §23.2 第 4 条列的「Layer 2 可拥有的独立字段」，Runtime 一概不认识。
 *
 * 落一个 JSON 文件而不是建一张表，理由与阶段 4 决 1 不建那 22 张产品表同源：
 * 单人本地、几个目录，一张表的迁移成本、所有权划分与并发语义都不值得付。
 * 形态换了、纪律没换 —— 它仍然是**独立于执行事实的一份产品状态**。
 *
 * ── 【定】一个 workspace 一套存储，这是安全设计不是整理癖 ────────────────
 *
 * 每个 workspace 自带 `dbPath` 与 `traceDir`，默认落在 `<ws>/.workagent/` 下。
 * 于是「A 的 Run 出现在 B 的列表里」在**物理上**不成立 —— 而 S4-5 那个洞
 * （在 /A 起的 Run 用 --workspace /B 恢复）的前提正是「同一个库里躺着
 * 来自不同目录的 Run」。
 *
 * 两道，缺一不可：
 *   ① 这里的**存储隔离** —— 让跨 workspace 的 Run 根本照不见面；
 *   ② Runtime 的 `assertResumeWorkspaceMatches` —— 万一有人显式共用一个库
 *      （`--db` 仍然支持），闸门照样拦得住。
 *
 * 只做 ① 不够：`--db` 是既有参数，共用库是**合法用法**（阶段 2 的默认行为就是
 * 共用），不能靠「大家都不这么干」来保证正确性。
 * 只做 ② 也不够：那样每次切目录都要靠一条报错来教育用户，而正确的默认
 * 应该是**根本不会撞上**。
 * ══════════════════════════════════════════════════════════════════════
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalWorkspacePath, workspaceIdOf } from "@workagent/harness-runtime";

export interface WorkspaceEntry {
  /** 由**真实路径**推出（`workspaceIdOf`）—— 与 RunSpec 里冻结的那个是同一个函数。 */
  id: string;
  /** 用户可见的名字。§23.2 第 4 条明确这是 Layer 2 可以独立拥有的字段。 */
  name: string;
  /** 用户敲进来的那个路径（原样留着，报错时好认）。 */
  path: string;
  /** realpath 之后的那个 —— 身份与所有判定都用它。 */
  realPath: string;
  dbPath: string;
  traceDir: string;
  createdAt: number;
  lastUsedAt: number;
}

interface RegistryFile {
  version: 1;
  activeId: string;
  workspaces: WorkspaceEntry[];
}

/**
 * 指向这些东西的 workspace 值得提醒一句。
 *
 * 【定】这是**提醒**不是拒绝。用户敲哪个目录是他自己的决定（CLI 一直允许
 * `--workspace .`），而 Agent 在 workspace 内有写权限、`run_shell` 的沙箱
 * 也只保证「不写出 workspace」。所以：
 *   · 拿一个仓库根当 workspace 是合理用法（就是要改这个仓库）；
 *   · 但它同时意味着 `.git/` 与 `.env` 就在 Agent 的可写范围内。
 * 读那两样有 ADR-0006 的读黑名单挡着，**写没有**。如实说一句，不替用户做决定。
 */
const SENSITIVE_AT_ROOT = [".env", ".git", ".ssh", "id_rsa", ".aws", ".npmrc", "node_modules"];

export interface CreateResult {
  ok: boolean;
  entry?: WorkspaceEntry;
  error?: string;
  /** 非阻断的提醒（见 SENSITIVE_AT_ROOT）。 */
  warnings: string[];
}

export class WorkspaceRegistry {
  private data: RegistryFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  list(): WorkspaceEntry[] {
    return [...this.data.workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  activeId(): string {
    return this.data.activeId;
  }

  active(): WorkspaceEntry | undefined {
    return this.data.workspaces.find((w) => w.id === this.data.activeId);
  }

  get(id: string): WorkspaceEntry | undefined {
    return this.data.workspaces.find((w) => w.id === id);
  }

  /**
   * 登记一个 workspace（目录不存在就建出来 —— 那正是「新建」这个动作）。
   *
   * 【定】幂等：同一个真实路径重复登记返回**同一条**记录，不产生第二个 id。
   * 身份由 realpath 推出，所以 `/tmp/x` 与 `/private/tmp/x` 是同一个 ——
   * 否则同一个目录会在列表里出现两次，而它们的 Run 却各在一个库里。
   */
  create(rawPath: string, name?: string): CreateResult {
    const warnings: string[] = [];
    if (!rawPath.trim()) return { ok: false, error: "路径为空", warnings };

    const abs = resolve(expandHome(rawPath.trim()));
    if (abs === "/") {
      return {
        ok: false,
        error:
          "拒绝把根目录 `/` 当作 workspace。Agent 在 workspace 内有写权限，" +
          "而沙箱只保证「不写出 workspace」—— 以 / 为根等于没有边界。",
        warnings,
      };
    }
    if (abs === canonicalWorkspacePath(homedir())) {
      return {
        ok: false,
        error:
          "拒绝把用户主目录当作 workspace（同上：那等于把整个家目录交给 Agent 写）。" +
          "请指向一个具体的项目目录。",
        warnings,
      };
    }

    try {
      // 【定】不存在就建 —— 「新建工作空间」这个动作的字面含义。
      mkdirSync(abs, { recursive: true });
    } catch (err) {
      return { ok: false, error: `建不出这个目录：${(err as Error).message}`, warnings };
    }

    const realPath = canonicalWorkspacePath(abs);
    const id = String(workspaceIdOf(abs));

    const existing = this.get(id);
    if (existing) {
      // 幂等：已经登记过就更新一下名字与时间，不新建。
      if (name) existing.name = name;
      existing.lastUsedAt = Date.now();
      this.save();
      return { ok: true, entry: existing, warnings: this.warnFor(realPath) };
    }

    const stateDir = join(realPath, ".workagent");
    const entry: WorkspaceEntry = {
      id,
      name: name?.trim() || basenameOf(realPath),
      path: abs,
      realPath,
      // 【定】一个 workspace 一套存储，见文件头。
      dbPath: join(stateDir, "runs.db"),
      traceDir: join(stateDir, "runs"),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.data.workspaces.push(entry);
    this.save();
    return { ok: true, entry, warnings: this.warnFor(realPath) };
  }

  activate(id: string): WorkspaceEntry | undefined {
    const w = this.get(id);
    if (!w) return undefined;
    w.lastUsedAt = Date.now();
    this.data.activeId = id;
    this.save();
    return w;
  }

  /**
   * 从列表里移除。
   *
   * 【定】**只摘登记，不删任何文件**（§22.5 的口径：Artifact 与 transcript
   * 永不物理删除）。用户在界面上点「移除」想表达的是「别再列出来」，
   * 而不是「把我这个目录里的东西删掉」—— 这两件事的代价差了一个数量级。
   */
  remove(id: string): boolean {
    const before = this.data.workspaces.length;
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    if (this.data.workspaces.length === before) return false;
    if (this.data.activeId === id) {
      this.data.activeId = this.data.workspaces[0]?.id ?? "";
    }
    this.save();
    return true;
  }

  private warnFor(realPath: string): string[] {
    const out: string[] = [];
    try {
      const entries = new Set(readdirSync(realPath));
      const hits = SENSITIVE_AT_ROOT.filter((n) => entries.has(n));
      if (hits.length > 0) {
        out.push(
          `这个目录根下有 ${hits.join(" / ")} —— Agent 在 workspace 内**有写权限**` +
            `（读有黑名单挡着，写没有）。确认你就是想让它在这里干活。`,
        );
      }
    } catch {
      /* 读不了目录就不提醒，不猜 */
    }
    return out;
  }

  private load(): RegistryFile {
    if (!existsSync(this.file)) return { version: 1, activeId: "", workspaces: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as RegistryFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) throw new Error("schema");
      return parsed;
    } catch {
      /**
       * 【定】读坏了就当空的，**不抛**。
       *
       * 这是一份可重建的产品状态（§22.5：「Transcript 投影（Layer 2）可重建，
       * 可回收」同一档）—— 为了它启动不了服务，代价与收益完全不成比例。
       * 真正不可重建的东西（transcript / RunSpec）在 Layer 3，读不到时那边是抛的。
       */
      return { version: 1, activeId: "", workspaces: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function basenameOf(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}
