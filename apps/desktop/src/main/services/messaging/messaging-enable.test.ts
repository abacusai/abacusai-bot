/**
 * Turning a messaging platform on must not wait for it to connect.
 *
 * Every connector's `start()` opens a real connection: SMTP verify plus IMAP
 * login, Slack's auth.test, Discord's /users/@me. That was awaited through
 * syncConnectors into the IPC call behind the enable toggle, and the toggle
 * disables itself while that call is in flight. A slow handshake left it
 * unusable; a host that never answered left it that way for good, which is the
 * "disable a connector and then you cannot turn it back on" report.
 */
import { describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) => id === "discord",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

/** Only the members the gateway touches; the rest of the options are unused here. */
const gateway = (): InstanceType<typeof MessagingGatewayService> =>
  new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

/** A connector whose start never settles: a host that accepts and says nothing. */
const hangingConnector = (): { started: boolean; connector: unknown } => {
  const state = { started: false };
  return {
    get started() {
      return state.started;
    },
    connector: {
      start: () => {
        state.started = true;
        return new Promise<void>(() => {});
      },
      stop: async () => {},
      sendText: async () => {},
    },
  };
};

describe("enabling a platform", () => {
  it("returns without waiting for the connection to come up", async () => {
    const service = gateway();
    const fake = hangingConnector();
    (service as any).buildConnector = () => fake.connector;

    // The regression: this never resolved while start() was pending, so the
    // IPC behind the toggle never answered and the toggle stayed disabled.
    await expect(
      Promise.race([
        service.syncConnectors(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("syncConnectors blocked on start()")),
            1_000
          )
        ),
      ])
    ).resolves.toBeUndefined();

    expect(fake.started).toBe(true);
  });

  it("reports the platform as connecting while it is still connecting", async () => {
    const service = gateway();
    const fake = hangingConnector();
    (service as any).buildConnector = () => fake.connector;

    await service.syncConnectors();

    const discord = service
      .getSnapshot()
      .platforms.find((platform) => platform.id === "discord");
    expect(discord?.enabled).toBe(true);
    expect(discord?.state).toBe("connecting");
  });

  it("can be switched off again while the connection is still pending", async () => {
    // The point of not blocking: the user is never stuck waiting on a handshake
    // that may never finish.
    const service = gateway();
    const fake = hangingConnector();
    (service as any).buildConnector = () => fake.connector;

    await service.syncConnectors();
    await expect(service.dispose()).resolves.toBeUndefined();
  });
});
