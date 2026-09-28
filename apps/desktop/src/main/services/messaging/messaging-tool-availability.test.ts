/**
 * Connecting a platform mid-conversation has to put its tools in front of the
 * agent that is waiting for them.
 *
 * `send_chat_message`, `list_chats` and `read_chat_messages` are withheld from
 * `tools/list` while no platform is running, and a session keeps the list it
 * was handed when it started. So a bot that asked the user to connect WhatsApp,
 * and was told it was connected, still had no send tool, and said so. The
 * environment note was already correct and made no difference: words the model
 * reads are not the same as a `tools/list` running again.
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
  isPlatformEnabled: (id: MessagingPlatformId) => id === "whatsapp",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "whatsapp",
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const build = (
  onToolAvailabilityChanged: () => void
): InstanceType<typeof MessagingGatewayService> =>
  new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    onToolAvailabilityChanged,
  } as never);

/** A connector that starts cleanly and stays up. */
const fakeConnector = (): unknown => ({
  start: async () => {},
  stop: async () => {},
  sendText: async () => {},
});

describe("tool availability as platforms come and go", () => {
  it("announces the change as soon as the platform is running", async () => {
    const changed = vi.fn();
    const service = build(changed);
    (service as any).buildConnector = () => fakeConnector();

    await service.syncConnectors();

    expect(service.runningPlatforms()).toContain("whatsapp");
    expect(changed).toHaveBeenCalled();
  });

  /**
   * On registration rather than on `connected`: the set the tool gate reads is
   * the connector map, so the tools become listable the moment it is populated.
   * Announcing only on a successful handshake would leave the gap open for the
   * whole of a slow connect.
   */
  it("announces it before the connection has finished coming up", async () => {
    const changed = vi.fn();
    const service = build(changed);
    (service as any).buildConnector = () => ({
      start: () => new Promise<void>(() => {}),
      stop: async () => {},
      sendText: async () => {},
    });

    await service.syncConnectors();

    expect(changed).toHaveBeenCalled();
  });

  it("announces it again when the platform goes away", async () => {
    const changed = vi.fn();
    const service = build(changed);
    (service as any).buildConnector = () => fakeConnector();

    await service.syncConnectors();
    changed.mockClear();
    await service.dispose();

    expect(service.runningPlatforms()).not.toContain("whatsapp");
    expect(changed).toHaveBeenCalled();
  });
});
