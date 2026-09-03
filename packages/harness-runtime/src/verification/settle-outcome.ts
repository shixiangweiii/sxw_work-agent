/**
 * Run 完成判定（V05 §10.4）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *              模型不再请求工具即完成。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这是标准 Harness 循环的做法。没有独立于模型判断的声明式验收机制，理由三条：
 *
 * 1. 它要求在发出第一个 token 之前就知道「什么算做完」，而这个信息不存在。
 *    用户说「把这三篇文章归档」，minCount: 3 里的 3 只存在于自然语言里。
 * 2. 它要解决的问题已被其他机制覆盖：副作用未知由 RECOVERY_REQUIRED 处理，
 *    Eval 的成败判定由 eval/graders/ 独立实现。
 * 3. 单人使用场景下，人在回路里。
 *
 * ── 但保留一条底线 ──────────────────────────────────────────────
 *
 * 结算时必须查一次 required Verification 的结果。
 *
 * 这条与「信不信模型」无关：Verification 已经跑过、扣了 token、结果已经在表里。
 * 结算时忽略它，等于花钱测出一个事实然后扔掉。
 *
 * 注意它不改变循环何时终止，只改变终止后打什么标签。
 */

import type { ArtifactCheckFact, IncompleteItem, RecoveryItem, RunOutcome } from "../types/run.js";
import type { VerificationResult } from "../types/tool.js";

export interface SettleInput {
  verifications: VerificationResult[];
  recoveryItems: RecoveryItem[];
  summary?: string;
  /**
   * 第二层（Artifact 级）Verification 的事实（阶段 3 S8，§10.4）。
   *
   * 【定】Run 层**不提出自己的问题，只汇总前两层已经产生的事实**。
   * 这里也一样：不重新去看产物，只读已经记下的检查结果。
   */
  artifactChecks?: ArtifactCheckFact[];
}

