import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeUpgradeDialog,
  upgradeDialogStore,
} from "#renderer/lib/upgrade-dialog";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

const ROUTER = "abacus/route-llm-code-low";
const OPUS = "abacus/claude-opus-5-5";
const SONNET = "abacus/claude-sonnet-5-5";
const TOP_LINE =
  "Top models including Claude Opus 5.5, Claude Sonnet 5.5, GPT-6 Astra and Gemini 4";

const account = (tier: "free" | "basic") => ({
  user_id: "u1",
  organization_id: "o1",
  name: null,
  email: null,
  picture: null,
  organization: null,
  org_user_count: null,
  plan: null,
  subscription_tier: tier,
  credits_granted: tier === "free" ? 2000 : 14000,
  credits_used: 100,
});

const billing = (tier: "free" | "basic"): BillingPlan => ({
  current: {
    plan: tier,
    planName: tier === "free" ? "Free" : "Basic",
    creditsRemaining: 1000,
    creditsGranted: 2000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "",
      features: [TOP_LINE],
      creditsPerMonth: 14000,
      current: tier === "basic",
    },
  ],
  upgrades:
    tier === "free"
      ? [
          {
            plan: "basic",
            planName: "Basic",
            priceText: "$10/month",
            features: [TOP_LINE],
            url: "https://apps.abacus.ai/upgrade",
          },
        ]
      : [],
  topUpUrl: null,
  upgradeInMobileApp: false,
});

const catalog = (tier: "free" | "basic"): ModelAvailability[] => [
  {
    id: ROUTER,
    label: "RouteLLM",
    provider: "abacus",
    tier: "default",
    configured: true,
  },
  ...[
    [OPUS, "Claude Opus 5.5"],
    [SONNET, "Claude Sonnet 5.5"],
  ].map(([id, label]): ModelAvailability => ({
    id: id!,
    label: label!,
    provider: "abacus",
    tier: "strong",
    ...(tier === "free"
      ? { configured: false, access: "locked" as const }
      : { configured: true }),
  })),
];

/** A fix, then the user saying it still fails: the complaint reason. */
const COMPLAINT: StreamChunk[] = [
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
];

/** The fix, then `ask`, its run ending on the agent's verdict on it. */
const judgedComplaint = (ask: string, complained: boolean): StreamChunk[] => [
  ...COMPLAINT.slice(
    0,
    COMPLAINT.findIndex((e) => e.type === "RUN_FINISHED") + 1
  ),
  b.runStarted("r2"),
  ...b.text("r2-u", "user", ask),
  b.textStart("r2-a"),
  ...b.toolCall("c2", "edit", "r2-a", { file_path: "/repo/login.js" }),
  b.toolResult("c2", { text: "Edited login.js" }),
  b.textDelta("r2-a", "I changed how the session is read."),
  b.textEnd("r2-a"),
  b.runFinished("r2", "success", { metadata: { abacus: { complained } } }),
];

/** Over the word list's length cap, and none of its words. */
const LONG_REBRIEF = `Stop checking the login by calling its functions in code. ${"When I sign in as a real user, typing my password, the page reloads and I land on the same form again. ".repeat(4)}Sign in the way I do and fix that.`;

/**
 * A game built through a connector's own tools (no file tool at all): it
 * runs Luau in Studio and playtests, says it is fixed, and the user writes
 * back that it still looks wrong.
 */
const CONNECTOR_COMPLAINT: StreamChunk[] = [
  b.runStarted("r1"),
  ...b.text("r1-u", "user", "Mach die Häuser schöner, sie sehen klobig aus"),
  b.textStart("r1-a"),
  ...b.toolCall("c1", "roblox-studio_search_game_tree", "r1-a", {
    query: "House",
  }),
  b.toolResult("c1", { text: "Workspace.House1, Workspace.House2" }),
  ...b.toolCall("c2", "roblox-studio_execute_luau", "r1-a", {
    code: "workspace.House1.Roof.Size = Vector3.new(12, 1, 12)",
  }),
  b.toolResult("c2", { text: "ok" }),
  ...b.toolCall("c3", "roblox-studio_start_stop_play", "r1-a", {
    mode: "start_play",
  }),
  b.toolResult("c3", { text: "Play started" }),
  ...b.toolCall("c4", "roblox-studio_get_console_output", "r1-a", {}),
  b.toolResult("c4", { text: "" }),
  b.textDelta("r1-a", "Behoben: die Häuser haben jetzt flachere Dächer."),
  b.textEnd("r1-a"),
  b.runFinished("r1", "success"),
  b.runStarted("r2"),
  ...b.text("r2-u", "user", "es sieht immer noch zu klobig aus"),
  b.textStart("r2-a"),
  ...b.toolCall("c5", "roblox-studio_execute_luau", "r2-a", {
    code: "workspace.House1.Roof.Size = Vector3.new(10, 1, 10)",
  }),
  b.toolResult("c5", { text: "ok" }),
  b.textDelta("r2-a", "Ich habe die Dächer schmaler gemacht."),
  b.textEnd("r2-a"),
  b.runFinished("r2", "success"),
];

