/**
 * The connectors screen, in both of its states.
 *
 * What matters: the registry's connectors are all shown (so a connector added
 * there appears here without this file changing); a signed-in user attaches
 * one in place rather than being sent to the settings panel — the old
 * behaviour, which quietly ended the flow and skipped every step after it; and
 * a signed-out user's tap runs the sign-in hop first and then attaches, the
 * same contract as the in-app connectors panel.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatuses } from "#shared/contracts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CONNECTORS } from "../../connectors";

let statuses: ConnectorStatuses;
const listConnectorStatuses = vi.fn(async () => statuses);
const connectConnector = vi.fn(async (_id: string) => ({ ok: true }) as const);
const cancelConnectorConnect = vi.fn(async () => undefined);
const startAbacusAuth = vi.fn(async () => ({ ok: true }) as const);

const { ConnectorsStep } = await import("./connectors-step");

const handlers = { onBack: vi.fn(), onNext: vi.fn(), dots: null };

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const gmail = "abacus-gmailuser";

const mountStep = (): ReturnType<typeof render> => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    (
      <QueryClientProvider client={client}>
        <ConnectorsStep {...handlers} />
      </QueryClientProvider>
    ) as JSX.Element
  );
};

const mount = async (): Promise<void> => {
  mountStep();
  await waitFor(() => byId("onboarding-connectors-grid"));
  await waitFor(() => expect(listConnectorStatuses).toHaveBeenCalled());
};

beforeEach(() => {
  vi.clearAllMocks();
  statuses = Object.fromEntries(
    CONNECTORS.map((connector) => [connector.id, { state: "available" }])
  );
  connectConnector.mockResolvedValue({ ok: true });
  startAbacusAuth.mockResolvedValue({ ok: true });

  (globalThis.window as unknown as { api: unknown }).api = {
    agent: {
      listConnectorStatuses,
      connectConnector,
      startAbacusAuth,
      cancelConnectorConnect,
      onEvent: () => () => undefined,
      getMessagingSnapshot: async () => null,
      updateMessagingPlatform: async () => null,
    },
  };
});

describe("a hop the user walks away from", () => {
  // The hop resolves on the loopback ping or after five minutes, and every
  // tile is disabled until it does. Nothing here may leave the screen frozen
  // for those five minutes on a decision the user has already made.
  const hangingHop = (): void => {
    connectConnector.mockReturnValue(new Promise(() => undefined) as never);
  };

  it("can be cancelled, and never greys the other tiles out", async () => {
    hangingHop();
    await mount();

    fireEvent.click(byId(`onboarding-connector-${gmail}-connect`));
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
    expect(cancelConnectorConnect).toHaveBeenCalled();
  });

  it("offers no cancel until there is something to cancel", async () => {
    await mount();

    expect(
      document.querySelector('[data-id="onboarding-connectors-cancel"]')
    ).toBeNull();
  });

  it("is abandoned when the step is left, not left holding its port", async () => {
    hangingHop();
    const view = mountStep();
    await waitFor(() => byId("onboarding-connectors-grid"));
    fireEvent.click(byId(`onboarding-connector-${gmail}-connect`));

    view.unmount();

    expect(cancelConnectorConnect).toHaveBeenCalled();
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
      gmail,
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
    (
      globalThis.window as unknown as {
        api: { agent: Record<string, unknown> };
      }
    ).api.agent.updateMessagingPlatform = updateMessagingPlatform;
    await mount();

    fireEvent.click(byId("onboarding-connector-messaging-whatsapp-connect"));

    // WhatsApp enables on click — that is what starts the bridge and the QR.
    await waitFor(() =>
      expect(updateMessagingPlatform).toHaveBeenCalledWith({
        platformId: "whatsapp",
        enabled: true,
      })
    );
    expect(connectConnector).not.toHaveBeenCalled();
  });

  it("marks a tile connected only when main says it is", async () => {
    // The regression: `enabled` survives its credentials being cleared, and a
    // Telegram with no token anywhere showed as connected in onboarding. The
    // status table is the one place that judgement is made now.
    statuses["messaging-telegram"] = { state: "pending", reason: "not-live" };
    await mount();

    await waitFor(() =>
      expect(
        byId("onboarding-connector-messaging-telegram").hasAttribute(
          "data-connected"
        )
      ).toBe(false)
    );
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

    fireEvent.click(byId(`onboarding-connector-${gmail}-connect`));

    await waitFor(() => expect(connectConnector).toHaveBeenCalledWith(gmail));
    // The regression this guards: attaching used to leave onboarding for the
    // settings panel, skipping the model and folder steps entirely.
    expect(handlers.onNext).not.toHaveBeenCalled();
  });

  it("signs in first when the app holds no Abacus account", async () => {
    statuses[gmail] = { state: "unavailable", reason: "not-signed-in" };
    await mount();

    fireEvent.click(byId(`onboarding-connector-${gmail}-connect`));

    await waitFor(() => expect(startAbacusAuth).toHaveBeenCalled());
    await waitFor(() => expect(connectConnector).toHaveBeenCalledWith(gmail));
  });

  it("marks what main says is attached, not what was clicked", async () => {
    statuses[gmail] = {
      state: "connected",
      account: "Gmail - ada@example.com",
    };
    await mount();

    await waitFor(() =>
      expect(
        byId(`onboarding-connector-${gmail}`).hasAttribute("data-connected")
      ).toBe(true)
    );
  });

  it("drops a platform tile the account does not offer", async () => {
    statuses[gmail] = { state: "unavailable", reason: "not-offered" };
    await mount();

    await waitFor(() =>
      expect(
        document.querySelector(`[data-id="onboarding-connector-${gmail}"]`)
      ).toBeNull()
    );
  });

  it("reports a failed attach but not a cancelled one", async () => {
    connectConnector.mockResolvedValue({
      ok: false,
      error: "nope",
    } as unknown as { ok: true });
    await mount();

    fireEvent.click(byId(`onboarding-connector-${gmail}-connect`));
    await waitFor(() => byId("onboarding-connectors-error"));

    connectConnector.mockResolvedValue({
      ok: false,
      cancelled: true,
    } as unknown as { ok: true });
    fireEvent.click(byId(`onboarding-connector-${gmail}-connect`));
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="onboarding-connectors-error"]')
      ).toBeNull()
    );
  });

  it("says Continue once anything is connected", async () => {
    // The regression: the button read a platform-only set — a scanned
    // WhatsApp QR turned its tile green while the button still offered to
    // continue without connectors.
    statuses["messaging-whatsapp"] = { state: "connected" };
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
