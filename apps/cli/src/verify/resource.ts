/**
 * verify:resource —— 通用 ResourceRef / 原样物化验收。
 *
 * 这里刻意只使用合成文本与字节，不含任何业务场景规则。每条判据都能通过
 * 删除对应存储、脱敏、来源或 hash 闸门单独翻红。
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  RedactionPort,
  RunEvent,
  ToolSnapshot,
  ToolExecutionContext,
} from "@workagent/harness-runtime";
import {
  DeclarativeEffectResolver,
  CollectingTraceSink,
  ToolRegistry,
  asId,
  executeBatch,
  renderToolResultForModel,
} from "@workagent/harness-runtime";
import { RandomIdGenerator, approveExcept } from "@workagent/testkit";
import {
  CommonArtifactChecker,
  CommonToolHandler,
  CommonVerifier,
  executeFetchUrl,
  executeMaterializeResource,
  executeReadResource,
  materializeResourceSnapshot,
} from "@workagent/tools-common";
import {
  SqliteArtifactStore,
  SqliteResourceStore,
  openDb,
} from "@workagent/store-sqlite";
import { compose } from "../compose.js";
import {
  ScriptedModelPort,
  banner,
  fact,
  runVerify,
  section,
  tempWorkspace,
  verdict,
} from "./harness.js";

const identityRedaction: RedactionPort = {
  redact: (raw) => ({
    ok: true,
    text: raw.replaceAll("SECRET_TEXT_SENTINEL", "[REDACTED:test]"),
    report: { fieldsRedacted: [], bytesRedacted: 0 },
  }),
};

async function main(): Promise<void> {
  banner(
    "ResourceRef 通用验收",
    "文本与二进制是否可恢复、可原样物化，同时不会把不透明字节送入模型可见轨道？",
  );
  const ws = tempWorkspace();
  const db = openDb({ path: ":memory:" });
  const resources = new SqliteResourceStore(db);
  const artifacts = new SqliteArtifactStore(db);
  try {
    section("A. 字节往返与内容去重");
    const text = "第一行 αβγ\n第二行 😀\n";
    const t1 = await resources.put({
      kind: "text",
      mediaType: "text/plain; charset=utf-8",
      label: "utf8 fixture",
      content: text,
      redactionDisposition: "TEXT_REDACTED",
    });
    const t2 = await resources.put({
      kind: "text",
      mediaType: "text/plain; charset=utf-8",
      label: "same bytes, another production",
      content: text,
      redactionDisposition: "TEXT_REDACTED",
    });
    const page = await resources.getTextPage(t1.ref);
    const rawText = await resources.readForMaterialization(t1.ref);
    const arbitrary = new Uint8Array([0, 255, 1, 2, 128, 10, 13, 42]);
    const binary = await resources.put({
      kind: "binary",
      mediaType: "application/octet-stream",
      label: "arbitrary bytes",
      content: arbitrary,
      redactionDisposition: "OPAQUE_BINARY_NOT_TEXT_SCANNED",
    });
    const rawBinary = await resources.readForMaterialization(binary.ref);
    const sameHashDifferentRef = t1.contentHash === t2.contentHash && t1.ref !== t2.ref;
    const textRoundTrip =
      page?.content === text &&
      Buffer.from(rawText?.content ?? []).equals(Buffer.from(text, "utf8"));
    const binaryRoundTrip = Buffer.from(rawBinary?.content ?? []).equals(Buffer.from(arbitrary));
    fact("相同文本 hash / refs", `${t1.contentHash === t2.contentHash} / ${t1.ref} ≠ ${t2.ref}`);
    fact("UTF-8 往返", textRoundTrip);
    fact("任意二进制往返", binaryRoundTrip);
    verdict(
      sameHashDifferentRef && textRoundTrip && binaryRoundTrip,
      "相同字节只共享内容身份、每次产生独立 ref；UTF-8 与任意字节均逐字节往返",
    );

    section("B. 原样物化、hash 与 Artifact 来源");
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);
    const pngRef = await resources.put({
      kind: "binary",
      mediaType: "image/png",
      label: "png fixture",
      suggestedFilename: "pixel.png",
      content: png,
      redactionDisposition: "OPAQUE_BINARY_NOT_TEXT_SCANNED",
    });
    const events = await runMaterializeBatch(
      ws.root,
      resources,
      artifacts,
      pngRef.ref,
      "assets/pixel.png",
    );
    const records = await artifacts.listByRun(asId("run_resource_verify"));
    const record = records[0];
    const exact = Buffer.from(readFileSync(join(ws.root, "assets/pixel.png"))).equals(Buffer.from(png));
    const atomic = readdirSync(join(ws.root, "assets")).every((name) => !name.includes(".workagent-"));
    const provenance =
      record?.role === "DELIVERABLE" &&
      record.sourceResourceRef === pngRef.ref &&
      events.some(
        (event) =>
          event.type === "ArtifactRegistered" &&
          event.payload.sourceResourceRef === pngRef.ref,
      );
    const magicChecked = events.some(
      (event) =>
        event.type === "ArtifactVerified" &&
        event.payload.ok &&
        event.payload.checksRun.includes("binary-magic"),
    );
    fact("磁盘字节逐字节一致", exact);
    fact("原子临时文件已清理", atomic);
    fact("Artifact role / source", `${record?.role} / ${record?.sourceResourceRef}`);
    fact("二进制魔数检查", magicChecked);
    verdict(
      exact && atomic && provenance && magicChecked,
      "materialize_resource 原子写入并独立校验，Artifact 来源贯穿存储与事件，二进制继续执行魔数检查",
    );

    section("B2. 复用既有 Artifact 不得追溯性改写其创建来源");
    const sameText = "same bytes, different registration path\n";
    writeFileSync(join(ws.root, "assets/existing.txt"), sameText, "utf8");
    const preexisting = await artifacts.register({
      runId: asId("run_resource_verify"),
      logicalId: "assets/existing.txt",
      role: "DELIVERABLE",
      kind: "text",
      path: "assets/existing.txt",
      content: sameText,
    });
    const sameRef = await resources.put({
      kind: "text",
      mediaType: "text/plain; charset=utf-8",
      label: "same bytes resource",
      content: sameText,
      redactionDisposition: "TEXT_REDACTED",
    });
    const reusedEvents = await runMaterializeBatch(
      ws.root,
      resources,
      artifacts,
      sameRef.ref,
      "assets/existing.txt",
    );
    const afterReuse = await artifacts.get(preexisting.artifactId);
    const currentRegistrationHasSource = reusedEvents.some(
      (event) =>
        event.type === "ArtifactRegistered" &&
        event.payload.artifactId === preexisting.artifactId &&
        event.payload.sourceResourceRef === sameRef.ref,
    );
    fact("既有内容版本的创建来源", afterReuse?.sourceResourceRef ?? "未记录（正确）");
    fact("本次登记动作的来源事件", currentRegistrationHasSource);
    verdict(
      afterReuse?.sourceResourceRef === undefined && currentRegistrationHasSource,
      "相同内容复用旧 Artifact 时不改写其创建 provenance；本次 materialize 来源仍由登记事件如实记录",
    );

    section("C. 失败必须显式且不越界");
    const ctx = context(ws.root);
    const missing = await executeMaterializeResource(
      { ref: "res_missing", path: "missing.bin", artifact_role: "INTERMEDIATE" },
      ctx,
      resources,
    );
    const escaped = await executeMaterializeResource(
      { ref: pngRef.ref, path: resolve(ws.root, "../escape.bin"), artifact_role: "INTERMEDIATE" },
      ctx,
      resources,
    );
    const badRole = await executeMaterializeResource(
      { ref: pngRef.ref, path: "bad.bin", artifact_role: "FINAL" },
      ctx,
      resources,
    );
    db.prepare("UPDATE resource_blobs SET content = ? WHERE content_hash = ?")
      .run(Buffer.from([1, 2, 3]), binary.contentHash);
    const tampered = await executeMaterializeResource(
      { ref: binary.ref, path: "tampered.bin", artifact_role: "INTERMEDIATE" },
      ctx,
      resources,
    );
    let oversizedError = "";
    try {
      await resources.put({
        kind: "binary",
        mediaType: "application/octet-stream",
        label: "oversized fixture",
        content: new Uint8Array(8 * 1024 * 1024 + 1),
        redactionDisposition: "OPAQUE_BINARY_NOT_TEXT_SCANNED",
      });
    } catch (err) {
      oversizedError = String((err as Error).message);
    }
    const codes = [missing, escaped, badRole, tampered].map((out) => out.error?.code);
    fact("四类失败码", codes.join(" / "));
    fact("8 MiB 上限", oversizedError.includes("RESOURCE_TOO_LARGE") ? "显式拒绝" : "未拒绝");
    verdict(
      codes.join("|") ===
        "TOOL_RESOURCE_NOT_FOUND|TOOL_PATH_ESCAPE|TOOL_ARTIFACT_ROLE_INVALID|TOOL_RESOURCE_HASH_MISMATCH" &&
        oversizedError.includes("RESOURCE_TOO_LARGE"),
      "缺失 ref、workspace 越界、非法角色、存储字节篡改与 Resource 超限均具名失败",
    );
    const throwingStore = {
      put: async () => {
        throw new Error("INJECTED_STORE_FAILURE");
      },
      getMetadata: async () => {
        throw new Error("INJECTED_STORE_FAILURE");
      },
      getTextPage: async () => {
        throw new Error("INJECTED_STORE_FAILURE");
      },
      readForMaterialization: async () => {
        throw new Error("INJECTED_STORE_FAILURE");
      },
      discardUncommitted: async () => {},
    };
    const materializeStoreFailure = await executeMaterializeResource(
      { ref: pngRef.ref, path: "store-failure.bin", artifact_role: "INTERMEDIATE" },
      ctx,
      throwingStore,
    );
    const readStoreFailure = await executeReadResource(
      { ref: pngRef.ref },
      ctx,
      throwingStore,
    );
    verdict(
      materializeStoreFailure.error?.code === "TOOL_RESOURCE_STORE_READ_FAILED" &&
        materializeStoreFailure.sideEffectState === "NO_EFFECT" &&
        readStoreFailure.error?.code === "TOOL_RESOURCE_STORE_READ_FAILED" &&
        readStoreFailure.sideEffectState === "NO_EFFECT",
      "ResourceStore 在读取阶段抛错时具名失败并如实记录 NO_EFFECT，不再落入 TOOL_THREW/UNKNOWN",
    );

    section("D. 二进制哨兵不进入模型可见结构");
    const opaque = Buffer.from("OPAQUE_BINARY_SENTINEL::never-inline", "utf8");
    const producedBatch = await runProducedResourceBatch(ws.root, opaque);
    const visible = producedBatch.visible;
    const hidden =
      !visible.includes(opaque.toString("utf8")) &&
      !visible.includes(opaque.toString("base64")) &&
      visible.includes("OPAQUE_BINARY_NOT_TEXT_SCANNED") &&
      producedBatch.binaryExact &&
      producedBatch.textContent === "[REDACTED:test]";
    fact("Transcript / Trace / Model Audit 合并长度", visible.length);
    verdict(
      hidden,
      "二进制正文与 base64 均不进入引用或事件，只留下 OPAQUE_BINARY_NOT_TEXT_SCANNED 元数据",
    );

    section("E. 同批累计 inline 上限按调用顺序生效");
    const aggregate = await runAggregateBatch(ws.root, resources);
    const externalized = aggregate.events.filter(
      (event) => event.type === "ToolResultExternalized",
    );
    const statuses = aggregate.results.map((result) => {
      if (result.type !== "tool_result") return "INVALID";
      try {
        return (JSON.parse(result.content) as { status?: string }).status ?? "INLINE";
      } catch {
        return "INLINE";
      }
    });
    fact("三条单项估算", "约 4400 / 4400 / 4400 tokens（均低于 8000）");
    fact("按顺序结果形态", statuses.join(" → "));
    fact("外置事件", externalized.map((event) => event.type).join(", ") || "（无）");
    verdict(
      statuses.join("|") === "INLINE|INLINE|EXTERNALIZED" && externalized.length === 1,
      "多个单项低于 8k 的结果在累计超过 12k 时外置，且只外置按顺序越线的结果",
    );

    section("F. ResourceRefs 元数据本身超限时形成可恢复索引");
    const many = await runManyResourcesBatch(ws.root, resources);
    const manyResult = many.results[0];
    const indexedEvent = many.events.find(
      (event) => event.type === "ToolResourceRefsExternalized",
    );
    const visibleTokens =
      manyResult?.type === "tool_result"
        ? Math.ceil(
            renderToolResultForModel(
              manyResult.content,
              manyResult.resourceRefs,
            ).length / 2.5,
          )
        : Number.POSITIVE_INFINITY;
    const indexRef =
      indexedEvent?.type === "ToolResourceRefsExternalized"
        ? indexedEvent.payload.indexRef
        : "";
    const indexPage = indexRef ? await resources.getTextPage(indexRef) : undefined;
    const indexPayload = indexPage
      ? (JSON.parse(indexPage.content) as { resourceCount?: number })
      : undefined;
    fact("索引前 ResourceRefs 数", indexedEvent?.type === "ToolResourceRefsExternalized" ? indexedEvent.payload.resourceCount : 0);
    fact("最终模型可见 token", visibleTokens);
    fact("索引可恢复的 ref 数", indexPayload?.resourceCount ?? 0);
    verdict(
      indexedEvent?.type === "ToolResourceRefsExternalized" &&
        (indexedEvent.payload.resourceCount ?? 0) >= 120 &&
        manyResult?.type === "tool_result" &&
        manyResult.resourceRefs?.length === 1 &&
        visibleTokens <= 8_000 &&
        indexPayload?.resourceCount === indexedEvent.payload.resourceCount,
      "大量附属 ResourceRefs 不再绕过单条 inline 上限：模型只收一个索引 ref，完整列表仍可分页恢复",
    );

    section("G. fetch_url 流式上限与转换后 Resource 元数据");
    const html = await executeFetchUrl(
      { url: "https://8.8.8.8/page.html" },
      context(ws.root),
      async () =>
        new Response("<h1>标题</h1><p>正文</p>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const converted = html.resources?.[0];
    let cancelled = false;
    let pulls = 0;
    const oversizedFetch = await executeFetchUrl(
      { url: "https://8.8.8.8/huge.bin" },
      context(ws.root),
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(4 * 1024 * 1024));
              // 正常实现会在第 3 块后 cancel；第 5 块 close 只是防止坏实现无限读。
              if (pulls >= 5) controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "application/octet-stream" } },
        ),
    );
    const oversizedBody = JSON.parse(oversizedFetch.output) as {
      sizeBytesComplete?: boolean;
      content?: string;
    };
    fact("HTML Resource MIME / filename", `${converted?.mediaType} / ${converted?.suggestedFilename}`);
    fact("超限流是否 cancel", cancelled);
    verdict(
      html.ok &&
        converted?.kind === "text" &&
        converted.mediaType === "text/markdown; charset=utf-8" &&
        converted.suggestedFilename === "page.md" &&
        typeof converted.content === "string" &&
        converted.content.includes("# 标题") &&
        oversizedFetch.ok &&
        oversizedFetch.resources === undefined &&
        oversizedBody.sizeBytesComplete === false &&
        oversizedBody.content === "" &&
        cancelled,
      "HTML 转换后的 Resource 使用 Markdown MIME/文件名；未知长度响应越过 8 MiB 时立即 cancel 且不产生引用",
    );
  } finally {
    db.close();
    ws.cleanup();
  }
}

async function runManyResourcesBatch(
  workspaceRoot: string,
  resources: SqliteResourceStore,
): Promise<Awaited<ReturnType<typeof drainBatch>>> {
  const snapshot: ToolSnapshot = {
    toolId: asId("tool_many_resources_fixture"),
    version: "1.0.0",
    definition: {
      id: asId("tool_many_resources_fixture"),
      version: "1.0.0",
      name: "many_resources_fixture",
      description: "验收夹具：一次产生大量小 Resource。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      effectResolution: {
        kind: "DECLARATIVE",
        rule: {
          pointer: "",
          effectType: "READ",
          scopeKind: "NONE",
          reversibility: "REVERSIBLE",
          operation: "fixture",
        },
      },
      redaction: { profile: "STANDARD" },
      idempotency: { isIdempotent: true, isReadOnly: true },
      timeoutPolicy: { timeoutMs: 10_000 },
      progressReporting: { mode: "NONE" },
      verification: { mode: "NONE", requiredForSuccess: false },
      recoveryObservation: { requiresPreFingerprint: false },
    },
  };
  return drainBatch(
    executeBatch(
      [{ toolCallId: "many_1", name: "many_resources_fixture", input: {} }],
      {
        runId: asId("run_many_resources"),
        invocationId: "inv_many_resources",
        registry: new ToolRegistry([snapshot]),
        tools: {
          execute: async () => ({
            ok: true,
            output: JSON.stringify({ status: "OK" }),
            sideEffectState: "NO_EFFECT" as const,
            resources: Array.from({ length: 120 }, (_, index) => ({
              kind: "binary" as const,
              label: `resource fixture ${index.toString().padStart(3, "0")} ${"x".repeat(180)}`,
              mediaType: "application/octet-stream",
              suggestedFilename: `part-${index.toString().padStart(3, "0")}.bin`,
              content: new Uint8Array([index % 256]),
            })),
          }),
        },
        effects: new DeclarativeEffectResolver(),
        redaction: identityRedaction,
        verification: {
          verify: async (action) => ({
            id: `ver_${action.id}`,
            actionId: action.id,
            mode: "NONE" as const,
            required: false,
            status: "SKIPPED" as const,
            detail: "夹具无需验证",
            at: Date.now(),
          }),
        },
        approvalDecider: approveExcept([]),
        approvalPolicy: { requiresApprovalFor: [], approvalTimeoutMs: 10_000 },
        timezone: "Asia/Shanghai",
        executionPrivilege: "SANDBOXED",
        ids: new RandomIdGenerator(),
        now: () => Date.now(),
        signal: new AbortController().signal,
        workspaceRoot,
        resources,
        inlineResultLimitTokens: 8_000,
        inlineResultsPerBatchLimitTokens: 12_000,
      },
    ),
  );
}

async function runProducedResourceBatch(
  workspaceRoot: string,
  opaque: Uint8Array,
): Promise<{
  visible: string;
  binaryExact: boolean;
  textContent?: string;
}> {
  const snapshot: ToolSnapshot = {
    toolId: asId("tool_produced_resource_fixture"),
    version: "1.0.0",
    definition: {
      id: asId("tool_produced_resource_fixture"),
      version: "1.0.0",
      name: "produced_resource_fixture",
      description: "验收夹具：产生一个文本和一个二进制 Resource。",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      effectResolution: {
        kind: "DECLARATIVE",
        rule: {
          pointer: "",
          effectType: "READ",
          scopeKind: "NONE",
          reversibility: "REVERSIBLE",
          operation: "fixture",
        },
      },
      redaction: { profile: "STANDARD" },
      idempotency: { isIdempotent: true, isReadOnly: true },
      timeoutPolicy: { timeoutMs: 10_000 },
      progressReporting: { mode: "NONE" },
      verification: { mode: "NONE", requiredForSuccess: false },
      recoveryObservation: { requiresPreFingerprint: false },
    },
  };
  const trace = new CollectingTraceSink();
  const auditDir = mkdtempSync(join(tmpdir(), "workagent-resource-audit-"));
  const model = new ScriptedModelPort([
    {
      text: "产生合成资源",
      toolCalls: [{ toolCallId: "produced_1", name: "produced_resource_fixture", input: {} }],
    },
    { text: "完成。", toolCalls: [] },
  ]);
  const composed = compose({
    workspaceRoot,
    dbPath: ":memory:",
    modelAuditDir: auditDir,
    trace,
    modelPortOverride: model,
    approvalDecider: approveExcept([]),
    tools: [snapshot],
    portOverrides: {
      redaction: identityRedaction,
      tools: {
        execute: async () => ({
          ok: true,
          output: JSON.stringify({ status: "OK" }),
          sideEffectState: "NO_EFFECT" as const,
          resources: [
            {
              kind: "text" as const,
              label: "secret text fixture",
              mediaType: "text/plain",
              content: "SECRET_TEXT_SENTINEL",
            },
            {
              kind: "binary" as const,
              label: "opaque binary fixture",
              mediaType: "application/octet-stream",
              content: opaque,
            },
          ],
        }),
      },
    },
  });
  try {
    const generator = composed.runtime.start(
      composed.makeRunSpec("验证 Resource 不进入模型可见持久化轨道"),
    );
    let runId = "";
    let item = await generator.next();
    while (!item.done) {
      if (!runId) runId = String(item.value.runId);
      item = await generator.next();
    }
    const entries = await composed.ports.transcript.readAll(runId as never);
    const binaryEvent = trace.events.find(
      (event) => event.type === "ResourceStored" && event.payload.kind === "binary",
    );
    const textEvent = trace.events.find(
      (event) => event.type === "ResourceStored" && event.payload.kind === "text",
    );
    const storedOpaque =
      binaryEvent?.type === "ResourceStored"
        ? await composed.ports.resources.readForMaterialization(binaryEvent.payload.ref)
        : undefined;
    const storedText =
      textEvent?.type === "ResourceStored"
        ? await composed.ports.resources.getTextPage(textEvent.payload.ref)
        : undefined;
    return {
      visible:
        JSON.stringify({ transcript: entries, trace: trace.events, requests: model.requestBodies }) +
        readTreeText(auditDir),
      binaryExact: Buffer.from(storedOpaque?.content ?? []).equals(Buffer.from(opaque)),
      ...(storedText ? { textContent: storedText.content } : {}),
    };
  } finally {
    composed.db.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
}

function readTreeText(root: string): string {
  if (!existsSync(root)) return "";
  let out = "";
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    out += entry.isDirectory() ? readTreeText(path) : readFileSync(path, "utf8");
  }
  return out;
}

async function runAggregateBatch(
  workspaceRoot: string,
  resources: SqliteResourceStore,
): Promise<{ events: RunEvent[]; results: Awaited<ReturnType<typeof drainBatch>>["results"] }> {
  const snapshot: ToolSnapshot = {
    toolId: asId("tool_resource_batch_fixture"),
    version: "1.0.0",
    definition: {
      id: asId("tool_resource_batch_fixture"),
      version: "1.0.0",
      name: "resource_batch_fixture",
      description: "验收夹具：返回指定序号的合成文本。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { marker: { type: "string" } },
        required: ["marker"],
      },
      effectResolution: {
        kind: "DECLARATIVE",
        rule: {
          pointer: "/marker",
          effectType: "READ",
          scopeKind: "NONE",
          reversibility: "REVERSIBLE",
          operation: "fixture",
        },
      },
      redaction: { profile: "STANDARD" },
      idempotency: { isIdempotent: true, isReadOnly: true },
      timeoutPolicy: { timeoutMs: 10_000 },
      progressReporting: { mode: "NONE" },
      verification: { mode: "NONE", requiredForSuccess: false },
      recoveryObservation: { requiresPreFingerprint: false },
    },
  };
  const generator = executeBatch(
    ["a", "b", "c"].map((marker, index) => ({
      toolCallId: `aggregate_${index}`,
      name: "resource_batch_fixture",
      input: { marker },
    })),
    {
      runId: asId("run_resource_aggregate"),
      invocationId: "inv_resource_aggregate",
      registry: new ToolRegistry([snapshot]),
      tools: {
        execute: async (action) => ({
          ok: true,
          output: String(
            (action.normalizedInput as Record<string, unknown>)["marker"] ?? "x",
          ).repeat(11_000),
          sideEffectState: "NO_EFFECT" as const,
        }),
      },
      effects: new DeclarativeEffectResolver(),
      redaction: identityRedaction,
      verification: {
        verify: async (action) => ({
          id: `ver_${action.id}`,
          actionId: action.id,
          mode: "NONE" as const,
          required: false,
          status: "SKIPPED" as const,
          detail: "夹具无需验证",
          at: Date.now(),
        }),
      },
      approvalDecider: approveExcept([]),
      approvalPolicy: { requiresApprovalFor: [], approvalTimeoutMs: 10_000 },
      timezone: "Asia/Shanghai",
      executionPrivilege: "SANDBOXED",
      ids: new RandomIdGenerator(),
      now: () => Date.now(),
      signal: new AbortController().signal,
      workspaceRoot,
      resources,
      inlineResultLimitTokens: 8_000,
      inlineResultsPerBatchLimitTokens: 12_000,
    },
  );
  return drainBatch(generator);
}

async function drainBatch(
  generator: ReturnType<typeof executeBatch>,
): Promise<{
  events: RunEvent[];
  results: Array<import("@workagent/harness-runtime").ModelContent>;
}> {
  const events: RunEvent[] = [];
  let item = await generator.next();
  while (!item.done) {
    events.push(item.value);
    item = await generator.next();
  }
  return { events, results: item.value.results };
}

async function runMaterializeBatch(
  workspaceRoot: string,
  resources: SqliteResourceStore,
  artifacts: SqliteArtifactStore,
  ref: string,
  path: string,
): Promise<RunEvent[]> {
  const generator = executeBatch(
    [
      {
        toolCallId: "materialize_1",
        name: "materialize_resource",
        input: { ref, path, artifact_role: "DELIVERABLE" },
      },
    ],
    {
      runId: asId("run_resource_verify"),
      invocationId: "inv_resource_verify",
      registry: new ToolRegistry([materializeResourceSnapshot]),
      tools: new CommonToolHandler({ resources }),
      effects: new DeclarativeEffectResolver(),
      redaction: identityRedaction,
      verification: new CommonVerifier(),
      approvalDecider: approveExcept([]),
      approvalPolicy: { requiresApprovalFor: ["WRITE"], approvalTimeoutMs: 10_000 },
      timezone: "Asia/Shanghai",
      executionPrivilege: "SANDBOXED",
      ids: new RandomIdGenerator(),
      now: () => Date.now(),
      signal: new AbortController().signal,
      workspaceRoot,
      resources,
      artifacts,
      artifactChecks: new CommonArtifactChecker({ workspaceRoot }),
      inlineResultLimitTokens: 8_000,
      inlineResultsPerBatchLimitTokens: 12_000,
    },
  );
  return (await drainBatch(generator)).events;
}

function context(workspaceRoot: string): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot,
    timezone: "Asia/Shanghai",
    executionPrivilege: "SANDBOXED",
    onProgress: () => {},
  };
}

await runVerify(main);
