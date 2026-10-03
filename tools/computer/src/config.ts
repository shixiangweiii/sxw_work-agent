/**
 * computer use 的启用档位与应用白名单（ADR-0013）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】三档，默认 off，必须**显式**开启：
 *
 *   off      不装配任何 GUI 工具（默认）；
 *   view     只装 `screenshot` —— 只看不动；
 *   control  再装 `computer` —— 点击、输入、按键、滚动、拖拽。
 *
 * 它与 `--sandbox` **正交**，理由写在 ADR-0013：沙箱管的是 Atlas 自己的子进程，
 * GUI 动作在**别的应用的进程里**生效，`SANDBOXED` 对它不成立。把 GUI 绑在
 * `--sandbox off` 上，等于逼用户为了点一下 TextEdit 而关掉 run_shell 的沙箱。
 * 所以单独一个开关，并且每个 GUI 动作在 riskFacts 里如实标 `GUI_INPUT_NOT_SANDBOXED`。
 *
 * ── 【定】白名单由人在启动时写下，是一次**静态授权**，不是运行期 lease ────────
 *
 * ADR-0005 / 决 5 不做 capability lease，那条决定不动：这里没有「运行中申请、
 * 授予、过期」的机制，只有启动参数里一张写死的应用表，随工具定义冻结进 RunSpec。
 * 截图也只截这张表里应用的窗口 —— 表外的一切（其他应用、通知、桌面）
 * 不会出现在发往模型端点的图里。
 * ══════════════════════════════════════════════════════════════════════
 */

export type ComputerUseLevel = "off" | "view" | "control";

export interface AppRule {
  /** 用户写的原文：bundle id（含点号）或应用名。 */
  raw: string;
  kind: "BUNDLE_ID" | "NAME";
}

export interface ComputerUseConfig {
  level: ComputerUseLevel;
  apps: AppRule[];
  /**
   * 浏览器可以被写进白名单（`--computer-allow-browsers`，ADR-0015，**只在 CLI 入口**）。
   * 只解除「浏览器」这一类；终端、IDE、Agent 宿主、凭证与安全类无论如何都不能操作。
   */
  allowBrowsers: boolean;
}

export const COMPUTER_OFF: ComputerUseConfig = { level: "off", apps: [], allowBrowsers: false };

/**
 * 硬拒绝名单：**无论白名单怎么写都不能操作**的应用（ADR-0013）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它有两处执行：TS 这一侧（配置解析 ＋ 每次动作前），以及 Swift 助手
 * 投递事件前的再判一次。两层的职责与 `run_shell` 的两道闸门同构 ——
 * 前者判「要不要做」，后者判「能碰到什么」；合并成一层的必然写法是
 * 「既然 TS 判过了，助手就不用判了」，那正好把最后一道拆掉。
 *
 * 每一类为什么在这里：
 *   · 终端 / IDE / Agent 宿主 —— 等同于**无沙箱的 shell**：在里面打一行字就是
 *     执行任意命令，而这些命令绕过 run_shell 的两道闸门与审批面上的命令原文。
 *     要跑命令就用 run_shell。
 *   · 浏览器 —— 网页任务用 Playwright MCP（按页面结构操作比点像素可靠）；
 *     更要紧的是 **Atlas 的审批卡片就显示在浏览器里**：允许 GUI 点浏览器，
 *     模型就能点到自己的「批准」按钮（自我审批）。
 *   · 凭证与安全 —— 钥匙串、密码管理器、系统设置、登录与授权对话框：
 *     一次误点或一次被注入的输入，后果是凭证外泄或安全设置被改。
 * ══════════════════════════════════════════════════════════════════════
 */
