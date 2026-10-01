import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";
import { Button } from "#renderer/ui/button";

import { OnboardingFrame, OnboardingStepPage } from "./index";
export const OnboardingGallery = ({ step }: { step: OnboardingStepId }) => {
  const { t } = useTranslation();
  const router = useRouter();
  const { transport } = router.options.context;
  const db = useDb();
  const bot = db.collections.bots.toArray.find((bot) => bot.channel == null);
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
        addKey={<Button>{t("onboarding.pages.addKey")}</Button>}
        localModel={
          <div className="bg-muted flex items-center justify-between rounded-xl border p-4">
            <span>{t("onboarding.pages.localModels")}</span>
            <Button>{t("localModels.useLocal")}</Button>
          </div>
        }
        previewBot={
          bot
            ? { bot, checkInRoutineId: "fixture-weekday-check-in" }
            : undefined
        }
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
