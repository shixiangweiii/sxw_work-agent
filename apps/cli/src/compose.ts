/**
 * Composition Root（V05 §27.3）。
 *
 * 【定】Runtime Core 不 import Case Package，由这里注册。
 * 也只有这里知道「我们用的是百炼」这件事 —— 主循环、Context 层、
 * 形状适配器都不知道。
 */

import { config as loadDotenv } from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGETS,
  DEFAULT_CONTEXT_POLICY,
  DeclarativeEffectResolver,
  HarnessRuntime,
  TRUSTED_PERSONAL,
  ToolRegistry,
  asId,
  assertProfileMatchesEndpoint,
  freezeProfile,
  loadProfileFromFile,
  makeError,
  warnIfAssumed,
  type AgentSpecId,
  type ApprovalDecider,
  type EndpointCapabilityProfile,
  type RedactionOutcome,
  type RedactionPort,
  type RunSpec,
  type RunSpecId,
  type RuntimePorts,
  type ToolDefinition,
  type TraceSinkPort,
  type TranscriptStorePort,
} from "@workagent/harness-runtime";
import { createAnthropicModelPort, createAnthropicProtocol } from "@workagent/shape-anthropic-messages";
import {
  MicroCaseToolHandler,
  MicroCaseVerifier,
  microCaseTools,
} from "@workagent/micro-cases";
import {
  RandomIdGenerator,
  SystemClock,
} from "@workagent/testkit";
import {
  SqliteRunStore,
  SqliteTranscriptStore,
  openDb,
  type Db,
} from "@workagent/store-sqlite";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const REPO_ROOT = resolve(HERE, "../../..");

/**
 * SQLite 库的默认位置。
 *
 * 【定】与 `.workagent-workspace/` 分开：workspace 是**用户数据**（V05 §7.1），
 * 库是 **Runtime 状态**。换 `--workspace` 不换库 —— 同一个库里可以有指向
 * 不同 workspace 的 Run，这与 RunSpec 自己存 workspaceRoot 是一致的。
 */
export const DEFAULT_STATE_DIR = ".workagent-state";

/**
 * 解析库路径。`--db` 覆盖默认值，`:memory:` 原样透传。
 *
 * 【定】默认路径必须是**固定的**，不能随 `--workspace` 或时间戳变 ——
 * `--resume <runId>` 跨进程要能找回同一个库，这就是它的前提。
 */
export function resolveDbPath(explicit?: string): string {
  if (explicit === ":memory:") return explicit;
  return explicit ? resolve(explicit) : resolve(REPO_ROOT, DEFAULT_STATE_DIR, "runs.db");
}

/**
 * 【定】.env 是唯一配置源，override: true 是刻意的。
 *
 * 不加 override 的话，shell 里 export 过的 ANTHROPIC_BASE_URL 会存活下来，
 * 把凭证发往错误的端点 —— Spike 0 期间真实踩过一次。
 */
export function loadEnv(): void {
  loadDotenv({ path: resolve(REPO_ROOT, ".env"), quiet: true, override: true });
}

export interface EndpointConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  profilePath: string;
}

/**
 * 端点选择。**这是本仓库唯一写死端点名的地方。**
 *
 * 主力 = 百炼 Anthropic 形状（D-16）；对照 = DeepSeek Anthropic 形状（§24.6【定】）。
 * 两者的三组判定几乎处处相反，这正是对照的价值：把 Runtime 产出的请求
 * 打到一个**真的会校验**的端点上，是一次免费的正确性检查。
 */
export type EndpointChoice = "bailian" | "deepseek";

/**
 * 默认端点 = 百炼 Anthropic 形状（D-16）。
 *
 * `requireCredentials = false` 时缺凭证不抛（存量清单 §4 第 5 条）。
 *
 * 为什么这样改而不是「延后到真正要发请求时」：凭证断言其实有**两层**，
 * `assertCredentialGoesWhereIntended()` 在 client 构造时还会再挡一次。
 * 而用 `modelPortOverride` 时那一层本来就跳过了 —— 所以只需要让这一层
 * 知道「这次不发请求」，比把断言拆散搬走简单，也不削弱真实调用路径上的保护。
 */
