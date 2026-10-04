import { CONNECTORS } from "@abacus-ai/connectors/registry";
import type { MessagingSnapshot } from "@abacus-ai/contract/messaging";
import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";

import type { Db } from "#renderer/data/db";
import type { Transport } from "#renderer/data/transport";

import {
  CONNECT_WATCHDOG_MS,
  connectPlatform,
  createConnectFlow,
} from "./connect-flow";
const snapshot = {
  gatewayEnabled: false,
  platforms: [],
  autoReplies: [],
  pendingRequests: [],
} as unknown as MessagingSnapshot;
const setup = () => {
  const calls: string[] = [];
  const updateSettings = vi.fn(async () => {
    calls.push("gateway");
    return { ...snapshot, gatewayEnabled: true };
  });
  const updatePlatform = vi.fn(
    async (input: { platformId: string; enabled: boolean }) => {
      calls.push(`${input.platformId}:${input.enabled}`);
      return { ...snapshot, gatewayEnabled: true };
    }
  );
  const snapshotCall = vi.fn(async () => {
    calls.push("snapshot");
    return snapshot;
  });
  const key = ["messaging", "snapshot"];
  const transport = {
    client: {
      messaging: { snapshot: snapshotCall, updateSettings, updatePlatform },
      connectors: { cancelConnect: vi.fn(), statuses: vi.fn(async () => ({})) },
      mcp: { refresh: vi.fn() },
    },
    orpc: {
      messaging: {
        snapshot: {
          queryKey: () => key,
          queryOptions: () => ({ queryKey: key, queryFn: snapshotCall }),
        },
      },
      connectors: { statuses: { queryKey: () => ["connectors"] } },
    },
  } as unknown as Transport;
  const updatePrefs = vi.fn(async () => undefined);
  const db = {
    collections: {
      sessions: { toArray: [] },
      prefs: { get: () => ({ onboardingPairing: [] }) },
    },
    updatePrefs,
  } as unknown as Db;
  return {
    calls,
    transport,
    db,
    updatePrefs,
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false } },
    }),
    navigate: vi.fn(async () => undefined),
  };
};
describe("connection lifecycle", () => {
  it("R5-T16 awaits gateway activation before platform activation", async () => {
    const d = setup();
    await connectPlatform(d, "whatsapp");
    expect(d.calls).toEqual(["snapshot", "gateway", "whatsapp:true"]);
  });
  it("R5-T17 deferred pairing persists a queue and does not navigate", async () => {
    const d = setup();
    const flow = createConnectFlow(d);
    const entry = CONNECTORS.find(
      (e) => e.kind === "messaging" && e.platform === "whatsapp"
    )!;
    expect(await flow.start(entry.id, { pairing: "defer" })).toEqual({
      ok: true,
    });
    expect(d.updatePrefs).toHaveBeenCalledWith({
      onboardingPairing: ["whatsapp"],
    });
    expect(d.navigate).not.toHaveBeenCalled();
  });
  it("R5-T17 sheet cancellation settles exactly once and disables an unlinked platform", async () => {
    const d = setup();
    const flow = createConnectFlow(d);
    const entry = CONNECTORS.find(
      (e) => e.kind === "messaging" && e.platform === "whatsapp"
    )!;
    const pending = flow.start(entry.id);
    await vi.waitFor(() => expect(d.navigate).toHaveBeenCalledWith("whatsapp"));
    await Promise.all([
      flow.settlePairing("whatsapp"),
      flow.settlePairing("whatsapp"),
    ]);
    expect(await pending).toEqual({
      ok: false,
      cancelled: true,
      error: "not-linked",
    });
    expect(d.calls.filter((c) => c === "whatsapp:false")).toHaveLength(1);
  });
});

it("R5-T16 pairing watchdog settles the pending caller and disables its platform", async () => {
  vi.useFakeTimers();
  try {
    const d = setup();
    const flow = createConnectFlow(d);
    const entry = CONNECTORS.find(
      (e) => e.kind === "messaging" && e.platform === "whatsapp"
    )!;
    const pending = flow.start(entry.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.navigate).toHaveBeenCalledWith("whatsapp");
    await vi.advanceTimersByTimeAsync(180000);
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
    expect(d.calls).toContain("whatsapp:false");
    expect(flow.store.state.error).toBe("timeout");
  } finally {
    vi.useRealTimers();
  }
});

it("a two-platform route transition settles deferred setup without cancelling its replacement", async () => {
  vi.useFakeTimers();
  try {
    const d = setup();
    const flow = createConnectFlow(d);
    const entry = CONNECTORS.find(
      (e) => e.kind === "messaging" && e.platform === "whatsapp"
    )!;
    const pending = flow.start(entry.id);
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    void flow.registerPairing("whatsapp", () => ready);
    await vi.advanceTimersByTimeAsync(CONNECT_WATCHDOG_MS - 1000);
    const cleanup = flow.settlePairing("whatsapp");
    await flow.registerPairing("telegram", async () => {});
    release();
    await cleanup;
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
    expect(d.calls.filter((call) => call === "whatsapp:false")).toHaveLength(1);
    expect(d.calls).not.toContain("telegram:false");
    expect(flow.store.state).toMatchObject({
      connectorId: "telegram",
      phase: "pairing",
    });
    await flow.settlePairing("telegram");
    d.queryClient.clear();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
