/**
 * The loopback endpoint in front of the model server: it starts the model a
 * request names, swaps to another installed one, streams the answer through,
 * and unloads after a quiet spell.
 */
import http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalModelProxy,
  forwardablePath,
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

  constructor(readonly modelId: string) {}

  get running(): boolean {
    return this.server != null;
  }

  async start(): Promise<void> {
    this.starts += 1;
    if (this.failStart) throw new Error("no such luck");
    const server = http.createServer((request, response) => {
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

const post = async (body: unknown, path = "/v1/chat/completions") => {
  const response = await fetch(`${proxy.baseUrl.replace(/\/v1$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

describe("the local model endpoint", () => {
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
