import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHostTransport,
  type HostTransport,
} from "#renderer/data/transport/websocket";

import serverFixtures from "./fixtures/bootstrap-server.json";
import {
  callApps,
  hostConnection,
  hostHttpBase,
  identifyHost,
  pollDelayMs,
  reconnectDelayMs,
  resolveBrowserHost,
  refreshUploadToken,
  runHostConnection,
  setUpBotAccount,
} from "./services";
const ready = serverFixtures.find(
  (fixture) => fixture.result.status === "ready"
)!.result;
const token = ready.token!;
const base = `${location.origin}${ready.hostBase}`;
const envelope = (result: unknown) => Response.json({ success: true, result });
const host = {
  deploymentConversationId: "conversation",
  hostBase: ready.hostBase,
  previewHost: null,
  computerLifecycle: "STOPPED",
  filesystemLifecycle: "AVAILABLE",
};
const health = { ok: true, owner: "owner", contractVersion: CONTRACT_VERSION };
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("uses the real envelope, bootstraps until ready, retries proxy 403, and restarts only once", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(envelope(host))
    .mockResolvedValueOnce(envelope(serverFixtures[0]!.result))
    .mockResolvedValueOnce(envelope(ready))
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(Response.json(health));
  vi.stubGlobal("fetch", fetch);
  const stage = vi.fn();
  const pending = resolveBrowserHost(stage, true);
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({
    token,
    base,
    url: `${base.replace(/^http/, "ws")}/rpc`,
  });
  expect(stage.mock.calls.flat()).toEqual([
    "starting",
    "installing",
    "connecting",
  ]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/_getOrCreateAbacusBotHost",
    "/api/_bootstrapAbacusBotHost",
    "/api/_bootstrapAbacusBotHost",
    `${base}/healthz`,
    `${base}/healthz`,
  ]);
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
    deploymentConversationId: "conversation",
    forceRestart: true,
  });
  expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({
    deploymentConversationId: "conversation",
  });
  expect(fetch.mock.calls[0]![1]).toMatchObject({
    credentials: "same-origin",
    headers: { "REAI-UI": "1" },
  });
  expect(fetch.mock.calls[3]![1]).toMatchObject({ credentials: "include" });
});
it.each([
  [403, "AbacusBotHostTierRequired", "Pro tier required", "tier"],
  [
    403,
    "GenericPermissionDeniedError",
    "DeepAgent access required",
    "connection",
  ],
  [401, "PermissionDenied", "Please sign in", "signin"],
  [200, "NotLoggedInError", "not logged in", "signin"],
  [500, "InvalidRequest", "Bootstrap failed. Please retry.", "connection"],
])(
  "maps %s/%s by errorType and preserves the server message",
  async (status, errorType, error, kind) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ success: false, errorType, error }, { status })
        )
    );
    await expect(
      callApps("getOrCreateAbacusBotHost", {})
    ).rejects.toMatchObject({ kind, message: error });
  }
);
it("rejects malformed envelopes, bootstrap data and tokens immediately", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(host)));
  await expect(callApps("getOrCreateAbacusBotHost", {})).rejects.toMatchObject({
    kind: "connection",
  });
  for (const result of [{ token }, { ...ready, token: "malformed" }]) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(envelope(host))
        .mockResolvedValueOnce(envelope(result))
    );
    await expect(resolveBrowserHost(() => {})).rejects.toMatchObject({
      kind: "connection",
    });
  }
});
it("offers a restart for an older host, a reload for an older page, and refuses the wrong owner", async () => {
  for (const [body, kind] of [
    [{ ...health, contractVersion: CONTRACT_VERSION - 1 }, "version"],
    [{ ...health, contractVersion: CONTRACT_VERSION + 1 }, "reload"],
    [{ ...health, owner: "other" }, "connection"],
  ] as const) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(envelope(host))
        .mockResolvedValueOnce(envelope(ready))
        .mockResolvedValueOnce(Response.json(body))
    );
    await expect(resolveBrowserHost(() => {})).rejects.toMatchObject({ kind });
  }
});
it("bounds an apps-server request that never answers", async () => {
  vi.useFakeTimers();
  const never = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        )
      )
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(envelope(host)).mockImplementation(never)
  );
  const pending = resolveBrowserHost(() => {}).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await pending).toMatchObject({ kind: "connection", network: true });
  // The request itself was aborted, not left open.
  expect(never.mock.calls[0]![1]?.signal?.aborted).toBe(true);
});

