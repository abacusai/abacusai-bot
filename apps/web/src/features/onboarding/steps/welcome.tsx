import type { Ref } from "react";

import { Spinner } from "#renderer/components/spinner";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";

import { websiteSignInStarted } from "../first-run";
import type { StepContext } from "./context";
import { StepBody, StepButton, StepTitle } from "./kit";

export interface BrowserProfile {
  id: string;
  browserName: string;
  profileName: string;
  isDefault?: boolean;
  hasAbacusSession?: boolean | null;
}

export const WelcomeStep = ({
  ctx,
  profiles,
  heading,
}: {
  ctx: StepContext;
  profiles: readonly BrowserProfile[] | undefined;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props } = ctx;
  const defaultProfile = profiles?.find((profile) => profile.isDefault);
  const quickProfile = profiles?.find(
    (profile) => profile.isDefault && profile.hasAbacusSession === true
  );
  const sessionProfiles =
    profiles?.filter((profile) => profile.hasAbacusSession !== false) ?? [];
  if (!IS_ELECTRON)
    return (
      <>
        <StepTitle ref={heading}>
          {t("onboarding.pages.connect.title")}
        </StepTitle>
        <StepBody className="mt-2">{t("onboarding.webSignIn.body")}</StepBody>
        {websiteSignInStarted() ? (
          <div className="mt-7">
            <StepButton disabled={busy} onClick={() => props.signIn("signin")}>
              {t("onboarding.pages.retry")}
            </StepButton>
          </div>
        ) : (
          <div
            role="status"
            className="onboarding-card mt-7 flex h-[52px] items-center gap-2.5 rounded-[14px] pr-[18px] pl-3.5"
          >
            <Spinner className="text-primary size-[18px]" aria-hidden />
            <span className="font-medium">
              {t("onboarding.webSignIn.waiting")}
            </span>
          </div>
        )}
      </>
    );
  return (
    <>
      <StepTitle ref={heading} size="hero">
        {t("onboarding.welcomeTitle")}
      </StepTitle>
      <p className="onboarding-tagline mt-2">
        {t("onboarding.welcomeTagline")}
      </p>
      <div className="mt-9 flex flex-wrap justify-center gap-2.5">
        <StepButton disabled={busy} onClick={() => props.signIn("signup")}>
          {t("onboarding.connectCta")}
        </StepButton>
        {quickProfile ? (
          <StepButton
            variant="secondary"
            disabled={busy}
            onClick={() => props.signIn("signin", quickProfile.id)}
          >
            {t("onboarding.haveAccountCta")}
          </StepButton>
        ) : sessionProfiles.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="lg"
                  variant="secondary"
                  data-variant="secondary"
                  className="onboarding-button"
                  disabled={busy}
                />
              }
            >
              {t("onboarding.haveAccountCta")}
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                {sessionProfiles.map((profile) => (
                  <DropdownMenuItem
                    key={profile.id}
                    onClick={() => props.signIn("signin", profile.id)}
                  >
                    {t("onboarding.continueWithBrowser", {
                      browser: profile.browserName,
                      profile: profile.profileName,
                    })}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onClick={() => props.signIn("signin")}>
                  {t("onboarding.signInAnotherWay")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <StepButton
            variant="secondary"
            disabled={busy}
            onClick={() => props.signIn("signin")}
          >
            {t("onboarding.haveAccountCta")}
          </StepButton>
        )}
      </div>
      {defaultProfile && (
        <StepBody className="onboarding-quiet mt-3">
          {t("onboarding.usesBrowserSessions", {
            browser: defaultProfile.browserName,
          })}
        </StepBody>
      )}
    </>
  );
};
