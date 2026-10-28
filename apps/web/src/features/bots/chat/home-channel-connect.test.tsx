/**
 * A chat-app agent's chat leads with its app's Connect card until the app is
 * connected, without the agent asking; every other bot shows none.
 */
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";
import type {
  MessagingPlatformId,
  MessagingSnapshot,
} from "@abacus-ai/contract/messaging";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import { i18n, initI18n } from "#renderer/lib/i18n";

import { HomeChannelConnect } from "./home-channel-connect";

const state = vi.hoisted(() => ({
  attempts: [] as string[],
  resolve: null as null | ((outcome: { ok: boolean }) => void),
}));

vi.mock("#renderer/lib/platform", async (original) => ({
  ...(await original<typeof import("#renderer/lib/platform")>()),
  IS_ELECTRON: true,
}));
vi.mock("#renderer/lib/connect-page", () => ({
  ConnectAttempt: class {
    readonly result: Promise<{ ok: boolean }>;
    constructor(_transport: unknown, connectorId: string) {
      state.attempts.push(connectorId);
      this.result = new Promise((resolve) => {
        state.resolve = resolve;
      });
    }
    cancel() {}
  },
}));

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});
beforeEach(() => {
  state.attempts = [];
  state.resolve = null;
});

const snapshotOf = (
  platform: MessagingPlatformId,
  connected: boolean
): MessagingSnapshot =>
  ({
    gatewayEnabled: true,
    autoApproveTools: false,
    respondToInbound: false,
    workspaceId: null,
    botId: null,
    approved: [],
    pending: [],
    autoReplies: [],
    platforms: [
      {
        id: platform,
        nameKey: platform,
        enabled: connected,
        configured: true,
        state: connected ? "connected" : "needs_login",
        fields: [],
        docsUrl: "",
        errorMessage: null,
        pendingCount: 0,
      },
    ],
  }) as MessagingSnapshot;

const mount = (
  bot: Partial<BotRow>,
  snapshot: { current: MessagingSnapshot }
) => {
  const transport = {
    orpc: {
      messaging: {
        snapshot: {
          queryKey: () => ["messaging", "snapshot"],
          queryOptions: () => ({
            queryKey: ["messaging", "snapshot"],
            queryFn: async () => snapshot.current,
          }),
        },
      },
    },
    client: { connectors: { submitFields: vi.fn() } },
  } as unknown as Transport;
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <HomeChannelConnect
        bot={{ id: "b1", name: "WhatsApp Agent", ...bot } as BotRow}
        transport={transport}
        conversationKey={"k" as ConversationKey}
      />
    </QueryClientProvider>
  );
};

it.each([
  ["whatsapp", "WhatsApp"],
  ["telegram", "Telegram"],
  ["discord", "Discord"],
] as const)(
  "a %s agent leads with Connect until the app is connected",
  async (channel, name) => {
    const snapshot = { current: snapshotOf(channel, false) };
    mount({ homeChannel: channel }, snapshot);
    const connect = await screen.findByRole("button", {
      name: `Connect ${name}`,
    });
    expect(
      screen.getByText(
        `You talk to this agent from ${name} on your phone. Connect ${name} to start.`
      )
    ).toBeTruthy();
    fireEvent.click(connect);
    expect(state.attempts).toEqual([`messaging-${channel}`]);
    // Connected: the card goes once the app reports it.
    snapshot.current = snapshotOf(channel, true);
    state.resolve?.({ ok: true });
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="connector-request"]')
      ).toBeNull()
    );
  }
);

it("shows nothing once the app is connected, or for a bot with no chat app", async () => {
  const connected = mount(
    { homeChannel: "whatsapp" },
    { current: snapshotOf("whatsapp", true) }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.querySelector('[data-slot="connector-request"]')).toBeNull();
  connected.unmount();
  mount({ homeChannel: null }, { current: snapshotOf("whatsapp", false) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.querySelector('[data-slot="connector-request"]')).toBeNull();
});

it("a switched-on app reconnecting at launch shows no card; a signed-out one does", async () => {
  const reconnecting = snapshotOf("whatsapp", false);
  reconnecting.platforms[0] = {
    ...reconnecting.platforms[0]!,
    enabled: true,
    state: "connecting",
  };
  const view = mount({ homeChannel: "whatsapp" }, { current: reconnecting });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.querySelector('[data-slot="connector-request"]')).toBeNull();
  view.unmount();
  const signedOut = snapshotOf("whatsapp", false);
  signedOut.platforms[0] = {
    ...signedOut.platforms[0]!,
    enabled: true,
    state: "needs_login",
  };
  mount({ homeChannel: "whatsapp" }, { current: signedOut });
  expect(
    await screen.findByRole("button", { name: "Connect WhatsApp" })
  ).toBeTruthy();
});

it("Not now hides the card for this view", async () => {
  mount(
    { homeChannel: "whatsapp" },
    { current: snapshotOf("whatsapp", false) }
  );
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  expect(document.querySelector('[data-slot="connector-request"]')).toBeNull();
});
