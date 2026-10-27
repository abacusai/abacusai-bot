import { useRouter } from "@tanstack/react-router";

import { useDb } from "#renderer/data/db";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import type { InboxPass } from "./first-bot";
import { OnboardingFrame, OnboardingStepPage } from "./index";

/** The first-run screen's other states, as `onboarding-first-bot-<variant>` fixtures. */
export const FIRST_RUN_GALLERY_VARIANTS = [
  "chat-app",
  "reading",
  "drafts",
  "empty",
  "stopped",
] as const;
type FirstRunVariant = (typeof FIRST_RUN_GALLERY_VARIANTS)[number];
const INBOX: Record<Exclude<FirstRunVariant, "chat-app">, InboxPass> = {
  reading: { state: "reading" },
  drafts: { state: "done", drafts: 4 },
  empty: { state: "done", drafts: 0 },
  stopped: { state: "stopped" },
};

export const OnboardingGallery = ({
  step,
  variant,
}: {
  step: OnboardingStepId;
  variant?: FirstRunVariant;
}) => {
  const router = useRouter();
  const { transport } = router.options.context;
  const db = useDb();
  const bot = db.collections.bots.toArray[0];
  const inbox =
    variant != null && variant !== "chat-app" ? INBOX[variant] : undefined;
  // The first-run screen shows a bot only for the inbox pass.
  const previewBot =
    bot && (step !== "first-bot" || inbox != null)
      ? { bot, checkInRoutineId: "fixture-weekday-check-in" }
      : undefined;
  return (
    <OnboardingFrame step={step} previewBot={previewBot}>
      <OnboardingStepPage
        step={step}
        transport={transport}
        facts={{
          signedIn: step !== "welcome" && step !== "connect",
          payingTier: false,
          ownsBot: false,
          ownProvider: false,
        }}
        preview={true}
        previewBot={previewBot}
        previewFirstRun={
          step === "first-bot"
            ? {
                ...(inbox != null ? { inbox } : {}),
                ...(variant === "chat-app" ? { chatApp: "whatsapp" } : {}),
              }
            : undefined
        }
        navigate={async () => {}}
        signIn={() => {}}
        cancelSignIn={async () => {}}
        complete={async () => {}}
        createFirstBot={async () => {
          throw new Error("Gallery does not create bots");
        }}
        choose={async () => {}}
      />
    </OnboardingFrame>
  );
};
