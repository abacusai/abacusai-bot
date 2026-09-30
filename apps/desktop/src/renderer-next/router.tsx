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

import type { Collections } from "#next/data/collections";
import type { Transport } from "#next/data/transport";
import type { NavType } from "#next/lib/motion";
import { Spinner } from "#next/ui/spinner";
import type { SystemInfo } from "#shared/contract";

import { routeTree } from "./routeTree.gen";

/** Shown after 150 ms of loading, for at least 200 ms. */
const PendingPane = () => (
  <div
    data-testid="pending-pane"
    className="text-muted-foreground flex size-full items-center justify-center"
  >
    <Spinner />
  </div>
);

export type Area =
  | "bots"
  | "sessions"
  | "routines"
  | "artifacts"
  | "library"
  | "settings";
/** One sidebar per area in phase 1; the strip is a variant, not an id. */
export type SidebarId = Area;

export interface RouterContext {
  queryClient: QueryClient;
  transport: Transport;
  system: SystemInfo;
  collections: Collections;
  /** `i18n.getFixedT(null)`, for loaders and not-found copy. */
  t: TFunction;
}

export const routeMasks = [
  createRouteMask({
    routeTree,
    from: "/bots/$botId/details",
    to: "/bots/$botId",
    params: true,
    search: true,
  }),
  createRouteMask({ routeTree, from: "/routines/new", to: "/routines" }),
  createRouteMask({
    routeTree,
    from: "/library/connectors",
    to: "/library/connectors",
    // The documented "hide a search param" case.
    search: ({ connector: _connector, ...rest }) => rest,
  }),
];

export { PANE_BOUNDARIES } from "#next/lib/navigation/pane-key";

export interface AppRouterOptions {
  context: RouterContext;
  history?: RouterHistory;
}

export const createAppRouter = ({ context, history }: AppRouterOptions) =>
  createRouter({
    routeTree,
    history: history ?? createHashHistory(),
    context,
    routeMasks,
    defaultPreload: "intent",
    // Query and DB own staleness (PLAN "Route tree").
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PendingPane,
    defaultPendingMs: 150,
    defaultPendingMinMs: 200,
    scrollRestoration: true,
    // React owns view transitions (PLAN "Motion").
    defaultViewTransition: undefined,
    defaultStructuralSharing: true,
  });

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
