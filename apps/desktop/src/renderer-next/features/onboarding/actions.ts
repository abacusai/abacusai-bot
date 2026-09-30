import type { QueryClient } from "@tanstack/react-query";

import type { Db } from "#next/data/db";
import type { Transport } from "#next/data/transport";
import type { OnboardingStepId } from "#next/lib/navigation/areas";
import type { PrefsRow } from "#shared/contract";
import type { FunnelStep } from "#shared/funnel";
export const accountStateQuery = (transport: Transport) =>
  transport.orpc.account.state.queryOptions({ input: {}, staleTime: Infinity });
export const FUNNEL_BY_STEP: Partial<Record<OnboardingStepId, FunnelStep>> = {
  welcome: "screen_auth",
  connected: "screen_welcome",
  models: "screen_models",
  connectors: "screen_connectors",
  "first-bot": "first_bot_shown",
};
export const enterStep = async (
  db: Db,
  transport: Transport,
  step: OnboardingStepId
): Promise<void> => {
  await db.updatePrefs({ onboardingStep: step, onboardingFlow: 2 });
  const name = FUNNEL_BY_STEP[step];
  if (name) await transport.client.system.funnelStep({ step: name });
};
export type OnboardingExit = NonNullable<PrefsRow["onboardingExit"]>;
export interface CompletionDeps {
  db: Db;
  transport: Transport;
  queryClient: QueryClient;
  /** Resolves only once the destination has committed. */
  navigate(exit: OnboardingExit): Promise<void>;
  startTour(): void;
}
export const finishCompletion = async (
  deps: CompletionDeps,
  exit: OnboardingExit
): Promise<void> => {
  await deps.transport.client.system.funnelStep({
    step: "onboarding_done",
    once: true,
  });
  try {
    await deps.db.updatePrefs({ onboardingStep: null });
  } catch (error) {
    console.warn("[onboarding] step cleanup deferred", error);
  }
  await deps.navigate(exit);
  if (exit.to === "bot-tour") deps.startTour();
  await deps.db.updatePrefs({ onboardingExit: null });
};
export const completeOnboarding = async (
  deps: CompletionDeps,
  exit: OnboardingExit
): Promise<void> => {
  await deps.db.updatePrefs({ onboardingExit: exit });
  const account = await deps.transport.client.account.skipOnboarding({});
  deps.queryClient.setQueryData(
    accountStateQuery(deps.transport).queryKey,
    account
  );
  await finishCompletion(deps, exit);
};
