/** R3-T4,T13,T14,T16,T20,T24: routed interaction checks over live collections. */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureBots, fixtureSessions } from "#next/data/fixture-db/rows";
import { renderApp } from "#next/test-support/app-harness";
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
describe("bots interactions", () => {
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
    app = await renderApp("/bots/chief-of-staff?tab=details");
    await screen.findByTestId("bot-chat");
    const count = () =>
      document.querySelectorAll(
        '[data-slot="bot-model-value"], [data-slot="composer-model"] span[data-bot-model-value]'
      ).length;
    expect(count()).toBe(1);
    const input = screen.getByRole("textbox", {
      name: /Message Chief of Staff/,
    });
    fireEvent.focus(input);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="bot-model-value"]')).toBeNull()
    );
    expect(screen.getAllByRole("button", { name: /App default/ })).toHaveLength(
      1
    );
    await act(async () =>
      app!.router.navigate({
        to: "/bots/$botId",
        params: { botId: "chief-of-staff" },
        search: {},
      })
    );
    expect(document.querySelector('[data-slot="bot-model-value"]')).toBeNull();
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /App default/ })).toBeNull()
    );
  });
  it("keeps the model chip mounted while its popover has focus", async () => {
    app = await renderApp("/bots/chief-of-staff?tab=details");
    await screen.findByTestId("bot-chat");
    fireEvent.focus(
      screen.getByRole("textbox", { name: /Message Chief of Staff/ })
    );
    const chip = await screen.findByRole("button", { name: "App default" });
    fireEvent.click(chip);
    await screen.findByRole("textbox", { name: "Search models" });
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
    expect(screen.queryByRole("button", { name: /App default/ })).toBeNull();
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
