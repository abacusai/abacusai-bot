/**
 * R1-T1: the route tree, redirects, masks and pop-up identity, on a real
 * router over memory history with the app's own components.
 */
import { createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { PANE_BOUNDARIES } from "#renderer/lib/navigation/pane-key";
import { routeMasks } from "#renderer/router";

import {
  createHarness,
  renderApp,
  type AppHarness,
} from "./test-support/app-harness";

let harness: (AppHarness & { view?: { unmount(): void } }) | null = null;
afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

type AnyRouteNode = {
  id: string;
  fullPath: string;
  options: { staticData?: { area?: string; sidebar?: string } };
  children?: Record<string, AnyRouteNode> | AnyRouteNode[];
  parentRoute?: AnyRouteNode;
};

let all: AnyRouteNode[] = [];
beforeAll(async () => {
  // A router initialises the tree (ids and full paths).
  const probe = await createHarness("/bots/new");
  all = Object.values(probe.router.routesById) as unknown as AnyRouteNode[];
  await probe.cleanup();
});

const ancestors = (node: AnyRouteNode): AnyRouteNode[] => {
  const chain: AnyRouteNode[] = [];
  for (let at: AnyRouteNode | undefined = node; at != null; at = at.parentRoute)
    chain.unshift(at);
  return chain;
};

describe("the route tree", () => {
  it("matches the snapshot of ids and full paths", () => {
    expect(
      all
        .map((node) => ({ id: node.id, fullPath: node.fullPath }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toMatchSnapshot();
  });

  it("gives every _shell leaf an area and a sidebar through its ancestors", () => {
    const leaves = all.filter(
      (node) =>
        node.id.startsWith("/_shell/") &&
        (node.children == null || Object.keys(node.children).length === 0) &&
        node.id !== "/_shell/"
    );
    expect(leaves.length).toBeGreaterThan(20);
    for (const leaf of leaves) {
      const chain = ancestors(leaf);
      const area = chain
        .map((node) => node.options.staticData?.area)
        .filter(Boolean)
        .at(-1);
      const sidebar = chain
        .map((node) => node.options.staticData?.sidebar)
        .filter(Boolean)
        .at(-1);
      expect(area, leaf.id).toBeDefined();
      expect(sidebar, leaf.id).toBeDefined();
    }
  });

  it("uses full paths, not ids, for every mask", () => {
    const fullPaths = new Set(all.map((node) => node.fullPath));
    for (const mask of routeMasks) expect(fullPaths.has(mask.from)).toBe(true);
  });

  it("keys PANE_BOUNDARIES by generated route ids", () => {
    const ids = new Set(all.map((node) => node.id));
    for (const id of Object.keys(PANE_BOUNDARIES))
      expect(ids.has(id), id).toBe(true);
  });
});

describe("redirects", () => {
  it.each([
    ["/", "/bots/new"],
    ["/bots", "/bots/new"],
    ["/sessions", "/sessions/new"],
    ["/library", "/library/connectors"],
    ["/settings", "/settings/general"],
    ["/onboarding", "/onboarding/welcome"],
  ])("%s lands on %s", async (from, to) => {
    harness = await renderApp(from, {
      onboarded: !from.startsWith("/onboarding"),
    });
    await waitFor(() =>
      expect(harness!.router.state.location.pathname).toBe(to)
    );
  });

  it("renders the start page and the bots sidebar on /bots/new", async () => {
    harness = await renderApp("/bots/new");
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(
      await screen.findByRole("link", { name: /Chief of Staff/ })
    ).toBeTruthy();
  });

  it("treats /__ui as not found with the gallery off", async () => {
    const env = import.meta.env as { DEV: boolean };
    const dev = env.DEV;
    env.DEV = false;
    try {
      harness = await renderApp("/__ui");
      expect(await screen.findByText("Not found")).toBeTruthy();
    } finally {
      env.DEV = dev;
    }
  });
});

describe("masked pop-ups", () => {
  it.each([
    {
      name: "routine create",
      to: "/routines/new",
      masked: "/routines",
      background: "routines-list-body",
    },
    {
      name: "bot check-in",
      to: "/bots/chief-of-staff/check-in",
      masked: "/bots/chief-of-staff",
      background: "bot-chat",
    },
    {
      name: "connector sheet",
      to: "/library/connectors?connector=gmail",
      masked: "/library/connectors",
      background: "connectors-page",
    },
  ])(
    "$name masks the URL, keeps its background and closes with back",
    async ({ to, masked, background }) => {
      const history = createMemoryHistory({ initialEntries: ["/bots/new"] });
      harness = await renderApp("/bots/new", { history });
      const start = harness.router.state.location.pathname;
      const base = to
        .replace(/\/(new|check-in)$/, (_, last) => (last === "new" ? "" : ""))
        .split("?")[0]!;
      // Go to the background first, as a user would.
      await act(async () => {
        await harness!.router.navigate({
          href: base === "/routines" ? "/routines" : base,
        });
      });
      const backgroundNode = await screen.findAllByTestId(background);
      const before = backgroundNode[0]!;
      await act(async () => {
        await harness!.router.navigate({ href: to });
      });
      expect(harness.router.state.location.maskedLocation?.pathname).toBe(
        masked
      );
      await screen.findByTestId(
        /routine-dialog|connector-sheet|check-in-dialog/
      );
      // The background instance survived the pop-up opening.
      expect(screen.getAllByTestId(background)[0]).toBe(before);

      await act(async () => {
        harness!.router.history.back();
      });
      await waitFor(() =>
        expect(screen.queryByTestId("routine-dialog")).toBeNull()
      );
      expect(screen.getAllByTestId(background)[0]).toBe(before);
      expect(start).toBe("/bots/new");
    }
  );

  it("survives a reload: a router re-created on the same history keeps the mask", async () => {
    const history = createMemoryHistory({ initialEntries: ["/routines"] });
    harness = await renderApp("/routines", { history });
    await act(async () => {
      await harness!.router.navigate({ to: "/routines/new" });
    });
    const first = harness;
    harness.view?.unmount();
    await first.cleanup();
    harness = await renderApp("/routines", { history });
    expect(harness.router.state.location.pathname).toBe("/routines/new");
    expect(await screen.findByTestId("routine-dialog")).toBeTruthy();
    expect(screen.getByTestId("routines-list-body")).toBeTruthy();
  });

  it("keeps a local counter and scroll across open and close", async () => {
    harness = await renderApp("/routines");
    const body = await screen.findByTestId("routines-list-body");
    const pane = body
      .closest("[data-slot=pane]")!
      .querySelector("div.overflow-auto") as HTMLElement;
    pane.scrollTop = 40;
    body.dataset.counter = "3";
    await act(async () => {
      await harness!.router.navigate({ to: "/routines/new" });
    });
    await act(async () => {
      harness!.router.history.back();
    });
    const after = screen.getByTestId("routines-list-body");
    expect(after).toBe(body);
    expect(after.dataset.counter).toBe("3");
    expect(pane.scrollTop).toBe(40);
    fireEvent.scroll(pane);
  });
});
