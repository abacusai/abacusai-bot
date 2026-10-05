import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import {
  createHarness,
  defaultSeed,
  renderApp,
} from "#next/test-support/app-harness";
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
      expect(app.router.state.location.maskedLocation?.pathname).toBe(base);
      expect(app.view.container.querySelector('[data-slot="pane"]')).toBe(pane);
      expect((pane as HTMLElement).dataset.localCounter).toBe("7");
      app.view.unmount();
      await app.cleanup();
      app = await renderApp(base, { history });
      expect(app.router.state.location.pathname).toBe(path);
      expect(app.router.state.location.search).toMatchObject(search);
      expect(app.router.state.location.maskedLocation?.pathname).toBe(base);
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
