import { createHmac } from "node:crypto";
import { appendFileSync, truncateSync } from "node:fs";
import fs from "node:fs/promises";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { type ClientRequest, get, request, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerEntry } from "@abacus-ai/contract/contracts";
import { expect, it, vi } from "vitest";

import { ConnectorFlowService } from "#main/services/connectors/connector-flow-service";
import { HostedMcpConnect } from "#main/services/mcp/hosted-mcp-connect";
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

it("MCP connect: a side-effect-free confirm page, then a one-time POST that installs and signs in", async () => {
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
  const serverUrl = "https://mcp.notion.com/mcp";
  const realFetch = globalThis.fetch;
  const tokenRequests: string[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      // A server of the user's own that asks for no sign-in.
      if (url === "https://open.example/mcp") return Response.json({});
      if (url === serverUrl) await registering;
      if (url === serverUrl)
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://mcp.notion.com/prm"`,
          },
        });
      if (url === "https://mcp.notion.com/prm")
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
  // Discovery can be held mid-flight, to cancel under it.
  let registering: Promise<void> = Promise.resolve();
  const signedIn = vi.fn();
  const failed = vi.fn();
  const watch = vi.fn();
  const entries = new Map<string, McpServerEntry>([
    ["mine", { url: "https://open.example/mcp" }],
  ]);
  const add = vi.fn((name: string, entry: McpServerEntry) => {
    entries.set(name, entry);
    return { success: true };
  });
  const hostBase = "https://apps.abacus.ai/api/botHost/h1";
  let hosted: HostedMcpConnect;
  const flow = new ConnectorFlowService({
    platform: {
      connect: () => ({ ok: true }),
      disconnect: async () => ({ ok: true }),
      watch: () => {},
    },
    mcp: {
      entry: (name) => entries.get(name),
      add,
      remove: () => ({ success: true }),
      signIn: async (name) =>
        hosted.begin({
          name,
          label: flow.mcpLabel(name)!,
          serverUrl: entries.get(name)!.url!,
        }),
      connectUrl: (name) => hosted.connectUrl(name),
      watch,
    },
    homeDir: () => home,
  });
  hosted = new HostedMcpConnect({
    base: hostBase,
    label: (name) => flow.mcpLabel(name),
    connect: (name) => flow.connectMcp(name),
    signedIn,
    failed,
    now: () => now,
  });
  const server = createHostHttpServer(
    identity,
    createNodeAppOperations(lease),
    lease,
    () => null,
    { prepareFile: async () => ({ status: 404, path: null }) } as never,
    hosted,
    { bytes: 64, timeoutMs: 300, now: () => now }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // A top-level page load from the confirm page, as a browser sends it.
  const owner = {
    "x-abacus-user-id": "o",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
  };
  /** The proxy's proof, as it signs it (spec 08, D8). */
  const proof = (
    method: string,
    path: string,
    { who = "o", ts = Math.floor(now / 1000), secret = identity.secret } = {}
  ) =>
    `${ts}.${createHmac("sha256", secret)
      .update(`mcp\n${method}\n${path.split("?")[0]}\n${who}\n${ts}`)
      .digest("hex")}`;
  /** Signed unless the headers bring their own proof ("" sends none). */
  const signed = (
    method: string,
    path: string,
    headers: Record<string, string>
  ): Record<string, string> => {
    const { "x-abacus-host-proof": own, ...rest } = headers;
    const value = own ?? proof(method, path);
    return value === "" ? rest : { ...rest, "x-abacus-host-proof": value };
  };
  const get = (path: string, headers: Record<string, string> = owner) =>
    fetch(`${base}${path}`, {
      headers: signed("GET", path, headers),
      redirect: "manual",
    });
  const post = (
    path: string,
    token: string,
    headers: Record<string, string> = owner
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        ...signed("POST", path, headers),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
      redirect: "manual",
    });
  /** The confirm page, and the token its button posts. */
  const confirm = async (path: string, headers = owner) => {
    const page = await get(path, headers);
    const html = await page.text();
    return {
      page,
      html,
      token: /name="token" value="([^"]+)"/.exec(html)?.[1] ?? "",
    };
  };
  const stateOf = async (path: string) => {
    const { token } = await confirm(path);
    return new URL(
      (await post(path, token)).headers.get("location")!
    ).searchParams.get("state")!;
  };
  try {
    // The chat link and the click open the same route.
    expect(await flow.connect("notion")).toEqual({
      ok: true,
      url: `${hostBase}/mcp/connect/notion`,
    });

    // No sign-in begins outside a confirmed POST.
    expect(
      await hosted.begin({ name: "notion", label: "Notion", serverUrl })
    ).toEqual({ kind: "failed", error: "unconfirmed" });

    // The proxy's proof: a valid one admits; none, a stale one, or one over
    // another path, method or owner does not, whatever the owner header says.
    const path = "/mcp/connect/notion";
    expect((await get(path)).status).toBe(200);
    for (const bad of [
      "",
      proof("GET", path, { ts: Math.floor(now / 1000) - 121 }),
      proof("GET", path, { ts: Math.floor(now / 1000) + 121 }),
      proof("GET", "/mcp/connect/canva"),
      proof("POST", path),
      proof("GET", path, { who: "o2" }),
      proof("GET", path, { secret: "f".repeat(64) }),
      "123.nothex",
    ])
      expect(
        (await get(path, { ...owner, "x-abacus-host-proof": bad })).status,
        bad
      ).toBe(403);

    // Wrong owner header, a frame, a fetch, or no fetch metadata at all.
    for (const headers of [
      { ...owner, "x-abacus-user-id": "O" },
      { ...owner, "x-abacus-user-id": "o2" },
      { ...owner, "sec-fetch-dest": "iframe" },
      { "x-abacus-user-id": "o", "sec-fetch-mode": "cors" },
      { "x-abacus-user-id": "o" },
    ])
      expect((await get(path, headers)).status).toBe(403);

    // The GET only asks, even cross-site (a link in a web chat app).
    const asked = await confirm("/mcp/connect/notion", {
      ...owner,
      "sec-fetch-site": "cross-site",
    });
    expect(asked.page.status).toBe(200);
    expect(asked.page.headers.get("x-frame-options")).toBe("DENY");
    expect(asked.page.headers.get("cache-control")).toBe("no-store");
    expect(asked.page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
    expect(asked.html).toContain("Connect Notion to AbacusAI Bot?");
    expect(add).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(serverUrl, expect.anything());
    expect((await get("/mcp/connect/nothing-here")).status).toBe(404);
    expect((await get("/mcp/connect/abacus-gmailuser")).status).toBe(404);

    // Refused POSTs: cross-site, missing, wrong, or superseded token.
    const { token } = await confirm("/mcp/connect/notion");
    expect(
      (
        await post("/mcp/connect/notion", token, {
          ...owner,
          "sec-fetch-site": "cross-site",
        })
      ).status
    ).toBe(403);
    expect((await post("/mcp/connect/notion", "")).status).toBe(403);
    // No fetch metadata on the POST: refused, the token left unspent.
    expect(
      (await post("/mcp/connect/notion", token, { "x-abacus-user-id": "o" }))
        .status
    ).toBe(403);
    expect(
      (
        await post("/mcp/connect/notion", token, {
          "x-abacus-user-id": "o",
          "sec-fetch-dest": "document",
        })
      ).status
    ).toBe(403);
    expect((await post("/mcp/connect/notion", asked.token)).status).toBe(403);
    expect(
      (await post("/mcp/connect/notion", token, { "x-abacus-user-id": "x" }))
        .status
    ).toBe(403);
    expect(add).not.toHaveBeenCalled();

    // The happy path: the POST installs and redirects, once.
    const started = await post("/mcp/connect/notion", token);
    expect(started.status).toBe(302);
    expect(add).toHaveBeenCalledExactlyOnceWith("notion", { url: serverUrl });
    expect(watch).toHaveBeenCalledWith("notion");
    expect((await post("/mcp/connect/notion", token)).status).toBe(403);
    const authorize = new URL(started.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://auth.provider.test/authorize"
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${hostBase}/mcp/callback`
    );
    const state = authorize.searchParams.get("state")!;

    // The provider's redirect is cross-site by nature; its state admits it.
    const callback = {
      "x-abacus-user-id": "o",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "cross-site",
    };
    const unknown = await get("/mcp/callback?code=c&state=nope", callback);
    expect(unknown.status).toBe(400);
    expect(tokenRequests).toHaveLength(0);
    const done = await get(
      `/mcp/callback?code=the-code&state=${encodeURIComponent(state)}`,
      callback
    );
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Notion is connected.");
    expect(signedIn).toHaveBeenCalledWith("notion");
    const stored = JSON.parse(
      await readFile(join(home, "mcp-auth.json"), "utf8")
    );
    expect(stored.servers[serverUrl].accessToken).toBe("token-1");
    expect(
      (
        await get(
          `/mcp/callback?code=the-code&state=${encodeURIComponent(state)}`,
          callback
        )
      ).status
    ).toBe(400);
    expect(tokenRequests).toHaveLength(1);

    // Again over the user's edited entry: kept as it is. A repeat begin
    // replaces the earlier flow, whose state no longer completes.
    entries.set("notion", { url: serverUrl, headers: { "X-Mine": "1" } });
    const replaced = await stateOf("/mcp/connect/notion");
    const refusedState = await stateOf("/mcp/connect/notion");
    expect(add).toHaveBeenCalledOnce();
    expect(entries.get("notion")).toEqual({
      url: serverUrl,
      headers: { "X-Mine": "1" },
    });
    expect(
      (await get(`/mcp/callback?code=c&state=${replaced}`, callback)).status
    ).toBe(400);
    expect(failed).not.toHaveBeenCalled();
    // A refusal is announced for its connector; its text never reaches the page.
    const refusal = await get(
      `/mcp/callback?error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}&state=${refusedState}`,
      callback
    );
    expect(refusal.status).toBe(400);
    expect(await refusal.text()).not.toContain("<script>");
    expect(failed).toHaveBeenCalledExactlyOnceWith("notion");

    // Cancel drops the pending flow; an expired one does not complete.
    const revokedState = await stateOf("/mcp/connect/notion");
    hosted.revoke("notion");
    expect(
      (await get(`/mcp/callback?code=c&state=${revokedState}`, callback)).status
    ).toBe(400);
    const lateState = await stateOf("/mcp/connect/notion");
    now += 31 * 60_000;
    expect(
      (await get(`/mcp/callback?code=c&state=${lateState}`, callback)).status
    ).toBe(400);
    // So does a confirm token past its ten minutes.
    const stale = await confirm("/mcp/connect/notion");
    now += 11 * 60_000;
    expect((await post("/mcp/connect/notion", stale.token)).status).toBe(403);
    expect(tokenRequests).toHaveLength(1);

    // Cancelled while discovery runs: the sign-in it was preparing never exists.
    let release!: () => void;
    registering = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing = await confirm("/mcp/connect/notion");
    const probes = () =>
      fetchSpy.mock.calls.filter(([input]) => String(input) === serverUrl)
        .length;
    const before = probes();
    const raced = post("/mcp/connect/notion", racing.token);
    await vi.waitFor(() => expect(probes()).toBe(before + 1));
    hosted.revoke("notion");
    release();
    const racedAnswer = await raced;
    expect(racedAnswer.status).toBe(400);
    expect(racedAnswer.headers.get("location")).toBeNull();
    registering = Promise.resolve();

    // Cancel-all drops every connector's confirm token and pending sign-in.
    const one = await confirm("/mcp/connect/notion");
    const pendingState = await stateOf("/mcp/connect/notion");
    const two = await confirm("/mcp/connect/huggingface");
    hosted.revoke();
    expect((await post("/mcp/connect/notion", one.token)).status).toBe(403);
    expect((await post("/mcp/connect/huggingface", two.token)).status).toBe(
      403
    );
    expect(
      (await get(`/mcp/callback?code=c&state=${pendingState}`, callback)).status
    ).toBe(400);

    // A body over the cap, declared or streamed, and one that never ends.
    const big = await confirm("/mcp/connect/notion");
    const sized = await fetch(`${base}/mcp/connect/notion`, {
      method: "POST",
      headers: {
        ...signed("POST", "/mcp/connect/notion", owner),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `token=${big.token}&pad=${"x".repeat(100)}`,
    });
    expect(sized.status).toBe(413);
    const raw = (body: (sent: ClientRequest) => void) =>
      new Promise<number | "closed">((resolve) => {
        const sent = request(
          `${base}/mcp/connect/notion`,
          {
            method: "POST",
            headers: {
              ...signed("POST", "/mcp/connect/notion", owner),
              "content-type": "application/x-www-form-urlencoded",
            },
          },
          (answer) => {
            answer.resume();
            resolve(answer.statusCode ?? 0);
          }
        );
        sent.on("error", () => resolve("closed"));
        body(sent);
      });
    // Chunked, no length: counted, and cut off past the cap.
    expect(
      await raw((sent) => {
        sent.write("x".repeat(40));
        sent.write("x".repeat(40));
      })
    ).toSatisfy((status) => status === 413 || status === "closed");
    // Started and never finished: the timeout answers.
    expect(await raw((sent) => sent.write("token="))).toBe(408);
    // Neither spent the token.
    expect((await post("/mcp/connect/notion", big.token)).status).toBe(302);

    // No sign-in: installed on the POST, then the connected page.
    const hf = await confirm("/mcp/connect/huggingface");
    expect(entries.has("huggingface")).toBe(false);
    const open = await post("/mcp/connect/huggingface", hf.token);
    expect(open.status).toBe(200);
    expect(await open.text()).toContain("Hugging Face is connected.");
    expect(entries.get("huggingface")).toEqual({
      url: "https://huggingface.co/mcp",
    });
    // The user's own server that asks for none.
    const mine = await confirm("/mcp/connect/mine");
    expect(
      await (await post("/mcp/connect/mine", mine.token)).text()
    ).toContain("mine is connected.");
  } finally {
    fetchSpy.mockRestore();
    if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
    else process.env.ABACUSAI_BOT_HOME = previousHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
