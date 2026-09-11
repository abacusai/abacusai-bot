import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { updaterPaths } from "./paths.ts";
import type { UpdaterPaths } from "./paths.ts";

/** Read-only HTTP service for a pre-published TUF repository. */

const resolveFile = async (
  directory: string,
  requested: string
): Promise<string | undefined> => {
  const root = path.resolve(directory);
  const candidate = path.resolve(root, `.${path.posix.sep}${requested}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return undefined;
  }
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
};

const respondFile = (
  response: http.ServerResponse,
  file: string,
  immutable: boolean
): void => {
  response.writeHead(200, {
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "content-security-policy": "default-src 'none'",
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(response);
};

export const createServer = (paths: UpdaterPaths): http.Server =>
  http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      let requested: string;
      try {
        requested = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (requested === "/health") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (requested.startsWith("/metadata/")) {
        const relative = requested.slice("/metadata/".length);
        const file = await resolveFile(paths.metadata, relative);
        if (file === undefined) {
          response.writeHead(404).end();
          return;
        }
        respondFile(response, file, relative !== "timestamp.json");
        return;
      }
      if (requested.startsWith("/targets/")) {
        const file = await resolveFile(
          paths.targets,
          requested.slice("/targets/".length)
        );
        if (file === undefined) {
          response.writeHead(404).end();
          return;
        }
        respondFile(response, file, true);
        return;
      }
      response.writeHead(404).end();
    })();
  });

export const serve = (paths = updaterPaths()): http.Server => {
  const host = process.env["ABACUSAI_BOT_UPDATE_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["ABACUSAI_BOT_UPDATE_PORT"] ?? "4321");
  const server = createServer(paths);
  server.listen(port, host, () => {
    console.log(`Serving the update repository on http://${host}:${port}`);
  });
  return server;
};

if (/server\.(?:m?ts|m?js)$/u.test(process.argv[1] ?? "")) {
  const paths = updaterPaths();
  try {
    await fs.access(paths.bootstrapRoot);
  } catch {
    throw new Error("The update repository has not been published");
  }
  serve(paths);
}
