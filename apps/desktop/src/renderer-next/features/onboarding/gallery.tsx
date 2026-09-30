import { useRouter } from "@tanstack/react-router";

import { useDb } from "#next/data/db";
import type { OnboardingStepId } from "#next/lib/navigation/areas";

import { OnboardingFrame, OnboardingStepPage } from "./index";
export const OnboardingGallery = ({ step }: { step: OnboardingStepId }) => {
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
        previewBot={bot ? { bot, checkInRoutineId: null } : undefined}
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