/** A research answer that only looked things up, then the same complaint. */
const RESEARCH_COMPLAINT: StreamChunk[] = [
  b.runStarted("r1"),
  ...b.text("r1-u", "user", "Which Roblox genres are popular this year?"),
  b.textStart("r1-a"),
  ...b.toolCall("c1", "web_search", "r1-a", { query: "popular Roblox genres" }),
  b.toolResult("c1", { text: "Tycoons, obbies, simulators" }),
  ...b.toolCall("c2", "roblox-studio_search_game_tree", "r1-a", {
    query: "Workspace",
  }),
  b.toolResult("c2", { text: "Workspace.Baseplate" }),
  b.textDelta("r1-a", "Tycoons, obbies and simulators lead this year."),
  b.textEnd("r1-a"),
  b.runFinished("r1", "success"),
  b.runStarted("r2"),
  ...b.text("r2-u", "user", "es sieht immer noch zu klobig aus"),
  b.textStart("r2-a"),
  b.textDelta("r2-a", "Was genau sieht klobig aus?"),
  b.textEnd("r2-a"),
  b.runFinished("r2", "success"),
];

const VIDEO_ASK = "Make a 30-second video for my bakery's new croissant";

/** The same video ask twice, each answered by paid_feature's card: the repeat reason, on a hand-off. */
const REPEATED_VIDEO_ASK: StreamChunk[] = ["r1", "r2"].flatMap((run) => [
  b.runStarted(run),
  ...b.text(`${run}-u`, "user", VIDEO_ASK),
  b.textStart(`${run}-a`),
  ...b.toolCall(`${run}-c`, "agent-tools_paid_feature", `${run}-a`, {
    feature: "video_gen",
    prompt: VIDEO_ASK,
  }),
  b.toolResult(`${run}-c`, { text: "Basic makes videos on the web." }),
  b.textDelta(`${run}-a`, "Basic makes it in Abacus AI Agent on the web."),
  b.textEnd(`${run}-a`),
  b.runFinished(run, "success"),
]);

let current: Awaited<ReturnType<typeof renderRelay>> | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
  closeUpgradeDialog();
});

/** A deferred answer, so a test can look while the new chat is prepared. */
const later = () => {
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  const promise = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
};

