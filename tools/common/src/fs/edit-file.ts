/**
 * edit_file —— 精确字符串替换。【场景工具】
 *
 * 三场景：
 *   办公：改文档里的一段措辞、更新一个日期，而不重写整份文件
 *   代码：改一个函数、改一行配置
 *   聊天：在纪要里补一条待办
 *
 * 形态：非幂等 ＋ **可观察**（前置指纹 = 文件 hash）→ §18.2 **分支二**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是「唯一匹配的字符串替换」而不是「行范围替换」——
 * 理由是形态，不是偏好：
 *
 * · **可验证**：Verification 能读回文件确认替换真的发生了；
 * · **非幂等 ＋ 可观察**：目标状态取决于起始状态，所以需要前置指纹；
 *   而文件 hash 恰好能回答「那次替换发生没发生」；
 * · 行范围在文件被并发改动后语义会**悄悄漂**（第 40 行还是不是那一行？），
 *   而唯一匹配失败是一个**显式错误**。
 *
 * ── 它是本批唯一天然落在分支二的「场景工具」───────────────────────
 *
 * 此前只有为测量而生的 `write_note` 落在那条分支上。也就是说
 * §2.4 的 `CompositeVerifier` 三方法路由，在这里第一次被**真正需要**：
 * 路由漏了 `observePre`，前置指纹拍不到，`edit_file` 就会静默退化到分支三，
 * 而**盘上看不出来、没有任何报错**。批 1 验收 E 段专测这一条。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 【定】失败必须给结构化诊断。
 *
 * 模型输出的 old_string 极易因空格 / CRLF vs LF 的微小差异匹配失败；
 * 没有诊断线索它只能反复重试同一个错误 —— 那正是 S9 的 Progress Guard
 * 要检测的「无进展」形态。与其让守卫去收尸，不如一开始就把线索给够。
 */

import { readFile, writeFile } from "node:fs/promises";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";
import { classifyFsError, resolveToolPath, writeBoundaryRefusal } from "./fs-common.js";

export const editFileDefinition: ToolDefinition = {
  id: asId("tool_edit_file"),
  version: "1.0.0",
  name: "edit_file",
  description:
    "把文件里的一段文本替换成另一段。old_string 必须在文件中**恰好出现一次**，" +
    "否则不做任何修改并返回诊断（零匹配给出最接近的候选行，多重匹配给出全部命中行号）。" +
    "路径必须落在 workspace 内。" +
    "多带几行上下文让 old_string 唯一，比反复重试同一个短串有效得多；" +
    "整份文件重写用 write_file，不要用本工具。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "相对 workspace 根的文件路径" },
      old_string: { type: "string", description: "要被替换的原文，必须在文件中唯一出现" },
      new_string: { type: "string", description: "替换成的新文本。传空串表示删除那一段" },
    },
    required: ["path", "old_string", "new_string"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/path",
      effectType: "WRITE",
      scopeKind: "FILE",
      // 旧内容被新内容盖掉，找不回来 —— 与覆盖写同档。
      reversibility: "PARTIALLY_REVERSIBLE",
      operation: "edit",
    },
  },
  redaction: { profile: "STANDARD" },
  /**
   * 【定】真的非幂等，不是为了测试才这么标（对比 write_file 的说明）。
   *
   * 替换执行过一次之后，old_string 就不在文件里了 —— 再执行一次会得到
   * 「零匹配」而不是同样的结果。这正是分支二存在的意义：崩溃后不能盲目重跑。
   */
  idempotency: { isIdempotent: false, isReadOnly: false },
  timeoutPolicy: { timeoutMs: 30_000 },
  progressReporting: { mode: "NONE" },
  verification: {
    mode: "REOBSERVE",
    requiredForSuccess: true,
  },
  /**
   * 【定】`requiresPreFingerprint: true`。
   *
   * 替换是**相对**操作：目标状态取决于起始状态。崩溃后单看文件内容
   * 判不出「那次替换发生没发生」—— 新内容可能本来就在那儿。
   * 只有拿执行前的 hash 比一比，才回答得了。
   */
  recoveryObservation: { requiresPreFingerprint: true },
};

