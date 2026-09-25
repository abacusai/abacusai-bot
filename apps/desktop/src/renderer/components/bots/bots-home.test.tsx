import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/**
 * The first page of Bots asks for a name, and nothing else.
 *
 * It used to open on a dress-up game: ten colour swatches and eight
 * silhouettes to tap through before typing anything, the same game every
 * other bot product on the market is already playing. The look is still
 * there; it is derived from the name once there is one.
 *
 * Below the maker sits the template catalog: a card opens the same create
 * dialog prefilled with that role rather than making the bot outright, so
 * everything stays editable before Create.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createBot = vi.fn(async (input: Record<string, unknown>) => ({
  id: "bot-1",
  name: String(input.name ?? ""),
}));
const onCreated = vi.fn();
/** What the user has attached, which decides which cards lead the shelf. */
const connected = vi.hoisted(() => vi.fn((): string[] => []));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../hooks/use-bots", () => ({
  useBotsQuery: () => ({ data: [] }),
  useCreateBotMutation: () => ({ mutateAsync: createBot }),
  useUpdateBotMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../hooks/use-connected-connectors", () => ({
  useConnectedConnectors: () => connected(),
}));
vi.mock("../../hooks/use-routines", () => ({
  useCreateRoutineMutation: () => ({ mutateAsync: vi.fn() }),
  useRoutinesQuery: () => ({ data: [] }),
  useUpdateRoutineMutation: () => ({ mutateAsync: vi.fn() }),
  useRemoveRoutineMutation: () => ({ mutateAsync: vi.fn() }),
}));

const { BotsHome } = await import("./bots-home");
const { defaultAvatarColor, defaultAvatarShape } = await import("#shared/bots");
const {
  BOT_TEMPLATE_CATEGORIES,
  FEATURED_TEMPLATE_IDS,
  templateIdsInCategory,
} = await import("./bot-templates");

(window as unknown as { api: unknown }).api = {
  agent: {
    listModels: async () => [],
    announceBotChange: async () => undefined,
  },
};

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

/** Re-render with a different set of connections than the default none. */
const remountWith = (connectors: string[]): void => {
  cleanup();
  connected.mockReturnValue(connectors);
  render(
    (
      <QueryClientProvider client={new QueryClient()}>
        <BotsHome onCreated={onCreated} />
      </QueryClientProvider>
    ) as JSX.Element
  );
};

const shelfOrder = (): string[] =>
  [...byId("bots-home-suggestions").children].map((card) =>
    (card.getAttribute("data-id") ?? "").replace("bots-home-template-", "")
  );

beforeEach(() => {
  vi.clearAllMocks();
  connected.mockReturnValue([]);
  render(
    (
      <QueryClientProvider client={new QueryClient()}>
        <BotsHome onCreated={onCreated} />
      </QueryClientProvider>
    ) as JSX.Element
  );
});

