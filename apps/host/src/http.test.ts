import { createHmac } from "node:crypto";
import { appendFileSync, truncateSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { WhisperModelService } from "#main/services/voice/whisper-model-service";

import { createNodeAppOperations } from "./app-operations";
import { createHostHttpServer } from "./http";
import { HostLease } from "./lease";
it("health reveals only readiness; uploads authenticate and save raw and multipart files without CORS", async () => {
  const home = await mkdtemp(join(tmpdir(), "host-http-"));
  const lease = new HostLease();
  const app = createNodeAppOperations(lease, {} as never);
  app.botHome = () => home;
  const identity = {
    owner: "o",
    org: "g",
    secret: "secret",
    origins: new Set(["https://apps.abacus.ai"]),
  };
  const payload = Buffer.from(
    JSON.stringify({ o: "o", g: "g", e: Math.floor(Date.now() / 1000) + 600 })
  ).toString("base64url");
  const token = `${payload}.${createHmac("sha256", identity.secret).update(payload).digest("hex")}`;
  const modelUrl =
    "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx";
  const fetchModel = vi.fn(
    async () => new Response(new Uint8Array(2 * 1024 * 1024))
  );
  const whisper = new WhisperModelService({
    modelDir: join(home, "models"),
    emitEvent: () => {},
    fetch: fetchModel,
  });
  const server = createHostHttpServer(
    identity,
    app,
    lease,
    (w, s) => (w === "w" && s === "s" ? home : null),
    whisper
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Origin: "https://apps.abacus.ai",
    "x-abacus-user-id": "o",
    Authorization: `Bearer ${token}`,
  };
  try {
    const health = await fetch(`${base}/healthz`);
    expect(Object.keys(await health.json()).sort()).toEqual(
      [
        "ok",
        "version",
        "contractVersion",
        "owner",
        "uptime",
        "busy",
        "lastActivityAt",
      ].sort()
    );
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
    expect(
      (await fetch(`${base}/upload`, { method: "POST", body: "refused" }))
        .status
    ).toBe(403);
    const body = new FormData();
    body.append("files", new Blob(["attachment"]), "../test.txt");
    const response = await fetch(
      `${base}/upload?workspaceId=w&sessionId=s&baseFolder=/ignored`,
      {
        method: "POST",
        headers,
        body,
      }
    );
    expect(response.status).toBe(200);
    const { paths } = (await response.json()) as { paths: string[] };
    expect(paths[0]).toContain(join(home, ".abacusai-bot", "temp"));
    expect(await readFile(paths[0], "utf8")).toBe("attachment");
    const writeHead = ServerResponse.prototype.writeHead;
    const grow = vi
      .spyOn(ServerResponse.prototype, "writeHead")
      .mockImplementation(function (this: ServerResponse, ...args: any[]) {
        if (args[1]?.["content-length"] === 10)
          appendFileSync(paths[0], "grew after stat");
        return (writeHead as Function).apply(this, args);
      });
    const download = await fetch(
      `${base}/files?hostRoot=${encodeURIComponent(home)}&path=${encodeURIComponent(paths[0])}`,
      { headers }
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-length")).toBe("10");
    expect(await download.text()).toBe("attachment");
    grow.mockRestore();
    await writeFile(paths[0], "attachment");
    const shrink = vi
      .spyOn(ServerResponse.prototype, "writeHead")
      .mockImplementation(function (this: ServerResponse, ...args: any[]) {
        if (args[1]?.["content-length"] === 10) truncateSync(paths[0], 5);
        return (writeHead as Function).apply(this, args);
      });
    await new Promise<void>((resolve, reject) => {
      const request = get(
        `${base}/files?${new URLSearchParams({ hostRoot: home, path: paths[0] })}`,
        { headers },
        (response) => {
          response.resume();
          response.once("end", () =>
            reject(new Error("short response ended cleanly"))
          );
          response.once("error", (error: NodeJS.ErrnoException) => {
            expect(error.code).toBe("ECONNRESET");
            expect(response.complete).toBe(false);
            resolve();
          });
        }
      );
      request.setTimeout(1000, () => {
        request.destroy();
        reject(new Error("short response did not abort promptly"));
      });
      request.once("error", (error: NodeJS.ErrnoException) => {
        // The server may destroy the socket before headers reach the client.
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
    });
    shrink.mockRestore();
    await writeFile(join(home, "empty"), "");
    const empty = await fetch(
      `${base}/files?${new URLSearchParams({ hostRoot: home, path: "empty" })}`,
      { headers }
    );
    expect(empty.headers.get("content-length")).toBe("0");
    expect(await empty.text()).toBe("");
    const modelPath = `/files?${new URLSearchParams({ whisperUrl: modelUrl })}`;
    expect((await fetch(`${base}${modelPath}`)).status).toBe(403);
    expect(fetchModel).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      const model = await fetch(`${base}${modelPath}`, { headers });
      expect(model.status).toBe(200);
      expect(model.headers.get("content-length")).toBe(String(2 * 1024 * 1024));
      expect((await model.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
    }
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(
      (
        await fetch(`${base}/files?whisperUrl=https://example.com/model`, {
          headers,
        })
      ).status
    ).toBe(403);
    expect(
      (await fetch(`${base}/files?hostRoot=${home}&path=${paths[0]}`)).status
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/upload?baseFolder=/tmp`, {
          method: "POST",
          headers,
          body: "x",
        })
      ).status
    ).toBe(400);
    const raw = await fetch(
      `${base}/upload?workspaceId=w&sessionId=s&name=raw.bin`,
      {
        method: "POST",
        headers,
        body: new Uint8Array(10 * 1024 * 1024),
      }
    );
    expect(raw.status).toBe(200);
    expect(
      (await readFile(((await raw.json()) as { paths: string[] }).paths[0]))
        .length
    ).toBe(10 * 1024 * 1024);
  } finally {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
