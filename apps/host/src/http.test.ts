import { createHmac } from "node:crypto";
import { appendFileSync, truncateSync } from "node:fs";
import fs from "node:fs/promises";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { get, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { HostedMcpSignIns } from "#main/services/mcp/mcp-oauth-service";
import { WhisperModelService } from "#main/services/voice/whisper-model-service";

import { createNodeAppOperations } from "./app-operations";
import { createHostHttpServer } from "./http";
import { HostLease } from "./lease";
it("health reveals only readiness; uploads authenticate and save raw and multipart files without CORS", async () => {
  const home = await mkdtemp(join(tmpdir(), "host-http-"));
  const lease = new HostLease(() => false);
  const app = createNodeAppOperations(lease);
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
    for (const maxBytes of [undefined, "8"]) {
      await writeFile(paths[0], "attachment");
      const shrink = vi
        .spyOn(ServerResponse.prototype, "writeHead")
        .mockImplementation(function (this: ServerResponse, ...args: any[]) {
          if ([10, 8].includes(args[1]?.["content-length"]))
            truncateSync(paths[0], 5);
          return (writeHead as Function).apply(this, args);
        });
      await new Promise<void>((resolve, reject) => {
        const request = get(
          `${base}/files?${new URLSearchParams({ hostRoot: home, path: paths[0], ...(maxBytes == null ? {} : { maxBytes }) })}`,
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
    }
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
    const uncachedHead = await fetch(`${base}${modelPath}`, {
      headers,
      method: "HEAD",
    });
    expect(uncachedHead.status).toBe(404);
    expect(await uncachedHead.text()).toBe("");
    expect(fetchModel).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      const model = await fetch(`${base}${modelPath}`, { headers });
      expect(model.status).toBe(200);
      expect(model.headers.get("content-length")).toBe(String(2 * 1024 * 1024));
      expect((await model.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
    }
    const cachedHead = await fetch(`${base}${modelPath}`, {
      headers,
      method: "HEAD",
    });
    expect(cachedHead.status).toBe(200);
    expect(cachedHead.headers.get("content-length")).toBe(
      String(2 * 1024 * 1024)
    );
    expect(await cachedHead.text()).toBe("");
    expect(fetchModel).toHaveBeenCalledTimes(1);
    const foreignModel = await fetch(
      `${base}/files?whisperUrl=https://example.com/model`,
      { headers }
    );
    expect(foreignModel.status).toBe(403);
    expect(await foreignModel.json()).toEqual({
      error: "forbidden",
      reason: "invalid-model-url",
    });
    const otherModel = `${base}/files?${new URLSearchParams({
      whisperUrl: modelUrl.replace("encoder", "decoder"),
    })}`;
    fetchModel.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const missingModel = await fetch(otherModel, { headers });
    expect(missingModel.status).toBe(404);
    expect(await missingModel.json()).toEqual({ error: "not-found" });
    fetchModel.mockRejectedValueOnce(
      new Error(`private download failure at ${home}`)
    );
    const failedModel = await fetch(otherModel, { headers });
    expect(failedModel.status).toBe(502);
    expect(await failedModel.json()).toEqual({
      error: "conflict",
      reason: "model-download-failed",
    });
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

it("serves typed file failures, HEAD, one-byte ranges and bounded previews", async () => {
  const home = await mkdtemp(join(tmpdir(), "host-files-"));
  const lease = new HostLease(() => false);
  const identity = {
    owner: "o",
    org: "g",
    secret: "secret",
    origins: new Set(["https://apps.abacus.ai"]),
  };
  const payload = Buffer.from(
    JSON.stringify({ o: "o", g: "g", e: Math.floor(Date.now() / 1000) + 600 })
  ).toString("base64url");
  const headers = {
    Origin: "https://apps.abacus.ai",
    "x-abacus-user-id": "o",
    Authorization: `Bearer ${payload}.${createHmac("sha256", identity.secret).update(payload).digest("hex")}`,
  };
  const server = createHostHttpServer(
    identity,
    createNodeAppOperations(lease),
    lease,
    () => null,
    { prepareFile: async () => ({ status: 404 }) }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = (path: string, maxBytes?: string) =>
    `${base}/files?${new URLSearchParams({ hostRoot: home, path, ...(maxBytes == null ? {} : { maxBytes }) })}`;
  try {
    await writeFile(join(home, "file.txt"), "attachment");
    await writeFile(join(home, "empty"), "");
    await symlink(tmpdir(), join(home, "escape"));
    const auth = await fetch(url("file.txt"));
    expect(auth.status).toBe(403);
    expect(await auth.json()).toEqual({ error: "forbidden" });
    for (const [path, status, body] of [
      ["missing", 404, { error: "not-found" }],
      ["escape", 403, { error: "forbidden", reason: "outside-root" }],
      [".", 409, { error: "conflict", reason: "not-a-file" }],
    ] as const) {
      const result = await fetch(url(path), { headers });
      expect(result.status).toBe(status);
      expect(await result.json()).toEqual(body);
      const head = await fetch(url(path), { headers, method: "HEAD" });
      expect(head.status).toBe(status);
      expect(await head.text()).toBe("");
    }
    for (const code of ["EACCES", "ELOOP"]) {
      const realpath = vi
        .spyOn(fs, "realpath")
        .mockRejectedValueOnce(
          Object.assign(new Error(`${code}: realpath '${home}'`), { code })
        );
      try {
        const result = await fetch(url("file.txt"), { headers });
        expect(result.status).toBe(409);
        expect(await result.json()).toEqual({
          error: "conflict",
          reason: "realpath-failed",
        });
      } finally {
        realpath.mockRestore();
      }
    }
    for (const [maxBytes, expected] of [
      [undefined, "attachment"],
      ["1", "a"],
      ["4", "atta"],
      ["0", ""],
      ["100", "attachment"],
    ] as const) {
      const result = await fetch(url("file.txt", maxBytes), { headers });
      expect(result.status).toBe(200);
      expect(result.headers.get("content-length")).toBe(
        String(expected.length)
      );
      expect(result.headers.get("x-file-size")).toBe("10");
      expect(await result.text()).toBe(expected);
      const head = await fetch(url("file.txt", maxBytes), {
        headers,
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(expected.length));
      expect(head.headers.get("x-file-size")).toBe("10");
      expect(await head.text()).toBe("");
    }
    for (const maxBytes of [undefined, "1", "4"]) {
      const result = await fetch(url("file.txt", maxBytes), {
        headers: { ...headers, Range: "bytes=0-0" },
      });
      expect(result.status).toBe(206);
      expect(result.headers.get("content-range")).toBe("bytes 0-0/10");
      expect(result.headers.get("content-length")).toBe("1");
      expect(result.headers.get("x-file-size")).toBe("10");
      expect(await result.text()).toBe("a");
    }
    const emptyRange = await fetch(url("empty"), {
      headers: { ...headers, Range: "bytes=0-0" },
    });
    expect(emptyRange.status).toBe(416);
    expect(emptyRange.headers.get("content-range")).toBe("bytes */0");
    expect(await emptyRange.text()).toBe("");
    for (const invalid of ["-1", "1.5", "", "Infinity", "9007199254740992"]) {
      const result = await fetch(url("file.txt", invalid), { headers });
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: "invalid-max-bytes" });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

it("MCP sign-in: a one-time start link, and a callback that stores the token once", async () => {
  const home = await mkdtemp(join(tmpdir(), "host-mcp-"));
  const previousHome = process.env.ABACUSAI_BOT_HOME;
  process.env.ABACUSAI_BOT_HOME = home;
  const lease = new HostLease(() => false);
  const identity = {
    owner: "o",
    org: "g",
    secret: "secret",
    origins: new Set(["https://apps.abacus.ai"]),
  };
  const serverUrl = "https://mcp.provider.test/mcp";
  const realFetch = globalThis.fetch;
  const tokenRequests: string[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      if (url === serverUrl)
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://mcp.provider.test/prm"`,
          },
        });
      if (url === "https://mcp.provider.test/prm")
        return Response.json({
          authorization_servers: ["https://auth.provider.test"],
        });
      if (
        url ===
        "https://auth.provider.test/.well-known/oauth-authorization-server"
      )
        return Response.json({
          issuer: "https://auth.provider.test",
          authorization_endpoint: "https://auth.provider.test/authorize",
          token_endpoint: "https://auth.provider.test/token",
          registration_endpoint: "https://auth.provider.test/register",
          code_challenge_methods_supported: ["S256"],
        });
      if (url === "https://auth.provider.test/register")
        return Response.json({ client_id: "client-1" });
      if (url === "https://auth.provider.test/token") {
        tokenRequests.push(String(init?.body));
        return Response.json({ access_token: "token-1", expires_in: 3600 });
      }
      return new Response("", { status: 404 });
    });
  let now = Date.now();
  const signedIn = vi.fn();
  const redirectUri = "https://apps.abacus.ai/api/botHost/h1/mcp/callback";
  const signIns = new HostedMcpSignIns({
    redirectUri,
    signedIn,
    now: () => now,
  });
  const server = createHostHttpServer(
    identity,
    createNodeAppOperations(lease),
    lease,
    () => null,
    { prepareFile: async () => ({ status: 404, path: null }) } as never,
    signIns
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = { "x-abacus-user-id": "o" };
  const get = (path: string, headers: Record<string, string> = owner) =>
    fetch(`${base}${path}`, { headers, redirect: "manual" });
  const begin = () =>
    signIns.begin({ name: "notion", label: "Notion", serverUrl });
  try {
    const { id } = await begin();
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await get(`/mcp/start/${id}`, {})).status).toBe(403);
    const started = await get(`/mcp/start/${id}`);
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://auth.provider.test/authorize"
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorize.searchParams.get("client_id")).toBe("client-1");
    const state = authorize.searchParams.get("state")!;
    expect((await get(`/mcp/start/${id}`)).status).toBe(410);
    expect((await get("/mcp/start/AAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);

    const unknown = await get("/mcp/callback?code=c&state=nope");
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).not.toContain("is connected");
    expect(tokenRequests).toHaveLength(0);

    const done = await get(
      `/mcp/callback?code=the-code&state=${encodeURIComponent(state)}`
    );
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Notion is connected.");
    expect(new URLSearchParams(tokenRequests[0]).get("redirect_uri")).toBe(
      redirectUri
    );
    expect(signedIn).toHaveBeenCalledWith("notion");
    const stored = JSON.parse(
      await readFile(join(home, "mcp-auth.json"), "utf8")
    );
    expect(stored.servers[serverUrl].accessToken).toBe("token-1");

    const reused = await get(
      `/mcp/callback?code=the-code&state=${encodeURIComponent(state)}`
    );
    expect(reused.status).toBe(400);
    expect(tokenRequests).toHaveLength(1);

    // A provider refusal's own text never reaches the page.
    const refused = await begin();
    const refusedState = new URL(
      (await get(`/mcp/start/${refused.id}`)).headers.get("location")!
    ).searchParams.get("state")!;
    const refusal = await get(
      `/mcp/callback?error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}&state=${refusedState}`
    );
    expect(refusal.status).toBe(400);
    expect(await refusal.text()).not.toContain("<script>");
    expect(tokenRequests).toHaveLength(1);

    const late = await begin();
    now += 31 * 60_000;
    expect((await get(`/mcp/start/${late.id}`)).status).toBe(410);
  } finally {
    fetchSpy.mockRestore();
    if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
    else process.env.ABACUSAI_BOT_HOME = previousHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
