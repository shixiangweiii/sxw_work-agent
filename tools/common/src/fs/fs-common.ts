/**
 * 文件工具共用的路径判定与错误分类。
 *
 * ── 为什么它住在 tools/common 而不是继续留在 cases/micro-cases ──────────
 *
 * 阶段 3 之前这份代码在 `cases/micro-cases/src/tools/fs-common.ts`，
 * 而阶段 3 的通用工具（read_file / write_file / search / edit_file）要用同一道判定。
 * 复制一份的代价在原文件头里已经写过一次了：R-5（realpath 边界）当年之所以
 * 能同时存在于三个工具里，就是因为有三份逐字相同的拷贝。
 *
 * 【定】所以这里是**唯一**一份实现；`cases/micro-cases` 反过来 import 它。
 * 方向是 cases → tools，不违反边界 6b（那条禁的是 tools → cases）。
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import {
  makeError,
  type RuntimeErrorRecord,
  type ToolExecutionContext,
} from "@workagent/harness-runtime";

/**
 * target 是否落在 workspace 根之内。
 *
 * 【定】这是执行边界的第二道 —— EffectResolver 已经算过一次，两者都不能省（V05 §22.1）。
 * 两道的意义不同：EffectResolver 决定「要不要审批」，这里决定「允不允许真的动手」。
 *
 * ── R-5 已于阶段 2 修复，判定是两道 ───────────────────────────────────
 *
 * ① 词法前缀（快，挡 `..`）；② `realpath` 之后再比一次（挡符号链接）。
 * 目标不存在时对**最近的已存在祖先**做 realpath —— 写一个新文件时目标本身
 * 还没有，但它的父目录有，而链接就藏在父目录那一段路径上。
 *
 * 【定】阶段 3 起它**只约束写**（决 3）。读工具不再调用它 —— 但读放开
 * 换来的是另外三条护栏，见 read-guard.ts 的文件头。
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
  return target === root || target.startsWith(root + sep);
}

/**
 * 解析真实路径。目标不存在时向上找最近的已存在祖先，把剩下的一段拼回去。
 *
 * 为什么要这么绕：`write_file("新目录/新文件.txt")` 的目标不存在，
 * 直接 realpath 会抛 ENOENT。而链接可能就在「新目录」的上一级 ——
 * 只要能解析到最近的已存在祖先，那一段链接就已经被摊平了。
 */
export function safeRealpath(p: string): string | undefined {
  let cur = resolve(p);
  const tail: string[] = [];
  // 最多向上 64 层。真实路径不会这么深，这个上限只是防御性的循环保护。
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : `${real}${sep}${tail.reverse().join(sep)}`;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return undefined; // 到根了还不存在
      tail.push(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
  return undefined;
}

/**
 * 把模型给的路径解析成绝对路径。
 *
 * 【定】相对路径一律相对 workspace 根，绝对路径原样接受 —— 后者只对**读**
 * 工具有意义（决 3 读放开）。写工具随后还要过 `isInsideWorkspace`。
 */
export function resolveToolPath(workspaceRoot: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p || ".");
}

// ══════════════════════════════════════════ N-8：文件系统错误分类

/**
 * 把 Node 的 errno 映射成**有判别力**的 RuntimeErrorRecord。
 *
 * ── N-8：修之前所有异常都折叠成 NOT_FOUND / AFTER_MODEL_CORRECTION ──────
 *
 * 那个映射有两处真实伤害：
 *
 *   · **EACCES 被报成「目录不存在」** —— 模型无从纠正。它会去换一个路径、
 *     或者认定那个目录不存在，而真相是「它存在，只是你没权限」。
 *     retryability 也错了：换个路径重试不会变好，这需要人去改权限。
 *   · **ELOOP / 断链符号链接能让整页列举失败** —— 一个坏链接把
 *     `list_dir` 的整次调用变成 NOT_FOUND。
 *
 * 【定】它必须在写五个新工具**之前**修好：新工具会照抄第一个工具的形状，
 * 抄错的形状在五个地方复现之后就不是「一处 bug」而是「一种风格」了。
 */
