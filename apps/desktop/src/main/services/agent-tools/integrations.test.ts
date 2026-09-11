/**
 * X search, against a stub xAI on loopback.
 *
 * A real server rather than a mocked `fetch`: what is worth asserting here is
 * the request that actually goes out — the model, the bearer token, and the
 * Live Search parameters that are the whole reason this endpoint is being used
 * instead of a search API. A mock would assert that the code calls the mock.
 *
 * Nothing here reaches api.x.ai, and no key is needed to run it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { xSearch, xSearchReady, xSearchSetupHint } from "./integrations";

interface Received {
  url?: string;
  authorization?: string;
  body: {
    model?: string;
    messages?: Array<{ role?: string; content?: string }>;
    search_parameters?: { mode?: string; sources?: Array<{ type?: string }> };
  };
}

let server: Server;
let home: string;
let received: Received | undefined;
/** What the stub answers with next. */
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      received = {
        ...(request.url != null ? { url: request.url } : {}),
        ...(request.headers.authorization != null
          ? { authorization: request.headers.authorization }
          : {}),
        body: JSON.parse(
          Buffer.concat(chunks).toString("utf8") || "{}"
        ) as Received["body"],
      };

      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  // Credentials resolve from the environment and then from settings on disk, so
  // without a home of its own this suite reads whatever the developer happens to
  // have configured — and "no key" cannot be tested on a machine that has one.
  // It also stops a fallback from leaving loopback and calling somebody's real
  // search API with a test query.
  home = mkdtempSync(join(tmpdir(), "abacusai-bot-integrations-"));
  process.env.ABACUSAI_BOT_HOME = home;

  for (const key of [
    "ABACUS_API_KEY",
    "TAVILY_API_KEY",
    "EXA_API_KEY",
    "FIRECRAWL_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "SEARXNG_URL",
  ]) {
    delete process.env[key];
  }

  process.env.ABACUSAI_BOT_X_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.XAI_API_KEY = "test-key";
});

afterAll(async () => {
  delete process.env.ABACUSAI_BOT_X_BASE_URL;
  delete process.env.XAI_API_KEY;
  delete process.env.ABACUSAI_BOT_X_MODEL;
  delete process.env.ABACUSAI_BOT_HOME;

  rmSync(home, { recursive: true, force: true });

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  received = undefined;
  reply = { status: 200, body: {} };
  delete process.env.ABACUSAI_BOT_X_MODEL;
});

/** A reply in the shape xAI actually returns. */
function completion(content: string, citations?: string[]): unknown {
  return {
    choices: [{ message: { role: "assistant", content } }],
    ...(citations != null ? { citations } : {}),
  };
}

describe("knowing whether it can run", () => {
  it("is ready with a key", () => {
    expect(xSearchReady()).toBe(true);
  });

  it("is not ready without one, and says which variable to set", () => {
    const previous = process.env.XAI_API_KEY;

    delete process.env.XAI_API_KEY;

    try {
      expect(xSearchReady()).toBe(false);
      // The hint is the whole of what an unconfigured user sees, so it has to
      // name the variable rather than say "not configured".
      expect(xSearchSetupHint).toContain("XAI_API_KEY");
    } finally {
      process.env.XAI_API_KEY = previous;
    }
  });
});

