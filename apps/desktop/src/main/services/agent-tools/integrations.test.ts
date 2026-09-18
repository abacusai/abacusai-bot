/**
 * X search, against a stub of the platform's endpoint on loopback.
 *
 * A real server rather than a mocked `fetch`: what is worth asserting here is
 * the request that actually goes out — the bearer token and the query — and
 * what the model gets back. A mock would assert that the code calls the mock.
 *
 * Nothing here leaves loopback, and no key is needed to run it.
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
  body: { query?: string; num_results?: number };
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
  home = mkdtempSync(join(tmpdir(), "abacusai-bot-integrations-"));
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_X_SEARCH_URL = `http://127.0.0.1:${port}/v1/abacusaibot_x_search`;
  process.env.ABACUS_API_KEY = "test-key";
});

afterAll(async () => {
  delete process.env.ABACUSAI_BOT_X_SEARCH_URL;
  delete process.env.ABACUS_API_KEY;
  delete process.env.ABACUSAI_BOT_HOME;

  rmSync(home, { recursive: true, force: true });

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  received = undefined;
  reply = { status: 200, body: {} };
});

/** A reply in the shape the platform returns. */
function found(text: string, count = 1): unknown {
  return {
    results: Array.from({ length: count }, (_, index) => ({
      url: `https://x.com/anyuser/status/${index}`,
      text: "post",
      like_count: 1,
      retweet_count: 0,
    })),
    text,
  };
}

describe("knowing whether it can run", () => {
  it("is ready with an Abacus key", () => {
    expect(xSearchReady()).toBe(true);
  });

  it("is not ready without one, and says where to get it", () => {
    const previous = process.env.ABACUS_API_KEY;

    delete process.env.ABACUS_API_KEY;

    try {
      expect(xSearchReady()).toBe(false);
      expect(xSearchSetupHint).toContain("Abacus.AI");
    } finally {
      process.env.ABACUS_API_KEY = previous;
    }
  });
});

describe("the request it sends", () => {
  it("authenticates with the Abacus key and passes the query through", async () => {
    reply = { status: 200, body: found("## Real-Time Search Results") };

    await xSearch("who is shipping agents");

    expect(received?.url).toBe("/v1/abacusaibot_x_search");
    expect(received?.authorization).toBe("Bearer test-key");
    expect(received?.body.query).toBe("who is shipping agents");
  });
});

describe("the answer it gives back", () => {
  it("returns the platform's formatted results", async () => {
    reply = {
      status: 200,
      body: found("## Real-Time Search Results\nURL: https://x.com/a/1"),
    };

    expect(await xSearch("anything")).toContain("https://x.com/a/1");
  });

  it("says so plainly when there is nothing", async () => {
    // An empty string reaching the model as a result reads as a broken tool.
    reply = { status: 200, body: { results: [], text: "" } };

    expect(await xSearch("nothing at all")).toBe(
      'No results for "nothing at all".'
    );
  });

  it("survives a reply missing the fields it wants", async () => {
    reply = { status: 200, body: {} };

    await expect(xSearch("anything")).resolves.toContain("No results");
  });

  it("reports a refusal as an error the model can act on", async () => {
    reply = { status: 429, body: { error: "You have no remaining credits" } };

    await expect(xSearch("anything")).rejects.toThrow(/429|remaining credits/);
  });
});