export async function executeEditFile(
  input: { path: string; old_string: string; new_string: string },
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const target = resolveToolPath(ctx.workspaceRoot, input.path);

  // 【定】与另外三个写工具共用同一份判定（见 `writeBoundaryRefusal`）。
  const refusal = writeBoundaryRefusal(ctx, target, "编辑", input.path);
  if (refusal) {
    return { ok: false, output: "", sideEffectState: "NO_EFFECT", error: refusal };
  }

  if (input.old_string === "") {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_EDIT_EMPTY_OLD",
        source: "TOOL_INPUT",
        category: "VALIDATION",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: "edit_file 的 old_string 不能为空 —— 空串在任何文件里都有无数个匹配点。",
      }),
    };
  }

  let original: string;
  try {
    original = await readFile(target, "utf8");
  } catch (err) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: classifyFsError(err, `编辑 "${input.path}"`),
    };
  }

  const hits = allIndexesOf(original, input.old_string);

  // ── 零匹配：给出最接近的候选行（诊断，不是失败信息的装饰）
  if (hits.length === 0) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_EDIT_NO_MATCH",
        source: "TOOL_INPUT",
        category: "NOT_FOUND",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage: diagnoseNoMatch(original, input.old_string, input.path),
      }),
    };
  }

  // ── 多重匹配：给出**全部**命中行号，提示扩大上下文
  if (hits.length > 1) {
    const lineNos = hits.map((i) => lineOf(original, i));
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_EDIT_AMBIGUOUS",
        source: "TOOL_INPUT",
        category: "CONFLICT",
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage:
          `old_string 在 ${input.path} 里出现了 ${hits.length} 次（行 ${lineNos.join(", ")}），` +
          `不唯一，未做任何修改。请把 old_string 往前后各扩几行，直到它只匹配你想改的那一处。`,
      }),
    };
  }

  if (ctx.signal.aborted) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NOT_STARTED",
      error: makeError({
        code: "TOOL_CANCELLED",
        source: "RUNTIME",
        category: "CANCELLED",
        retryability: "SAME_INPUT_IMMEDIATE",
        sideEffectState: "NOT_STARTED",
        safeMessage: "edit_file 在写入前被取消",
      }),
    };
  }

  const at = hits[0]!;
  const updated =
    original.slice(0, at) + input.new_string + original.slice(at + input.old_string.length);

  try {
    await writeFile(target, updated, "utf8");
    return {
      ok: true,
      output: JSON.stringify({
        path: input.path,
        replacedAtLine: lineOf(original, at),
        bytesBefore: Buffer.byteLength(original, "utf8"),
        bytesAfter: Buffer.byteLength(updated, "utf8"),
      }),
      sideEffectState: "APPLIED",
    };
  } catch (err) {
    return {
      ok: false,
      output: "",
      // 写到一半失败：盘上是旧内容还是半截新内容，这里判不出来。
      sideEffectState: "UNKNOWN",
      error: { ...classifyFsError(err, `编辑 "${input.path}"`), sideEffectState: "UNKNOWN" },
    };
  }
}

/**
 * 独立 Verification：读回文件确认替换真的发生了。
 *
 * 【定】两个条件都要查。只查「新内容在」的话，new_string 恰好是文件里
 * 本来就有的一段时会误判通过 —— 而那正是替换没发生的典型现场。
 *
 * ── 【定】但「原内容不在」**不是所有情况下都成立的后置条件** ──────────────
 *
 * 当 `new_string` **包含** `old_string` 时（在一个锚点后面插入内容，
 * 这是最常见的编辑形态之一），替换成功之后文件里当然还有 old_string ——
 * 它就在 new_string 里面。这时要求「原内容不在」是**逻辑上不可能满足**的，
 * 于是每一次「锚点后插入」都会被判成验证失败。
 *
 * 这不是理论问题：S13 的代码场景任务第一次跑就撞上了 ——
 * 一次完全正确的 `edit_file` 让整个 Run 从 SUCCESS 掉成 COMPLETED_WITH_LIMITS，
 * 而产物本身一个字都没错。一个在正确行为上报警的验证器，
 * 比没有验证器更糟：它会训练人忽略它。
 */
