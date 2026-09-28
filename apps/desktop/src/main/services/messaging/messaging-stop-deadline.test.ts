/**
 * Saving a connector must not wait for another connector to shut down.
 *
 * `stop()` is awaited through syncConnectors into the IPC call behind the Save
 * button and the enable toggle, and the pane disables both while that call is
 * in flight. Nothing bounded that await, so one connector whose stop() never
 * settled parked every save on the pane, including saves for other platforms,
 * because syncConnectors sweeps the whole catalog and evicts any connector
 * sitting in `error` before deciding what to run.
 *
 * The case that found it was the email connector, since removed: its IMAP
 * `logout()` waited on a reply a half-open socket (a NAT timeout, a
 * sleep/wake, a network switch) would never send, and nothing threw because
 * the socket was not `destroyed`. That is the "Slack connector is on saving
 * state for a long time" report, and the same one again for Telegram: the
 * platform being saved was never the one that was stuck. Any connector can
 * hang that way, which is why the deadline is the gateway's rather than one
 * connector's; a stuck Discord stands in for it here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) =>
    id === "discord" || id === "telegram",
  isPlatformConfigured: (id: MessagingPlatformId) =>
    id === "discord" || id === "telegram",
  savePlatformValues: () => {},
  setPlatformEnabled: () => {},
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

/** Longer than STOP_DEADLINE_MS, so the deadline is what ends the wait. */
const PAST_THE_DEADLINE_MS = 10_000;

type Service = InstanceType<typeof MessagingGatewayService>;

/** Every platform comes up fine and then never finishes shutting down. */
const gateway = (): Service => {
  const service = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

  (service as any).buildConnector = (id: MessagingPlatformId) => ({
    start: async () => (service as any).setState(id, "connected"),
    stop: () => new Promise<void>(() => {}),
    sendText: async () => {},
  });

  return service;
};

/** Whether a promise has settled, without waiting on it. */
const settled = async (work: Promise<unknown>): Promise<boolean> => {
  const pending = Symbol("pending");
  return (await Promise.race([work, Promise.resolve(pending)])) !== pending;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a connector that will not stop", () => {
  it("does not park a save for a different platform", async () => {
    const service = gateway();
    await service.syncConnectors();

    // Email drops its connection and the retry fails: still in the connectors
    // map, now reporting `error`. The next sync evicts it before anything else.
    (service as any).setState("discord", "error", "IMAP connection closed");

    // The regression: this never resolved, so the IPC behind Save never
    // answered and the pane sat on "Saving…" with the changes still unsaved.
    const save = service.updatePlatform({
      platformId: "telegram",
      values: { botToken: "xoxb-new" },
    });
    expect(await settled(save)).toBe(false);

    await vi.advanceTimersByTimeAsync(PAST_THE_DEADLINE_MS);
    await expect(save).resolves.toBeDefined();
  });

  it("does not park a save for the platform that is stuck", async () => {
    const service = gateway();
    await service.syncConnectors();

    // New credentials under a live connector restart it, so this awaits the
    // stuck stop() directly rather than through the eviction sweep.
    const save = service.updatePlatform({
      platformId: "discord",
      values: { password: "new-app-password" },
    });
    await vi.advanceTimersByTimeAsync(PAST_THE_DEADLINE_MS);

    await expect(save).resolves.toBeDefined();
  });

  it("abandons the connector rather than leaving it owning the platform", async () => {
    const service = gateway();
    await service.syncConnectors();
    const stuck = (service as any).connectors.get("discord");

    const save = service.updatePlatform({
      platformId: "discord",
      values: { password: "new-app-password" },
    });
    await vi.advanceTimersByTimeAsync(PAST_THE_DEADLINE_MS);
    await save;

    // The point of the restart is that the new credentials get used. Giving up
    // on the old connector has to hand the platform over rather than leave the
    // stuck one owning it, or the save changes nothing.
    const running = (service as any).connectors.get("discord");
    expect(running).toBeDefined();
    expect(running).not.toBe(stuck);
  });
});
