/**
 * verify:model-audit —— 模型调用级原始请求/返回审计。
 *
 * 验证的是一条完整生产链：Runtime 生成 invocationId → 真实 Anthropic 形状
 * adapter 收发 HTTP/SSE → 独立 JSONL sidecar → Runtime 归一化结果收尾。
 */

import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CollectingTraceSink,
  asId,
  loadProfileFromFile,
  type EndpointCapabilityProfile,
  type ModelInvocationAuditEnd,
  type ModelInvocationAuditStart,
  type ModelInvocationAuditStorePort,
  type ModelInvocationAuditWriter,
  type ProviderFailureObservation,
  type ProviderResponseMetadata,
  type RunEvent,
  type RunSpec,
  type Timestamp,
} from "@workagent/harness-runtime";
import {
  createAnthropicModelPort,
  createAnthropicProtocol,
} from "@workagent/shape-anthropic-messages";
import { compose, REPO_ROOT, type Composed } from "../compose.js";
import {
  readModelInvocationAudit,
} from "../model-audit/file-store.js";
import { banner, fact, runVerify, section, tempWorkspace, verdict } from "./harness.js";

interface FakeProvider {
  server: Server;
  baseUrl: string;
  messageBodies: unknown[];
  countBodies: unknown[];
  eventsByMessage: unknown[][];
  failNextMessage(): void;
  streamErrorNextMessage(): void;
  transportFailNextMessage(): void;
  slowNextMessage(): void;
}

interface RunEvidence {
  runId: string;
  events: RunEvent[];
  terminal: string;
  outcome?: string;
}

const workspace = tempWorkspace();
const CRASH_WORKER = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "workers/model-audit-crash.ts",
);