export function settleOutcome(input: SettleInput): RunOutcome {
  const art = splitArtifactChecks(input.artifactChecks ?? []);
  const base = {
    summary: input.summary,
    /**
     * 阶段 1、2 恒空，阶段 3 接上（S8）。
     *
     * 【定】只列**检查通过**的。§17【定】「Deliverable 原则上必须 Verified」——
     * 把一个检查失败的产物列进 `deliveredArtifactIds`，等于对外宣称交付了
     * 一份坏东西。失败的那些走 incompleteItems，在那里说清楚坏在哪。
     */
    deliveredArtifactIds: art.delivered,
    recoveryItems: input.recoveryItems,
  };

  /**
   * ── 【定】核心交付物检查失败 → `FAILED`，先于其他一切判定 ──────────────
   *
   * §1.2 第 3 条。原版方案一律降级为 `COMPLETED_WITH_LIMITS`，那会让
   * 「**交付物是坏的**」和「某个中间步骤有瑕疵」在 outcome 上不可区分 ——
   * 而这两件事对用户的意义差着一个数量级：前者意味着这次 Run 白跑了。
   *
   * 排在 recoveryItems 之前是刻意的：一份坏掉的交付物是**已知的**失败，
   * 而 recoveryItem 只是「有一步状态未知」。已知的坏消息优先于不确定的。
   */
  if (art.failedDeliverables.length > 0) {
    return {
      ...base,
      kind: "FAILED",
      incompleteItems: [...art.failedDeliverables, ...art.failedOthers],
    };
  }

  // 副作用状态未知先于完成判定生效 —— 它是一个独立的非终态分支，
  // 不需要一条 criterion 去表达。
  if (input.recoveryItems.length > 0) {
    return {
      ...base,
      kind: "COMPLETED_WITH_LIMITS",
      incompleteItems: [
        ...input.recoveryItems.map(
          (r): IncompleteItem => ({
            what: r.what,
            why: `副作用状态 ${r.sideEffectState}，需要人工确认`,
            actionId: r.actionId,
          }),
        ),
        ...art.failedOthers,
      ],
    };
  }

  const unmet = unmetRequired(input.verifications);

  if (unmet.length === 0 && art.failedOthers.length === 0) {
    return { ...base, kind: "SUCCESS", incompleteItems: [] };
  }

  /**
   * 中间产物检查失败 → `COMPLETED_WITH_LIMITS` ＋ **具名** incompleteItems。
   *
   * 「具名」是关键：`what` 里要出现是哪个产物、`why` 里要出现坏在哪 ——
   * 一条「有中间产物没通过检查」的记录，事后既查不到是哪个，也修不了。
   */
  if (unmet.length === 0) {
    return { ...base, kind: "COMPLETED_WITH_LIMITS", incompleteItems: art.failedOthers };
  }

  /**
   * ── 决 2：`USER_REJECTED` 的语义边界 ─────────────────────────────────
   *
   * 【定】**仅当所有**未达成的必需项都是「用户拒绝」时，才判 USER_REJECTED。
   *
   * 为什么是「全部」而不是「存在」：批内 3 个 action、1 个被用户拒、
   * 2 个因为工具挂了没做成 —— 判 USER_REJECTED 会把责任栽给用户，
   * 而实际上就算他全批准，那个 Run 也做不成。混着的时候
   * `COMPLETED_WITH_LIMITS` 才是诚实的：它不声称自己知道该怪谁。
   *
   * 【定】这个值域**不新增**成员。「模型声称做不了」不给独立 kind ——
   * 那要判断模型的话语意图，会把结算从「只查事实表」拖回「读模型说了什么」，
   * 直接违反不变量 12。它继续走 SUCCESS ＋ summary（R-7 的一半已于
   * 2026-08-25 接上），代价写进 ADR。
   */
  const causes = input.verifications
    .filter((v) => v.required && v.status !== "PASSED")
    .map((v) => v.unmetCause);
  const allUserRejected = causes.length > 0 && causes.every((c) => c === "USER_REJECTED");

  return {
    ...base,
    kind: allUserRejected ? "USER_REJECTED" : "COMPLETED_WITH_LIMITS",
    incompleteItems: [...unmet, ...art.failedOthers],
  };
}

/**
 * 把 Artifact 级检查事实拆成三堆：交付成功的、坏掉的交付物、坏掉的其他产物。
 *
 * 【定】按 `role` 分流是这一层的**全部意义**。不分流的话，
 * 「交付物是坏的」会和「某个中间步骤有瑕疵」结算成同一个 kind。
 */
