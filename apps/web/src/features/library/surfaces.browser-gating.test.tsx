import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  render,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import {
  PhoneErrorScreen,
  PhoneWhatsAppApp,
  WhatsAppConnect,
  WhatsAppIntro,
} from "#renderer/features/onboarding/whatsapp";
import { settingsIndexFor } from "#renderer/features/settings/search-index";
import {
  ConnectScreen,
  FailedScreen,
  failureScreen,
  HostStatus,
  SetupScreen,
  StatusPill,
} from "#renderer/features/shell/connect";
import {
  ConnectError,
  hostConnection,
  type ConnectStage,
  type HostConnectionState,
} from "#renderer/features/shell/connect/services";
import {
  BOT_TEMPLATE_CATEGORIES,
  BOT_TEMPLATES,
  orderedTemplateIds,
  templateIdsInCategory,
} from "#renderer/lib/bots/templates";
import { themeOverride } from "#renderer/lib/theme";
import { renderApp } from "#renderer/test-support/app-harness";
// The avatar reads the motion preference from prefs; no DbProvider here.
vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => "full",
}));
vi.mock("#renderer/data/db/prefs", async (original) => ({
  ...(await original<typeof import("#renderer/data/db/prefs")>()),
  usePrefs: () => ({ ...fixturePrefs(), motion: { reduce: "on" } }),
}));
vi.mock("#renderer/lib/voice/use-dictation", () => ({
  useConnectedDictation: () => ({ supported: false }),
}));
it("filters desktop messaging templates from the web catalog and every category", () => {
  const blocked = ["whatsapp-agent", "telegram-agent", "discord-agent"];
  for (const id of blocked) {
    expect(BOT_TEMPLATES.some((template) => template.id === id)).toBe(false);
    for (const category of BOT_TEMPLATE_CATEGORIES) {
      expect(
        orderedTemplateIds(category, ["messaging-telegram"])
      ).not.toContain(id);
      expect(templateIdsInCategory(category)).not.toContain(id);
    }
  }
  expect(
    BOT_TEMPLATES.some((template) => template.id === "chief-of-staff")
  ).toBe(true);
});
it("serves the browser's own messaging page and hides native tool groups while retaining other tools", async () => {
  // The apps server does not offer the bot's own number here.
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith("/api/_getAbacusBotWhatsAppChat")
      ? Promise.resolve(
          Response.json({
            success: true,
            result: {
              available: false,
              status: null,
              phone: null,
              number: null,
            },
          })
        )
      : realFetch(input, init)
  );
  const app = await renderApp("/library/tools");
  try {
    await screen.findByRole("heading", { name: "Tools" });
    for (const id of ["device", "messaging"])
      expect(document.querySelector(`[data-setting-id="${id}"]`)).toBeNull();
    expect(
      document.querySelector('[data-setting-id="terminal"]')
    ).not.toBeNull();
    await act(async () => {
      await app.router.navigate({
        to: "/library/tools/$toolsetId",
        params: { toolsetId: "device" },
      });
    });
    expect(screen.queryByText("device_list")).toBeNull();
    await act(async () => {
      await app.router.navigate({
        to: "/library/tools/$toolsetId",
        params: { toolsetId: "messaging" },
      });
    });
    expect(app.router.state.location.pathname).toBe("/library/tools");
    expect(screen.queryByText("send_whatsapp_message")).toBeNull();
    await act(async () => {
      await app.router.navigate({
        to: "/library/messaging",
        search: { platform: "abacus_telegram" },
      });
    });
    // The desktop's own-account lanes stay desktop-only; the browser links WhatsApp to the server-run agent.
    expect(
      document.querySelector('[data-setting-id="gatewayEnabled"]')
    ).toBeNull();
    expect(await screen.findByText(enUS.web.whatsapp.rowDetail)).toBeDefined();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
    vi.unstubAllGlobals();
  }
});
it("uses host account/environment copy and deliberately hides tour and window density", async () => {
  const entries = settingsIndexFor(false, "linux");
  expect(entries.some((entry) => ["tour", "density"].includes(entry.id))).toBe(
    false
  );
  const { contract } = await import("@abacus-ai/contract/contract");
  const { implement } = await import("@orpc/server");
  const impl = implement(contract);
  const app = await renderApp("/settings/environment", {
    procedures: {
      account: {
        abacus: impl.account.abacus.handler(
          () =>
            ({ email: "test@example.com", subscription_tier: "pro" }) as never
        ),
        state: impl.account.state.handler(
          () =>
            ({
              account: { email: "test@example.com", name: "Test" },
              apps: [],
              onboarded: true,
            }) as never
        ),
      },
    },
  });
  try {
    expect(await screen.findByText("Host")).toBeDefined();
    await act(async () => {
      await app.router.navigate({ to: "/settings/account" });
    });
    expect(await screen.findByText("Forget this host’s account")).toBeDefined();
    await act(async () => {
      await app.router.navigate({ to: "/sessions/new" });
    });
    expect(screen.queryByRole("button", { name: "Host" })).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("terminal shell menu uses the translated label rather than an object", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const { sessionConversationKey } =
    await import("@abacus-ai/contract/conversation-scope");
  const { openTab } =
    await import("#renderer/features/sessions/dock/panel-tabs-store");
  openTab(sessionConversationKey("default", "spreadsheet"), {
    ref: "files",
    title: "Files",
  });
  const app = await renderApp("/sessions/spreadsheet?tab=files&view=split");
  try {
    fireEvent.click(await screen.findByRole("button", { name: "Add tab" }));
    expect(
      await screen.findByRole("menuitem", { name: /Default shell/ })
    ).toBeDefined();
    expect(screen.queryByText(/returned an object/)).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("uses workspace copy on the browser connection screen", () => {
  const view = render(<ConnectScreen stage="starting" restart={() => {}} />);
  try {
    expect(screen.getByRole("status").textContent).toContain(
      "Starting your workspace"
    );
  } finally {
    view.unmount();
  }
});

const STAGES: ConnectStage[] = [
  "starting",
  "installing",
  "updating",
  "connecting",
  "reconnecting",
  "open",
];
const RAW = "upstream said: internal detail 0xdeadbeef";

it("the setup page maps every stage to a step, with a bar always measured", () => {
  const expected: Record<ConnectStage, string[]> = {
    starting: ["current", "pending", "pending"],
    installing: ["done", "current", "pending"],
    updating: ["done", "current", "pending"],
    connecting: ["done", "done", "current"],
    reconnecting: ["done", "done", "current"],
    open: ["done", "done", "current"],
  };
  for (const stage of STAGES) {
    const view = render(<SetupScreen stage={stage} />);
    try {
      const steps = [...view.container.querySelectorAll("li")].map(
        (li) => li.dataset.state
      );
      expect(steps, stage).toEqual(expected[stage]);
      const bar = view.container.querySelector("progress")!;
      expect(bar.max, stage).toBe(100);
      expect(bar.value, stage).toBe(
        stage === "starting"
          ? 33
          : stage === "installing" || stage === "updating"
            ? 66
            : 92
      );
      expect(bar.getAttribute("aria-label")).toBeTruthy();
      // Setup follows the app theme.
      expect(themeOverride.state).toBeNull();
    } finally {
      view.unmount();
    }
    expect(themeOverride.state).toBeNull();
  }
});

it("the pill names every stage", () => {
  const label: Record<ConnectStage, string> = {
    starting: "Waking your bot",
    installing: "Waking your bot",
    updating: "Updating your bot",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    open: "Waking your bot",
  };
  for (const stage of STAGES) {
    const view = render(<StatusPill stage={stage} />);
    expect(view.container.textContent, stage).toBe(label[stage]);
    view.unmount();
  }
});

it("the failed page retries and keeps the error's own text off the page", () => {
  const retry = vi.fn();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const view = render(<FailedScreen error={new Error(RAW)} retry={retry} />);
  try {
    expect(view.container.textContent).not.toContain(RAW);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
  } finally {
    view.unmount();
    warn.mockRestore();
  }
});

it("one failure mapping: a reload without a loop, the loop's retry with one", () => {
  const connection = new ConnectError("connection", RAW);
  expect(failureScreen(connection, false)).toEqual({
    kind: "failed",
    retry: "reload",
  });
  expect(failureScreen(connection, true)).toEqual({
    kind: "failed",
    retry: "retry-now",
  });
  expect(failureScreen(new ConnectError("reload", RAW), true)).toEqual({
    kind: "failed",
    retry: "reload",
  });
  expect(failureScreen(new ConnectError("tier", RAW), true)).toEqual({
    kind: "refused",
  });
  // An account refusal is never the "didn't wake up" page.
  expect(failureScreen(new ConnectError("refused", RAW), true)).toEqual({
    kind: "refused",
  });
  expect(failureScreen(null, true)).toBeNull();
});

it("the host status picks failures first, then open, then the banner, setup or pill; raw text never shows", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const show = (patch: Partial<HostConnectionState>) => {
    act(() =>
      hostConnection.setState(() => ({
        stage: "connecting",
        error: null,
        generation: 0,
        attempting: false,
        firstVisit: false,
        ...patch,
      }))
    );
    return render(<HostStatus />);
  };
  const cases: Array<[Partial<HostConnectionState>, string | null]> = [
    [{ error: new ConnectError("signin", RAW), stage: "open" }, "status"],
    [{ error: new ConnectError("limit", RAW), stage: "open" }, "host-limit"],
    [{ error: new ConnectError("refused", RAW), stage: "open" }, "refused"],
    [
      { error: new ConnectError("connection", RAW), stage: "open" },
      "host-failed",
    ],
    [{ error: new ConnectError("reload", RAW) }, "host-failed"],
    [{ stage: "open", firstVisit: true }, null],
    [{ error: new ConnectError("version", RAW) }, "host-status"],
    [{ firstVisit: true }, "host-setup"],
    [{}, "host-status"],
  ];
  try {
    for (const [patch, slot] of cases) {
      const view = show(patch);
      const text = document.body.textContent ?? "";
      expect(text, JSON.stringify(patch)).not.toContain(RAW);
      if (slot == null) expect(view.container.firstChild).toBeNull();
      else if (slot === "status")
        expect(text).toContain("Sign in to use AbacusAI Bot on the web.");
      else if (slot === "refused") {
        expect(text).toContain(enUS.web.connect.accountRefused);
        expect(text).not.toContain(enUS.web.connect.failedTitle);
        expect(
          screen.getByRole("button", {
            name: enUS.web.connect.switchAccount,
          })
        ).toBeDefined();
      } else
        expect(
          document.querySelector(`[data-slot="${slot}"]`),
          slot
        ).not.toBeNull();
      view.unmount();
    }
  } finally {
    warn.mockRestore();
    act(() =>
      hostConnection.setState((state) => ({
        ...state,
        error: null,
        firstVisit: false,
        stage: "starting",
      }))
    );
  }
});

it("hides WhatsApp referrals in account, invite choices and direct links", async () => {
  const { contract } = await import("@abacus-ai/contract/contract");
  const { implement } = await import("@orpc/server");
  const impl = implement(contract);
  const whatsappContacts = vi.fn(() => []);
  const app = await renderApp("/settings/account", {
    procedures: {
      account: {
        abacus: impl.account.abacus.handler(
          () => ({ email: "test@example.com" }) as never
        ),
      },
      referrals: {
        whatsappContacts:
          impl.referrals.whatsappContacts.handler(whatsappContacts),
      },
    },
  });
  try {
    await screen.findByRole("heading", { name: "Account" });
    expect(
      document.querySelector('[data-setting-id="invite-whatsapp"]')
    ).toBeNull();
    await waitFor(() => {
      expect(
        document.querySelector('[data-setting-id="invite-link"]')
      ).not.toBeNull();
    });
    for (const invite of ["link", "gmail"] as const) {
      expect(
        document.querySelector(`[data-setting-id="invite-${invite}"]`)
      ).not.toBeNull();
      await act(async () => {
        await app.router.navigate({
          to: "/settings/account",
          search: { invite },
        });
      });
      expect(await screen.findByRole("dialog")).toBeDefined();
      expect(
        screen.queryByText(enUS.phase5.inviteChannels.whatsapp)
      ).toBeNull();
    }
    await act(async () => {
      await app.router.navigate({
        to: "/settings/account",
        search: { invite: "whatsapp" },
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(whatsappContacts).not.toHaveBeenCalled();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

const withQueries = (node: React.ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {node}
  </QueryClientProvider>
);

it("opens the WhatsApp intro once: offered and unlinked, closed and marked seen on skip", async () => {
  const callApps = vi.fn(async () => ({
    available: true,
    status: "unlinked",
    phone: null,
    number: "+1 415 555 0123",
  }));
  const markSeen = vi.fn(async () => undefined);
  render(
    withQueries(
      <WhatsAppIntro callApps={callApps} seen={false} markSeen={markSeen} />
    )
  );
  expect(
    await screen.findByRole("heading", { name: enUS.web.whatsappBot.title })
  ).toBeDefined();
  await act(async () => {
    screen.getByRole("button", { name: enUS.web.whatsappBot.skip }).click();
  });
  expect(markSeen).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("never shows the WhatsApp intro to an account that has seen it", async () => {
  const callApps = vi.fn();
  render(
    withQueries(
      <WhatsAppIntro
        callApps={callApps}
        seen
        markSeen={async () => undefined}
      />
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callApps).not.toHaveBeenCalled();
});

it("hands the pre-typed message to WhatsApp by a tap, stays on the page, and offers a new code once it expires", async () => {
  const href = location.href;
  const deepLink = `https://wa.me/14155550123?text=${encodeURIComponent("Hi AbacusAI Bot! (code c_abc)")}`;
  const callApps = vi.fn(async (service: string) =>
    service === "getAbacusBotWhatsAppChat"
      ? { available: true, status: "unlinked", phone: null, number: null }
      : {
          status: "pending",
          deepLink,
          phone: null,
          expiresAt: Math.floor(Date.now() / 1000) + 3,
        }
  );
  render(
    withQueries(<WhatsAppConnect callApps={callApps} onLinked={() => {}} />)
  );
  const input = screen.getByLabelText(enUS.web.whatsappBot.numberLabel);
  await act(async () => {
    fireEvent.change(input, { target: { value: "+1 415 555 0123" } });
  });
  await act(async () => {
    screen.getByRole("button", { name: enUS.web.whatsappBot.connect }).click();
  });
  const open = (
    await screen.findByText(enUS.web.whatsapp.openWhatsApp)
  ).closest("a")!;
  expect(open.getAttribute("href")).toBe(deepLink);
  expect(open.getAttribute("target")).toBe("_blank");
  expect(location.href).toBe(href);
  expect(
    await screen.findByRole(
      "button",
      { name: enUS.web.whatsappBot.newCode },
      { timeout: 6000 }
    )
  ).toBeDefined();
});

it("is only WhatsApp on a phone: connect with no Skip, then all set with the bot's chat and a way to change number", async () => {
  let status = "unlinked";
  const callApps = vi.fn(async (service: string) => {
    if (service === "startAbacusBotWhatsAppChat") status = "linked";
    if (service === "unlinkAbacusBotWhatsAppChat") status = "unlinked";
    return service === "getAbacusBotWhatsAppChat"
      ? { available: true, status, phone: null, number: "+1 415 555 0123" }
      : service === "startAbacusBotWhatsAppChat"
        ? { status: "linked", deepLink: null, phone: "+1 415 555 0123" }
        : {};
  });
  render(withQueries(<PhoneWhatsAppApp callApps={callApps} />));
  expect(
    await screen.findByRole("heading", { name: enUS.web.whatsappBot.title })
  ).toBeDefined();
  // A chat with the bot, never worded like linking the user's own account.
  expect(screen.getByText(enUS.web.whatsappBot.body)).toBeDefined();
  for (const linking of [
    enUS.web.whatsapp.dialogTitle,
    enUS.web.whatsapp.dialogBody,
  ])
    expect(document.body.textContent).not.toContain(linking);
  expect(
    screen.queryByRole("button", { name: enUS.web.whatsappBot.skip })
  ).toBeNull();
  await act(async () => {
    fireEvent.change(screen.getByLabelText(enUS.web.whatsappBot.numberLabel), {
      target: { value: "+1 415 555 0123" },
    });
  });
  await act(async () => {
    screen.getByRole("button", { name: enUS.web.whatsappBot.connect }).click();
  });
  expect(
    await screen.findByRole("heading", {
      name: enUS.web.whatsappBot.doneTitle,
    })
  ).toBeDefined();
  expect(
    screen
      .getByText(enUS.web.whatsapp.openWhatsApp)
      .closest("a")!
      .getAttribute("href")
  ).toBe("https://wa.me/14155550123");
  await act(async () => {
    screen
      .getByRole("button", { name: enUS.web.whatsappBot.useDifferentNumber })
      .click();
  });
  expect(callApps).toHaveBeenCalledWith("unlinkAbacusBotWhatsAppChat", {});
  expect(
    await screen.findByRole("heading", { name: enUS.web.whatsappBot.title })
  ).toBeDefined();
});

it("allows retrying WhatsApp connection after a failed request", async () => {
  let fail = true;
  const onLinked = vi.fn();
  const callApps = vi.fn(async (service: string) => {
    if (service === "getAbacusBotWhatsAppChat")
      return { available: true, status: "unlinked", phone: null, number: null };
    if (fail) throw new Error("Service unavailable");
    return { status: "linked", deepLink: null, phone: "+1 415 555 0123" };
  });
  render(
    withQueries(<WhatsAppConnect callApps={callApps} onLinked={onLinked} />)
  );
  fireEvent.change(screen.getByLabelText(enUS.web.whatsappBot.numberLabel), {
    target: { value: "+1 415 555 0123" },
  });
  const connect = screen.getByRole("button", {
    name: enUS.web.whatsappBot.connect,
  });
  await act(async () => connect.click());
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Service unavailable"
  );
  expect((connect as HTMLButtonElement).disabled).toBe(false);
  expect(onLinked).not.toHaveBeenCalled();
  fail = false;
  await act(async () => connect.click());
  expect(onLinked).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the linked phone and allows retrying after unlinking fails", async () => {
  const callApps = vi.fn(async (service: string) => {
    if (service === "getAbacusBotWhatsAppChat")
      return {
        available: true,
        status: "linked",
        phone: "+1 415 555 0123",
        number: "+1 415 555 0123",
      };
    throw new Error("Service unavailable");
  });
  render(withQueries(<PhoneWhatsAppApp callApps={callApps} />));
  const change = await screen.findByRole("button", {
    name: enUS.web.whatsappBot.useDifferentNumber,
  });
  await act(async () => change.click());
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Service unavailable"
  );
  expect((change as HTMLButtonElement).disabled).toBe(false);
  expect(
    screen.getByRole("heading", { name: enUS.web.whatsappBot.doneTitle })
  ).toBeDefined();
  expect(screen.queryByLabelText(enUS.web.whatsappBot.numberLabel)).toBeNull();
});

it("a phone's passing failure stays on the phone: try again, switch account or sign out", async () => {
  const retry = vi.fn();
  const switchAccount = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => undefined);
  render(
    <PhoneErrorScreen
      reason="connection"
      retry={retry}
      switchAccount={switchAccount}
      signOut={signOut}
    />
  );
  expect(
    screen.getByRole("heading", { name: enUS.web.phoneError.title })
  ).toBeDefined();
  expect(screen.getByText(enUS.web.phoneError.connection)).toBeDefined();
  expect(document.body.textContent).not.toContain(enUS.web.connect.failedTitle);
  fireEvent.click(
    screen.getByRole("button", { name: enUS.web.connect.tryAgain })
  );
  expect(retry).toHaveBeenCalledOnce();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: enUS.web.connect.switchAccount })
    );
  });
  expect(switchAccount).toHaveBeenCalledOnce();
});

it("a phone's refusal names the server's reason, offers no retry, and says when sign-out fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const signOut = vi.fn(async () => {
    throw new Error("offline");
  });
  render(
    <PhoneErrorScreen
      reason="refused"
      detail="Incorrect hostname for the request"
      switchAccount={async () => undefined}
      signOut={signOut}
    />
  );
  try {
    expect(screen.getByText(enUS.web.phoneError.refused)).toBeDefined();
    expect(
      screen.getByText("Incorrect hostname for the request")
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: enUS.web.connect.tryAgain })
    ).toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: enUS.userMenu.signOut })
      );
    });
    expect(signOut).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(enUS.web.connect.signOutFailed)
    ).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: enUS.userMenu.signOut,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  } finally {
    warn.mockRestore();
  }
});