it("polls again past a health check that never answers, within the install deadline", async () => {
  vi.useFakeTimers();
  // Never settles, and ignores its signal: the bound alone ends the wait.
  const hang = () => new Promise<Response>(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(envelope(host))
      .mockResolvedValueOnce(envelope(ready))
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce(Response.json(health))
  );
  let done = false;
  const pending = resolveBrowserHost(() => {}).finally(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(29_000);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(pending).resolves.toMatchObject({ token });
});

it("serializes refresh after eight minutes without replacing the connection", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(envelope(host))
    .mockResolvedValueOnce(envelope(ready))
    .mockResolvedValueOnce(Response.json(health));
  vi.stubGlobal("fetch", fetch);
  const connection = await resolveBrowserHost(() => {});
  await vi.advanceTimersByTimeAsync(8 * 60_000);
  fetch.mockResolvedValue(envelope({ ...ready, token: "fresh.token" }));
  const [a, b] = await Promise.all([
    refreshUploadToken(),
    refreshUploadToken(),
  ]);
  expect(a).toBe(connection);
  expect(b).toBe(connection);
  expect(a.token).toBe("fresh.token");
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(JSON.parse(fetch.mock.calls[3]![1].body)).toEqual({
    deploymentConversationId: "conversation",
  });
});

it.each(
  serverFixtures.filter((fixture) => fixture.result.status === "starting")
)(
  "accepts the server's $result.detail response with explicit null token/version",
  async ({ result }) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(envelope(host))
        .mockResolvedValueOnce(envelope(result))
        .mockResolvedValueOnce(envelope(ready))
        .mockResolvedValueOnce(Response.json(health))
    );
    const pending = resolveBrowserHost(() => {});
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ token });
  }
);
it("accepts a ready response with a nullable version", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(envelope(host))
      .mockResolvedValueOnce(envelope({ ...ready, version: null }))
      .mockResolvedValueOnce(Response.json(health))
  );
  expect(await resolveBrowserHost(() => {})).toMatchObject({ token });
});

it("derives every host route from the same-origin hostBase", () => {
  expect(ready.hostBase).toMatch(/^\/api\/botHost\/\w+$/);
  expect(ready.previewHost).toBeNull();
  expect(
    hostHttpBase({ hostBase: "/api/botHost/abc/", previewHost: "x" })
  ).toBe(`${location.origin}/api/botHost/abc`);
  expect(
    hostHttpBase({ hostBase: null, previewHost: "pod.preview.apps.abacus.ai" })
  ).toBe("https://pod.preview.apps.abacus.ai");
  expect(() => hostHttpBase({ hostBase: null, previewHost: null })).toThrow(
    "Invalid connection service response"
  );
});
it("falls back to the preview host only when hostBase is null", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(envelope({ ...host, hostBase: null }))
    .mockResolvedValueOnce(
      envelope({
        ...ready,
        hostBase: null,
        previewHost: "pod.preview.apps.abacus.ai",
      })
    )
    .mockResolvedValueOnce(Response.json(health));
  vi.stubGlobal("fetch", fetch);
  expect(await resolveBrowserHost(() => {})).toMatchObject({
    base: "https://pod.preview.apps.abacus.ai",
    url: "wss://pod.preview.apps.abacus.ai/rpc",
  });
  expect(fetch.mock.calls[2]![0]).toBe(
    "https://pod.preview.apps.abacus.ai/healthz"
  );
});
it.each([
  [{ hostBase: null, previewHost: null }],
  [{ hostBase: "//elsewhere.example/api/botHost/x" }],
  [{ hostBase: "https://elsewhere.example/api/botHost/x" }],
])(
  "refuses a ready response without a same-origin host path: %j",
  async (patch) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(envelope(host))
        .mockResolvedValueOnce(envelope({ ...ready, ...patch }))
    );
    await expect(resolveBrowserHost(() => {})).rejects.toMatchObject({
      kind: "connection",
    });
  }
);
it("refuses a refreshed token for a different host path", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(envelope(host))
    .mockResolvedValueOnce(envelope(ready))
    .mockResolvedValueOnce(Response.json(health));
  vi.stubGlobal("fetch", fetch);
  const connection = await resolveBrowserHost(() => {});
  fetch.mockResolvedValue(
    envelope({ ...ready, hostBase: "/api/botHost/other", token: "x.y" })
  );
  await expect(refreshUploadToken(true)).rejects.toThrow(
    "Host identity changed"
  );
  expect(connection.token).toBe(token);
});

