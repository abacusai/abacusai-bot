import { CONTRACT_VERSION } from "@abacus-ai/contract/contract";
import { afterEach, expect, it, vi } from "vitest";

import { ConnectError, resolveBrowserHost, callApps } from "./services";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("connects in service order, retries proxy denial, and retains the owner token", async () => {
  vi.useFakeTimers();
  const token = btoa(JSON.stringify({ o: "owner" })) + ".signature";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        deploymentConversationId: "conversation",
        previewHost: "pod.preview.apps.abacus.ai",
      })
    )
    .mockResolvedValueOnce(Response.json({ status: "STARTING" }))
    .mockResolvedValueOnce(Response.json({ status: "ACTIVE" }))
    .mockResolvedValueOnce(
      Response.json({
        token,
        previewHost: "pod.preview.apps.abacus.ai",
        version: "1",
      })
    )
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        owner: "owner",
        contractVersion: CONTRACT_VERSION,
      })
    );
  vi.stubGlobal("fetch", fetch);
  const stage = vi.fn();
  const pending = resolveBrowserHost(stage, true);
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({
    url: "wss://pod.preview.apps.abacus.ai/rpc",
    token,
  });
  expect(stage.mock.calls.flat()).toEqual([
    "starting",
    "installing",
    "connecting",
  ]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://apps.abacus.ai/api/_getOrCreateAbacusBotHost",
    "https://apps.abacus.ai/api/_getChatLLMComputer",
    "https://apps.abacus.ai/api/_getChatLLMComputer",
    "https://apps.abacus.ai/api/_bootstrapAbacusBotHost",
    "https://pod.preview.apps.abacus.ai/healthz",
    "https://pod.preview.apps.abacus.ai/healthz",
  ]);
  expect(JSON.parse(fetch.mock.calls[3]![1].body)).toMatchObject({
    forceRestart: true,
  });
  expect(fetch.mock.calls[4]![1]).toEqual({ credentials: "include" });
});
it("only service failures select sign-in or upgrade", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
  );
  await expect(callApps("getOrCreateAbacusBotHost", {})).rejects.toMatchObject({
    kind: "signin",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
  );
  await expect(callApps("getOrCreateAbacusBotHost", {})).rejects.toBeInstanceOf(
    ConnectError
  );
});
it("offers an explicit restart on version mismatch", async () => {
  const token = btoa(JSON.stringify({ o: "owner" })) + ".signature";
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          deploymentConversationId: "conversation",
          previewHost: "pod",
        })
      )
      .mockResolvedValueOnce(Response.json({ status: "ACTIVE" }))
      .mockResolvedValueOnce(
        Response.json({ token, previewHost: "pod", version: "1" })
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          owner: "owner",
          contractVersion: CONTRACT_VERSION + 1,
        })
      )
  );
  await expect(resolveBrowserHost(() => {})).rejects.toMatchObject({
    kind: "version",
  });
});
