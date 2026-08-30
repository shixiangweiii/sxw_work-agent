/**
 * 私网与 localhost 拒绝（决 3 修订 2 · 护栏 2，防 SSRF）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它防的是决 3 那条链路的**后半段**：
 *
 *   读放开 → 读到敏感内容 → 外部网页正文注入 → 诱导 fetch_url(内网地址)
 *
 * 前半段由读黑名单挡（read-guard.ts），这里挡的是「把请求打进内网」——
 * 云环境的元数据服务（169.254.169.254）、本机监听的调试端口、
 * 内网的管理面板，都是这条路上的经典目标。
 *
 * ── 【定】必须做 DNS 解析后再判，不能只看字面 ──────────────────────────
 *
 * 只判 hostname 字符串的话，`http://localtest.me/`（一个公开域名，
 * A 记录指向 127.0.0.1）会直接过关。这类「指向内网的公开域名」是
 * SSRF 绕过的标准手法之一，而且不需要攻击者控制 DNS —— 现成的就有。
 *
 * 【定】重定向终点要再判一次。见 fetch-url.ts 里的第二次调用。
 * ══════════════════════════════════════════════════════════════════════
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type UrlGuardResult = { ok: true; url: URL } | { ok: false; why: string };

/** 字面量就能判掉的主机名。判它们不需要 DNS，先便宜地过一遍。 */
const DENIED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

export async function assertPublicUrl(raw: string): Promise<UrlGuardResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, why: "不是一个合法的 URL" };
  }

  /**
   * 【定】只允许 http / https。
   *
   * `file:` 会让 fetch 去读本地文件 —— 那等于给读黑名单开一个后门，
   * 而且是绕过 `read_file` 的那种。`data:` / `blob:` 同理没有意义。
   */
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, why: `只允许 http / https，收到 ${url.protocol}` };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (DENIED_HOSTNAMES.has(host)) {
    return { ok: false, why: `指向本机（${host}）` };
  }
  // `.local` 是 mDNS 的保留域，一律指向局域网。
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, why: `指向局域网保留域（${host}）` };
  }

  // 字面量 IP：直接判。
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, why: `是私网 / 回环 / 链路本地地址（${host}）` }
      : { ok: true, url };
  }

  /**
   * 域名：解析之后再判。
   *
   * 解析失败**不拒绝** —— 那是「连不上」，交给 fetch 去报一个诚实的
   * DNS 错误。在这里把它报成「安全拒绝」会误导排查方向。
   */
  try {
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) {
        return {
          ok: false,
          why:
            `域名 ${host} 解析到私网地址 ${a.address}。` +
            `「指向内网的公开域名」是 SSRF 的标准绕过手法，已拒绝。`,
        };
      }
    }
  } catch {
    /* 解析不了就让 fetch 去报 DNS 错误，这里不越俎代庖 */
  }

  return { ok: true, url };
}

/**
 * 回环 / 私网 / 链路本地 / 唯一本地地址。
 *
 * 覆盖 IPv4 与 IPv6 两族。`::ffff:127.0.0.1` 这种 IPv4-mapped 形式要
 * 单独摊平 —— 它看起来是 IPv6，实际打到的是 IPv4 回环。
 */
export function isPrivateAddress(addr: string): boolean {
  let a = addr.toLowerCase();

  /**
   * ── 【定】方括号必须先剥掉（2026-08-30 评审 P1 实测的绕过）───────────────
   *
   * `new URL("http://[::ffff:127.0.0.1]/x").hostname` 返回的是
   * **`[::ffff:7f00:1]`** —— 带方括号、且已被规范化成十六进制。
   * 原实现两处都对不上：正则要求点分十进制、`isIP()` 对带括号的串返回 0。
   * 于是它两条分支都不进，掉到最后的 IPv4 解析里 `split(".")` 得到长度 1，
   * 直接 `return false` —— **放行**。
   *
   * 实测（修复前）：`http://[::ffff:127.0.0.1]/x` 与 `http://[::ffff:7f00:1]/x`
   * 都被放行，能打到本机回环端口。
   */
  const bare = a.startsWith("[") && a.endsWith("]") ? a.slice(1, -1) : a;

  /**
   * IPv4-mapped IPv6，**两种写法都要认**：
   *   点分十进制 `::ffff:127.0.0.1`（用户可能这么写）
   *   十六进制   `::ffff:7f00:1`（URL 解析器规范化之后的样子）
   *
   * 【定】只认前者是本次绕过的直接成因 —— 而 URL 解析器**总是**产出后者。
   * 也就是说那条规则从来没有在真实链路上生效过。
   */
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mappedDotted) return isPrivateAddress(mappedDotted[1]!);

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    return isPrivateAddress(
      `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`,
    );
  }

  if (isIP(bare) === 6) {
    if (bare === "::1" || bare === "::") return true;
    // fc00::/7 唯一本地地址；fe80::/10 链路本地
    return bare.startsWith("fc") || bare.startsWith("fd") || bare.startsWith("fe8") ||
      bare.startsWith("fe9") || bare.startsWith("fea") || bare.startsWith("feb");
  }

  /**
   * 【定】到这里还认不出来的 IPv6 一律**拒绝**，不落到下面的 IPv4 解析。
   *
   * 下面那段用 `split(".")` 判 IPv4，对任何含冒号的串都会得到「不是 4 段」
   * 然后 `return false` —— 也就是**放行**。一个我们看不懂的 IPv6 形态
   * 落进一条默认放行的路径，正是这次绕过的形状。
   */
  if (bare.includes(":")) return true;
  a = bare;

  const p = a.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [x, y] = p as [number, number, number, number];

  if (x === 0) return true;                       // 0.0.0.0/8
  if (x === 10) return true;                      // 10.0.0.0/8
  if (x === 127) return true;                     // 回环
  if (x === 169 && y === 254) return true;        // 链路本地，含云元数据服务
  if (x === 172 && y >= 16 && y <= 31) return true; // 172.16.0.0/12
  if (x === 192 && y === 168) return true;        // 192.168.0.0/16
  if (x === 100 && y >= 64 && y <= 127) return true; // 运营商级 NAT
  if (x >= 224) return true;                      // 组播与保留段
  return false;
}
