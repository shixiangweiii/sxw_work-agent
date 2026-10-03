/**
 * Swift 助手的客户端（ADR-0013）：经 LaunchServices 启动助手 .app，用 Unix socket
 * 收发 JSON 行。
 *
 * 【定】懒启动：第一次真的要用时才拉起助手。`compose()` 因此保持同步，
 * 没用到 GUI 的 Run 也不会凭空起一个持有系统授权的进程。
 *
 * 【定】socket 放在 `mkdtemp` 出来的私有目录（0700）里，助手只接受本进程的连接
 * （LOCAL_PEERPID 校验），本进程退出它就退出 —— 见助手源码的文件头。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CaptureRequest,
  CaptureResult,
  ComputerDriver,
  DriverAction,
  DriverActionResult,
  DriverPermissions,
  ElementInfo,
  ProbeRequest,
  ProbeResult,
  ResolvedApp,
  WindowInfo,
} from "./driver.js";

export interface HelperDriverOptions {
  appPath: string;
  /** 等助手起来的上限（ms）。默认 15s。 */
  startTimeoutMs?: number;
  /** 单个请求的上限（ms）。默认 30s。 */
  requestTimeoutMs?: number;
  /** 助手日志写到哪（诊断用）。不给就写在私有目录里。 */
  logPath?: string;
  /**
   * 怎么把助手拉起来、让它在 `socketPath` 上监听。不给 = 经 LaunchServices 启动真助手
   * （`open -n -g -a`，独立的 TCC 身份）。`verify:computer` 用它换成一个 node 写的假助手，
   * 测重连那条路径（CU-R07）—— 不截真屏、不弹授权。
   */
  launch?: (socketPath: string, logPath: string) => Promise<void>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HelperDriver implements ComputerDriver {
  private socket: Socket | undefined;
  private starting: Promise<void> | undefined;
  private dir: string | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly opts: HelperDriverOptions) {}

  /** 助手日志的位置（doctor 打印用）。 */
  get logFile(): string | undefined {
    return this.opts.logPath ?? (this.dir ? join(this.dir, "helper.log") : undefined);
  }

  async permissions(): Promise<DriverPermissions> {
    return this.call<DriverPermissions>("permissions");
  }

  /** 触发系统授权提示（只由 doctor 在用户显式要求时调用）。 */
  async requestPermissions(): Promise<DriverPermissions> {
    return this.call<DriverPermissions>("requestPermissions");
  }

  async resolveApps(queries: string[]): Promise<ResolvedApp[]> {
    return this.call<ResolvedApp[]>("resolveApps", { queries });
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    const r = await this.call<Omit<CaptureResult, "png"> & { png: string }>("capture", req);
    return { ...r, png: new Uint8Array(Buffer.from(r.png, "base64")) };
  }

  async probe(req: ProbeRequest): Promise<ProbeResult> {
    return this.call<ProbeResult>("probe", req);
  }

  async describe(x: number, y: number): Promise<{ window: WindowInfo | null; element: ElementInfo | null }> {
    return this.call("describe", { x, y });
  }

  async perform(action: DriverAction, guard: { allowBundleIds: string[]; allowBrowsers?: boolean }): Promise<DriverActionResult> {
    return this.call<DriverActionResult>("perform", {
      action,
      allowBundleIds: guard.allowBundleIds,
      allowBrowsers: guard.allowBrowsers === true,
    });
  }

  async close(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.call("quit", {}, 2_000);
      } catch {
        // 助手已经不在了也无妨：本进程一退出它的看门狗也会让它退出。
      }
      this.socket.destroy();
    }
    this.socket = undefined;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }

  // ─────────────────────────────────────────────────────────── 内部

  private async call<T>(op: string, params: object = {}, timeoutMs?: number): Promise<T> {
    await this.ensure();
    const id = this.nextId++;
    const socket = this.socket!;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`GUI 助手请求 ${op} 超时`));
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.write(JSON.stringify({ id, op, params }) + "\n");
    });
  }

  private ensure(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!existsSync(this.opts.appPath)) {
      throw new Error(`找不到 Atlas GUI Helper：${this.opts.appPath}。先运行 npm run computer:build。`);
    }
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), "atlas-gui-"));
    const sock = join(this.dir, "h.sock");
    const log = this.opts.logPath ?? join(this.dir, "helper.log");
    rmSync(sock, { force: true });
    await (this.opts.launch ?? this.launchApp)(sock, log);
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 15_000);
    while (!existsSync(sock)) {
      if (Date.now() > deadline) throw new Error(`Atlas GUI Helper 没有在限定时间内就绪（日志：${log}）`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise<void>((resolve, reject) => {
      const s = createConnection(sock);
      s.setEncoding("utf8");
      /**
       * 【定】接收缓冲**跟着连接走**，一条连接一份（2026-10-03 代码评审 CU-R07）。
       * 它此前是实例字段，断线时 `pending` 清了、缓冲没清：助手在传一张大截图的中途退出，
       * 半条 JSON 留在缓冲里，与重连后的第一条完整响应拼成一行 → 解析失败 → 整行丢弃 →
       * 那个请求白等 30 秒超时。放在闭包里，两代连接的字节在结构上就不可能拼到一起，
       * 而不是靠「记得在某处清空」。
       */
      const conn = { buffer: "" };
      s.once("connect", () => {
        this.socket = s;
        resolve();
      });
      s.once("error", (e) => reject(new Error(`连不上 Atlas GUI Helper：${e.message}`)));
      s.on("data", (chunk: string) => this.onData(conn, chunk));
      s.on("close", () => {
        // 已经换上新连接时，在途请求属于新连接 —— 旧连接迟到的 close 不得把它们一起判死。
        if (this.socket !== undefined && this.socket !== s) return;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("GUI 助手连接断开"));
        }
        this.pending.clear();
        if (this.socket === s) this.socket = undefined;
      });
    });
  }

  private readonly launchApp = (sock: string, log: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      execFile(
        "open",
        ["-n", "-g", "-a", this.opts.appPath, "--args", "--socket", sock, "--client-pid", String(process.pid), "--log", log],
        (err) => (err ? reject(new Error(`启动 Atlas GUI Helper 失败：${err.message}`)) : resolve()),
      );
    });

  private onData(conn: { buffer: string }, chunk: string): void {
    conn.buffer += chunk;
    let nl: number;
    while ((nl = conn.buffer.indexOf("\n")) >= 0) {
      const line = conn.buffer.slice(0, nl);
      conn.buffer = conn.buffer.slice(nl + 1);
      let msg: { id?: number; ok?: boolean; result?: unknown; code?: string; message?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(`${msg.code ?? "ERROR"}: ${msg.message ?? "GUI 助手报错"}`));
    }
  }
}
