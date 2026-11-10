import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { retryOfferForAccount } from "@abacus-ai/contract/retry-offer";
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

/** An account key in the half that gets the offer, so the free path is testable. */
const FREE_USER = (() => {
  for (let index = 0; index < 100; index += 1)
    if (retryOfferForAccount(`o1:u${index}`)) return `u${index}`;
  throw new Error("no account in the offer's half");
})();

const account = (tier: "free" | "basic") => ({
  user_id: tier === "free" ? FREE_USER : "u1",
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

let current: Awaited<ReturnType<typeof renderRelay>> | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
  closeUpgradeDialog();
});

const mount = async (tier: "free" | "basic") => {
  const steps: Array<{ step: string; detail?: string }> = [];
  const moved: Array<[string, string]> = [];
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
        moved.push(["chat", id]);
        return "chat" as const;
      }),
      onResumeOnModel: vi.fn(async (id: string) => {
        moved.push(["app", id]);
      }),
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
  await act(async () => relay.emitAll(COMPLAINT));
  const line = await screen.findByRole(
    "button",
    { name: "Try this again with Claude Opus 5.5" },
    { timeout: 5000 }
  );
  const prefs = () => current!.db.collections.prefs.get("app")?.dismissals;
  return { relay, steps, moved, line, prefs };
};

/** The last message sent, with what it carried. */
const lastSend = (relay: FakeRelay) =>
  JSON.stringify(relay.stats.send.at(-1) ?? null);

describe("RetryOfferRow on a paying plan", () => {
  it("runs the message again on Opus at once and keeps this chat on it", async () => {
    const h = await mount("basic");
    // No upgrade on a plan that has it: no "Included in" tag.
    expect(
      h.line.closest('[data-slot="retry-offer"]')?.textContent
    ).not.toContain("Included in");
    fireEvent.click(h.line);
    await waitFor(() => expect(h.relay.stats.send).toHaveLength(1));
    // This chat moved, never the app's default.
    expect(h.moved).toEqual([["chat", OPUS]]);
    expect(lastSend(h.relay)).toContain(OPUS);
    expect(lastSend(h.relay)).toContain("It still doesn't work, same error");
    expect(upgradeDialogStore.state.request).toBeNull();
    await waitFor(() => expect(h.prefs()?.topModelHint?.switched).toBe(true));
    await waitFor(() =>
      expect(h.steps).toEqual([
        { step: "retry_offer_shown", detail: "complaint_paid" },
        { step: "retry_offer_tapped", detail: "complaint_paid" },
        { step: "retry_offer_resumed", detail: "complaint_paid" },
      ])
    );
  });
});

describe("RetryOfferRow on a free plan", () => {
  it("opens the upgrade dialog, and once paid moves this chat only and sends on Opus", async () => {
    const h = await mount("free");
    expect(h.line.closest('[data-slot="retry-offer"]')?.textContent).toContain(
      "Included in Basic"
    );
    fireEvent.click(h.line);
    const request = upgradeDialogStore.state.request;
    expect(request).toMatchObject({
      kind: "plan",
      src: "model_locked",
      pendingText: "It still doesn't work, same error",
    });
    expect(h.relay.stats.send).toHaveLength(0);
    // The plan is paid: the dialog resumes.
    await act(async () => {
      await request!.resume!();
    });
    await waitFor(() => expect(h.relay.stats.send).toHaveLength(1));
    expect(h.moved).toEqual([["chat", OPUS]]);
    expect(lastSend(h.relay)).toContain(OPUS);
    await waitFor(() =>
      expect(h.steps.map((step) => [step.step, step.detail])).toContainEqual([
        "retry_offer_resumed",
        "complaint",
      ])
    );
  });
});