export function readEndpointConfig(
  requireCredentials = true,
  choice: EndpointChoice = "bailian",
): EndpointConfig {
  const spec =
    choice === "deepseek"
      ? {
          urlKey: "deepseek_base_url_Anthropic",
          keyKey: "deepseek_api_key",
          modelKey: "deepseek_model",
          fallbackModel: "deepseek-v4-flash",
          profile: "deepseek-anthropic.json",
        }
      : {
          urlKey: "dashscope_base_url_Anthropic",
          keyKey: "dashscope_api_key",
          modelKey: "dashscope_model",
          fallbackModel: "qwen3.7-plus",
          profile: "bailian-anthropic.json",
        };

  const baseUrl = process.env[spec.urlKey] ?? "";
  const apiKey = process.env[spec.keyKey] ?? "";
  const modelId = process.env[spec.modelKey] ?? spec.fallbackModel;
  if (requireCredentials && (!baseUrl || !apiKey)) {
    throw new Error(
      `根 .env 缺少 ${spec.urlKey} / ${spec.keyKey}。\n` +
        (choice === "deepseek"
          ? "对照端点是 DeepSeek Anthropic 形状（§24.6）。"
          : "主力端点是百炼 Anthropic 形状（D-16）。"),
    );
  }
  return {
    baseUrl,
    apiKey,
    modelId,
    profilePath: resolve(REPO_ROOT, "adapters/endpoint-profiles", spec.profile),
  };
}

export interface ComposeOptions {
  workspaceRoot: string;
  approvalDecider: ApprovalDecider;
  trace: TraceSinkPort;
  /** 覆盖端点能力声明。verify:endpoint-profile 靠它换 profile。 */
  profileOverride?: EndpointCapabilityProfile;
  /** 不发真实请求时用。 */
  modelPortOverride?: RuntimePorts["model"];
  /**
   * 替换单个 Port 实现。verify:pairing 用它注入「会抛异常的 Port」——
   * R-4 要验的正是「Port 抛异常时不变量 8 还守不守得住」，
   * 而阶段 1 的四个真实现都在内部吞掉了异常，不注入就测不出来。
   */
  portOverrides?: Partial<Pick<RuntimePorts, "effects" | "redaction" | "verification">>;
  systemPrompt?: string;
  /** IANA 时区名。不传则取宿主时区。验收脚本可固定它，让帧内容可复现。 */
  timezone?: string;
  /**
   * 覆盖上下文预算策略。verify:compact 用它把阈值调到几百 token ——
   * 默认的 60k/100k 在脚本化模型下永远撞不到，Compact 就永远测不着
   * （这正是 roadmap 里「Compact 写了但没被真跑过」的直接成因）。
   */
  contextPolicy?: typeof DEFAULT_CONTEXT_POLICY;
  tools?: typeof microCaseTools;
  /**
   * SQLite 库路径。默认 `.workagent-state/runs.db`。
   *
   * 验收脚本传 `":memory:"` —— 那是**同一条 SQLite 代码路径**，只是不落盘，
   * 既密封又不牺牲覆盖（跑的是真 SQL，不是内存桩）。
   * `verify:persistence` 是唯一必须用文件的，它要跨进程。
   */
  dbPath?: string;
  /**
   * 端点选择。默认主力（百炼），`"deepseek"` 走 §24.6 的对照端点。
   *
   * 【定】它只在 compose 这一层存在。Runtime、Context、形状适配器
   * 一律不知道有这回事 —— 换端点改变的是**加载哪份声明**，不是任何代码。
   */
  endpoint?: EndpointChoice;
  /**
   * 关掉执行前指纹的拍摄（决 6 的旋钮，故障注入用）。
   *
   * 【定】它在 **Runtime 侧**，不在工具身上 —— 同一个 `append_log`，
   * 开着就落 §18.2 分支二，关掉就落分支三，而工具声明一个字没改。
   * 阶段 2 的研究问题靠这个才测得下去。
   */
  disableRecoveryObservation?: boolean;
}

