import {
  createFileRoute,
  stripSearchParams,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { DEFAULT_PREFS } from "#next/data/db/prefs";
import { BotsGlobals } from "#next/features/bots";
import {
  accountStateQuery,
  needsOnboarding,
  onboardingTarget,
  finishCompletion,
} from "#next/features/onboarding";
import { PairingQueueBanner } from "#next/features/onboarding";
import { SessionsGlobals } from "#next/features/sessions";
import { dispatchPreview } from "#next/features/shell";
import { ShellLayout } from "#next/features/shell";
import { TourHost, startTour, useTourState } from "#next/features/tour";
import { OpenTargetBridge } from "#next/lib/attention/open-target";
import { useDocumentSoundOwner } from "#next/lib/document-sound";
import { ignoreLoadError } from "#next/lib/navigation/loaders";
import { SHELL_DEFAULTS, ShellSearch } from "#next/lib/navigation/search";
import { useChromeState } from "#next/lib/window-chrome/chrome-state";

/** "/Users/ada" → "AD": the account avatar until the account row exists. */
const initialsOf = (home: string): string =>
  (home.split(/[\\/]/).filter(Boolean).at(-1) ?? "").slice(0, 2).toUpperCase();

const ShellRoute = () => {
  const { transport, system, db, queryClient } = Route.useRouteContext();
  useDocumentSoundOwner(transport);
  const router = useRouter();
  const tour = useTourState();
  useEffect(() => {
    const exit = db.collections.prefs.get("app")?.onboardingExit;
    if (!exit) return;
    void finishCompletion(
      {
        db,
        transport,
        queryClient,
        navigate: async () => undefined,
        startTour: () =>
          startTour({ origin: router.state.location.href, onboarded: true }),
      },
      exit
    ).catch((error) => console.warn("[onboarding] tail deferred", error));
  }, [db, transport, queryClient, router]);
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
      <TourHost />
      <OpenTargetBridge />
      <PairingQueueBanner suppressed={tour != null} />
      <SessionsGlobals preview={dispatchPreview} />
    </>
  );
};

export const Route = createFileRoute("/_shell")({
  beforeLoad: async ({ context, location }) => {
    const account = await context.queryClient.ensureQueryData(
      accountStateQuery(context.transport)
    );
    const prefs = context.db.collections.prefs.get("app") ?? DEFAULT_PREFS;
    if (needsOnboarding(account))
      throw redirect({ ...onboardingTarget(prefs), replace: true });
    const exit = prefs.onboardingExit;
    if (exit) {
      const target =
        exit.to === "new-session"
          ? "/sessions/new"
          : exit.to === "new-bot"
            ? "/bots/new"
            : `/bots/${encodeURIComponent(exit.botId)}${exit.to === "bot" && exit.edit ? "/edit" : ""}`;
      if (location.pathname !== target)
        throw redirect({ href: target, replace: true });
    }
  },
  validateSearch: ShellSearch,
  search: { middlewares: [stripSearchParams(SHELL_DEFAULTS)] },
  loader: ({ context }) =>
    Promise.all([
      context.db.collections.sessions.preload().catch(ignoreLoadError),
      context.db.collections.workspaces.preload().catch(ignoreLoadError),
    ]),
  component: ShellRoute,
});
