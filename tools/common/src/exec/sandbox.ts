/**
 * macOS seatbelt 沙箱 —— `run_shell` 的**真正**安全边界。
 *
 * ══════════════════════════════════════════════════════════════════════
 * `command-analysis.ts` 决定「要不要问人」，本文件决定「跑起来能碰到什么」。
 * 只有后者是边界，前者判错的代价是多问一次。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这个分工不是我们发明的。Claude Code 的 `shouldUseSandbox.ts` 文件头写着：
 * 命令名匹配是「用户便利功能，**不是安全边界**」，真正的控制是沙箱加审批 ——
 * 而它为那个「便利功能」写了 8500 行。
 *
 * ── 实测（2026-08-30，本机 darwin 25.6）────────────────────────────────
 *
 *   (deny file-write*) ＋ (allow file-write* (subpath /tmp/x))
 *     → touch 越界目标：Operation not permitted，文件不存在 ✓
 *   (deny network*)
 *     → curl 连不上；去掉后同一命令 status=200 ✓
 *   (deny file-read* (regex #"/\.ssh/"))   → 拦住 .ssh/id_rsa ✓
 *   (deny file-read* (regex #"/\.env"))    → 拦住 .env.local ✓
 */

import { existsSync, realpathSync } from "node:fs";
import {
  DENIED_BASENAMES,
  DENIED_BASENAME_PREFIXES,
  DENIED_SEGMENTS,
} from "../fs/read-guard.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * 这台机器上有没有可用的沙箱。
 *
 * 【定】没有沙箱时 `run_shell` **不进工具面**，不得降级为无沙箱执行。
 *
 * 降级正是 E-3 / U-6 那个形状的反面版本：一条闸门在某些环境下自动消失，
 * 而调用方看到的一切都和正常工作一模一样。宁可这台机器上没有这个能力，
 * 也不要有一个「有时候有边界、有时候没有」的能力。
 */
export function isSandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/**
 * 把读黑名单的三张常量表翻译成 sbpl 的 deny 规则。
 *
 * 【定】翻译，不是另抄一份。规则表的唯一事实源是 `fs/read-guard.ts` ——
 * 见那个文件里「出现了第三个消费者」那段。`verify:shell` 钉住条目数相等。
 *
 * sbpl 的 `(regex #"…")` 用的是 POSIX 扩展正则，匹配的是**完整路径**。
 * 三条规则各自的边界都不是随手写的，见下面每一处的【定】：
 *   目录段 `.ssh`      → `/\.ssh(/|$)`    中间段与终段都要覆盖
 *   basename `id_rsa`  → `/id_rsa$`        锚在路径末尾
 *   前缀 `.env`        → `/\.env(\.|$)`   与 read-guard 的语义严格对齐
 *
 * 【定】边界写错的方向有两种，代价不对称：
 *   写紧了 → 误伤正常文件（`.environment.md`），用户会想办法绕过护栏；
 *   写松了 → 漏掉敏感文件（终段的 `.git`），护栏在那一处不存在。
 * 两个方向 `verify:shell` 都要能照到，所以判据是**双侧抽样对拍**，
 * 不是「条数相等」—— 条数对语义分叉的两个方向都无感知。
 */
export function toSandboxDenyRules(): string[] {
  const rules: string[] = [];
  for (const seg of DENIED_SEGMENTS) {
    /**
     * 【定】段匹配要同时覆盖「作为中间段」与「作为路径终段」。
     *
     * 原来只有 `/x/`（要求尾斜杠），于是作为**终段**的 `.git`
     * （git worktree 里 `.git` 是个文件而不是目录）整个漏过去。
     * 评审用内核级对拍抓到的：read-guard 拒、沙箱放行 —— **沙箱更松**，
     * 而分叉出现在安全边界那一侧。
     */
    rules.push(`(regex #"/${escapeRegex(seg)}(/|$)")`);
  }
  for (const name of DENIED_BASENAMES) {
    rules.push(`(regex #"/${escapeRegex(name)}$")`);
  }
  for (const prefix of DENIED_BASENAME_PREFIXES) {
    /**
     * 【定】必须加终止边界 `(\.|$)`（2026-08-30 评审 F4）。
     *
     * 原来是裸的 `/\.env`，而 `read-guard.ts` 那边的实现是
     * 「等于 `.env` **或以 `.env.` 开头**」——它的注释还专门【定】否决过
     * `startsWith(".env")` 这种写法，理由是「会连 `.environment.md` 这类
     * 正常文件一起挡掉，而误伤会让人去绕过护栏」。
     *
     * 也就是说：**沙箱这一侧实现的正是 read-guard 明确拒绝的那个语义。**
     * 「唯一事实源」的声明在两个实现里各说各话，而 B4 的「条数相等」
     * 判据对语义分叉**两个方向都无感知**。
     */
    rules.push(`(regex #"/${escapeRegex(prefix)}(\\.|$)")`);
  }
  return rules;
}

