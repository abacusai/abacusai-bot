/** Onboarding, phase 1: the steps exist as routes (canvas page 11), empty. */
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import type { OnboardingStepId } from "#next/lib/navigation/areas";

export type OnboardingStep = OnboardingStepId;

export const OnboardingStepPage = ({ step }: { step: OnboardingStep }) => {
  const { t } = useTranslation();
  return (
    <div className="bg-background flex size-full items-center justify-center">
      <EmptyState
        title={t(`onboardingFlow.steps.${step}`)}
        description={t("onboardingFlow.description")}
      />
    </div>
  );
};
