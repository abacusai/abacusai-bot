/**
 * The root (spec 01 §6.1). No async boot work here: the transport, system
 * facts and prefs were resolved by bootstrap() and arrive as context.
 */
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";

import { LibraryGlobals } from "#next/features/library";
import { RoutinesGlobals } from "#next/features/routines";
import { CriticalUpdateDialog } from "#next/features/settings";
import { AppRoot, NotFound, RootError } from "#next/features/shell";
import { installLogRing } from "#next/lib/log-ring";
import type { RouterContext } from "#next/router";

const Devtools =
  import.meta.env.DEV && import.meta.env.MODE !== "test"
    ? lazy(() =>
        import("#next/lib/devtools").then((module) => ({
          default: module.Devtools,
        }))
      )
    : null;

const RootComponent = () => {
  const { transport, db, system } = Route.useRouteContext();
  useEffect(() => {
    if (import.meta.env.MODE !== "test") return installLogRing(transport);
  }, [transport]);
  return (
    <AppRoot transport={transport} db={db} system={system}>
      <Outlet />
      <RoutinesGlobals />
      <LibraryGlobals />
      <CriticalUpdateDialog />
      {Devtools != null && (
        <Suspense fallback={null}>
          <Devtools />
        </Suspense>
      )}
    </AppRoot>
  );
};

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: RootError,
  notFoundComponent: NotFound,
});
