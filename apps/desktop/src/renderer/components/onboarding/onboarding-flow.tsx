import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Award,
  Brain,
  Gift,
  Link2,
  Monitor,
  Puzzle,
  Sparkles,
  UserRound,
} from "lucide-react";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isPayingAbacusTier } from "#shared/models";
import type { ModelAvailability } from "#shared/models";
import { canSignOutOfAbacus } from "#shared/settings";

import logo from "../../assets/icon2.png";
import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { signInToAbacus } from "../../lib/abacus-sign-in";
import { cn } from "../../lib/cn";
import { durableStorage } from "../../lib/durable-storage";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { useAccountStore } from "../../stores/account-store";
import { useWorkspaceStore } from "../../stores/code-store";
import { useTourStore } from "../../stores/tour-store";
import { WindowDragRegion } from "../layout/window-drag-region";
import { Button, Spinner } from "../ui";
import { ConnectorsStep } from "./connectors-step";
import {
  nextStep,
  previousStep,
  stepProgress,
  stepsFor,
  type OnboardingStep,
} from "./onboarding-steps";
import { ProviderSetupStep } from "./provider-setup-step";
import { WelcomeTour } from "./welcome-tour";

/** The three things worth knowing before signing up, as headlines. */
/**
 * What the account just bought, said once after it is created. Two i18n keys
 * per row (bold lead, quieter remainder) so a translator can move the emphasis.
 */
const promises = [
  { key: "Agent", icon: Award },
  { key: "Models", icon: Gift },
  { key: "Work", icon: Link2 },
  { key: "Local", icon: Monitor },
] as const;

const capabilities = [
  { key: "Memory", icon: Brain },
  { key: "Connectors", icon: Puzzle },
  { key: "Models", icon: Sparkles },
] as const;

/**
 * First run: sign in, look around, then get the app able to work; the route
 * decides what to leave out (onboarding-steps). The sign-in is a wall with no
 * skip (app.tsx gates the overlay on the credential); every later step can be
 * stepped past. The explainer spotlights the real window; the overlay yields.
 */

/**
 * Where the user is in the flow, kept where a renderer restart (experience
 * swap, crash recovery) cannot drop them back onto the welcome screen. Cleared
 * when the flow ends so a rerun starts at the top.
 */
const STEP_STORAGE_KEY = "onboarding.step";

const STEP_NAMES: readonly OnboardingStep[] = [
  "auth",
  "welcome",
  "explainer",
  "connectors",
  "models",
];

