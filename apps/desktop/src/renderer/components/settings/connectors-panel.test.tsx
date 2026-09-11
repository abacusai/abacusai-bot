/**
 * The connectors marketplace, around the one part of it that is not a config
 * write: attaching an Abacus.AI connector.
 *
 * That flow is single-flight in the main process — starting one connect
 * cancels any other — and the panel has to show that truth rather than a card
 * per click. It also has to let go of a connect the user walked away from,
 * because the listener waiting for it holds a loopback port for five minutes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../stores/code-store", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ activeWorkspaceId: null, getActiveSessionId: () => null }),
}));

vi.mock("../../hooks/use-workspace-queries", () => ({
  useWorkspaceMetadataQuery: () => ({ data: { workspaces: [] } }),
}));
vi.mock("../../hooks/use-mcp-runtime", () => ({
  useMcpRuntime: () => ({
    servers: new Map(),
    logs: new Map(),
    refresh: async () => undefined,
    restart: async () => undefined,
    reloadLogs: async () => undefined,
  }),
}));

import { CONNECTORS, type AbacusConnector } from "../../connectors";

const { ConnectorsPanel } = await import("./connectors-panel");

/** Two connector cards from the real catalog, so the ids are the shipped ones. */
const connectors = CONNECTORS.filter(
  (connector): connector is AbacusConnector => connector.auth === "abacus"
).slice(0, 2);

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const cancelAbacusConnector = vi.fn(async () => undefined);
/** Resolvers for each in-flight connect, keyed by service. */
let pending: Map<string, (result: unknown) => void>;
let connectAbacusConnector: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;

/** The gateway snapshot the panel's messaging section renders from. */
const messagingPlatform = (
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id,
  nameKey: id,
  docsUrl: "https://example.com",
  enabled: false,
  configured: id === "whatsapp",
  state: "disabled",
  errorMessage: null,
  fields: [],
  pendingCount: 0,
  ...overrides,
});

let messagingSnapshot: {
  platforms: Array<Record<string, unknown>>;
  pending: unknown[];
  approved: unknown[];
  gatewayEnabled: boolean;
  autoApproveTools: boolean;
  workspaceId: string | null;
};
let updateMessagingPlatform: ReturnType<typeof vi.fn>;

beforeEach(() => {
  messagingSnapshot = {
    platforms: [
      messagingPlatform("telegram", { configured: true }),
      messagingPlatform("discord"),
      messagingPlatform("whatsapp"),
    ],
    pending: [],
    approved: [],
    gatewayEnabled: true,
    autoApproveTools: false,
    workspaceId: null,
  };
  updateMessagingPlatform = vi.fn(async () => messagingSnapshot);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  pending = new Map();
  cancelAbacusConnector.mockClear();

  connectAbacusConnector = vi.fn(
    (service: string) =>
      new Promise((resolve) => {
        // Starting a connect cancels whatever was already running — the main
        // process does exactly this, and it is what makes the state tricky.
        for (const [other, resolveOther] of pending) {
          if (other === service) continue;
          resolveOther({ ok: false, error: "cancelled", cancelled: true });
          pending.delete(other);
        }
        pending.set(service, resolve);
      })
  );

  (globalThis.window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(),
    getHomeDir: async () => "/home/test",
    agent: {
      listMcpServers: async () => [],
      listAbacusConnectors: async () => ({
        ok: true,
        available: connectors.map((connector) => ({
          service: connector.abacusService,
          name: connector.name,
        })),
        connected: {},
      }),
      connectAbacusConnector,
      cancelAbacusConnector,
      refreshMcpServers: async () => undefined,
      startAbacusAuth: async () => ({ ok: true }),
      getMessagingSnapshot: async () => messagingSnapshot,
      updateMessagingPlatform,
      decideMessagingPairing: async () => messagingSnapshot,
      updateMessagingSettings: async () => messagingSnapshot,
      onEvent: () => () => undefined,
    },
  };
});

const mount = async (): Promise<{ unmount: () => void }> => {
  const view = render(
    <QueryClientProvider client={queryClient}>
      {(<ConnectorsPanel />) as JSX.Element}
    </QueryClientProvider>
  );
  await waitFor(() => byId(`connector-add-${connectors[0]!.id}`));

  return view;
};