export function classifyFsError(err: unknown, what: string): RuntimeErrorRecord {
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? "";
  const detail = String(e?.message ?? err).slice(0, 200);

  switch (code) {
    case "ENOENT":
      return makeError({
        code: "TOOL_FS_NOT_FOUND",
        source: "TOOL_HANDLER",
        category: "NOT_FOUND",
        // 模型可以自己换一个存在的路径 —— 这是它纠正得了的。
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `${what}：路径不存在（ENOENT）。${detail}`,
      });
    case "EACCES":
    case "EPERM":
      return makeError({
        code: "TOOL_FS_PERMISSION",
        source: "TOOL_HANDLER",
        category: "AUTHORIZATION",
        // 【定】不是 AFTER_MODEL_CORRECTION：换路径、重试都不会变好，要人去改权限。
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `${what}：没有权限访问（${code}）。路径存在，但当前进程读不了它。${detail}`,
      });
    case "ENOTDIR":
      return makeError({
        code: "TOOL_FS_NOT_A_DIRECTORY",
        source: "TOOL_INPUT",
        category: "VALIDATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `${what}：路径中有一段不是目录（ENOTDIR）。若目标是文件，请用 read_file 或 stat。${detail}`,
      });
    case "EISDIR":
      return makeError({
        code: "TOOL_FS_IS_A_DIRECTORY",
        source: "TOOL_INPUT",
        category: "VALIDATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `${what}：目标是一个目录（EISDIR）。列目录请用 list_dir。${detail}`,
      });
    case "ELOOP":
      return makeError({
        code: "TOOL_FS_SYMLINK_LOOP",
        source: "TOOL_HANDLER",
        category: "INTERNAL",
        // 符号链接成环是外部世界的状态问题，模型改参数没用。
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: `${what}：符号链接成环或层级过深（ELOOP）。${detail}`,
      });
    case "EMFILE":
    case "ENFILE":
    case "EBUSY":
      return makeError({
        code: "TOOL_FS_TEMPORARY",
        source: "TOOL_HANDLER",
        category: "UNAVAILABLE",
        retryability: "SAME_INPUT_BACKOFF",
        sideEffectState: "NO_EFFECT",
        safeMessage: `${what}：系统资源暂时不可用（${code}），稍后重试。${detail}`,
      });
    default:
      return makeError({
        code: "TOOL_FS_INTERNAL",
        source: "TOOL_HANDLER",
        category: "INTERNAL",
        retryability: "AFTER_USER_ACTION",
        sideEffectState: "NO_EFFECT",
        // 【定】不认识的 errno 如实说「不认识」，不要塞进 NOT_FOUND ——
        // 那正是 N-8 的成因：一个包罗万象的分类等于没有分类。
        safeMessage: `${what}：文件系统错误${code ? `（${code}）` : ""}。${detail}`,
      });
  }
}

/** 越界写的统一拒绝（决 3：写保留 workspace 边界）。 */
/**
 * 写工具的 workspace 边界判定 —— **唯一一份**（ADR-0012）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】四个写工具（`write_file` / `edit_file` / `append_log` / `slow_write`）
 * 必须调它，**不要各自写一遍 `if (!isInsideWorkspace(...)) return ...`**。
 *
 * 各写一遍的后果不是重复，是**分叉**：ADR-0012 加了 `executionPrivilege`
 * 这一维之后，四处里漏改任何一处，就会出现「同一个越界写，`write_file`
 * 放行而 `edit_file` 拒绝」—— 而两边都不会报错，只是行为不同。
 * 这个文件头已经因为「边界判定的唯一事实源」写过一次同样的话。
 *
 * ── 【定】UNRESTRICTED 下放行，而这一条是被一次探针逼出来的 ──────────────
 *
 * ADR-0012 把 `policy.ts` 那条越界写 DENY 改成了 REQUIRE_APPROVAL，
 * 而这里的判定当时**没跟着改**。实测那条路径的原始输出：
 *
 *     policy(SANDBOXED   ) : DENY
 *     policy(UNRESTRICTED) : REQUIRE_APPROVAL
 *     UNRESTRICTED 下工具执行 : 失败 → TOOL_PATH_ESCAPE
 *     文件真的写出来了吗       : 否
 *
 * 也就是说：**停下来问了人，人批准了，然后照样失败。**
 * 那比原来的 DENY 更糟 —— DENY 至少是快速失败、理由明确、
 * `retryability: AFTER_MODEL_CORRECTION` 告诉模型换个路径；
 * 而「问了再失败」既浪费了人的一次决定，又把那次决定变成了空的。
 *
 * 【定】`SANDBOXED` 那一档的语义**一个字没改**：越界写由 Policy 直接拒绝，
 * 这里是第二道（V05 §22.1 要求两道都在）。变的只是「有没有第三种档位」。
 * ══════════════════════════════════════════════════════════════════════
 */
