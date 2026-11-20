import { CONNECTORS } from "@abacus-ai/connectors/registry";
/**
 * R1-T1: the route tree, redirects, masks and pop-up identity, on a real
 * router over memory history with the app's own components.
 */
import {
  BOT_HELP_CONTROLS,
  BOT_HELP_ROUTES,
  BOT_HELP_TOPICS,
  botHelpPlace,
  type BotHelpPlace,
} from "@abacus-ai/contract/bot-help";
import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";
import { TOOLSETS_FOR_DISPLAY } from "@abacus-ai/contract/toolsets";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import enUS from "#locales/en-US.json";
import { APP_HOTKEYS } from "#renderer/features/shell/hotkeys";
import {
  AREA_HOME,
  LIBRARY_PAGES,
  RAIL_AREAS,
  SETTINGS_PAGES,
} from "#renderer/lib/navigation/areas";
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
  localStorage.clear();
});

type AnyRouteNode = {
  id: string;
  fullPath: string;
  options: {
    staticData?: { area?: string; sidebar?: string };
    validateSearch?: {
      "~standard": {
        validate: (
          value: unknown
        ) => { value: Record<string, unknown> } | Promise<unknown>;
      };
    };
  };
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

/**
 * `bot_help`'s places name routes, search params and labels the model and
 * the card both use. A page renamed or moved fails here, not in a user's
 * chat: every place the contract can build, for every topic and every name
 * a registry holds, opens a real route with a search it keeps, and every
 * label it says in English is the app's own en-US text.
 */
describe("bot_help's places", () => {
  const normal = (fullPath: string): string =>
    fullPath.length > 1 ? fullPath.replace(/\/$/, "") : fullPath;
  const routeFor = (to: string): AnyRouteNode | undefined =>
    all.find((node) => normal(node.fullPath) === to);
  const lookup = (key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (at, part) =>
          at != null && typeof at === "object"
            ? (at as Record<string, unknown>)[part]
            : undefined,
        enUS
      );
  const names = [
    "",
    "no such thing",
    ...PROVIDER_KEY_FIELDS.flatMap((field) => [field.provider, field.label]),
    ...CONNECTORS.flatMap((connector) => [connector.id, connector.name]),
    ...TOOLSETS_FOR_DISPLAY.map((set) => set.id),
    ...BOT_HELP_CONTROLS.flatMap((control) => [
      control.id,
      control.label.text,
      ...(control.words ?? []),
    ]),
    "Price Watch",
  ];
  const places: BotHelpPlace[] = BOT_HELP_TOPICS.flatMap((topic) =>
    names.flatMap(
      (name) =>
        botHelpPlace(topic, name, [{ id: "bot-1", name: "Price Watch" }]) ?? []
    )
  );

  it("opens only routes the router has", () => {
    for (const to of BOT_HELP_ROUTES) expect(routeFor(to), to).toBeDefined();
  });

  it("keeps every search param it sets, as the route validates it", () => {
    for (const place of places) {
      if (place.search == null) continue;
      const route = routeFor(place.to)!;
      const kept: Record<string, unknown> = {};
      for (const node of ancestors(route)) {
        const schema = node.options.validateSearch;
        if (schema == null) continue;
        const result = schema["~standard"].validate(place.search) as {
          value?: Record<string, unknown>;
        };
        Object.assign(kept, result.value ?? {});
      }
      for (const [key, value] of Object.entries(place.search))
        expect(kept[key], `${place.to}?${key}=${value}`).toBe(value);
    }
  });

  it("says each label as the English app shows it", () => {
    for (const place of places)
      for (const label of place.path) {
        if (label.key == null) continue;
        const text = lookup(label.key);
        expect(typeof text, label.key).toBe("string");
        if (!label.key.startsWith("capabilities.toolsets."))
          expect(text, label.key).toBe(label.text);
      }
  });

  it("says each control by the English app's own label", () => {
    for (const control of BOT_HELP_CONTROLS)
      for (const label of [control.label, ...(control.states ?? [])])
        expect(lookup(label.key!), label.key).toBe(label.text);
  });

  /**
   * The app's areas and pages come from the renderer's own registries: one
   * shipped without a help entry fails here, so the model is never left to
   * describe it from memory.
   */
  it("has an entry for every rail area, settings page and library page", () => {
    const opened = new Set(
      BOT_HELP_CONTROLS.flatMap((control) =>
        control.place == null ? [] : [control.place.to as string]
      )
    );
    const shipped = [
      ...[...RAIL_AREAS, "settings" as const].map((area) => AREA_HOME[area]),
      ...SETTINGS_PAGES.map((page) => `/settings/${page}`),
      ...LIBRARY_PAGES.map((page) => `/library/${page}`),
    ];
    for (const to of shipped) expect(opened.has(to), to).toBe(true);
  });

  it("names every app-wide shortcut as the app binds it", () => {
    // Moving between tabs and Escape are not things anyone asks how to find.
    const tabs = new Set<keyof typeof APP_HOTKEYS>([
      "escape",
      "closeTab",
      "nextTab",
      "previousTab",
      "nextPanelTab",
      "previousPanelTab",
    ]);
    const named = new Set(BOT_HELP_CONTROLS.map((control) => control.hotkey));
    for (const [id, hotkey] of Object.entries(APP_HOTKEYS))
      if (!tabs.has(id as keyof typeof APP_HOTKEYS))
        expect(named.has(hotkey), id).toBe(true);
    for (const control of BOT_HELP_CONTROLS)
      if (control.hotkey != null)
        expect(Object.values(APP_HOTKEYS), control.id).toContain(
          control.hotkey
        );
  });

  it('takes "how do I start a new chat" to New session, and the microphone to no page', () => {
    expect(botHelpPlace("app", "new chat")).toEqual({
      path: [
        { key: "shell.rail.sessions", text: "Sessions" },
        { key: "sessions.sidebar.new", text: "New session" },
      ],
      to: "/sessions/new",
    });
    expect(botHelpPlace("app", "mic")).toBeNull();
  });

  it('takes "can I use Gemini" to the Gemini key row of the Models page', () => {
    expect(botHelpPlace("models", "gemini")).toEqual({
      path: [
        { key: "shell.rail.settings", text: "Settings" },
        { key: "settings.pages.models", text: "Models" },
        { text: "Google Gemini (AI Studio)" },
      ],
      to: "/settings/models",
      search: { provider: "gemini" },
    });
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

  it.each(["/bots/chief-of-staff", "/sessions/fix-sidebar-width"])(
    "/ reopens the last page, %s",
    async (page) => {
      harness = await renderApp(page);
      await act(async () => {
        await harness!.router.navigate({ to: "/" });
      });
      await waitFor(() =>
        expect(harness!.router.state.location.pathname).toBe(page)
      );
    }
  );

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
      name: "connector dialog",
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
        /routine-dialog|connector-dialog|check-in-dialog/
      );
      // The background instance survived the pop-up opening.
      expect(screen.getAllByTestId(background)[0]).toBe(before);

      await act(async () => {
        harness!.router.history.back();
      });
      await waitFor(() =>
        expect(
          screen.queryByTestId(
            /routine-dialog|connector-dialog|check-in-dialog/
          )
        ).toBeNull()
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
