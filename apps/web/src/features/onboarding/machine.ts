import type { AccountState } from "@abacus-ai/contract/account";
import type { PrefsRow } from "@abacus-ai/contract/contract";

import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from "#renderer/lib/navigation/areas";
import { IS_ELECTRON } from "#renderer/lib/platform";
export const ONBOARDING_FLOW = ONBOARDING_STEPS;
export interface FlowFacts {
  signedIn: boolean;
  payingTier: boolean;
  ownsBot: boolean;
  webSignup?: boolean;
  email?: string;
  /** Browser: AbacusAI Bot's WhatsApp number is offered and not linked yet. */
  whatsappOffered?: boolean;
  /** Not from the host yet (spec 09 D12): render, but act on nothing. */
  provisional?: boolean;
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
        : "ignore";
    case "connect":
      if (event.type === "auth-ok")
        return !IS_ELECTRON && facts.whatsappOffered ? "whatsapp" : "connected";
      if (event.type === "auth-cancelled" || event.type === "back")
        return "welcome";
      if (event.type === "auth-failed" || event.type === "retry")
        return "connect";
      return "ignore";
    case "connected":
      return event.type === "next"
        ? facts.payingTier || !IS_ELECTRON
          ? "connectors"
          : "models"
        : "ignore";
    case "whatsapp":
      // A website signup finishes on `connected`, as without this step.
      return event.type === "next" || event.type === "skip"
        ? facts.webSignup
          ? "connected"
          : "connectors"
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
          ? !IS_ELECTRON && facts.whatsappOffered
            ? "whatsapp"
            : facts.payingTier || !IS_ELECTRON
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
  if (!IS_ELECTRON && step === "models") return "connectors";
  if (
    step === "connect" &&
    !["pending", "failed"].includes(doc.signIn?.status ?? "")
  )
    return "welcome";
  if (!facts.signedIn && step !== "welcome" && step !== "connect")
    return "welcome";
  if (step === "whatsapp" && (IS_ELECTRON || !facts.whatsappOffered))
    return "connected";
  if (step === "first-bot" && facts.ownsBot && !doc.createdBotId) return "done";
  return step;
};
export const needsOnboarding = (
  account: AccountState,
  signedIn = true
): boolean => !account.onboarded || !signedIn;
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
