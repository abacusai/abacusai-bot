/**
 * R1-T11: route-level view transitions are the router's document-level
 * `document.startViewTransition`, carrying the types `installTransitionTypes`
 * computes (spec 01 §6.7 as amended). jsdom has no view transitions, so the
 * harness stubs `document.startViewTransition` and `CSS.supports` the way
 * Chromium answers them; every case runs the real app router. Each started
 * transition is recorded with its types: an untyped commit must start none.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { durations, offsets, notch } from "#renderer/lib/motion";
import { renderApp, type AppHarness } from "#renderer/test-support/app-harness";

import { inferNavType, ROUTE_RANK } from "./nav-type";

import tokensCss from "../../styles/tokens.css?raw";

let harness: AppHarness | null = null;
let started: string[][] = [];
/** Per started transition: a rendered `view-transition-name: composer` element was in the old DOM. */
let composerAtStart: boolean[] = [];

/**
 * A rendered element named `composer`. While a pending fallback shows, React
 * keeps the previous page in the DOM under `display: none`; the browser
 * captures no snapshot of it, so it does not count.
 */
const composerNamed = (): boolean =>
  Array.from(document.querySelectorAll<HTMLElement>("[style]")).some(
    (el) =>
      el.style.viewTransitionName === "composer" &&
      !Array.from(
        (function* () {
          for (let n: HTMLElement | null = el; n; n = n.parentElement) yield n;
        })()
      ).some((n) => n.style.display === "none")
  );

type Stubbed = Document & { startViewTransition?: unknown };
const originalStart = (document as Stubbed).startViewTransition;
const originalCss = (window as { CSS?: unknown }).CSS;

beforeEach(() => {
  started = [];
  composerAtStart = [];
  (document as Stubbed).startViewTransition = ((
    arg: (() => unknown) | { update: () => unknown; types?: string[] }
  ) => {
    const update = typeof arg === "function" ? arg : arg.update;
    const types = typeof arg === "function" ? [] : [...(arg.types ?? [])];
    started.push(types);
    composerAtStart.push(composerNamed());
    const done = Promise.resolve().then(update);
    return {
      updateCallbackDone: done,
      ready: done,
      finished: done,
      types: new Set(types),
      skipTransition: () => undefined,
    };
  }) as never;
  (window as { CSS?: unknown }).CSS = {
    supports: (query: string) =>
      query === "selector(:active-view-transition-type(a))",
  };
});

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
  (document as Stubbed).startViewTransition = originalStart;
  (window as { CSS?: unknown }).CSS = originalCss;
});

const types = (): string[] => started.flat();

