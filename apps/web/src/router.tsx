import type { SystemInfo } from "@abacus-ai/contract/contract";
/**
 * The router (spec 01 §6): file routes, hash history, route masks for the
 * pop-ups, and the context every loader gets. `bootstrap()` resolves the
 * transport, system facts and prefs before this exists (§8.6).
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  createHashHistory,
  createRouteMask,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import type { TFunction } from "i18next";

import { RoutePending, PaneError } from "#renderer/components/page-state";
import type { Db } from "#renderer/data/db";
import { invalidateCredentials } from "#renderer/data/queries/settings";
import type { Transport } from "#renderer/data/transport";
import {
  chatRuntimeFor,
  type ChatRuntime,
} from "#renderer/features/chat/runtime/runtime";
import type { NavType } from "#renderer/lib/motion";

import { routeTree } from "./routeTree.gen";

type Area =
  | "bots"
  | "sessions"
  | "routines"
  | "artifacts"
  | "library"
  | "settings";
/** One sidebar per area in phase 1; the strip is a variant, not an id. */
type SidebarId = Area;

export interface RouterContext {
  queryClient: QueryClient;
  transport: Transport;
  system: SystemInfo;
  /** The document's collections and prefs writer (spec 01 §8.3). */
  db: Db;
  /** `i18n.getFixedT(null)`, for loaders and not-found copy. */
  t: TFunction;
  /**
   * The document's chat runtime (spec 02 §2, §14.8): thread loaders await
   * `chat.session(id).load()`. One per transport, kept across Fast Refresh.
   */
  chat: ChatRuntime;
  /**
   * After this window changed a credential: invalidates at once what a
   * `credentials-changed` notice would, since the route gates cache "signed
   * in" until then. Pages read it here rather than importing the query
   * helper, which would split it into a chunk of its own.
   */
  credentialsChanged(): Promise<void>;
}

export const routeMasks = [
  createRouteMask({
    routeTree,
    from: "/sessions/$sessionId/diff",
    to: "/sessions/$sessionId",
    params: true,
    search: ({
      path: _path,
      source: _source,
      toolKey: _key,
      mode: _mode,
      ...rest
    }) => rest,
  }),
  createRouteMask({
    routeTree,
    from: "/routines/$routineId/edit",
    to: "/routines/$routineId",
    params: true,
    search: true,
  }),
  createRouteMask({
    routeTree,
    from: "/bots/$botId/check-in",
    to: "/bots/$botId",
    params: true,
    search: true,
  }),
  createRouteMask({ routeTree, from: "/routines/new", to: "/routines" }),
  createRouteMask({
    routeTree,
    from: "/library/messaging",
    to: "/library/messaging",
    search: ({ platform: _platform, ...rest }) => rest,
  }),
  createRouteMask({
    routeTree,
    from: "/library/mcp",
    to: "/library/mcp",
    search: ({ server: _server, ...rest }) => rest,
  }),
  createRouteMask({
    routeTree,
    from: "/library/skills",
    to: "/library/skills",
    search: ({ marketplace: _marketplace, ...rest }) => rest,
  }),
  createRouteMask({
    routeTree,
    from: "/settings/account",
    to: "/settings/account",
    search: ({ invite: _invite, ...rest }) => rest,
  }),

  createRouteMask({
    routeTree,
    from: "/library/connectors",
    to: "/library/connectors",
    // The documented "hide a search param" case.
    search: ({ connector: _connector, ...rest }) => rest,
  }),
];

export interface AppRouterOptions {
  /** `chat` defaults to the transport's runtime; tests may pass their own. */
  context: Omit<RouterContext, "chat" | "credentialsChanged"> & {
    chat?: ChatRuntime;
  };
  history?: RouterHistory;
}

export const createAppRouter = ({ context, history }: AppRouterOptions) => {
  const credentialsChanged = () =>
    invalidateCredentials(context.queryClient, context.transport.orpc);
  return createRouter({
    routeTree,
    history: history ?? createHashHistory(),
    context: {
      ...context,
      credentialsChanged,
      chat:
        context.chat ?? chatRuntimeFor(context.transport, credentialsChanged),
    } satisfies RouterContext,
    routeMasks,
    defaultPreload: "intent",
    // Query and DB own staleness (PLAN "Route tree").
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: RoutePending,
    defaultErrorComponent: PaneError,
    // A warm navigation never flashes the skeleton, and one that does show
    // it is not held open past its data.
    defaultPendingMs: 400,
    defaultPendingMinMs: 100,
    scrollRestoration: true,
    // Set by installTransitionTypes: typed navigations only.
    defaultViewTransition: undefined,
    defaultStructuralSharing: true,
  });
};

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
  interface StaticDataRouteOption {
    area?: Area;
    sidebar?: SidebarId;
  }
  interface HistoryState {
    navIntent?: { id: string; type: NavType | "none" };
  }
}
