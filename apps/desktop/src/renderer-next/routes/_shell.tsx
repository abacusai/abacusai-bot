import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { BotsGlobals } from "#next/features/bots";
import { SessionsGlobals } from "#next/features/sessions";
import { dispatchPreview } from "#next/features/shell";
import { ShellLayout } from "#next/features/shell";
import { ignoreLoadError } from "#next/lib/navigation/loaders";
import { SHELL_DEFAULTS, ShellSearch } from "#next/lib/navigation/search";
import { useChromeState } from "#next/lib/window-chrome/chrome-state";

/** "/Users/ada" → "AD": the account avatar until the account row exists. */
const initialsOf = (home: string): string =>
  (home.split(/[\\/]/).filter(Boolean).at(-1) ?? "").slice(0, 2).toUpperCase();

const ShellRoute = () => {
  const { transport, system } = Route.useRouteContext();
  const chrome = useChromeState(transport);
  return (
    <>
      <ShellLayout
        geometryMissing={
          import.meta.env.DEV && chrome.mode === "overlay-unavailable"
        }
        initials={initialsOf(system.homeDir)}
      />
      <BotsGlobals />
      <SessionsGlobals preview={dispatchPreview} />
    </>
  );
};

export const Route = createFileRoute("/_shell")({
  validateSearch: ShellSearch,
  search: { middlewares: [stripSearchParams(SHELL_DEFAULTS)] },
  loader: ({ context }) =>
    Promise.all([
      context.db.collections.sessions.preload().catch(ignoreLoadError),
      context.db.collections.workspaces.preload().catch(ignoreLoadError),
    ]),
  component: ShellRoute,
});
