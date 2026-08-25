/**
 * 三个文件工具共用的边界判定。
 *
 * 在此之前 `isInside` 在 list-dir / write-note / append-log 里各有一份**逐字相同**的
 * 拷贝。三份拷贝意味着 R-5（realpath 边界）将来要改三处，而三处里漏一处
 * 不会有任何东西告诉你 —— 这正是 R-5 现在能同时存在于三个工具里的原因。
 *
 * ⚠️ **本次只做收敛，不改判定语义。**
 *
 * 当前实现仍是「resolve() 之后比较字符串前缀」，挡得住 `..`，
 * 挡不住 workspace 内已存在的、指向外部的符号链接：
 *
 *     workspace/link -> /outside
 *     write_note(path="link/x.txt")   词法上仍以 workspace 开头，
 *                                     而 Node 的 writeFile 会跟随链接。
 *
 * 利用门槛要说清楚：阶段 1 没有任何能创建符号链接的工具，需要 workspace 里
 * 预先存在外指链接（用户放的或别的进程放的）。所以它是**边界缺口**，
 * 不是「Agent 现在就能越权读写」。
 *
 * R-5 的修法（`realpath` 之后再比对；目标不存在时对最近的已存在祖先做 realpath）
 * 就落在这个文件里，但那是一次**行为变更**，不该和一次格式修复混在同一批。
 * 见 存量BUG/阶段1存量问题清单 R-5。
 */

import { resolve } from "node:path";

/**
 * target 是否落在 workspace 根之内。
 *
 * 【定】这是执行边界的第二道 —— EffectResolver 已经算过一次，两者都不能省（V05 §22.1）。
 * 两道的意义不同：EffectResolver 决定「要不要审批」，这里决定「允不允许真的动手」。
 */
export function isInsideWorkspace(root: string, target: string): boolean {
  const r = resolve(root);
  return target === r || target.startsWith(r + "/");
}