async function main(): Promise<void> {
  banner(
    "验收项 16：模型调用原始请求/返回审计",
    "真实 adapter 收到和返回的事实能否独立落盘，且审计失败不改变 Run？",
  );

  const provider = await startFakeProvider();
  try {
    const profile = auditProfile();
    const apiKey = "fixture-third-party-key-never-persist";
    const model = createAnthropicModelPort({
      baseUrl: provider.baseUrl,
      apiKey,
      profile,
    });

    section("A. CLI：实际请求、SDK 解码 Provider 事件与 Runtime 结果落在同一 invocation sidecar");
    const trace = new CollectingTraceSink();
    const cli = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace,
      profileOverride: profile,
      modelPortOverride: model,
      systemPrompt: "system-request-only-canary",
      dbPath: ":memory:",
    });
    const cliRun = await drain(cli, cli.makeRunSpec("检查当前目录"));
    cli.db.close();

    const cliFiles = auditFilesFor(cliRun.runId);
    const firstAudit = readModelInvocationAudit(cliFiles[0]!);
    const firstRecords = firstAudit.records as Array<Record<string, any>>;
    const requestRecord = firstRecords.find((record) => record.kind === "request");
    const metadataRecord = firstRecords.find((record) => record.kind === "response_metadata");
    const providerRecords = firstRecords.filter((record) => record.kind === "provider_event");
    const endRecord = firstRecords.find((record) => record.kind === "invocation_end");
    const contextEvent = trace.byType("ContextFrameCompiled")[0];
    const completedEvent = trace.byType("ModelInvocationCompleted")[0];

    fact("CLI Run", `${cliRun.runId} · ${cliRun.terminal}/${cliRun.outcome}`);
    fact("调用 sidecar", cliFiles.map((path) => path.split("/").at(-1)).join(", "));
    verdict(
      cliRun.terminal === "COMPLETED" && cliRun.outcome === "SUCCESS" && cliFiles.length === 2,
      "真实流先返回 tool_use、执行 stat、再调用一次模型；两次 invoke 各有一份独立 sidecar",
    );
    verdict(
      firstAudit.state === "COMPLETE" &&
        JSON.stringify(requestRecord?.request?.body) === JSON.stringify(provider.messageBodies[0]),
      "sidecar request.body 与假 Provider 实际收到的 JSON 逐字结构一致",
    );
    verdict(
      metadataRecord?.status === 200 && metadataRecord?.requestId === "req-audit-1" &&
        JSON.stringify(providerRecords.map((record) => record.event)) ===
          JSON.stringify(provider.eventsByMessage[0]),
      "HTTP 状态/request-id 与每一条 SDK 解码 Provider 事件按原顺序完整保留",
    );
    verdict(
      endRecord?.outcome === "COMPLETED" &&
        endRecord?.result?.content?.some((item: Record<string, unknown>) =>
          item.type === "reasoning" && item.text === "reasoning-canary") &&
        endRecord?.result?.toolCalls?.[0]?.name === "stat" &&
        endRecord?.result?.usage?.billedInputTokens === 13,
      "同一文件尾部保留 Runtime 实际消费的 reasoning/tool call/usage 规范化结果",
    );
    verdict(
      contextEvent?.payload.invocationId === completedEvent?.payload.invocationId &&
        contextEvent?.payload.frameId !== undefined &&
        String(cliFiles[0]).endsWith(`/${contextEvent?.payload.invocationId}.jsonl`),
      "ContextFrameCompiled、ModelInvocationCompleted 与 sidecar 复用同一个 invocationId",
    );

    const serializedAudit = readFileSync(cliFiles[0]!, "utf8");
    const serializedTrace = JSON.stringify(trace.events);
    verdict(
      !serializedAudit.includes(apiKey) &&
        !serializedAudit.toLowerCase().includes("authorization") &&
        !serializedAudit.toLowerCase().includes("x-api-key"),
      "完整请求/返回可审计，但认证值和认证请求头不进入 sidecar",
    );
    verdict(
      (statSync(cliFiles[0]!).mode & 0o777) === 0o600 &&
        (statSync(join(workspace.root, ".workagent", "model-invocations", cliRun.runId)).mode & 0o777) === 0o700,
      "调用文件权限为 0600、Run 审计目录权限为 0700",
    );
    verdict(
      !serializedTrace.includes("system-request-only-canary") &&
        !serializedTrace.includes("raw-event-only-canary") &&
        trace.byType("ModelInvocationAuditFailed").length === 0,
      "成功路径的完整请求和 Provider-only 字段没有混入主 Trace，也没有新增成功事件",
    );

    section("B. Web 默认采集，EVAL 与 count_tokens 明确排除");
    const beforeWebMessages = provider.messageBodies.length;
    const web = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace: new CollectingTraceSink(),
      profileOverride: profile,
      modelPortOverride: model,
      dbPath: ":memory:",
    });
    const webRun = await drain(web, web.makeRunSpec("Web 入口", "WEB"));
    web.db.close();
    const webFiles = auditFilesFor(webRun.runId);

    const evalRunComposed = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace: new CollectingTraceSink(),
      profileOverride: profile,
      modelPortOverride: model,
      dbPath: ":memory:",
    });
    const evalRun = await drain(evalRunComposed, evalRunComposed.makeRunSpec("评测入口", "EVAL"));
    evalRunComposed.db.close();
    const evalFiles = auditFilesFor(evalRun.runId);

    fact("Provider 调用", `messages ${provider.messageBodies.length} / count_tokens ${provider.countBodies.length}`);
    verdict(
      provider.messageBodies.length >= beforeWebMessages + 2 &&
        provider.countBodies.length > 0 &&
        webFiles.length === 1 && evalFiles.length === 0,
      "WEB 推理默认落盘；EVAL 与实际发生过的 count_tokens 调用均不生成 sidecar",
    );

    section("C. Provider 失败保留原始错误 body，并以 FAILED 收尾");
    provider.failNextMessage();
    const errorTrace = new CollectingTraceSink();
    const failed = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace: errorTrace,
      profileOverride: profile,
      modelPortOverride: model,
      dbPath: ":memory:",
    });
    const failedRun = await drain(failed, failed.makeRunSpec("触发 Provider 错误"));
    failed.db.close();
    const failedFiles = auditFilesFor(failedRun.runId);
    const failedReads = failedFiles.map(readModelInvocationAudit);
    const failedRead = failedReads.find((read) =>
      (read.records as Array<{ kind?: string }>).some((record) => record.kind === "provider_error"),
    )!;
    const failedRecords = failedRead.records as Array<Record<string, any>>;
    const rawError = failedRecords.find((record) => record.kind === "provider_error");
    const failedEnd = failedRecords.find((record) => record.kind === "invocation_end");
    fact("Provider 原始错误", JSON.stringify(rawError));
    fact("失败收尾", JSON.stringify(failedEnd));
    verdict(
      failedRead.state === "COMPLETE" &&
        rawError?.failure?.status === 429 &&
        rawError?.failure?.requestId === "req-audit-error" &&
        rawError?.failure?.errorBody?.error?.message === "provider-error-canary" &&
        failedEnd?.outcome === "FAILED" &&
        errorTrace.byType("RuntimeErrorOccurred")[0]?.payload.invocationId !== undefined &&
        failedFiles.length === 2 && failedRun.outcome === "SUCCESS",
      "Provider 429 的原始错误与 Runtime 归类共同落盘；Runtime 重试使用新的 invocationId/文件后成功",
    );

    section("D. HTTP 200 后的流内 error 仍是 Provider 失败，并按 error.type 归一化");
    // 判别力实测：把 providerResponded 临时退回 `status !== undefined`，
    // 本段的集成判据与映射表会同时翻红，transport 正例仍保持绿色。
    provider.streamErrorNextMessage();
    const streamErrorTrace = new CollectingTraceSink();
    const streamErrorComposed = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace: streamErrorTrace,
      profileOverride: profile,
      modelPortOverride: model,
      dbPath: ":memory:",
    });
    const streamErrorRun = await drain(
      streamErrorComposed,
      streamErrorComposed.makeRunSpec("触发 HTTP 200 后的流内 Provider error"),
    );
    streamErrorComposed.db.close();
    const streamErrorFiles = auditFilesFor(streamErrorRun.runId);
    const streamErrorRead = streamErrorFiles.map(readModelInvocationAudit).find((read) =>
      read.records.some((record) =>
        record.kind === "provider_error" &&
        (record.failure.errorBody as { error?: { type?: string } } | undefined)?.error?.type ===
          "overloaded_error"
      ),
    );
    const streamErrorRecords = streamErrorRead?.records ?? [];
    const streamMetadata = streamErrorRecords.find((record) => record.kind === "response_metadata");
    const streamPrefix = streamErrorRecords.find((record) => record.kind === "provider_event");
    const streamFailure = streamErrorRecords.find((record) => record.kind === "provider_error");
    const streamEnd = streamErrorRecords.find((record) => record.kind === "invocation_end");
    const streamRuntimeError = streamErrorTrace.byType("RuntimeErrorOccurred").find(
      (event) => event.payload.invocationId ===
        (streamErrorRecords[0]?.kind === "request" ? streamErrorRecords[0].invocationId : undefined),
    );
    fact(
      "流内错误事实",
      `HTTP ${streamMetadata?.kind === "response_metadata" ? streamMetadata.status : "?"} · ` +
        `${streamFailure?.kind === "provider_error" ? streamFailure.failure.kind : "?"} · ` +
        `${streamEnd?.kind === "invocation_end" && streamEnd.outcome === "FAILED" ? streamEnd.error.code : "?"}`,
    );
    verdict(
      streamErrorRead?.state === "COMPLETE" &&
        streamMetadata?.kind === "response_metadata" &&
        streamMetadata.status === 200 &&
        streamMetadata.requestId === "req-audit-stream-error" &&
        streamPrefix?.kind === "provider_event" &&
        (streamPrefix.event as { audit_stream_prefix?: string }).audit_stream_prefix ===
          "stream-prefix-canary" &&
        streamFailure?.kind === "provider_error" &&
        streamFailure.failure.kind === "PROVIDER" &&
        streamFailure.failure.status === undefined &&
        streamFailure.failure.requestId === "req-audit-stream-error" &&
        (streamFailure.failure.errorBody as { error?: { message?: string } }).error?.message ===
          "stream-error-canary" &&
        streamEnd?.kind === "invocation_end" &&
        streamEnd.outcome === "FAILED" &&
        streamEnd.error.code === "MODEL_UNAVAILABLE" &&
        streamEnd.error.source === "MODEL_PROVIDER" &&
        streamEnd.error.category === "UNAVAILABLE" &&
        streamEnd.error.retryability === "SAME_INPUT_BACKOFF" &&
        streamEnd.error.sideEffectState === "UNKNOWN" &&
        streamRuntimeError?.payload.error.code === "MODEL_UNAVAILABLE" &&
        streamErrorTrace.byType("LoopContinued").some(
          (event) => event.payload.transition.reason === "MODEL_ERROR_RETRY",
        ) &&
        streamErrorFiles.length === 2 &&
        streamErrorRun.outcome === "SUCCESS",
      "HTTP 200 的正常事件前缀、流内原始 error 与 Provider 归一化结果同文件共存；退避重试另建 invocation",
    );

    const streamErrorMappings = [
      ["rate_limit_error", "MODEL_RATE_LIMIT", "RATE_LIMIT", "SAME_INPUT_BACKOFF"],
      ["overloaded_error", "MODEL_UNAVAILABLE", "UNAVAILABLE", "SAME_INPUT_BACKOFF"],
      ["api_error", "MODEL_UNAVAILABLE", "UNAVAILABLE", "SAME_INPUT_BACKOFF"],
      ["timeout_error", "MODEL_TIMEOUT", "TIMEOUT", "SAME_INPUT_BACKOFF"],
      ["billing_error", "MODEL_QUOTA", "QUOTA", "AFTER_USER_ACTION"],
      ["authentication_error", "MODEL_AUTH", "AUTHENTICATION", "NEVER"],
      ["permission_error", "MODEL_AUTH", "AUTHORIZATION", "NEVER"],
      ["invalid_request_error", "MODEL_BAD_REQUEST", "PROTOCOL", "AFTER_MODEL_CORRECTION"],
      ["not_found_error", "MODEL_NOT_FOUND", "NOT_FOUND", "AFTER_ENVIRONMENT_CHANGE"],
      ["future_error", "MODEL_UNKNOWN", "UNKNOWN", "SAME_INPUT_BACKOFF"],
    ] as const;
    const classifier = createAnthropicProtocol({
      profile,
      tools: [],
      systemPrompt: "",
      maxOutputTokens: 1024,
    });
    const mappingResults = streamErrorMappings.map(([type, code, category, retryability], index) => {
      const body = index === 2
        ? { type, message: `${type}-canary` }
        : { type: "error", error: { type, message: `${type}-canary` } };
      const error = Object.assign(new Error(`${type}-canary`), {
        requestID: `req-${type}`,
        error: body,
      });
      const actual = classifier.classifyError(error);
      return {
        type,
        ok:
          actual.code === code &&
          actual.source === "MODEL_PROVIDER" &&
          actual.category === category &&
          actual.retryability === retryability &&
          actual.sideEffectState === "UNKNOWN",
      };
    });
    fact("流内 error.type 映射", mappingResults.map((result) => `${result.type}:${result.ok ? "✓" : "✗"}`).join(" "));
    verdict(
      mappingResults.every((result) => result.ok),
      "Anthropic 已知流内错误类型逐一映射到既有 Runtime 语义，未知类型保守退避；直接 type 形状也受支持",
    );

    section("E. 网络失败明确标作 TRANSPORT，不伪造 Provider 响应");
    provider.transportFailNextMessage();
    const transport = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace: new CollectingTraceSink(),
      profileOverride: profile,
      modelPortOverride: model,
      dbPath: ":memory:",
    });
    const transportRun = await drain(transport, transport.makeRunSpec("触发 transport failure"));
    transport.db.close();
    const transportFiles = auditFilesFor(transportRun.runId);
    const transportRead = transportFiles.map(readModelInvocationAudit).find((read) =>
      (read.records as Array<Record<string, any>>).some(
        (record) => record.kind === "provider_error" && record.failure?.kind === "TRANSPORT",
      ),
    );
    const transportRecords = transportRead?.records as Array<Record<string, any>> | undefined;
    verdict(
      transportRead?.state === "COMPLETE" &&
        transportRecords?.some((record) => record.kind === "provider_error" &&
          record.failure?.kind === "TRANSPORT" && record.failure?.status === undefined) === true &&
        transportRecords?.some((record) => record.kind === "response_metadata") === false &&
        transportFiles.length === 2 && transportRun.outcome === "SUCCESS",
      "连接中断没有 HTTP 状态、request ID 或错误 body，审计标作 TRANSPORT；重试另建文件后成功",
    );

    section("F. 用户取消与预算 deadline 都保留已经收到的 Provider 前缀");
    provider.slowNextMessage();
    const cancelTrace = new CollectingTraceSink();
    const cancelled = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace: cancelTrace,
      profileOverride: profile,
      modelPortOverride: model,
      dbPath: ":memory:",
    });
    const cancelledRun = await drainWithCancel(cancelled, cancelled.makeRunSpec("取消慢调用"), 120);
    cancelled.db.close();
    const cancelledRead = readModelInvocationAudit(auditFilesFor(cancelledRun.runId)[0]!);
    const cancelledRecords = cancelledRead.records as Array<Record<string, any>>;
    const cancelledEnd = cancelledRecords.find((record) => record.kind === "invocation_end");

    provider.slowNextMessage();
    const budgeted = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace: new CollectingTraceSink(),
      profileOverride: profile,
      modelPortOverride: model,
      dbPath: ":memory:",
    });
    const budgetedRun = await drain(
      budgeted,
      budgeted.makeRunSpec("预算打断慢调用", "CLI", { activeWallClockMs: 120 }),
    );
    budgeted.db.close();
    const budgetedRead = readModelInvocationAudit(auditFilesFor(budgetedRun.runId)[0]!);
    const budgetedRecords = budgetedRead.records as Array<Record<string, any>>;
    const budgetedEnd = budgetedRecords.find((record) => record.kind === "invocation_end");
    fact(
      "用户取消",
      `${cancelledRun.terminal} / ${cancelledRead.state} / ${cancelledEnd?.outcome ?? "无结尾"} / ` +
        `${cancelledEnd?.interruptionReason ?? "无原因"} / provider_event=` +
        `${cancelledRecords.filter((record) => record.kind === "provider_event").length}`,
    );
    fact(
      "预算中断",
      `${budgetedRun.terminal} / ${budgetedRead.state} / ${budgetedEnd?.outcome ?? "无结尾"} / ` +
        `${budgetedEnd?.interruptionReason ?? "无原因"} / provider_event=` +
        `${budgetedRecords.filter((record) => record.kind === "provider_event").length}`,
    );
    verdict(
      cancelledRun.terminal === "ABORTED_STREAMING" &&
        cancelledRead.state === "COMPLETE" && cancelledEnd?.outcome === "INTERRUPTED" &&
        cancelledEnd?.interruptionReason === "USER_ABORT" &&
        cancelledRecords.some((record) => record.kind === "provider_event") &&
        budgetedRun.terminal === "BUDGET_EXHAUSTED" &&
        budgetedRead.state === "COMPLETE" && budgetedEnd?.outcome === "INTERRUPTED" &&
        budgetedEnd?.interruptionReason === "DEADLINE" &&
        budgetedRecords.some((record) => record.kind === "provider_event"),
      "用户取消和 active wall-clock 硬墙都以 INTERRUPTED 收尾，并保留中断前 Provider 事件前缀",
    );

    section("G. 审计写失败 fail-open，且一个调用只报警一次");
    const brokenTrace = new CollectingTraceSink();
    const broken = compose({
      workspaceRoot: workspace.root,
      approvalDecider: async () => ({ approved: true }),
      trace: brokenTrace,
      profileOverride: profile,
      modelPortOverride: model,
      dbPath: ":memory:",
      portOverrides: { modelAudit: new ProviderEventFailingAuditStore() },
    });
    const brokenRun = await drain(broken, broken.makeRunSpec("审计失败也继续"));
    broken.db.close();
    const auditFailures = brokenTrace.byType("ModelInvocationAuditFailed");
    verdict(
      brokenRun.terminal === "COMPLETED" &&
        brokenRun.outcome === "SUCCESS" &&
        auditFailures.length === 1 &&
        auditFailures[0]?.payload.stage === "PROVIDER_EVENT" &&
        brokenTrace.byType("ModelInvocationCompleted").length === 1,
      "provider_event 写盘失败只产生一条显眼诊断，模型调用、预算计数和 Run 结算继续",
    );

    section("H. Reader 用严格 v1 状态机区分完整、合法前缀与语义损坏");
    // 判别力实测：临时跳过 shapeError 后，本段语义矩阵翻红，SIGKILL 合法前缀仍为绿色。
    const readerDir = join(workspace.root, "reader-fixtures");
    mkdirSync(readerDir, { recursive: true });
    const prefix = firstRecords.filter((record) => record.kind !== "invocation_end");
    const requestFixture = firstRecords.find((record) => record.kind === "request")!;
    const metadataFixture = firstRecords.find((record) => record.kind === "response_metadata")!;
    const eventFixture = firstRecords.find((record) => record.kind === "provider_event")!;
    const endFixture = firstRecords.find((record) => record.kind === "invocation_end")!;
    const errorFixture = streamErrorRecords.find((record) => record.kind === "provider_error")!;
    const fixture = (name: string, records: unknown[], separator = "\n"): string => {
      const path = join(readerDir, `${name}.jsonl`);
      writeFileSync(path, records.map((record) => JSON.stringify(record)).join(separator) + "\n", "utf8");
      return path;
    };
    const incomplete = readModelInvocationAudit(fixture("incomplete", prefix));
    const emptyPath = join(readerDir, "empty.jsonl");
    writeFileSync(emptyPath, "", "utf8");
    const empty = readModelInvocationAudit(emptyPath);
    const corruptPath = join(readerDir, "json-truncated.jsonl");
    writeFileSync(corruptPath, `${JSON.stringify(requestFixture)}\n{"kind":`, "utf8");
    const corrupt = readModelInvocationAudit(corruptPath);
    const missing = readModelInvocationAudit(join(readerDir, "missing.jsonl"));
    const semanticCases = [
      readModelInvocationAudit(fixture("wrong-schema", [{ ...requestFixture, schemaVersion: 2 }])),
      readModelInvocationAudit(fixture("end-only", [endFixture])),
      readModelInvocationAudit(fixture("duplicate-request", [requestFixture, requestFixture])),
      readModelInvocationAudit(fixture("metadata-after-event", [requestFixture, eventFixture, metadataFixture])),
      readModelInvocationAudit(fixture("event-index-gap", [requestFixture, { ...eventFixture, index: 2 }])),
      readModelInvocationAudit(fixture("event-index-duplicate", [requestFixture, eventFixture, eventFixture])),
      readModelInvocationAudit(fixture("duplicate-error", [requestFixture, errorFixture, errorFixture])),
      readModelInvocationAudit(fixture("event-after-error", [requestFixture, errorFixture, eventFixture])),
      readModelInvocationAudit(fixture("record-after-end", [requestFixture, endFixture, metadataFixture])),
      readModelInvocationAudit(fixture("unknown-kind", [requestFixture, { kind: "mystery", schemaVersion: 1 }])),
      readModelInvocationAudit(fixture("missing-field", [{ ...requestFixture, invocationId: undefined }])),
      readModelInvocationAudit(fixture("internal-blank", [requestFixture, endFixture], "\n\n")),
    ];
    fact(
      "Reader 语义反例",
      semanticCases.map((read) => `${read.state}@${read.errors[0]?.line ?? "-"}`).join(" · "),
    );
    verdict(
      firstAudit.state === "COMPLETE" &&
        incomplete.state === "INCOMPLETE" &&
        empty.state === "INCOMPLETE" &&
        corrupt.state === "CORRUPT" && corrupt.errors[0]?.line === 2 &&
        corrupt.records.length === 1 &&
        missing.state === "NOT_CAPTURED" &&
        semanticCases.every((read) => read.state === "CORRUPT" && read.errors.length === 1),
      "合法完整、空/缺尾、缺文件与 JSON/语义坏行分别判为 COMPLETE/INCOMPLETE/NOT_CAPTURED/CORRUPT",
    );

    const crashRoot = join(readerDir, "real-crash");
    const crashed = spawnSync("npx", ["tsx", CRASH_WORKER, crashRoot], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 20_000,
      env: process.env,
    });
    const crashedRead = readModelInvocationAudit(
      join(crashRoot, "run_audit_crash", "inv_audit_crash.jsonl"),
    );
    fact(
      "真 SIGKILL",
      `exit=${crashed.status ?? "null"} signal=${crashed.signal ?? "null"} ` +
        `state=${crashedRead.state} records=${crashedRead.records.length}`,
    );
    verdict(
      (crashed.status !== 0 || crashed.signal === "SIGKILL") &&
        crashed.stdout.includes("@@AUDIT_PREFIX_WRITTEN@@") &&
        crashedRead.state === "INCOMPLETE" &&
        (crashedRead.records as Array<{ kind?: string }>).some((record) => record.kind === "provider_event"),
      "子进程写完 request/metadata/provider_event 后被真 SIGKILL；完整前缀可读且明确判为 INCOMPLETE",
    );
  } finally {
    await closeServer(provider.server);
  }
}