const HARD_DENIED: Array<{ category: string; bundlePrefixes: string[]; names: string[]; optIn?: "browsers" }> = [
  {
    category: "终端（等同无沙箱的 shell，请用 run_shell）",
    bundlePrefixes: [
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "dev.warp.",
      "net.kovidgoyal.kitty",
      "io.alacritty",
      "org.alacritty",
      "com.github.wez.wezterm",
      "com.mitchellh.ghostty",
      "co.zeit.hyper",
    ],
    names: ["terminal", "终端", "iterm", "iterm2", "warp", "kitty", "alacritty", "wezterm", "ghostty", "hyper"],
  },
  {
    category: "IDE / 代码编辑器（内含终端，等同 shell）",
    bundlePrefixes: [
      "com.jetbrains.",
      "com.google.android.studio",
      "com.microsoft.VSCode",
      "com.visualstudio.code",
      "com.todesktop.",
      "com.exafunction.windsurf",
      "dev.zed.",
      "com.apple.dt.Xcode",
      "com.sublimetext.",
    ],
    names: [
      "webstorm", "intellij idea", "pycharm", "goland", "clion", "rider", "datagrip", "phpstorm",
      "rubymine", "android studio", "visual studio code", "code", "cursor", "windsurf", "zed",
      "xcode", "sublime text",
    ],
  },
  {
    category: "Agent 宿主（内含终端与自动化能力）",
    bundlePrefixes: ["com.anthropic.", "com.workagent."],
    names: ["claude"],
  },
  {
    category: "浏览器（网页任务请用 Playwright MCP；且 Atlas 的审批卡片就在浏览器里）",
    /**
     * 【定】唯一可以显式解除的一类（ADR-0015）。理由只对它成立：它被拒的首要原因是
     * 「Atlas 的审批卡片就在浏览器里」（自我审批），而 CLI 入口的审批在终端 —— 终端仍是硬拒绝。
     * 其余几类拒绝的理由是「等同无沙箱的 shell」或「凭证」，与入口无关，不开口子。
     */
    optIn: "browsers",
    bundlePrefixes: [
      "com.apple.Safari",
      "com.google.Chrome",
      "org.chromium.",
      "org.mozilla.",
      "com.microsoft.edgemac",
      "com.brave.",
      "company.thebrowser.",
      "com.operasoftware.",
      "com.vivaldi.",
    ],
    names: [
      "safari", "google chrome", "chrome", "chromium", "firefox", "microsoft edge", "edge",
      "brave browser", "brave", "arc", "opera", "vivaldi",
    ],
  },
  {
    category: "凭证与安全（钥匙串、密码管理器、系统设置、登录与授权对话框）",
    bundlePrefixes: [
      "com.apple.keychainaccess",
      "com.apple.Passwords",
      "com.1password.",
      "com.agilebits.",
      "com.bitwarden.",
      "com.lastpass.",
      "com.dashlane.",
      "com.apple.systempreferences",
      "com.apple.Settings",
      "com.apple.SecurityAgent",
      "com.apple.loginwindow",
      "com.apple.LocalAuthentication",
      "com.apple.coreservices.uiagent",
    ],
    names: [
      "keychain access", "钥匙串访问", "passwords", "密码", "1password", "bitwarden", "lastpass",
      "dashlane", "system settings", "系统设置", "system preferences", "系统偏好设置",
    ],
  },
];

/**
 * 命中硬拒绝名单时返回类别说明；否则 undefined。bundle id 与应用名两种身份都判。
 * `allowBrowsers` 为真时跳过「浏览器」那一类（ADR-0015）；其余类别不受影响。
 */
export function hardDeniedReason(
  app: { bundleId?: string; name?: string },
  opts: { allowBrowsers?: boolean } = {},
): string | undefined {
  const bid = app.bundleId ?? "";
  const name = (app.name ?? "").trim().toLowerCase();
  // 以「.」结尾的是厂商前缀（`com.jetbrains.` 认全家）；其余认它本身及其变体
  // （`com.google.Chrome` 也认 `com.google.Chrome.canary`）。
  const hit = (p: string): boolean =>
    p.endsWith(".") ? bid.startsWith(p) : bid === p || bid.startsWith(`${p}.`);
  for (const group of HARD_DENIED) {
    if (group.optIn === "browsers" && opts.allowBrowsers) continue;
    if (bid && group.bundlePrefixes.some(hit)) return group.category;
    if (name && group.names.includes(name)) return group.category;
  }
  return undefined;
}

