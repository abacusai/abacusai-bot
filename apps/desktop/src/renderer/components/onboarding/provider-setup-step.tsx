import { ArrowLeft, ArrowRight, Check, KeyRound, Link2 } from "lucide-react";
import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PROVIDER_KEY_FIELDS, type ProviderKeyField } from "#shared/settings";

import { signInToAbacus } from "../../lib/abacus-sign-in";
import { cn } from "../../lib/cn";
import { ProviderMark } from "../chat/provider-mark";
import { ProviderKeyDialog } from "../settings/provider-key-dialog";
import { Button, Spinner } from "../ui";

/**
 * Where the free keys are: the last step of the flow, two providers that cost
 * nothing to start. Nothing here is required. The cards read their labels and
 * links from PROVIDER_KEY_FIELDS to stay in step with Settings → API keys.
 */

/**
 * The three routes to a model this screen offers, in order: Abacus first
 * because the account from step one already has the free tier, then the two
 * that cost nothing to add. Everything else is in Settings → API keys.
 */
const OFFERED_PROVIDERS = ["abacus", "openrouter", "gemini"] as const;

const FEATURED_PROVIDERS = OFFERED_PROVIDERS.map((provider) =>
  PROVIDER_KEY_FIELDS.find((field) => field.provider === provider)!
).filter(Boolean);

/** Every other model provider, opened in place when asked for. */
/**
 * What each card says under its name: one promise per provider, or four
 * identical tiles leave the user to work out which to press.
 */
const CARD_COPY: Record<
  string,
  { lead: string; accent: string; tail?: string }
> = {
  abacus: {
    lead: "onboarding.setupBlurbAbacusLead",
    accent: "onboarding.setupBlurbAbacusAccent",
  },
  openrouter: {
    lead: "onboarding.setupBlurbOpenrouterLead",
    accent: "onboarding.setupBlurbOpenrouterAccent",
    tail: "onboarding.setupBlurbOpenrouterTail",
  },
  gemini: {
    lead: "onboarding.setupBlurbGeminiLead",
    accent: "onboarding.setupBlurbGeminiAccent",
  },
};

const MORE_PROVIDERS = PROVIDER_KEY_FIELDS.filter(
  (field) =>
    field.kind === "model" &&
    !OFFERED_PROVIDERS.includes(field.provider as never)
);

