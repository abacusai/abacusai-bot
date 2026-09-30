import {
  Brain,
  ChevronDown,
  Gift,
  Globe,
  Puzzle,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AbacusAuthIntent, BrowserSignInProfile } from "#shared/contracts";

import logo from "../../assets/icon2.png";
import { Button, Spinner } from "../ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** The pitch, as three headlines: one per thing worth knowing before signing up. */
const CAPABILITIES = [
  { key: "Memory", icon: Brain },
  { key: "Connectors", icon: Puzzle },
  { key: "Models", icon: Sparkles },
] as const;

/**
 * The sign-in wall. The app requires an account, so this is the one screen
 * with no way past it but the button.
 */
export const SignInStep = ({
  busy,
  error,
  onConnect,
  browserProfiles = [],
  onContinueWith,
  onCancel,
  onOpenInBrowser,
  dots,
}: {
  /** The browser hop is out; it can take minutes while an account is created. */
  busy: boolean;
  error: string | null;
  /** `signin` is the returning user's button; it always uses the browser. */
  onConnect: (intent: AbacusAuthIntent) => void;
  /**
   * The default browser's profile, then others that may already be signed in
   * to Abacus.AI, offered behind "I already have an account".
   */
  browserProfiles?: BrowserSignInProfile[];
  /** Sign in with a picked profile's session. */
  onContinueWith?: (profileId: string) => void;
  onCancel: () => void;
  /** Move the pending sign-in to the system browser. */
  onOpenInBrowser: () => void;
  dots: ReactNode;
}): JSX.Element => {
  const { t } = useTranslation();
  const defaultProfile = browserProfiles.find((p) => p.isDefault === true);
  // Unflagged entries are the ones main found an Abacus.AI cookie for.
  const sessionProfiles = browserProfiles.filter(
    (p) => p.hasAbacusSession !== false
  );
  // The default browser is already signed in: the returning user's link
  // finishes with it in one click, and the menu keeps every other way.
  const quickProfile =
    defaultProfile?.hasAbacusSession === true && onContinueWith != null
      ? defaultProfile
      : undefined;

  const profileMenu = (
    profiles: BrowserSignInProfile[],
    trigger: JSX.Element,
    label: ReactNode
  ): JSX.Element => (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{label}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="w-auto min-w-72"
        data-id="onboarding-browser-profiles"
      >
        {profiles.map((profile) => (
          <DropdownMenuItem
            key={profile.id}
            data-id="onboarding-continue-with-browser"
            onClick={() => onContinueWith?.(profile.id)}
            className="text-sm"
          >
            <Globe aria-hidden="true" />
            {t("onboarding.continueWithBrowser", {
              browser: profile.browserName,
              profile: profile.profileName,
            })}
          </DropdownMenuItem>
        ))}
        {profiles.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          data-id="onboarding-signin-another-way"
          onClick={() => onConnect("signin")}
          className="text-sm"
        >
          <UserRound aria-hidden="true" />
          {t("onboarding.signInAnotherWay")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

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

      <div className="mt-9 flex w-full flex-col items-center gap-4">
        <Button
          size="lg"
          data-id="onboarding-connect"
          disabled={busy}
          onClick={() => onConnect("signup")}
          className="from-primary h-14 w-full bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
        >
          {busy ? (
            <Spinner fontSize={16} className="text-current" />
          ) : (
            <UserRound className="size-5" aria-hidden="true" />
          )}
          {busy ? t("apiKeys.connecting") : t("onboarding.connectCta")}
        </Button>
        {!busy &&
          defaultProfile != null && (
            // Said before the click: the provider popup will already know them.
            <p
              className="text-muted-foreground -mt-1 text-xs text-balance"
              data-id="onboarding-browser-sessions"
            >
              {t("onboarding.usesBrowserSessions", {
                browser: defaultProfile.browserName,
              })}
            </p>
          )}
        {!busy &&
          (quickProfile != null ? (
            <div className="flex items-center gap-0.5">
              <Button
                variant="link"
                size="sm"
                data-id="onboarding-have-account"
                onClick={() => onContinueWith?.(quickProfile.id)}
                className="text-muted-foreground hover:text-secondary-foreground text-sm"
              >
                {t("onboarding.haveAccountContinueWith", {
                  browser: quickProfile.browserName,
                })}
              </Button>
              {profileMenu(
                sessionProfiles.filter((p) => p.id !== quickProfile.id),
                <Button
                  variant="ghost"
                  size="icon-sm"
                  data-id="onboarding-signin-options"
                  aria-label={t("onboarding.signInOptions")}
                  className="text-muted-foreground"
                />,
                <ChevronDown aria-hidden="true" />
              )}
            </div>
          ) : sessionProfiles.length > 0 && onContinueWith != null ? (
            // A browser already signed in to Abacus.AI: the returning user's
            // link offers its profiles, so the screen keeps two choices.
            profileMenu(
              sessionProfiles,
              <Button
                variant="link"
                size="sm"
                data-id="onboarding-have-account"
                className="text-muted-foreground hover:text-secondary-foreground text-sm"
              />,
              t("onboarding.haveAccountCta")
            )
          ) : (
            <Button
              variant="link"
              size="sm"
              data-id="onboarding-have-account"
              onClick={() => onConnect("signin")}
              className="text-muted-foreground hover:text-secondary-foreground text-sm"
            >
              {t("onboarding.haveAccountCta")}
            </Button>
          ))}
        {busy && (
          <div className="flex items-center gap-2">
            {/* For anyone whose browser already holds their Abacus.AI session
                or passwords; in the browser arm it reopens a closed tab. */}
            <Button
              variant="link"
              size="sm"
              data-id="onboarding-open-auth-in-browser"
              onClick={onOpenInBrowser}
              className="text-muted-foreground hover:text-secondary-foreground text-xs"
            >
              {t("onboarding.openInBrowserCta")}
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
        )}
      </div>

      <div className="mt-9">{dots}</div>
    </div>
  );
};