describe("two connectors, one browser hop", () => {
  it("says Adding… on the running card, and leaves it clickable", async () => {
    const [first] = connectors as [AbacusConnector, AbacusConnector];
    await mount();

    fireEvent.click(byId(`connector-add-${first.id}`));
    await waitFor(() =>
      expect(connectAbacusConnector).toHaveBeenCalledWith(first.abacusService)
    );

    // Still an Add button — nothing has connected — reading "Adding…", and
    // not disabled: a hop that goes nowhere is one click from a fresh one.
    const button = byId(`connector-add-${first.id}`);
    expect(button.textContent).toContain("connectors.adding");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(
      document.querySelector(`[data-id="connector-remove-${first.id}"]`)
    ).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(cancelAbacusConnector).toHaveBeenCalled());
    await waitFor(() =>
      expect(connectAbacusConnector).toHaveBeenCalledTimes(2)
    );
  });

  it("lets a second card take over, cancelling the first out loud", async () => {
    const [first, second] = connectors as [AbacusConnector, AbacusConnector];
    await mount();

    fireEvent.click(byId(`connector-add-${first.id}`));
    await waitFor(() =>
      expect(connectAbacusConnector).toHaveBeenCalledTimes(1)
    );
    expect(byId(`connector-add-${second.id}`).hasAttribute("disabled")).toBe(
      false
    );

    fireEvent.click(byId(`connector-add-${second.id}`));
    await waitFor(() => expect(cancelAbacusConnector).toHaveBeenCalled());
    await waitFor(() =>
      expect(connectAbacusConnector).toHaveBeenCalledWith(second.abacusService)
    );
    // The first hop was resolved as cancelled by the stub; its card is back
    // on Add with no error of its own to show.
    await waitFor(() =>
      expect(byId(`connector-add-${first.id}`).textContent).toContain(
        "connectors.add"
      )
    );
    expect(
      document.querySelector(`[data-id="connector-error-${first.id}"]`)
    ).toBeNull();
  });

  it("puts a failure on the card and gives the button back", async () => {
    const [first] = connectors as [AbacusConnector, AbacusConnector];
    await mount();

    fireEvent.click(byId(`connector-add-${first.id}`));
    await waitFor(() =>
      expect(connectAbacusConnector).toHaveBeenCalledTimes(1)
    );
    pending.get(first.abacusService)?.({ ok: false, error: "boom" });

    await waitFor(() =>
      expect(byId(`connector-error-${first.id}`).textContent).toContain(
        "connectors.abacusConnectFailed"
      )
    );
    expect(byId(`connector-add-${first.id}`).hasAttribute("disabled")).toBe(
      false
    );
  });
});

describe("the messaging section", () => {
  it("leads the page with the messaging cards, in their own section", async () => {
    await mount();

    await waitFor(() => byId("connectors-section-messaging"));
    for (const id of [
      "messaging-whatsapp",
      "messaging-telegram",
      "messaging-discord",
    ]) {
      expect(
        byId("connectors-section-messaging").querySelector(
          `[data-id="connector-card-${id}"]`
        ),
        `no card for "${id}"`
      ).toBeTruthy();
    }
  });

  it("connects WhatsApp in one click and opens the pairing dialog", async () => {
    await mount();
    await waitFor(() => byId("connector-add-messaging-whatsapp"));

    fireEvent.click(byId("connector-add-messaging-whatsapp"));

    await waitFor(() =>
      expect(updateMessagingPlatform).toHaveBeenCalledWith({
        platformId: "whatsapp",
        enabled: true,
      })
    );
    await waitFor(() => byId("messaging-detail-whatsapp"));
  });

  it("connects Telegram in one click, like WhatsApp — QR, not a token", async () => {
    await mount();
    await waitFor(() => byId("connector-add-messaging-telegram"));

    fireEvent.click(byId("connector-add-messaging-telegram"));

    // A linked-device platform now: connecting enables it immediately, which
    // is what starts the bridge and produces the QR to scan.
    await waitFor(() =>
      expect(updateMessagingPlatform).toHaveBeenCalledWith({
        platformId: "telegram",
        enabled: true,
      })
    );
    await waitFor(() => byId("messaging-detail-telegram"));
  });

  it("removes a platform by disabling it in the gateway", async () => {
    messagingSnapshot.platforms = messagingSnapshot.platforms.map((platform) =>
      platform.id === "whatsapp"
        ? { ...platform, enabled: true, state: "connected" }
        : platform
    );
    await mount();
    await waitFor(() => byId("connector-remove-messaging-whatsapp"));

    fireEvent.click(byId("connector-remove-messaging-whatsapp"));

    await waitFor(() =>
      expect(updateMessagingPlatform).toHaveBeenCalledWith({
        platformId: "whatsapp",
        enabled: false,
      })
    );
  });
});

describe("walking away from a connect", () => {
  it("abandons it instead of leaving the listener to time out", async () => {
    const view = await mount();

    fireEvent.click(byId(`connector-add-${connectors[0]!.id}`));
    await waitFor(() => expect(connectAbacusConnector).toHaveBeenCalled());

    view.unmount();

    expect(cancelAbacusConnector).toHaveBeenCalled();
  });
});
