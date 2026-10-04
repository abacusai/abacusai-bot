import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";
import { afterEach, expect, it, vi } from "vitest";

import serverFixtures from "./fixtures/bootstrap-server.json";
import { callApps, resolveBrowserHost, refreshUploadToken } from "./services";
const ready = serverFixtures.find(
  (fixture) => fixture.result.status === "ready"
)!.result;
const token = ready.token!;
const envelope = (result: unknown) => Response.json({ success: true, result });
const host = {
  deploymentConversationId: "conversation",
  previewHost: "pod.preview.apps.abacus.ai",
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
    url: `wss://${host.previewHost}/rpc`,
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
    `https://${host.previewHost}/healthz`,
    `https://${host.previewHost}/healthz`,
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
  expect(fetch.mock.calls[3]![1]).toEqual({ credentials: "include" });
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
it("offers restart only for contract mismatch and refuses the wrong owner", async () => {
  for (const [body, kind] of [
    [{ ...health, contractVersion: CONTRACT_VERSION + 1 }, "version"],
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
