import { useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { isPayingAbacusTier } from "#shared/models";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { useAbacusCredentialQuery } from "../../hooks/use-abacus-credential";
import { signInToAbacus } from "../../lib/abacus-sign-in";
import { cn } from "../../lib/cn";
import { durableStorage } from "../../lib/durable-storage";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { useAccountStore } from "../../stores/account-store";
import { useWorkspaceStore } from "../../stores/code-store";
import { useTourStore } from "../../stores/tour-store";
import { WindowDragRegion } from "../layout/window-drag-region";
import { ConnectorsStep } from "./connectors-step";
import {
  isOnboardingStep,
  nextStep,
  previousStep,
  settleStep,
  stepProgress,
  stepsFor,
  type OnboardingStep,
} from "./onboarding-steps";
import { ProviderSetupStep } from "./provider-setup-step";
import { SignInStep } from "./sign-in-step";
import { WelcomeStep } from "./welcome-step";
import { WelcomeTour } from "./welcome-tour";

/**
 * First run. The route (onboarding-steps) says which screens exist; this
 * component holds the current one, settles it when the facts behind the route
 * change, and draws the shell around each step. The explainer is the last
 * step and spotlights the live window, so the overlay stands down for it.
 */

/**
 * The step outlives the renderer (an experience swap or crash recovery
 * reloads it mid-flow, often while the user is off scanning a QR code).
 */
const STEP_STORAGE_KEY = "onboarding.step";

const readStoredStep = (): OnboardingStep | null => {
  try {
    const value = durableStorage.getItem(STEP_STORAGE_KEY);
    return isOnboardingStep(value) ? value : null;
  } catch {
    return null;
  }
};

const writeStoredStep = (step: OnboardingStep | null): void => {
  try {
    if (step == null) durableStorage.removeItem(STEP_STORAGE_KEY);
    else durableStorage.setItem(STEP_STORAGE_KEY, step);
  } catch {
    // The current renderer still advances without storage.
  }
};

/** Card width per step; the model list needs room or it grows a scrollbar. */
const CARD_WIDTH: Record<Exclude<OnboardingStep, "explainer">, string> = {
  auth: "max-w-2xl",
  welcome: "max-w-xl",
  connectors: "max-w-3xl",
  models: "max-w-2xl",
};

/** Progress dots. Decorative, so kept out of the accessibility tree. */
const StepDots = ({
  index,
  total,
}: {
  index: number;
  total: number;
}): React.ReactElement => (
  <div className="flex items-center gap-1.5" aria-hidden>
    {Array.from({ length: total }, (_, position) => (
      <span
        key={position}
        className={cn(
          "h-1 rounded-full transition-all duration-300",
          position === index
            ? "bg-primary w-5"
            : "bg-muted-foreground/30 w-1.5",
          position < index && "bg-primary/40"
        )}
      />
    ))}
  </div>
);

export const OnboardingFlow = (): React.ReactElement | null => {
  const queryClient = useQueryClient();
  const apply = useAccountStore((state) => state.apply);
  const onboarded = useAccountStore((state) => state.onboarded);
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId
  );
  const activateWorkspaceSession = useWorkspaceStore(
    (state) => state.activateWorkspaceSession
  );
  const credential = useAbacusCredentialQuery();
  const { data: abacusAccount } = useAbacusAccountQuery();

  const [step, setStepState] = useState<OnboardingStep>(
    () => readStoredStep() ?? "auth"
  );
  const setStep = useCallback((next: OnboardingStep): void => {
    writeStoredStep(next);
    setStepState(next);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishing = useRef(false);

  // The stored key answers "signed in"; a slow or empty model catalog would
  // read as signed out and bounce the user back onto the wall. Until the read
  // lands, the route is drawn as signed out and nothing moves.
  const signedIn = credential.isPending ? null : credential.data === true;
  const steps = stepsFor({
    signedIn: signedIn === true,
    paying: isPayingAbacusTier(abacusAccount?.subscription_tier),
    onboarded,
  });

  // Onboarding owns the tour; a replay still up from before would fight it.
  useEffect(() => {
    useTourStore.getState().reset();
  }, []);

  /**
   * Leave for the app, recorded so the flow does not reappear, on an empty
   * composer in whichever workspace is active. No folder is adopted on the
   * user's behalf: the composer asks.
   */
  const finish = useCallback(async (): Promise<void> => {
    if (finishing.current) return;
    finishing.current = true;
    setBusy(true);
    writeStoredStep(null);
    if (activeWorkspaceId != null) {
      activateWorkspaceSession(activeWorkspaceId, null);
      void window.api.agent.switchWorkspace(activeWorkspaceId);
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.metadata,
      });
    }
    apply(await window.api.skipAccountOnboarding());
  }, [activateWorkspaceSession, activeWorkspaceId, apply, queryClient]);

  // The route changed under the current screen: keep it, move on, or leave.
  const settled = signedIn == null ? step : settleStep(steps, step);
  useEffect(() => {
    if (settled == null) void finish();
    else if (settled !== step) setStep(settled);
  }, [settled, step, finish, setStep]);

  // Entering the explainer: the app must render underneath for the spotlight
  // to have a window, and app.tsx reads this to know that.
  useEffect(() => {
    if (step === "explainer") useTourStore.getState().open();
  }, [step]);

  const advance = (): void => {
    const next = nextStep(steps, step);
    if (next == null) void finish();
    else setStep(next);
  };

  const back = (): void => {
    const previous = previousStep(steps, step);
    if (previous != null) setStep(previous);
  };

  /** Sign in; the settle effect moves off the wall once the facts change. */
  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await signInToAbacus();
      if (result.ok !== true) {
        // A cancelled sign-in is a decision, not an error.
        if (result.cancelled !== true) setError(result.error);
        return;
      }
      // The hop stored the key, so a credential read still in flight would
      // answer for a moment before it existed; drop that read.
      await queryClient.cancelQueries({
        queryKey: settingsQueryKeys.models.abacusCredential,
      });
      queryClient.setQueryData(settingsQueryKeys.models.abacusCredential, true);
      // The catalog changes with the credential, and the tier decides whether
      // the models screen is in the route at all.
      await window.api.agent.listModels(true);
      queryClient.setQueryData(
        workspaceQueryKeys.abacusAccount,
        await window.api.agent.getAbacusAccount(true)
      );
    } finally {
      setBusy(false);
    }
  };

  if (step === "explainer") return <WelcomeTour onFinish={advance} />;

  const dots = <StepDots {...stepProgress(steps, step)} />;

  return (
    <div
      className="bg-background absolute inset-0 z-50 flex overflow-y-auto px-6 pt-[max(3rem,var(--workspace-topbar-height))] pb-12"
      data-id="onboarding-overlay"
    >
      <WindowDragRegion />
      <div
        className={cn(
          "bg-card/85 border-border m-auto w-full rounded-2xl border p-8 shadow-2xl backdrop-blur-xl",
          CARD_WIDTH[step]
        )}
      >
        {step === "auth" && (
          <SignInStep
            busy={busy}
            error={error}
            onConnect={() => void connect()}
            onCancel={() => void window.api.agent.cancelAbacusAuth()}
            dots={dots}
          />
        )}
        {step === "welcome" && <WelcomeStep onNext={advance} dots={dots} />}
        {step === "connectors" && (
          <ConnectorsStep dots={dots} onBack={back} onNext={advance} />
        )}
        {step === "models" && (
          <ProviderSetupStep dots={dots} onBack={back} onDone={advance} />
        )}
      </div>
    </div>
  );
};