function splitArtifactChecks(facts: ArtifactCheckFact[]): {
  delivered: string[];
  failedDeliverables: IncompleteItem[];
  failedOthers: IncompleteItem[];
} {
  const delivered: string[] = [];
  const failedDeliverables: IncompleteItem[] = [];
  const failedOthers: IncompleteItem[] = [];

  /**
   * ══════════════════════════════════════════════════════════════════════
   * 【定】一个 `logicalId` 的**最后一条**事实，才是这个 Run 对它的交付。
   *
   * 被后续版本取代的产物不是「交付物」，是**中间状态** ——
   * 它甚至可能已经不在盘上了（`artifacts` 表只存 metadata＋hash＋path，
   * 而 path 上躺着的是最新那一版的字节）。
   *
   * ── 实测（Run `run_18c20267c1a1`，2026-09-01）───────────────────────────
   *
   * 上一个 Run 在 workspace 留下了 `images.zip`（6.25MB / 49 个文件），
   * 而 `zip -9 ../images.zip …` 对**已存在的归档是追加**：
   *
   *     v2  6,412,214 B  ← 上次的 49 个 ＋ 这次的 2 个，内容是错的
   *     v3    155,558 B  ← 模型看到 stdout 后 rm 重做，正确
   *
   * 两个版本都 `ok`（v2 **确实**是个结构完好的 zip，检查器没判错），
   * 于是 `deliveredArtifactIds` 同时列着它们 —— Atlas 宣称交付了**两份**
   * 同名产物，而磁盘上只有一份，另一份的 6.4MB 已经不可取回。
   *
   * 这条与紧挨着的另外两条【定】共同构成 §17 的 Deliverable 语义，
   * 三条是同一个形状：**交付集合里不许出现一个「对外宣称、而实际不成立」的东西。**
   *
   * ── 失败方向按「最终 / 被取代」分流，而不是一律降级 ─────────────────────
   *
   *   最终版本坏     → failedDeliverables → `FAILED`（这次交付的东西是坏的）
   *   被取代的版本坏 → failedOthers       → `COMPLETED_WITH_LIMITS`（过程有瑕疵，
   *                                          但最终交付物是好的）
   *
   * 【定】被取代的失败**不许直接丢掉**。丢掉的话，「模型产出过一份坏产物、
   * 后来自己修好了」与「一次就做对了」在结算上完全不可区分 —— 而前者意味着
   * 这条任务链路上有一个真实的坑。失败方向仍然保守：它照样让 Run 拿不到 SUCCESS。
   * ══════════════════════════════════════════════════════════════════════
   */
  const finalIndexOf = new Map<string, number>();
  facts.forEach((f, i) => finalIndexOf.set(f.logicalId, i));

  facts.forEach((f, i) => {
    const isFinal = finalIndexOf.get(f.logicalId) === i;

    if (f.ok) {
      /**
       * 【定】只有 `DELIVERABLE` 进 `deliveredArtifactIds`（二次评审 codex P2-3）。
       *
       * 原实现对任何 `ok` 的产物一律 push，于是一个显式声明为 `INTERMEDIATE`
       * 的中间产物会出现在「交付物」清单里 —— 实测：`verify:artifact` E 段的
       * `notes.txt`（INTERMEDIATE）就在里面。
       *
       * `INTERMEDIATE` 这个词的**全部含义**就是「它不是要交的东西」；
       * 把它列进交付集合，等于让 role 在失败方向上有意义（检查失败时分流）、
       * 在成功方向上没意义 —— 而 §17 的 Deliverable 语义两个方向都要成立。
       *
       * 不再保留没有独立语义的第三种 role；非交付物统一是 `INTERMEDIATE`。
       */
      if (isFinal && f.role === "DELIVERABLE" && !delivered.includes(f.artifactId)) {
        delivered.push(f.artifactId);
      }
      return;
    }

    const item: IncompleteItem = {
      what: isFinal
        ? `产物 ${f.logicalId}（${f.role}）未通过完整性检查`
        : `产物 ${f.logicalId}（${f.role}）的一个**中间版本**未通过完整性检查（后来被新版本取代）`,
      why: f.detail,
    };
    if (isFinal && f.role === "DELIVERABLE") failedDeliverables.push(item);
    else failedOthers.push(item);
  });
  return { delivered, failedDeliverables, failedOthers };
}

/**
 * 必需验证里「没有拿到通过」的那些。
 *
 * ── 为什么不是只筛 FAILED ──────────────────────────────────────
 *
 * V05 §10.4 的示例代码只写了 `status === "FAILED"`。照抄它会漏掉一整类事实：
 * 一个 requiredForSuccess 的操作**根本没跑到验证**（工具失败、被 Policy 拒、
 * 被用户拒、被批内策略跳过、被 cancel），此时表里要么是一条 SKIPPED，
 * 要么什么都没有 —— 两种情况下 failed.length 都是 0，Run 结算成 SUCCESS。
 *
 * 【定】跳过不等于通过。SKIPPED 的语义是「这条必需验证没有得出通过的结论」，
 * 它与 FAILED 一样，都不能支撑 SUCCESS。
 *
 * 「压根没有记录」那一类由 settle-batch 负责补事实：任何声明了
 * requiredForSuccess 却没走到 Verification 的 Action，都会合成一条 FAILED。
 * 两处配合，才让 outcome.kind 与实际执行事实一致（不变量 12）。
 */