/** What is true of every route below: hosted, or your own keys, or free. */
export const ProviderSetupStep = ({
  onBack,
  onDone,
  dots,
}: {
  /** Back to the welcome screen. */
  onBack: () => void;
  /** Done here — leave onboarding for the app. */
  onDone: () => void;
  /** The flow's progress dots, so this step doesn't own the shell's chrome. */
  dots: ReactNode;
}): React.ReactElement => {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState<Record<string, boolean>>({});
  const [abacusConnecting, setAbacusConnecting] = useState(false);
  const [abacusError, setAbacusError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  /** Which OpenRouter attempt owns the spinner; see `connectOpenRouter`. */
  const attempt = useRef(0);
  const [connectError, setConnectError] = useState<string | null>(null);
  /** The provider whose key field is open, or null while the grid is idle. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** Has the user asked for the providers this screen does not lead with? */
  const [showAll, setShowAll] = useState(false);
  const openKeyField = FEATURED_PROVIDERS.find(
    (field) => field.provider === openKey
  );

  /** Which providers can already run; environment keys count too. */
  const refresh = async (): Promise<void> => {
    const [models, stored] = await Promise.all([
      window.api.agent.listModels(),
      window.api.agent.listStoredKeyProviders(),
    ]);
    const storedSet = new Set(stored);

    setConfigured(
      Object.fromEntries(
        FEATURED_PROVIDERS.map((field) => [
          field.provider,
          models.some((m) => m.provider === field.provider && m.configured) ||
            storedSet.has(field.provider),
        ])
      )
    );
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Leaving the step abandons whichever hop is still out, or its loopback port
  // is held for the full timeout and the tile is still spinning on return.
  useEffect(
    () => () => {
      void window.api?.agent?.cancelAbacusAuth?.();
      void window.api?.agent?.cancelOpenRouterAuth?.();
    },
    []
  );

  /** The same browser hop as the welcome screen's sign-in — offered again
   * here because "Abacus free tier" is one of the three LLM choices. */
  const connectAbacus = async (): Promise<void> => {
    setAbacusConnecting(true);
    setAbacusError(null);
    try {
      const result = await signInToAbacus();
      if (result.ok === true) {
        await window.api.agent.listModels(true);
        await refresh();
        return;
      }
      // A cancelled sign-in is a decision, not a failure.
      if (result.cancelled !== true) setAbacusError(result.error);
    } finally {
      setAbacusConnecting(false);
    }
  };

  /**
   * Give up on the hop in flight: the tile is disabled and spinning until the
   * hop answers, up to five minutes for Abacus.
   */
  const cancelConnect = (): void => {
    void window.api?.agent?.cancelAbacusAuth?.();
    void window.api?.agent?.cancelOpenRouterAuth?.();
    attempt.current += 1;
    setAbacusConnecting(false);
    setConnecting(false);
  };

  const connectOpenRouter = async (): Promise<void> => {
    attempt.current += 1;
    const mine = attempt.current;
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await window.api.agent.startOpenRouterAuth();
      if (result.ok === true) {
        await refresh();
        return;
      }
      // A cancelled sign-in is a decision, not a failure.
      if (result.cancelled !== true) setConnectError(result.error);
    } finally {
      // Only stand down if this attempt still owns the spinner: a restart
      // resolves this promise as cancelled, and an unguarded reset would wipe
      // the spinner belonging to the hop the user just started.
      if (attempt.current === mine) setConnecting(false);
    }
  };

  /**
   * A browser hop for the two providers that have one, otherwise the key
   * dialog, which replaces whatever field was open. Choosing a row does not
   * open the provider's console; the dialog carries that link.
   */
  const choose = async (field: ProviderKeyField): Promise<void> => {
    if (field.connect === "abacus") return connectAbacus();
    if (field.connect === "openrouter") return connectOpenRouter();

    setOpenKey(field.provider !== openKey ? field.provider : null);
  };

  return (
    <div className="@container flex flex-col" data-id="onboarding-setup">
      <div className="flex items-center justify-between">
        <Button
          variant="link"
          size="sm"
          onClick={onBack}
          aria-label={t("common.back")}
          className="text-muted-foreground hover:text-secondary-foreground text-xs"
        >
          <ArrowLeft size={13} />
          {t("common.back")}
        </Button>
      </div>

      <div className="flex flex-col items-center text-center">
        {/* No mark and no product name here. The user is inside the app, three
            screens into its first run — the window has already said whose it
            is, and repeating it on every step spends the top of the screen on
            what they already know instead of on what the step is asking. */}
        <h1 className="text-foreground text-4xl font-bold tracking-tight text-balance">
          {t("onboarding.setupTitleLead")}{" "}
          <span className="text-primary">
            {t("onboarding.setupTitleAccent")}
          </span>
        </h1>
        <p className="text-secondary-foreground mt-2 text-base">
          {t("onboarding.setupSubtitle")}
        </p>
      </div>

      {/* One row per provider, and the row is the control: the three cards
          that used to sit under this grid said the same three things again in
          twice the height, which is what put a scrollbar on a step that is
          meant to fit. Selecting a row either starts its browser hop or opens
          one key field, so the screen grows by a line rather than by a card. */}
      <div
        className="mt-8 grid grid-cols-2 gap-3 @xl:grid-cols-4"
        data-id="onboarding-setup-providers"
      >
        {FEATURED_PROVIDERS.map((field) => {
          const isConfigured = configured[field.provider] === true;
          const isBusy =
            (field.provider === "abacus" && abacusConnecting) ||
            (field.provider === "openrouter" && connecting);
          // A signup funnel that drops the authorize step strands the user in
          // the browser, so the tile in flight stays live: pressing it again
          // reopens the hop (main is single-flight and drops the old attempt).

          const isOtherBusy = (abacusConnecting || connecting) && !isBusy;

          return (
            <div
              key={field.provider}
              data-id={`onboarding-setup-provider-${field.provider}`}
              title={
                field.provider === "abacus"
                  ? t("onboarding.setupAbacusGrant")
                  : field.hint
              }
              className={cn(
                "border-border bg-card/60 flex flex-col items-center gap-3 rounded-2xl border p-4",
                (isConfigured || openKey === field.provider) &&
                  "border-primary/50"
              )}
            >
              <span className="flex size-12 items-center justify-center">
                <ProviderMark provider={field.provider} className="size-10" />
              </span>
              <span className="text-foreground text-center text-sm font-semibold text-balance">
                {field.label}
              </span>

              {CARD_COPY[field.provider] != null && (
                <span className="text-muted-foreground text-center text-xs leading-snug text-balance">
                  {t(CARD_COPY[field.provider].lead)}{" "}
                  <span className="text-primary font-semibold">
                    {t(CARD_COPY[field.provider].accent)}
                  </span>
                  {/* `!` because TS does not carry the null check across a
                      second index access. */}
                  {CARD_COPY[field.provider].tail != null && (
                    <> {t(CARD_COPY[field.provider].tail!)}</>
                  )}
                </span>
              )}

              <Button
                variant="outline"
                size="sm"
                data-id={`onboarding-setup-provider-${field.provider}-connect`}
                disabled={isOtherBusy || isConfigured}
                onClick={() => void choose(field)}
                className={cn(
                  "mt-auto w-full",
                  isConfigured
                    ? "border-transparent bg-emerald-500/10 text-emerald-700 disabled:opacity-100 dark:text-emerald-400"
                    : "text-primary border-primary/40"
                )}
              >
                {isBusy ? (
                  <Spinner fontSize={12} className="text-current" />
                ) : isConfigured ? (
                  <Check className="size-3.5" />
                ) : (
                  <Link2 className="size-3.5" />
                )}
                {isConfigured
                  ? t("onboarding.connectorsConnectedCta")
                  : t("onboarding.connectorsConnectCta")}
              </Button>
            </div>
          );
        })}

        {/* The fourth card is real but inert: Claude, Codex, Grok and the rest
            are supported, they just take a key from a subscription this screen
            has no business collecting mid-onboarding. Saying so here is what
            stops a list of three reading as the whole world. */}
        <div
          data-id="onboarding-setup-provider-existing"
          aria-disabled="true"
          className="border-border bg-card/60 flex flex-col items-center gap-3 rounded-2xl border p-4 opacity-70"
          title={t("onboarding.setupExistingBody")}
        >
          <span className="flex size-12 items-center justify-center">
            <KeyRound className="text-muted-foreground size-8" />
          </span>
          <span className="text-foreground text-center text-sm font-semibold text-balance">
            {t("onboarding.setupExistingTitle")}
          </span>
          <span className="text-muted-foreground text-center text-xs leading-snug text-balance">
            {t("onboarding.setupExistingBody")}
          </span>
          <span className="text-muted-foreground mt-auto flex h-8 w-full items-center justify-center text-xs font-medium">
            {t("onboarding.setupExistingLater")}
          </span>
        </div>
      </div>

      {!showAll && MORE_PROVIDERS.length > 0 && (
        <div className="mt-6 flex justify-center">
          <Button
            variant="link"
            data-id="onboarding-setup-more"
            onClick={() => setShowAll(true)}
            className="text-primary text-base font-semibold"
          >
            {t("onboarding.connectorsMore")}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      )}

      {showAll && (
        <div
          className="mt-4 grid max-h-56 grid-cols-2 gap-2 overflow-y-auto @xl:grid-cols-4"
          data-id="onboarding-setup-all"
        >
          {MORE_PROVIDERS.map((field) => (
            <Button
              key={field.provider}
              variant="outline"
              size="sm"
              data-id={`onboarding-setup-provider-${field.provider}-connect`}
              disabled={configured[field.provider] === true}
              onClick={() => void choose(field)}
              className="h-auto justify-start gap-2 py-2"
            >
              <ProviderMark provider={field.provider} className="size-4" />
              <span className="truncate text-xs font-medium">
                {field.label}
              </span>
              {configured[field.provider] === true && (
                <Check className="ml-auto size-3.5 text-emerald-600" />
              )}
            </Button>
          ))}
        </div>
      )}

      {/* A dialog rather than a field under the grid: pasting a key means
          leaving for the provider's console first, and the dialog names the
          errand and is still there when they return. */}
      <ProviderKeyDialog
        field={openKeyField ?? null}
        open={openKeyField != null}
        onClose={() => setOpenKey(null)}
        onSaved={refresh}
      />

      {(abacusError ?? connectError) != null && (
        <div
          className="text-destructive mt-3 text-xs"
          data-id="onboarding-setup-error"
        >
          {abacusError ?? connectError}
        </div>
      )}

      <div className="mt-8 flex flex-col items-center gap-5">
        <Button
          size="lg"
          data-id="onboarding-setup-done"
          onClick={onDone}
          className="from-primary h-14 w-full bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
        >
          {t("onboarding.setupDoneCta")}
          <ArrowRight className="size-5" />
        </Button>

        {/* Only while a hop is out: a permanent cancel would be a control for
            a state the user is not in. */}
        {(abacusConnecting || connecting) && (
          <Button
            variant="link"
            size="sm"
            data-id="onboarding-setup-cancel"
            onClick={cancelConnect}
            className="text-muted-foreground hover:text-secondary-foreground -mt-2 text-xs"
          >
            {t("common.cancel")}
          </Button>
        )}

        {dots}
      </div>
    </div>
  );
};
