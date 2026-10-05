import { canSignOutOfAbacus } from "@abacus-ai/contract/settings";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatches,
} from "@tanstack/react-router";

import { OnboardingFrame } from "#renderer/features/onboarding";
import {
  accountStateQuery,
  signedInQuery,
} from "#renderer/features/onboarding/actions";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";
const Layout = () => {
  const matches = useMatches();
  const step = matches.at(-1)?.params as { step?: OnboardingStepId };
  return (
    <OnboardingFrame step={step.step ?? "welcome"}>
      <Outlet />
    </OnboardingFrame>
  );
};
export const Route = createFileRoute("/_bare/onboarding")({
  beforeLoad: async ({ context, preload }) => {
    if (preload) return;
    const account = await context.queryClient.ensureQueryData(
      accountStateQuery(context.transport)
    );
    if (
      account.onboarded &&
      canSignOutOfAbacus(
        await context.queryClient.fetchQuery(signedInQuery(context.transport))
      )
    )
      throw redirect({ to: "/bots/new", replace: true });
  },
  loader: ({ context }) =>
    Promise.all([
      context.db.collections.prefs.preload(),
      context.db.collections.bots.preload(),
    ]),
  component: Layout,
});
