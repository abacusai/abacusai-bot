import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";

import en from "#locales/en-US.json";
import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
import { setViewportWidth } from "#renderer/test-support/media";

import { openFloating } from "./shell-store";

const os = implement(contract);
const account = {
  user_id: "dummy",
  organization_id: "dummy-org",
  name: "Ada Example",
  email: "ada@example.com",
  picture: null,
  organization: "Example",
  org_user_count: 1,
  plan: "Pro",
  subscription_tier: "pro",
  credits_granted: 100,
  credits_used: 0,
};
const summary = {
  inviteLink: "https://example.com/invite/dummy",
  invitesSent: 2,
  milestoneInvites: 5,
  milestoneCredits: 100,
  milestoneGranted: false,
  friendsJoined: 1,
  creditsPerFriend: 10,
  gmailConnected: false,
};

it("moves Settings into the profile menu, changes the shared theme and deep-links Usage", async () => {
  const app = await renderApp("/sessions/new", {
    procedures: {
      account: { abacus: os.account.abacus.handler(() => account) },
    },
  });
  try {
    const trigger = await screen.findByRole("button", { name: account.name });
    expect(
      screen.queryByRole("link", { name: en.shell.rail.settings })
    ).toBeNull();
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText(account.email)).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: /Settings/ }).textContent
    ).toContain("⌘");
    fireEvent.click(
      within(menu).getByRole("menuitemradio", { name: en.theme.dark })
    );
    await waitFor(() =>
      expect(app.collections.prefs.get("app")?.theme).toBe("dark")
    );
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: en.settings.pages.usage })
    );
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/settings/usage")
    );
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("opens a referral dialog, copies the real link, selects it on clipboard failure, and returns focus", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  const previousClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard"
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  const app = await renderApp("/sessions/new", {
    procedures: {
      account: { abacus: os.account.abacus.handler(() => account) },
      referrals: { summary: os.referrals.summary.handler(() => summary) },
    },
  });
  try {
    const trigger = await screen.findByRole("button", { name: account.name });
    fireEvent.click(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: en.referrals.title })
    );
    const dialog = await screen.findByRole("dialog", {
      name: en.referrals.title,
    });
    expect(within(dialog).getByText("2 of 5 invites sent")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: en.phase5.copyInvite })
    );
    await waitFor(() => expect(copy).toHaveBeenCalledWith(summary.inviteLink));
    copy.mockRejectedValueOnce(new Error("Clipboard denied"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: en.phase5.copyInvite })
    );
    const field = within(dialog).getByRole("textbox", {
      name: en.phase5.inviteLink,
    }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.selectionEnd).toBe(summary.inviteLink.length);
    fireEvent.click(
      within(dialog).getByRole("button", { name: en.profile.close })
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  } finally {
    app.view.unmount();
    await app.cleanup();
    if (previousClipboard)
      Object.defineProperty(navigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("swaps the paid link and free promo from the shared account cache without a paid mascot", async () => {
  let current = account;
  const open = vi.fn();
  const app = await renderApp("/sessions/new", {
    procedures: {
      account: { abacus: os.account.abacus.handler(() => current) },
      system: {
        openExternal: os.system.openExternal.handler(({ input }) =>
          open(input)
        ),
      },
    },
  });
  const refresh = () =>
    act(async () => {
      await app.router.options.context.queryClient.invalidateQueries({
        queryKey: app.transport.orpc.account.abacus.queryKey(),
      });
    });
  try {
    const link = await screen.findByRole("link", { name: en.profile.agent });
    expect(link.getAttribute("href")).toBe(ABACUS_AGENT_URL);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(link);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({ url: ABACUS_AGENT_URL })
    );
    current = {
      ...account,
      plan: "Free",
      subscription_tier: "free",
      credits_used: 100,
    };
    await refresh();
    await screen.findByRole("button", { name: en.creditsCard.cta });
    expect(screen.queryByRole("link", { name: en.profile.agent })).toBeNull();
    current = account;
    await refresh();
    await screen.findByRole("link", { name: en.profile.agent });
    expect(document.querySelector('[data-slot="upgrade-promo"]')).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it.each(["pinned", "collapsed", "strip", "floating", "phone"] as const)(
  "keeps one profile menu and one paid link in %s mode",
  async (mode) => {
    setViewportWidth(mode === "strip" ? 800 : mode === "phone" ? 375 : 1280);
    const seed = defaultSeed();
    seed.prefs!.sidebar.pinned = mode === "pinned" || mode === "strip";
    const app = await renderApp(
      mode === "strip" ? "/bots/new" : "/sessions/new",
      {
        seed,
        procedures: {
          account: { abacus: os.account.abacus.handler(() => account) },
        },
      }
    );
    try {
      if (mode === "floating" || mode === "phone")
        act(() => openFloating("peek"));
      await screen.findByRole("link", { name: en.profile.agent });
      expect(
        screen.getAllByRole("link", { name: en.profile.agent })
      ).toHaveLength(1);
      const trigger = screen.getByRole("button", { name: account.name });
      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu");
      expect(
        within(menu).getAllByRole("menuitem", { name: /Settings/ })
      ).toHaveLength(1);
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      app.view.unmount();
      await app.cleanup();
      setViewportWidth(1280);
    }
  }
);
