import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { fixtureSessions } from "#renderer/data/fixture-db/rows";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";
import { noteTopModelResume } from "./router-after-upgrade";

const ROUTER = "abacus/route-llm-code-low";
const OPUS = "abacus/claude-opus-5-5";

const BASIC = {
  user_id: "u1",
  organization_id: "o1",
  name: null,
  email: null,
  picture: null,
  organization: null,
  org_user_count: null,
  plan: null,
  subscription_tier: "basic",
  credits_granted: 20000,
  credits_used: 300,
};

const BILLING: BillingPlan = {
  current: {
    plan: "basic",
    planName: "Basic",
    creditsRemaining: 19700,
    creditsGranted: 20000,
    freeTierExpiresAt: null,
  },
  plans: [],
  upgrades: [],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

const CATALOG: ModelAvailability[] = [
  {
    id: ROUTER,
    label: "RouteLLM",
    provider: "abacus",
    tier: "default",
    configured: true,
    recommended: true,
  },
  {
    id: OPUS,
    label: "Claude Opus 5.5",
    provider: "abacus",
    tier: "strong",
    configured: true,
  },
];

const turn = (reply: string): StreamChunk[] => [
  b.runStarted("r1"),
  ...b.text("r1-u", "user", "still cut off, fix the last row"),
  b.textStart("r1-a"),
  b.textDelta("r1-a", reply),
  b.textEnd("r1-a"),
  b.runFinished("r1", "success"),
];

let chats = 0;
let current: Awaited<ReturnType<typeof renderRelay>> | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

const mount = async (
  reply: string,
  resumed: boolean,
  { continuedFrom }: { continuedFrom?: string } = {}
) => {
  const continued: Array<[string, string | undefined]> = [];
  // A chat of its own: the offer's answers are kept per chat.
  const relay = new FakeRelay({ threadId: `t-${(chats += 1)}` });
  relay.emitAll(b.sessionReady());
  const os = implement(contract);
  current = await renderRelay(
    relay,
    "session",
    {
      model: {
        value: OPUS,
        label: "Claude Opus 5.5",
        onChange: () => {},
        groups: [],
      },
      onContinueInNewChat: async (model: string, prompt?: string) => {
        continued.push([model, prompt]);
      },
    },
    {},
    undefined,
    {
      account: {
        abacus: os.account.abacus.handler(() => BASIC),
        billingPlan: os.account.billingPlan.handler(() => BILLING),
      },
      models: { list: os.models.list.handler(() => CATALOG) },
    }
  );
  if (resumed) noteTopModelResume(relay.threadId);
  // The chat's row, as a continued chat is started (start-session.ts).
  if (continuedFrom != null)
    act(() => {
      current!.db.collections.sessions.insert({
        ...fixtureSessions()[0]!,
        id: relay.threadId,
        continuedFrom,
        continuation: { sessionId: continuedFrom, summary: "The goal." },
      } as never);
    });
  await act(async () => relay.emitAll(turn(reply)));
  return { continued };
};

const LINE = "Make your credits last: continue on RouteLLM in a new chat";

it("after the upgrade's clean result on Opus: continue on the plan's router in a new chat, or stay", async () => {
  const h = await mount("Fixed: the last row now fits on the page.", true);
  const line = await screen.findByRole(
    "button",
    { name: LINE },
    { timeout: 5000 }
  );
  expect(
    screen.getByRole("button", { name: "Stay on Claude Opus 5.5" })
  ).toBeTruthy();
  fireEvent.click(line);
  await waitFor(() => expect(h.continued).toEqual([[ROUTER, undefined]]));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: LINE })).toBeNull()
  );
});

it("Stay keeps the chat on Opus and the line goes", async () => {
  const h = await mount("Fixed: the last row now fits on the page.", true);
  fireEvent.click(
    await screen.findByRole(
      "button",
      { name: "Stay on Claude Opus 5.5" },
      { timeout: 5000 }
    )
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: LINE })).toBeNull()
  );
  expect(h.continued).toEqual([]);
});

it("a chat continued in a new one on Opus gets the line under its first result", async () => {
  await mount("Fixed: the last row now fits on the page.", false, {
    continuedFrom: "s-before",
  });
  expect(
    await screen.findByRole("button", { name: LINE }, { timeout: 5000 })
  ).toBeTruthy();
});

it.each([
  ["a turn the upgrade did not resume", "Fixed: the last row fits.", false],
  ["a reply that declines", "I can't do that.", true],
])("no line after %s", async (_name, reply, resumed) => {
  await mount(reply, resumed);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(screen.queryByRole("button", { name: LINE })).toBeNull();
});
