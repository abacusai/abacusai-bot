import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from "#renderer/lib/navigation/areas";
import type { AccountState } from "#shared/account";
import type { PrefsRow } from "#shared/contract";
export const ONBOARDING_FLOW = ONBOARDING_STEPS;
export interface FlowFacts {
  signedIn: boolean;
  payingTier: boolean;
  ownsBot: boolean;
}
export type FlowEvent =
  | { type: "sign-up" | "sign-in" | "retry"; attempt: string }
  | { type: "auth-ok" | "auth-cancelled" | "auth-failed"; attempt: string }
  | { type: "skip" | "back" | "next" | "tour" };
export const next = (
  step: OnboardingStepId,
  event: FlowEvent,
  facts: FlowFacts,
  live: string | null
): OnboardingStepId | "complete" | "ignore" => {
  if (
    event.type.startsWith("auth-") &&
    "attempt" in event &&
    event.attempt !== live
  )
    return "ignore";
  switch (step) {
    case "welcome":
      return event.type === "sign-up" || event.type === "sign-in"
        ? "connect"
        : event.type === "skip"
          ? "models"
          : "ignore";
    case "connect":
      if (event.type === "auth-ok") return "connected";
      if (event.type === "auth-cancelled" || event.type === "back")
        return "welcome";
      if (event.type === "auth-failed" || event.type === "retry")
        return "connect";
      return event.type === "skip" ? "models" : "ignore";
    case "connected":
      return event.type === "next"
        ? facts.payingTier
          ? "connectors"
          : "models"
        : "ignore";
    case "models":
      return event.type === "next"
        ? "connectors"
        : event.type === "back"
          ? facts.signedIn
            ? "connected"
            : "welcome"
          : "ignore";
    case "connectors":
      return event.type === "next"
        ? facts.ownsBot
          ? "done"
          : "first-bot"
        : event.type === "back"
          ? facts.payingTier
            ? "connected"
            : "models"
          : "ignore";
    case "first-bot":
      return event.type === "next"
        ? "done"
        : event.type === "tour"
          ? "complete"
          : "ignore";
    case "done":
      return event.type === "next" ? "complete" : "ignore";
  }
};
export const resumeStep = (stored: {
  step: string | null;
  flow: number | null;
}): OnboardingStepId =>
  stored.flow === 2 &&
  stored.step !== "connect" &&
  ONBOARDING_FLOW.includes(stored.step as OnboardingStepId)
    ? (stored.step as OnboardingStepId)
    : "welcome";
export const guardStep = (
  step: OnboardingStepId,
  facts: FlowFacts,
  doc: { signIn: { status: string } | null; createdBotId: string | null }
): OnboardingStepId => {
  if (
    step === "connect" &&
    !["pending", "failed"].includes(doc.signIn?.status ?? "")
  )
    return "welcome";
  if (step === "connected" && !facts.signedIn) return "welcome";
  if (step === "first-bot" && facts.ownsBot && !doc.createdBotId) return "done";
  return step;
};
export const needsOnboarding = (account: AccountState): boolean =>
  !account.onboarded;
export const onboardingTarget = (prefs: PrefsRow) => ({
  to: "/onboarding/$step" as const,
  params: {
    step: resumeStep({
      step: prefs.onboardingStep,
      flow: prefs.onboardingFlow ?? null,
    }),
  },
});
export const connectedProviders = (
  models: readonly { provider?: string }[],
  keys: readonly string[]
): ReadonlySet<string> =>
  new Set([
    ...keys,
    ...models.flatMap((model) => (model.provider ? [model.provider] : [])),
  ]);
