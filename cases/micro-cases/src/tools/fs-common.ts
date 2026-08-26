/**
 * 三个文件工具共用的边界判定。
 *
 * 在此之前 `isInside` 在 list-dir / write-note / append-log 里各有一份**逐字相同**的
 * 拷贝。三份拷贝意味着 R-5（realpath 边界）将来要改三处，而三处里漏一处
 * 不会有任何东西告诉你 —— 这正是 R-5 曾经能同时存在于三个工具里的原因。
 *
 * ── R-5 已于阶段 2 修复 ────────────────────────────────────────────────
 *
 * 原实现是「`resolve()` 之后比较字符串前缀」。它挡得住 `..`，
 * 挡不住 workspace 内已存在的、指向外部的符号链接：
 *
 *     workspace/link -> /outside
 *     write_note(path="link/x.txt")   词法上仍以 workspace 开头，
 *                                     而 Node 的 writeFile 会跟随链接。
 *
 * 利用门槛当时就说清楚过：阶段 1 没有任何能创建符号链接的工具，
 * 需要 workspace 里预先存在外指链接。所以它是**边界缺口**，
 * 不是「Agent 当时就能越权读写」—— 但边界缺口该在有人踩进来之前补上。
 *
 * 现在的判定是**两道**：
 *   ① 词法前缀（快，挡 `..`）；
 *   ② `realpath` 之后再比一次（挡符号链接）。
 * 目标不存在时对**最近的已存在祖先**做 realpath —— 写一个新文件时
 * 目标本身还没有，但它的父目录有，而链接就藏在父目录那一段路径上。
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * target 是否落在 workspace 根之内。
 *
 * 【定】这是执行边界的第二道 —— EffectResolver 已经算过一次，两者都不能省（V05 §22.1）。
 * 两道的意义不同：EffectResolver 决定「要不要审批」，这里决定「允不允许真的动手」。
 */
export function isInsideWorkspace(root: string, target: string): boolean {
  const r = resolve(root);
  if (!lexicallyInside(r, target)) return false;

  /**
   * 【定】root 自己也要 realpath。
   *
   * macOS 上 `/tmp` 就是指向 `/private/tmp` 的链接 —— 只对 target 解析、
   * 不对 root 解析的话，所有临时目录里的合法写入都会被误判成越界。
   * 「误判越界」比漏判更难发现：它表现为工具毫无理由地失败。
   */
  const realRoot = safeRealpath(r);
  const realTarget = safeRealpath(target);
  if (realRoot === undefined || realTarget === undefined) return false;
  return lexicallyInside(realRoot, realTarget);
}

function lexicallyInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + "/");
}

/**
 * 解析真实路径。目标不存在时向上找最近的已存在祖先，把剩下的一段拼回去。
 *
 * 为什么要这么绕：`write_note("新目录/新文件.txt")` 的目标不存在，
 * 直接 realpath 会抛 ENOENT。而链接可能就在「新目录」的上一级 ——
 * 只要能解析到最近的已存在祖先，那一段链接就已经被摊平了。
 */
function safeRealpath(p: string): string | undefined {
  let cur = resolve(p);
  const tail: string[] = [];
  // 最多向上 64 层。真实路径不会这么深，这个上限只是防御性的循环保护。
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : `${real}/${tail.reverse().join("/")}`;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return undefined; // 到根了还不存在
      tail.push(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
  return undefined;
}