describe("the bot maker", () => {
  it("shows the bot's own face above the name field, with a picker behind a pencil", async () => {
    // The face follows the name until a look is picked; the picker is a
    // popover on the pencil, not a row of swatches on the form.
    expect(byId("bots-home-face")).toBeTruthy();
    expect(
      document.querySelector('[data-id="bots-home-face-picker"]')
    ).toBeNull();

    fireEvent.click(byId("bots-home-face-edit"));

    await waitFor(() => byId("bots-home-face-picker"));
    expect(
      byId("bots-home-face-picker").querySelectorAll("button")
    ).toHaveLength(8);
    expect(
      byId("bots-home-face-colors").querySelectorAll("button")
    ).toHaveLength(10);
  });

  it("carries a look picked on the page into the bot it creates", async () => {
    fireEvent.click(byId("bots-home-face-edit"));
    await waitFor(() => byId("bots-home-face-picker"));
    fireEvent.click(
      byId("bots-home-face-picker").querySelector(
        '[aria-label$=" cone"]'
      ) as HTMLElement
    );
    fireEvent.click(
      byId("bots-home-face-colors").querySelector(
        '[aria-label$=" #3b82f6"]'
      ) as HTMLElement
    );
    fireEvent.change(byId("bots-home-name-input"), {
      target: { value: "Scout" },
    });
    fireEvent.click(byId("bots-home-get-started"));
    await waitFor(() => byId("new-bot-dialog"));
    const create = [...byId("new-bot-dialog").querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "bots.create"
    );
    fireEvent.click(create!);

    await waitFor(() => expect(createBot).toHaveBeenCalled());
    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      name: "Scout",
      avatarShape: "cone",
      avatarColor: "#3b82f6",
    });
  });

  it("leads with the Featured tab, in the sheet's order", () => {
    const shelf = byId("bots-home-suggestions");

    expect(shelf.children).toHaveLength(FEATURED_TEMPLATE_IDS.length);
    expect(shelfOrder()).toEqual([...FEATURED_TEMPLATE_IDS]);
    expect(
      byId("bots-home-category-featured").getAttribute("aria-selected")
    ).toBe("true");
  });

  it("swaps the cards when a category tab is picked", () => {
    fireEvent.click(byId("bots-home-category-finance"));

    expect(shelfOrder()).toEqual(templateIdsInCategory("finance"));
    expect(
      byId("bots-home-category-finance").getAttribute("aria-selected")
    ).toBe("true");
    expect(
      byId("bots-home-category-featured").getAttribute("aria-selected")
    ).toBe("false");
  });

  it("offers every category as a tab", () => {
    for (const category of BOT_TEMPLATE_CATEGORIES)
      expect(byId(`bots-home-category-${category}`)).toBeTruthy();
  });

  it("lays the cards out in auto-fill columns, so any width reflows in order", () => {
    // A fixed column count per breakpoint leaves an orphan card on its own
    // row or squeezes five into a space for three as the pane resizes.
    expect(byId("bots-home-suggestions").className).toContain("auto-fill");
  });

  it("opens the same new-bot dialog from a card, filled in from the template", async () => {
    // One form for both ways in. A card used to make its bot outright and
    // open a different editor over it, so the two flows looked like two
    // products; now nothing exists until Create.
    fireEvent.click(byId("bots-home-template-whatsapp-agent"));

    await waitFor(() => byId("new-bot-dialog"));
    expect(createBot).not.toHaveBeenCalled();
    expect((byId("new-bot-name-input") as HTMLInputElement).value).toBe(
      "bots.templates.whatsapp-agent.name"
    );
    expect(
      (byId("new-bot-instructions-input") as HTMLTextAreaElement).value
    ).toContain("Live in my WhatsApp.");
    // The sheet's persona comes along too, not only the mission.
    expect((byId("new-bot-persona-input") as HTMLInputElement).value).toMatch(
      /^Feels like texting a smart friend/
    );

    const create = [...byId("new-bot-dialog").querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "bots.create"
    );
    fireEvent.click(create!);

    await waitFor(() => expect(createBot).toHaveBeenCalled());
    const input = createBot.mock.calls[0]?.[0] ?? {};
    expect(input.name).toBe("bots.templates.whatsapp-agent.name");
    expect(input.title).toBeTruthy();
    expect(input.description).toBeTruthy();
    expect(input.persona).toMatch(/^Feels like texting a smart friend/);
    expect(input.avatarColor).toBeTruthy();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("opens the new-bot dialog with the typed name, and creates from there", async () => {
    fireEvent.change(byId("bots-home-name-input"), {
      target: { value: "Chief of Staff" },
    });
    fireEvent.click(byId("bots-home-get-started"));

    await waitFor(() => byId("new-bot-dialog"));
    expect((byId("new-bot-name-input") as HTMLInputElement).value).toBe(
      "Chief of Staff"
    );

    const create = [...byId("new-bot-dialog").querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "bots.create"
    );
    fireEvent.click(create!);

    await waitFor(() => expect(createBot).toHaveBeenCalled());
    const input = createBot.mock.calls[0]?.[0] ?? {};
    expect(input.name).toBe("Chief of Staff");
    // The face shown on the page is the face the bot gets: the name's own
    // default, sent explicitly rather than left for the store to derive.
    expect(input.avatarColor).toBe(defaultAvatarColor("Chief of Staff"));
    expect(input.avatarShape).toBe(defaultAvatarShape("Chief of Staff"));
  });
});

/**
 * The shelf used to be a fixed five, so somebody who had just linked WhatsApp
 * was shown mail and debugging first and had to go hunting for the bot about
 * the thing they had connected. What they attached now decides what leads.
 */
describe("the shelf, against what is connected", () => {
  it("leads with the bot for the platform the user connected", () => {
    remountWith(["messaging-telegram"]);

    expect(shelfOrder()[0]).toBe("telegram-agent");
  });

  it("orders several connections the way the catalog does", () => {
    remountWith(["messaging-whatsapp", "abacus-gmailuser"]);

    expect(shelfOrder().slice(0, 2)).toEqual([
      "whatsapp-agent",
      "email-drafting",
    ]);
  });

  it("stays the same length, with no card twice", () => {
    remountWith(["messaging-discord", "abacus-slack", "abacus-gmailuser"]);
    const order = shelfOrder();

    expect(order).toHaveLength(FEATURED_TEMPLATE_IDS.length);
    expect(new Set(order).size).toBe(order.length);
  });

  it("falls back to the sheet's order when nothing is connected", () => {
    expect(shelfOrder()).toEqual([...FEATURED_TEMPLATE_IDS]);
  });

  it("does not drag a connected bot onto a tab that has no such bot", () => {
    remountWith(["messaging-whatsapp"]);
    fireEvent.click(byId("bots-home-category-research"));

    expect(shelfOrder()).toEqual(templateIdsInCategory("research"));
  });
});
