import { Globe, Play, UserRound } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AbacusAuthIntent, BrowserSignInProfile } from "#shared/contracts";

import tour from "../../assets/demo-product.mp4";
import { Button, Spinner } from "../ui";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** Google's mark, in its own colours: the button is theirs to recognise. */
const GoogleMark = (): JSX.Element => (
  <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M23.5 12.3c0-.9-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.8c2.3-2.1 3.6-5.2 3.6-8.8z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.8-3c-1.1.7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.4v3.1C3.4 21.3 7.4 24 12 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.3 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3V6.6H1.4C.5 8.2 0 10 0 12s.5 3.8 1.4 5.4l3.9-3.1z"
    />
    <path
      fill="#EA4335"
      d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.6l3.9 3.1c.9-2.9 3.6-4.9 6.7-4.9z"
    />
  </svg>
);

/**
 * The sign-in wall. The app requires an account, so this is the one screen
 * with no way past it but the button. It opens the browser, where the user's
 * Google account already is and the sign-in page's Google button finishes
 * it; a browser profile already signed in to Abacus.AI is offered behind a
 * small link underneath.
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
  /** The main button: the browser, where the user's Google account already is. */
  onConnect: (intent: AbacusAuthIntent) => void;
  /**
   * Chromium profiles that may already be signed in to Abacus.AI, offered
   * behind "Sign in another way".
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
  const [tourOpen, setTourOpen] = useState(false);

  return (
    <div
      className="relative flex flex-col items-center text-center"
      data-id="onboarding-welcome"
    >
      <h1 className="text-foreground text-5xl font-bold tracking-tight text-balance">
        {t("onboarding.welcomeTitle")}
      </h1>
      <p className="text-secondary-foreground mt-3 text-xl font-medium tracking-tight text-balance">
        {t("onboarding.welcomeTagline")}
      </p>

      {/* The product, shown rather than described: the pitch is the tour. */}
      <button
        type="button"
        data-id="onboarding-play-tour"
        aria-label={t("onboarding.playTourCta")}
        onClick={() => setTourOpen(true)}
        className="bg-primary/10 hover:bg-primary/20 dark:bg-primary/20 dark:hover:bg-primary/30 mt-12 flex size-24 items-center justify-center rounded-full transition-colors"
      >
        <Play
          className="text-primary ml-1 size-10"
          fill="currentColor"
          aria-hidden="true"
        />
      </button>
      <Dialog open={tourOpen} onOpenChange={setTourOpen}>
        <DialogContent className="max-w-4xl p-2" data-id="onboarding-tour">
          <DialogTitle className="sr-only">
            {t("onboarding.playTourCta")}
          </DialogTitle>
          {tourOpen && (
            <video src={tour} controls autoPlay className="w-full rounded-lg" />
          )}
        </DialogContent>
      </Dialog>

      {error != null && (
        <div
          className="text-destructive mt-6 text-xs"
          data-id="onboarding-error"
        >
          {error}
        </div>
      )}

      <div className="mt-12 flex w-full flex-col items-center gap-4">
        <Button
          size="lg"
          data-id="onboarding-connect"
          disabled={busy}
          onClick={() => onConnect("signin")}
          className="bg-background text-foreground hover:bg-muted border-border h-14 w-full max-w-sm rounded-full border text-base font-semibold shadow-lg"
        >
          {busy ? (
            <Spinner fontSize={16} className="text-current" />
          ) : (
            <GoogleMark />
          )}
          {busy ? t("apiKeys.connecting") : t("onboarding.connectCta")}
        </Button>
        {!busy &&
          browserProfiles.length > 0 &&
          onContinueWith != null && (
            // A browser already signed in to Abacus.AI: the link offers its
            // profiles, so the screen keeps one button.
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="link"
                    size="sm"
                    data-id="onboarding-have-account"
                    className="text-muted-foreground hover:text-secondary-foreground text-xs"
                  />
                }
              >
                {t("onboarding.signInAnotherWay")}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="center"
                className="w-auto min-w-72"
                data-id="onboarding-browser-profiles"
              >
                {browserProfiles.map((profile) => (
                  <DropdownMenuItem
                    key={profile.id}
                    data-id="onboarding-continue-with-browser"
                    onClick={() => onContinueWith(profile.id)}
                    className="text-sm"
                  >
                    <Globe aria-hidden="true" />
                    {t("onboarding.continueWithBrowser", {
                      browser: profile.browserName,
                      profile: profile.profileName,
                    })}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
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
          )}
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
      <div className="mt-8">{dots}</div>
    </div>
  );
};
