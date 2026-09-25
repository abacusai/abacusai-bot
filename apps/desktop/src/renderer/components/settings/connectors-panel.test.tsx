/**
 * The connectors page, around the parts that are not a straight status read:
 * connecting through the one flow, and the browser hop that flow runs for a
 * platform connector.
 *
 * That hop is single-flight in the main process (starting one connect
 * cancels any other), and the panel has to show that truth rather than a card
 * per click. It also has to let go of a connect the user walked away from,
 * because the listener waiting for it holds a loopback port for five minutes.
 * And a token card connects from the same page through the same dialog the
 * chat uses.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatuses } from "#shared/contracts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
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

import { CONNECTORS, type PlatformConnector } from "../../connectors";

const { ConnectorsPanel } = await import("./connectors-panel");

/** Two platform cards from the real registry, so the ids are the shipped ones. */
const connectors = CONNECTORS.filter(
  (connector): connector is PlatformConnector => connector.kind === "platform"
).slice(0, 2);

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const cancelConnectorConnect = vi.fn(async () => undefined);
const submitConnectorFields = vi.fn(async () => ({ ok: true }) as const);
const disconnectConnector = vi.fn(async () => ({ ok: true }) as const);
/** Resolvers for each in-flight connect, keyed by connector id. */
let pending: Map<string, (result: unknown) => void>;
let connectConnector: ReturnType<typeof vi.fn>;
let statuses: ConnectorStatuses;
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
  cancelConnectorConnect.mockClear();
  submitConnectorFields.mockClear();
  disconnectConnector.mockClear();
  statuses = Object.fromEntries(
    CONNECTORS.map((connector) => [connector.id, { state: "available" }])
  );

  connectConnector = vi.fn(
    (id: string) =>
      new Promise((resolve) => {
        // Starting a connect cancels whatever was already running. The main
        // process does exactly this, and it is what makes the state tricky.
        for (const [other, resolveOther] of pending) {
          if (other === id) continue;
          resolveOther({ ok: false, error: "cancelled", cancelled: true });
          pending.delete(other);
        }
        pending.set(id, resolve);
      })
  );

  (globalThis.window as unknown as { api: unknown }).api = {
    openExternal: vi.fn(),
    hasGoogleChrome: async () => true,
    agent: {
      listConnectorStatuses: async () => statuses,
      connectConnector,
      submitConnectorFields,
      disconnectConnector,
      cancelConnectorConnect,
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
    const [first] = connectors as [PlatformConnector, PlatformConnector];
    await mount();

    fireEvent.click(byId(`connector-add-${first.id}`));
    await waitFor(() =>
      expect(connectConnector).toHaveBeenCalledWith(first.id)
    );

    // Still an Add button (nothing has connected), reading "Adding…", and
    // not disabled: a hop that goes nowhere is one click from a fresh one.
    const button = byId(`connector-add-${first.id}`);
    expect(button.textContent).toContain("connectors.adding");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(
      document.querySelector(`[data-id="connector-remove-${first.id}"]`)
    ).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(cancelConnectorConnect).toHaveBeenCalled());
    await waitFor(() => expect(connectConnector).toHaveBeenCalledTimes(2));
  });

  it("lets a second card take over, cancelling the first out loud", async () => {
    const [first, second] = connectors as [
      PlatformConnector,
      PlatformConnector,
    ];
    await mount();

    fireEvent.click(byId(`connector-add-${first.id}`));
    await waitFor(() => expect(connectConnector).toHaveBeenCalledTimes(1));
    expect(byId(`connector-add-${second.id}`).hasAttribute("disabled")).toBe(
      false
    );

    fireEvent.click(byId(`connector-add-${second.id}`));
    await waitFor(() => expect(cancelConnectorConnect).toHaveBeenCalled());
    await waitFor(() =>
      expect(connectConnector).toHaveBeenCalledWith(second.id)
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
    const [first] = connectors as [PlatformConnector, PlatformConnector];
    await mount();

    fireEvent.click(byId(`connector-add-${first.id}`));
    await waitFor(() => expect(connectConnector).toHaveBeenCalledTimes(1));
    pending.get(first.id)?.({ ok: false, error: "boom" });

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

describe("what main says is connected", () => {
  it("files a card under Installed on main's word alone, and removes through main", async () => {
    statuses["abacus-gmailuser"] = {
      state: "connected",
      account: "Gmail - ada@example.com",
    };
    statuses.github = { state: "connected" };
    await mount();

    await waitFor(() => byId("connector-remove-abacus-gmailuser"));
    expect(
      byId("connectors-section-installed").querySelector(
        '[data-id="connector-card-github"]'
      )
    ).toBeTruthy();

    fireEvent.click(byId("connector-remove-github"));
    await waitFor(() =>
      expect(disconnectConnector).toHaveBeenCalledWith("github")
    );
  });

  it("hides a platform card the account does not offer", async () => {
    statuses["abacus-jira"] = { state: "unavailable", reason: "not-offered" };
    await mount();

    expect(
      document.querySelector('[data-id="connector-card-abacus-jira"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-id="connector-card-abacus-gmailuser"]')
    ).toBeTruthy();
  });
});

describe("a token card", () => {
  it("opens the fields dialog and connects through it without a browser hop", async () => {
    await mount();

    fireEvent.click(byId("connector-add-github"));
    await waitFor(() => byId("connector-credential-prompt"));
    expect(connectConnector).not.toHaveBeenCalled();

    fireEvent.change(byId("connector-credential-GH_TOKEN"), {
      target: { value: "ghp_secret" },
    });
    fireEvent.click(byId("connector-credential-submit"));

    await waitFor(() =>
      expect(submitConnectorFields).toHaveBeenCalledWith("github", {
        GH_TOKEN: "ghp_secret",
      })
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

  it("connects Telegram in one click, like WhatsApp: QR, not a token", async () => {
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
    statuses["messaging-whatsapp"] = { state: "connected" };
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
    await waitFor(() => expect(connectConnector).toHaveBeenCalled());

    view.unmount();

    expect(cancelConnectorConnect).toHaveBeenCalled();
  });
});
