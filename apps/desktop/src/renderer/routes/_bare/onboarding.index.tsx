import { createFileRoute, redirect } from "@tanstack/react-router";

import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import { onboardingTarget } from "#renderer/features/onboarding";

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