export function writeBoundaryRefusal(
  ctx: Pick<ToolExecutionContext, "workspaceRoot" | "executionPrivilege">,
  target: string,
  op: string,
  shownPath: string,
): RuntimeErrorRecord | undefined {
  if (ctx.executionPrivilege === "UNRESTRICTED") return undefined;
  if (isInsideWorkspace(ctx.workspaceRoot, target)) return undefined;
  return outsideWorkspaceError(shownPath, op);
}

export function outsideWorkspaceError(path: string, op: string): RuntimeErrorRecord {
  return makeError({
    code: "TOOL_PATH_ESCAPE",
    source: "TOOL_INPUT",
    category: "AUTHORIZATION",
    retryability: "AFTER_MODEL_CORRECTION",
    sideEffectState: "NO_EFFECT",
    safeMessage:
      `路径 "${path}" 落在 workspace 之外，拒绝${op}。` +
      `读操作可以越界，写操作不行 —— 读错文件是信息问题，写错文件是不可逆损失。`,
  });
}

/**
 * 取消的统一形态 —— **唯一一份**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】四个写工具（`write_file` / `edit_file` / `append_log` / `slow_write`）
 * 必须调它，不要各自内联一个 `makeError({ code: "TOOL_CANCELLED", … })`。
 *
 * 它此前**零消费者**，而那四处各自抄了一份逐字相同的六行 —— 也就是说
 * 这个函数存在的全部理由（防分叉）从来没有兑现过。同一个文件里
 * `writeBoundaryRefusal` 的【定】刚写完「各写一遍的后果不是重复，是分叉」，
 * 而隔壁就躺着那句话的一个反例。
 *
 * ── 三个字段为什么是这几个值，改之前先读 ───────────────────────────────
 *
 * · `NOT_STARTED` 而不是 `UNKNOWN`：中断点落在副作用**之前**，我们真的知道
 *   什么都没发生。`UNKNOWN` 会造出一个 RecoveryItem 并在 resume 时把 Run 停在
 *   `RECOVERY_REQUIRED` —— 谎报的方向恰好是最贵的那边。
 * · `SAME_INPUT_IMMEDIATE`：取消不是故障，同样的输入重来一次是对的。
 * · `source: "RUNTIME"`：取消来自 Runtime 的 signal，不是工具自己的判断。
 *
 * `detail` 用来带那些**逐次不同**的补充（`slow_write` 要说自己等了多久）——
 * 有了它，四处才真的能共用一份，而不是"三处共用、第四处因为要多说一句
 * 所以又抄了一遍"。
 * ══════════════════════════════════════════════════════════════════════
 */
export function cancelledError(toolName: string, detail?: string): RuntimeErrorRecord {
  return makeError({
    code: "TOOL_CANCELLED",
    source: "RUNTIME",
    category: "CANCELLED",
    retryability: "SAME_INPUT_IMMEDIATE",
    sideEffectState: "NOT_STARTED",
    safeMessage: `${toolName} 在产生副作用之前被取消${detail ? `（${detail}）` : ""}`,
  });
}

export { basename };
