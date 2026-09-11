/**
 * A server that answers with a redirect must not be able to move a credential
 * header somewhere else. Driven against a real loopback server, because the
 * behaviour under test belongs to fetch, not to us.
 */
import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpClient } from "./client.js";

let server: http.Server;
let base: string;
/** The credential header, as the redirect target saw it. */
let receivedAuth: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `${base}/target` });
      res.end();

      return;
    }

    receivedAuth = req.headers["x-credential"] as string | undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address != null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("http transport redirects", () => {
  it("refuses to follow one when a credential header is attached", async () => {
    receivedAuth = undefined;
    const transport = McpClient.httpTransport(
      `${base}/redirect`,
      { "x-credential": "s3cret" },
      { refuseRedirects: true }
    );

    await expect(transport.request("tools/list")).rejects.toThrow();
    expect(receivedAuth).toBeUndefined();
  });

  it("still follows one for a server with no expanded credential", async () => {
    receivedAuth = undefined;
    const transport = McpClient.httpTransport(`${base}/redirect`);

    await expect(transport.request("tools/list")).resolves.toEqual({
      ok: true,
    });
  });
});
