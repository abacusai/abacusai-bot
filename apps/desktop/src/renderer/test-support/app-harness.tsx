import { implement, type Router } from "@orpc/server";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  type RouterHistory,
} from "@tanstack/react-router";
import { act, render } from "@testing-library/react";

import type { AiClient } from "#renderer/data/ai";
import { createDb, type Collections, type Db } from "#renderer/data/db";
import {
  FixtureDb,
  fixtureTransport,
  type FixtureSeed,
} from "#renderer/data/fixture-db/fixture-db";
import {
  fixtureBots,
  fixturePrefs,
  fixtureRoutines,
  fixtureSessions,
  fixtureWorkspaces,
} from "#renderer/data/fixture-db/rows";
import { createQueryClient } from "#renderer/data/query-client";
import {
  createMemoryTransport,
  type MemoryTransport,
} from "#renderer/data/transport/memory";
import type { AppClient } from "#renderer/data/transport/types";
import { fixtureRuntime } from "#renderer/features/chat/fixtures/player";
import { resetReadinessForTests } from "#renderer/features/shell/readiness";
import { resetShellStore } from "#renderer/features/shell/shell-store";
import { i18n, initI18n } from "#renderer/lib/i18n";
import { installTransitionTypes } from "#renderer/lib/navigation/transition-types";
import { createAppRouter, type AppRouter } from "#renderer/router";
import {
  contract,
  type SystemInfo,
  type WindowChromeState,
} from "#shared/contract";
import type { RunFinishedNotice } from "#shared/contract/ai";
import type { MaterializeBrowserRuntimeFileRequest } from "#shared/contract/browser";
import type { FilesEvent } from "#shared/contract/files";
import type { TerminalEvent } from "#shared/contract/terminal";
/**
 * The whole app over test doubles: a memory transport answering the handful
 * of procedures the shell calls (system.info, window.chrome, window.ready,
 * the notice streams), collections over a FixtureDb, and a router on memory
 * history. `renderApp("/bots/new")` mounts it; the returned handles drive it.
 */
import type {
  AbacusAuthOutcome,
  FileTreeNode,
  DefaultAgentMode,
  BrowserRuntimeState,
} from "#shared/contracts";

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

