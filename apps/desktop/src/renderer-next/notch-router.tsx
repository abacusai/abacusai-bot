import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import { installTransitionTypes } from "#next/lib/navigation/transition-types";

import type { NotchRouterContext } from "./notch-context";
import { routeTree } from "./notchRouteTree.gen";
export const createNotchRouter = (context: NotchRouterContext) => {
  const router = createRouter({
    routeTree,
    context,
    history: createMemoryHistory({ initialEntries: ["/idle"] }),
    defaultPreload: false,
    defaultViewTransition: { types: ["notch-swap"] },
  });
  installTransitionTypes(router);
  return router;
};
