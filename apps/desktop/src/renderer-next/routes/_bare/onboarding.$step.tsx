import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { OnboardingStepPage } from "#next/features/onboarding";
import { ONBOARDING_STEPS } from "#next/lib/navigation/areas";

const OnboardingRoute = () => {
  const { step } = Route.useParams();
  return <OnboardingStepPage step={step} />;
};

export const Route = createFileRoute("/_bare/onboarding/$step")({
  params: { parse: v.parser(v.object({ step: v.picklist(ONBOARDING_STEPS) })) },
  component: OnboardingRoute,
});
