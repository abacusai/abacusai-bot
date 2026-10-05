import {
  createFileRoute,
  Outlet,
  redirect,
  useMatches,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { OnboardingFrame } from "#renderer/features/onboarding";
import {
  confirmProvisional,
  keep,
  leave,
  readGate,
  takeDestination,
  unlessConnecting,
} from "#renderer/features/onboarding/gate";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";
const Layout = () => {
  const { provisional, queryClient, transport } = Route.useRouteContext();
  const router = useRouter();
  useEffect(() => {
    if (!provisional) return;
    void confirmProvisional({ queryClient, transport }, "onboarding", () =>
      router.invalidate()
    ).catch((error: unknown) =>
      console.warn("[gate] sign-in check deferred", error)
    );
  }, [provisional, queryClient, transport, router]);
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
    if (preload) return { provisional: false };
    // The same provisional rule as the shell (gate.ts).
    const gate = readGate(context, "onboarding");
    if (gate == null) return { provisional: true };
    const fresh = await gate;
    const { account, signedIn } = fresh;
    if (account.onboarded && signedIn) {
      leave(context);
      const destination = takeDestination();
      if (destination != null)
        throw redirect({ href: destination, replace: true });
      throw redirect({ to: "/bots/new", replace: true });
    }
    keep(context, "onboarding", fresh);
    return { provisional: false };
  },
  loader: ({ context }) =>
    unlessConnecting(
      context.transport,
      Promise.all([
        context.db.collections.prefs.preload(),
        context.db.collections.bots.preload(),
      ])
    ),
  component: Layout,
});
