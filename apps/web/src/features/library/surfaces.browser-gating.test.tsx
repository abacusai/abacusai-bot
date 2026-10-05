import { act, screen, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { settingsIndexFor } from "#renderer/features/settings/search-index";
import { ConnectScreen } from "#renderer/features/shell/connect";
import {
  BOT_TEMPLATE_CATEGORIES,
  BOT_TEMPLATES,
  orderedTemplateIds,
  templateIdsInCategory,
} from "#renderer/lib/bots/templates";
import { renderApp } from "#renderer/test-support/app-harness";
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
    expect(await screen.findByRole("button", { name: "Host" })).toBeDefined();
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
    expect(screen.getByRole("status").textContent).toBe(
      "Starting your workspace"
    );
  } finally {
    view.unmount();
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
