/**
 * The root (spec 01 §6.1). No async boot work here: the transport, system
 * facts and prefs were resolved by bootstrap() and arrive as context.
 */
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";

import { LibraryGlobals } from "#renderer/features/library/globals";
import { RoutinesGlobals } from "#renderer/features/routines/globals";
import {
  CriticalUpdateDialog,
  useUpdatePillAction,
} from "#renderer/features/settings/updates";
import { AppRoot } from "#renderer/features/shell/app-root";
import { NotFound, RootError } from "#renderer/features/shell/screens";
import { useTopBarEndActions } from "#renderer/features/shell/top-bar-slots";
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

const UpdateEndAction = () => {
  useTopBarEndActions(useUpdatePillAction());
  return null;
};

const RootComponent = () => {
  const { transport, db, system } = Route.useRouteContext();
  useEffect(() => {
    if (import.meta.env.MODE !== "test") return installLogRing(transport);
  }, [transport]);
  return (
    <AppRoot transport={transport} db={db} system={system}>
      <ActionBindingsProvider>
        <Outlet />
        <RoutinesGlobals />
        <LibraryGlobals />
        <CriticalUpdateDialog />
        <UpdateEndAction />
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
