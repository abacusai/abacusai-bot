/**
 * Continuing a stuck chat in a new one, through the real router: the retry
 * line under a stuck task asks the old chat's agent for a summary, opens the
 * new chat in the same folder on Opus with a line saying what it starts
 * from, and sends the stuck message there with the summary going to main.
 * The old chat keeps its model; each chat links to the other.
 */
import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as b from "#renderer/features/chat/fixtures/builders";
import { FakeRelay } from "#renderer/features/chat/fixtures/relay";
import { startDraftStore } from "#renderer/features/sessions/start/start-session";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

const ROUTER = "abacus/route-llm-code-low";
const OPUS = "abacus/claude-opus-5-5";
const SUMMARY = "## Goal\nFix the crash on the login page.";
const STUCK = "It still doesn't work, same error";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
const width = window.innerWidth;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
  });
});
afterEach(async () => {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

const BILLING: BillingPlan = {
  current: {
    plan: "basic",
    planName: "Basic",
    creditsRemaining: 13_000,
    creditsGranted: 14_000,
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
      creditsPerMonth: 14_000,
      current: true,
    },
  ],
  upgrades: [],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

const MODELS: ModelAvailability[] = [
  [ROUTER, "RouteLLM"],
  [OPUS, "Claude Opus 5.5"],
  ["abacus/claude-sonnet-5-5", "Claude Sonnet 5.5"],
].map(([id, label]) => ({
  id: id!,
  label: label!,
  provider: "abacus",
  tier: "default",
  configured: true,
}));

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
  ...b.text("r2-u", "user", STUCK),
  b.textStart("r2-a"),
  ...b.toolCall("c2", "edit", "r2-a", { file_path: "/repo/login.js" }),
  b.toolResult("c2", { text: "Edited login.js" }),
  b.textDelta("r2-a", "I changed how the session is read."),
  b.textEnd("r2-a"),
  b.runFinished("r2", "success"),
];

it("a stuck chat on a paid plan continues in a new chat on Opus, and the two link to each other", async () => {
  const os = implement(contract);
  const handoffs: unknown[] = [];
  const relay = new FakeRelay({ threadId: "spreadsheet" });
  relay.emitAll(b.sessionReady());
  const seed = defaultSeed();
  seed.sessions = seed.sessions?.map((session) =>
    session.id === "spreadsheet"
      ? { ...session, model: ROUTER, status: "running" as never }
      : session
  );
  app = await renderApp("/sessions/spreadsheet?view=split", {
    seed,
    ai: relay.ai as never,
    models: MODELS,
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => ({
          user_id: "u1",
          organization_id: "o1",
          name: null,
          email: null,
          picture: null,
          organization: null,
          org_user_count: null,
          plan: null,
          subscription_tier: "basic",
          credits_granted: 14_000,
          credits_used: 1_000,
        })),
        billingPlan: os.account.billingPlan.handler(() => BILLING),
      },
      git: {
        worktrees: {
          setForSession: os.git.worktrees.setForSession.handler(() => ({
            success: true,
          })),
        },
      },
      terminal: { promoteScope: os.terminal.promoteScope.handler(() => null) },
      browser: {
        runtime: {
          promoteScope: os.browser.runtime.promoteScope.handler(() => []),
        },
      },
      agent: {
        action: os.agent.action.handler(({ input }) => {
          handoffs.push(input);
          return { ok: true, summary: SUMMARY };
        }),
      },
    },
  } as never);
  await act(async () => relay.emitAll(COMPLAINT));
  fireEvent.click(
    await screen.findByRole(
      "button",
      { name: "Try again in a new chat with Claude Opus 5.5" },
      { timeout: 10_000 }
    )
  );
  // The new chat's start page, in the old chat's folder, saying what it starts from.
  await waitFor(
    () => expect(app!.router.state.location.pathname).toMatch(/^\/sessions\//),
    { timeout: 10_000 }
  );
  expect(handoffs).toEqual([
    { workspaceId: "default", sessionId: "spreadsheet", action: "handoff" },
  ]);
  expect(
    (await screen.findByText(/Starts from a summary of/)).textContent
  ).toContain("Clean up a spreadsheet");
  // The stuck message goes out at once, on Opus, into a chat that carries the summary.
  const sent = await waitFor(
    () => {
      const found = relay.stats.send.find(
        (send) => (send as { threadId?: string }).threadId !== "spreadsheet"
      ) as
        | { threadId: string; forwardedProps?: { model?: string } }
        | undefined;
      expect(found).toBeDefined();
      return found!;
    },
    { timeout: 10_000 }
  );
  expect(sent.forwardedProps?.model).toBe(OPUS);
  expect(JSON.stringify(sent)).toContain(STUCK);
  const next = app.collections.sessions.get(sent.threadId)!;
  expect(next).toMatchObject({
    workspaceId: "default",
    continuedFrom: "spreadsheet",
  });
  // Nothing ran again in the old chat, and it keeps its model.
  expect(app.collections.sessions.get("spreadsheet")?.model).toBe(ROUTER);
  expect(
    relay.stats.send.filter(
      (send) => (send as { threadId?: string }).threadId === "spreadsheet"
    )
  ).toHaveLength(0);
  // The new chat opens once its first message is in.
  await waitFor(() =>
    expect(app!.router.state.location.pathname).toBe(
      `/sessions/${sent.threadId}`
    )
  );
  // The draft that carried the summary is spent.
  await waitFor(() =>
    expect(startDraftStore.state.continuation).toBeUndefined()
  );
}, 60_000);

it.each([
  ["flights", "Continued from", "Clean up a spreadsheet"],
  ["spreadsheet", "Continued in", "Find me flights"],
] as const)(
  "the chats link to each other: %s shows “%s” %s",
  async (thread, words, other) => {
    const relay = new FakeRelay({ threadId: thread });
    relay.emitAll(b.sessionReady());
    const seed = defaultSeed();
    seed.sessions = seed.sessions?.map((session) =>
      session.id === "flights"
        ? { ...session, continuedFrom: "spreadsheet" }
        : session
    );
    app = await renderApp(`/sessions/${thread}?view=split`, {
      seed,
      ai: relay.ai as never,
    } as never);
    await act(async () =>
      relay.emitAll([
        b.runStarted("r1"),
        ...b.text("r1-u", "user", "Fix the login crash"),
        ...b.text("r1-a", "assistant", "Found it."),
        b.runFinished("r1", "success"),
      ])
    );
    const link = (
      await screen.findByText(words, undefined, {
        timeout: 10_000,
      })
    ).closest('[data-slot="continuation-link"]')!;
    expect(link.querySelector("a")?.textContent).toBe(other);
  },
  30_000
);
