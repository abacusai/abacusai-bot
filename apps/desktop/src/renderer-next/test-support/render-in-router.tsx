/**
 * Render a component inside a one-route router (for hooks like useParams)
 * with the given collections, without the app's loaders.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";

import { CollectionsProvider, type Collections } from "#next/data/collections";
import { i18n, initI18n } from "#next/lib/i18n";

export const renderInRouter = async (
  node: ReactNode,
  collections: Collections,
  path = "/"
) => {
  await initI18n();
  await i18n.changeLanguage("en-US");
  const rootRoute = createRootRoute({
    component: () => (
      <CollectionsProvider value={collections}>{node}</CollectionsProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RouterProvider router={router as never} />);
    await router.load();
  });
  return { router, view };
};
