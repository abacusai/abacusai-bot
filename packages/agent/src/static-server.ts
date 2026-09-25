/**
 * Serving a directory the agent just wrote, held open by this process. `bash`
 * cannot hold a server: pi runs a command to completion under a timeout, so
 * `npx live-server` dies a moment after it prints its URL. A copy of the
 * desktop's agent-tools/static-server.ts (this package cannot reach the app's
 * tree); behaviour must stay identical, the path traversal guard above all.
 */
import fs from "fs/promises";
import http from "http";
import net from "net";
import path from "path";

export type ServedDirectory = { directory: string; url: string; port: number };

/** Servers this process started, so they can be listed, stopped and cleaned up. */
const running = new Map<string, ServedDirectory & { server: http.Server }>();

/**
 * Starts in flight, claimed before the first await, so two concurrent serves
 * of one directory cannot both bind and orphan the first server's port.
 */
const starting = new Map<string, Promise<ServedDirectory>>();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const freePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address != null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

/**
 * Where a request lands on disk, or null if it escapes the served directory.
 * `..` in a URL is the whole threat model: loopback-bound, but a page in the
 * preview can still ask for anything.
 */
const resolveRequest = (root: string, rawUrl: string): string | null => {
  const requested = decodeURIComponent(
    new URL(rawUrl, "http://127.0.0.1").pathname
  );
  const target = path.resolve(root, `.${requested}`);

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;

  return target;
};

const send = (
  response: http.ServerResponse,
  status: number,
  body: string | Buffer,
  type: string
): void => {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  response.end(body);
};

/** The HTML pages directly inside `directory`, sorted, `index.html` first. */
export const htmlPagesIn = async (directory: string): Promise<string[]> => {
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) =>
      a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)
    );
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * What a directory URL resolves to: its index, else its only page, else a
 * listing of its pages so the user (and the agent reading the preview) can
 * pick one instead of meeting a dead end.
 */
const directoryEntry = async (
  directory: string,
  rawUrl: string
): Promise<string | { listing: string }> => {
  const pages = await htmlPagesIn(directory);
  if (pages[0] === "index.html" || pages.length === 1)
    return path.join(directory, pages[0] ?? "index.html");
  const base = new URL(rawUrl, "http://127.0.0.1").pathname.replace(
    /\/?$/,
    "/"
  );
  const items = pages
    .map(
      (page) =>
        `<li><a href="${escapeHtml(base + encodeURIComponent(page))}">${escapeHtml(page)}</a></li>`
    )
    .join("");
  return {
    listing: `<!doctype html><meta charset="utf-8"><title>${escapeHtml(path.basename(directory))}</title><body style="font:14px system-ui;padding:24px"><h1 style="font-size:16px">${escapeHtml(path.basename(directory))}</h1><ul>${items || "<li>No pages here.</li>"}</ul></body>`,
  };
};

const handle = async (
  root: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> => {
  const resolved = resolveRequest(root, request.url ?? "/");

  if (resolved == null)
    return send(response, 403, "Forbidden", "text/plain; charset=utf-8");

  // A directory serves its index, else the one page it has: a folder the agent
  // wrote holds `love.html` far more often than `index.html`.
  const stat = await fs.stat(resolved).catch(() => null);
  const file =
    stat?.isDirectory() === true
      ? await directoryEntry(resolved, request.url ?? "/")
      : resolved;
  if (typeof file !== "string")
    return send(response, 200, file.listing, "text/html; charset=utf-8");
  const contents = await fs.readFile(file).catch(() => null);

  if (contents == null)
    return send(response, 404, "Not found", "text/plain; charset=utf-8");

  send(
    response,
    200,
    contents,
    MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream"
  );
};

/** Starts a server for `directory`, or returns the one already serving it. */
export const serveDirectory = async (
  directory: string
): Promise<ServedDirectory> => {
  const root = path.resolve(directory);
  const existing = running.get(root);

  if (existing != null)
    return { directory: root, url: existing.url, port: existing.port };

  const pending = starting.get(root);

  if (pending != null) return pending;

  const start = startDirectory(root);

  starting.set(root, start);

  try {
    return await start;
  } finally {
    starting.delete(root);
  }
};

const startDirectory = async (root: string): Promise<ServedDirectory> => {
  const stat = await fs.stat(root).catch(() => null);
  if (stat?.isDirectory() !== true)
    throw new Error(`${root} is not a directory.`);

  const entries = await fs.readdir(root).catch(() => [] as string[]);
  if (entries.length === 0)
    throw new Error(`${root} is empty. There is nothing to serve.`);

  const port = await freePort();
  const server = http.createServer((request, response) => {
    void handle(root, request, response).catch(() => {
      send(response, 500, "Server error", "text/plain; charset=utf-8");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const served = { directory: root, url: `http://127.0.0.1:${port}`, port };
  running.set(root, { ...served, server });

  return served;
};

export const stopDirectory = (directory: string): boolean => {
  const root = path.resolve(directory);
  const entry = running.get(root);

  if (entry == null) return false;

  entry.server.close();
  running.delete(root);

  return true;
};

export const listServed = (): ServedDirectory[] =>
  [...running.values()].map(({ directory, url, port }) => ({
    directory,
    url,
    port,
  }));

/**
 * Stop everything. A server outliving the app that started it holds its port
 * with nothing able to reach it.
 */
export const stopAllServed = (): void => {
  // The spread is the point: the body deletes from the collection being
  // iterated, so this snapshots the keys first.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const root of [...running.keys()]) stopDirectory(root);
};
