/**
 * The first-bot and done slides (canvas OnboardFirstBot, OnboardDone) wired
 * to the real flow: Say hello keeps the bot and moves to done, Take the
 * tour completes with the tour, Edit completes into the editor, Start from
 * scratch discards and moves on; done messages the bot or starts a session,
 * and offers a new bot when the first one was skipped.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { fixtureBots } from "#renderer/data/fixture-db/rows";
import { fixedT, initI18n } from "#renderer/lib/i18n";

import type { StepContext } from "./context";
import { DoneStep } from "./done";
import { FirstBotStep } from "./first-bot";

const discard = vi.fn(async () => {});
vi.mock("../first-bot", async (original) => ({
  ...(await original<typeof import("../first-bot")>()),
  discardFirstBot: (...args: unknown[]) => discard(...(args as [])),
}));
vi.mock("#renderer/data/db", () => ({ useDb: () => ({ db: true }) }));

const bot = fixtureBots()[0]!;
const ctx = () => {
  const funnelStep = vi.fn(async () => {});
  const props = {
    step: "first-bot",
    transport: { client: { system: { funnelStep } } } as never,
    facts: { signedIn: true, payingTier: false, ownsBot: false },
    navigate: vi.fn(async () => {}),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    createFirstBot: vi.fn(),
  } as StepContext["props"];
  const context: StepContext = {
    props,
    t: fixedT(),
    busy: false,
    perform: async (action) => {
      await action();
    },
    advance: vi.fn(),
    back: vi.fn(),
  };
  return { context, funnelStep };
};
const ready = (checkInRoutineId: string | null) =>
  ({
    state: "ready",
    result: { bot, checkInRoutineId, preview: true },
  }) as const;

describe("FirstBotStep", () => {
  it("shows the bot row with its check-in and routes each action", async () => {
    await initI18n();
    const { context, funnelStep } = ctx();
    render(
      <FirstBotStep
        ctx={context}
        first={ready("routine")}
        bot={bot}
        present={true}
        heading={createRef()}
      />
    );
    expect(screen.getByRole("heading").textContent).toBe(
      "We made your first bot for you"
    );
    expect(screen.getByText(bot.name)).toBeTruthy();
    expect(
      screen.getByText("Checks in weekdays at 8:00 · Gmail, Calendar")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Say hello" }));
    await vi.waitFor(() =>
      expect(context.props.navigate).toHaveBeenCalledWith("done")
    );
    expect(funnelStep).toHaveBeenCalledWith({ step: "first_bot_kept" });

    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith({
        to: "bot-tour",
        botId: bot.id,
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith({
        to: "bot",
        botId: bot.id,
        edit: true,
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Start from scratch" }));
    await vi.waitFor(() =>
      expect(funnelStep).toHaveBeenCalledWith({ step: "first_bot_cancelled" })
    );
    expect(discard).toHaveBeenCalledWith({ db: true }, ready("routine").result);
    expect(context.props.navigate).toHaveBeenLastCalledWith("done");
  });

  it("reads No check-ins when the routine was not created, and continues once removed", async () => {
    await initI18n();
    const { context } = ctx();
    const view = render(
      <FirstBotStep
        ctx={context}
        first={ready(null)}
        bot={bot}
        present={true}
        heading={createRef()}
      />
    );
    expect(screen.getByText("No check-ins")).toBeTruthy();
    view.rerender(
      <FirstBotStep
        ctx={context}
        first={{ state: "removed" }}
        bot={null}
        present={false}
        heading={createRef()}
      />
    );
    expect(screen.getByText("This bot was removed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(context.props.navigate).toHaveBeenCalledWith("done");
  });
});

describe("DoneStep", () => {
  it("messages the first bot and mentions its check-in", async () => {
    await initI18n();
    const { context } = ctx();
    render(
      <DoneStep ctx={context} bot={bot} checkIn={true} heading={createRef()} />
    );
    expect(screen.getByRole("heading").textContent).toBe("You’re set");
    expect(screen.getByText(/is checking your calendar/).textContent).toContain(
      bot.name
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Message ${bot.name}` })
    );
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith({
        to: "bot",
        botId: bot.id,
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith({
        to: "new-session",
      })
    );
  });

  it("offers a new bot when the first one was skipped", async () => {
    await initI18n();
    const { context } = ctx();
    render(
      <DoneStep
        ctx={context}
        bot={null}
        checkIn={false}
        heading={createRef()}
      />
    );
    expect(screen.queryByText(/is checking your calendar/)).toBeNull();
    expect(
      screen.getByText("Say hello, or start a session in a folder.")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New bot" }));
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith({ to: "new-bot" })
    );
  });
});