const go = async (options: Record<string, unknown>) => {
  await act(async () => {
    await harness!.router.navigate(options as never);
  });
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const back = () =>
  act(async () => {
    harness!.router.history.back();
    await settle();
  });
const forward = () =>
  act(async () => {
    harness!.router.history.forward();
    await settle();
  });

const withIntent = (type: string) => ({
  state: (previous: Record<string, unknown>) => ({
    ...previous,
    navIntent: { id: crypto.randomUUID(), type },
  }),
});

describe("inferNavType", () => {
  const at = (fullPath: string, key = fullPath) => ({ fullPath, paneKey: key });

  it.each([
    [at("/bots/new"), at("/bots/$botId", "b1"), "new", "nav-forward"],
    [
      at("/sessions/$sessionId", "s1"),
      at("/sessions/$sessionId", "s2"),
      "new",
      null,
    ],
    [at("/bots/$botId", "b1"), at("/bots/$botId", "b2"), "new", null],
    [at("/bots/new"), at("/settings/general"), "new", "settings-in"],
    [at("/settings/general"), at("/bots/new"), "new", "settings-out"],
    [at("/settings/general"), at("/settings/appearance"), "new", null],
    [at("/library/skills"), at("/library/mcp"), "new", null],
    [at("/bots/new"), at("/sessions/new"), "new", "nav-lateral"],
    [
      at("/bots/$botId", "b1"),
      at("/bots/$botId/edit", "e1"),
      "new",
      "nav-forward",
    ],
    [
      at("/sessions/$sessionId/review", "r"),
      at("/sessions/$sessionId", "s"),
      "new",
      "nav-back",
    ],
    [at("/bots/$botId", "b1"), at("/bots/new"), "back", "nav-back"],
    [at("/bots/new"), at("/sessions/new"), "back", "nav-back"],
    [
      at("/sessions/$sessionId", "s2"),
      at("/sessions/$sessionId", "s1"),
      "back",
      null,
    ],
  ] as const)("%o → %o (%s) is %s", (from, to, direction, expected) => {
    expect(inferNavType(from, to, direction)).toBe(expected);
  });

  it("gives search-only and pop-up changes no type", () => {
    const same = { fullPath: "/routines", paneKey: "routines-list" };
    expect(
      inferNavType(
        same,
        { fullPath: "/routines/new", paneKey: "routines-list" },
        "new",
        "nav-forward"
      )
    ).toBeNull();
    expect(inferNavType(same, same, "back")).toBeNull();
  });

  it("uses a new entry's intent, but inference for a forward traversal", () => {
    const from = { fullPath: "/bots/new", paneKey: "a" };
    const to = { fullPath: "/bots/$botId", paneKey: "b" };
    expect(inferNavType(from, to, "new", "nav-lateral")).toBe("nav-lateral");
    expect(inferNavType(from, to, "forward-seen", "nav-lateral" as never)).toBe(
      "nav-forward"
    );
    expect(inferNavType(from, to, "new", "none")).toBeNull();
  });

  it("ignores a pane-move intent between siblings of one area", () => {
    const sibling = (fullPath: string, key: string) => ({
      fullPath,
      paneKey: key,
    });
    for (const intent of ["nav-lateral", "nav-forward", "nav-back"] as const)
      expect(
        inferNavType(
          sibling("/bots/$botId", "b1"),
          sibling("/bots/$botId", "b2"),
          "new",
          intent
        )
      ).toBeNull();
    expect(
      inferNavType(
        sibling("/settings/general", "g"),
        sibling("/settings/keyboard", "k"),
        "new",
        "nav-lateral"
      )
    ).toBeNull();
  });

  it("keeps a designed type between siblings: onboarding steps", () => {
    const step = (key: string) => ({
      fullPath: "/onboarding/$step",
      paneKey: key,
    });
    expect(
      inferNavType(step("welcome"), step("models"), "new", "onboarding-step")
    ).toBe("onboarding-step");
  });

  it("keeps drills within one area: the bot chat ↔ editor morph", () => {
    const chat = { fullPath: "/bots/$botId", paneKey: "chat" };
    const editor = { fullPath: "/bots/$botId/edit", paneKey: "edit" };
    expect(inferNavType(chat, editor, "new", "nav-forward")).toBe(
      "nav-forward"
    );
    expect(inferNavType(editor, chat, "new", "nav-back")).toBe("nav-back");
    expect(inferNavType(chat, editor, "new")).toBe("nav-forward");
    expect(inferNavType(editor, chat, "back")).toBe("nav-back");
  });

  it("ranks every leaf the route table knows", () => {
    for (const entry of Object.values(ROUTE_RANK))
      expect([0, 1, 2]).toContain(entry.rank);
  });
});

describe("the router's document view transition", () => {
  it("keeps shell navigation usable after a route loader fails and can retry", async () => {
    harness = await renderApp("/sessions/new");
    const route = harness.router.routesById["/_shell/(routines)/routines"];
    const original = route.options.loader;
    route.options.loader = () => {
      throw new Error("Audit loader failure");
    };
    try {
      await go({ to: "/routines" });
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(document.querySelector('[data-slot="shell"]')).not.toBeNull();
      route.options.loader = original;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(document.querySelector('[data-slot="shell"]')).not.toBeNull();
    } finally {
      route.options.loader = original;
    }
  });
  it("starts none while a slow navigation shows its pending screen, then one with the intent on commit", async () => {
    harness = await renderApp("/sessions/new");
    // BotsGlobals already preloads routines for cross-area Needs you.
    // Hold this navigation's loader rather than a snapshot consumed at boot.
    const route = harness.router.routesById["/_shell/(routines)/routines"];
    const original = route.options.loader;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        route.options.loader = original;
        resolve();
      };
    });
    route.options.loader = async (args) => {
      await gate;
      return typeof original === "function"
        ? original(args)
        : original?.handler(args);
    };
    const navigation = harness.router.navigate({
      to: "/routines",
      ...withIntent("nav-forward"),
    } as never);
    // Past defaultPendingMs (400): the pending pane is committed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(screen.getByTestId("pending-pane")).toBeTruthy();
    expect(document.querySelector('[data-slot="shell"]')).not.toBeNull();
    expect(
      document.querySelector('[data-pending-area="routines"]')
    ).not.toBeNull();
    expect(started).toEqual([]);
    release();
    await act(async () => {
      await navigation;
    });
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/routines")
    );
    expect(started).toEqual([["nav-forward"]]);
  });

  it("types the committing location, not router.latestLocation (Claude impl r1 #2)", async () => {
    harness = await renderApp("/sessions/new");
    // BotsGlobals already preloads routines for cross-area Needs you.
    // Hold this navigation's loader rather than a snapshot consumed at boot.
    const route = harness.router.routesById["/_shell/(routines)/routines"];
    const original = route.options.loader;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        route.options.loader = original;
        resolve();
      };
    });
    route.options.loader = async (args) => {
      await gate;
      return typeof original === "function"
        ? original(args)
        : original?.handler(args);
    };
    const navigation = harness.router.navigate({
      to: "/routines",
      ...withIntent("nav-forward"),
    } as never);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // A newer history change the router has parsed but not started loading:
    // the commit about to happen is still /routines.
    const router = harness.router as unknown as {
      latestLocation: unknown;
      buildLocation(options: unknown): unknown;
    };
    const committing = router.latestLocation;
    router.latestLocation = router.buildLocation({ to: "/settings/general" });
    release();
    await act(async () => {
      await navigation;
    });
    router.latestLocation = committing;
    expect(started[0]).toEqual(["nav-forward"]);
  });

  it("starts none for a blocked navigation, and the next one is unaffected", async () => {
    harness = await renderApp("/bots/new");
    const unblock = harness.router.history.block({
      blockerFn: () => true,
      enableBeforeUnload: false,
    });
    await act(async () => {
      void harness!.router.navigate({
        to: "/sessions/new",
        ...withIntent("settings-in"),
      } as never);
      await settle();
    });
    expect(harness.router.state.location.pathname).toBe("/bots/new");
    expect(started).toEqual([]);
    unblock();
    await go({ to: "/sessions/new" });
    expect(started).toEqual([["nav-lateral"]]);
  });

  it("commits only the second of two rapid navigations, with its own intent", async () => {
    harness = await renderApp("/sessions/new");
    const release = harness.db.bots.holdSnapshot();
    await act(async () => {
      void harness!.router.navigate({
        to: "/bots/$botId",
        params: { botId: "chief-of-staff" },
        ...withIntent("settings-in"),
      } as never);
      await harness!.router.navigate({
        to: "/routines",
        ...withIntent("nav-forward"),
      } as never);
    });
    release();
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/routines")
    );
    expect(types()).toEqual(["nav-forward"]);
  });

  it("starts none when invalidate() re-commits the same entry", async () => {
    harness = await renderApp("/bots/new");
    await go({ to: "/sessions/new" });
    started = [];
    await act(async () => {
      await harness!.router.invalidate();
    });
    expect(started).toEqual([]);
  });

  it("plays nav-back on browser back, and infers (not the saved intent) going forward", async () => {
    harness = await renderApp("/bots/new");
    await go({ to: "/sessions/new", ...withIntent("nav-forward") });
    expect(types()).toEqual(["nav-forward"]);
    started = [];
    await back();
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/bots/new")
    );
    expect(started).toEqual([["nav-back"]]);
    started = [];
    await forward();
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/sessions/new")
    );
    expect(started).toEqual([["nav-lateral"]]);
  });

  it("infers nav-forward for a creation (/sessions/new → /sessions/<id>)", async () => {
    harness = await renderApp("/sessions/new");
    await go({
      to: "/sessions/$sessionId",
      params: { sessionId: "review-prs" },
    });
    expect(started).toEqual([["nav-forward"]]);
  });

  it("morphs the composer on /bots/new → /bots/<id>: named before and after the update", async () => {
    harness = await renderApp("/bots/new");
    expect(composerNamed()).toBe(true);
    await go({ to: "/bots/$botId", params: { botId: "chief-of-staff" } });
    expect(started).toEqual([["nav-forward"]]);
    expect(composerAtStart).toEqual([true]);
    await screen.findByTestId("bot-chat");
    await waitFor(() => expect(composerNamed()).toBe(true));
  });

  it("names no composer at a pending-skeleton commit", async () => {
    let release!: () => void;
    const hydrating = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness = await renderApp("/bots/new", { beforeHydrate: () => hydrating });
    const navigation = harness.router.navigate({
      to: "/bots/$botId",
      params: { botId: "chief-of-staff" },
    });
    // Past defaultPendingMs (400): the skeleton is committed, untyped.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(screen.getByTestId("pending-pane")).toBeTruthy();
    expect(started).toEqual([]);
    expect(composerNamed()).toBe(false);
    release();
    await act(async () => {
      await navigation;
    });
    await screen.findByTestId("bot-chat");
    await waitFor(() => expect(composerNamed()).toBe(true));
  });

  it("starts none between sibling threads (/sessions/<a> → /sessions/<b>), either way", async () => {
    harness = await renderApp("/sessions/review-prs");
    await go({
      to: "/sessions/$sessionId",
      params: { sessionId: "terminal-tab" },
      ...withIntent("nav-lateral"),
    });
    await back();
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe(
        "/sessions/review-prs"
      )
    );
    expect(started).toEqual([]);
  });

  // The diff is a pop-up over the session's pane (one pane key): no intent
  // types it, a drill included.
  it.each(["nav-forward", "none"])(
    "starts none opening a session's diff over its pane, whatever the intent (%s)",
    async (intent) => {
      harness = await renderApp("/sessions/review-prs");
      await go({
        to: "/sessions/$sessionId/diff",
        params: { sessionId: "review-prs" },
        search: { path: "a.ts", scope: "unstaged", source: "git" },
        ...withIntent(intent),
      });
      await waitFor(() =>
        expect(harness!.router.state.location.pathname).toBe(
          "/sessions/review-prs/diff"
        )
      );
      expect(started).toEqual([]);
    }
  );

  it("starts none closing a masked sheet with back, or between search-only entries", async () => {
    harness = await renderApp("/routines");
    await go({ to: "/routines/new" });
    await back();
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/routines")
    );
    await go({ to: "/artifacts", search: { type: "deck" } });
    started = [];
    await go({ to: "/artifacts", search: { type: "image" } });
    await back();
    await forward();
    expect(started).toEqual([]);
  });

  it("types settings-in entering Settings and settings-out leaving it", async () => {
    harness = await renderApp("/bots/new");
    await go({ to: "/settings/general" });
    await go({ to: "/settings/appearance" });
    await go({ to: "/sessions/new" });
    expect(started).toEqual([["settings-in"], ["settings-out"]]);
  });
});

