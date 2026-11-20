import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { onboardingStore } from "#renderer/features/onboarding";
import { firstBotStore } from "#renderer/features/onboarding/first-bot";
import {
  newStartDraft,
  startDraftStore,
} from "#renderer/features/sessions/start/start-session";
import { updateDraft } from "#renderer/lib/continuity/composer-drafts";
import {
  noteWebsitePromptTaken,
  websitePromptSessionId,
} from "#renderer/lib/website-prompt";
import {
  renderApp,
  defaultSeed,
  type AppHarness,
} from "#renderer/test-support/app-harness";

const PROMPT = "Build a booking site for my pottery studio";

let harness: (AppHarness & { view: { unmount(): void } }) | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});
beforeEach(() => {
  localStorage.removeItem("abacusai-bot:onboarding.websitePrompt");
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
  firstBotStore.setState(() => ({ state: "idle" }));
  startDraftStore.setState(newStartDraft);
});

/** The first-run step of a fresh account whose Gmail is connected (the Chief of Staff would start on its own). */
const renderFirstRun = async ({
  prompt = PROMPT as string | null,
  sessions = 0,
} = {}) => {
  const seed = defaultSeed();
  seed.bots = [];
  seed.routines = [];
  seed.sessions = (seed.sessions ?? []).slice(0, sessions);
  const os = implement(contract);
  harness = await renderApp("/onboarding/first-bot", {
    onboarded: false,
    signedIn: true,
    seed,
    models: [
      {
        id: "abacus/route-llm",
        label: "RouteLLM",
        provider: "abacus",
        tier: "default",
        configured: true,
        recommended: true,
      },
    ],
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => ({
          user_id: "fixture-user",
          organization_id: null,
          name: null,
          email: null,
          picture: null,
          organization: null,
          org_user_count: null,
          plan: "Free",
          subscription_tier: "FREE",
          credits_used: null,
          credits_granted: null,
          ...(prompt != null ? { website_prompt: prompt } : {}),
        })),
      },
      connectors: {
        statuses: os.connectors.statuses.handler(
          () => ({ "abacus-gmailuser": { state: "connected" } }) as never
        ),
      },
    },
  });
  return harness;
};

const funnel = () =>
  harness!.calls
    .filter(([name]) => name === "system.funnelStep")
    .map(([, input]) => input);

it("a fresh install sends the website's prompt as the person's first message, labelled, instead of the Chief of Staff", async () => {
  await renderFirstRun();
  // Sent on its own as the person's words, in a fresh chat on the house, as
  // soon as the start page's box is ready.
  await waitFor(() => expect(startDraftStore.state.stage).not.toBe("draft"));
  expect(startDraftStore.state.envelope?.parts).toEqual([
    { type: "text", content: PROMPT },
  ]);
  expect(startDraftStore.state.sponsored).toBe(true);
  // The chat it becomes is the one the label goes on.
  expect(websitePromptSessionId()).toBe(startDraftStore.state.id);
  // No first-run task of the app's own: no Chief of Staff, no inbox pass.
  expect(harness!.collections.bots.toArray).toHaveLength(0);
  expect(
    harness!.calls.filter(([name]) => name === "bots.openChat")
  ).toHaveLength(0);
  expect(funnel()).toContainEqual({
    step: "website_prompt_run",
    detail: "short",
  });
  expect(funnel()).toContainEqual({ step: "start_sent", detail: "auto" });
  expect(
    harness!.calls.filter(([name]) => name === "account.skipOnboarding")
  ).toHaveLength(1);
});

it("an install that already has chats keeps the usual first run and lets the prompt go", async () => {
  await renderFirstRun({ sessions: 1 });
  await waitFor(() =>
    expect(funnel()).toContainEqual({
      step: "website_prompt_skipped",
      detail: "has_sessions",
    })
  );
  // The Chief of Staff starts as it would have.
  await waitFor(() =>
    expect(harness!.collections.bots.toArray).toHaveLength(1)
  );
  expect(startDraftStore.state.envelope).toBeNull();
  expect(
    localStorage.getItem("abacusai-bot:onboarding.websitePrompt")
  ).not.toBeNull();
  expect(websitePromptSessionId()).toBeNull();
});

it("words the person already typed are never replaced", async () => {
  updateDraft(`draft:${startDraftStore.state.id}`, (draft) => ({
    ...draft,
    text: "my own first ask",
  }));
  await renderFirstRun();
  await waitFor(() =>
    expect(funnel()).toContainEqual({
      step: "website_prompt_skipped",
      detail: "typed",
    })
  );
  expect(startDraftStore.state.envelope).toBeNull();
  expect(websitePromptSessionId()).toBeNull();
});

it("a prompt this install already took is not run again", async () => {
  noteWebsitePromptTaken("earlier-chat");
  await renderFirstRun();
  await waitFor(() =>
    expect(harness!.collections.bots.toArray).toHaveLength(1)
  );
  expect(
    funnel().some((input) =>
      (input as { step: string }).step.startsWith("website_prompt")
    )
  ).toBe(false);
  expect(startDraftStore.state.envelope).toBeNull();
});

it("without a website prompt the first run is the usual one", async () => {
  await renderFirstRun({ prompt: null });
  await waitFor(() =>
    expect(harness!.collections.bots.toArray).toHaveLength(1)
  );
  expect(
    funnel().some((input) =>
      (input as { step: string }).step.startsWith("website_prompt")
    )
  ).toBe(false);
  expect(
    localStorage.getItem("abacusai-bot:onboarding.websitePrompt")
  ).toBeNull();
});
