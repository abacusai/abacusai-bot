import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import type { TopModelHintCard } from "@abacus-ai/contract/top-model-hint";
import { EMPTY_TOP_MODEL_HINT_CARD } from "@abacus-ai/contract/top-model-hint";
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

const ROUTER = "abacus/route-llm-code-low";
const SONNET = "abacus/claude-sonnet-5-5";
const OPUS = "abacus/claude-opus-5-5";

const PAID_ACCOUNT = {
  user_id: "u1",
  organization_id: "o1",
  name: null,
  email: null,
  picture: null,
  organization: null,
  org_user_count: null,
  plan: null,
  subscription_tier: "basic",
  credits_granted: 14000,
  credits_used: 1000,
};

const PAID_BILLING: BillingPlan = {
  current: {
    plan: "basic",
    planName: "Basic",
    creditsRemaining: 13000,
    creditsGranted: 14000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "",
      features: [
        "Top models including Claude Opus 5.5, Claude Sonnet 5.5, GPT-6 Astra and Gemini 4",
      ],
      creditsPerMonth: 14000,
      current: true,
    },
  ],
  upgrades: [],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

const row = (id: string, label: string): ModelAvailability => ({
  id,
  label,
  provider: "abacus",
  tier: "default",
  configured: true,
});

const PAID_CATALOG: ModelAvailability[] = [
  { ...row(ROUTER, "RouteLLM"), recommended: true },
  row(`${OPUS}-xhigh`, "Claude Opus 5.5 XHigh"),
  row(OPUS, "Claude Opus 5.5"),
  row(SONNET, "Claude Sonnet 5.5"),
];

let current: Awaited<ReturnType<typeof renderRelay>> | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

const turn = (runId: string, ask: string, reply: string): StreamChunk[] => [
  b.runStarted(runId),
  ...b.text(`${runId}-u`, "user", ask),
  ...b.text(`${runId}-a`, "assistant", reply),
  b.runFinished(runId, "success"),
];

const ANSWERED = turn(
  "r1",
  "Make the header sticky",
  "Done: the header now stays at the top."
);

/** A session chat on the plan's low router, with `live` arriving on screen. */
const mount = async ({
  live = ANSWERED,
  account = PAID_ACCOUNT as typeof PAID_ACCOUNT,
  card = undefined as TopModelHintCard | undefined,
  topModels = { tier: "basic" } as { tier: string } | null,
  continueFails = false,
  continues = true,
} = {}) => {
  const steps: Array<{ step: string; detail?: string }> = [];
  const continued: Array<[string, string | undefined]> = [];
  const moved: string[] = [];
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const os = implement(contract);
  const model = {
    value: ROUTER,
    label: "RouteLLM",
    onChange: () => {},
    groups: [],
    ...(topModels != null ? { topModels } : {}),
  };
  current = await renderRelay(
    relay,
    "session",
    {
      model,
      onSwitchThisChat: vi.fn(async (id: string) => {
        moved.push(id);
        return "chat" as const;
      }),
      ...(continues
        ? {
            onContinueInNewChat: vi.fn(async (id: string, prompt?: string) => {
              if (continueFails) throw new Error("failed");
              continued.push([id, prompt]);
            }),
          }
        : {}),
    },
    {},
    undefined,
    {
      system: {
        funnelStep: os.system.funnelStep.handler(({ input }) => {
          steps.push(input);
        }),
      },
      account: {
        abacus: os.account.abacus.handler(() => account),
        billingPlan: os.account.billingPlan.handler(() => PAID_BILLING),
      },
      models: { list: os.models.list.handler(() => PAID_CATALOG) },
    }
  );
  if (card != null)
    await act(() =>
      current!.db.updatePrefs({ dismissals: { topModelHint: card } })
    );
  await act(async () => relay.emitAll(live));
  const record = () =>
    current!.db.collections.prefs.get("app")?.dismissals.topModelHint;
  return { relay, steps, continued, moved, record };
};

const hint = () => document.querySelector('[data-slot="top-model-hint"]');

