/**
 * Progress Guard（阶段 3 S9，U-3、V05 §16.2）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】它只回答**一个**问题：**在原地打转吗？**
 *
 * §16.2 提的是两个问题，另一个是「还活着吗」（长任务不该因为「久了」
 * 被误杀）。那一半尚未实现：早期的 `noteProgress()` / `lastProgressAt`
 * 只写不读，已删除，不再伪装成正在运行的存活检测。
 *
 * ── 「还活着吗」为什么现在做不了 ──────────────────────────────────────
 *
 * `ToolProgress` 事件是在工具**执行完之后**才被排空的
 * （`settle-batch.ts` 那段注释写明了这个偏差：`tools.execute()` 是一个
 * await，generator 在它期间挂起，中途 yield 不出去）。也就是说事件上的
 * 时间戳是**批结算时刻**，不是进展发生的时刻。
 *
 * 【定】拿这种时间戳做「多久没动静了」的判定，会得到一个**自信的错误
 * 答案** —— 一个卡了十分钟的工具，它的全部进展都会在结算的那一瞬间
 * 涌出来，看上去刚刚还很活跃。要真做这一半，得先把工具执行改成
 * generator 形态（波及每一个工具），那不是本阶段的事。
 *
 * 进展**仍然照常发出**：`ToolProgress` 进 Trace，是给人看的可观测信号，
 * 也是「这次搜索到底扫了多少目录」的事后证据。只是没有人拿它做判定。
 *
 * 【定】另外两条不变：
 *   · **不得基于流式 delta**（§16.2）—— 一次 30 秒的下载期间模型一个
 *     token 都不吐，拿 delta 当心跳会把正在正常工作的它判成卡住；
 *   · **进展回报不持久化** —— §18.6：等待就是 await，进程死了所有等待
 *     一起死，不存在「恢复后判断上次进展到哪」这个需求。
 *
 * ── 无进展形态：本批**只接第一条** ────────────────────────────────────
 *
 * 相同 Tool ＋ 相同 normalized input ＋ 相同 effect digest 连续 N 次。
 * 它可以从 transcript 机械判定，实现廉价，判别力明确。
 *
 * §16.2 的第二条形态（「多个不同调用但外部状态无变化」）**明确推后**：
 * 判定「外部状态无变化」需要状态观察基础设施，现在没有 ——
 * 硬做会造出一个没有判别力的检查，那比不做更糟。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 连续多少次相同调用算「无进展」。
 *
 * 取 3 而不是 2：模型第二次重试同一个调用是很正常的（第一次拿到错误、
 * 读了诊断、决定再试一次），第三次还一模一样才说明它没有在读反馈。
 * 取 5 又太晚 —— 每一轮都在烧 token。
 */
export const NO_PROGRESS_THRESHOLD = 3;

export interface ProgressSample {
  toolName: string;
  /** 规范化后的输入摘要。用 inputDigest，不用原始文本。 */
  inputDigest: string;
  /** ResolvedEffect.digest —— 同样的输入也可能解析出不同的作用域。 */
  effectDigest: string;
}

export interface NoProgressVerdict {
  toolName: string;
  repeats: number;
  inputDigest: string;
}

export class ProgressGuard {
  /** 最近一次调用的指纹，以及它连续重复了几次。 */
  private last: ProgressSample | undefined;
  private repeats = 0;

  constructor(private readonly threshold: number = NO_PROGRESS_THRESHOLD) {}

  /**
   * 观察一批工具调用。返回非空表示判定为无进展。
   *
   * 【定】工具回报的进展**不重置**这个计数，这也是当初把两个问题分开的
   * 理由：一个下载可以一边老老实实回报进展，一边是模型第三次发起同一个
   * 下载。混在一起会让「在原地打转」被「还活着」掩盖掉。
   *
   * 【定】只看**整批**是不是与上一批完全相同。逐个 Action 比会误判：
   * 一个批里合理地包含两次 `list_dir`（不同目录）时，
   * 第二次会被当成「重复第一次」。
   */
  observeBatch(samples: ProgressSample[]): NoProgressVerdict | undefined {
    // 空批（模型没调工具）不参与判定 —— 那一轮本来就在往前走。
    if (samples.length === 0) {
      this.last = undefined;
      this.repeats = 0;
      return undefined;
    }

    const merged: ProgressSample = {
      toolName: samples.map((s) => s.toolName).join("+"),
      inputDigest: samples.map((s) => s.inputDigest).join("|"),
      effectDigest: samples.map((s) => s.effectDigest).join("|"),
    };

    const same =
      this.last !== undefined &&
      this.last.toolName === merged.toolName &&
      this.last.inputDigest === merged.inputDigest &&
      this.last.effectDigest === merged.effectDigest;

    if (!same) {
      this.last = merged;
      this.repeats = 1;
      return undefined;
    }

    this.repeats += 1;
    if (this.repeats < this.threshold) return undefined;

    return {
      toolName: merged.toolName,
      repeats: this.repeats,
      inputDigest: merged.inputDigest.slice(0, 32),
    };
  }
}