export interface Composed {
  runtime: HarnessRuntime;
  ports: RuntimePorts;
  /**
   * 【定】Port 类型，不是具体类。
   *
   * 阶段 1 这里写死成 `InMemoryTranscriptStore`，于是「换存储实现」这件事
   * 在类型上是做不到的 —— 而阶段 2 干的正是这件事。
   */
  transcript: TranscriptStorePort;
  db: Db;
  profile: EndpointCapabilityProfile;
  makeRunSpec(task: string): RunSpec;
  notices: string[];
}

export function compose(opts: ComposeOptions): Composed {
  loadEnv();
  // 用了 modelPortOverride 就不会发真实请求，此时不该要求真凭证。
  const cfg = readEndpointConfig(opts.modelPortOverride === undefined, opts.endpoint ?? "bailian");

  const profile = opts.profileOverride ?? loadProfileFromFile(cfg.profilePath);
  /**
   * M-5：`.env` 的 modelId 与声明里的 modelId 必须一致。
   *
   * 在此之前它被读进 `cfg.modelId` 之后**没有任何消费点** —— 实际全用
   * `profile.modelId`。用户在 .env 里改了模型名，什么都不会发生，
   * 也没有任何提示。这是「静默忽略用户配置」，比不支持更糟。
   *
   * 二选一里选「校验一致」而不是「允许覆盖」：声明的粒度是端点 × 模型
   * （§8.6 不变量 5），换模型就该换声明 —— 允许只换模型名，等于允许
   * 拿 A 模型的实测事实去驱动 B 模型。
   */
  const modelMismatch =
    !opts.profileOverride && cfg.modelId !== profile.modelId
      ? `.env 的 ${opts.endpoint === "deepseek" ? "deepseek_model" : "dashscope_model"}` +
        `（${cfg.modelId}）与端点声明里的 modelId（${profile.modelId}）不一致。` +
        `实际发出的请求用的是**声明里的** ${profile.modelId} —— .env 那个值一直没有生效。`
      : undefined;
  /**
   * 【定】只在**真的要发请求**时硬失败，其余情况响亮地提示。
   *
   * 与凭证断言、U-6 的 baseUrl 断言同一个口径：不发请求就没有「发错地方」
   * 这回事，硬失败只会把验收脚本一起挡住。
   *
   * 为什么发请求时必须硬失败：声明的粒度是端点 × 模型（§8.6 不变量 5）。
   * 拿 A 模型的实测事实（协议校验强度、推理块档位、token 口径）去驱动 B 模型，
   * 不会报错，只会悄悄跑错 —— 而这正是 M-5 记的那件事：
   * 这个字段被读进来之后**从来没有消费点**，用户改了它什么都不会发生。
   */
  if (modelMismatch && !opts.modelPortOverride) {
    throw new Error(
      `${modelMismatch}\n\n` +
        `二选一：\n` +
        `  · 把 .env 改成 ${profile.modelId}（推荐 —— 那就是实际在用的模型）；\n` +
        `  · 或为 ${cfg.modelId} 补一份端点能力声明，再指向它。`,
    );
  }
  /**
   * U-6：启动前断言「配置的 baseUrl」与「加载的声明」指向同一个端点。
   *
   * 只在真的要发请求时断（有 override 就不发）。与 credential-guard 同一类：
   * **事发前断言，不是事后记录** —— 声明错配不会报错，只会悄悄跑错。
   */
  if (!opts.modelPortOverride && !opts.profileOverride) {
    assertProfileMatchesEndpoint(profile, cfg.baseUrl);
  }
  const notices = [...warnIfAssumed(profile), ...(modelMismatch ? [modelMismatch] : [])];

  const tools = opts.tools ?? microCaseTools;
  const registry = new ToolRegistry(tools);
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const contextPolicy = opts.contextPolicy ?? DEFAULT_CONTEXT_POLICY;

  const dbPath = opts.dbPath ?? resolve(REPO_ROOT, DEFAULT_STATE_DIR, "runs.db");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb({ path: dbPath });

  const transcript = new SqliteTranscriptStore(db);
  const runStore = new SqliteRunStore(db);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();

  // 形状适配器 ＋ 端点能力声明的组合出口。
  // 注意 protocol 需要 client 来做 countTokens，而 client 需要 profile ——
  // 先建 client，再把它的 countTokens 注入 protocol。
  const model =
    opts.modelPortOverride ??
    createAnthropicModelPort({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      profile,
    });

  const protocol = createAnthropicProtocol({
    profile,
    tools,
    systemPrompt,
    maxOutputTokens: contextPolicy.reservedOutputTokens,
    countTokensFn: async (body) => {
      const n = await model.countTokens({ body, modelId: profile.modelId });
      if (n === undefined) throw new Error("端点未返回 token 计数");
      return n;
    },
  });

  const ports: RuntimePorts = {
    model,
    protocol,
    transcript,
    runs: runStore,
    tools: new MicroCaseToolHandler(),
    redaction: opts.portOverrides?.redaction ?? new SimpleRedaction(),
    effects: opts.portOverrides?.effects ?? new DeclarativeEffectResolver(),
    verification:
      opts.portOverrides?.verification ??
      new MicroCaseVerifier({ recoveryObservationEnabled: !opts.disableRecoveryObservation }),
    clock,
    ids,
    trace: opts.trace,
  };

  const runtime = new HarnessRuntime({
    ports,
    approvalDecider: opts.approvalDecider,
    workspaceRoot: opts.workspaceRoot,
  });

  const makeRunSpec = (task: string): RunSpec => ({
    id: asId<RunSpecId>(ids.next("rs")),
    origin: { kind: "CLI", invokedAt: clock.now() },
    correlationId: ids.next("corr"),
    input: { task },
    agentSpec: {
      agentSpecId: asId<AgentSpecId>("agent_micro_case"),
      version: "0.1.0",
      contentHash: "micro@0.1.0",
      model: {
        endpointId: profile.endpointId,
        modelId: profile.modelId,
        parameters: {},
        endpointProfileRef: String(profile.id),
      },
      systemPrompt,
      // 【定】随 RunSpec 冻结。Replay 要在原时区下重放，不能取重放机器的当前时区。
      timezone: opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      toolSnapshots: tools,
      contextPolicy,
      loopPolicy: {
        maxTurns: DEFAULT_BUDGETS.maxTurns,
        maxConsecutiveFailures: DEFAULT_BUDGETS.maxConsecutiveFailures,
        maxModelErrorRetries: 2,
        maxOutputLimitRecoveries: 2,
      },
      approvalPolicy: TRUSTED_PERSONAL,
    },
    // 【定】Run 启动时冻结。Replay 使用冻结版本，不使用当前配置。
    endpointProfile: freezeProfile(profile),
    budgets: DEFAULT_BUDGETS,
    runtimeEnvironmentFingerprint: `node-${process.version}`,
    createdAt: clock.now(),
  });

  void registry; // 供将来的固定开销核对；ToolRegistry 由主循环自行构造

  return { runtime, ports, transcript, db, profile, makeRunSpec, notices };
}

