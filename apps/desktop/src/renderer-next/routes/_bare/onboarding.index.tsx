import { createFileRoute, redirect } from "@tanstack/react-router";

import { DEFAULT_PREFS } from "#next/data/db/prefs";
import { onboardingTarget } from "#next/features/onboarding";

export const Route = createFileRoute("/_bare/onboarding/")({
  beforeLoad: ({ context }) => {
    throw redirect({
      ...onboardingTarget(
        context.db.collections.prefs.get("app") ?? DEFAULT_PREFS
      ),
      replace: true,
    });
  },
});
