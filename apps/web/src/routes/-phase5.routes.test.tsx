import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import {
  createHarness,
  defaultSeed,
  renderApp,
} from "#renderer/test-support/app-harness";
const routine = defaultSeed().routines![0]!;
it.each([
  [`/routines/${routine.id}`, `/routines/${routine.id}/edit`, {}],
  ["/library/messaging", "/library/messaging", { platform: "telegram" }],
  ["/library/mcp", "/library/mcp", { server: "new" }],
  ["/library/skills", "/library/skills", { marketplace: true }],
  ["/settings/account", "/settings/account", { invite: "gmail" }],
] as const)(
  "R5-T1 %s mask keeps background identity, reloads and closes with Back",
  async (base, path, search) => {
    const history = createMemoryHistory({ initialEntries: [base] });
    let app = await renderApp(base, { history });
    try {
      const pane = app.view.container.querySelector('[data-slot="pane"]')!;
      pane.scrollTop = 80;
      (pane as HTMLElement).dataset.localCounter = "7";
      await act(() =>
        app.router.navigate({ to: path as never, search: search as never })
      );
      expect(app.router.state.location.maskedLocation?.pathname).toBe(
        base === "/library/messaging" ? undefined : base
      );
      expect(app.view.container.querySelector('[data-slot="pane"]')).toBe(pane);
      expect((pane as HTMLElement).dataset.localCounter).toBe("7");
      app.view.unmount();
      await app.cleanup();
      app = await renderApp(base, { history });
      expect(app.router.state.location.pathname).toBe(path);
      expect(app.router.state.location.search).toMatchObject(search);
      expect(app.router.state.location.maskedLocation?.pathname).toBe(
        base === "/library/messaging" ? undefined : base
      );
      await act(() => {
        history.back();
      });
      await waitFor(() =>
        expect(app.router.state.location.search).not.toMatchObject(
          Object.keys(search).length ? search : { missing: true }
        )
      );
      expect(app.router.state.location.pathname).toBe(base);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
it("R5-T3 cold routine navigation waits for both owned snapshots", async () => {
  let releaseRoutine!: () => void;
  let releaseRuns!: () => void;
  const pending = renderApp(`/routines/${routine.id}`, {
    beforeRender(db) {
      releaseRoutine = db.routines.holdSnapshot();
      releaseRuns = db.routineRuns.holdSnapshot();
    },
  });
  await waitFor(() => expect(releaseRoutine).toBeDefined());
  expect(screen.queryByText("This routine is gone.")).toBeNull();
  releaseRoutine();
  releaseRuns();
  const app = await pending;
  try {
    expect(
      await screen.findByRole("heading", { name: routine.name })
    ).not.toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
it("R5-T3 sidebar preloads do not hydrate a chat or start a routine", async () => {
  const hydrate = vi.fn();
  const app = await createHarness("/routines", { beforeHydrate: hydrate });
  try {
    for (const href of [
      "/routines",
      `/routines/${routine.id}`,
      "/routines/new",
      "/artifacts",
      "/library/connectors",
      "/library/messaging",
      "/library/mcp",
      "/library/skills",
      "/library/tools",
      ...[
        "general",
        "appearance",
        "notifications",
        "memory",
        "usage",
        "account",
        "models",
        "environment",
        "browser",
        "devices",
        "language",
        "keyboard",
        "about",
      ].map((page) => `/settings/${page}`),
    ])
      await app.router.preloadRoute({ to: href as never });
    expect(hydrate).not.toHaveBeenCalled();
    expect(app.db.routines.rows.size).toBe(defaultSeed().routines!.length);
    expect(app.db.routineRuns.rows.size).toBe(0);
  } finally {
    await app.cleanup();
  }
});
it("a hover preload fetches a session's first page, and the click builds the session from it", async () => {
  let release!: () => void;
  const hydrating = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hydrate = vi.fn(() => hydrating);
  const app = await createHarness("/sessions/new", { beforeHydrate: hydrate });
  try {
    const sessions = vi.spyOn(app.router.options.context.chat, "session");
    await app.router.preloadRoute({
      to: "/sessions/$sessionId",
      params: { sessionId: "review-prs" },
    });
    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    expect(sessions).not.toHaveBeenCalled();
    release();
    await act(() =>
      app.router.navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: "review-prs" },
      })
    );
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(app.router.options.context.chat.session("review-prs").ready).toBe(
      true
    );
  } finally {
    await app.cleanup();
  }
});
it("hovering an opened bot whose chat is ready preloads the chat itself, not the skeleton", async () => {
  const hydrate = vi.fn(async () => {});
  const seed = defaultSeed();
  const bot = { ...seed.bots![0]!, sessionId: "bot-test" };
  const forever = {
    ...seed.sessions![0]!,
    id: "bot-test",
    botOwned: true,
    turn: null,
  };
  const app = await renderApp(`/bots/${bot.id}`, {
    beforeHydrate: hydrate,
    seed: {
      ...seed,
      bots: [bot, ...seed.bots!.slice(1)],
      sessions: [...seed.sessions!, forever],
    },
  });
  try {
    await waitFor(() =>
      expect(app.router.state.matches.at(-1)?.loaderData).toMatchObject({
        ready: true,
      })
    );
    await act(() => app.router.navigate({ to: "/routines" }));
    hydrate.mockClear();
    const matches = await app.router.preloadRoute({
      to: "/bots/$botId",
      params: { botId: bot.id },
    });
    expect(matches?.at(-1)?.loaderData).toEqual({
      ready: true,
      botId: bot.id,
      sessionId: "bot-test",
      workspaceId: "default",
    });
    expect(hydrate).not.toHaveBeenCalled();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
