/**
 * verify:model-audit 的真崩溃夹具。
 *
 * 写完一个合法审计前缀后立刻 SIGKILL：没有 finally、没有 finish()，用来证明
 * JSONL reader 会把进程真实死亡留下的文件判成 INCOMPLETE，而不是伪装完整。
 */

import { writeSync } from "node:fs";
import {
  MODEL_INVOCATION_AUDIT_SCHEMA_VERSION,
  asId,
  type ContextFrameId,
  type ModelInvocationId,
  type RunId,
  type Timestamp,
} from "@workagent/harness-runtime";
import { FileModelInvocationAuditStore } from "../../model-audit/file-store.js";

const rootDir = process.argv[2];
if (!rootDir) throw new Error("用法：model-audit-crash.ts <audit-root>");

const writer = new FileModelInvocationAuditStore(rootDir).open({
  schemaVersion: MODEL_INVOCATION_AUDIT_SCHEMA_VERSION,
  runId: asId<RunId>("run_audit_crash"),
  invocationId: asId<ModelInvocationId>("inv_audit_crash"),
  frameId: asId<ContextFrameId>("frame_audit_crash"),
  turn: 1,
  endpointProfileVersion: "fixture-v1",
  modelId: "fixture-model",
  startedAt: Date.now() as Timestamp,
  requestBody: { messages: [{ role: "user", content: "crash-prefix-canary" }] },
});
writer.responseMetadata({ status: 200, requestId: "req-before-crash" }, Date.now() as Timestamp);
writer.providerEvent({ type: "message_start", crash_prefix: true }, Date.now() as Timestamp);

// stdout 同步写完再 kill，让父进程能区分“夹具没启动”与“确实死在目标点”。
writeSync(1, "@@AUDIT_PREFIX_WRITTEN@@\n");
process.kill(process.pid, "SIGKILL");
