/**
 * `connect` (canvas OnboardConnect): the live sign-in attempt. One spinner
 * card while the browser is open ("Continue with {browser} · {profile}"
 * when a profile was picked), the error line and Try again when it failed,
 * and the quiet row: Use my browser instead · Sign in another way · Cancel.
 * The browser build connects the site's own session instead (no hop).
 */
import type { Ref } from "react";

import { Spinner } from "#renderer/components/spinner";
import { webSignInHref } from "#renderer/lib/navigation/web-sign-in";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { signInFailureCopy } from "#renderer/lib/sign-in-failure";

import type { SignInAttempt } from "../store";
import type { StepContext } from "./context";
import { StepBody, StepButton, StepLink, StepLinks, StepTitle } from "./kit";
import type { BrowserProfile } from "./welcome";

export const failureCopy = (
  attempt: SignInAttempt
): { key: string; values: Record<string, string> } => {
  const outcome = attempt.outcome;
  if (outcome && !outcome.ok && outcome.error === "unidentified-account")
    return { key: "onboarding.abacusUnidentified", values: {} };
  if (!IS_ELECTRON && outcome && !outcome.ok) {
    const copy = signInFailureCopy(outcome.error);
    return { key: copy.key, values: { code: copy.code } };
  }
  return { key: "onboarding.frame.failed", values: {} };
};

export const ConnectStep = ({
  ctx,
  attempt,
  profiles,
  heading,
}: {
  ctx: StepContext;
  attempt: SignInAttempt | null;
  profiles: readonly BrowserProfile[] | undefined;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, props, perform } = ctx;
  const waiting = (props.preview && !attempt) || attempt?.status === "pending";
  const profile = attempt?.profileId
    ? profiles?.find((entry) => entry.id === attempt.profileId)
    : undefined;
  const sessionExpired =
    !IS_ELECTRON &&
    attempt?.status === "failed" &&
    attempt.outcome &&
    !attempt.outcome.ok &&
    attempt.outcome.error === "auth-code:session:UNKNOWN";
  return (
    <>
      <StepTitle ref={heading}>
        {t(
          IS_ELECTRON
            ? "onboarding.pages.connect.browserTitle"
            : "onboarding.pages.connect.title"
        )}
      </StepTitle>
      <StepBody className="mt-2">
        {t(
          IS_ELECTRON ? "onboarding.connectBody" : "onboarding.webSignIn.body"
        )}
      </StepBody>
      {waiting && (
        <div
          role="status"
          className="onboarding-card mt-7 flex min-h-[60px] w-full max-w-[460px] items-center gap-2.5 rounded-[14px] py-3 pr-[18px] pl-3.5"
        >
          <Spinner className="text-primary size-[18px]" />
          <span className="text-left">
            <span className="block font-medium">
              {t(
                IS_ELECTRON
                  ? "onboarding.pages.connect.waiting"
                  : "onboarding.webSignIn.waiting"
              )}
            </span>
            {profile && (
              <span className="onboarding-quiet block">
                {t("onboarding.continueWithBrowser", {
                  browser: profile.browserName,
                  profile: profile.profileName,
                })}
              </span>
            )}
          </span>
        </div>
      )}
      {attempt?.status === "failed" && (
        <>
          <p role="alert" className="onboarding-body mt-7 max-w-[520px]">
            {t(failureCopy(attempt).key, failureCopy(attempt).values)}
          </p>
          <div className="mt-4">
            <StepButton
              onClick={() => props.signIn(attempt.intent, attempt.profileId)}
            >
              {t("onboarding.pages.retry")}
            </StepButton>
          </div>
        </>
      )}
      <StepLinks className="mt-4">
        {IS_ELECTRON && (
          <StepLink
            onClick={() =>
              void props.transport.client.auth.abacus.openInBrowser({})
            }
          >
            {t("onboarding.openInBrowserCta")}
          </StepLink>
        )}
        {IS_ELECTRON ? (
          <StepLink
            onClick={() =>
              void perform(async () => {
                await props.cancelSignIn();
                props.signIn("signin");
              })
            }
          >
            {t("onboarding.signInAnotherWay")}
          </StepLink>
        ) : sessionExpired ? (
          <a
            className="onboarding-link inline-flex items-center"
            href={webSignInHref()}
          >
            {t("onboarding.signInAnotherWay")}
          </a>
        ) : null}
        <StepLink
          onClick={() =>
            void perform(async () => {
              await props.cancelSignIn();
              await props.navigate("welcome");
            })
          }
        >
          {t("common.cancel")}
        </StepLink>
      </StepLinks>
    </>
  );
};
