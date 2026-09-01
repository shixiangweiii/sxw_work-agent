/**
 * ask_user —— 问用户一道选择题，拿到答案再继续。【机制工具】
 *
 * 服务的机制：**§20 人工交互**（Run → `WAITING_FOR_INTERACTION` ＋ 等待时间扣除）。
 *
 * 不做它会怎样：**遇到歧义时模型只能猜，而且猜完不会告诉你它猜过。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它与 `request_handoff` 不是同一个洞 —— 这一点要写清楚，因为
 * `request-handoff.ts` 的文件头说过「它同时是 U-8 那个不存在的 ask-user
 * 工具的落点，两个洞是同一个」。**那句话对了一半。**
 *
 * U-8 的原文（存量清单）说的是 `WAITING_FOR_USER` 这个**枚举值零产出点**。
 * `request_handoff` 确实关掉了那一半 —— 状态机现在有人产出这个状态了。
 * 没关掉的是另一半：
 *
 * | | request_handoff | ask_user |
 * |---|---|---|
 * | 语义 | **你去做**一件我做不了的事 | **你来定**一个我定不了的事 |
 * | 外部世界 | 人真的去动了它 | 什么都没动 |
 * | `expected_completion` | **必填**，做完要能被观察到 | 不存在，因为没有可观察的结果 |
 * | 之后 | 必须重新 Observation（§20.3） | 直接用答案往下走 |
 *
 * 硬要用 handoff 问一个偏好问题，模型必须为 `expected_completion` **编造**
 * 一个可观察结果 —— 而那个字段的全部意义就是「别信人的口头声明，去核实」。
 * 让它编，等于把 §20.3 那条纪律教成一句可以糊弄的话。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 触发它的实测 ────────────────────────────────────────────────────────
 *
 * 2026-08-30 网页归档任务三次复跑，对「`images/` 目录该放什么」给出了
 * **三种不同结构**（`images/.gitkeep`、空目录条目、`images/README.md`）——
 * 因为那个页面根本没有图片，任务本身有歧义，而模型没有任何办法问一句。
 * 三次都「成功」了，三次的产物不一样，而没有任何judgement记录说明它选过。
 *
 * ── 形态 ────────────────────────────────────────────────────────────────
 *
 * 无副作用、幂等、只读 → §18.2 分支一（崩溃后重新问一次是安全的）。
 */

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolSnapshot,
} from "@workagent/harness-runtime";
import { asId, makeError } from "@workagent/harness-runtime";

/** 选项数量上下限。 */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

export const askUserDefinition: ToolDefinition = {
  id: asId("tool_ask_user"),
  version: "1.0.0",
  name: "ask_user",
  /**
   * 【定】这段话必须把它与 `request_handoff` 的分工说清楚。
   *
   * 两个工具都「停下来等人」，措辞一旦含糊，模型会在两者之间随机选 ——
   * 而选错的方向是有代价的：用 handoff 问偏好，会逼出一个编造的
   * `expected_completion`；用 ask_user 请人去外部系统办事，
   * 拿到的答案不会被重新观察。
   */
  description:
    "问用户一道选择题，等他选完再继续。用在**任务本身有歧义、而歧义会改变产物**的时候：" +
    "两种目录结构都说得通、文件该叫什么、要不要包含某一部分、用哪个格式。" +
    "question 写清楚你在纠结什么；options 每行一个候选（2–5 个），" +
    "每个候选写清楚选它会得到什么。" +
    "**与 request_handoff 的区别**：request_handoff 是「请你去外部世界做一件事」" +
    "（做完系统会重新核实）；ask_user 是「请你替我做个决定」，不需要你动任何东西。" +
    "不要用它问你自己查得到的事实（那用 read_file / search / run_shell）。" +
    "没人应答时你会收到 NO_ANSWER —— 那时自己选一个继续，并在最终总结里" +
    "写明你选了哪个、为什么，**不要停下来也不要假装问过**。",
  inputSchema: {
    type: "object",
    // 【定】显式严格：未声明的键丢弃。见 validateAndNormalize 的标准语义那段。
    additionalProperties: false,
    properties: {
      question: { type: "string", description: "你在纠结什么，一句话说清楚" },
      options: {
        type: "string",
        /**
         * 【定】换行分隔的字符串，不是数组。
         *
         * 本仓的 `JsonSchemaProperty` 只支持 string / number / boolean
         * （`types/tool.ts` 的「极简子集」，D-25 精神：不引入 schema 库）。
         * 要传数组就得改 `validateAndNormalize()` —— 那是**每一次工具调用**
         * 都要走的那段代码，为一个工具去动它不划算，而且 D-25 之下没有单测兜底。
         *
         * 代价如实记：格式靠工具自己校验，模型可能传错。所以下面对
         * 数量与空行都做了显式检查并给出结构化错误，而不是静默接受。
         */
        description: "候选项，每行一个（2–5 个）。每行写清楚选它会得到什么",
      },
    },
    required: ["question", "options"],
  },
  effectResolution: {
    kind: "DECLARATIVE",
    rule: {
      pointer: "/question",
      // 它不碰外部世界，连人都不用去碰 —— 只是要一个决定。
      effectType: "NONE",
      scopeKind: "NONE",
      reversibility: "REVERSIBLE",
      operation: "ask_user",
    },
  },
  redaction: { profile: "STANDARD" },
  idempotency: { isIdempotent: true, isReadOnly: true },
  /**
   * 【定】比 `request_handoff` 的 2 小时短得多，但仍然远大于人的反应时间。
   *
   * 差别的理由：handoff 要人**去外部系统办事**（可能要半小时），
   * 而这里只是让人在几个选项里点一个。30 分钟够了，
   * 而更短的超时会让「去倒杯水回来」变成一次失败。
   */
  timeoutPolicy: { timeoutMs: 30 * 60_000 },
  progressReporting: { mode: "NONE" },
  verification: { mode: "NONE", requiredForSuccess: false },
  recoveryObservation: { requiresPreFingerprint: false },
  /**
   * 【定】与 `request_handoff` 同样要这一行。
   *
   * 它是 §20 的触发条件：Runtime 据此把 Run 切到 `WAITING_FOR_INTERACTION`，
   * 并把等待时间从 active 墙钟里扣掉。少了它，用户想 20 秒回来发现
   * Run 因为墙钟预算挂了 —— 而那 20 秒里 Agent 什么都没干。
   */
  waitsForHumanInteraction: true,
};