const settled = async () => {
  for (let index = 0; index < 4; index += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
};

describe("TopModelHint", () => {
  it("offers the plan's Sonnet first, then Opus, then the picker, once per chat", async () => {
    const h = await mount();
    await screen.findByText(
      "Your plan includes the top models. Continue this work in a new chat with Claude Sonnet 5.5 or Claude Opus 5.5."
    );
    const buttons = [...hint()!.querySelectorAll("button")].map(
      (button) => button.textContent || button.getAttribute("aria-label")
    );
    expect(buttons).toEqual([
      "Claude Sonnet 5.5",
      "Claude Opus 5.5",
      "See all models",
      "Not now",
    ]);
    await waitFor(() =>
      expect(h.record()).toMatchObject({
        shown: 1,
        threads: [h.relay.threadId],
        shownThread: h.relay.threadId,
        shownTurn: 1,
        switched: false,
      })
    );
    await settled();
    expect(h.steps).toEqual([
      { step: "top_model_hint_shown", detail: "basic" },
    ]);
  });

  it("continues this work in a new chat on the model in one tap, leaving this chat's model, and is done for good", async () => {
    const h = await mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Claude Sonnet 5.5" })
    );
    // No message to send: the new chat waits for the user's words.
    await waitFor(() => expect(h.continued).toEqual([[SONNET, undefined]]));
    expect(h.moved).toEqual([]);
    expect(h.relay.stats.send).toHaveLength(0);
    await waitFor(() => expect(h.record()?.switched).toBe(true));
    expect(hint()).toBeNull();
    await settled();
    expect(h.steps.map((step) => [step.step, step.detail])).toEqual([
      ["top_model_hint_shown", "basic"],
      ["top_model_hint_tapped", "sonnet"],
      ["top_model_hint_switched", "sonnet"],
    ]);
  });

  it("keeps the line when the new chat could not be prepared, and records no switch", async () => {
    const h = await mount({ continueFails: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "Claude Opus 5.5" })
    );
    await screen.findByRole("button", { name: "Claude Opus 5.5" });
    await settled();
    expect(h.record()?.switched).toBe(false);
    expect(h.steps.map((step) => step.step)).not.toContain(
      "top_model_hint_switched"
    );
  });

  it("opens the chat's model picker from See all models", async () => {
    const h = await mount();
    const picker = document.querySelector<HTMLButtonElement>(
      '[data-slot="chat-model-picker"]'
    );
    expect(picker).not.toBeNull();
    const clicked = vi.fn();
    picker!.addEventListener("click", clicked);
    fireEvent.click(
      await screen.findByRole("button", { name: "See all models" })
    );
    expect(clicked).toHaveBeenCalledTimes(1);
    await settled();
    expect(h.steps).toContainEqual({
      step: "top_model_hint_tapped",
      detail: "all",
    });
  });

  it("closes on Not now and keeps quiet afterwards", async () => {
    const h = await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(hint()).toBeNull();
    await waitFor(() =>
      expect(h.record()).toMatchObject({ dismissed: 1, shownTurn: null })
    );
    expect(h.record()?.dismissedAt).toEqual(expect.any(Number));
    await act(async () =>
      h.relay.emitAll(turn("r2", "Now the footer", "Done."))
    );
    await settled();
    expect(hint()).toBeNull();
  });

  it("goes away once the next message is sent, and does not come back in that chat", async () => {
    const h = await mount();
    await screen.findByRole("button", { name: "Claude Sonnet 5.5" });
    await act(async () =>
      h.relay.emitAll(turn("r2", "Now the footer", "Done."))
    );
    await waitFor(() => expect(hint()).toBeNull());
    await settled();
    expect(hint()).toBeNull();
    expect(h.record()?.shown).toBe(1);
  });

  it.each([
    [
      "while the turn is still running",
      { live: [b.runStarted("r1"), ...b.text("r1-u", "user", "Make it")] },
    ],
    [
      "after a failed turn, where the error card speaks",
      {
        live: [
          b.runStarted("r1"),
          ...b.text("r1-u", "user", "Make it"),
          b.runError("r1", { message: "Something odd happened." } as never),
        ],
      },
    ],
    [
      "with half the month's credits used",
      { account: { ...PAID_ACCOUNT, credits_used: 7000 } },
    ],
    [
      "after a switch",
      { card: { ...EMPTY_TOP_MODEL_HINT_CARD, switched: true } },
    ],
    [
      "after three showings",
      { card: { ...EMPTY_TOP_MODEL_HINT_CARD, shown: 3, threads: ["a"] } },
    ],
    [
      "without the binding (a free plan, or another model)",
      { topModels: null },
    ],
    [
      "in a chat that cannot be continued (a bot's, a routine run)",
      { continues: false },
    ],
  ])("stays down %s", async (_name, options) => {
    await mount(options as Parameters<typeof mount>[0]);
    await settled();
    expect(hint()).toBeNull();
  });

  it("stays down under a reply that has a retry line of its own", async () => {
    await mount({
      live: [
        b.runStarted("r1"),
        ...b.text("r1-u", "user", "Fix the login crash"),
        b.textStart("r1-a"),
        ...b.toolCall("c1", "edit", "r1-a", { file_path: "/repo/login.js" }),
        b.toolResult("c1", { text: "Edited login.js" }),
        b.textDelta("r1-a", "Fixed the empty password case."),
        b.textEnd("r1-a"),
        b.runFinished("r1", "success"),
        b.runStarted("r2"),
        ...b.text("r2-u", "user", "It still doesn't work, same error"),
        b.textStart("r2-a"),
        ...b.toolCall("c2", "edit", "r2-a", { file_path: "/repo/login.js" }),
        b.toolResult("c2", { text: "Edited login.js" }),
        b.textDelta("r2-a", "I changed how the session is read."),
        b.textEnd("r2-a"),
        b.runFinished("r2", "success"),
      ],
    });
    await screen.findByRole(
      "button",
      { name: "Try again in a new chat with Claude Opus 5.5" },
      { timeout: 5000 }
    );
    await settled();
    expect(hint()).toBeNull();
  }, 15_000);
});
