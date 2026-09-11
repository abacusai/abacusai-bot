/**
 * The download every vendored binary comes through.
 *
 * ripgrep, fd and the scrcpy jar are fetched at build time, and a single bad
 * moment from the release host used to end the build: a CI job died on
 * `ripgrep-15.2.0-aarch64-apple-darwin.tar.gz: download failed with 504 Gateway
 * Time-out` before a test had run. One `fetch` with no second try is a
 * coin-flip dependency on somebody else's CDN.
 *
 * The two cases worth being careful about are the ones that must NOT retry: a
 * 404 means the pin is wrong and should say so immediately, and a checksum
 * mismatch is not a bad connection. Asking again until the digest matches is
 * how a build talks itself into the wrong file.
 */
import { createHash } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { fetchVerified } from "@abacus-ai/config/vendor-fetch";
import { describe, expect, it } from "vitest";

const BODY = Buffer.from("the real bytes");
const SHA = createHash("sha256").update(BODY).digest("hex");

/**
 * A host that answers each request with the next entry in `plan`, repeating
 * the last one once it runs out.
 */
async function host(plan: Array<number | "ok" | "wrong">): Promise<{
  url: string;
  attempts: () => number;
  close: () => void;
}> {
  let served = 0;
  const server = http.createServer((_request, response) => {
    const step = plan[Math.min(served++, plan.length - 1)];

    if (step === "ok") {
      response.writeHead(200);
      response.end(BODY);

      return;
    }

    if (step === "wrong") {
      response.writeHead(200);
      response.end("tampered");

      return;
    }

    response.writeHead(step as number);
    response.end("no");
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`,
    attempts: () => served,
    close: () => server.close(),
  };
}

/** What `fetchVerified` did, and how many requests it took to do it. */
async function attempt(
  plan: Array<number | "ok" | "wrong">
): Promise<{ outcome: string; attempts: number }> {
  const server = await host(plan);

  try {
    await fetchVerified(server.url, SHA, "tool.tgz");

    return { outcome: "ok", attempts: server.attempts() };
  } catch (error) {
    return {
      outcome: (error as Error).message.split("\n")[0] ?? "",
      attempts: server.attempts(),
    };
  } finally {
    server.close();
  }
}

describe("fetching a vendored binary", () => {
  it("rides out a bad moment from the host", async () => {
    expect(await attempt([504, "ok"])).toEqual({ outcome: "ok", attempts: 2 });
  }, 30_000);

  it("retries a host asking to be asked later", async () => {
    expect(await attempt([429, "ok"])).toEqual({ outcome: "ok", attempts: 2 });
  }, 30_000);

  it("gives up eventually, saying how many times it tried", async () => {
    const result = await attempt([503]);

    expect(result.attempts).toBe(4);
    expect(result.outcome).toContain("after 4 attempts");
  }, 30_000);

  it("does not retry a pin that is simply wrong", async () => {
    // A 404 is an answer. Retrying it turns a clear error into a slow one.
    const result = await attempt([404]);

    expect(result.attempts).toBe(1);
    expect(result.outcome).toContain("404");
    expect(result.outcome).not.toContain("attempts");
  }, 30_000);

  it("never retries wrong bytes", async () => {
    // The one that would be dangerous: asking again until the digest matches
    // is how a build accepts a file it should have refused.
    const result = await attempt(["wrong"]);

    expect(result.attempts).toBe(1);
    expect(result.outcome).toContain("checksum mismatch");
  }, 30_000);
});
