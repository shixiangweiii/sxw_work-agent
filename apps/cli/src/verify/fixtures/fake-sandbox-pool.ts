/**
 * 手写的**假沙箱池**，给 `verify:cloud` 当夹具。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】不拿真池子当夹具，三条理由，第三条最要紧：
 *   ① 真池子要云端凭证，判据就只能在有凭证的机器上跑；
 *   ② 它会真的建沙箱，**花钱**；
 *   ③ 拿一个真实服务当夹具，测的就成了「Atlas 能不能接**我这个**池子」——
 *      而要答的是「Atlas 这一侧的判定对不对」。
 * 与 `fake-mcp-server.ts` 同一条纪律。
 *
 * 它刻意造出真实池子的那些难处：借用等待、429/503/504/502 各自的语义、
 * 出网回显（**可以故意写错**）、输出截断、超时带着半截输出回来。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface FakePoolOptions {
  /** 下一次 acquire 返回这个 HTTP 状态（不设就正常借出）。 */
  acquireStatus?: number;
  /** 回显故意写成这一份（判据：Atlas 的第二道闸门要能被单独触发）。 */
  echoOverride?: Record<string, unknown>;
  /** 命令执行返回这个结果（不设就回显命令本身）。 */
  exec?: Partial<{
    exit_code: number;
    stdout: string;
    stderr: string;
    error: string;
    truncated: boolean;
    stdout_bytes: number;
    stderr_bytes: number;
  }>;
  /** command 调用返回这个 HTTP 状态。 */
  commandStatus?: number;
  /** command 调用时让 fetch 自己抛（模拟「请求发出去了、响应没回来」）。 */
  commandUnreachable?: boolean;
}

export interface FakePool {
  fetchImpl: typeof fetch;
  opts: FakePoolOptions;
  /** 按时间顺序记下收到的请求，判据据此断言「Atlas 实际发了什么」。 */
  calls: { method: string; path: string; body?: unknown }[];
  /** 沙箱里的文件系统（上传进来的 ＋ 预置的）。 */
  files: Map<string, Uint8Array>;
  /** 已借出但还没归还的 lease。判据据此断言「无论如何都归还了」。 */
  openLeases: Set<string>;
  /** 本次 acquire 实际收到的出网策略（undefined = 调用方没传）。 */
  lastEgressRequest: unknown;
}

const ALL = "0.0.0.0/0";

export function makeFakePool(opts: FakePoolOptions = {}): FakePool {
  const pool: FakePool = {
    fetchImpl: null as unknown as typeof fetch,
    opts,
    calls: [],
    files: new Map(),
    openLeases: new Set(),
    lastEgressRequest: undefined,
  };
  let seq = 0;

  pool.fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname + u.search;
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    pool.calls.push({ method, path, ...(body === undefined ? {} : { body }) });

    const json = (status: number, obj: unknown) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

    // ── 借用 ──
    if (method === "POST" && u.pathname === "/v1/leases") {
      if (pool.opts.acquireStatus) {
        return new Response(JSON.stringify({ detail: "injected" }), { status: pool.opts.acquireStatus });
      }
      const req = (body ?? {}) as Record<string, unknown>;
      pool.lastEgressRequest = req.egress;
      const eg = req.egress as { mode?: string; allow_out?: string[] } | undefined;
      // 真池子的语义：不传 egress = 彻底断网
      const desired =
        eg === undefined
          ? { mode: "allowlist", allow_out: [], deny_out: [ALL], rules: {} }
          : eg.mode === "open"
            ? { mode: "open", allow_out: [], deny_out: ["10.0.0.0/8"], rules: {} }
            : { mode: "allowlist", allow_out: eg.allow_out ?? [], deny_out: [ALL], rules: {} };
      const id = `lease-${++seq}`;
      pool.openLeases.add(id);
      return json(200, {
        lease_id: id,
        sandbox_id: `sbx-${seq}`,
        state: "ACTIVE",
        source: "ready",
        created_at: 0,
        expires_at: 1_000_000,
        hard_deadline: 2_000_000,
        egress: desired,
        // 平台回显：默认与下发一致；判据可以用 echoOverride 让它说谎
        egress_platform: pool.opts.echoOverride ?? {
          allow_out: desired.allow_out,
          deny_out: desired.deny_out,
          allow_public_traffic: false,
        },
      });
    }

    const m = u.pathname.match(/^\/v1\/leases\/([^/]+)(\/.*)?$/);
    if (!m) return new Response("not found", { status: 404 });
    const leaseId = decodeURIComponent(m[1] as string);
    const rest = m[2] ?? "";

    // ── 归还 ──
    if (method === "DELETE" && rest === "") {
      pool.openLeases.delete(leaseId);
      return json(200, { lease_id: leaseId, state: "RELEASED" });
    }

    // ── 文件 ──
    if (rest === "/files") {
      const p = u.searchParams.get("path") ?? "";
      if (method === "PUT") {
        const raw = init?.body;
        pool.files.set(p, raw instanceof Uint8Array ? raw : new TextEncoder().encode(String(raw ?? "")));
        return json(200, { path: p, size: pool.files.get(p)?.byteLength ?? 0 });
      }
      if (method === "GET") {
        const data = pool.files.get(p);
        if (!data) return new Response("no such file", { status: 404 });
        return new Response(data as unknown as string, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
    }

    // ── 执行 ──
    if (method === "POST" && rest === "/commands") {
      // 真实世界里这是读超时：请求已经送到，命令**可能正在跑**，而我们不知道结果
      if (pool.opts.commandUnreachable) throw new TypeError("fetch failed");
      if (pool.opts.commandStatus) {
        return new Response(JSON.stringify({ detail: "injected" }), { status: pool.opts.commandStatus });
      }
      const cmd = String((body as Record<string, unknown>)?.cmd ?? "");
      const e = pool.opts.exec ?? {};
      const stdout = e.stdout ?? `ran: ${cmd}\n`;
      return json(200, {
        exit_code: e.exit_code ?? 0,
        stdout,
        stderr: e.stderr ?? "",
        error: e.error ?? null,
        truncated: e.truncated ?? false,
        stdout_bytes: e.stdout_bytes ?? new TextEncoder().encode(stdout).byteLength,
        stderr_bytes: e.stderr_bytes ?? 0,
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return pool;
}