const shellRouter = (
  system: SystemInfo = SYSTEM_INFO,
  options: HarnessOptions = {}
) => {
  let onboarded = options.onboarded ?? true;
  const relay = fixtureRuntime("bot-golden-plain", {}, "bot-test")!.relay;
  return {
    system: {
      funnelStep: os.system.funnelStep.handler(({ input, context }) => {
        context.calls.push(["system.funnelStep", input]);
      }),
      openExternal: os.system.openExternal.handler(({ input }) => {
        options.openExternal?.(input.url);
      }),
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
      keys: { listProviders: os.settings.keys.listProviders.handler(() => []) },
      sandboxSupport: os.settings.sandboxSupport.handler(() => ({
        available: true,
        reason: null,
      })),
      execBackend: {
        get: os.settings.execBackend.get.handler(
          () =>
            ({
              selected: "local",
              effective: "local",
              statuses: [{ id: "local", ready: true }],
            }) as never
        ),
      },
      events: os.settings.events.handler(quiet as never),
      get: os.settings.get.handler(() => ({ defaultModel: null }) as never),
      defaultMode: {
        get: os.settings.defaultMode.get.handler(
          options.defaultMode ?? (() => "YOLO" as never)
        ),
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
      openChat: os.bots.openChat.handler(async ({ input, context }) => {
        context.calls.push(["bots.openChat", input]);
        await options.beforeOpenChat?.();
        return {
          botId: input.botId,
          sessionId: "bot-test",
          workspaceId: "default",
        };
      }),
    },
    browser: {
      events: os.browser.events.handler(quiet as never),
      profiles: { list: os.browser.profiles.list.handler(() => []) },
      runtime: {
        materialize: os.browser.runtime.materialize.handler(
          ({ input, context }) => {
            context.calls.push(["browser.runtime.materialize", input]);
            return {
              lease: {
                conversationKey: input.conversationKey,
                resourceId: input.resourceId,
                generation: 1,
              },
              url: input.url ?? "about:blank",
              loading: false,
              canGoBack: false,
              canGoForward: false,
            } as BrowserRuntimeState;
          }
        ),
        present: os.browser.runtime.present.handler(({ input, context }) => {
          context.calls.push(["browser.runtime.present", input]);
          return {
            lease: input.lease,
            url: "about:blank",
          } as BrowserRuntimeState;
        }),
        hide: os.browser.runtime.hide.handler(() => {}),
        capture: os.browser.runtime.capture.handler(
          () => ({ dataUrl: null }) as never
        ),
        materializeFile: os.browser.runtime.materializeFile.handler(
          ({ input }) => {
            if (!options.materializeFile)
              throw new Error("Missing local file fixture");
            return options.materializeFile(input);
          }
        ),
        close: os.browser.runtime.close.handler(() => {}),
      },
    },
    models: { list: os.models.list.handler(() => []) },
    connectors: {
      cancelConnect: os.connectors.cancelConnect.handler(() => {}),
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
    auth: {
      openRouter: { cancel: os.auth.openRouter.cancel.handler(() => {}) },
      abacus: {
        browserProfiles: os.auth.abacus.browserProfiles.handler(() => []),
        start: os.auth.abacus.start.handler(({ input, context }) => {
          context.calls.push(["auth.abacus.start", input]);
          return (
            options.authStart?.() ?? {
              ok: false,
              cancelled: true,
              error: "cancelled",
            }
          );
        }),
        cancel: os.auth.abacus.cancel.handler(({ context }) => {
          context.calls.push(["auth.abacus.cancel", {}]);
        }),
      },
    },
    account: {
      state: os.account.state.handler(() => ({
        account: null,
        apps: [],
        onboarded,
      })),
      skipOnboarding: os.account.skipOnboarding.handler(({ context }) => {
        onboarded = true;
        context.calls.push(["account.skipOnboarding", {}]);
        return { account: null, apps: [], onboarded };
      }),
      abacus: os.account.abacus.handler(() => null),
    },
    localModels: {
      state: os.localModels.state.handler(() => ({
        runtimeAvailable: false,
        totalMemoryBytes: 0,
        recommendedId: "qwen3.5-4b",
        catalog: [],
        installedIds: [],
        download: null,
        servingId: null,
      })),
    },
    workspaces: {
      checkPath: os.workspaces.checkPath.handler(({ input }) => ({
        workspaceId: input.workspaceId,
        path: "/repo",
        exists: true,
      })),
      ensureSessionHome: os.workspaces.ensureSessionHome.handler(
        ({ context }) => {
          context.calls.push(["workspaces.ensureSessionHome", null]);
          return { workspaceId: "default" };
        }
      ),
    },
    git: {
      checkoutStatus: os.git.checkoutStatus.handler(() => ({
        kind: "primary",
        path: "/repo",
        exists: true,
        workspaceExists: true,
      })),
      watch: os.git.watch.handler(quiet as never),
      currentBranch: os.git.currentBranch.handler(
        () => ({ currentBranch: "main" }) as never
      ),
      branches: os.git.branches.handler(() => ({ branches: [] }) as never),
      prInfo: os.git.prInfo.handler(() => null),
      worktrees: {
        list: os.git.worktrees.list.handler(() => ({ worktrees: [] }) as never),
      },
      diff: os.git.diff.handler(() => ({ kind: "none" })),
    },
    devices: {
      status: os.devices.status.handler(
        () => ({ available: false, enabled: false }) as never
      ),
      list: os.devices.list.handler(() => []),
    },
    terminal: {
      events: os.terminal.events.handler(
        options.terminalEvents ?? (quiet as never)
      ),
    },
    agent: {
      start: os.agent.start.handler(({ context, input }) => {
        context.calls.push(["agent.start", input]);
        return { success: true } as never;
      }),
      switchConversation: os.agent.switchConversation.handler(() => {}),
    },
    files: {
      events: os.files.events.handler(options.filesEvents ?? (quiet as never)),
      treeRoot: os.files.treeRoot.handler(() => ({
        fileTree: options.fileTree ?? [],
        lastUpdatedAt: "now",
      })),
      search: os.files.search.handler(() => ({ items: [] })),
      rename: os.files.rename.handler(async ({ input, context }) => {
        context.calls.push(["files.rename", input]);
        await options.renameFile?.(input);
      }),
    },
    ai: {
      send: os.ai.send.handler(({ input, context }) => {
        context.calls.push(["ai.send", input]);
        return (options.ai ?? relay.ai).send(input);
      }),
      hydrate: os.ai.hydrate.handler(async ({ input }) => {
        await options.beforeHydrate?.();
        return (options.ai ?? relay.ai).hydrate(input);
      }),
      subscribe: os.ai.subscribe.handler(
        ({ input, signal }) =>
          (options.ai ?? relay.ai).subscribe(input, { signal }) as never
      ),
      runFinished: os.ai.runFinished.handler(
        options.runFinished ?? (quiet as never)
      ),
      attention: os.ai.attention.handler(quiet as never),
    },
  } as unknown as Router<any, { calls: Array<[string, unknown]> }>;
};

export const defaultSeed = (): FixtureSeed => ({
  prefs: fixturePrefs(),
  bots: fixtureBots(1_800_000_000_000),
  sessions: fixtureSessions(1_800_000_000_000),
  workspaces: fixtureWorkspaces(),
  routines: fixtureRoutines(1_800_000_000_000),
});

export interface HarnessOptions {
  onboarded?: boolean;
  authStart?(): Promise<AbacusAuthOutcome>;
  seed?: FixtureSeed;
  system?: SystemInfo;
  /** Feature-owned procedures exercise the real contract and memory transport. */
  procedures?: Record<string, unknown>;
  history?: RouterHistory;
  /** Runs on the FixtureDb before any collection syncs. */
  beforeRender?: (db: FixtureDb) => void;
  defaultMode?: () => Promise<DefaultAgentMode>;
  materializeFile?: (
    input: MaterializeBrowserRuntimeFileRequest
  ) => Promise<BrowserRuntimeState>;
  beforeOpenChat?: () => Promise<void>;
  beforeHydrate?: () => Promise<void>;
  ai?: AiClient;
  runFinished?: () => AsyncGenerator<RunFinishedNotice>;
  filesEvents?: () => AsyncGenerator<FilesEvent>;
  terminalEvents?: () => AsyncGenerator<TerminalEvent>;
  fileTree?: FileTreeNode[];
  renameFile?: (
    input: Parameters<AppClient["files"]["rename"]>[0]
  ) => Promise<void>;
  openExternal?: (url: string) => void;
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
  const system = options.system ?? SYSTEM_INFO;
  const mergeProcedures = (
    base: Record<string, unknown>,
    extra: Record<string, unknown>
  ): Record<string, unknown> => {
    const result = { ...base };
    for (const [key, value] of Object.entries(extra))
      result[key] =
        value && typeof value === "object" && !("~orpc" in value)
          ? mergeProcedures(
              (base[key] ?? {}) as Record<string, unknown>,
              value as Record<string, unknown>
            )
          : value;
    return result;
  };
  const transport = createMemoryTransport(
    mergeProcedures(
      shellRouter(system, {
        onboarded: !path.startsWith("/onboarding"),
        ...options,
      }) as Record<string, unknown>,
      options.procedures ?? {}
    ) as ReturnType<typeof shellRouter>,
    { calls }
  );
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
      system,
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