export async function verifyEditFile(
  input: { path: string; old_string: string; new_string: string },
  ctx: ToolExecutionContext,
): Promise<{ ok: boolean; detail: string }> {
  const target = resolveToolPath(ctx.workspaceRoot, input.path);
  try {
    const actual = await readFile(target, "utf8");
    const hasNew = input.new_string === "" ? true : actual.includes(input.new_string);
    // 新内容包含旧内容时，「旧内容消失」根本不是这次编辑的后置条件。
    const oldMayRemain = input.new_string.includes(input.old_string);
    const oldGone = oldMayRemain || !actual.includes(input.old_string);

    if (hasNew && oldGone) {
      return {
        ok: true,
        detail: oldMayRemain
          ? `重新读取 ${input.path}：新内容已就位（新内容包含原内容，属锚点插入，不要求原内容消失）`
          : `重新读取 ${input.path}：新内容已就位，原内容已不存在`,
      };
    }
    return {
      ok: false,
      detail:
        `重新读取 ${input.path}：` +
        (hasNew ? "" : "新内容未出现；") +
        (oldGone ? "" : "原内容仍然存在；") +
        "替换未按预期完成",
    };
  } catch (err) {
    return {
      ok: false,
      detail: `重新读取 ${input.path} 失败：${String((err as Error).message).slice(0, 120)}`,
    };
  }
}

// ══════════════════════════════════════════════════════════ 诊断

function allIndexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
    // 上限：一个短串在大文件里可以有几万个匹配点，列全了没有意义。
    if (out.length > 50) break;
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

/**
 * 零匹配时的候选行。
 *
 * 判据：拿 old_string 的第一行去做**去空白**的近似匹配。
 * 之所以按「去掉所有空白后比较」，是因为匹配失败最常见的成因恰恰是
 * 缩进、行尾空格、CRDLF 与 LF 的差异 —— 而这些在原样比较下完全看不出来。
 */
function diagnoseNoMatch(text: string, oldString: string, path: string): string {
  const head = (oldString.split("\n")[0] ?? "").trim();
  const norm = (s: string): string => s.replace(/\s+/g, "");
  const target = norm(head);

  const lines = text.split("\n");
  const candidates: Array<{ line: number; text: string }> = [];
  if (target.length > 0) {
    for (let i = 0; i < lines.length && candidates.length < 3; i++) {
      const l = norm(lines[i]!);
      if (l.includes(target) || (target.length > 8 && l.includes(target.slice(0, 8)))) {
        candidates.push({ line: i + 1, text: lines[i]!.slice(0, 200) });
      }
    }
  }

  const crlf = text.includes("\r\n");
  return (
    `old_string 在 ${path} 里一次都没匹配上，未做任何修改。` +
    (candidates.length > 0
      ? `\n最接近的候选（去掉空白后比较）：\n` +
        candidates.map((c) => `  第 ${c.line} 行：${c.text}`).join("\n") +
        `\n请按文件里的**原样**（含缩进与行尾）重新给出 old_string。`
      : `\n文件里没有形状接近的行 —— 确认一下路径与内容是否对得上，必要时先 read_file 看一眼。`) +
    (crlf ? `\n注意：这个文件用的是 CRLF 行尾，old_string 里的换行必须与之一致。` : "")
  );
}

export const editFileSnapshot: ToolSnapshot = {
  toolId: editFileDefinition.id,
  version: editFileDefinition.version,
  definition: editFileDefinition,
};
