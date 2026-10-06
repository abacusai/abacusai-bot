/**
 * The root (spec 01 §6.1). No async boot work here: the transport, system
 * facts and prefs were resolved by bootstrap() and arrive as context.
 */
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";

import { followSettingsNotices } from "#renderer/data/queries/settings";
import { followWindowNotices } from "#renderer/data/queries/window";
import { LibraryGlobals } from "#renderer/features/library/globals";
import { RoutinesGlobals } from "#renderer/features/routines/globals";
import { AppRoot } from "#renderer/features/shell/app-root";
import { NotFound, RootError } from "#renderer/features/shell/screens";
import { ActionBindingsProvider } from "#renderer/lib/keyboard/action-bindings";
import { installLogRing } from "#renderer/lib/log-ring";
import type { RouterContext } from "#renderer/router";

const Devtools =
  import.meta.env.DEV && import.meta.env.MODE !== "test"
    ? lazy(() =>
        import("#renderer/lib/devtools").then((module) => ({
          default: module.Devtools,
        }))
      )
    : null;

import { UpdateOwner } from "#platform/updates";

const RootComponent = () => {
  const { transport, db, queryClient } = Route.useRouteContext();
  useEffect(() => {
    if (import.meta.env.MODE !== "test") return installLogRing(transport);
  }, [transport]);
  useEffect(() => {
    const abort = new AbortController();
    followSettingsNotices(transport, queryClient, abort.signal);
    followWindowNotices(transport, queryClient, abort.signal);
    return () => abort.abort();
  }, [transport, queryClient]);
  return (
    <AppRoot transport={transport} db={db}>
      <ActionBindingsProvider>
        <Outlet />
        <RoutinesGlobals />
        <LibraryGlobals />
        <Suspense fallback={null}>
          <UpdateOwner />
        </Suspense>
      </ActionBindingsProvider>
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
