/**
 * The first bot, at the end of onboarding: a Chief of Staff made silently, on
 * the house for its first runs, that the user is taken straight into.
 *
 * Linking WhatsApp, Telegram or Discord (which the connectors step, two
 * screens earlier, invites the user to do) mints a self-lane bot of the
 * app's own. The check here must read "they already have bots" only about
 * bots the user made, or a new user who connected anything never gets one.
 */
import { render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "#shared/bots";

vi.mock("react-i18next", () => {
  const t = (key: string): string => key;
  return { useTranslation: () => ({ t, i18n: { language: "en-US" } }) };
});
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const bots = vi.hoisted(() => ({ current: [] as Bot[] }));
const createBot = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/use-bots", () => ({
  useBotsQuery: () => ({
    data: bots.current,
    refetch: async () => ({ data: bots.current }),
  }),
  useCreateBotMutation: () => ({ mutateAsync: createBot }),
}));

const { FirstBot } = await import("./first-bot");

const bot = (over: Partial<Bot>): Bot =>
  ({ id: "b1", name: "A bot", description: "", channel: null, ...over }) as Bot;

const onDone = vi.fn();
const mount = (): void => {
  render((<FirstBot armed onDone={onDone} />) as JSX.Element);
};

const reportFunnelStep = vi.fn();

beforeEach(() => {
  bots.current = [];
  navigate.mockReset();
  onDone.mockReset();
  reportFunnelStep.mockReset();
  createBot.mockReset().mockResolvedValue(bot({ id: "made" }));
  (globalThis.window as unknown as { api: unknown }).api = { reportFunnelStep };
});

describe("the first bot", () => {
  it("is a sponsored Chief of Staff, made without a popup and opened", async () => {
    bots.current = [bot({ id: "self-lane", channel: "whatsapp" })];
    mount();

    await waitFor(() => expect(createBot).toHaveBeenCalledTimes(1));
    expect(createBot.mock.calls[0]?.[0]).toMatchObject({
      name: "bots.templates.chief-of-staff.name",
      title: "Chief of Staff",
      sponsoredFirstRun: true,
    });
    expect(createBot.mock.calls[0]?.[0].description).toContain(
      "Use Gmail only."
    );
    expect(createBot.mock.calls[0]?.[0].description).not.toMatch(
      /Calendar|Slack/
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith({
      to: "/bots/$botId",
      params: { botId: "made" },
    });
    expect(reportFunnelStep.mock.calls.map((call) => call[0])).toEqual([
      "first_bot_shown",
      "first_bot_kept",
    ]);
  });

  it("is not made for someone who already has a bot of their own", async () => {
    bots.current = [bot({ id: "mine" })];
    mount();

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(createBot).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(reportFunnelStep).toHaveBeenCalledWith(
      "first_bot_skipped",
      "has_bots"
    );
  });

  it("gives up quietly when the bot could not be made", async () => {
    createBot.mockRejectedValue(new Error("no"));
    mount();

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
  });
});
