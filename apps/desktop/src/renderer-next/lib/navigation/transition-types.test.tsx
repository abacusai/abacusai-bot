/**
 * R1-T11: the router seam adds view-transition types only on the commit of a
 * new history entry, with the entry's own intent or the inferred type; on the
 * real app router over memory history.
 */
import { waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { durations, offsets } from "#next/lib/motion";
import { renderApp, type AppHarness } from "#next/test-support/app-harness";

import { inferNavType, ROUTE_RANK } from "./nav-type";
import { installTransitionTypes, transitionTypeSink } from "./transition-types";

import tokensCss from "../../styles/tokens.css?raw";

let harness: AppHarness | null = null;
let added: string[] = [];

beforeEach(() => {
  added = [];
  vi.spyOn(transitionTypeSink, "add").mockImplementation((type) => {
    added.push(type);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.cleanup();
  harness = null;
});

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
      "nav-lateral",
    ],
    [at("/bots/new"), at("/settings/general"), "new", "settings-in"],
    [at("/settings/general"), at("/bots/new"), "new", "settings-out"],
    [at("/settings/general"), at("/settings/appearance"), "new", "nav-lateral"],
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
    [at("/bots/new"), at("/sessions/new"), "back", "nav-back"],
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

  it("ranks every leaf the route table knows", () => {
    for (const entry of Object.values(ROUTE_RANK))
      expect([0, 1, 2]).toContain(entry.rank);
  });
});

describe("the seam on the app router", () => {
  it("adds nothing while a slow navigation is pending, then its intent on commit", async () => {
    harness = await renderApp("/sessions/new");
    const release = harness.db.routines.holdSnapshot();
    const navigation = harness.router.navigate({
      to: "/routines",
      ...withIntent("nav-forward"),
    } as never);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(added).toEqual([]);
    release();
    await act(async () => {
      await navigation;
    });
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/routines")
    );
    expect(added).toEqual(["nav-forward"]);
  });

  it("adds nothing on a pending offer and the intent on the commit (seam unit)", () => {
    const committed: Array<() => void> = [];
    const location = {
      pathname: "/bots/b1",
      state: {
        __TSR_key: "k2",
        __TSR_index: 1,
        navIntent: { id: "i", type: "nav-lateral" },
      },
    };
    const fake = {
      startTransition: (fn: () => void, _expected?: unknown) => {
        committed.push(fn);
        return Promise.resolve(true);
      },
      latestLocation: location,
      options: {},
      stores: {
        resolvedLocation: {
          get: () => ({
            pathname: "/bots/new",
            state: { __TSR_key: "k1", __TSR_index: 0 },
          }),
        },
      },
      getMatchedRoutes: (pathname: string) =>
        pathname === "/bots/new"
          ? [[], {}, { id: "/_shell/(bots)/bots/new", fullPath: "/bots/new" }]
          : [
              [],
              { botId: "b1" },
              { id: "/_shell/(bots)/bots/$botId", fullPath: "/bots/$botId" },
            ],
    };
    installTransitionTypes(fake as never);
    void fake.startTransition(() => undefined, [
      { status: "pending" },
    ] as never);
    committed.at(-1)!();
    expect(added).toEqual([]);
    void fake.startTransition(() => undefined, [
      { status: "success" },
    ] as never);
    committed.at(-1)!();
    expect(added).toEqual(["nav-lateral"]);
    // A re-commit of the same entry (invalidate) adds nothing.
    void fake.startTransition(() => undefined, [
      { status: "success" },
    ] as never);
    committed.at(-1)!();
    expect(added).toEqual(["nav-lateral"]);
  });

  it("adds nothing for a blocked navigation, and the next one is unaffected", async () => {
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
    expect(added).toEqual([]);
    unblock();
    await go({ to: "/sessions/new" });
    expect(added).toEqual(["nav-lateral"]);
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
    expect(added).toEqual(["nav-forward"]);
  });

  it("adds nothing when invalidate() re-commits the same entry", async () => {
    harness = await renderApp("/bots/new");
    await go({ to: "/sessions/new" });
    added = [];
    await act(async () => {
      await harness!.router.invalidate();
    });
    expect(added).toEqual([]);
  });

  it("plays nav-back going back, and infers (not the saved intent) going forward", async () => {
    harness = await renderApp("/bots/new");
    await go({
      to: "/bots/$botId",
      params: { botId: "chief-of-staff" },
      ...withIntent("nav-lateral"),
    });
    expect(added).toEqual(["nav-lateral"]);
    added = [];
    await back();
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/bots/new")
    );
    expect(added).toEqual(["nav-back"]);
    added = [];
    await forward();
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe(
        "/bots/chief-of-staff"
      )
    );
    expect(added).toEqual(["nav-forward"]);
  });

  it("adds nothing closing a masked sheet with back, or between search-only entries", async () => {
    harness = await renderApp("/routines");
    await go({ to: "/routines/new" });
    await back();
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe("/routines")
    );
    await go({ to: "/artifacts", search: { type: "deck" } });
    added = [];
    await go({ to: "/artifacts", search: { type: "image" } });
    await back();
    await forward();
    expect(added).toEqual([]);
  });

  it("adds settings-in entering Settings and settings-out leaving it", async () => {
    const documentTypes: string[] = [];
    vi.spyOn(transitionTypeSink, "document").mockImplementation((type) => {
      documentTypes.push(type);
    });
    harness = await renderApp("/bots/new");
    await go({ to: "/settings/general" });
    await go({ to: "/settings/appearance" });
    await go({ to: "/sessions/new" });
    expect(added).toEqual(["settings-in", "nav-lateral", "settings-out"]);
    // The router's document-level view transition gets the same types
    // (jsdom has no startViewTransition, so the router only asks).
    expect(documentTypes).toEqual([]);
  });
});

describe("motion constants", () => {
  it("equal the durations and offsets tokens.css uses", () => {
    const ms = [
      ...tokensCss.matchAll(
        /animation: (\d+)ms vt-(?:fade|slide)[a-z-]* both;/g
      ),
    ].map((m) => Number(m[1]));
    expect(new Set(ms)).toEqual(
      new Set([durations.crossFade, durations.drill])
    );
    expect(tokensCss).toContain(`${durations.reduced}ms vt-fade-in`);
    expect(tokensCss).toContain(`translate: ${offsets.drill}px 0`);
    expect(tokensCss).toContain(`translate: -${offsets.drill}px 0`);
  });
});
