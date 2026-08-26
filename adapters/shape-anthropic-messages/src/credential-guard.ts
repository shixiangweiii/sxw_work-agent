/**
 * 凭证边界断言（V05 §22.3）。
 *
 * 【定】凭证只能发往它所属 Endpoint 的 baseUrl。
 *
 * 这条不是注意事项，是不变量 —— Spike 0 期间被实际违反过一次：
 * shell 里 export 过 ANTHROPIC_BASE_URL=https://api.anthropic.com，
 * 而 dotenv 默认不覆盖已存在的环境变量，于是第三方 Key 被发往了官方端点。
 * 401 拒绝了，但凭证已经离开它该在的边界。
 *
 * 因此这里做的是「启动前拒绝运行」，不是「出错后记录」。
 */

const OFFICIAL_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
] as const;

export interface CredentialBoundaryCheck {
  baseUrl: string;
  apiKey: string;
  /** 端点声明里记的 endpointId，用于错误信息定位。 */
  endpointId: string;
}

export function assertCredentialGoesWhereIntended(c: CredentialBoundaryCheck): void {
  if (!c.apiKey) {
    throw new Error(`端点 ${c.endpointId} 没有可用凭证。检查 .env 是否被正确加载。`);
  }
  if (!c.baseUrl) {
    throw new Error(`端点 ${c.endpointId} 没有配置 baseUrl。拒绝使用 SDK 默认值 —— 默认值指向官方端点。`);
  }

  let host: string;
  try {
    host = new URL(c.baseUrl).host;
  } catch {
    throw new Error(`端点 ${c.endpointId} 的 baseUrl 不是合法 URL：${c.baseUrl}`);
  }

  const isOfficial = OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const looksLikeOfficialKey = /^sk-ant-/.test(c.apiKey) || /^sk-proj-/.test(c.apiKey);

  /**
   * U-7：反方向也要挡 —— **官方 key 发往第三方代理**。
   *
   * 原实现只有「第三方 key → 官方 host」一个方向。两个方向的危害不对称，
   * 但都真实：
   *   · 第三方 key → 官方端点：请求失败，浪费一次调用，**key 泄漏给了官方**；
   *   · 官方 key → 第三方代理：请求可能**成功**，而你的 Anthropic key
   *     完整地交给了一个第三方 —— 这个方向更安静，也更贵。
   *
   * 「更安静」正是它必须被挡的理由：失败会自己叫，成功不会。
   */
  if (!isOfficial && looksLikeOfficialKey) {
    throw new Error(
      `拒绝运行：baseUrl 指向第三方端点 ${host}，但持有的是官方形态的凭证（${maskKey(c.apiKey)}）。\n` +
        `这个方向不会报错 —— 请求可能照常成功，而你的官方 key 已经完整地交给了第三方。\n` +
        `检查 .env 里 ${c.endpointId} 那一组的 api_key 是不是填错了。`,
    );
  }

  if (isOfficial && !looksLikeOfficialKey) {
    throw new Error(
      `拒绝运行：baseUrl 指向官方端点 ${host}，但持有的是第三方凭证。\n` +
        `这正是 Spike 0 期间真实发生过的凭证越界 —— 通常成因是 shell 里 export 了 ` +
        `ANTHROPIC_BASE_URL / OPENAI_BASE_URL，覆盖了 .env 的配置。\n` +
        `检查：env | grep -i base_url`,
    );
  }
}

/** 打日志时用。永远不要打印完整 key。 */
export function maskKey(apiKey: string): string {
  if (apiKey.length <= 12) return "****";
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}
