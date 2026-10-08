/**
 * The loopback endpoint in front of the model server: it starts the model a
 * request names, swaps to another installed one, streams the answer through,
 * and unloads after a quiet spell.
 */
import http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalModelProxy,
  bearerMatches,
  forwardablePath,
  isLoopbackHost,
  modelInBody,
  type UpstreamServer,
} from "./local-model-proxy";

/** An upstream that answers with what it was asked, prefixed by its model id. */
class FakeUpstream implements UpstreamServer {
  private server: http.Server | null = null;
  baseUrl = "";
  starts = 0;
  stops = 0;
  failStart = false;
  onRequest: ((request: http.IncomingMessage) => void) | null = null;

  constructor(readonly modelId: string) {}

  get running(): boolean {
    return this.server != null;
  }

  async start(): Promise<void> {
    this.starts += 1;
    if (this.failStart) throw new Error("no such luck");
    const server = http.createServer((request, response) => {
      this.onRequest?.(request);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/plain",
          "x-path": request.url ?? "",
        });
        // Two writes: the second only arrives if the proxy streams.
        response.write(`${this.modelId}:`);
        setTimeout(() => response.end(Buffer.concat(chunks)), 10);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    this.baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    this.server = server;
  }

  stop(): void {
    this.stops += 1;
    this.server?.close();
    this.server = null;
  }
}

let proxy: LocalModelProxy;
let upstreams: Record<string, FakeUpstream>;
let defaultModel: string | null;