function unmetRequired(verifications: VerificationResult[]): IncompleteItem[] {
  return verifications
    .filter((v) => v.required && v.status !== "PASSED")
    .map((v) => ({
      what:
        v.status === "FAILED"
          ? `Action ${v.actionId} 的必需验证未通过`
          : `Action ${v.actionId} 的必需验证未能得出结论`,
      why: v.detail,
      actionId: v.actionId,
    }));
}

/**
 * 撞墙路径的 outcome。
 *
 * 这些场景下模型没有机会说完成 —— 它们不走上面的循环终止路径，
 * outcome 由墙决定，DETERMINISTIC handoff 负责把「做到哪了」讲清楚。
 */
export function settleWallOutcome(
  kind: Extract<
    RunOutcome["kind"],
    "BUDGET_EXHAUSTED" | "CONTEXT_EXHAUSTED" | "QUOTA_EXHAUSTED" | "CANCELLED" | "FAILED"
  >,
  input: SettleInput,
): RunOutcome {
  const art = splitArtifactChecks(input.artifactChecks ?? []);
  const incompleteItems = [
    ...unmetRequired(input.verifications),
    ...art.failedDeliverables,
    ...art.failedOthers,
    ...input.recoveryItems.map((r) => ({
      what: r.what,
      why: `副作用状态 ${r.sideEffectState}`,
      actionId: r.actionId,
    })),
  ];
  return {
    kind,
    summary: deterministicWallHandoff(kind, input, art.delivered, incompleteItems),
    // 撞墙也可能已经产出了合格的交付物 —— 撞墙的是 Run，不是那份产物。
    // 恒空会让「跑到一半没预算了，但清单已经写好了」在 outcome 上看不出来。
    deliveredArtifactIds: art.delivered,
    recoveryItems: input.recoveryItems,
    incompleteItems,
  };
}

/**
 * 撞墙后不能再为“写一段漂亮总结”调用模型。这里仅把已经存在的事实按固定模板
 * 排列成 handoff：墙的种类、通过的验证、交付物、未完成项与停止前已落盘的摘要。
 */
function deterministicWallHandoff(
  kind: RunOutcome["kind"],
  input: SettleInput,
  deliveredArtifactIds: string[],
  incompleteItems: IncompleteItem[],
): string {
  const wall: Record<RunOutcome["kind"], string> = {
    SUCCESS: "正常完成",
    COMPLETED_WITH_LIMITS: "带限制完成",
    USER_REJECTED: "用户拒绝",
    BUDGET_EXHAUSTED: "预算硬限制",
    CONTEXT_EXHAUSTED: "上下文硬限制",
    QUOTA_EXHAUSTED: "端点配额耗尽",
    CANCELLED: "取消",
    FAILED: "运行失败",
  };
  const passedActions = input.verifications
    .filter((v) => v.status === "PASSED")
    .map((v) => String(v.actionId));
  const lines = [`Run 因${wall[kind]}停止；以下 handoff 由已落盘事实生成。`];
  lines.push(
    passedActions.length > 0
      ? `已通过验证的 Action：${passedActions.join("、")}。`
      : "没有已通过验证的 Action。",
  );
  lines.push(
    deliveredArtifactIds.length > 0
      ? `已验证交付物：${deliveredArtifactIds.join("、")}。`
      : "没有已验证交付物。",
  );
  if (incompleteItems.length > 0) {
    lines.push(`未完成或待确认：${incompleteItems.map((i) => `${i.what}（${i.why}）`).join("；")}。`);
  } else {
    lines.push("没有额外的未完成项或待确认副作用。");
  }
  if (input.summary?.trim()) lines.push(`停止前记录：${input.summary.trim()}`);
  return lines.join("\n");
}
