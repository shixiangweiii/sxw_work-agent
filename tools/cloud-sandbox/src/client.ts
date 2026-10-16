/**
 * 沙箱池（`sxw_fc-sandbox`）的 HTTP 客户端。**只会说话，不做判定。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】判定全在 `handler.ts`：读黑名单、outputs 边界、回显核对、产物登记。
 * 判定若写进这里，验收脚本只能拿一个假池子去**模仿**它，判据测的就成了假池子
 * —— 与 ADR-0013「判定不进 Swift 助手」一字不差。
 *
 * 【定】边界 grep 第 16 条守着这个文件不进 `packages/` 与 `adapters/`。
 * 诱惑形态与 MCP 第 12 条同构：把它搬进 `ports/` 叫一个「SandboxPort」，
 * 那里本来就叫 Port，看着天经地义 —— 而边界 4 / 6 / 7 一条都不会响。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 池子里一次借用。`leaseId` 是**凭证**，不得出现在 output / 事件 / trace / 审批面。 */
export interface Lease {
  leaseId: string;
  sandboxId: string;
  expiresAt: number;
  /** 本次借用生效的出网策略（池子回给我们的「我按这个下发了」）。 */
  egress?: EgressEcho;
  /** 平台自己回显的那一份。闸门二比的就是它。 */
  egressPlatform?: EgressEcho;
}

export interface EgressEcho {
  mode?: string;
  allow_out?: string[];
  deny_out?: string[];
  [k: string]: unknown;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

/** 池子给出的、可以直接映射成 Atlas 事实的失败分类。 */
export type PoolFailureKind =
  /** 没借到沙箱（队列满 / 排空中 / 等待超时）—— 命令**根本没跑** */
  | "NOT_ACQUIRED"
  /** 沙箱侧出错 —— 跑没跑说不清 */
  | "SANDBOX_ERROR"
  /** 池子不可达 / 协议对不上 */
  | "UNREACHABLE";

export class PoolError extends Error {
  constructor(
    readonly kind: PoolFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface PoolClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** 借用等待上限（池子那边还有自己的上限，取小）。 */
  waitTimeoutMs: number;
  /** 单次 HTTP 请求超时。执行类请求另按命令超时放宽。 */
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** 借用时要的出网策略。`undefined` = 不传 = 池子按**彻底断网**处理。 */
export interface EgressRequest {
  mode: "allowlist" | "open";
  allow_out: string[];
  deny_out: string[];
}

export class PoolClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PoolClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async acquire(egress: EgressRequest | undefined, leaseTtlMs: number): Promise<Lease> {
    const body: Record<string, unknown> = {
      wait_timeout_s: this.opts.waitTimeoutMs / 1000,
      lease_ttl_s: leaseTtlMs / 1000,
    };
    // 【定】不传 egress ＝ 池子按彻底断网处理。**不要**为了「显式」而传一个
    // 等价的全禁策略 —— 那会让「调用方要求断网」与「调用方没说」在池子的
    // 借用记录上不可区分，而这两件事在事后归因时完全不同。
    if (egress) body.egress = egress;
    const r = await this.call("POST", "/v1/leases", body, this.opts.waitTimeoutMs + 10_000);
    const j = (await r.json()) as Record<string, unknown>;
    return {
      leaseId: String(j.lease_id),
      sandboxId: String(j.sandbox_id),
      expiresAt: Number(j.expires_at),
      egress: (j.egress as EgressEcho) ?? undefined,
      egressPlatform: (j.egress_platform as EgressEcho) ?? undefined,
    };
  }

  async release(leaseId: string): Promise<void> {
    await this.call("DELETE", `/v1/leases/${encodeURIComponent(leaseId)}`, undefined, this.opts.requestTimeoutMs);
  }

  async upload(leaseId: string, path: string, data: Uint8Array): Promise<void> {
    const url = `/v1/leases/${encodeURIComponent(leaseId)}/files?path=${encodeURIComponent(path)}`;
    await this.call("PUT", url, data, this.opts.requestTimeoutMs);
  }

  async download(leaseId: string, path: string): Promise<Uint8Array> {
    const url = `/v1/leases/${encodeURIComponent(leaseId)}/files?path=${encodeURIComponent(path)}`;
    const r = await this.call("GET", url, undefined, this.opts.requestTimeoutMs);
    return new Uint8Array(await r.arrayBuffer());
  }

  async command(leaseId: string, cmd: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
    const r = await this.call(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/commands`,
      { cmd, cwd, timeout_s: timeoutMs / 1000 },
      timeoutMs + 30_000,
    );
    const j = (await r.json()) as Record<string, unknown>;
    return {
      exitCode: Number(j.exit_code),
      stdout: String(j.stdout ?? ""),
      stderr: String(j.stderr ?? ""),
      error: j.error ? String(j.error) : undefined,
      truncated: j.truncated === true,
      stdoutBytes: Number(j.stdout_bytes ?? 0),
      stderrBytes: Number(j.stderr_bytes ?? 0),
    };
  }

  private async call(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    let payload: string | Uint8Array | undefined;
    if (body instanceof Uint8Array) {
      payload = body;
      headers["content-type"] = "application/octet-stream";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload as unknown as string }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new PoolError("UNREACHABLE", `连不上沙箱池 ${this.opts.baseUrl}：${(e as Error).message}`);
    }
    if (res.ok) return res;
    const text = (await res.text().catch(() => "")).slice(0, 400);
    /**
     * 【定】这张映射表决定了 Atlas 事实表里写什么，它必须逐条对得上池子的语义：
     *   429 队列满 / 503 排空中 / 504 等待超时 → **一个沙箱都没借到**，命令没跑；
     *   502 → 沙箱侧出错，跑没跑说不清。
     * 合并成一类的后果很具体：「池子忙」会被记成「副作用状态未知」，
     * 于是一次本该直接重试的请求变成了要人来销账的恢复项。
     */
    const kind: PoolFailureKind =
      res.status === 429 || res.status === 503 || res.status === 504 ? "NOT_ACQUIRED" : "SANDBOX_ERROR";
    throw new PoolError(kind, `沙箱池返回 ${res.status}：${text}`, res.status);
  }
}
