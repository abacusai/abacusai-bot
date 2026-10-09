/** R3-T4,T13,T14,T16,T20,T24: routed interaction checks over live collections. */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixtureBots, fixtureSessions } from "#renderer/data/fixture-db/rows";
import {
  openPanelTab,
  panelScopeKey,
  setPanelOpen,
} from "#renderer/lib/side-panel/store";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
// Tag the actual motion spans from both features without changing the chat kit.
vi.mock("motion/react", async (original) => {
  const actual = await original<typeof import("motion/react")>();
  const Span = (props: ComponentProps<typeof actual.motion.span>) =>
    createElement(actual.motion.span, {
      ...props,
      "data-model-layout-id": props.layoutId,
    } as ComponentProps<typeof actual.motion.span>);
  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get: (target, key) => (key === "span" ? Span : Reflect.get(target, key)),
    }),
  };
});
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
describe("bots interactions", () => {
  it("fills the remembered Details and Memory tabs while switching to a sender chat", async () => {
    const sender = {
      ...fixtureSessions()[0]!,
      id: "sender-panel-test",
      botOwned: true,
      owner: {
        kind: "bot" as const,
        botId: "chief-of-staff",
        role: "sender" as const,
        key: "sender",
      },
    };
    app = await renderApp("/bots/chief-of-staff?tab=memory", {
      seed: { ...defaultSeed(), sessions: [...fixtureSessions(), sender] },
    });
    const panel = (kind: string) =>
      document.querySelector(`[data-panel-tab^="${kind}:"]`);
    await waitFor(() => expect(panel("memory")).not.toBeNull());
    await act(async () => {
      await app!.router.navigate({
        to: "/bots/$botId/chats/$sessionId",
        params: { botId: "chief-of-staff", sessionId: sender.id },
      });
    });
    await waitFor(() => {
      expect(panel("memory")).not.toBeNull();
      expect(panel("memory")!.getAttribute("data-active")).toBe("true");
    });
    act(() =>
      openPanelTab(panelScopeKey("bots", "chief-of-staff")!, {
        kind: "details",
      })
    );
    await waitFor(() => {
      expect(panel("details")!.textContent).toContain("Chief of Staff");
      expect(panel("details")!.getAttribute("data-active")).toBe("true");
      expect(panel("memory")!.getAttribute("data-active")).toBe("false");
    });
  });
  it("keeps the same row node while pinning and moving into Needs you", async () => {
    app = await renderApp("/bots/new");
    const row = await screen.findByRole("link", { name: /Chief of Staff,/ });
    await act(async () =>
      app!.appDb.updatePrefs({ pinned: { botIds: ["chief-of-staff"] } })
    );
    expect(screen.getByRole("link", { name: /Chief of Staff,/ })).toBe(row);
    const session = {
      ...fixtureSessions()[0]!,
      owner: {
        kind: "bot" as const,
        botId: "chief-of-staff",
        role: "sender" as const,
        key: "sender",
      },
      turn: {
        phase: "waiting_permission" as const,
        isBusy: true,
        updatedAt: "now",
      },
    };
    act(() => {
      app!.db.sessions.upsert(session);
    });
    await screen.findAllByText("Needs you");
    expect(screen.getByRole("link", { name: /Chief of Staff,/ })).toBe(row);
    act(() => {
      app!.db.sessions.upsert({ ...session, turn: null });
    });
    await waitFor(() => expect(screen.queryByText("Needs you")).toBeNull());
    expect(screen.getByRole("link", { name: /Chief of Staff,/ })).toBe(row);
  });
  it("row options and right click expose the same actions", async () => {
    app = await renderApp("/bots/new");
    const row = await screen.findByRole("link", { name: /Chief of Staff,/ });
    fireEvent.click(
      screen.getByRole("button", { name: "Options for Chief of Staff" })
    );
    await screen.findByRole("menu");
    const items = screen.getAllByRole("menuitem").map((e) => e.textContent);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(row);
    await screen.findByRole("menu");
    expect(screen.getAllByRole("menuitem").map((e) => e.textContent)).toEqual(
      items
    );
  });
  it.each([{ key: "ContextMenu" }, { key: "F10", shiftKey: true }])(
    "keyboard row menu opens with $key",
    async (key) => {
      app = await renderApp("/bots/new");
      const row = await screen.findByRole("link", { name: /Chief of Staff,/ });
      row.focus();
      fireEvent.keyDown(row, key);
      await screen.findByRole("menu");
      expect(screen.getByRole("menuitem", { name: "Pin" })).toBeTruthy();
    }
  );
  it("the four model locations have at most one value", async () => {
    app = await renderApp("/bots/chief-of-staff?tab=details", {
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
    });
    expect(
      document.querySelector('[data-slot="topbar-actions"]')?.textContent ?? ""
    ).not.toContain("Details");
    await screen.findByTestId("bot-chat");
    const count = () =>
      document.querySelectorAll('[data-model-layout-id="model:chief-of-staff"]')
        .length;
    expect(count()).toBe(1);
    const input = screen.getByRole("textbox", {
      name: /Message Chief of Staff/,
    });
    fireEvent.focus(input);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="bot-model-value"]')).toBeNull()
    );
    expect(count()).toBe(1);
    // The chip is the picker's trigger, a combobox named "Model: …".
    expect(screen.getAllByRole("combobox", { name: /RouteLLM/ })).toHaveLength(
      1
    );
    await act(async () => {
      setPanelOpen(panelScopeKey("bots", "chief-of-staff")!, false);
    });
    expect(document.querySelector('[data-slot="bot-model-value"]')).toBeNull();
    expect(count()).toBe(1);
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: /RouteLLM/ })).toBeNull()
    );
    expect(count()).toBe(0);
  });
  it("keeps the model chip mounted while its popover has focus", async () => {
    app = await renderApp("/bots/chief-of-staff?tab=details", {
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
    });
    await screen.findByTestId("bot-chat");
    fireEvent.focus(
      screen.getByRole("textbox", { name: /Message Chief of Staff/ })
    );
    const chip = await screen.findByRole("combobox", { name: /RouteLLM/ });
    fireEvent.click(chip);
    // The picker's search field, labelled "Models".
    await screen.findByRole("combobox", { name: "Models" });
    expect(chip.isConnected).toBe(true);
    expect(document.querySelector('[data-slot="bot-model-value"]')).toBeNull();
  });
  it("a channel bot has no composer or editable model", async () => {
    const bot = { ...fixtureBots()[0]!, channel: "telegram", sessionId: null };
    app = await renderApp("/bots/chief-of-staff?tab=details", {
      seed: { bots: [bot] },
    });
    await screen.findByTestId("bot-chat");
    expect(screen.queryByRole("textbox", { name: /Message/ })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /RouteLLM/ })).toBeNull();
    expect(screen.queryByText("Edit bot")).toBeNull();
  });
  it("an externally deleted bot changes the mounted chat to BotGone", async () => {
    app = await renderApp("/bots/chief-of-staff");
    await screen.findByTestId("bot-chat");
    act(() => {
      app!.db.bots.apply([{ type: "delete", key: "chief-of-staff" }]);
    });
    await screen.findByText("This bot was deleted");
    expect(screen.queryByTestId("bot-chat")).toBeNull();
  });
});