/** 白名单的一条是否认这个应用。bundle id 精确匹配；名字不分大小写精确匹配。 */
export function ruleMatches(rule: AppRule, app: { bundleId: string; name: string }): boolean {
  return rule.kind === "BUNDLE_ID"
    ? rule.raw === app.bundleId
    : rule.raw.trim().toLowerCase() === app.name.trim().toLowerCase();
}

/**
 * `--computer off|view|control` ＋ `--computer-apps "TextEdit,com.apple.calculator"`。
 *
 * 【定】受枚举约束、非法值立刻失败（与 `--approval` / `--sandbox` 同一条纪律）：
 * `--computer contrl` 静默落回 off 的话，用户以为开了、实际一个 GUI 工具都没有，
 * 而模型会在总结里说「我没有操作屏幕的能力」—— 那是另一件事的样子。
 *
 * 【定】白名单里出现硬拒绝的应用 → 立刻失败并说明类别，**不静默剔除**。
 * 剔除的话，用户以为允许了 Safari，实际每一次点击都被拒，而原因藏在某条工具结果里。
 */
export function parseComputerFlags(
  level: string | undefined,
  apps: string | undefined,
  allowBrowsers = false,
): ComputerUseConfig {
  const v = (level ?? "off").toLowerCase();
  if (v !== "off" && v !== "view" && v !== "control") {
    throw new Error(
      `--computer 只能是 off / view / control，收到：${level}\n` +
        `  off      不装配 GUI 工具（默认）\n` +
        `  view     只能截图（白名单应用的窗口）\n` +
        `  control  还能点击、输入、按键、滚动、拖拽（每一步按审批档位处置）`,
    );
  }
  if (v === "off") {
    if (apps !== undefined && apps.trim() !== "") {
      throw new Error("给了 --computer-apps 却没有用 --computer view|control 开启 computer use。");
    }
    if (allowBrowsers) {
      throw new Error("给了 --computer-allow-browsers 却没有用 --computer view|control 开启 computer use。");
    }
    return COMPUTER_OFF;
  }
  const rules: AppRule[] = (apps ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((raw) => ({ raw, kind: raw.includes(".") ? ("BUNDLE_ID" as const) : ("NAME" as const) }));
  if (rules.length === 0) {
    throw new Error(
      "--computer view|control 必须同时用 --computer-apps 列出允许的应用（逗号分隔，应用名或 bundle id），" +
        '例如 --computer-apps "TextEdit,Calculator"。\n' +
        "截图只包含这些应用的窗口，动作也只能落在它们上面 —— 没有白名单就没有可操作的东西。",
    );
  }
  for (const r of rules) {
    const why = hardDeniedReason(r.kind === "BUNDLE_ID" ? { bundleId: r.raw } : { name: r.raw }, { allowBrowsers });
    if (why) {
      const browserHint = hardDeniedReason(r.kind === "BUNDLE_ID" ? { bundleId: r.raw } : { name: r.raw }, { allowBrowsers: true })
        ? ""
        : "（浏览器可以在 CLI 入口用 --computer-allow-browsers 显式放开，见 ADR-0015）";
      throw new Error(`--computer-apps 里的「${r.raw}」不能加入白名单：${why}${browserHint}。见 ADR-0013。`);
    }
  }
  return { level: v, apps: rules, allowBrowsers };
}

/** 白名单的一行展示（工具描述、启动横幅、审批面共用）。 */
export function describeAllowlist(config: ComputerUseConfig): string {
  return config.apps.map((a) => a.raw).join("、");
}