const post = async (
  body: unknown,
  path = "/v1/chat/completions",
  headers: Record<string, string> = {
    authorization: `Bearer ${proxy.apiKey}`,
  }
) => {
  const response = await fetch(`${proxy.baseUrl.replace(/\/v1$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    headers: response.headers,
  };
};

beforeEach(async () => {
  upstreams = { a: new FakeUpstream("a"), b: new FakeUpstream("b") };
  defaultModel = "a";
  proxy = new LocalModelProxy({
    serverFor: (modelId) => upstreams[modelId] ?? null,
    defaultModelId: () => defaultModel,
    idleMs: 60,
  });
  // Any free port: the preferred one may be taken on a developer's machine.
  await proxy.listen(49_000 + Math.floor(Math.random() * 500));
});

afterEach(() => {
  proxy.close();
});

describe("modelInBody", () => {
  it("reads the model of an OpenAI-style request and nothing else", () => {
    expect(modelInBody(Buffer.from('{"model":"a","messages":[]}'))).toBe("a");
    expect(modelInBody(Buffer.from('{"messages":[]}'))).toBeNull();
    expect(modelInBody(Buffer.from("not json"))).toBeNull();
    expect(modelInBody(Buffer.alloc(0))).toBeNull();
  });
});

describe("forwardablePath", () => {
  it("maps a request onto one of the known API paths, or nothing", () => {
    expect(forwardablePath("/v1/chat/completions")).toBe(
      "/v1/chat/completions"
    );
    expect(forwardablePath("/v1/models?x=1")).toBe("/v1/models");
    expect(forwardablePath("/v1")).toBeNull();
    expect(forwardablePath("/v1/anything")).toBeNull();
    expect(forwardablePath("http://evil.invalid/v1/models")).toBeNull();
    expect(forwardablePath("//evil.invalid/v1/models")).toBeNull();
    expect(forwardablePath("/health")).toBeNull();
    expect(forwardablePath("/")).toBeNull();
    expect(forwardablePath(undefined)).toBeNull();
  });
});

/** A raw request, so the Host header can be anything a rebound page would send. */
const rawGet = (host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const port = Number(new URL(proxy.baseUrl).port);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/models",
        headers: { host, authorization: `Bearer ${proxy.apiKey}` },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    request.on("error", reject);
    request.end();
  });

describe("isLoopbackHost", () => {
  it("accepts only loopback names on the proxy's own port", () => {
    expect(isLoopbackHost("127.0.0.1:41434", 41434)).toBe(true);
    expect(isLoopbackHost("LOCALHOST:41434", 41434)).toBe(true);
    expect(isLoopbackHost("[::1]:41434", 41434)).toBe(true);
    expect(isLoopbackHost("127.0.0.1:41435", 41434)).toBe(false);
    expect(isLoopbackHost("127.0.0.1", 41434)).toBe(false);
    expect(isLoopbackHost("evil.example:41434", 41434)).toBe(false);
    expect(isLoopbackHost(undefined, 41434)).toBe(false);
  });
});

describe("bearerMatches", () => {
  it("matches only the exact token", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("bearer abc", "abc")).toBe(true);
    expect(bearerMatches("Bearer abd", "abc")).toBe(false);
    expect(bearerMatches("Bearer ab", "abc")).toBe(false);
    expect(bearerMatches("abc", "abc")).toBe(false);
    expect(bearerMatches(undefined, "abc")).toBe(false);
  });
});

describe("the local model endpoint", () => {
  it("refuses a request without this boot's key, before starting anything", async () => {
    const none = await post({ model: "a" }, "/v1/chat/completions", {});
    expect(none.status).toBe(401);
    const wrong = await post({ model: "a" }, "/v1/chat/completions", {
      authorization: "Bearer local",
    });
    expect(wrong.status).toBe(401);
    expect(upstreams.a!.starts).toBe(0);
  });

  it("refuses a non-loopback Host even with the key", async () => {
    expect(await rawGet("attacker.example")).toBe(403);
    expect(await rawGet(`localhost:${new URL(proxy.baseUrl).port}`)).toBe(200);
    expect(upstreams.a!.starts).toBe(1);
  });

  it("does not pass its key on to the model server", async () => {
    let seen: string | undefined = "unset";
    upstreams.a!.onRequest = (request) => {
      seen = request.headers.authorization;
    };
    await post({ model: "a" });
    expect(seen).toBeUndefined();
  });

  it("answers 404 off the API path rather than forwarding anywhere", async () => {
    const reply = await post({ model: "a" }, "/health");
    expect(reply.status).toBe(404);
    expect(upstreams.a!.starts).toBe(0);
  });

  it("starts the model on the first request and streams the answer through", async () => {
    const reply = await post({
      model: "a",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(reply.status).toBe(200);
    expect(reply.text).toBe(
      'a:{"model":"a","messages":[{"role":"user","content":"hi"}]}'
    );
    expect(reply.headers.get("x-path")).toBe("/v1/chat/completions");
    expect(upstreams.a!.starts).toBe(1);
    expect(proxy.servingId).toBe("a");

    await post({ model: "a" });
    expect(upstreams.a!.starts).toBe(1);
  });

  it("swaps to the model a request names, one loaded at a time", async () => {
    await post({ model: "a" });
    const reply = await post({ model: "b" });

    expect(reply.text.startsWith("b:")).toBe(true);
    expect(upstreams.a!.stops).toBe(1);
    expect(proxy.servingId).toBe("b");
  });

  it("serves the default model to a request that names none", async () => {
    const reply = await post({ messages: [] }, "/v1/models");
    expect(reply.text.startsWith("a:")).toBe(true);
  });

  it("answers 503 when nothing is installed, and when the model cannot start", async () => {
    defaultModel = null;
    const none = await post({ messages: [] });
    expect(none.status).toBe(503);
    expect(none.text).toContain("no local model is installed");

    upstreams.b!.failStart = true;
    const broken = await post({ model: "b" });
    expect(broken.status).toBe(503);
    expect(broken.text).toContain("no such luck");

    const unknown = await post({ model: "zzz" });
    expect(unknown.status).toBe(503);
  });

  it("shares one start between requests that arrive together", async () => {
    await Promise.all([
      post({ model: "a" }),
      post({ model: "a" }),
      post({ model: "a" }),
    ]);
    expect(upstreams.a!.starts).toBe(1);
  });

  it("unloads the model after a quiet spell", async () => {
    await post({ model: "a" });
    expect(proxy.servingId).toBe("a");

    await vi.waitFor(() => expect(proxy.servingId).toBeNull(), {
      timeout: 2_000,
    });
    expect(upstreams.a!.stops).toBe(1);

    // And loads it again on the next request.
    await post({ model: "a" });
    expect(upstreams.a!.starts).toBe(2);
  });
});
