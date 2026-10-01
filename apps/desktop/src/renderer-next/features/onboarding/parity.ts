/** Spec 06 §2 parity locations. Acceptance evidence is in reports/06-implementation.md. */
export const PHASE6_ONBOARDING_PARITY = [
  {
    id: "OB1",
    status: "Changed (PLAN route tree)",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "OB2",
    status: "Changed (F9)",
    consumer: "src/renderer-next/routes/_shell.tsx#Route",
    owner: "phase-6",
  },
  {
    id: "OB3",
    status: 'Changed (F9; canvas "Skip for now", 05 `SettingsSignedOut`)',
    consumer: "src/renderer-next/routes/_shell.tsx#Route",
    owner: "phase-6",
  },
  {
    id: "OB4",
    status: "Changed (canvas order) + Parity (paying-tier skip)",
    consumer: "src/renderer-next/features/onboarding/machine.ts#next",
    owner: "phase-6",
  },
  {
    id: "OB5",
    status: "Parity",
    consumer: "src/renderer-next/features/onboarding/machine.ts#resumeStep",
    owner: "phase-6",
  },
  {
    id: "OB6",
    status: "Parity (canvas look)",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "OB7",
    status: "Parity + Changed (canvas split into two steps; Skip added, F9)",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "OB8",
    status: "Parity",
    consumer: "src/renderer-next/features/onboarding/store.ts#onboardingStore",
    owner: "phase-6",
  },
  {
    id: "OB9",
    status: "Parity",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "OB10",
    status: "Parity",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "OB11",
    status: "Parity + New (local model row)",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "OB12",
    status:
      "Parity (every old tile reachable) + Changed (pairing deferred to Library, 05 F7)",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "OB13",
    status: 'Parity; workspace switch Retired (PLAN "no state in two places")',
    consumer:
      "src/renderer-next/features/onboarding/actions.ts#completeOnboarding",
    owner: "phase-6",
  },
  {
    id: "OB14",
    status: "Parity",
    consumer: "src/renderer-next/features/onboarding/actions.ts#enterStep",
    owner: "phase-6",
  },
  {
    id: "OB15",
    status: "Changed (05 ST9)",
    consumer:
      "src/renderer-next/features/settings/account-usage.tsx#AccountPage",
    owner: "other-phase",
  },
  {
    id: "OB16",
    status: "Retired (structure)",
    consumer:
      "retired: The tour host lives only under the shell, so onboarding no longer resets an open tour.",
    owner: "phase-6",
  },
  {
    id: "OB17",
    status: "New",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "FB1",
    status: "Parity (placement changed: a step, not a popup)",
    consumer:
      "src/renderer-next/features/onboarding/first-bot.ts#firstBotStore",
    owner: "phase-6",
  },
  {
    id: "FB2",
    status: "Parity",
    consumer:
      "src/renderer-next/features/onboarding/first-bot.ts#firstBotStore",
    owner: "phase-6",
  },
  {
    id: "FB3",
    status: "Parity (canvas copy) + Changed (check-in, canvas board)",
    consumer:
      "src/renderer-next/features/onboarding/first-bot.ts#firstBotStore",
    owner: "phase-6",
  },
  {
    id: "FB4",
    status: "Parity + New (tour entry)",
    consumer:
      "src/renderer-next/features/onboarding/first-bot.ts#firstBotStore",
    owner: "phase-6",
  },
  {
    id: "FB5",
    status: "New (F14)",
    consumer: "src/renderer-next/features/onboarding/hatch.tsx#FirstBotHatch",
    owner: "phase-6",
  },
  {
    id: "FB6",
    status: "New",
    consumer: "src/renderer-next/features/onboarding/index.tsx#OnboardingFrame",
    owner: "phase-6",
  },
  {
    id: "FB7",
    status: "Parity (other phases)",
    consumer: "src/renderer-next/features/bots/chat/slots.tsx#useBotChatSlots",
    owner: "other-phase",
  },
  {
    id: "TR1",
    status: 'Changed (PLAN "react-tourlight nuked"; canvas stops)',
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
  {
    id: "TR2",
    status: "Parity (copy)",
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
  {
    id: "TR3",
    status: "Changed (new shell)",
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
  {
    id: "TR4",
    status: "Parity",
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
  {
    id: "TR5",
    status: "Parity",
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
  {
    id: "TR6",
    status: "Parity + New (persisted completion)",
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
  {
    id: "TR7",
    status: "Changed (05 ST22 \u2192 here)",
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
  {
    id: "TR8",
    status: "Parity",
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
  {
    id: "TR9",
    status: "New",
    consumer: "src/renderer-next/features/tour/index.tsx#TourHost",
    owner: "phase-6",
  },
] as const;
