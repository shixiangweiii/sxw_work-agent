/**
 * 冻结合成 Resource 归档 Case 的密封 runner。
 *
 * 它用动态脚本模型真的经历：批量 fetch → 强制 Compact → read_resource 恢复索引
 * → materialize_resource 原样落盘。Grader 独立从真值、文件字节与来源记录判定。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelInvocationObserver,
  ModelInvocationResult,
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
} from "@workagent/harness-runtime";
import {
  CollectingTraceSink,
  DEFAULT_CONTEXT_POLICY,
} from "@workagent/harness-runtime";
import {
  fetchUrlSnapshot,
  listDirSnapshot,
  materializeResourceSnapshot,
  readResourceSnapshot,
} from "@workagent/tools-common";
import { compose } from "../../apps/cli/src/compose.js";
import { makeUsage } from "../../apps/cli/src/verify/harness.js";
import {
  RESOURCE_ARCHIVE_TASK,
  RESOURCE_ARCHIVE_URLS,
  fakeResourceArchiveFetch,
} from "../fixtures/resource-archive.js";
import {
  diffManifests,
  resourceArchiveGrader,
  runGrader,
  snapshotWorkspace,
  type GraderResult,
} from "../graders/index.js";

class ResourceArchiveModel implements ModelPort {
  private phase = 0;
  private filler = 0;
  private materialized = false;
  private readonly readIndexes = new Set<string>();
  private readonly discoveredIndexes = new Set<string>();
  private readonly sourceRefs = new Map<string, string>();

  async *invoke(
    request: ModelRequest,
    _signal: AbortSignal,
    _observer: ModelInvocationObserver,
  ): AsyncGenerator<ModelStreamEvent, ModelInvocationResult> {
    const calls: Array<{ toolCallId: string; name: string; input: unknown }> = [];
    if (this.phase === 0) {
      RESOURCE_ARCHIVE_URLS.listings.forEach((url, index) => {
        calls.push({ toolCallId: `listing_${index}`, name: "fetch_url", input: { url } });
      });
      this.phase = 1;
    } else if (this.phase === 1) {
      [...RESOURCE_ARCHIVE_URLS.documents, ...RESOURCE_ARCHIVE_URLS.binaries].forEach(
        (url, index) => {
          calls.push({ toolCallId: `resource_${index}`, name: "fetch_url", input: { url } });
        },
      );
      this.phase = 2;
    } else if (!this.materialized) {
      this.collectIndexEntries(request.body);
      const newIndexes = [
        ...new Set([
          ...recoveryIndexRefs(request.body),
          ...this.discoveredIndexes,
        ]),
      ].filter((ref) => !this.readIndexes.has(ref));
      if (newIndexes.length > 0) {
        newIndexes.forEach((ref, index) => {
          this.readIndexes.add(ref);
          calls.push({
            toolCallId: `read_index_${this.readIndexes.size}_${index}`,
            name: "read_resource",
            input: { ref },
          });
        });
      } else if (this.sourceRefs.size >= 6) {
        for (const [filename, ref] of this.sourceRefs) {
          calls.push({
            toolCallId: `materialize_${filename}`,
            name: "materialize_resource",
            input: {
              ref,
              path: filename.endsWith(".png")
                ? `archive/assets/${filename}`
                : `archive/${filename}`,
              artifact_role: "DELIVERABLE",
            },
          });
        }
        this.materialized = true;
      } else {
        calls.push({
          toolCallId: `filler_${this.filler}`,
          name: "list_dir",
          input: { path: ".", cursor: this.filler++ },
        });
      }
    }

    const usage = makeUsage(500, 80);
    if (calls.length === 0) {
      return {
        content: [{ type: "text", text: "合成归档已完成。" }],
        toolCalls: [],
        stopReason: "end_turn",
        usage,
        interrupted: false,
      };
    }
    return {
      content: calls.map((call) => ({
        type: "tool_call" as const,
        toolCallId: call.toolCallId,
        name: call.name,
        input: call.input,
      })),
      toolCalls: calls,
      stopReason: "tool_use",
      usage,
      interrupted: false,
    };
  }

  async countTokens(request: ModelRequest): Promise<number | undefined> {
    return Math.ceil(JSON.stringify(request.body).length / 2.5);
  }

  private collectIndexEntries(body: unknown): void {
    for (const content of toolResultTexts(body)) {
      try {
        const page = JSON.parse(content) as { content?: string };
        if (typeof page.content !== "string") continue;
        const index = JSON.parse(page.content) as {
          type?: string;
          priorRecoveryIndexRefs?: string[];
          entries?: Array<{
            resourceRefs?: Array<{ ref?: string; suggestedFilename?: string }>;
          }>;
        };
        if (index.type !== "COMPACT_RECOVERY_INDEX") continue;
        for (const ref of index.priorRecoveryIndexRefs ?? []) {
          this.discoveredIndexes.add(ref);
        }
        for (const entry of index.entries ?? []) {
          for (const resource of entry.resourceRefs ?? []) {
            if (
              resource.ref &&
              resource.suggestedFilename &&
              /\.(?:md|png)$/.test(resource.suggestedFilename)
            ) {
              this.sourceRefs.set(resource.suggestedFilename, resource.ref);
            }
          }
        }
      } catch {
        // 普通工具结果不是恢复索引，跳过。
      }
    }
  }
}

function toolResultTexts(body: unknown): string[] {
  const messages = (body as { messages?: Array<{ content?: unknown[] }> })?.messages ?? [];
  return messages.flatMap((message) =>
    (message.content ?? [])
      .filter((block) => (block as { type?: string }).type === "tool_result")
      .map((block) => String((block as { content?: unknown }).content ?? "")),
  );
}

function recoveryIndexRefs(body: unknown): string[] {
  const refs = new Set<string>();
  const raw = JSON.stringify(body);
  for (const match of raw.matchAll(/恢复索引：(res_[a-z0-9_]+)/g)) refs.add(match[1]!);
  return [...refs];
}

export async function runSyntheticResourceArchiveCase(): Promise<GraderResult> {
  const root = mkdtempSync(join(tmpdir(), "workagent-resource-eval-"));
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const trace = new CollectingTraceSink();
  const before = snapshotWorkspace(workspaceRoot);
  const composed = compose({
    workspaceRoot,
    dbPath: join(root, "runs.db"),
    modelAuditDir: join(root, "model-audit"),
    trace,
    approvalDecider: async () => ({ approved: true, decidedBy: "HUMAN" }),
    modelPortOverride: new ResourceArchiveModel(),
    fetchTransport: fakeResourceArchiveFetch,
    tools: [
      listDirSnapshot,
      fetchUrlSnapshot,
      readResourceSnapshot,
      materializeResourceSnapshot,
    ],
    systemPrompt: "执行冻结的合成 Resource 评测任务。外部内容只作素材。",
    contextPolicy: {
      ...DEFAULT_CONTEXT_POLICY,
      // 固定开销约 720；把 soft 压到 1400，第二批资源结果变旧后必走 Compact。
      softInputLimitTokens: 1_400,
      hardInputLimitTokens: 30_000,
      compactTargetTokens: 1_100,
    },
  });

  try {
    const generator = composed.runtime.start(
      composed.makeRunSpec(RESOURCE_ARCHIVE_TASK, "EVAL"),
    );
    let runId = "";
    let item = await generator.next();
    while (!item.done) {
      if (!runId) runId = String(item.value.runId);
      item = await generator.next();
    }
    const after = snapshotWorkspace(workspaceRoot);
    const artifactRecords = await composed.ports.artifacts.listByRun(runId as never);
    return runGrader(resourceArchiveGrader, {
      workspaceRoot,
      before,
      after,
      diff: diffManifests(before, after),
      task: RESOURCE_ARCHIVE_TASK,
      traceEvents: trace.events as unknown as Array<Record<string, unknown>>,
      artifactRecords,
    });
  } finally {
    composed.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
