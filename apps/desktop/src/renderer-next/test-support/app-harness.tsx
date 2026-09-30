/**
 * The whole app over test doubles: a memory transport answering the handful
 * of procedures the shell calls (system.info, window.chrome, window.ready,
 * the notice streams), collections over a FixtureDb, and a router on memory
 * history. `renderApp("/bots/new")` mounts it; the returned handles drive it.
 */
import { implement, type Router } from "@orpc/server";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  type RouterHistory,
} from "@tanstack/react-router";
import { act, render } from "@testing-library/react";

import { createCollections, type Collections } from "#next/data/collections";
import {
  FixtureDb,
  directDbSource,
  type FixtureSeed,
} from "#next/data/fixture-db/fixture-db";
import {
  fixtureBots,
  fixturePrefs,
  fixtureRoutines,
  fixtureSessions,
  fixtureWorkspaces,
} from "#next/data/fixture-db/rows";
import { createQueryClient } from "#next/data/query-client";
import {
  createMemoryTransport,
  type MemoryTransport,
} from "#next/data/transport/memory";
import { resetReadinessForTests } from "#next/features/shell/readiness";
import { resetShellStore } from "#next/features/shell/shell-store";
import { i18n, initI18n } from "#next/lib/i18n";
import { installTransitionTypes } from "#next/lib/navigation/transition-types";
import { createAppRouter, type AppRouter } from "#next/router";
import {
  contract,
  type SystemInfo,
  type WindowChromeState,
} from "#shared/contract";

export const SYSTEM_INFO: SystemInfo = {
  appVersion: "1.0.0",
  platform: "darwin",
  arch: "arm64",
  versions: {},
  homeDir: "/Users/ada",
  paths: { home: "/Users/ada", sessionHome: "/s", botHome: "/b" },
  materialIconsBasePath: null,
  contractVersion: 1,
  foundationApi: 2,
};

export const CHROME: WindowChromeState = {
  mode: "overlay",
  fullScreen: false,
  density: "comfortable",
  toolbarHeight: 40,
};

const os = implement(contract).$context<{ calls: Array<[string, unknown]> }>();

const quiet = async function* ({ signal }: { signal?: AbortSignal }) {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  yield* [];
};

export const shellRouter = (system: SystemInfo = SYSTEM_INFO) =>
  ({
    system: {
      info: os.system.info.handler(({ context }) => {
        context.calls.push(["system.info", null]);
        return system;
      }),
    },
    window: {
      chrome: os.window.chrome.handler(() => CHROME),
      ready: os.window.ready.handler(({ input, context }) => {
        context.calls.push(["window.ready", input]);
      }),
      events: os.window.events.handler(quiet as never),
    },
    settings: { events: os.settings.events.handler(quiet as never) },
  }) as unknown as Router<any, { calls: Array<[string, unknown]> }>;

export const defaultSeed = (): FixtureSeed => ({
  prefs: fixturePrefs(),
  bots: fixtureBots(1_800_000_000_000),
  sessions: fixtureSessions(1_800_000_000_000),
  workspaces: fixtureWorkspaces(),
  routines: fixtureRoutines(1_800_000_000_000),
});

export interface HarnessOptions {
  seed?: FixtureSeed;
  history?: RouterHistory;
  /** Runs on the FixtureDb before any collection syncs. */
  beforeRender?: (db: FixtureDb) => void;
}

export interface AppHarness {
  router: AppRouter;
  history: RouterHistory;
  db: FixtureDb;
  collections: Collections;
  transport: MemoryTransport;
  calls: Array<[string, unknown]>;
  cleanup(): Promise<void>;
}

export const createHarness = async (
  path: string,
  options: HarnessOptions = {}
): Promise<AppHarness> => {
  await initI18n();
  await i18n.changeLanguage("en-US");
  resetShellStore();
  resetReadinessForTests();
  const calls: Array<[string, unknown]> = [];
  const transport = createMemoryTransport(shellRouter(), { calls });
  const db = new FixtureDb(options.seed ?? defaultSeed());
  options.beforeRender?.(db);
  const collections = createCollections(directDbSource(db), { backoffMs: [5] });
  await collections.prefs.preload();
  const queryClient = createQueryClient();
  const history =
    options.history ?? createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({
    history,
    context: {
      queryClient,
      transport,
      system: SYSTEM_INFO,
      collections,
      t: i18n.getFixedT(null, "translation") as never,
    },
  });
  installTransitionTypes(router);
  (router as { __queryClient?: unknown }).__queryClient = queryClient;
  return {
    router,
    history,
    db,
    collections,
    transport,
    calls,
    cleanup: async () => {
      for (const collection of Object.values(collections))
        await collection.cleanup().catch(() => undefined);
      transport.close();
    },
  };
};

export const renderApp = async (path: string, options: HarnessOptions = {}) => {
  const harness = await createHarness(path, options);
  const queryClient = (harness.router as { __queryClient?: unknown })
    .__queryClient as ReturnType<typeof createQueryClient>;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={harness.router} />
      </QueryClientProvider>
    );
    await harness.router.load();
  });
  return { ...harness, view };
};
