/** Final setup preserves each explicit product destination. */
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { fixtureBots, fixturePrefs } from "#renderer/data/fixture-db/rows";
import { fixedT, initI18n } from "#renderer/lib/i18n";

import type { StepContext } from "./context";
import { DoneStep } from "./done";
import { FirstBotStep } from "./first-bot";

vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => "none",
}));

// The avatar reads the motion preference from prefs; no DbProvider here.
vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => "full",
}));
vi.mock("#renderer/data/db/prefs", () => ({
  usePrefs: () => ({ ...fixturePrefs(), motion: { reduce: "on" } }),
}));

const bot = fixtureBots()[0]!;
const ctx = () => {
  const funnelStep = vi.fn(async () => {});
  const props = {
    step: "first-bot",
    transport: { client: { system: { funnelStep } } } as never,
    facts: {
      signedIn: true,
      payingTier: false,
      ownsBot: false,
      ownProvider: false,
    },
    navigate: vi.fn(async () => {}),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    createFirstBot: vi.fn(),
    choose: vi.fn(async () => {}),
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
const ready = {
  state: "ready",
  result: { bot, checkInRoutineId: null },
} as const;
const cards = () =>
  [...document.querySelectorAll("[data-first-choice]")].map((card) =>
    card.getAttribute("data-first-choice")
  );

describe("FirstBotStep: what to do first", () => {
  it("leads with Build, every card starts its own work, and the free text becomes the goal", async () => {
    await initI18n();
    const { context, funnelStep } = ctx();
    render(
      <FirstBotStep
        ctx={context}
        first={{ state: "choose" }}
        bot={null}
        present={false}
        heading={createRef()}
        inbox={{ state: "reading" }}
        chatApp={null}
      />
    );
    expect(screen.getByRole("heading").textContent).toBe(
      "What do you want to do first?"
    );
    expect(
      screen.getByText(
        "Pick one. Your bot starts on it right away. Nothing to connect."
      )
    ).toBeTruthy();
    expect(cards()).toEqual(["build", "chat-app", "research", "images"]);
    expect(
      document
        .querySelector('[data-first-choice="build"]')
        ?.getAttribute("data-primary")
    ).toBe("true");
    expect(screen.queryByText(/Chief of Staff/)).toBeNull();
    expect(screen.queryByText("We made your first bot for you")).toBeNull();
    // A one-line teaser: the plan's price and whole pitch are the dialog's.
    expect(
      screen.getByText("Logos, product photos, posts and clips.")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Portfolio site" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({
        kind: "build",
        prompt: expect.stringContaining("portfolio website"),
      })
    );
    expect(funnelStep).toHaveBeenCalledWith({
      step: "first_choice_build",
      detail: "portfolio_site",
    });
    fireEvent.click(screen.getByRole("button", { name: "Start building" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({
        kind: "build",
        prompt: null,
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({
        kind: "chat-app",
        app: "whatsapp",
      })
    );
    expect(funnelStep).toHaveBeenCalledWith({
      step: "first_choice_whatsapp",
      detail: "whatsapp",
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({ kind: "research" })
    );
    fireEvent.click(screen.getByRole("button", { name: "See Basic" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({ kind: "images" })
    );
    expect(funnelStep).toHaveBeenCalledWith({
      step: "first_choice_images",
      detail: "free",
    });

    const box = screen.getByRole("textbox", { name: "What you need" });
    expect(box.getAttribute("placeholder")).toBe(
      "Or just tell me what you need…"
    );
    fireEvent.change(box, { target: { value: "  Kaggle notebooks " } });
    fireEvent.submit(box.closest("form")!);
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({
        kind: "goal",
        goal: "Kaggle notebooks",
      })
    );
    expect(funnelStep).toHaveBeenCalledWith({ step: "first_choice_freetext" });

    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith(
        { to: "new-session" },
        { tour: true }
      )
    );
  });

  it("puts a chat app linked in onboarding on top, named for that app", async () => {
    await initI18n();
    const { context } = ctx();
    render(
      <FirstBotStep
        ctx={context}
        first={{ state: "choose" }}
        bot={null}
        present={false}
        heading={createRef()}
        inbox={{ state: "reading" }}
        chatApp="telegram"
      />
    );
    expect(cards()).toEqual(["chat-app", "build", "research", "images"]);
    expect(screen.getByText("Answer me on Telegram")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({
        kind: "chat-app",
        app: "telegram",
      })
    );
  });

  it("continues once the bot was removed", async () => {
    await initI18n();
    const { context } = ctx();
    render(
      <FirstBotStep
        ctx={context}
        first={{ state: "removed" }}
        bot={null}
        present={false}
        heading={createRef()}
        inbox={{ state: "reading" }}
        chatApp={null}
      />
    );
    expect(screen.getByText("This bot was removed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(context.props.complete).toHaveBeenCalledWith({ to: "new-bot" });
  });
});

describe("FirstBotStep: after a Gmail sign-in", () => {
  const renderInbox = (
    inbox: Parameters<typeof FirstBotStep>[0]["inbox"],
    context: StepContext
  ) =>
    render(
      <FirstBotStep
        ctx={context}
        first={ready}
        bot={bot}
        present={true}
        heading={createRef()}
        inbox={inbox}
        chatApp={null}
      />
    );

  it("works on the inbox, then shows what needs the user with drafts to review", async () => {
    await initI18n();
    const { context } = ctx();
    const view = renderInbox({ state: "reading" }, context);
    expect(screen.getByRole("heading").textContent).toBe(
      "Reading your last 3 days of email…"
    );
    expect(screen.getByRole("button", { name: "Watch it work" })).toBeTruthy();
    view.rerender(
      <FirstBotStep
        ctx={context}
        first={ready}
        bot={bot}
        present={true}
        heading={createRef()}
        inbox={{ state: "done", drafts: 3 }}
        chatApp={null}
      />
    );
    expect(screen.getByRole("heading").textContent).toBe(
      "Your inbox, already sorted"
    );
    expect(
      screen.getByText(`${bot.name} read your last 3 days of email.`)
    ).toBeTruthy();
    expect(screen.getByText("3 emails need you today")).toBeTruthy();
    expect(
      screen.getByText("Drafts ready for each. Nothing is sent without you.")
    ).toBeTruthy();
    expect(cards()).toEqual(["inbox", "build"]);
    expect(screen.getByText("Or build something")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review drafts" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({
        kind: "bot",
        botId: bot.id,
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith({
        to: "bot-tour",
        botId: bot.id,
      })
    );
  });

  it("leads with Build when nothing needs the user, the inbox kept second", async () => {
    await initI18n();
    const { context } = ctx();
    renderInbox({ state: "done", drafts: 0 }, context);
    expect(screen.getByRole("heading").textContent).toBe(
      "Nothing needs you today"
    );
    expect(cards()).toEqual(["build", "inbox"]);
    expect(
      document
        .querySelector('[data-first-choice="build"]')
        ?.getAttribute("data-primary")
    ).toBe("true");
    expect(screen.getByText("Keep watching my inbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep watching" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({
        kind: "bot",
        botId: bot.id,
      })
    );
  });

  it("sends a pass that stopped to its chat", async () => {
    await initI18n();
    const { context } = ctx();
    renderInbox({ state: "stopped" }, context);
    expect(screen.getByRole("heading").textContent).toBe(
      `${bot.name} stopped before finishing`
    );
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await vi.waitFor(() =>
      expect(context.props.choose).toHaveBeenCalledWith({
        kind: "bot",
        botId: bot.id,
      })
    );
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
    expect(
      screen.getByText(/Your weekday check-in is set up/).textContent
    ).toContain(bot.name);
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
    expect(screen.queryByText(/Your weekday check-in is set up/)).toBeNull();
    expect(
      screen.getByText("Say hello, or start a session in a folder.")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New bot" }));
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith({ to: "new-bot" })
    );
  });
});
