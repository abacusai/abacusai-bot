/**
 * The composer morph (shared-element.ts): the four composers (the bot start
 * name pill, the bot chat, the session start, the session workspace) each
 * carry `view-transition-name: composer`, exactly once per page, so the
 * router's route transition pairs them. Pages without a composer that
 * should morph (the gallery, read-only replays) carry none.
 */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { sharedElementMounts } from "#renderer/lib/navigation/shared-element";
import { renderApp } from "#renderer/test-support/app-harness";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
// The session workspace's dock needs a desktop width (session-dock.test.tsx).
const width = window.innerWidth;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
  });
});
afterEach(async () => {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

const named = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[style]")).filter(
    (el) => el.style.viewTransitionName === "composer"
  );

// ChatView is lazy: the composer surface arrives a tick after the route.
const expectOne = async () => {
  await waitFor(() => expect(named()).toHaveLength(1));
  expect(sharedElementMounts("composer")).toBe(1);
  expect(named()[0]!.style.viewTransitionClass).toBe("composer");
  expect(named()[0]!.closest('[data-slot="pane"]')).not.toBeNull();
};

it.each([
  ["/bots/new", "input-group"],
  ["/bots/chief-of-staff", "composer-surface"],
  ["/sessions/new", "composer-surface"],
  // The dock-less session page trips react-resizable-panels in jsdom
  // (session-dock.test.tsx renders a split view for the same reason).
  ["/sessions/spreadsheet?tab=files&view=split", "composer-surface"],
])("%s renders one composer shared element (%s)", async (path, slot) => {
  app = await renderApp(path);
  if (path.startsWith("/bots/c")) await screen.findByTestId("bot-chat");
  await expectOne();
  expect(named()[0]!.dataset.slot).toBe(slot);
});

it("keeps one composer element across /bots/new → /bots/<id>", async () => {
  app = await renderApp("/bots/new");
  await expectOne();
  await act(() =>
    app!.router.navigate({
      to: "/bots/$botId",
      params: { botId: "chief-of-staff" },
    })
  );
  await screen.findByTestId("bot-chat");
  await expectOne();
  expect(named()[0]!.dataset.slot).toBe("composer-surface");
});

it("keeps one composer element across /sessions/new → /sessions/<id>", async () => {
  app = await renderApp("/sessions/new");
  await expectOne();
  await act(() =>
    app!.router.navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: "spreadsheet" },
      search: { tab: "files", view: "split" },
    })
  );
  await expectOne();
});

it.each(["bots-chat", "bots-sidebar"])(
  "the gallery (%s) carries no composer name",
  async (fixture) => {
    app = await renderApp(`/__ui?fixture=${fixture}`);
    expect(named()).toHaveLength(0);
    expect(sharedElementMounts("composer")).toBe(0);
  }
);
