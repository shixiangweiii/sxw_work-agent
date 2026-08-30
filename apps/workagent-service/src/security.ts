/**
 * 本地前后端通信的边界（V05 §22.6【定】）。
 *
 * 原文四条：**随机端口或受控 Socket；会话级鉴权 Token；Origin 校验；
 * 禁止外部网页调用本地 API**。这里逐条落地，外加一条 §22.6 没写但它必须的。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【定】第五条：**Host 头必须是 loopback 字面量**。
 *
 * 只校验 Origin 挡不住 DNS rebinding：攻击者把自己的域名解析到 127.0.0.1，
 * 浏览器发出的请求在他自己看来是同源的，`Origin` 就是他的域名 ——
 * 而如果我们「只在 Origin 存在时才校验」，一个 `no-cors` 的表单提交
 * 连 Origin 都可以不带，那条分支直接放行。
 *
 * 校验 `Host` 是 `127.0.0.1:<port>` / `localhost:<port>` 才能把这条堵上：
 * 浏览器会如实填写它请求的主机名，而攻击者的域名不是 loopback 字面量。
 *
 * 这不是过度设计。这个服务代理的是**一个能读你磁盘、能跑 shell 的 Agent**，
 * 一个能调它的网页等于一次远程代码执行。
 * ══════════════════════════════════════════════════════════════════════
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface GuardResult {
  ok: boolean;
  status?: number;
  message?: string;
}

export class LocalGuard {
  readonly token: string;

  constructor(
    private readonly port: () => number,
    token?: string,
  ) {
    // 32 字节。会话级，进程重启就换一个 —— 它不落盘（落盘的 token 就不是会话级了）。
    this.token = token ?? randomBytes(32).toString("hex");
  }

  /**
   * 一次请求能不能进来。
   *
   * 顺序是刻意的：**先判来源，再判凭据**。反过来的话，一个跨站请求会先
   * 因为没带 token 得到 401 —— 而 401 与 403 对调试的人意义完全不同
   * （一个说「你忘了带钥匙」，一个说「你根本不该出现在这里」）。
   */
  check(
    req: IncomingMessage,
    url: URL,
    opts: { requireToken: boolean } = { requireToken: true },
  ): GuardResult {
    const host = req.headers.host ?? "";
    if (!this.isLoopbackHost(host)) {
      return {
        ok: false,
        status: 403,
        message: `Host 不是 loopback：${host}。这个服务只接受 127.0.0.1 / localhost。`,
      };
    }

    const origin = req.headers.origin;
    if (origin !== undefined && !this.isAllowedOrigin(origin)) {
      return {
        ok: false,
        status: 403,
        message: `跨源请求被拒绝：${origin}。外部网页不得调用本地 API（§22.6）。`,
      };
    }

    /**
     * 【定】静态壳不校验 Token（`requireToken: false`），来源校验照旧。
     * 理由写在 `server.ts` 的调用点上 —— 它是实测翻车之后改的，
     * 不是一开始就这么设计的，那段过程比结论更值得留着。
     */
    if (!opts.requireToken) return { ok: true };

    /**
     * Token 两种带法：
     *   · `Authorization: Bearer <token>` —— 普通 API 调用；
     *   · `?t=<token>` —— SSE 与首屏。**`EventSource` 设不了请求头**，
     *     这是它唯一的出路。
     *
     * 【定】不接受 Cookie。Cookie 会被浏览器自动附带，那正是 CSRF 的载体 ——
     * 而我们刚在上面把跨源挡掉，没必要再开一扇会自动填钥匙的门。
     */
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const query = url.searchParams.get("t") ?? "";
    const supplied = bearer || query;
    if (!supplied || !this.tokenMatches(supplied)) {
      return { ok: false, status: 401, message: "缺少或错误的会话 Token。" };
    }
    return { ok: true };
  }

  /** 【定】定长比较。token 比较用 `===` 会泄露前缀匹配长度。 */
  private tokenMatches(supplied: string): boolean {
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private isLoopbackHost(host: string): boolean {
    const p = this.port();
    return (
      host === `127.0.0.1:${p}` ||
      host === `localhost:${p}` ||
      host === `[::1]:${p}`
    );
  }

  private isAllowedOrigin(origin: string): boolean {
    const p = this.port();
    return (
      origin === `http://127.0.0.1:${p}` ||
      origin === `http://localhost:${p}` ||
      origin === `http://[::1]:${p}`
    );
  }
}

/**
 * 每个响应都带的安全头。
 *
 * `Content-Security-Policy` 是**第二道**：界面渲染的是模型产出的文本，
 * 万一哪天有人把 `textContent` 写成 `innerHTML`（边界 grep 第 10 条抓的那件事），
 * CSP 至少能挡住注入脚本发起外连。
 *
 * 【定】两道都要有。第一道（不用 innerHTML）是正确性，第二道是兜底 ——
 * 「一条闸门排在另一条后面等于没有闸门」说的是**串联**的两道；
 * 这两道是**并联**的，各自独立生效。
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // 【定】不发 Access-Control-Allow-Origin。没有 CORS 头 = 浏览器不会把
  // 跨源响应交给发起方，这是 Origin 校验之外的第三层。
};