describe("the request it sends", () => {
  it("asks for Live Search against X, not the model's memory", async () => {
    // Without these parameters the endpoint is an ordinary chat completion and
    // the "search" is whatever the model remembers — confident, sourceless, and
    // frequently wrong. This is the assertion that the feature is the feature.
    reply = { status: 200, body: completion("Some posts.") };

    await xSearch("typescript 6");

    expect(received?.body.search_parameters?.mode).toBe("on");
    expect(received?.body.search_parameters?.sources).toEqual([{ type: "x" }]);
  });

  it("authenticates with the key", async () => {
    reply = { status: 200, body: completion("Some posts.") };

    await xSearch("anything");

    expect(received?.authorization).toBe("Bearer test-key");
  });

  it("passes the query through to the model", async () => {
    reply = { status: 200, body: completion("Some posts.") };

    await xSearch("who is shipping agents");

    expect(received?.body.messages?.[0]?.content).toContain(
      "who is shipping agents"
    );
  });

  it("uses a default model, and honours an override", async () => {
    reply = { status: 200, body: completion("Some posts.") };
    await xSearch("a");
    expect(received?.body.model).toBe("grok-4");

    process.env.ABACUSAI_BOT_X_MODEL = "grok-3";
    reply = { status: 200, body: completion("Some posts.") };
    await xSearch("b");
    expect(received?.body.model).toBe("grok-3");
  });
});

describe("the answer it gives back", () => {
  it("returns what the model reported", async () => {
    reply = {
      status: 200,
      body: completion("Three people are talking about it."),
    };

    expect(await xSearch("anything")).toContain(
      "Three people are talking about it."
    );
  });

  it("appends the sources, because a summary without links cannot be checked", async () => {
    reply = {
      status: 200,
      body: completion("People are talking.", [
        "https://x.com/a/1",
        "https://x.com/b/2",
      ]),
    };

    const result = await xSearch("anything");

    expect(result).toContain("https://x.com/a/1");
    expect(result).toContain("https://x.com/b/2");
  });

  it("caps the sources rather than pasting a hundred links", async () => {
    const many = Array.from(
      { length: 30 },
      (_, index) => `https://x.com/post/${index}`
    );

    reply = { status: 200, body: completion("Lots.", many) };

    const result = await xSearch("anything");

    expect(result).toContain("https://x.com/post/9");
    expect(result).not.toContain("https://x.com/post/10");
  });

  it("says so plainly when there is nothing", async () => {
    // An empty string reaching the model as a result reads as a broken tool.
    reply = { status: 200, body: completion("   ") };

    expect(await xSearch("nothing at all")).toBe(
      'No results for "nothing at all".'
    );
  });

  it("survives a reply missing the fields it wants", async () => {
    reply = { status: 200, body: {} };

    await expect(xSearch("anything")).resolves.toContain("No results");
  });

  it("reports a refused key as an error the model can act on", async () => {
    // 401 is the one failure a user can actually fix, so it must not surface as
    // an empty result or a generic failure.
    reply = { status: 401, body: { error: "Incorrect API key provided" } };

    await expect(xSearch("anything")).rejects.toThrow(/401|Incorrect API key/);
  });

  it("reports a rate limit rather than reporting no results", async () => {
    reply = { status: 429, body: { error: "rate limit exceeded" } };

    await expect(xSearch("anything")).rejects.toThrow(/429|rate limit/);
  });
});

describe("without an xAI key", () => {
  // This tool used to fall back to a web backend so X search was not gated
  // behind an xAI signup. It no longer needs to: the agent ships its own
  // x_search, and the desktop stands this one down whenever xAI cannot answer.
  // So the contract here is now the narrow one — xAI, or nothing.
  it("is not ready, leaving the agent's own x_search to answer", () => {
    const previous = process.env.XAI_API_KEY;

    delete process.env.XAI_API_KEY;

    try {
      // Deliberately with a search backend still reachable: readiness must turn
      // on the xAI key alone, or this tool competes with the agent's version.
      process.env.SEARXNG_URL = "http://127.0.0.1:9/";
      expect(xSearchReady()).toBe(false);
    } finally {
      delete process.env.SEARXNG_URL;
      process.env.XAI_API_KEY = previous;
    }
  });

  it("points at the key that would actually change something", () => {
    // Someone reading this hint has already declined to sign up for xAI once,
    // so it says what they lose rather than listing keys that no longer apply.
    expect(xSearchSetupHint).toContain("XAI_API_KEY");
    expect(xSearchSetupHint).not.toContain("TAVILY_API_KEY");
  });
});
