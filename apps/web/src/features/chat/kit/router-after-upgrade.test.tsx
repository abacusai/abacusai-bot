import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { contract } from "@abacus-ai/contract/contract";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

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
  {
    resumed = false,
    pinned = OPUS as string | null,
    defaultModel = ROUTER,
    catalog = CATALOG,
  }: {
    resumed?: boolean;
    pinned?: string | null;
    defaultModel?: string;
    catalog?: ModelAvailability[];
  } = {}
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
        value: pinned,
        ...(pinned == null && { resolved: defaultModel }),
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
      models: { list: os.models.list.handler(() => catalog) },
      settings: {
        get: os.settings.get.handler(
          () => ({ defaultModel, apiKeys: {} }) as never
        ),
      },
    }
  );
  if (resumed) noteTopModelResume(relay.threadId);
  await act(async () => relay.emitAll(turn(reply)));
  return { continued };
};

const LINE = "Make your credits last: continue on RouteLLM in a new chat";
const CLEAN = "Fixed: the last row now fits on the page.";

const noLine = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(screen.queryByRole("button", { name: LINE })).toBeNull();
};

it("after the upgrade's clean result on Opus: continue on the plan's router in a new chat, or stay", async () => {
  const h = await mount(CLEAN, { resumed: true });
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
  const h = await mount(CLEAN, { resumed: true });
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

it("a chat pinned to Opus on its first turn, with the router as the app's default, gets the line", async () => {
  await mount(CLEAN);
  expect(
    await screen.findByRole("button", { name: LINE }, { timeout: 5000 })
  ).toBeTruthy();
});

it("on Basic, whose plan model is RouteLLM - Open: the way back is a new chat on it", async () => {
  // Basic's catalog: RouteLLM - Open is the plan's model; no code router.
  const basic: ModelAvailability[] = [
    {
      id: "openllm/auto",
      label: "RouteLLM - Open",
      provider: "openllm",
      tier: "default",
      configured: true,
      recommended: true,
    },
    CATALOG[1]!,
  ];
  const h = await mount(CLEAN, {
    resumed: true,
    defaultModel: "openllm/auto",
    catalog: basic,
  });
  fireEvent.click(
    await screen.findByRole(
      "button",
      {
        name: "Make your credits last: continue on RouteLLM - Open in a new chat",
      },
      { timeout: 5000 }
    )
  );
  await waitFor(() =>
    expect(h.continued).toEqual([["openllm/auto", undefined]])
  );
});

it("someone whose default is Opus chose it: no line", async () => {
  await mount(CLEAN, { defaultModel: OPUS });
  await noLine();
});

it("a chat on the app's default, not pinned and not resumed: no line", async () => {
  await mount(CLEAN, { pinned: null, defaultModel: OPUS });
  await noLine();
});

it("a reply that declines: no line", async () => {
  await mount("I can't do that.", { resumed: true });
  await noLine();
});