function auditProfile(): EndpointCapabilityProfile {
  const base = loadProfileFromFile(
    join(REPO_ROOT, "adapters/endpoint-profiles/bailian-anthropic.json"),
  );
  return {
    ...base,
    id: asId("epcp_model_audit_fixture"),
    endpointId: asId("ep_model_audit_fixture"),
    modelId: "audit-fixture-model",
    tokens: {
      ...base.tokens,
      countTokensAccuracy: "APPROXIMATE",
      countTokensExcludesReasoning: false,
    },
  };
}

async function drain(composed: Composed, spec: RunSpec): Promise<RunEvidence> {
  const events: RunEvent[] = [];
  const gen = composed.runtime.start(spec);
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  const runId = String(events.find((event) => event.type === "RunStarted")?.runId ?? "");
  return {
    runId,
    events,
    terminal: next.value.terminal.reason,
    outcome: next.value.outcome?.kind,
  };
}

async function drainWithCancel(
  composed: Composed,
  spec: RunSpec,
  cancelAfterMs: number,
): Promise<RunEvidence> {
  const events: RunEvent[] = [];
  const gen = composed.runtime.start(spec);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    if (!timer && next.value.type === "RunStarted") {
      const startedRunId = next.value.runId;
      timer = setTimeout(
        () => composed.runtime.cancel(startedRunId, "verify:model-audit 用户取消"),
        cancelAfterMs,
      );
    }
    next = await gen.next();
  }
  if (timer) clearTimeout(timer);
  const runId = String(events.find((event) => event.type === "RunStarted")?.runId ?? "");
  return {
    runId,
    events,
    terminal: next.value.terminal.reason,
    outcome: next.value.outcome?.kind,
  };
}

