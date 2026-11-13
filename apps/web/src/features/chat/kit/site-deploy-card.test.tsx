import { contract } from "@abacus-ai/contract/contract";
import type { SiteReadyMark } from "@abacus-ai/contract/site-deploy";
import { implement } from "@orpc/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DbProvider } from "#renderer/data/db";
import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import { IS_BROWSER } from "#renderer/lib/platform";
import { createHarness, defaultSeed } from "#renderer/test-support/app-harness";

import { ChatViewProvider, type ChatViewContextValue } from "./context";
import { SiteDeployCard } from "./site-deploy-card";

const PAID = {
  user_id: "u1",
  organization_id: "o1",
  name: null,
  email: null,
  picture: null,
  organization: null,
  org_user_count: null,
  plan: "basic",
  subscription_tier: "basic",
  credits_granted: 20000,
  credits_used: 200,
};

let cleanup: (() => Promise<void>) | undefined;
const unmount = async () => {
  await cleanup?.();
  cleanup = undefined;
};
afterEach(unmount);

const mount = async (mark: SiteReadyMark, closed?: string) => {
  const os = implement(contract);
  const seed = defaultSeed();
  const base = fixturePrefs();
  const opened: string[] = [];
  const copied: string[] = [];
  Object.assign(navigator, {
    clipboard: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  const harness = await createHarness("/", {
    seed: {
      ...seed,
      prefs: fixturePrefs({
        siteReady: { "thread-1": mark },
        dismissals: {
          ...base.dismissals,
          siteDeployCards: closed != null ? { "thread-1": closed } : {},
        },
      }),
      routines: [
        {
          ...seed.routines![0]!,
          name: "BTC morning news",
          prompt: "Send me the BTC headlines",
          schedule: "0 9 * * *",
          createdAt: 2_000_000_000_000,
        },
      ],
    },
    openExternal: (url) => opened.push(url),
    procedures: {
      account: { abacus: os.account.abacus.handler(() => PAID) },
    },
  });
  const chat = {
    threadId: "thread-1",
    session: { threadId: "thread-1" },
    composer: {},
    slots: {},
  } as unknown as ChatViewContextValue;
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={harness.router.options.context.queryClient}>
        <RouterContextProvider router={harness.router}>
          <DbProvider value={harness.appDb}>
            <ChatViewProvider value={chat}>
              <SiteDeployCard active={false} />
            </ChatViewProvider>
          </DbProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  });
  cleanup = async () => {
    rendered.unmount();
    await harness.cleanup();
  };
  const steps = () =>
    harness.calls
      .filter(([name]) => name === "system.funnelStep")
      .map(([, input]) => input as { step: string; detail?: string });
  const closedFor = () =>
    harness.appDb.collections.prefs.get("app")?.dismissals.siteDeployCards?.[
      "thread-1"
    ];
  return { steps, opened, copied, closedFor };
};

const SERVER: SiteReadyMark = {
  turnId: "turn-2",
  siteDir: "/work/btc-bot",
  at: 1,
  kind: "server",
  name: "btc-bot",
};

describe.runIf(!IS_BROWSER)("SiteDeployCard on a paid plan", () => {
  it("a site keeps its deploy card", async () => {
    await mount({ turnId: "turn-1", siteDir: "/work/bakery", at: 1 });
    expect(await screen.findByText("Deploy your site")).toBeTruthy();
  });

  it("a server: keep it running 24/7, its steps asking the agent to keep it on", async () => {
    const h = await mount(SERVER);
    expect(await screen.findByText("Keep “btc-bot” running 24/7")).toBeTruthy();
    expect(
      screen.getByText(
        "It runs only while this computer is on. Your plan includes personal agents in Abacus AI Agent on the web, which keep it running with your computer off."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() =>
      expect(h.copied).toEqual([
        "Deploy this from the zip I uploaded and keep it running 24/7. The conversation that built it is in abacusai-bot-conversation.md inside the zip.",
      ])
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Open Abacus AI Agent/ })
    );
    await waitFor(() =>
      expect(h.steps()).toEqual(
        expect.arrayContaining([
          { step: "site_deploy_shown", detail: "keep_running" },
          { step: "site_deploy_open_agent", detail: "keep_running" },
          { step: "keep_running_move", detail: "server" },
        ])
      )
    );
  });

  it("a routine: one button that opens the agent with the routine typed in", async () => {
    const h = await mount({
      turnId: "turn-3",
      siteDir: null,
      at: 1,
      kind: "routine",
      name: "BTC morning news",
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Set it up in Abacus AI Agent/,
      })
    );
    await waitFor(() => expect(h.opened).toHaveLength(1));
    const prompt = new URL(h.opened[0]!).searchParams.get("prompt");
    expect(prompt).toBe(
      "Set up a scheduled task that runs 24/7, called “BTC morning news”. Schedule (cron, my local time): 0 9 * * *. Each run: Send me the BTC headlines"
    );
    expect(h.steps()).toContainEqual({
      step: "keep_running_move",
      detail: "routine",
    });
  });

  it("closed, it stays closed for that thing, and a turn closed by an older build stays closed", async () => {
    const h = await mount(SERVER);
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(h.closedFor()).toBe("server:/work/btc-bot"));
    await unmount();

    // A later turn that started the same server; a card an older build closed by its turn.
    for (const [mark, closed] of [
      [{ ...SERVER, turnId: "turn-9" }, "server:/work/btc-bot"],
      [SERVER, "turn-2"],
    ] as const) {
      await mount(mark, closed);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        document.querySelector('[data-slot="site-deploy-card"]')
      ).toBeNull();
      await unmount();
    }
  });
});
