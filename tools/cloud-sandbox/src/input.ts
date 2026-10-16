/**
 * `cloud_shell` 的入参解析。**resolver / handler / 审批面共用这一份。**
 *
 * 【定】三处各解析一遍的后果不是重复，是**分叉**：审批面上显示「断网」而
 * 实际跑的是白名单，或者 resolver 数出 2 个 inputs 而 handler 传了 3 个 ——
 * 而两边都不会报错。`fs-common.ts` 的 `writeBoundaryRefusal` 收敛成一份，
 * 是同一条纪律。
 */

import type { JsonValue } from "@workagent/harness-runtime";

/** 出网档位。`label` 进 digest 与审批面，必须是规范化后的。 */
export type NetworkSpec =
  | { kind: "none"; allow: []; label: "none" }
  | { kind: "open"; allow: []; label: "open" }
  | { kind: "allowlist"; allow: string[]; label: string };

/** 按行分隔的路径清单（B4 把自家工具锁在标量上，所以列表只能这么传）。 */
export function parseLines(raw: JsonValue | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 解析 `network`。
 *
 * 【定】**认不出来的一律按 `none` 处理**，不报错也不放行。
 * 失败方向固定在保守侧：模型拼错一个档位名，后果应该是「这次没网、命令失败、
 * 它看得见」，而不是「悄悄开了全网」。
 */
export function parseNetwork(raw: JsonValue | undefined): NetworkSpec {
  if (typeof raw !== "string") return { kind: "none", allow: [], label: "none" };
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "none" || v === "off" || v === "false") {
    return { kind: "none", allow: [], label: "none" };
  }
  if (v === "open" || v === "all") return { kind: "open", allow: [], label: "open" };
  const allow = Array.from(
    new Set(
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ).sort();
  if (allow.length === 0) return { kind: "none", allow: [], label: "none" };
  return { kind: "allowlist", allow, label: allow.join(",") };
}

/** 一条命令要用到的、已经规范化的入参。 */
export interface CloudShellInput {
  command: string;
  description?: string;
  inputs: string[];
  outputs: string[];
  network: NetworkSpec;
  timeoutMs: number;
  artifactPath?: string;
  artifactRole?: string;
}

export function parseInput(
  raw: Record<string, unknown>,
  { defaultTimeoutMs, maxTimeoutMs }: { defaultTimeoutMs: number; maxTimeoutMs: number },
): CloudShellInput {
  const t = typeof raw.timeout_ms === "number" && Number.isFinite(raw.timeout_ms) ? raw.timeout_ms : defaultTimeoutMs;
  return {
    command: typeof raw.command === "string" ? raw.command : "",
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    inputs: parseLines(raw.inputs as JsonValue),
    outputs: parseLines(raw.outputs as JsonValue),
    network: parseNetwork(raw.network as JsonValue),
    timeoutMs: Math.min(Math.max(1_000, t), maxTimeoutMs),
    ...(typeof raw.artifact_path === "string" && raw.artifact_path.trim()
      ? { artifactPath: raw.artifact_path.trim() }
      : {}),
    ...(typeof raw.artifact_role === "string" ? { artifactRole: raw.artifact_role } : {}),
  };
}
