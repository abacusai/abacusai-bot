/**
 * A local stand-in for https://ui.shadcn.com (spec 01 §5.4). The shadcn CLI
 * fetches registry items from `REGISTRY_URL` (and derives its other URLs from
 * it), so pointing that at this server pins what `init` and `add` see:
 *
 * - `record`: every request is forwarded upstream and the response stored
 *   under `<dir>/files/`, with `<dir>/manifest.json` listing `{ path, sha256 }`.
 * - `replay`: offline; only recorded responses are served. An unrecorded
 *   request is a 404 and is reported, so a snapshot that is missing an item
 *   fails loudly instead of silently reaching the network.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

export const UPSTREAM = "https://ui.shadcn.com";

/**
 * Run a command without blocking this process's event loop (the proxy lives
 * in it). Resolves stdout when `capture` is set; rejects on a non-zero exit.
 */
export const run = (command, args, { cwd, env, capture = false }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))
    );
  });

/** A request path (with query) as a stable file name. */
const fileFor = (path) => {
  const url = new URL(path, "http://x");
  const safe = `${url.pathname}${url.search}`
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._/-]/g, "_");
  return safe.endsWith(".json") ? safe : `${safe}.body`;
};

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export const readManifest = (dir) => {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return { cli: null, entries: [] };
  return JSON.parse(readFileSync(path, "utf8"));
};

/**
 * Start the proxy. Resolves `{ url, close(), misses }`, where `url` is the
 * value for `REGISTRY_URL` (ends in `/r`).
 */
export const startRegistryProxy = async ({ mode, dir, cli }) => {
  const manifest = readManifest(dir);
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const misses = [];

  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    try {
      if (mode === "replay") {
        const entry = byPath.get(path);
        if (entry == null) {
          misses.push(path);
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: `not in snapshot: ${path}` }));
          return;
        }
        const body = readFileSync(join(dir, "files", entry.file));
        if (sha256(body) !== entry.sha256)
          throw new Error(`snapshot file changed on disk: ${entry.file}`);
        response.writeHead(entry.status, {
          "content-type": entry.contentType,
        });
        response.end(body);
        return;
      }

      const upstream = await fetch(new URL(path, UPSTREAM), {
        headers: { accept: request.headers.accept ?? "*/*" },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      const contentType =
        upstream.headers.get("content-type") ?? "application/json";
      const file = fileFor(path);
      mkdirSync(dirname(join(dir, "files", file)), { recursive: true });
      writeFileSync(join(dir, "files", file), body);
      byPath.set(path, {
        path,
        file,
        status: upstream.status,
        contentType,
        sha256: sha256(body),
      });
      response.writeHead(upstream.status, { "content-type": contentType });
      response.end(body);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/r`,
    misses,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      if (mode === "record") {
        mkdirSync(dir, { recursive: true });
        const entries = [...byPath.values()].sort((a, b) =>
          a.path.localeCompare(b.path)
        );
        writeFileSync(
          join(dir, "manifest.json"),
          `${JSON.stringify({ cli, entries }, null, 2)}\n`
        );
      }
    },
  };
};
