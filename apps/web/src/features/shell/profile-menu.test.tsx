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

it("keeps Settings in the rail, changes the shared theme and deep-links Usage", async () => {
  const app = await renderApp("/sessions/new", {
    procedures: {
      account: { abacus: os.account.abacus.handler(() => account) },
    },
  });
  try {
    const trigger = await screen.findByRole("button", { name: account.name });
    expect(
      screen.getByRole("link", { name: en.shell.rail.settings })
    ).toBeTruthy();
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText(account.email)).toBeTruthy();
    expect(
      within(menu).queryByRole("menuitem", { name: /Settings/ })
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: en.settings.pages.account })
    ).toBeTruthy();
    fireEvent.click(within(menu).getByRole("radio", { name: en.theme.dark }));
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

it("exposes one Theme radio group, keeps selection open, and supports roving focus", async () => {
  const app = await renderApp("/sessions/new", {
    procedures: {
      account: { abacus: os.account.abacus.handler(() => account) },
    },
  });
  try {
    const trigger = await screen.findByRole("button", { name: account.name });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    const group = within(menu).getByRole("radiogroup", {
      name: en.settings.theme.label,
    });
    expect(within(menu).getAllByRole("radiogroup")).toHaveLength(1);
    const options = within(group).getAllByRole("radio");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
      en.theme.light,
      en.theme.dark,
      en.theme.system,
    ]);
    for (const [index, theme] of ["light", "dark", "system"].entries()) {
      fireEvent.click(options[index]!);
      await waitFor(() =>
        expect(app.collections.prefs.get("app")?.theme).toBe(theme)
      );
      expect(options[index]!.getAttribute("aria-checked")).toBe("true");
      expect(options[index]!.getAttribute("data-selected")).toBe("true");
      expect(screen.getByRole("menu")).toBe(menu);
    }
    const appearance = within(menu).getByRole("menuitem", {
      name: en.settings.pages.appearance,
    });
    act(() => appearance.focus());
    fireEvent.keyDown(appearance, { key: "Tab" });
    await waitFor(() =>
      expect(group.contains(document.activeElement)).toBe(true)
    );
    const first = document.activeElement!;
    fireEvent.keyDown(first, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).not.toBe(first));
    expect(group.contains(document.activeElement)).toBe(true);
    expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "Tab" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(menu).getByRole("menuitem", { name: en.profile.help })
      )
    );
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    await waitFor(() =>
      expect(group.contains(document.activeElement)).toBe(true)
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
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
    expect(await within(dialog).findByText("2 of 5 invites sent")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: en.phase5.copyInvite })
    );
    await waitFor(() => expect(copy).toHaveBeenCalledWith(summary.inviteLink));
    await screen.findByRole("button", { name: en.phase5.copied });
    copy.mockRejectedValueOnce(new Error("Clipboard denied"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: en.phase5.copied })
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
      if (mode === "floating" || mode === "phone")
        await waitFor(() =>
          expect(
            document
              .querySelector('[data-slot="sidebar-floating"]')
              ?.contains(document.activeElement)
          ).toBe(true)
        );
      await screen.findByRole("link", { name: en.profile.agent });
      expect(
        screen.getAllByRole("link", { name: en.profile.agent })
      ).toHaveLength(1);
      expect(
        screen
          .getByRole("link", { name: en.profile.agent })
          .closest('[data-slot="rail"]')
      ).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: en.shell.rail.settings })
          .closest('[data-slot="rail"]')
      ).toBeTruthy();
      const trigger = screen.getByRole("button", { name: account.name });
      expect(trigger.closest('[data-slot="rail"]')).toBeTruthy();
      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu");
      expect(
        within(menu).getAllByRole("menuitem", {
          name: en.settings.pages.account,
        })
      ).toHaveLength(1);
      await waitFor(() =>
        expect(menu.contains(document.activeElement)).toBe(true)
      );
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: account.name })
        )
      );
    } finally {
      app.view.unmount();
      await app.cleanup();
      setViewportWidth(1280);
    }
  }
);

it.each([
  ["settings.pages.account", "/settings/account"],
  ["settings.pages.usage", "/settings/usage"],
  ["phase5.managePlan", "/settings/account"],
  ["settings.pages.appearance", "/settings/appearance"],
  ["profile.help", "/settings/about"],
] as const)("routes %s into Settings", async (key, path) => {
  const app = await renderApp("/sessions/new", {
    procedures: {
      account: { abacus: os.account.abacus.handler(() => account) },
    },
  });
  try {
    fireEvent.click(await screen.findByRole("button", { name: account.name }));
    const labels = {
      "settings.pages.account": en.settings.pages.account,
      "settings.pages.usage": en.settings.pages.usage,
      "phase5.managePlan": en.phase5.managePlan,
      "settings.pages.appearance": en.settings.pages.appearance,
      "profile.help": en.profile.help,
    };
    fireEvent.click(await screen.findByRole("menuitem", { name: labels[key] }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe(path));
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it.each(["free", "enterprise", "trial", "unknown"] as const)(
  "keeps the %s menu honest",
  async (tier) => {
    const app = await renderApp("/sessions/new", {
      procedures: {
        account: {
          abacus: os.account.abacus.handler(() => ({
            ...account,
            subscription_tier: tier,
            org_user_count: tier === "enterprise" ? 20 : 1,
          })),
        },
      },
    });
    try {
      fireEvent.click(
        await screen.findByRole("button", { name: account.name })
      );
      const menu = await screen.findByRole("menu");
      expect(
        within(menu).queryByRole("menuitem", { name: en.phase5.managePlan })
      ).toBeNull();
      expect(
        Boolean(
          within(menu).queryByRole("menuitem", { name: en.creditsCard.cta })
        )
      ).toBe(tier === "free");
      expect(
        screen.queryByRole("link", { name: en.profile.agent }) !== null
      ).toBe(tier === "enterprise");
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);

it.each([
  [0, 0],
  [-2, 5],
  [1_240_000, 5],
])("shows actual referral progress for %s / %s", async (sent, total) => {
  const app = await renderApp("/sessions/new", {
    procedures: {
      account: { abacus: os.account.abacus.handler(() => account) },
      referrals: {
        summary: os.referrals.summary.handler(() => ({
          ...summary,
          invitesSent: sent,
          milestoneInvites: total,
        })),
      },
    },
  });
  try {
    fireEvent.click(await screen.findByRole("button", { name: account.name }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: en.referrals.title })
    );
    const dialog = await screen.findByRole("dialog", {
      name: en.referrals.title,
    });
    if (total > 0) {
      const text = en.referrals.progressTitle
        .replace(
          "{{sent}}",
          new Intl.NumberFormat("en-US").format(Math.max(0, sent))
        )
        .replace("{{total}}", String(total));
      expect(await within(dialog).findByText(text)).toBeTruthy();
    } else {
      await within(dialog).findByRole("textbox", {
        name: en.phase5.inviteLink,
      });
      expect(within(dialog).queryByText(/invites sent/)).toBeNull();
    }
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("supports menu typeahead, arrows and Escape with focus return", async () => {
  const app = await renderApp("/sessions/new", {
    procedures: {
      account: { abacus: os.account.abacus.handler(() => account) },
    },
  });
  try {
    const trigger = await screen.findByRole("button", { name: account.name });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "u" });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(en.settings.pages.usage)
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(en.phase5.managePlan)
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
