/**
 * `models` (canvas OnboardModels): "Hook up your AI", the provider rows,
 * the platform's local-model row, "Existing subscriptions · Connect later ·
 * Paste a key" and Continue (always enabled: a user may finish with nothing).
 */
import type { Ref } from "react";

import { ConnectorMark } from "#renderer/components/connector-mark";

import type { StepContext } from "./context";
import {
  ConnectedMark,
  StepBody,
  StepButton,
  StepLink,
  StepTitle,
} from "./kit";
import { OnboardingProviderKey } from "./provider-key";

const ROWS = [
  {
    id: "abacus",
    mark: "abacus",
    lead: "onboarding.setupBlurbAbacusLead",
    accent: "onboarding.setupBlurbAbacusAccent",
    tail: null,
  },
  {
    id: "openrouter",
    mark: "openrouter",
    lead: "onboarding.setupBlurbOpenrouterLead",
    accent: "onboarding.setupBlurbOpenrouterAccent",
    tail: "onboarding.setupBlurbOpenrouterTail",
  },
  {
    id: "gemini",
    mark: "gemini",
    lead: "onboarding.setupBlurbGeminiLead",
    accent: "onboarding.setupBlurbGeminiAccent",
    tail: null,
  },
] as const;

export const ModelsStep = ({
  ctx,
  connected,
  refresh,
  heading,
}: {
  ctx: StepContext;
  /** Providers with a configured model or a stored key. */
  connected: ReadonlySet<string>;
  refresh(): Promise<unknown>;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, perform, advance } = ctx;
  const isConnected = (id: string) =>
    connected.has(id) || (id === "abacus" && props.facts.signedIn);
  return (
    <>
      <StepTitle ref={heading} size="medium">
        {t("onboarding.setupTitleLead")}{" "}
        <span className="onboarding-accent">
          {t("onboarding.setupTitleAccent")}
        </span>
      </StepTitle>
      <StepBody className="mt-1.5">{t("onboarding.setupSubtitle")}</StepBody>
      <div className="mt-7 flex w-full max-w-[640px] flex-col gap-2">
        {ROWS.map((row) => (
          <div
            key={row.id}
            className="onboarding-row"
            data-connected={isConnected(row.id)}
          >
            <ConnectorMark id={row.mark} size={36} />
            <span className="onboarding-row-title min-w-0 flex-1">
              {t(row.lead)}{" "}
              <span className="onboarding-accent">{t(row.accent)}</span>
              {row.tail && <> {t(row.tail)}</>}
            </span>
            {isConnected(row.id) ? (
              <ConnectedMark>
                {t("onboarding.pages.connectedLabel")}
              </ConnectedMark>
            ) : row.id === "gemini" ? (
              <OnboardingProviderKey
                transport={props.transport}
                saved={refresh}
                provider="gemini"
              />
            ) : (
              <StepButton
                variant="small"
                disabled={busy}
                onClick={() =>
                  row.id === "abacus"
                    ? props.signIn("signin")
                    : void perform(async () => {
                        await props.transport.client.auth.openRouter.start({});
                        await refresh();
                      })
                }
              >
                {t("onboarding.pages.connectLabel")}
              </StepButton>
            )}
          </div>
        ))}
        {props.localModel}
      </div>
      <div className="mt-3 flex w-full max-w-[640px] items-center gap-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {t("onboarding.setupExistingTitle")}
          </span>
          <span className="onboarding-quiet block">
            {t("onboarding.setupExistingBody")}
          </span>
        </span>
        <StepLink disabled={busy} onClick={advance}>
          {t("onboarding.setupExistingLater")}
        </StepLink>
        <OnboardingProviderKey transport={props.transport} saved={refresh} />
      </div>
      <div className="mt-7">
        <StepButton disabled={busy} onClick={advance}>
          {t("onboarding.setupDoneCta")}
        </StepButton>
      </div>
    </>
  );
};
