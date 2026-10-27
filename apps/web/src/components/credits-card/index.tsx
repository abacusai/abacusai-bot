import {
  type BillingPlan,
  planPitch,
  planPrice,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import {
  FREE_POOL_PROVIDERS,
  type FreePoolProvider,
} from "@abacus-ai/contract/free-pool";
import {
  isPlausibleApiKey,
  PROVIDER_KEY_FIELDS,
  providerDisplayName,
} from "@abacus-ai/contract/settings";
import { AlertTriangle, Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { GroupCard } from "#renderer/components/form-kit/page";
import { ABACUS_BUY_CREDITS_URL } from "#renderer/lib/abacus-links";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#renderer/ui/dialog";
import { Field, FieldLabel, FieldError } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";
import { Separator } from "#renderer/ui/separator";

export interface CreditActions {
  openExternal(url: string): Promise<void>;
  /** The account's own upgrade page, or the plan page without one. */
  openUpgrade(): Promise<void>;
  canTopUpCredits?(): Promise<boolean>;
  configuredFreeSources?(): Promise<Record<string, boolean>>;
  connectFreeSource?(source: FreePoolProvider, key?: string): Promise<boolean>;
  /** The account's plan, credits and upgrades, read now; see billing-plan.ts. */
  billingPlan?(): Promise<BillingPlan | null>;
  /** The user chose the free models at the credit wall (main tells the agents). */
  chooseFreeLane?(): Promise<void>;
  /** Re-reads the model catalog, after a model was refused for the plan. */
  refreshModels?(): Promise<void>;
}

/**
 * The credit wall's choice, when a turn stopped there: the plan, or the free
 * models from the providers it would move to. No model on this computer.
 */
export interface CreditWallChoice {
  /** The providers the free lane would use, in order. */
  providers: readonly string[];
  /** Keep going on the free models; absent when none is connected. */
  onContinueFree?(): Promise<unknown>;
  /** The plan's button: the upgrade dialog that resumes the turn. */
  onUpgrade?(): void;
  expired?: boolean;
}

export const missingFreeSources = (configured: Record<string, boolean>) =>
  FREE_POOL_PROVIDERS.filter((source) => configured[source] !== true).slice(
    0,
    2
  );

const SOURCE_KEYS: Record<FreePoolProvider, string> = {
  gemini: "Gemini",
  openrouter: "Openrouter",
  mistral: "Mistral",
  nvidia: "Nvidia",
  cerebras: "Cerebras",
  groq: "Groq",
};

/** Main's credit boundary, shared by the transcript and the sidebar. */
export const CreditsCard = ({
  host,
  tier,
  scope = "abacus",
  onResume,
  alternatives,
  title,
  note,
  ready,
  wall,
}: {
  host: CreditActions;
  tier: "free" | "basic" | "paid" | "unknown";
  scope?: "abacus" | "pool";
  onResume?(): Promise<unknown>;
  alternatives?: ReactNode;
  title?: string;
  note?: string;
  /** The cut-off turn's handover, drawn by the route's deliverables card. */
  ready?: ReactNode;
  /** The turn stopped at the credit wall: the plan or the free lane. */
  wall?: CreditWallChoice;
}) => {
  const { t, i18n } = useTranslation();
  const [billing, setBilling] = useState<BillingPlan | null>(null);
  const [configured, setConfigured] = useState<Record<string, boolean> | null>(
    null
  );
  const [asking, setAsking] = useState<FreePoolProvider | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canTopUp, setCanTopUp] = useState(false);
  useEffect(() => {
    let live = true;
    void host
      .canTopUpCredits?.()
      .then((value) => {
        if (live) setCanTopUp(value);
      })
      .catch(() => {});
    void host
      .configuredFreeSources?.()
      .then((sources) => {
        if (live) setConfigured(sources);
      })
      .catch(() => {});
    void host
      .billingPlan?.()
      .then((plan) => {
        if (live) setBilling(plan);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host]);
  const paying = tier === "paid" || tier === "basic";
  // At the wall with a free lane to offer, its link is the way on: the
  // sources to connect are for an account with none.
  const missing =
    paying || configured == null || wall?.onContinueFree != null
      ? []
      : missingFreeSources(configured);
  const offer = wallOffer(billing);
  const balance = billing?.current;
  const connect = async (source: FreePoolProvider, value?: string) => {
    if (busy || !host.connectFreeSource) return;
    setBusy(true);
    setError(null);
    try {
      if (await host.connectFreeSource(source, value)) {
        setAsking(null);
        setConfigured((await host.configuredFreeSources?.()) ?? {});
        await onResume?.();
      }
    } catch {
      setError(t("phase5.saveFailed"));
    }
    setBusy(false);
  };
  const field = PROVIDER_KEY_FIELDS.find((entry) => entry.provider === asking);
  return (
    <>
      <div data-slot="credits-card">
        <GroupCard
          title={
            wall != null
              ? t(
                  wall.expired === true
                    ? "outcome.wall.expiredTitle"
                    : paying
                      ? "outcome.wall.paidTitle"
                      : "outcome.wall.title"
                )
              : (title ??
                t(
                  paying
                    ? "creditsCard.paidTitle"
                    : scope === "pool"
                      ? "workspace.premiumUpgrade.poolOutTitle"
                      : "workspace.premiumUpgrade.exhaustedTitle"
                ))
          }
        >
          {wall != null ? (
            <div
              className="flex flex-col gap-3 p-3 text-sm"
              data-slot="credit-wall"
            >
              {balance?.creditsRemaining != null &&
                balance.creditsGranted != null && (
                  <p className="text-muted-foreground" data-slot="wall-balance">
                    {t("outcome.wall.balance", {
                      remaining: new Intl.NumberFormat(i18n.language).format(
                        Math.max(0, Math.round(balance.creditsRemaining))
                      ),
                      granted: new Intl.NumberFormat(i18n.language).format(
                        Math.round(balance.creditsGranted)
                      ),
                    })}
                  </p>
                )}
              {wall.onContinueFree != null && wall.providers.length > 0 && (
                <div
                  role="note"
                  data-slot="wall-warning"
                  className="flex items-start gap-2 rounded-lg bg-[color-mix(in_oklch,var(--chat-status-attention)_12%,transparent)] p-2.5"
                >
                  <AlertTriangle
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-[var(--chat-status-attention)]"
                  />
                  <p>
                    {t("outcome.wall.warning", {
                      providers: wall.providers
                        .map(providerDisplayName)
                        .join(", "),
                    })}
                  </p>
                </div>
              )}
              {!paying && offer != null && (
                <div className="flex flex-col gap-1.5" data-slot="wall-offer">
                  <p className="font-medium">
                    {t("outcome.wall.offer", {
                      plan: offer.planName,
                      price: planPrice(t, offer, i18n.language),
                    })}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {planPitch(t, billing, i18n.language).map((feature) => (
                      <li key={feature} className="flex gap-1.5">
                        <Check
                          aria-hidden
                          className="text-primary mt-0.5 size-3.5 shrink-0"
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground p-3 text-sm">
              {note ??
                t(
                  paying
                    ? canTopUp
                      ? "creditsCard.paidBody"
                      : "workspace.premiumUpgrade.switchNote"
                    : missing.length
                      ? "workspace.premiumUpgrade.connectNote"
                      : "workspace.premiumUpgrade.switchNote"
                )}
            </p>
          )}
          {ready != null && (
            <div className="flex flex-col gap-2 px-3" data-slot="credits-ready">
              <p className="text-sm font-medium">
                {t("creditsCard.readyTitle")}
              </p>
              {ready}
            </div>
          )}
          <div className="flex flex-col gap-3 p-3">
            {tier === "free" && (
              <Button
                size="sm"
                data-action="upgrade"
                onClick={() =>
                  wall?.onUpgrade != null
                    ? wall.onUpgrade()
                    : void host.openUpgrade()
                }
              >
                {wall != null && offer != null
                  ? t("outcome.wall.upgradeCta", { plan: offer.planName })
                  : t("creditsCard.cta")}
              </Button>
            )}
            {paying && canTopUp ? (
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p>{t("creditsCard.topUpCta")}</p>
                  <p className="text-muted-foreground text-xs">
                    {t("workspace.premiumUpgrade.topUpMeta")}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() =>
                    void (tier === "paid"
                      ? host.openExternal(ABACUS_BUY_CREDITS_URL)
                      : host.openUpgrade())
                  }
                >
                  {t("creditsCard.topUpCta")}
                </Button>
              </div>
            ) : !paying ? (
              missing.map((source, index) => (
                <div key={source}>
                  {index > 0 && <Separator className="mb-3" />}
                  <div
                    className="flex flex-wrap items-center gap-3"
                    data-source={source}
                  >
                    <div className="min-w-0 flex-1">
                      <p>
                        {t(
                          `workspace.premiumUpgrade.source${SOURCE_KEYS[source]}`
                        )}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t(
                          `workspace.premiumUpgrade.source${SOURCE_KEYS[source]}Meta`
                        )}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        if (IS_ELECTRON && source === "openrouter")
                          void connect(source);
                        else {
                          setAsking(source);
                          setKey("");
                          setError(null);
                        }
                      }}
                    >
                      {t("workspace.premiumUpgrade.connectCta")}
                    </Button>
                  </div>
                </div>
              ))
            ) : null}
            {wall?.onContinueFree != null && (
              <Button
                variant="link"
                size="sm"
                data-action="continue-free"
                className="text-muted-foreground self-start px-0"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void wall.onContinueFree?.().finally(() => setBusy(false));
                }}
              >
                {t("outcome.wall.continueFree")}
              </Button>
            )}
            {alternatives && (
              <>
                <Separator />
                <div className="flex flex-col gap-2">{alternatives}</div>
              </>
            )}
            {error && !asking && <p role="alert">{error}</p>}
          </div>
        </GroupCard>
      </div>
      <Dialog
        open={asking != null}
        onOpenChange={(open) => {
          if (!open && !busy) setAsking(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("onboarding.setupKeyDialogTitle", { provider: field?.label })}
            </DialogTitle>
            <DialogDescription>
              {t("onboarding.pages.keyPrivate")}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!isPlausibleApiKey(key))
                setError(t("onboarding.setupKeyInvalid"));
              else if (asking) void connect(asking, key.trim());
            }}
          >
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="credit-source-key">
                {t("onboarding.pages.addKey")}
              </FieldLabel>
              <Input
                id="credit-source-key"
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? "credit-source-error" : undefined}
              />
              <FieldError id="credit-source-error">{error}</FieldError>
            </Field>
            {field?.signupUrl && (
              <Button
                type="button"
                variant="link"
                onClick={() => void host.openExternal(field.signupUrl!)}
              >
                {field.label}
              </Button>
            )}
            <Button type="submit" disabled={busy}>
              {t("bots.save")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
