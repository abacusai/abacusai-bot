import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import { OnboardingFrame, OnboardingStepPage } from "./index";
export const OnboardingGallery = ({ step }: { step: OnboardingStepId }) => {
  const { t } = useTranslation();
  const router = useRouter();
  const { transport } = router.options.context;
  const db = useDb();
  const bot = db.collections.bots.toArray.find((bot) => bot.channel == null);
  const previewBot = bot
    ? { bot, checkInRoutineId: "fixture-weekday-check-in" }
    : undefined;
  return (
    <OnboardingFrame step={step}>
      <OnboardingStepPage
        step={step}
        transport={transport}
        facts={{
          signedIn: step !== "welcome" && step !== "connect",
          payingTier: false,
          ownsBot: false,
        }}
        preview={true}
        localModel={
          <div className="onboarding-row">
            <span className="onboarding-row-title flex-1">
              {t("onboarding.pages.models.local")}{" "}
              <span className="onboarding-accent">
                {t("onboarding.pages.models.localAccent")}
              </span>
            </span>
          </div>
        }
        previewBot={previewBot}
        navigate={async () => {}}
        signIn={() => {}}
        cancelSignIn={async () => {}}
        complete={async () => {}}
        createFirstBot={async () => {
          throw new Error("Gallery does not create bots");
        }}
      />
    </OnboardingFrame>
  );
};