/**
 * 提问通道，由 Composition Root 提供 —— 它才知道「人在哪」。
 *
 * 【定】与 `HandoffChannel` 分开两个接口，不合并。
 * 合并意味着一个 `kind` 字段和两条 if 分支，而两者的**失败语义相反**：
 * 没人接管 handoff 是失败（那件事真的没做），没人回答 ask_user 不是失败
 * （模型可以自己定）。把它们塞进一个接口，第一个写实现的人就会把
 * 两种失败处置成同一种。
 */
export interface QuestionChannel {
  /**
   * 把问题交给人，等他选。
   *
   * 返回 `undefined` 表示**没有人**（无 TTY、被取消）——
   * 【定】调用方必须把它处置成 NO_ANSWER 而不是错误，见下。
   */
  ask(request: {
    question: string;
    options: string[];
    signal: AbortSignal;
  }): Promise<{ choice: string; note?: string } | undefined>;
}

export async function executeAskUser(
  input: { question: string; options: string },
  ctx: ToolExecutionContext,
  channel: QuestionChannel | undefined,
): Promise<ToolExecutionOutcome> {
  const options = String(input.options ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return {
      ok: false,
      output: "",
      sideEffectState: "NO_EFFECT",
      error: makeError({
        code: "TOOL_ASK_USER_BAD_OPTIONS",
        source: "TOOL_INPUT",
        category: "VALIDATION",
        // 模型自己改得对 —— 把结构化的错误回灌给它就行。
        retryability: "AFTER_MODEL_CORRECTION",
        sideEffectState: "NO_EFFECT",
        safeMessage:
          `options 解析出 ${options.length} 个候选（每行一个），` +
          `要求 ${MIN_OPTIONS}–${MAX_OPTIONS} 个。` +
          `少于 2 个就不是选择题；多于 ${MAX_OPTIONS} 个说明这个决定还没想清楚，先自己收敛。`,
      }),
    };
  }

  /**
   * 【定】没有通道 ≠ 装配错误，走 NO_ANSWER。
   *
   * 这里与 `request_handoff` 刻意不同：那边没通道是 `TOOL_HANDOFF_NO_CHANNEL`
   * 这个明确的装配错误，因为「能发起接管却无人接收」等于把 Run 挂死。
   * 而问一个问题没人答，本来就有一个正确的降级行为：自己选。
   */
  const answered = channel
    ? await channel.ask({ question: input.question, options, signal: ctx.signal })
    : undefined;

  if (!answered) {
    /**
     * ── 【定】ok:true，不是 ok:false ─────────────────────────────────────
     *
     * 这是阶段 3.5 决 3。理由是实测过的形态：`request_handoff` 在非交互
     * 环境下报 `ok:false`，于是 2026-08-30 那次跑批里模型一问就挂
     * （题 3 / 网页归档都撞到过）。
     *
     * 但这两件事的性质不同：handoff 缺的是**一个真实发生过的外部动作**，
     * 没发生就是没发生，报失败是诚实的；而 ask_user 缺的只是一个偏好，
     * 模型完全可以自己定一个继续走完 —— 报失败等于让一次「本可以完成」
     * 的任务因为旁边没人而中止。
     *
     * 代价也要写明：模型现在**必须**在总结里交代它选了什么。
     * 这条只能靠 description 的引导面守（B 组那类），拿不到机械判据 ——
     * 所以不要为它硬造一条。
     */
    return {
      ok: true,
      output: JSON.stringify({
        status: "NO_ANSWER",
        question: input.question,
        options,
        reason: channel
          ? "没有人回答（非交互环境，或等待被取消）。"
          : "本次装配没有提问通道。",
        nextStep:
          "自己从 options 里选一个继续往下做，**不要停在这里，也不要假装问过用户**。" +
          "在最终总结里写明：你选了哪一个、为什么选它、以及这是你自己定的而不是用户定的。",
      }),
      sideEffectState: "NO_EFFECT",
    };
  }

  return {
    ok: true,
    output: JSON.stringify({
      status: "ANSWERED",
      question: input.question,
      choice: answered.choice,
      userNote: answered.note ?? "",
      // 【定】与 handoff 的措辞刻意不同：这里**不需要**重新观察。
      // 用户的偏好就是事实本身，没有外部世界的状态要去核实。
      nextStep: "按用户选的这一项继续。这是他的决定，直接用，不需要再去核实什么。",
    }),
    sideEffectState: "NO_EFFECT",
  };
}

export const askUserSnapshot: ToolSnapshot = {
  toolId: askUserDefinition.id,
  version: askUserDefinition.version,
  definition: askUserDefinition,
};
