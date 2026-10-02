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

import { createDb, type Collections, type Db } from "#next/data/db";
import {
  FixtureDb,
  fixtureTransport,
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
import { fixtureRuntime } from "#next/features/chat/fixtures/player";
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

const CHROME: WindowChromeState = {
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

const relay = fixtureRuntime("bot-golden-plain", {}, "bot-test")!.relay;
const shellRouter = (system: SystemInfo = SYSTEM_INFO) =>
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
    settings: {
      events: os.settings.events.handler(quiet as never),
      get: os.settings.get.handler(() => ({ defaultModel: null }) as never),
      defaultMode: {
        get: os.settings.defaultMode.get.handler(() => "YOLO" as never),
      },
      notifications: {
        get: os.settings.notifications.get.handler(
          () => ({ enabled: false }) as never
        ),
      },
    },
    bots: {
      chatPreviews: os.bots.chatPreviews.handler(() => ({})),
      senderChats: os.bots.senderChats.handler(() => []),
      events: os.bots.events.handler(quiet as never),
      openChat: os.bots.openChat.handler(({ input, context }) => {
        context.calls.push(["bots.openChat", input]);
        return {
          botId: input.botId,
          sessionId: "bot-test",
          workspaceId: "default",
        };
      }),
    },
    models: { list: os.models.list.handler(() => []) },
    connectors: {
      statuses: os.connectors.statuses.handler(() => ({})),
      events: os.connectors.events.handler(quiet as never),
    },
    messaging: {
      snapshot: os.messaging.snapshot.handler(() => ({
        platforms: [],
        approved: [],
        pending: [],
        autoReplies: [],
        gatewayEnabled: false,
        autoApproveTools: false,
        respondToInbound: false,
        workspaceId: null,
        botId: null,
      })),
      events: os.messaging.events.handler(quiet as never),
    },
    memory: {
      bots: os.memory.bots.handler(() => []),
      events: os.memory.events.handler(quiet as never),
    },
    account: { abacus: os.account.abacus.handler(() => null) },
    files: { events: os.files.events.handler(quiet as never) },
    ai: {
      hydrate: os.ai.hydrate.handler(({ input }) => relay.ai.hydrate(input)),
      subscribe: os.ai.subscribe.handler(
        ({ input, signal }) => relay.ai.subscribe(input, { signal }) as never
      ),
      runFinished: os.ai.runFinished.handler(quiet as never),
      attention: os.ai.attention.handler(quiet as never),
    },
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
  /** The app's collections and prefs writer over `db`. */
  appDb: Db;
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
  const appDb = createDb(fixtureTransport(db), { retryDelayMs: () => 5 });
  const { collections } = appDb;
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
      db: appDb,
      t: i18n.getFixedT(null, "translation") as never,
    },
  });
  installTransitionTypes(router);
  (router as { __queryClient?: unknown }).__queryClient = queryClient;
  return {
    router,
    history,
    db,
    appDb,
    collections,
    transport,
    calls,
    cleanup: async () => {
      appDb.stop();
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