it("polls from 0.5 s up to 3 s and reconnects from 0.5 s up to 8 s with jitter", () => {
  expect([0, 1, 2, 3, 4].map(pollDelayMs)).toEqual([
    500, 1000, 2000, 3000, 3000,
  ]);
  expect([0, 1, 4, 9].map((n) => reconnectDelayMs(n, () => 0))).toEqual([
    250, 500, 4000, 4000,
  ]);
  expect([0, 1, 4, 9].map((n) => reconnectDelayMs(n, () => 1))).toEqual([
    500, 1000, 8000, 8000,
  ]);
});

describe("runHostConnection", () => {
  class FakeSocket extends EventTarget {
    static all: FakeSocket[] = [];
    readyState = 0;
    send = vi.fn();
    constructor(
      readonly url: string,
      readonly protocols: string[]
    ) {
      super();
      FakeSocket.all.push(this);
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    close = vi.fn(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    });
    /** The host closes it with `code`. */
    closeWith(code: number) {
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event("close"), { code }));
    }
  }
  /** Like a browser: CLOSING at once, the close event a while later. */
  class SlowCloseSocket extends FakeSocket {
    override close = vi.fn(() => {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      setTimeout(() => this.closeWith(1006), 3_000);
    });
  }
  const hide = () =>
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const bootstraps = (fetch: ReturnType<typeof vi.fn>) =>
    fetch.mock.calls.filter(([url]) => url === "/api/_bootstrapAbacusBotHost");
  const WebSocket = FakeSocket as unknown as new (
    url: string,
    protocols: string[]
  ) => WebSocket;
  const transports: HostTransport[] = [];
  afterEach(() => {
    FakeSocket.all = [];
    for (const transport of transports.splice(0)) transport.close();
  });
  const start = async (options: { forceRestart?: boolean } = {}) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(envelope(host))
      .mockResolvedValueOnce(envelope(ready))
      .mockResolvedValueOnce(Response.json(health));
    vi.stubGlobal("fetch", fetch);
    const identity = await identifyHost();
    const transport = createHostTransport({ flowControl: false });
    transports.push(transport);
    const running = runHostConnection(transport, identity, {
      WebSocket,
      random: () => 0,
      ...options,
    });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    return { fetch, transport, running };
  };

  it("opens a generation per socket, with the token only as a subprotocol", async () => {
    const { transport } = await start();
    const [first] = FakeSocket.all;
    expect(first!.url).toBe(`${base.replace(/^http/, "ws")}/rpc`);
    expect(first!.protocols).toEqual(["abacus-rpc", `abacus-token.${token}`]);
    expect(transport.state).toBe("connecting");
    first!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
    expect(hostConnection.state).toMatchObject({
      stage: "open",
      error: null,
      generation: 1,
    });
  });

  it("replaces a dropped socket with the same token first, then starts over from bootstrap", async () => {
    const { fetch, transport } = await start();
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(transport.generation).toBe(1));
    await vi.advanceTimersByTimeAsync(5_000);
    FakeSocket.all[0]!.close();
    expect(transport.state).toBe("reconnecting");
    await vi.waitFor(() =>
      expect(hostConnection.state.stage).toBe("reconnecting")
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.all).toHaveLength(2);
    // No apps-server call for a reconnect with a fresh token.
    expect(fetch).toHaveBeenCalledTimes(3);
    // That handshake fails: the next attempt re-bootstraps.
    fetch
      .mockResolvedValueOnce(envelope(ready))
      .mockResolvedValueOnce(Response.json(health));
    FakeSocket.all[1]!.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(3));
    expect(fetch.mock.calls[3]![0]).toBe("/api/_bootstrapAbacusBotHost");
    expect(fetch.mock.calls[4]![0]).toBe(`${base}/healthz`);
    FakeSocket.all[2]!.open();
    await vi.waitFor(() => expect(transport.generation).toBe(2));
    expect(transport.state).toBe("open");
  });

  it("counts a socket that drops at once as a failure and re-bootstraps", async () => {
    const { fetch, transport } = await start();
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
    fetch
      .mockResolvedValueOnce(envelope(ready))
      .mockResolvedValueOnce(Response.json(health));
    FakeSocket.all[0]!.close();
    // No same-token retry after 250 ms: the backoff of a first failure.
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    expect(fetch.mock.calls[3]![0]).toBe("/api/_bootstrapAbacusBotHost");
  });

  it("closes the transport for good on a contract mismatch", async () => {
    const { fetch, transport, running } = await start();
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
    fetch
      .mockResolvedValueOnce(envelope(ready))
      .mockResolvedValueOnce(
        Response.json({ ...health, contractVersion: CONTRACT_VERSION - 1 })
      );
    // Dropped at once: the re-bootstrap finds an older host.
    FakeSocket.all[0]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(transport.state).toBe("closed");
    expect(hostConnection.state.error).toMatchObject({ kind: "version" });
  });

  it("stops retrying in a hidden tab after the first failure until it is visible", async () => {
    const { transport } = await start();
    const hidden = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      FakeSocket.all[0]!.dispatchEvent(new Event("error"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.all).toHaveLength(1);
      expect(transport.state).toBe("connecting");
      hidden.mockReturnValue("visible");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(envelope(ready))
          .mockResolvedValueOnce(Response.json(health))
      );
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    } finally {
      hidden.mockRestore();
    }
  });

  it("asks for a restart once, even when the restarted host then fails its first check", async () => {
    const { fetch, transport } = await start({ forceRestart: true });
    expect(JSON.parse(bootstraps(fetch)[0]![1].body)).toEqual({
      deploymentConversationId: "conversation",
      forceRestart: true,
    });
    // The first socket never opens: the next attempt re-bootstraps.
    fetch
      .mockResolvedValueOnce(envelope(ready))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(envelope(ready))
      .mockResolvedValueOnce(Response.json(health));
    FakeSocket.all[0]!.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    expect(bootstraps(fetch)).toHaveLength(3);
    for (const [, init] of bootstraps(fetch).slice(1))
      expect(JSON.parse(init.body)).toEqual({
        deploymentConversationId: "conversation",
      });
    FakeSocket.all[1]!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
  });

  it("never bootstraps from a hidden tab, also after a stable socket whose token expired", async () => {
    const { fetch, transport } = await start();
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
    const hidden = hide();
    try {
      // Open past the token's refresh age, then the pod is reaped.
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      FakeSocket.all[0]!.close();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(bootstraps(fetch)).toHaveLength(1);
      expect(FakeSocket.all).toHaveLength(1);
      fetch
        .mockResolvedValueOnce(envelope(ready))
        .mockResolvedValueOnce(Response.json(health));
      hidden.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
      expect(bootstraps(fetch)).toHaveLength(2);
    } finally {
      hidden.mockRestore();
    }
  });

  it.each([
    ["signin", new Response(null, { status: 401 })],
    [
      "tier",
      Response.json({
        success: false,
        error: "Upgrade",
        errorType: "AbacusBotHostTierRequired",
      }),
    ],
  ])(
    "closes for good on a %s refusal while reconnecting, with no further calls",
    async (kind, refusal) => {
      const { fetch, transport, running } = await start();
      FakeSocket.all[0]!.open();
      await vi.waitFor(() => expect(transport.state).toBe("open"));
      fetch.mockResolvedValueOnce(refusal);
      // Dropped at once: the next attempt re-bootstraps and is refused.
      FakeSocket.all[0]!.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await running;
      expect(transport.state).toBe("closed");
      expect(hostConnection.state.error).toMatchObject({ kind });
      const calls = fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch.mock.calls.length).toBe(calls);
      expect(FakeSocket.all).toHaveLength(1);
    }
  );

  it("treats a policy close (1008) as a refusal: closed for good, reload offered", async () => {
    const { fetch, transport, running } = await start();
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
    FakeSocket.all[0]!.closeWith(1008);
    await running;
    expect(transport.state).toBe("closed");
    expect(hostConnection.state.error).toMatchObject({ kind: "reload" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([1009, 1013])(
    "backs off after a %i close and keeps the token",
    async (code) => {
      const { fetch, transport } = await start();
      FakeSocket.all[0]!.open();
      await vi.waitFor(() => expect(transport.state).toBe("open"));
      await vi.advanceTimersByTimeAsync(6_000);
      FakeSocket.all[0]!.closeWith(code);
      // Not the 250 ms of a plain drop: the backoff of a failure.
      await vi.advanceTimersByTimeAsync(400);
      expect(FakeSocket.all).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
      expect(bootstraps(fetch)).toHaveLength(1);
      expect(transport.closeCode(1)).toBe(code);
    }
  );

  it("makes a repeated identity mismatch final", async () => {
    const { fetch, transport, running } = await start();
    const mismatch = () =>
      fetch
        .mockResolvedValueOnce(envelope(ready))
        .mockResolvedValueOnce(Response.json({ ...health, owner: "other" }));
    mismatch();
    mismatch();
    mismatch();
    FakeSocket.all[0]!.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(60_000);
    await running;
    expect(transport.state).toBe("closed");
    expect(hostConnection.state.error).toMatchObject({ kind: "reload" });
    expect(bootstraps(fetch)).toHaveLength(4);
  });

  it("drops a socket that accepts calls but never answers, on the 30 s probe and on coming online", async () => {
    const { fetch, transport } = await start();
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
    // The probe is sent, and never answered.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.all[0]!.send).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe("open");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.closeCode(1)).toBe(4000);
    // Reconnected with the same token, after the backoff of a failure.
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    expect(bootstraps(fetch)).toHaveLength(1);
    FakeSocket.all[1]!.open();
    await vi.waitFor(() => expect(transport.generation).toBe(2));
    // Coming back online probes at once.
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.closeCode(2)).toBe(4000);
    // A second unresponsive socket in a row waits longer still.
    await vi.advanceTimersByTimeAsync(900);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(3));
  });

  it("keeps a socket that answers the probe late but keeps delivering frames", async () => {
    const { transport } = await start();
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
    // Busy, not dead: a frame every few seconds, the probe never answered.
    for (let second = 0; second < 90; second += 5) {
      await vi.advanceTimersByTimeAsync(5_000);
      FakeSocket.all[0]!.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ i: "999", p: { s: 200 } }),
        })
      );
    }
    expect(transport.state).toBe("open");
    expect(transport.generation).toBe(1);
    expect(transport.closeCode(1)).toBeUndefined();
  });

  it("waits for a closing socket's close event before opening the next one", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(envelope(host))
      .mockResolvedValueOnce(envelope(ready))
      .mockResolvedValueOnce(Response.json(health));
    vi.stubGlobal("fetch", fetch);
    const identity = await identifyHost();
    const transport = createHostTransport({ flowControl: false });
    transports.push(transport);
    void runHostConnection(transport, identity, {
      WebSocket: SlowCloseSocket as unknown as typeof WebSocket,
      random: () => 0,
    });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(transport.state).toBe("open"));
    await vi.advanceTimersByTimeAsync(6_000);
    FakeSocket.all[0]!.close();
    const abort = new AbortController();
    void transport.client.system
      .info({}, { signal: abort.signal })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    // CLOSING: nothing sent, no second socket yet.
    expect(FakeSocket.all[0]!.send).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    FakeSocket.all[1]!.open();
    await vi.waitFor(() => expect(FakeSocket.all[1]!.send).toHaveBeenCalled());
    abort.abort();
  });

  it("disables Retry while an attempt is in flight", async () => {
    const { fetch } = await start();
    expect(hostConnection.state.attempting).toBe(true);
    fetch.mockResolvedValueOnce(new Response(null, { status: 502 }));
    FakeSocket.all[0]!.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(hostConnection.state.attempting).toBe(false));
  });
});

it("sets up the bot account through the apps server before the identity step", async () => {
  const fetch = vi.fn().mockResolvedValue(envelope(null));
  vi.stubGlobal("fetch", fetch);
  await setUpBotAccount();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/_setUpAbacusaibotWebAccount",
  ]);
  expect(fetch.mock.calls[0]![1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    headers: { "REAI-UI": "1" },
  });
});
it("a signed-out bot account setup is the sign-in refusal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json(
        {
          success: false,
          error: "User not logged in",
          errorType: "NotLoggedInError",
        },
        { status: 200 }
      )
    )
  );
  await expect(setUpBotAccount()).rejects.toMatchObject({
    kind: "signin",
    message: "User not logged in",
  });
});
it("an apps server without the setup step leaves the boot to the identity step", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ success: false, error: "Not found" }, { status: 404 })
      )
  );
  await expect(setUpBotAccount()).resolves.toBeUndefined();
});
it("any other bot account setup failure stops the boot", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          {
            success: false,
            error: "Internal error",
            errorType: "InternalError",
          },
          { status: 500 }
        )
      )
  );
  await expect(setUpBotAccount()).rejects.toMatchObject({
    kind: "connection",
    status: 500,
  });
});
