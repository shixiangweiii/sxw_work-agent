/**
 * Composition Root（V05 §27.3）。
 *
 * 【定】Runtime Core 不 import Case Package，由这里注册。
 * 也只有这里知道「我们用的是百炼」这件事 —— 主循环、Context 层、
 * 形状适配器都不知道。
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGETS,
  DEFAULT_CONTEXT_POLICY,
  DeclarativeEffectResolver,
  HarnessRuntime,
  TRUSTED_PERSONAL,
  ToolRegistry,
  asId,
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
} from "@workagent/harness-runtime";
import { createAnthropicModelPort, createAnthropicProtocol } from "@workagent/shape-anthropic-messages";
import {
  MicroCaseToolHandler,
  MicroCaseVerifier,
  microCaseTools,
} from "@workagent/micro-cases";
import {
  InMemoryTranscriptStore,
  RandomIdGenerator,
  SystemClock,
} from "@workagent/testkit";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const REPO_ROOT = resolve(HERE, "../../..");

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

/** 默认端点 = 百炼 Anthropic 形状（D-16）。这是本仓库唯一写死端点名的地方。 */
export function readEndpointConfig(): EndpointConfig {
  const baseUrl = process.env["dashscope_base_url_Anthropic"] ?? "";
  const apiKey = process.env["dashscope_api_key"] ?? "";
  const modelId = process.env["dashscope_model"] ?? "qwen3.7-plus";
  if (!baseUrl || !apiKey) {
    throw new Error(
      "根 .env 缺少 dashscope_base_url_Anthropic / dashscope_api_key。\n" +
        "阶段 1 的主力端点是百炼 Anthropic 形状（D-16）。",
    );
  }
  return {
    baseUrl,
    apiKey,
    modelId,
    profilePath: resolve(REPO_ROOT, "adapters/endpoint-profiles/bailian-anthropic.json"),
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
  systemPrompt?: string;
  tools?: typeof microCaseTools;
}

export interface Composed {
  runtime: HarnessRuntime;
  ports: RuntimePorts;
  transcript: InMemoryTranscriptStore;
  profile: EndpointCapabilityProfile;
  makeRunSpec(task: string): RunSpec;
  notices: string[];
}

export function compose(opts: ComposeOptions): Composed {
  loadEnv();
  const cfg = readEndpointConfig();

  const profile = opts.profileOverride ?? loadProfileFromFile(cfg.profilePath);
  const notices = warnIfAssumed(profile);

  const tools = opts.tools ?? microCaseTools;
  const registry = new ToolRegistry(tools);
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const transcript = new InMemoryTranscriptStore();
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
    maxOutputTokens: DEFAULT_CONTEXT_POLICY.reservedOutputTokens,
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
    tools: new MicroCaseToolHandler(),
    redaction: new SimpleRedaction(),
    effects: new DeclarativeEffectResolver(),
    verification: new MicroCaseVerifier(),
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
      toolSnapshots: tools,
      contextPolicy: DEFAULT_CONTEXT_POLICY,
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

  return { runtime, ports, transcript, profile, makeRunSpec, notices };
}

export const DEFAULT_SYSTEM_PROMPT = [
  "你是 WorkAgent 的执行体，运行在一个受限的 workspace 里。",
  "",
  "规则：",
  "- 所有路径都相对 workspace 根目录，不要使用绝对路径或 .. 逃逸；",
  "- 需要了解目录内容时使用 list_dir；需要写文件时使用 write_note；",
  "- 写操作会请求用户确认，被拒绝是正常情况，据此调整而不是反复重试；",
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

      const patterns: Array<[RegExp, string]> = [
        [/\bsk-[A-Za-z0-9._-]{16,}\b/g, "api_key"],
        [/\bsk-ant-[A-Za-z0-9._-]{16,}\b/g, "anthropic_key"],
        [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "email"],
        [/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, "bearer_token"],
      ];

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
