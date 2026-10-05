import {
  createFileRoute,
  Outlet,
  redirect,
  useMatches,
} from "@tanstack/react-router";

import { OnboardingFrame } from "#renderer/features/onboarding";
import { accountStateQuery } from "#renderer/features/onboarding/actions";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";
import { canSignOutOfAbacus } from "#shared/settings";
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
  beforeLoad: async ({ context }) => {
    const account = await context.queryClient.ensureQueryData(
      accountStateQuery(context.transport)
    );
    if (
      account.onboarded &&
      canSignOutOfAbacus(await context.transport.client.settings.get({}))
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
