import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

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
    <ShellLayout
      geometryMissing={
        import.meta.env.DEV && chrome.mode === "overlay-unavailable"
      }
      initials={initialsOf(system.homeDir)}
    />
  );
};

export const Route = createFileRoute("/_shell")({
  validateSearch: ShellSearch,
  search: { middlewares: [stripSearchParams(SHELL_DEFAULTS)] },
  loader: ({ context }) =>
    Promise.all([
      context.collections.sessions.preload().catch(ignoreLoadError),
      context.collections.workspaces.preload().catch(ignoreLoadError),
    ]),
  component: ShellRoute,
});