/** 读黑名单三张表的条目总数。`verify:shell` 拿它与规则数比对。 */
export function readGuardEntryCount(): number {
  return DENIED_SEGMENTS.size + DENIED_BASENAMES.size + DENIED_BASENAME_PREFIXES.length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SandboxProfileOptions {
  /** 唯一允许写入的目录（已 resolve 的绝对路径）。 */
  workspaceRoot: string;
  /** 额外允许写入的临时目录 —— 很多工具（zip / tar / git）要写 tmp 才能工作。 */
  tmpDir: string;
  /** 是否放行网络。默认 false。 */
  allowNetwork: boolean;
}

/**
 * 生成 sbpl profile。
 *
 * 结构是「(allow default) 之后逐条 deny」而不是「(deny default) 之后逐条 allow」——
 * 后者更严，但一个连 dyld 都加载不了的沙箱跑不起任何程序，
 * 而把 macOS 跑通一个进程所需的全部 allow 列全，本身就是一个 8500 行的问题。
 *
 * 【定】我们要守的是**两件具体的事**：写不出 workspace、读不到凭证、
 * （默认还有）连不上网。这三条用 deny 表达是完备的，不需要 default-deny。
 */
export function buildSandboxProfile(opts: SandboxProfileOptions): string {
  const lines: string[] = ["(version 1)", "(allow default)"];

  /**
   * ── 写：全禁，然后只开 workspace 与 tmp ──
   *
   * 【定】subpath 必须用 **realpath**，不能用调用方给的路径。
   *
   * 实测踩到的（verify:shell B1 第一次跑就红）：macOS 的 `tmpdir()` 返回
   * `/var/folders/…`，而 `/var` 是指向 `/private/var` 的符号链接。
   * seatbelt 按**解析后的真实路径**匹配 subpath，于是
   * `(allow file-write* (subpath "/var/folders/…/ws"))` 对
   * `/private/var/folders/…/ws` 一条都不命中 —— 结果是沙箱把
   * **workspace 内的写也一起拒了**，工具完全不能用。
   *
   * 这个 bug 的形态值得记：它只在「验了能写的那一侧」时才暴露。
   * 如果 B 段只验「越界写被拦」，那条判据会是绿的 ——
   * 一个拒绝一切的沙箱与一个正确的沙箱，在那条判据下不可区分。
   */
  lines.push("(deny file-write*)");
  lines.push(`(allow file-write* (subpath ${sbplString(realOf(opts.workspaceRoot))}))`);
  lines.push(`(allow file-write* (subpath ${sbplString(realOf(opts.tmpDir))}))`);
  // /dev/null 与 /dev/stdout 这类必须能写，否则 `cmd >/dev/null` 直接失败。
  lines.push('(allow file-write* (regex #"^/dev/(null|zero|stdout|stderr|tty|fd/)"))');

  // ── 读：凭证黑名单 ──
  for (const rule of toSandboxDenyRules()) {
    lines.push(`(deny file-read* ${rule})`);
  }

  // ── 网络 ──
  if (!opts.allowNetwork) {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}

/**
 * sbpl 的字符串字面量。
 *
 * 【定】必须转义，且路径里出现引号时**宁可抛错也不要静默截断** ——
 * 一个被截断的 subpath 会变成一个更宽的授权范围（`/Users/x"y/ws` 截成
 * `/Users/x`），而那是沙箱最不该出的错。
 */
/**
 * 解析符号链接。见上面 subpath 那段的实测记录。
 *
 * 【定】解析不了就**原样返回**，不抛。这里返回的是一个 `allow` 规则的参数：
 * 解析失败时给出一个可能不命中的路径，后果是「写不进去」（工具报错，看得见）；
 * 而抛错会让整个工具在一个可恢复的情形下彻底不可用。
 * 注意这个取舍只对 allow 成立 —— 对 deny 规则必须反过来。
 */
function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function sbplString(path: string): string {
  if (path.includes('"') || path.includes("\\")) {
    throw new Error(
      `路径含引号或反斜杠，无法安全地写进 sandbox profile：${path}。` +
        `换一个 workspace 路径 —— 这里不做转义猜测，猜错会放宽授权范围。`,
    );
  }
  return `"${path}"`;
}