export const DEFAULT_SYSTEM_PROMPT = [
  "你是 WorkAgent 的执行体，运行在一个受限的 workspace 里。",
  "",
  "规则：",
  "- 所有路径都相对 workspace 根目录，不要使用绝对路径或 .. 逃逸；",
  "- 需要了解目录内容时使用 list_dir；需要写文件时使用 write_note；",
  "- 写操作会请求用户确认，被拒绝是正常情况，据此调整而不是反复重试；",
  // 配套 ContextFrame 里注入的受信时间事实（见 context/compile.ts 的 renderTimeFact）。
  //
  // 【定】这句话不能替代那条事实 —— 光靠 prompt 约束，模型只会从「编一个日期」
  // 换成「回避日期」，两次实跑各出现过一种。事实必须真的在上下文里。
  //
  // 【定】阶段 2 改这段时守住两条：
  //   1. 「不要另行推测日期」这句强约束**原样保留** —— 它是 A1 修复的核心，
  //      削弱它，「编造 2025 年」就会回来；
  //   2. 补充说明只说「事实是执行段起始时刻、需要精确时刻就调 now」，
  //      **不要说「这个时间可能不准」** —— 那是往「回避日期」那侧推的措辞，
  //      而回避是两种失败模式里更难在产物上发现的那一种。
  "- 日期与时间一律以上下文中的「[系统事实] 当前时间」为准，不要另行推测；",
  "- 那条事实是本次执行开始时的时刻；需要精确到分钟时调用 now 工具取当前时刻；",
  "- 统计数字必须来自工具返回值，不要凭目录名或文件名推算；",
  "- 任务完成后，直接用一段话说明你做了什么，不要再调用工具。",
].join("\n");

