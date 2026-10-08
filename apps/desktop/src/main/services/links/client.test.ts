import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewClient } from "./client";

afterEach(() => vi.restoreAllMocks());
const server = (
  replies: Array<{
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    remote?: string;
  }>
) => {
  const request = vi.spyOn(http, "request");
  const targets: string[] = [];
  request.mockImplementation(((
    url: URL,
    options: http.RequestOptions,
    callback: (r: http.IncomingMessage) => void
  ) => {
    targets.push(url.href);
    const reply = replies.shift()!;
    const req = new EventEmitter() as http.ClientRequest;
    let destroyed = false;
    req.destroy = (error?: Error) => {
      destroyed = true;
      if (error) queueMicrotask(() => req.emit("error", error));
      return req;
    };
    req.end = (() => {
      queueMicrotask(() => {
        const socket = new EventEmitter();
        Object.assign(socket, { remoteAddress: reply.remote ?? "8.8.8.8" });
        req.emit("socket", socket);
        socket.emit("connect");
        if (destroyed) return;
        // Confirm the lookup is pinned, even if DNS changes after resolution.
        const lookup = options.lookup!;
        lookup(url.hostname, { all: false }, (_error, address) =>
          expect(address).toBe("8.8.8.8")
        );
        const res = new PassThrough() as unknown as http.IncomingMessage;
        res.statusCode = reply.status ?? 200;
        res.headers = reply.headers ?? { "content-type": "text/html" };
        callback(res);
        (res as unknown as PassThrough).end(reply.body ?? "<title>OK</title>");
      });
      return req;
    }) as typeof req.end;
    return req;
  }) as typeof http.request);
  return { targets, request };
};
const resolve = () => Promise.resolve([{ address: "8.8.8.8", family: 4 }]);
describe("guarded HTTP", () => {
  it("rechecks DNS on redirects and never requests a private redirect", async () => {
    const mock = server([
      { status: 302, headers: { location: "http://private.example/" } },
    ]);
    const dns = vi
      .fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(
      new PreviewClient(dns).fetch(
        "http://example.com/",
        "html",
        new AbortController().signal
      )
    ).rejects.toThrow("DNS");
    expect(mock.targets).toEqual(["http://example.com/"]);
    expect(dns).toHaveBeenCalledTimes(2);
  });
  it("refuses rebinding at connect time", async () => {
    server([{ remote: "127.0.0.1" }]);
    await expect(
      new PreviewClient(resolve).fetch(
        "http://example.com/",
        "html",
        new AbortController().signal
      )
    ).rejects.toThrow("connected");
  });
  it("allows three redirects but refuses a fourth", async () => {
    const mock = server(
      Array.from({ length: 4 }, (_, i) => ({
        status: 302,
        headers: { location: `/hop${i}` },
      }))
    );
    await expect(
      new PreviewClient(resolve).fetch(
        "http://example.com/",
        "html",
        new AbortController().signal
      )
    ).rejects.toThrow("Redirect");
    expect(mock.request).toHaveBeenCalledTimes(4);
  });
  it.each([
    { headers: { "content-type": "application/json" }, body: "{}" },
    { headers: { "content-type": "text/html", "content-length": "524289" } },
    { headers: { "content-type": "text/html", "content-encoding": "gzip" } },
    { body: "x".repeat(524289) },
  ])(
    "rejects content types, declared and streamed caps, compressed responses",
    async (reply) => {
      server([reply]);
      await expect(
        new PreviewClient(resolve).fetch(
          "http://example.com/",
          "html",
          new AbortController().signal
        )
      ).rejects.toThrow();
    }
  );
  it("caps image bodies and sends no ambient credentials or referrer", async () => {
    const mock = server([
      {
        headers: { "content-type": "image/png" },
        body: "x".repeat(1024 * 1024 + 1),
      },
    ]);
    await expect(
      new PreviewClient(resolve).fetch(
        "http://example.com/",
        "image",
        new AbortController().signal
      )
    ).rejects.toThrow("limit");
    const options = mock.request.mock.calls[0]![1] as http.RequestOptions;
    expect(options.headers).toEqual({
      "user-agent": "LinkPreview/1.0",
      accept: "image/*",
      "accept-encoding": "identity",
    });
  });
});