const mount = async (
  tier: "free" | "basic",
  {
    continues = true,
    answer = () => Promise.resolve(),
    events = COMPLAINT,
  }: {
    continues?: boolean;
    answer?: () => Promise<void>;
    events?: StreamChunk[];
  } = {}
) => {
  const steps: Array<{ step: string; detail?: string }> = [];
  const continued: Array<[string, string | undefined]> = [];
  const moved: string[] = [];
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const os = implement(contract);
  current = await renderRelay(
    relay,
    "session",
    {
      model: {
        value: ROUTER,
        label: "RouteLLM",
        onChange: () => {},
        groups: [],
      },
      onSwitchThisChat: vi.fn(async (id: string) => {
        moved.push(id);
        return "chat" as const;
      }),
      onResumeOnModel: vi.fn(async (id: string) => {
        moved.push(id);
      }),
      ...(continues
        ? {
            onContinueInNewChat: vi.fn(
              async (model: string, prompt?: string) => {
                continued.push([model, prompt]);
                await answer();
              }
            ),
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
        abacus: os.account.abacus.handler(() => account(tier)),
        billingPlan: os.account.billingPlan.handler(() => billing(tier)),
      },
      models: { list: os.models.list.handler(() => catalog(tier)) },
    }
  );
  await act(async () => relay.emitAll(events));
  const prefs = () => current!.db.collections.prefs.get("app")?.dismissals;
  return { relay, steps, continued, moved, prefs };
};

const LINE = "Continue in a new chat";
const findLine = () =>
  screen.findByRole("button", { name: LINE }, { timeout: 5000 });

/** The retry offer's own funnel steps; a free plan's top-model card logs its own. */
const offerSteps = (steps: Array<{ step: string }>) =>
  steps.filter((each) => each.step.startsWith("retry_offer_"));

const settled = async () => {
  for (let index = 0; index < 4; index += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
};

describe("RetryOfferRow on a paying plan", () => {
  it("continues in a new chat on Opus with the stuck message, leaving this chat and its model alone", async () => {
    const pending = later();
    const h = await mount("basic", { answer: () => pending.promise });
    const line = await findLine();
    // No upgrade on a plan that has it: no "Included in" tag, and the cost said.
    const offer = line.closest('[data-slot="retry-offer"]')?.textContent;
    expect(offer).not.toContain("Included in");
    expect(offer).toContain("Try this again on Claude Opus 5.5");
    expect(offer).toContain("It uses credits faster.");
    fireEvent.click(line);
    // Up with a spinner while the summary is written.
    expect(
      await screen.findByRole("button", {
        name: "Preparing a new chat with Claude Opus 5.5…",
      })
    ).toHaveProperty("disabled", true);
    expect(h.continued).toEqual([[OPUS, "It still doesn't work, same error"]]);
    await act(async () => pending.resolve());
    await waitFor(() => expect(h.prefs()?.topModelHint?.switched).toBe(true));
    await waitFor(() =>
      expect(h.prefs()?.retryOffer?.answered).toEqual(expect.any(String))
    );
    // Nothing ran again here, and this chat kept its model.
    expect(h.relay.stats.send).toHaveLength(0);
    expect(h.moved).toEqual([]);
    expect(upgradeDialogStore.state.request).toBeNull();
    expect(h.steps).toEqual([
      { step: "retry_offer_shown", detail: "complaint_paid" },
      { step: "retry_offer_tapped", detail: "complaint_paid" },
      { step: "retry_offer_resumed", detail: "complaint_paid" },
    ]);
  });

  it("keeps the line for another try when the new chat could not be prepared", async () => {
    const h = await mount("basic", {
      answer: () => Promise.reject(new Error("failed")),
    });
    fireEvent.click(await findLine());
    expect(await findLine()).toHaveProperty("disabled", false);
    await settled();
    expect(h.prefs()?.retryOffer?.answered ?? null).toBeNull();
    expect(h.prefs()?.topModelHint?.switched ?? false).toBe(false);
    expect(h.steps.map((step) => step.step)).not.toContain(
      "retry_offer_resumed"
    );
  });
});

describe("RetryOfferRow on a free plan", () => {
  it("opens the upgrade dialog with the message waiting, and runs nothing on Opus", async () => {
    const h = await mount("free");
    const line = await findLine();
    fireEvent.click(line);
    await waitFor(() =>
      expect(upgradeDialogStore.state.request).toMatchObject({
        kind: "plan",
        src: "retry_offer",
        pendingText: "It still doesn't work, same error",
      })
    );
    await settled();
    expect(h.continued).toEqual([]);
    expect(h.relay.stats.send).toHaveLength(0);
    expect(h.steps.map((step) => [step.step, step.detail])).toContainEqual([
      "retry_offer_tapped",
      "complaint",
    ]);
  });
});

describe("RetryOfferRow in a chat that cannot be continued", () => {
  it("stays down: a bot's chat or a routine run keeps its model", async () => {
    await mount("basic", { continues: false });
    await settled();
    await settled();
    expect(document.querySelector('[data-slot="retry-offer"]')).toBeNull();
  });
});

describe("RetryOfferRow under a plan hand-off", () => {
  it("stays down on a repeated media ask: a top model gives the same card", async () => {
    const h = await mount("basic", { events: REPEATED_VIDEO_ASK });
    await settled();
    await settled();
    expect(document.querySelector('[data-slot="paid-feature"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="retry-offer"]')).toBeNull();
    expect(h.steps).toEqual([]);
  });
});

describe("RetryOfferRow after a connector's work", () => {
  it("offers the retry on a complaint after a turn that built through a connector's tools", async () => {
    await mount("free", { events: CONNECTOR_COMPLAINT });
    const line = await findLine();
    expect(
      line.closest('[data-slot="retry-offer"]')?.getAttribute("data-reason")
    ).toBe("complaint");
  });

  it("stays down on the same complaint after a turn that only looked things up", async () => {
    const h = await mount("free", { events: RESEARCH_COMPLAINT });
    await settled();
    await settled();
    expect(document.querySelector('[data-slot="retry-offer"]')).toBeNull();
    expect(offerSteps(h.steps)).toEqual([]);
  });
});

describe("RetryOfferRow on the agent's verdict", () => {
  it("offers the retry on a long re-brief the agent judged a complaint", async () => {
    await mount("free", { events: judgedComplaint(LONG_REBRIEF, true) });
    const line = await findLine();
    expect(
      line.closest('[data-slot="retry-offer"]')?.getAttribute("data-reason")
    ).toBe("complaint");
  });

  it("stays down on listed words the agent judged no complaint", async () => {
    const h = await mount("free", {
      events: judgedComplaint("It still doesn't work, same error", false),
    });
    await settled();
    await settled();
    expect(document.querySelector('[data-slot="retry-offer"]')).toBeNull();
    expect(offerSteps(h.steps)).toEqual([]);
  });
});