/**
 * 最小脱敏实现（V05 §22.2）。
 *
 * 【定】脱敏失败 = Tool 失败，不得降级为原样保存。
 * 阶段 1 只处理最明显的凭证形态；Case 01 的 RedactionProfile 是阶段 3 的范围。
 */
class SimpleRedaction implements RedactionPort {
  redact(raw: string, profile: ToolDefinition["redaction"]): RedactionOutcome {
    if (profile.profile === "NONE") {
      return { ok: true, text: raw, report: { fieldsRedacted: [], bytesRedacted: 0 } };
    }
    try {
      const fields: string[] = [];
      let bytes = 0;
      let text = raw;

      /**
       * ── M-6：两档必须真的不同 ────────────────────────────────────────
       *
       * 在此之前 STRICTEST 与 STANDARD 走的是**完全相同**的分支，
       * `fieldsToRedact` 也从未被读。也就是说「最严档」是一个纯粹的标签 ——
       * 而它碰的是不变量 13（未脱敏原文不得离开 Adapter 边界）。
       *
       * 两档的区别是**假阳性的容忍度**：
       *   STANDARD  ：只打有明确形状的凭证（sk-、Bearer、邮箱）。
       *               宁可漏一个长得不像密钥的密钥，也不想把正常内容打花。
       *   STRICTEST ：再加上「长得像密钥的高熵串」「手机号 / 身份证号」这类。
       *               宁可误伤，也不放过 —— 这正是「最严」该有的取舍。
       *
       * 【定】不要让 STRICTEST 只是「多几个正则」的同义词而不解释取舍方向。
       * 档位的意义是**在假阳性和漏报之间选一边**，选哪边要说出来。
       */
      const strictest = profile.profile === "STRICTEST";
      const patterns: Array<[RegExp, string]> = [
        [/\bsk-ant-[A-Za-z0-9._-]{16,}\b/g, "anthropic_key"],
        [/\bsk-[A-Za-z0-9._-]{16,}\b/g, "api_key"],
        [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "email"],
        [/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, "bearer_token"],
        ...(strictest
          ? ([
              // 高熵串：32 位以上的连续字母数字。会误伤 hash 与 UUID，
              // 那正是「最严」这一档接受的代价。
              [/\b[A-Za-z0-9]{32,}\b/g, "high_entropy"],
              [/\b1[3-9]\d{9}\b/g, "cn_mobile"],
              [/\b\d{17}[\dXx]\b/g, "cn_id"],
            ] as Array<[RegExp, string]>)
          : []),
      ];

      /**
       * `fieldsToRedact`：工具可以点名「这些字段一定要打」。
       * 它在阶段 1 有声明、零消费 —— 声明了却不生效比不声明更危险，
       * 因为工具作者会以为自己已经保护过了。
       */
      for (const field of profile.fieldsToRedact ?? []) {
        const re = new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`, "g");
        text = text.replace(re, (_m, head: string) => {
          if (!fields.includes(field)) fields.push(field);
          return `${head}"[REDACTED:${field}]"`;
        });
      }

      for (const [re, name] of patterns) {
        text = text.replace(re, (m) => {
          if (!fields.includes(name)) fields.push(name);
          bytes += Buffer.byteLength(m, "utf8");
          return `[REDACTED:${name}]`;
        });
      }

      // 【定】RedactionReport 记录字段与字节数，不记录被脱敏的内容本身。
      return { ok: true, text, report: { fieldsRedacted: fields, bytesRedacted: bytes } };
    } catch (err) {
      return {
        ok: false,
        text: "",
        report: { fieldsRedacted: [], bytesRedacted: 0 },
        error: makeError({
          code: "REDACTION_FAILED",
          source: "TOOL_HANDLER",
          category: "REDACTION",
          retryability: "NEVER",
          sideEffectState: "UNKNOWN",
          safeMessage: `脱敏失败，拒绝原样保存：${String((err as Error).message).slice(0, 120)}`,
        }),
      };
    }
  }
}
