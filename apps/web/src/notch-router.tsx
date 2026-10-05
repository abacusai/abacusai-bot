import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import type { NotchRouterContext } from "./notch-context";
import { routeTree } from "./notchRouteTree.gen";
export const createNotchRouter = (context: NotchRouterContext) => {
  const router = createRouter({
    routeTree,
    context,
    history: createMemoryHistory({ initialEntries: ["/idle"] }),
    defaultPreload: false,
    // Document snapshots escape the bezel clip and cannot follow an interrupted resize.
    defaultViewTransition: false,
  });
  return router;
};
