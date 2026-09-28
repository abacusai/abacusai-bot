import { Gift, Brain, Puzzle, Sparkles, UserRound } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AbacusAuthMode } from "#shared/contracts";

import logo from "../../assets/icon2.png";
import { Button, Spinner } from "../ui";

/** The pitch, as three headlines: one per thing worth knowing before signing up. */
const CAPABILITIES = [
  { key: "Memory", icon: Brain },
  { key: "Connectors", icon: Puzzle },
  { key: "Models", icon: Sparkles },
] as const;

/**
 * The sign-in wall. The app requires an account, so this is the one screen
 * with no way past it but the buttons. A first run leads with sign-up and a
 * returning profile with sign-in; each offers the other, because the browser
 * page otherwise opens on the wrong form for everyone who already has an
 * Abacus.AI account.
 */
export const SignInStep = ({
  busy,
  error,
  primaryMode,
  onConnect,
  onReopen,
  onCancel,
  dots,
}: {
  /** The browser hop is out; it can take minutes while an account is created. */
  busy: boolean;
  error: string | null;
  /** What the big button does; the link under it does the other. */
  primaryMode: AbacusAuthMode;
  onConnect: (mode: AbacusAuthMode) => void;
  onReopen: () => void;
  onCancel: () => void;
  dots: ReactNode;
}): JSX.Element => {
  const { t } = useTranslation();
  const signUpFirst = primaryMode === "signup";

  return (
    <div
      className="relative flex flex-col items-center text-center"
      data-id="onboarding-welcome"
    >
      {/* The price is the first question anyone has; answered up here, the
          pitch below does not have to spend a line on it. */}
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

      {/* Divided rather than boxed: cards around each headline would read as
          a settings page. */}
      <div
        className="divide-border/70 mt-9 grid w-full grid-cols-1 gap-6 sm:grid-cols-3 sm:gap-0 sm:divide-x"
        data-id="onboarding-capabilities"
      >
        {CAPABILITIES.map(({ key, icon: Icon }) => (
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

      <div className="mt-9 flex w-full flex-col items-center gap-3">
        <Button
          size="lg"
          data-id="onboarding-connect"
          disabled={busy}
          onClick={() => onConnect(primaryMode)}
          className="from-primary h-14 w-full bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
        >
          {busy ? (
            <Spinner fontSize={16} className="text-current" />
          ) : (
            <UserRound className="size-5" aria-hidden="true" />
          )}
          {busy
            ? t("onboarding.waitingCta")
            : signUpFirst
              ? t("onboarding.connectCta")
              : t("onboarding.signInCta")}
        </Button>
        {busy ? (
          // The work is in another app now; say so, and give a way back to a
          // tab that got closed or buried.
          <div
            className="flex flex-col items-center gap-1"
            data-id="onboarding-waiting"
          >
            <p className="text-secondary-foreground text-sm">
              {t("onboarding.waitingBody")}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="link"
                size="sm"
                data-id="onboarding-reopen-auth"
                onClick={onReopen}
                className="text-xs"
              >
                {t("onboarding.waitingReopen")}
              </Button>
              <Button
                variant="link"
                size="sm"
                data-id="onboarding-cancel-auth"
                onClick={onCancel}
                className="text-muted-foreground hover:text-secondary-foreground text-xs"
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              {signUpFirst
                ? t("onboarding.connectHintSignUp")
                : t("onboarding.connectHintSignIn")}
            </p>
            <p className="text-secondary-foreground text-sm">
              {signUpFirst
                ? t("onboarding.haveAccountLead")
                : t("onboarding.newAccountLead")}{" "}
              <Button
                variant="link"
                size="sm"
                data-id="onboarding-alternate-auth"
                onClick={() => onConnect(signUpFirst ? "signin" : "signup")}
                className="h-auto p-0 text-sm font-semibold"
              >
                {signUpFirst
                  ? t("onboarding.haveAccountCta")
                  : t("onboarding.newAccountCta")}
              </Button>
            </p>
          </>
        )}
      </div>

      <div className="mt-9">{dots}</div>
    </div>
  );
};
