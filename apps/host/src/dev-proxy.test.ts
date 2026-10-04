import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it("exposes file metadata through the dev preview proxy", async () => {
  const home = await mkdtemp(join(tmpdir(), "host-proxy-test-"));
  const upstream = createServer((_request, response) => {
    response
      .writeHead(206, {
        "content-length": "1",
        "content-range": "bytes 0-0/10",
        "x-file-size": "10",
      })
      .end("a");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve)
  );
  await writeFile(join(home, "secret"), "test-secret");
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve)
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../scripts/dev-proxy.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        TMPDIR: home,
        ABACUSAI_BOT_HOST_SECRET_FILE: join(home, "secret"),
        HOST_PROXY_PORT: String(port),
        HOST_PROXY_TARGET: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`proxy exited: ${code}`)));
    });
    const request = (origin: string, method = "GET") =>
      new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const req = get(
          `https://127.0.0.1:${port}/files`,
          {
            rejectUnauthorized: false,
            method,
            headers: { Host: "local.preview.apps.abacus.ai", Origin: origin },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response));
          }
        );
        req.once("error", reject);
      });
    for (const method of ["GET", "OPTIONS"]) {
      const response = await request("https://apps.abacus.ai", method);
      expect(response.statusCode).toBe(method === "GET" ? 206 : 204);
      expect(response.headers["access-control-expose-headers"]).toBe(
        "Content-Length, Content-Range, X-File-Size"
      );
      if (method === "GET") {
        expect(response.headers["content-length"]).toBe("1");
        expect(response.headers["content-range"]).toBe("bytes 0-0/10");
        expect(response.headers["x-file-size"]).toBe("10");
      }
    }
    const foreign = await request("https://example.com");
    expect(foreign.headers["access-control-expose-headers"]).toBeUndefined();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
