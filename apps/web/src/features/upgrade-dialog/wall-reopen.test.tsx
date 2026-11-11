import type { WallReopenMark } from "@abacus-ai/contract/contract/rows";
import type { UIMessage } from "@tanstack/ai-client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DbProvider } from "#renderer/data/db";
import { fixturePrefs, fixtureSessions } from "#renderer/data/fixture-db/rows";
import {
  closeUpgradeDialog,
  resumeHandoffStore,
  upgradeDialogStore,
} from "#renderer/lib/upgrade-dialog";
import { createHarness, defaultSeed } from "#renderer/test-support/app-harness";

import { WALL_REOPEN_AWAY_MS, WallReopenHost } from "./wall-reopen";

const CHAT = fixtureSessions()[0]!.id;

const MESSAGES = [
  {
    id: "m1",
    role: "user",
    parts: [{ type: "text", content: "Build an invoice app for my shop" }],
  },
  {
    id: "m2",
    role: "user",
    parts: [{ type: "text", content: "still cut off" }],
  },
] as unknown as UIMessage[];

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  closeUpgradeDialog();
  resumeHandoffStore.setState(() => null);
  await cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
});

const mount = async (wallReopen: WallReopenMark) => {
  const openChat = vi.fn();
  const seed = defaultSeed();
  const harness = await createHarness("/", {
    seed: {
      ...seed,
      prefs: fixturePrefs({
        dismissals: { ...fixturePrefs().dismissals, wallReopen },
      }),
    },
  });
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={harness.router.options.context.queryClient}>
        <RouterContextProvider router={harness.router}>
          <DbProvider value={harness.appDb}>
            <WallReopenHost
              messagesOf={async () => MESSAGES}
              openChat={openChat}
            />
          </DbProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  });
  cleanup = async () => {
    rendered.unmount();
    await harness.cleanup();
  };
  const mark = () =>
    harness.appDb.collections.prefs.get("app")?.dismissals.wallReopen;
  return { openChat, mark };
};

it("a wall from before the app opened: the first input asks the dialog once, with the chat's task and waiting message", async () => {
  const h = await mount({ sessionId: CHAT, wallAt: 1_000, askedAt: null });
  // Nothing at mount: a window the OS opened at login has nobody there.
  expect(upgradeDialogStore.state.request).toBeNull();
  fireEvent.pointerMove(window);
  await waitFor(() =>
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "credits",
      key: "wall-reopen:1000",
      threadId: CHAT,
      reopen: true,
      task: "Build an invoice app for my shop",
      pendingText: "still cut off",
    })
  );
  await waitFor(() => expect(h.mark()?.askedAt).toEqual(expect.any(Number)));

  // Once paid: the chat opens and its view sends the message on the top model.
  await upgradeDialogStore.state.request!.resume!("abacus/claude-opus-5-5");
  expect(resumeHandoffStore.state).toEqual({
    threadId: CHAT,
    model: "abacus/claude-opus-5-5",
  });
  expect(h.openChat).toHaveBeenCalledWith(CHAT);

  // Not now: the same wall is never asked again.
  closeUpgradeDialog(true);
  fireEvent.pointerDown(window);
  fireEvent.keyDown(window);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(upgradeDialogStore.state.request).toBeNull();
});

it("a wall met while the user is here waits for half an hour away, then the next input asks", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await mount({ sessionId: CHAT, wallAt: now + 10, askedAt: null });
  // Just asked live: the next click is no return.
  fireEvent.pointerDown(window);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(upgradeDialogStore.state.request).toBeNull();

  // A short break is not one either.
  fireEvent.blur(window);
  now += 5 * 60_000;
  fireEvent.focus(window);
  fireEvent.pointerDown(window);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(upgradeDialogStore.state.request).toBeNull();

  fireEvent.blur(window);
  now += WALL_REOPEN_AWAY_MS;
  fireEvent.focus(window);
  fireEvent.pointerDown(window);
  await waitFor(() =>
    expect(upgradeDialogStore.state.request).toMatchObject({
      key: `wall-reopen:${1_000_010}`,
      reopen: true,
    })
  );
});
