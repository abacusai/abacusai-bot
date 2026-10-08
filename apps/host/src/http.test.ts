import { createHmac } from "node:crypto";
import { appendFileSync, truncateSync } from "node:fs";
import fs from "node:fs/promises";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { get, request, ServerResponse } from "node:http";
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

it("MCP connect: the link goes straight to the provider, and the connector is installed only once consent lands", async () => {
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
        await exchanging;
        tokenRequests.push(String(init?.body));
        return Response.json({ access_token: "token-1", expires_in: 3600 });
      }
      return new Response("", { status: 404 });
    });
  let now = Date.now();
  // Discovery can be held mid-flight, to cancel under it.
  let registering: Promise<void> = Promise.resolve();
  // So can the code exchange.
  let exchanging: Promise<void> = Promise.resolve();
  const connected = vi.fn();
  const failed = vi.fn();
  const entries = new Map<string, McpServerEntry>([
    ["mine", { url: "https://open.example/mcp" }],
  ]);
  const add = vi.fn((name: string, entry: McpServerEntry) => {
    entries.set(name, entry);
    return { success: true };
  });
  const hostBase = "https://apps.abacus.ai/api/botHost/h1";
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
      signIn: async () => ({ kind: "failed" }),
      connectUrl: (name) => hosted.connectUrl(name),
    },
    homeDir: () => home,
  });
  const hosted = new HostedMcpConnect({
    base: hostBase,
    // "keyed" stands for a connector that needs the user's keys first.
    plan: (name) =>
      name === "keyed"
        ? { kind: "needs-fields", label: "Keyed" }
        : flow.mcpConnectPlan(name),
    install: (name, entry) => flow.installMcp(name, entry).success,
    connected,
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
    () => now
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // A top-level navigation, as a browser sends it: a link in a chat app, a
  // tab the app opens, or the provider's redirect.
  const owner = {
    "x-abacus-user-id": "o",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
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
  /** Sent by node:http: fetch sets its own `sec-fetch-mode`. */
  const send = (
    method: string,
    path: string,
    headers: Record<string, string>
  ) =>
    new Promise<{
      status: number;
      headers: { get: (name: string) => string | null };
      text: () => Promise<string>;
    }>((resolve, reject) => {
      request(
        `${base}${path}`,
        { method, headers: signed(method, path, headers) },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => chunks.push(chunk));
          answer.on("end", () =>
            resolve({
              status: answer.statusCode ?? 0,
              headers: {
                get: (name) => {
                  const value = answer.headers[name.toLowerCase()];
                  return value == null ? null : String(value);
                },
              },
              text: async () => Buffer.concat(chunks).toString("utf8"),
            })
          );
        }
      )
        .on("error", reject)
        .end();
    });
  const get = (path: string, headers: Record<string, string> = owner) =>
    send("GET", path, headers);
  /** The provider's state for a sign-in the route started. */
  const stateOf = async (path: string) =>
    new URL((await get(path)).headers.get("location")!).searchParams.get(
      "state"
    )!;
  const callback = (state: string, code = "c") =>
    get(`/mcp/callback?code=${code}&state=${encodeURIComponent(state)}`, owner);
  try {
    // The chat link and the click open the same route, with a one-time nonce.
    expect(await flow.connect("notion")).toEqual({
      ok: true,
      url: expect.stringMatching(
        /^https:\/\/apps\.abacus\.ai\/api\/botHost\/h1\/mcp\/connect\/notion\?nonce=[\w-]{32}$/
      ),
    });

    // The proxy's proof: a valid one admits; none, a stale one, or one over
    // another path, method or owner does not, whatever the owner header says.
    const path = "/mcp/connect/notion";
    expect((await get(path)).status).toBe(302);
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

    // Only a top-level navigation by the owner: never a frame, an image, a
    // fetch, or a request without fetch metadata.
    for (const headers of [
      { ...owner, "x-abacus-user-id": "O" },
      { ...owner, "x-abacus-user-id": "o2" },
      { ...owner, "sec-fetch-dest": "iframe" },
      { ...owner, "sec-fetch-dest": "image" },
      { ...owner, "sec-fetch-mode": "cors" },
      { ...owner, "sec-fetch-mode": "no-cors" },
      { "x-abacus-user-id": "o", "sec-fetch-dest": "document" },
      { "x-abacus-user-id": "o", "sec-fetch-mode": "navigate" },
      { "x-abacus-user-id": "o" },
    ])
      expect((await get(path, headers)).status).toBe(403);
    // Nothing is posted to the route any more.
    expect((await send("POST", path, owner)).status).toBe(404);
    expect((await get("/mcp/connect/nothing-here")).status).toBe(404);
    expect((await get("/mcp/connect/abacus-gmailuser")).status).toBe(404);

    // The GET answers the provider's consent screen and installs nothing.
    const started = await get(path);
    expect(started.status).toBe(302);
    expect(started.headers.get("cache-control")).toBe("no-store");
    const authorize = new URL(started.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://auth.provider.test/authorize"
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${hostBase}/mcp/callback`
    );
    expect(add).not.toHaveBeenCalled();
    expect(entries.has("notion")).toBe(false);
    expect(connected).not.toHaveBeenCalled();
    const state = authorize.searchParams.get("state")!;

    // Another owner's state: refused, and left for its owner.
    const foreign = await hosted.route(
      {
        method: "GET",
        pathname: "/mcp/callback",
        query: new URLSearchParams({ code: "c", state }),
        headers: { ...owner, "x-abacus-user-id": "o2" },
      },
      "o2"
    );
    expect(foreign).toMatchObject({ kind: "page", status: 400 });
    const unknown = await get("/mcp/callback?code=c&state=nope", owner);
    expect(unknown.status).toBe(400);
    expect(tokenRequests).toHaveLength(0);

    // The provider's redirect: the code is exchanged, then the install.
    const done = await callback(state, "the-code");
    expect(done.status).toBe(200);
    expect(done.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
    expect(done.headers.get("x-frame-options")).toBe("DENY");
    const page = await done.text();
    expect(page).toContain("Notion is connected.");
    expect(page).toContain("go back to AbacusAI Bot or WhatsApp");
    expect(page).not.toContain("<script");
    expect(page).not.toContain("<form");
    expect(add).toHaveBeenCalledExactlyOnceWith("notion", { url: serverUrl });
    expect(connected).toHaveBeenCalledExactlyOnceWith("notion");
    const stored = JSON.parse(
      await readFile(join(home, "mcp-auth.json"), "utf8")
    );
    expect(stored.servers[serverUrl].accessToken).toBe("token-1");
    // The state is spent.
    expect((await callback(state, "the-code")).status).toBe(400);
    expect(tokenRequests).toHaveLength(1);

    // `return`: a same-origin path under /bot/ is where the tab goes after;
    // anything else is ignored and the page answers.
    const returning = async (target: string) =>
      callback(
        await stateOf(
          `/mcp/connect/notion?return=${encodeURIComponent(target)}`
        )
      );
    const back = await returning("/bot/library/connectors");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(
      "/bot/library/connectors?connected=notion"
    );
    expect(
      (await returning("/bot/library/connectors?category=web")).headers.get(
        "location"
      )
    ).toBe("/bot/library/connectors?category=web&connected=notion");
    // A chat session, with its query kept.
    expect(
      (await returning("/bot/sessions/s-1?tab=files")).headers.get("location")
    ).toBe("/bot/sessions/s-1?tab=files&connected=notion");
    for (const target of [
      "//evil.com",
      "https://x",
      "/other",
      "/bot//evil.com",
      "/bot/../other",
      "/bot/\\evil.com",
      "/bot/x\r\nSet-Cookie: a=b",
    ]) {
      const ignored = await returning(target);
      expect(ignored.status, target).toBe(200);
      expect(ignored.headers.get("location")).toBeNull();
    }

    // Again over the user's edited entry: kept as it is. A repeat GET
    // replaces the earlier flow, whose state no longer completes.
    entries.set("notion", { url: serverUrl, headers: { "X-Mine": "1" } });
    const replaced = await stateOf(path);
    const refusedState = await stateOf(path);
    expect((await callback(replaced)).status).toBe(400);
    expect(failed).not.toHaveBeenCalled();
    // A refusal is announced for its connector; its text never reaches the page.
    const refusal = await get(
      `/mcp/callback?error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}&state=${refusedState}`,
      owner
    );
    expect(refusal.status).toBe(400);
    expect(await refusal.text()).not.toContain("<script>");
    expect(failed).toHaveBeenCalledExactlyOnceWith("notion");
    expect((await callback(await stateOf(path))).status).toBe(200);
    expect(add).toHaveBeenCalledOnce();
    expect(entries.get("notion")).toEqual({
      url: serverUrl,
      headers: { "X-Mine": "1" },
    });
    entries.delete("notion");

    // Cancel drops the pending sign-in; an expired one does not complete.
    const revokedState = await stateOf(path);
    hosted.revoke("notion");
    expect((await callback(revokedState)).status).toBe(400);
    const lateState = await stateOf(path);
    now += 31 * 60_000;
    expect((await callback(lateState)).status).toBe(400);

    // Cancelled while discovery runs: the sign-in it was preparing never exists.
    let release!: () => void;
    registering = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probes = () =>
      fetchSpy.mock.calls.filter(([input]) => String(input) === serverUrl)
        .length;
    const before = probes();
    const raced = get(path);
    await vi.waitFor(() => expect(probes()).toBe(before + 1));
    hosted.revoke("notion");
    release();
    const racedAnswer = await raced;
    expect(racedAnswer.status).toBe(400);
    expect(racedAnswer.headers.get("location")).toBeNull();
    expect(failed).toHaveBeenLastCalledWith("notion");
    registering = Promise.resolve();

    // Cancel-all drops every pending sign-in.
    const pendingState = await stateOf(path);
    hosted.revoke();
    expect((await callback(pendingState)).status).toBe(400);
    expect(entries.has("notion")).toBe(false);

    const tokensFor = async (url: string) =>
      JSON.parse(await readFile(join(home, "mcp-auth.json"), "utf8")).servers[
        url
      ];
    // Cancelled during the code exchange: not installed, the tokens dropped.
    let exchanged!: () => void;
    exchanging = new Promise<void>((resolve) => {
      exchanged = resolve;
    });
    const exchangeState = await stateOf(path);
    const exchangesBefore = fetchSpy.mock.calls.filter(
      ([input]) => String(input) === "https://auth.provider.test/token"
    ).length;
    const cancelledExchange = callback(exchangeState);
    await vi.waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter(
          ([input]) => String(input) === "https://auth.provider.test/token"
        ).length
      ).toBe(exchangesBefore + 1)
    );
    hosted.revoke("notion");
    exchanged();
    expect((await cancelledExchange).status).toBe(400);
    exchanging = Promise.resolve();
    expect(entries.has("notion")).toBe(false);
    expect(await tokensFor(serverUrl)).toBeUndefined();
    expect(failed).toHaveBeenLastCalledWith("notion");

    // An install that fails drops the tokens it would have used.
    add.mockReturnValueOnce({ success: false });
    expect((await callback(await stateOf(path))).status).toBe(400);
    expect(entries.has("notion")).toBe(false);
    expect(await tokensFor(serverUrl)).toBeUndefined();

    // No sign-in, no credentials: installed on the GET, but only with a
    // host-minted nonce. Without one (a forged navigation, or a link the
    // page built) the tab gets a confirm link that carries a fresh one.
    const relative = (url: string) => url.slice(hostBase.length);
    expect(entries.has("huggingface")).toBe(false);
    const unconfirmed = await get("/mcp/connect/huggingface");
    expect(unconfirmed.status).toBe(200);
    const confirmHtml = await unconfirmed.text();
    expect(confirmHtml).toContain("Connect Hugging Face?");
    expect(confirmHtml).not.toContain("<script");
    expect(entries.has("huggingface")).toBe(false);
    // Someone else's or a made-up nonce is no better.
    for (const nonce of [
      "made-up",
      new URL(hosted.connectUrl("mine")).searchParams.get("nonce")!,
    ])
      expect(
        await (await get(`/mcp/connect/huggingface?nonce=${nonce}`)).text()
      ).toContain("Connect Hugging Face?");
    expect(entries.has("huggingface")).toBe(false);
    const confirmLink = /href="([^"]+)"/
      .exec(confirmHtml)![1]!
      .replaceAll("&amp;", "&");
    const open = await get(relative(confirmLink));
    expect(open.status).toBe(200);
    expect(await open.text()).toContain("Hugging Face is connected.");
    expect(entries.get("huggingface")).toEqual({
      url: "https://huggingface.co/mcp",
    });
    expect(connected).toHaveBeenLastCalledWith("huggingface");
    // Spent: the same link only confirms again.
    expect(await (await get(relative(confirmLink))).text()).toContain(
      "Connect Hugging Face?"
    );
    // Expired: the same.
    const stale = relative(hosted.connectUrl("huggingface"));
    now += 16 * 60_000;
    expect(await (await get(stale)).text()).toContain("Connect Hugging Face?");
    // The confirm link keeps the return path.
    const returnConfirm = /href="([^"]+)"/
      .exec(
        await (
          await get(
            `/mcp/connect/huggingface?return=${encodeURIComponent("/bot/library/connectors")}`
          )
        ).text()
      )![1]!
      .replaceAll("&amp;", "&");
    expect((await get(relative(returnConfirm))).headers.get("location")).toBe(
      "/bot/library/connectors?connected=huggingface"
    );
    // The user's own server that asks for none, signed in by its name.
    expect(
      await (await get(relative(hosted.connectUrl("mine")))).text()
    ).toContain("mine is connected.");

    // A connector that needs keys is connected from the app, never here.
    const keyed = await get("/mcp/connect/keyed");
    expect(keyed.status).toBe(400);
    expect(await keyed.text()).toContain("Open AbacusAI Bot to connect it.");
    expect(failed).toHaveBeenLastCalledWith("keyed");
    expect(entries.has("keyed")).toBe(false);
  } finally {
    fetchSpy.mockRestore();
    if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
    else process.env.ABACUSAI_BOT_HOME = previousHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
