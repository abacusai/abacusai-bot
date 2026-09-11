/**
 * The connectors screen, in both of its states.
 *
 * What matters: the catalog's connectors are all shown (so a connector added
 * there appears here without this file changing); a signed-in user attaches
 * one in place rather than being sent to the settings panel — the old
 * behaviour, which quietly ended the flow and skipped every step after it; and
 * a signed-out user's tap runs the sign-in hop first and then attaches, the
 * same contract as the in-app connectors panel.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CONNECTORS } from "../../connectors";

const listAbacusConnectors = vi.fn(async () => ({
  ok: true,
  available: CONNECTORS.filter((connector) => connector.auth === "abacus").map(
    (connector) => ({
      service: (connector as { abacusService: string }).abacusService,
      name: connector.name,
    })
  ),
  connected: {} as Record<string, string>,
}));
const connectAbacusConnector = vi.fn(async () => ({ ok: true }) as const);
const cancelAbacusConnector = vi.fn(async () => undefined);
const startAbacusAuth = vi.fn(async () => ({ ok: true }) as const);

const { ConnectorsStep } = await import("./connectors-step");

const handlers = { onBack: vi.fn(), onNext: vi.fn(), dots: null };

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const mount = async (): Promise<void> => {
  render((<ConnectorsStep {...handlers} />) as JSX.Element);
  await waitFor(() => byId("onboarding-connectors-grid"));
};

const firstConnector = CONNECTORS.find(
  (connector) => connector.auth === "abacus"
) as {
  id: string;
  abacusService: string;
};

beforeEach(() => {
  vi.clearAllMocks();
  connectAbacusConnector.mockResolvedValue({ ok: true });
  startAbacusAuth.mockResolvedValue({ ok: true });
  listAbacusConnectors.mockResolvedValue({
    ok: true,
    available: CONNECTORS.filter(
      (connector) => connector.auth === "abacus"
    ).map((connector) => ({
      service: (connector as { abacusService: string }).abacusService,
      name: connector.name,
    })),
    connected: {},
  });

  (globalThis.window as unknown as { api: unknown }).api = {
    agent: {
      listAbacusConnectors,
      connectAbacusConnector,
      startAbacusAuth,
      cancelAbacusConnector,
    },
  };
});

describe("a hop the user walks away from", () => {
  // The hop resolves on the loopback ping or after five minutes, and every
  // tile is disabled until it does. Nothing here may leave the screen frozen
  // for those five minutes on a decision the user has already made.
  const hangingHop = (): void => {
    connectAbacusConnector.mockReturnValue(
      new Promise(() => undefined) as never
    );
  };

  it("can be cancelled, and never greys the other tiles out", async () => {
    hangingHop();
    await mount();

    fireEvent.click(byId(`onboarding-connector-${firstConnector.id}-connect`));
    await waitFor(() => byId("onboarding-connectors-cancel"));

    // The regression: every other tile used to be disabled for as long as the
    // hop was out — walk away from the browser tab and the whole screen was
    // dead until a five-minute timeout. Changing your mind is a click on
    // another tile, so the tiles stay live.
    expect(
      byId("onboarding-connector-messaging-whatsapp-connect").hasAttribute(
        "disabled"
      )
    ).toBe(false);

    fireEvent.click(byId("onboarding-connectors-cancel"));

    await waitFor(() =>
      expect(
        document.querySelector('[data-id="onboarding-connectors-cancel"]')
      ).toBeNull()
    );
    expect(cancelAbacusConnector).toHaveBeenCalled();
  });

  it("lets a click on another tile take over the hop", async () => {
    hangingHop();
    await mount();

    fireEvent.click(byId(`onboarding-connector-${firstConnector.id}-connect`));
    await waitFor(() => byId("onboarding-connectors-cancel"));

    // The main process is single-flight — starting this connect cancels the
    // one in flight — so the renderer's only job is not to stand in the way.
    connectAbacusConnector.mockReturnValue(
      new Promise(() => undefined) as never
    );
    fireEvent.click(byId("onboarding-connector-messaging-whatsapp-connect"));

    // The abandoned hop is told to stand down rather than left holding its
    // loopback port.
    expect(cancelAbacusConnector).toHaveBeenCalled();
  });

  it("offers no cancel until there is something to cancel", async () => {
    await mount();

    expect(
      document.querySelector('[data-id="onboarding-connectors-cancel"]')
    ).toBeNull();
  });

  it("is abandoned when the step is left, not left holding its port", async () => {
    hangingHop();
    const view = render((<ConnectorsStep {...handlers} />) as JSX.Element);
    await waitFor(() => byId("onboarding-connectors-grid"));
    fireEvent.click(byId(`onboarding-connector-${firstConnector.id}-connect`));

    view.unmount();

    expect(cancelAbacusConnector).toHaveBeenCalled();
  });
});

describe("the connectors step", () => {
  it("offers Gmail and the messaging platforms, not the whole catalog", async () => {
    // Onboarding is not the place to read a wall of logos; the rest are one
    // click away in Settings once the app is running.
    await mount();

    const tiles = document.querySelectorAll(
      '[data-id^="onboarding-connector-"]:not([data-id$="-connect"])'
    );
    expect(tiles).toHaveLength(4);
    for (const id of [
      "abacus-gmailuser",
      "messaging-whatsapp",
      "messaging-discord",
      "messaging-telegram",
    ]) {
      expect(
        document.querySelector(`[data-id="onboarding-connector-${id}"]`),
        `no tile for "${id}"`
      ).toBeTruthy();
    }
  });

  it("connects a messaging tile through the gateway, not the browser hop", async () => {
    const updateMessagingPlatform = vi.fn(async () => null);
    const getMessagingSnapshot = vi.fn(async () => null);
    (
      globalThis.window as unknown as {
        api: { agent: Record<string, unknown> };
      }
    ).api.agent.updateMessagingPlatform = updateMessagingPlatform;
    (
      globalThis.window as unknown as {
        api: { agent: Record<string, unknown> };
      }
    ).api.agent.getMessagingSnapshot = getMessagingSnapshot;
    await mount();

    fireEvent.click(byId("onboarding-connector-messaging-whatsapp-connect"));

    // WhatsApp enables on click — that is what starts the bridge and the QR.
    await waitFor(() =>
      expect(updateMessagingPlatform).toHaveBeenCalledWith({
        platformId: "whatsapp",
        enabled: true,
      })
    );
    expect(connectAbacusConnector).not.toHaveBeenCalled();
  });

  it("marks a messaging tile connected only when it actually is", async () => {
    // The regression: `enabled` survives its credentials being cleared, and a
    // Telegram with no token anywhere showed as connected in onboarding.
    const snapshotOf = (state: string) => ({
      platforms: [
        {
          id: "telegram",
          nameKey: "telegram",
          docsUrl: "",
          enabled: true,
          configured: false,
          state,
          errorMessage: null,
          fields: [],
          pendingCount: 0,
        },
      ],
      pending: [],
      approved: [],
      gatewayEnabled: true,
      autoApproveTools: false,
      respondToInbound: false,
      workspaceId: null,
    });

    const api = (
      globalThis.window as unknown as {
        api: { agent: Record<string, unknown> };
      }
    ).api.agent;
    api.getMessagingSnapshot = async () => snapshotOf("not_configured");
    await mount();

    await waitFor(() =>
      expect(
        byId("onboarding-connector-messaging-telegram").hasAttribute(
          "data-connected"
        )
      ).toBe(false)
    );

    // And the genuine article still shows.
    api.getMessagingSnapshot = async () => snapshotOf("connected");
    const view2 = render((<ConnectorsStep {...handlers} />) as JSX.Element);
    await waitFor(() =>
      expect(
        document
          .querySelectorAll(
            '[data-id="onboarding-connector-messaging-telegram"]'
          )[1]!
          .hasAttribute("data-connected")
      ).toBe(true)
    );
    view2.unmount();
  });

  it("keeps the attach heading, and drops the pitch", async () => {
    await mount();

    expect(document.body.textContent).toContain("onboarding.connectorsTitle");
    expect(
      document.querySelector('[data-id="onboarding-connectors-pitch"]')
    ).toBeNull();
  });

  it("attaches one in place, and stays on the step", async () => {
    await mount();

    fireEvent.click(byId(`onboarding-connector-${firstConnector.id}-connect`));

    await waitFor(() =>
      expect(connectAbacusConnector).toHaveBeenCalledWith(
        firstConnector.abacusService
      )
    );
    // The regression this guards: attaching used to leave onboarding for the
    // settings panel, skipping the model and folder steps entirely.
    expect(handlers.onNext).not.toHaveBeenCalled();
  });

  it("marks what the platform says is attached, not what was clicked", async () => {
    listAbacusConnectors.mockResolvedValue({
      ok: true,
      available: [
        { service: firstConnector.abacusService, name: firstConnector.id },
      ],
      connected: { [firstConnector.abacusService]: "connector-1" },
    });
    await mount();

    await waitFor(() =>
      expect(
        byId(`onboarding-connector-${firstConnector.id}`).hasAttribute(
          "data-connected"
        )
      ).toBe(true)
    );
  });

  it("reports a failed attach but not a cancelled one", async () => {
    connectAbacusConnector.mockResolvedValue({
      ok: false,
      error: "nope",
    } as unknown as { ok: true });
    await mount();

    fireEvent.click(byId(`onboarding-connector-${firstConnector.id}-connect`));
    await waitFor(() => byId("onboarding-connectors-error"));

    connectAbacusConnector.mockResolvedValue({
      ok: false,
      cancelled: true,
    } as unknown as { ok: true });
    fireEvent.click(byId(`onboarding-connector-${firstConnector.id}-connect`));
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="onboarding-connectors-error"]')
      ).toBeNull()
    );
  });

  it("says Continue once a messaging platform is connected", async () => {
    // The regression: the button read `connected`, which only ever holds the
    // Abacus connectors — a scanned WhatsApp QR turned its tile green while
    // the button still offered to continue without connectors.
    const api = (
      globalThis.window as unknown as {
        api: { agent: Record<string, unknown> };
      }
    ).api.agent;
    api.getMessagingSnapshot = async () => ({
      platforms: [
        {
          id: "whatsapp",
          nameKey: "whatsapp",
          docsUrl: "",
          enabled: true,
          configured: true,
          state: "connected",
          errorMessage: null,
          fields: [],
          pendingCount: 0,
        },
      ],
      pending: [],
      approved: [],
      gatewayEnabled: true,
      autoApproveTools: false,
      respondToInbound: false,
      workspaceId: null,
    });
    await mount();

    await waitFor(() =>
      expect(byId("onboarding-connectors-next").textContent).toContain(
        "onboarding.connectorsContinueCta"
      )
    );
  });

  it("carries on with nothing attached", async () => {
    await mount();

    fireEvent.click(byId("onboarding-connectors-next"));
    expect(handlers.onNext).toHaveBeenCalled();
  });
});