const storedStep = (): OnboardingStep | null => {
  try {
    const value = durableStorage.getItem(STEP_STORAGE_KEY);
    return STEP_NAMES.includes(value as OnboardingStep)
      ? (value as OnboardingStep)
      : null;
  } catch {
    return null;
  }
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const apply = useAccountStore((state) => state.apply);
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId
  );
  const activateWorkspaceSession = useWorkspaceStore(
    (state) => state.activateWorkspaceSession
  );
  const [step, setStepState] = useState<OnboardingStep>(
    () => storedStep() ?? "auth"
  );
  const setStep = (next: OnboardingStep): void => {
    try {
      durableStorage.setItem(STEP_STORAGE_KEY, next);
    } catch {
      // The current renderer still advances even if storage is unavailable.
    }
    setStepState(next);
  };

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** What the route is made of: an Abacus credential at all, and a paid one. */
  /** Prime the model catalog's cache; the credential answers "signed in". */
  const readCatalog = async (fresh = false): Promise<ModelAvailability[]> =>
    window.api.agent.listModels(fresh);

  useEffect(() => {
    void readCatalog();
    // Onboarding gets a Tourlight instance of its own, or a replay still up
    // when the flow restarts keeps running under the overlay.
    useTourStore.getState().reset();
  }, []);

  /**
   * Is there an Abacus.AI credential? The stored key, not the model catalog: a
   * slow, failed or empty catalog read would read as "not signed in" and bounce
   * the user back onto the wall. The same query backs app.tsx's gate and the
   * sign-out row, so all three flip on the same fact at the same moment.
   */
  const credentialQuery = useQuery({
    queryKey: settingsQueryKeys.models.abacusCredential,
    queryFn: async () =>
      canSignOutOfAbacus(await window.api.agent.getSettings()),
    staleTime: 60_000,
  });
  /**
   * A hop that succeeded is the last word: the credential query starts before
   * the key exists, and its stale `false` can land after the hop stored one.
   */
  const [signedInHere, setSignedInHere] = useState(false);
  const signedIn = signedInHere
    ? true
    : credentialQuery.isPending
      ? undefined
      : credentialQuery.data === true;
  // The app is hidden while onboarding is owed, so being on this step is what
  // tells app.tsx to render the window the spotlight will look for. Keyed on
  // the step, not set by whoever advanced to it.
  useEffect(() => {
    if (step === "explainer") useTourStore.getState().open();
  }, [step]);

  // A run that already holds a credential has no sign-in screen in its route,
  // and the flow must not open on a wall with no skip.
  useEffect(() => {
    if (signedIn === true && step === "auth") setStep("welcome");
  }, [signedIn, step]);

  // Losing the credential mid-flow sends the user back to the first screen:
  // every later screen assumes an account.
  useEffect(() => {
    if (signedIn === false && step !== "auth") setStep("auth");
  }, [signedIn, step]);

  const { data: abacusAccount } = useAbacusAccountQuery();
  const onboarded = useAccountStore((state) => state.onboarded);
  const steps = stepsFor({
    // Until the catalog answers, assume nothing is connected: showing the
    // sign-in and then dropping it reads better than the reverse.
    signedIn: signedIn === true,
    paying: isPayingAbacusTier(abacusAccount?.subscription_tier),
    onboarded,
  });
  const { index, total } = stepProgress(steps, step);
  const dots = <StepDots index={index} total={total} />;

  /**
   * Open a workspace on an empty composer, as soon as the folder step produces
   * one: the explainer spotlights workspace UI that does not exist until the
   * app knows the workspace is there.
   */
  const openWorkspace = (workspaceId: string | null): void => {
    const target = workspaceId ?? activeWorkspaceId;
    if (target == null) return;
    activateWorkspaceSession(target, null);
    void window.api.agent.switchWorkspace(target);
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.metadata,
    });
  };

  /**
   * Leave onboarding for the app, recorded so it does not reappear, into an
   * empty composer. Finishing does not invent a folder to work in: adopting the
   * home directory would be a silent read/write grant over everything the user
   * owns, so the composer asks. Bots keep a default (see botDefaultWorkspace).
   */

  const finish = async (): Promise<void> => {
    setBusy(true);
    try {
      durableStorage.removeItem(STEP_STORAGE_KEY);
    } catch {
      // A stale step only matters if onboarding ever runs again; best-effort.
    }
    // Null: whichever workspace is active, if any. The folder is the user's to
    // choose.
    openWorkspace(null);
    apply(await window.api.skipAccountOnboarding());
  };

  /**
   * On to the next screen, or out of the flow. The workspace is opened on the
   * way into the explainer so it has something to point at.
   */
  const advance = (from: OnboardingStep = step): void => {
    const next = nextStep(steps, from);
    if (next == null) {
      void finish();
      return;
    }
    setStep(next);
  };

  /** Back a screen; the explainer is stepped over rather than restarted. */
  const back = (): void => {
    const previous = previousStep(steps, step);
    const target =
      previous === "explainer" ? previousStep(steps, previous) : previous;
    if (target != null) setStep(target);
  };

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await signInToAbacus();
      if (result.ok === true) {
        // The hop succeeded, so the key is stored: say so rather than let a
        // slow read bounce the user back onto the wall.
        setSignedInHere(true);
        queryClient.setQueryData(
          settingsQueryKeys.models.abacusCredential,
          true
        );
        // The plan decides the rest of the route, so the catalog is re-read
        // before moving on: a subscriber skips the LLM step from here.
        await readCatalog(true);
        const account = await window.api.agent.getAbacusAccount(true);
        queryClient.setQueryData(workspaceQueryKeys.abacusAccount, account);
        const route = stepsFor({
          signedIn: true,
          // The just-fetched account, not the hook: the tier decides whether
          // the models step exists at all, and the hook has not re-rendered yet.
          paying: isPayingAbacusTier(account?.subscription_tier),
          onboarded,
        });
        const after = nextStep(route, "auth");
        // Nothing behind the wall for someone who has done this before: the
        // sign-in was the whole of what they were being asked for.
        if (after == null && onboarded) {
          void finish();
          return;
        }
        // `?? "connectors"`: with no workspace the explainer has nothing to
        // point at yet.
        setStep(after ?? "connectors");
        return;
      }
      // A cancelled sign-in is a decision, not an error.
      if (result.cancelled !== true) setError(result.error);
    } finally {
      setBusy(false);
    }
  };

  // The explainer spotlights the real window, so the overlay stands down and
  // the flow tells app.tsx to render the window it points at. Skipping and
  // finishing both land on the next step.
  if (step === "explainer")
    return <WelcomeTour onFinish={() => advance("explainer")} />;

  return (
    <div
      className="bg-background absolute inset-0 z-50 flex overflow-y-auto px-6 pt-[max(3rem,var(--workspace-topbar-height))] pb-12"
      data-id="onboarding-overlay"
    >
      <WindowDragRegion />
      <div
        className={cn(
          // A card floating on the blurred app; edge-to-edge text reads as a
          // page that failed to load. Sized per step, which keeps a scrollbar
          // out from under the model list.

          "bg-card/85 border-border m-auto w-full rounded-2xl border p-8 shadow-2xl backdrop-blur-xl",
          step === "models"
            ? "max-w-2xl"
            : step === "connectors"
              ? "max-w-3xl"
              : step === "auth"
                ? "max-w-2xl"
                : step === "welcome"
                  ? "max-w-xl"
                  : "max-w-md"
        )}
      >
        {step === "auth" && (
          <div
            className="relative flex flex-col items-center text-center"
            data-id="onboarding-welcome"
          >
            {/* Top-right, out of the way of the mark: the price is the first
                question anyone has, and answering it up here means the pitch
                below does not have to spend a line on it. */}
            <span
              className="absolute top-0 right-0 flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"
              data-id="onboarding-free-badge"
            >
              <Gift className="size-3.5" aria-hidden="true" />
              {t("onboarding.welcomeFreeBadge")}
            </span>

            <img src={logo} alt="" className="size-20 rounded-2xl shadow-sm" />

            <h1 className="text-foreground mt-7 text-5xl font-bold tracking-tight text-balance">
              {t("onboarding.welcomeTitle")}
            </h1>
            <p className="text-secondary-foreground mt-3 text-xl font-medium tracking-tight text-balance">
              {t("onboarding.welcomeTagline")}
            </p>

            {/* Three headlines in a row, divided rather than boxed: this is the
                whole pitch, and cards around each one would make it read as a
                settings page instead. */}
            <div
              className="divide-border/70 mt-9 grid w-full grid-cols-1 gap-6 sm:grid-cols-3 sm:gap-0 sm:divide-x"
              data-id="onboarding-capabilities"
            >
              {capabilities.map(({ key, icon: Icon }) => (
                <div
                  key={key}
                  className="flex flex-col items-center gap-3 px-3"
                  data-id={`onboarding-capability-${key.toLowerCase()}`}
                >
                  <span className="bg-primary/10 dark:bg-primary/20 flex size-12 items-center justify-center rounded-full">
                    <Icon
                      className="text-primary size-5"
                      aria-hidden="true"
                      strokeWidth={1.75}
                    />
                  </span>
                  <span className="text-foreground text-sm font-semibold">
                    {t(`onboarding.welcomeCapability${key}`)}
                  </span>
                </div>
              ))}
            </div>

            {error != null && (
              <div
                className="text-destructive mt-6 text-xs"
                data-id="onboarding-error"
              >
                {error}
              </div>
            )}

            <div className="mt-9 flex w-full flex-col items-center gap-4">
              <Button
                size="lg"
                data-id="onboarding-connect"
                disabled={busy}
                onClick={() => void connect()}
                className="from-primary h-14 w-full bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
              >
                {busy ? (
                  <Spinner fontSize={16} className="text-current" />
                ) : (
                  <UserRound className="size-5" aria-hidden="true" />
                )}
                {busy ? t("apiKeys.connecting") : t("onboarding.connectCta")}
              </Button>
              {/* The hop now waits minutes (account creation takes that long),
                  so a user who changed their mind needs a way out of it. */}
              {busy && (
                <Button
                  variant="link"
                  size="sm"
                  data-id="onboarding-cancel-auth"
                  onClick={() => void window.api.agent.cancelAbacusAuth()}
                  className="text-muted-foreground hover:text-secondary-foreground text-xs"
                >
                  {t("common.cancel")}
                </Button>
              )}
            </div>

            <div className="mt-9">{dots}</div>
          </div>
        )}

        {step === "welcome" && (
          <div
            className="flex flex-col items-center text-center"
            data-id="onboarding-welcome-connected"
          >
            <img src={logo} alt="" className="size-16 rounded-2xl shadow-sm" />

            <h1 className="text-foreground mt-7 text-4xl font-bold tracking-tight text-balance">
              {t("onboarding.connectedTitleLead")}{" "}
              <span className="text-primary">
                {t("onboarding.connectedTitleName")}
              </span>
            </h1>

            <ul className="divide-border/60 mt-8 flex w-full flex-col divide-y text-left">
              {promises.map(({ key, icon: Icon }) => (
                <li
                  key={key}
                  className="flex items-center gap-4 py-4"
                  data-id={`onboarding-promise-${key.toLowerCase()}`}
                >
                  <span className="bg-primary/10 dark:bg-primary/20 flex size-11 shrink-0 items-center justify-center rounded-xl">
                    <Icon
                      className="text-primary size-5"
                      aria-hidden="true"
                      strokeWidth={1.75}
                    />
                  </span>
                  <span className="text-base leading-snug">
                    <span className="text-foreground font-semibold">
                      {t(`onboarding.connectedPromise${key}Lead`)}
                    </span>{" "}
                    <span className="text-secondary-foreground">
                      {t(`onboarding.connectedPromise${key}`)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-8 w-full">
              <Button
                size="lg"
                data-id="onboarding-welcome-continue"
                onClick={() => advance("welcome")}
                className="from-primary h-14 w-full bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
              >
                {t("onboarding.connectedCta")}
                <ArrowRight className="size-5" aria-hidden="true" />
              </Button>
            </div>

            <div className="mt-9">{dots}</div>
          </div>
        )}

        {step === "connectors" && (
          <ConnectorsStep
            dots={dots}
            onBack={back}
            onNext={() => advance("connectors")}
          />
        )}

        {step === "models" && (
          <ProviderSetupStep
            dots={dots}
            onBack={back}
            onDone={() => advance("models")}
          />
        )}
      </div>
    </div>
  );
};
