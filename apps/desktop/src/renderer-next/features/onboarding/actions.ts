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
const tails = new WeakMap<Db, Map<string, Promise<void>>>();
export const finishCompletion = (
  deps: CompletionDeps,
  exit: OnboardingExit
): Promise<void> => {
  let runs = tails.get(deps.db);
  if (!runs) {
    runs = new Map();
    tails.set(deps.db, runs);
  }
  const key = JSON.stringify(exit);
  const existing = runs.get(key);
  if (existing) return existing;
  let completed = false;
  const work = (async () => {
    await deps.transport.client.system.funnelStep({
      step: "onboarding_done",
      once: true,
    });
    let cleaned = true;
    try {
      await deps.db.updatePrefs({ onboardingStep: null });
    } catch (error) {
      cleaned = false;
      console.warn("[onboarding] step cleanup deferred", error);
    }
    await deps.navigate(exit);
    if (exit.to === "bot-tour") deps.startTour();
    if (cleaned) {
      await deps.db.updatePrefs({ onboardingExit: null });
      completed = true;
    }
  })();
  runs.set(key, work);
  void work.then(
    () => {
      if (!completed) runs.delete(key);
    },
    () => runs.delete(key)
  );
  return work;
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
