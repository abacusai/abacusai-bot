import { Loader2, Mail } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ConnectorOutcome } from "#shared/contracts";

import { Button } from "../ui";

/** What the user decided; a connect that failed leaves them on the card to decide again. */
export type GmailPermissionOutcome = "connected" | "declined";

/**
 * One question right after sign-in, for an account on a Google address: may the
 * app connect its Gmail. Allow opens the browser straight on Google's consent
 * for that very account, so the whole thing is one more click; Not now is
 * remembered and the connectors screen still offers the tile.
 */
export const GmailPermissionStep = ({
  email,
  onAllow,
  onDone,
  dots,
}: {
  email: string;
  /** Starts the connect hop; resolves when the browser came back. */
  onAllow: () => Promise<ConnectorOutcome>;
  onDone: (outcome: GmailPermissionOutcome) => void;
  dots: ReactNode;
}): JSX.Element => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const allow = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      const result = await onAllow();
      if (result.ok === true) {
        onDone("connected");
        return;
      }
      // A cancelled hop is the user changing their mind mid-way, not a failure to report.
      if (result.cancelled !== true) setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex flex-col items-center text-center"
      data-id="onboarding-gmail-permission"
    >
      <span className="bg-primary/10 dark:bg-primary/20 flex size-16 items-center justify-center rounded-2xl">
        <Mail
          className="text-primary size-8"
          aria-hidden="true"
          strokeWidth={1.75}
        />
      </span>
      <h1 className="text-foreground mt-7 text-4xl font-bold tracking-tight text-balance">
        {t("onboarding.gmailTitle")}
      </h1>
      <p className="text-secondary-foreground mt-4 text-base leading-snug text-balance">
        {t("onboarding.gmailBody", { email })}
      </p>
      <p className="text-secondary-foreground mt-2 text-sm leading-snug">
        {t("onboarding.gmailNote")}
      </p>
      {failed && (
        <p
          className="text-destructive mt-4 text-sm"
          role="alert"
          data-id="onboarding-gmail-failed"
        >
          {t("onboarding.gmailFailed")}
        </p>
      )}
      <div className="mt-8 flex w-full flex-col gap-3">
        <Button
          size="lg"
          data-id="onboarding-gmail-allow"
          onClick={() => void allow()}
          disabled={busy}
          className="from-primary h-14 w-full bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
        >
          {busy ? (
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          ) : (
            t("onboarding.gmailAllowCta")
          )}
        </Button>
        <Button
          size="lg"
          variant="ghost"
          data-id="onboarding-gmail-not-now"
          onClick={() => onDone("declined")}
          disabled={busy}
          className="h-12 w-full text-base"
        >
          {t("onboarding.gmailNotNowCta")}
        </Button>
      </div>
      <div className="mt-6">{dots}</div>
    </div>
  );
};
