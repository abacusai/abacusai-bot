/**
 * A connector that has been stopped must go quiet.
 *
 * Stopping one does not silence it. Its handshake is still in flight, its
 * socket has frames queued, its long poll is parked on a response, and every
 * callback names only the platform, so a superseded connector could report
 * itself connected, overwrite a newer attempt's state with its own failure, or
 * hand the agent a message from a platform the user had switched off.
 *
 * The window was small while `startPlatform` awaited the handshake. It is not
 * small any more, which is what makes this worth pinning.
 */
import { describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

let enabled = true;

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
  }),
  isPlatformEnabled: (id: MessagingPlatformId) => id === "discord" && enabled,
  isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

type Callbacks = {
  onState: (state: string, error?: string) => void;
  onMessage: (message: {
    userId: string;
    userName: string | null;
    chatId: string;
    text: string;
  }) => void;
  onLog: (line: string) => void;
};

/** Builds a connector that hands its callbacks back, so a test can fire them late. */
const service = (): {
  gateway: InstanceType<typeof MessagingGatewayService>;
  captured: Callbacks[];
  inbound: string[];
} => {
  const captured: Callbacks[] = [];
  const inbound: string[] = [];

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: (_w: string, _s: string, message: string) =>
      inbound.push(message),
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

  const build = (
    gateway as unknown as {
      buildConnector: (id: MessagingPlatformId) => unknown;
    }
  ).buildConnector.bind(gateway);
  (
    gateway as unknown as {
      buildConnector: (id: MessagingPlatformId) => unknown;
    }
  ).buildConnector = (id: MessagingPlatformId) => {
    // Reuse the real callback wiring; the generation stamp is what is under
    // test, and rebuilding it here would test the test.
    const real = build(id) as { callbacks?: Callbacks };
    const callbacks = (real as unknown as { callbacks: Callbacks }).callbacks;
    captured.push(callbacks);
    return {
      id,
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      callbacks,
    };
  };

  return { gateway, captured, inbound };
};

const platformState = (
  gateway: InstanceType<typeof MessagingGatewayService>
): string | undefined =>
  gateway.getSnapshot().platforms.find((platform) => platform.id === "discord")
    ?.state;

describe("a connector that has been stopped", () => {
  it("cannot report itself connected afterwards", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    const stopped = captured[0]!;

    await gateway.dispose();

    // The late arrival: its handshake finished after the stop.
    stopped.onState("connected");

    // Still enabled in config, so nothing else would mask a wrong answer here.
    expect(platformState(gateway)).not.toBe("connected");
  });

  it("cannot overwrite the state of the attempt that replaced it", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    const first = captured[0]!;

    // Credentials changed: the old connector is retired and a new one starts.
    await gateway.dispose();
    await gateway.syncConnectors();
    const second = captured[1]!;
    second.onState("connected");

    first.onState("error", "stale failure from the old connector");

    expect(platformState(gateway)).toBe("connected");
    const discord = gateway
      .getSnapshot()
      .platforms.find((platform) => platform.id === "discord");
    expect(discord?.errorMessage).toBeNull();
  });

  it("cannot deliver a message into routing", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    const stopped = captured[0]!;

    // Spied at the routing boundary rather than at sendMessage. A message that
    // reaches handleInbound has already escaped the guard: whether it then
    // finds a workspace to run in is a different question, and asserting on
    // that would pass for the wrong reason in a gateway with none configured.
    const routed: string[] = [];
    (
      gateway as unknown as {
        handleInbound: (id: string, m: { text: string }) => Promise<void>;
      }
    ).handleInbound = async (_id, message) => {
      routed.push(message.text);
    };

    await gateway.dispose();
    stopped.onMessage({
      userId: "U1",
      userName: "Someone",
      chatId: "C1",
      text: "still listening?",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(routed).toEqual([]);
  });
});

describe("a disabled platform", () => {
  it("does not keep showing the error it failed with", async () => {
    const { gateway, captured } = service();
    await gateway.syncConnectors();
    captured[0]!.onState("error", "invalid app token");

    const failing = gateway
      .getSnapshot()
      .platforms.find((platform) => platform.id === "discord");
    expect(failing?.errorMessage).toBe("invalid app token");

    // Switched off. The red box used to stay, describing a connection nothing
    // is attempting any more.
    enabled = false;
    try {
      const off = gateway
        .getSnapshot()
        .platforms.find((platform) => platform.id === "discord");
      expect(off?.state).toBe("disabled");
      expect(off?.errorMessage).toBeNull();
    } finally {
      enabled = true;
    }
  });
});
