/**
 * 读黑名单（决 3 修订 2 · 护栏 1）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 决 3 放开了「读」的 workspace 边界，原论证是：
 *
 *     读错文件是信息问题，写错文件是不可逆损失。
 *
 * **批 2 引入 `fetch_url` 之后这条不成立**：
 *
 *     读是信息问题 ⇒ 信息可以被外发 ⇒ 读 ＋ 外发 ＝ 损失。
 *
 * 完整链路（阶段 3 方案 §0.1 逐段核过源码）：
 *   workspace 外读放开
 *     → read_file / search 读到仓库根 .env（含真实端点凭证与 baseUrl）
 *     → 内容进入上下文（SimpleRedaction 只打 sk- 形状与 email，其余漏网）
 *     → 外部网页正文注入，诱导模型调用 fetch_url("https://…/?d=<内容>")
 *     → GET 的 query 参数就是外发通道
 *
 * 这条链路**不需要创建任何授权**，所以 §22.4【定】「不可信内容不能创建
 * Grant / 改变 Policy / 自动批准 Action」拦不住它。
 *
 * ── 【定】黑名单必须同时覆盖 read_file 与 search ──────────────────────
 *
 * `search(kind: "content")` 一次能扫遍整棵目录树，比 `read_file` 更高效地
 * 构成同一条外泄链路。只挡 read_file 等于没挡。
 * `verify:tools` F 段因此对**两个工具各试一次**，不是只试一次。
 *
 * ── 为什么 stat 不在管辖范围 ──────────────────────────────────────
 *
 * `stat` 只回 kind / size / mtime，不回内容。挡它换不来任何保密性，
 * 却会让「这个文件在不在」这种无害的问题也失败。
 * 【定】判据是「会不会把**内容**带进上下文」，不是「名字里有没有 secret」。
 * ══════════════════════════════════════════════════════════════════════
 */

import { basename, sep } from "node:path";

/**
 * 路径中出现即拒绝的**目录名**。
 *
 * `.git` 里有完整历史（含曾经提交过的凭证）；`.workagent-state` 是
 * Runtime 自己的 SQLite 库（里面有全部 transcript，也就有全部工具输出）；
 * 后三个是通用的凭证目录。
 */
const DENIED_SEGMENTS = new Set([
  ".git",
  ".workagent-state",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
]);

/**
 * 文件名（basename）匹配即拒绝。
 *
 * `.env` 用前缀匹配 —— `.env.local` / `.env.production` 同样是凭证文件，
 * 而它们不会长成 `.env` 这个精确串。
 */
const DENIED_BASENAME_PREFIXES = [".env"];
const DENIED_BASENAMES = new Set([
  /**
   * `.envrc` 是 direnv 的配置，正文常常就是一排 `export SECRET=…` ——
   * 它是凭证文件，但**上面那条前缀规则抓不到它**：判据是
   * 「等于 `.env`」或「以 `.env.` 开头」，而 `.envrc` 两条都不中。
   *
   * 【定】走精确名单，不放宽成 `startsWith(".env")` ——
   * 那会连 `.environment.md` 这类正常文件一起挡掉，而误伤会让人去绕过护栏。
   */
  ".envrc",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_ed25519",
  ".git-credentials",
]);

export interface ReadDenial {
  /** 命中的规则，写进错误信息 —— 拒绝必须说得出理由，否则模型只会反复重试。 */
  rule: string;
}

/**
 * 这个绝对路径能不能读。返回 undefined = 可以读。
 *
 * 【定】入参必须是**已 resolve 的绝对路径**。拿相对路径来判会漏：
 * `a/../.env` 的 basename 是 `.env`，但 `x/.envfoo/../.env` 这类
 * 只有 resolve 之后才对得上。调用方一律先过 `resolveToolPath()`。
 */
export function checkReadAllowed(absolutePath: string): ReadDenial | undefined {
  const name = basename(absolutePath);

  for (const p of DENIED_BASENAME_PREFIXES) {
    if (name === p || name.startsWith(`${p}.`)) {
      return { rule: `文件名以 "${p}" 开头（凭证文件）` };
    }
  }
  if (DENIED_BASENAMES.has(name)) {
    return { rule: `文件名 "${name}" 在凭证文件黑名单里` };
  }
  for (const seg of absolutePath.split(sep)) {
    if (DENIED_SEGMENTS.has(seg)) {
      return { rule: `路径中包含受保护目录 "${seg}"` };
    }
  }
  return undefined;
}

/**
 * `search` 遍历时用的快速过滤。
 *
 * 与 `checkReadAllowed` 是同一份规则，只是返回 boolean —— 遍历里每个条目
 * 都要判一次，构造 ReadDenial 对象没有意义。
 *
 * 【定】两个函数必须共用同一份常量表。分成两份规则就会有「read_file 挡住了、
 * search 漏过去了」的那天，而那正是本文件存在的理由。
 */
export function isReadDeniedPath(absolutePath: string): boolean {
  return checkReadAllowed(absolutePath) !== undefined;
}

/**
 * 供 verify 段打印，证明黑名单不是一个空集合。
 *
 * 【定】打印的写法必须与**实现**一致。这里此前写的是 `basename .env*`，
 * 而实现是「等于 `.env` 或以 `.env.` 开头」—— 于是 `.envrc` 明明漏网，
 * 验收输出看上去却像挡住了。一个骗人的打印比不打印更糟。
 */
export function readGuardRules(): string[] {
  return [
    ...DENIED_BASENAME_PREFIXES.flatMap((p) => [`basename ${p}`, `basename ${p}.*`]),
    ...[...DENIED_BASENAMES].map((n) => `basename ${n}`),
    ...[...DENIED_SEGMENTS].map((s) => `segment ${s}/`),
  ];
}