describe("motion constants", () => {
  it("equal the durations and offsets tokens.css uses", () => {
    const ms = [
      ...tokensCss.matchAll(
        /animation: (\d+)ms vt-(?:fade|slide)[a-z-]* both;/g
      ),
    ].map((m) => Number(m[1]));
    expect(new Set(ms)).toEqual(new Set([durations.route, notch.contentFade]));
    expect(tokensCss).toContain(
      `${durations.reduced}ms vt-fade-out both !important`
    );
    expect(tokensCss).toContain(
      `${durations.reduced}ms vt-fade-in both !important`
    );
    expect(tokensCss).toContain(`translate: ${offsets.drill}px 0`);
    expect(tokensCss).toContain(`translate: -${offsets.drill}px 0`);
  });
  it("time every group and snapshot by the route duration, one choreography", () => {
    // The UA's 250 ms defaults would otherwise outlast the 120 ms fades.
    expect(tokensCss).toMatch(
      new RegExp(
        `::view-transition-group\\(\\*\\) \\{\\s*animation-duration: ${durations.route}ms;\\s*animation-timing-function: cubic-bezier\\(0\\.2, 0\\.8, 0\\.2, 1\\);`
      )
    );
    expect(tokensCss).toMatch(
      new RegExp(
        `::view-transition-old\\(\\*\\),\\s*::view-transition-new\\(\\*\\) \\{\\s*animation-duration: ${durations.route}ms;`
      )
    );
  });
  it("time the composer morph's group and cross-fade", () => {
    expect(tokensCss).toMatch(
      new RegExp(
        `::view-transition-group\\(composer\\) \\{\\s*animation-duration: ${durations.layout}ms;\\s*animation-timing-function: cubic-bezier\\(0\\.2, 0\\.8, 0\\.2, 1\\);`
      )
    );
    expect(tokensCss).toContain(
      `::view-transition-old(composer) {\n  animation: ${durations.route}ms vt-fade-out both;`
    );
    expect(tokensCss).toContain(
      `::view-transition-new(composer) {\n  animation: ${durations.route}ms vt-fade-in both;`
    );
    expect(tokensCss).toMatch(
      /::view-transition-image-pair\(composer\) \{\s*overflow: clip;\s*border-radius: 22px;/
    );
  });
});

describe("reduced motion CSS (Codex impl r1 #9, Claude impl r1 #13)", () => {
  const block = (start: string): string => {
    const from = tokensCss.indexOf(start);
    expect(from).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = tokensCss.indexOf("{", from); i < tokensCss.length; i += 1) {
      if (tokensCss[i] === "{") depth += 1;
      if (tokensCss[i] === "}") depth -= 1;
      if (depth === 0) return tokensCss.slice(from, i + 1);
    }
    return "";
  };

  it("the OS rule never applies when prefs say off", () => {
    const media = block("@media (prefers-reduced-motion: reduce)");
    const selectors = [...media.matchAll(/^\s*(html[^{]*)\{/gm)].map((m) =>
      m[1]!.trim()
    );
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors)
      expect(selector).toContain(':not([data-reduce-motion="off"])');
  });

  it("fades the old snapshot out, never in", () => {
    const olds = [
      ...tokensCss.matchAll(
        /::view-transition-old\(\*\)\s*\{\s*animation:\s*([^;]+);/g
      ),
    ].map((m) => m[1]!);
    expect(olds.length).toBe(2);
    for (const animation of olds) expect(animation).toContain("vt-fade-out");
  });
});
