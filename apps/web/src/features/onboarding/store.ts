import type { AbacusAuthOutcome } from "@abacus-ai/contract/contracts";
import { Store } from "@tanstack/react-store";

import { webSignIn } from "#platform/sign-in";
import type { Transport } from "#renderer/data/transport";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { SignInFailure } from "#renderer/lib/sign-in-failure";
export interface SignInAttempt {
  id: string;
  intent: "signup" | "signin";
  profileId?: string;
  status: "pending" | "failed" | "cancelled" | "succeeded";
  outcome: AbacusAuthOutcome | null;
}
export const onboardingStore = new Store<{
  signIn: SignInAttempt | null;
  createdBotId: string | null;
}>({ signIn: null, createdBotId: null });
export const startSignIn = (
  transport: Transport,
  intent: "signup" | "signin",
  profileId: string | undefined,
  settled: (outcome: AbacusAuthOutcome) => void
): boolean => {
  if (onboardingStore.state.signIn?.status === "pending") return false;
  const attempt: SignInAttempt = {
    id: crypto.randomUUID(),
    intent,
    ...(profileId ? { profileId } : {}),
    status: "pending",
    outcome: null,
  };
  onboardingStore.setState((state) => ({ ...state, signIn: attempt }));
  void (
    IS_ELECTRON
      ? transport.client.auth.abacus.start({
          intent,
          ...(profileId ? { browserProfileId: profileId } : {}),
        })
      : webSignIn(transport)
  )
    .catch((error: unknown): AbacusAuthOutcome => ({
      ok: false,
      error: error instanceof SignInFailure ? error.message : "auth-failed",
    }))
    .then((outcome) => {
      if (onboardingStore.state.signIn?.id !== attempt.id) return;
      onboardingStore.setState((state) => ({
        ...state,
        signIn: {
          ...attempt,
          status: outcome.ok
            ? "succeeded"
            : outcome.cancelled
              ? "cancelled"
              : "failed",
          outcome,
        },
      }));
      settled(outcome);
    });
  return true;
};
export const cancelSignIn = async (transport: Transport): Promise<void> => {
  onboardingStore.setState((state) => ({ ...state, signIn: null }));
  if (IS_ELECTRON) await transport.client.auth.abacus.cancel({});
};
