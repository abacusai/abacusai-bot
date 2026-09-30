import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";

import type { AbacusAuthIntent } from "#shared/contracts";
import { isPayingAbacusTier } from "#shared/models";

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
/** Once per install: a sign-in the user closed is not started on them again. */
const AUTO_SIGN_IN_KEY = "onboarding.autoSignIn";
const GMAIL_CONNECTOR_ID = "abacus-gmailuser";
/** Once per install: the Gmail hop is started on the account's behalf a single time. */
const GMAIL_HOP_KEY = "onboarding.gmailHop";

const CARD_WIDTH: Record<Exclude<OnboardingStep, "explainer">, string> = {
  auth: "max-w-lg",
  welcome: "max-w-2xl",
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
  const accountQuery = useAbacusAccountQuery();
  const abacusAccount = accountQuery.data;
  const connectorStatuses = useConnectorStatuses();
  const email = abacusAccount?.email ?? "";

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
  // Signing in flips the credential first; the account and the connector
  // statuses follow a moment later, and the Gmail hop below needs both. The
  // screen holds until they are in, so a web signup's flow does not end
  // before the hop has an address to start with.
  const factsPending =
    signedIn === true &&
    !onboarded &&
    (accountQuery.isFetching ||
      connectorStatuses.fetching ||
      !connectorStatuses.loaded);
  const routePending = signedIn == null || factsPending;
  const settled = routePending ? step : settleStep(steps, step);
  useEffect(() => {
    if (settled == null) void finish();
    else if (settled !== step) setStep(settled);
  }, [settled, step, finish, setStep]);

  // Gmail is connected for the account right after sign-in, unasked: the
  // browser opens on Google's consent for that very address while the flow
  // moves on. Once per install, whatever the browser answers; the connectors
  // screen keeps the tile for anyone who closed the consent.
  const gmailWanted =
    signedIn === true &&
    !onboarded &&
    !factsPending &&
    email.length > 0 &&
    !isConnected(connectorStatuses.statuses, GMAIL_CONNECTOR_ID);
  const gmailStarted = useRef(durableStorage.getItem(GMAIL_HOP_KEY) != null);
  useEffect(() => {
    if (!gmailWanted || gmailStarted.current) return;
    gmailStarted.current = true;
    durableStorage.setItem(GMAIL_HOP_KEY, "started");
    void window.api.agent
      .connectConnector(GMAIL_CONNECTOR_ID, { autostart: true, hint: email })
      .then((outcome) => {
        window.api.reportFunnelStep(
          outcome.ok ? "gmail_allowed" : "gmail_declined"
        );
      });
  }, [gmailWanted, email]);

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

  // An account made on the website minutes ago has its session waiting in
  // the browser: go there unasked, and the wall is only ever seen in passing.
  const autoSignIn = useQuery({
    queryKey: ["onboarding", "auto-sign-in"],
    queryFn: () => window.api.agent.shouldAutoSignIn(),
    enabled:
      step === "auth" &&
      signedIn === false &&
      !onboarded &&
      durableStorage.getItem(AUTO_SIGN_IN_KEY) == null,
    staleTime: Infinity,
  });
  // The stored key is the one guard. The answer stays cached across the
  // flow's remounts (a sign-out brings the wall back), so a ref would reset
  // and sign the user straight back in.
  useEffect(() => {
    if (autoSignIn.data !== true) return;
    if (step !== "auth" || signedIn !== false || onboarded) return;
    if (durableStorage.getItem(AUTO_SIGN_IN_KEY) != null) return;
    durableStorage.setItem(AUTO_SIGN_IN_KEY, "started");
    window.api.reportFunnelStep("auto_signin");
    void connect("signin");
    // `connect` is rebuilt every render; the effect is about the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSignIn.data, step, signedIn, onboarded]);

  if (step === "explainer") return <WelcomeTour onFinish={advance} />;

  const dots = <StepDots {...stepProgress(steps, step)} />;

  return (
    <div
      className="bg-background absolute inset-0 z-50 flex overflow-y-auto px-6 pt-[max(3rem,var(--workspace-topbar-height))] pb-12"
      data-id="onboarding-overlay"
    >
      <WindowDragRegion />
      {/* Each screen is the window, not a card in it: content sits on the
          app's own backdrop, centred, at a width that reads well. */}
      <div className={cn("m-auto w-full", CARD_WIDTH[step])}>
        {step === "auth" && (
          <SignInStep
            busy={busy || factsPending}
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
