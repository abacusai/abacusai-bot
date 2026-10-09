import {
  FREE_POOL_PROVIDERS,
  type FreePoolProvider,
} from "@abacus-ai/contract/free-pool";
import {
  isPlausibleApiKey,
  PROVIDER_KEY_FIELDS,
} from "@abacus-ai/contract/settings";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { GroupCard } from "#renderer/components/form-kit/page";
import { ABACUS_BUY_CREDITS_URL } from "#renderer/lib/abacus-links";
import { useVisibleContextualUpsell } from "#renderer/lib/contextual-upsell";
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
  markCreditsExhausted?(): Promise<void>;
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
}: {
  host: CreditActions;
  tier: "free" | "basic" | "paid" | "unknown";
  scope?: "abacus" | "pool";
  onResume?(): Promise<unknown>;
  alternatives?: ReactNode;
  title?: string;
  note?: string;
}) => {
  const { t } = useTranslation();
  const promotionRef = useVisibleContextualUpsell(tier === "free");
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
    return () => {
      live = false;
    };
  }, [host]);
  const paying = tier === "paid" || tier === "basic";
  const missing =
    paying || configured == null ? [] : missingFreeSources(configured);
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
      <div data-slot="credits-card" ref={promotionRef}>
        <GroupCard
          title={
            title ??
            t(
              paying
                ? "creditsCard.paidTitle"
                : scope === "pool"
                  ? "workspace.premiumUpgrade.poolOutTitle"
                  : "workspace.premiumUpgrade.exhaustedTitle"
            )
          }
        >
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
          <div className="flex flex-col gap-3 p-3">
            {tier === "free" && (
              <Button size="sm" onClick={() => void host.openUpgrade()}>
                {t("creditsCard.cta")}
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