function auditFilesFor(runId: string): string[] {
  const dir = join(workspace.root, ".workagent", "model-invocations", runId);
  try {
    const paths = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
    return paths.sort((left, right) => auditStartedAt(left) - auditStartedAt(right));
  } catch {
    return [];
  }
}

function auditStartedAt(path: string): number {
  const first = readFileSync(path, "utf8").split("\n").find((line) => line.trim());
  if (!first) return 0;
  try {
    return Number((JSON.parse(first) as { startedAt?: number }).startedAt ?? 0);
  } catch {
    return 0;
  }
}

class ProviderEventFailingAuditStore implements ModelInvocationAuditStorePort {
  open(_start: ModelInvocationAuditStart): ModelInvocationAuditWriter {
    return {
      responseMetadata: (_metadata: ProviderResponseMetadata, _observedAt: Timestamp) => {},
      providerEvent: () => {
        throw new Error("provider-event-write-canary");
      },
      providerFailure: (_failure: ProviderFailureObservation, _observedAt: Timestamp) => {},
      finish: (_end: ModelInvocationAuditEnd) => {},
      closeIncomplete: () => {},
    };
  }
}

async function startFakeProvider(): Promise<FakeProvider> {
  const messageBodies: unknown[] = [];
  const countBodies: unknown[] = [];
  const eventsByMessage: unknown[][] = [];
  let failNext = false;
  let streamErrorNext = false;
  let transportFailNext = false;
  let slowNext = false;
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    if (req.url?.endsWith("/count_tokens")) {
      countBodies.push(body);
      sendJson(res, 200, { input_tokens: 13 });
      return;
    }
    if (!req.url?.endsWith("/messages")) {
      sendJson(res, 404, { error: { message: "not found" } });
      return;
    }

    messageBodies.push(body);
    if (transportFailNext) {
      transportFailNext = false;
      req.socket.destroy();
      return;
    }
    if (failNext) {
      failNext = false;
      res.setHeader("request-id", "req-audit-error");
      sendJson(res, 429, {
        type: "error",
        error: { type: "rate_limit_error", message: "provider-error-canary" },
      });
      return;
    }
    if (streamErrorNext) {
      streamErrorNext = false;
      const prefix = streamErrorPrefixEvent();
      eventsByMessage.push([prefix]);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "request-id": "req-audit-stream-error",
      });
      res.write(`event: message_start\ndata: ${JSON.stringify(prefix)}\n\n`);
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "stream-error-canary" },
        })}\n\n`,
      );
      res.end();
      return;
    }

    const ordinal = messageBodies.length;
    const events = ordinal === 1 ? toolUseEvents() : finalTextEvents(ordinal);
    eventsByMessage.push(events);
    const slowThisResponse = slowNext;
    slowNext = false;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "request-id": `req-audit-${ordinal}`,
    });
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i] as Record<string, unknown>;
      res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      if (slowThisResponse && i === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        if (res.destroyed) return;
      }
    }
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("假 Provider 没拿到 TCP 地址");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    messageBodies,
    countBodies,
    eventsByMessage,
    failNextMessage: () => {
      failNext = true;
    },
    streamErrorNextMessage: () => {
      streamErrorNext = true;
    },
    transportFailNextMessage: () => {
      transportFailNext = true;
    },
    slowNextMessage: () => {
      slowNext = true;
    },
  };
}

function streamErrorPrefixEvent(): unknown {
  return {
    type: "message_start",
    audit_stream_prefix: "stream-prefix-canary",
    message: {
      id: "msg_audit_stream_error",
      type: "message",
      role: "assistant",
      model: "audit-fixture-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 13,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function toolUseEvents(): unknown[] {
  return [
    {
      type: "message_start",
      audit_raw_canary: "raw-event-only-canary",
      message: {
        id: "msg_audit_1",
        type: "message",
        role: "assistant",
        model: "audit-fixture-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 13,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning-canary" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature-canary" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "先检查目录。" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_audit", name: "stat", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":\".\"}" } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ];
}

function finalTextEvents(ordinal: number): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: `msg_audit_${ordinal}`,
        type: "message",
        role: "assistant",
        model: "audit-fixture-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 13,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成。" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

await runVerify(main, workspace.cleanup);
