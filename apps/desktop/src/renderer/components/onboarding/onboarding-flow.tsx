import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";

import type { AbacusAuthIntent } from "#shared/contracts";
import { isPayingAbacusTier } from "#shared/models";

import { CONNECTORS } from "../../connectors";
import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { useAbacusCredentialQuery } from "../../hooks/use-abacus-credential";
import {
  isConnected,
  useConnectorStatuses,
} from "../../hooks/use-connector-statuses";
import { signInToAbacus } from "../../lib/abacus-sign-in";
import { cn } from "../../lib/cn";
import { durableStorage } from "../../lib/durable-storage";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { useAccountStore } from "../../stores/account-store";
import { useWorkspaceStore } from "../../stores/code-store";
import { useTourStore } from "../../stores/tour-store";
import { useConnectFlow } from "../connectors/connect-flow";
import { WindowDragRegion } from "../layout/window-drag-region";
import { ConnectorsStep } from "./connectors-step";
import { GmailPermissionStep } from "./gmail-permission-step";
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
const GMAIL_CONNECTOR_ID = "abacus-gmailuser";
const GMAIL_OFFER_KEY = "onboarding.gmailOffer";
/** Google-hosted consumer addresses; a Workspace domain cannot be told from the address alone. */
const isGoogleHostedEmail = (email: string): boolean =>
  /@(gmail|googlemail)\.com$/i.test(email.trim());

const CARD_WIDTH: Record<Exclude<OnboardingStep, "explainer">, string> = {
  auth: "max-w-2xl",
  gmail: "max-w-2xl",
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
  const connectorStatuses = useConnectorStatuses();
  const connectFlow = useConnectFlow();
  // "Not now" is an answer: the connectors screen keeps the Gmail tile, this card does not come back.
  const [gmailDeclined, setGmailDeclined] = useState(
    () => durableStorage.getItem(GMAIL_OFFER_KEY) === "declined"
  );
  const email = abacusAccount?.email ?? "";
  const gmailConnector =
    CONNECTORS.find((connector) => connector.id === GMAIL_CONNECTOR_ID) ?? null;
  const offerGmail =
    gmailConnector != null &&
    !gmailDeclined &&
    isGoogleHostedEmail(email) &&
    connectorStatuses.loaded &&
    !isConnected(connectorStatuses.statuses, GMAIL_CONNECTOR_ID);

  const webSignup = abacusAccount?.web_signup === true;

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

  // Each screen as it comes up, once the key read has settled which it is.
  useEffect(() => {
    if (signedIn != null) window.api.reportFunnelStep(`screen_${step}`);
  }, [step, signedIn]);
  const steps = stepsFor({
    signedIn: signedIn === true,
    paying: isPayingAbacusTier(abacusAccount?.subscription_tier),
    onboarded,
    offerGmail,
    webSignup,
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
    window.api.reportFunnelStep("onboarding_done");
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
  // A web signup's route is the Gmail question or nothing, which only the
  // connector statuses can tell apart: hold the screen until they are in.
  const routePending =
    signedIn == null ||
    (signedIn && webSignup && !onboarded && !connectorStatuses.loaded);
  const settled = routePending ? step : settleStep(steps, step);
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
  const connect = async (
    intent: AbacusAuthIntent,
    browserProfileId?: string
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await signInToAbacus(intent, browserProfileId);
      if (result.ok !== true) {
        // A cancelled sign-in is a decision, not an error.
        if (result.cancelled !== true) setError(result.error);
        return;
      }
      // The account first: it decides the route, and a credential flipped
      // ahead of it would draw a screen the account then takes away.
      queryClient.setQueryData(
        workspaceQueryKeys.abacusAccount,
        await window.api.agent.getAbacusAccount(true)
      );
      // The hop stored the key, so a credential read still in flight would
      // answer for a moment before it existed; drop that read.
      await queryClient.cancelQueries({
        queryKey: settingsQueryKeys.models.abacusCredential,
      });
      queryClient.setQueryData(settingsQueryKeys.models.abacusCredential, true);
      // The catalog changes with the credential.
      await window.api.agent.listModels(true);
    } finally {
      setBusy(false);
    }
  };

  // Chromium profiles holding an Abacus.AI session, offered on the wall. Main
  // answers empty outside the in-app arm; a slow answer only adds buttons.
  const browserProfiles = useQuery({
    queryKey: ["onboarding", "browser-sign-in-profiles"],
    queryFn: () => window.api.agent.listBrowserSignInProfiles(),
    enabled: step === "auth",
    staleTime: Infinity,
  });

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
            onConnect={(intent) => void connect(intent)}
            browserProfiles={browserProfiles.data ?? []}
            onContinueWith={(profileId) => void connect("signin", profileId)}
            onCancel={() => void window.api.agent.cancelAbacusAuth()}
            onOpenInBrowser={() =>
              void window.api.agent.openAbacusAuthInBrowser()
            }
            dots={dots}
          />
        )}
        {step === "gmail" && gmailConnector != null && (
          <>
            {connectFlow.dialogs}
            <GmailPermissionStep
              email={email}
              dots={dots}
              onAllow={() =>
                connectFlow.start(gmailConnector, {
                  autostart: true,
                  hint: email,
                })
              }
              onDone={(outcome) => {
                if (outcome === "declined") {
                  window.api.reportFunnelStep("gmail_declined");
                  durableStorage.setItem(GMAIL_OFFER_KEY, "declined");
                  setGmailDeclined(true);
                } else {
                  window.api.reportFunnelStep("gmail_allowed");
                  void connectorStatuses.refresh();
                }
                advance();
              }}
            />
          </>
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
