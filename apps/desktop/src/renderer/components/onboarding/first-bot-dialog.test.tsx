/**
 * The first bot, at the end of onboarding.
 *
 * Linking WhatsApp, Telegram or Discord (which the connectors step, two
 * screens earlier, invites the user to do) mints a self-lane bot of the
 * app's own. The check here read "they already have bots" about those and
 * bailed, so a new user who connected anything, which is most of them, never
 * reached their first bot.
 */
import { render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "#shared/bots";

vi.mock("react-i18next", () => {
  const t = (key: string): string => key;
  return { useTranslation: () => ({ t, i18n: { language: "en-US" } }) };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const bots = vi.hoisted(() => ({ current: [] as Bot[] }));
const createBot = vi.hoisted(() => vi.fn());
const deleteBot = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/use-bots", () => ({
  useBotsQuery: () => ({ data: bots.current }),
  useCreateBotMutation: () => ({ mutateAsync: createBot }),
  useDeleteBotMutation: () => ({ mutate: deleteBot }),
}));
// The dialog itself is the bot maker; what it renders is its own test. Its
// close handler is kept so a case here can press Cancel.
const dialog = vi.hoisted(() => ({
  close: null as (() => void) | null,
  created: null as ((bot: Bot) => void) | null,
}));
vi.mock("../bots/new-bot-dialog", () => ({
  NewBotDialog: ({
    onClose,
    onCreated,
  }: {
    onClose: () => void;
    onCreated: (bot: Bot) => void;
  }) => {
    dialog.close = onClose;
    dialog.created = onCreated;
    return null;
  },
}));

const { FirstBotDialog } = await import("./first-bot-dialog");

const bot = (over: Partial<Bot>): Bot =>
  ({
    id: "b1",
    name: "A bot",
    description: "",
    channel: null,
    ...over,
  }) as Bot;

const mount = (): void => {
  render((<FirstBotDialog armed onDone={() => {}} />) as JSX.Element);
};

beforeEach(() => {
  bots.current = [];
  dialog.close = null;
  dialog.created = null;
  deleteBot.mockReset();
  createBot.mockReset().mockResolvedValue(bot({ id: "made" }));
});

describe("the first bot", () => {
  it("is made for a new user who connected a chat app on the way in", async () => {
    bots.current = [
      bot({
        id: "wa",
        name: "WhatsApp AbacusAI Bot <-> You",
        channel: "whatsapp",
      }),
      bot({
        id: "tg",
        name: "Telegram AbacusAI Bot <-> You",
        channel: "telegram",
      }),
    ];

    mount();

    await waitFor(() => expect(createBot).toHaveBeenCalledTimes(1));
    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      title: "Chief of Staff",
    });
  });

  it("is not made for someone who already has a bot of their own", async () => {
    bots.current = [bot({ id: "mine", name: "Gmail bot" })];

    mount();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createBot).not.toHaveBeenCalled();
  });

  it("takes the bot back when the popup is cancelled", async () => {
    mount();
    await waitFor(() => expect(dialog.close).not.toBeNull());

    dialog.close?.();

    // Made before the popup so the popup can show it, but a user who closed
    // the form never asked for a bot; leaving it in their list is the app
    // deciding for them.
    expect(deleteBot).toHaveBeenCalledWith("made");
  });

  it("keeps the bot when the popup is closed by Create", async () => {
    mount();
    await waitFor(() => expect(dialog.created).not.toBeNull());

    // The dialog calls onClose after a button that returned true, so
    // Create is followed by a close, which is not a cancel.
    dialog.created?.(bot({ id: "made", name: "Chief" }));
    dialog.close?.();

    expect(deleteBot).not.toHaveBeenCalled();
  });
});
