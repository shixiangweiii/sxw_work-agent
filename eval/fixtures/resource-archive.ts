/**
 * 冻结的合成 Resource 归档 Case。
 *
 * 所有 HTTP 响应来自注入传输，不访问网络。页面、正文、二进制与真值都在本文件，
 * 因而模型、Runtime 和 grader 没有任何一方能通过实时站点变化解释偏差。
 */

import type { FetchTransport } from "@workagent/tools-common";

const ORIGIN = "https://8.8.8.8";

export const RESOURCE_ARCHIVE_TASK =
  `读取 ${ORIGIN}/collection/1 和 ${ORIGIN}/collection/2 两页列出的全部文档，` +
  "把每份文档及其链接的二进制素材原样保存到 archive/；文档放根目录，素材放 archive/assets/，" +
  "保持文档内相对链接可解析，不新增其他文件。";

export const RESOURCE_ARCHIVE_TEXT: Readonly<Record<string, string>> = {
  "alpha.md": [
    "# Alpha",
    "",
    "Alpha 的第一段保持原样。".repeat(30),
    "",
    "![alpha](assets/pixel-alpha.png)",
    "",
  ].join("\n"),
  "beta.md": [
    "# Beta",
    "",
    "Beta 包含 UTF-8：上海、東京、😀。".repeat(30),
    "",
  ].join("\n"),
  "gamma.md": [
    "# Gamma",
    "",
    "Gamma 的行序与标点必须保持。".repeat(30),
    "",
    "![gamma](assets/pixel-gamma.png)",
    "",
  ].join("\n"),
  "delta.md": [
    "# Delta",
    "",
    "Delta 最后一行之前有一整段合成正文。".repeat(30),
    "",
  ].join("\n"),
};

export const RESOURCE_ARCHIVE_BINARY: Readonly<Record<string, Uint8Array>> = {
  "pixel-alpha.png": new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
  ]),
  "pixel-gamma.png": new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8,
  ]),
};

const pages: Record<string, { body: string | Uint8Array; mediaType: string }> = {
  [`${ORIGIN}/collection/1`]: {
    mediaType: "text/html; charset=utf-8",
    body:
      `<nav>synthetic navigation</nav>` +
      `<a href="${ORIGIN}/docs/alpha.md">Alpha</a>` +
      `<a href="${ORIGIN}/docs/beta.md">Beta</a>`,
  },
  [`${ORIGIN}/collection/2`]: {
    mediaType: "text/html; charset=utf-8",
    body:
      `<a href="${ORIGIN}/docs/gamma.md">Gamma</a>` +
      `<a href="${ORIGIN}/docs/delta.md">Delta</a>`,
  },
  ...Object.fromEntries(
    Object.entries(RESOURCE_ARCHIVE_TEXT).map(([name, body]) => [
      `${ORIGIN}/docs/${name}`,
      { body, mediaType: "text/markdown; charset=utf-8" },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(RESOURCE_ARCHIVE_BINARY).map(([name, body]) => [
      `${ORIGIN}/assets/${name}`,
      { body, mediaType: "image/png" },
    ]),
  ),
};

export const RESOURCE_ARCHIVE_URLS = {
  listings: [`${ORIGIN}/collection/1`, `${ORIGIN}/collection/2`],
  documents: Object.keys(RESOURCE_ARCHIVE_TEXT).map((name) => `${ORIGIN}/docs/${name}`),
  binaries: Object.keys(RESOURCE_ARCHIVE_BINARY).map((name) => `${ORIGIN}/assets/${name}`),
};

export const fakeResourceArchiveFetch: FetchTransport = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  const entry = pages[url];
  if (!entry) {
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }
  return new Response(entry.body, {
    status: 200,
    headers: { "content-type": entry.mediaType },
  });
};
