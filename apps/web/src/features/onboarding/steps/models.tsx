/**
 * `models` (canvas OnboardModels): "Hook up your AI", the provider rows,
 * "Existing subscriptions · Connect later ·
 * Paste a key" and Continue (always enabled: a user may finish with nothing).
 */
import { useSelector } from "@tanstack/react-store";
import type { Ref } from "react";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { ConnectPending } from "#renderer/components/form-kit/connect-dialog";
import { connectErrorText } from "#renderer/lib/connect-page";
import { useRowConnects } from "#renderer/lib/use-row-connects";

import { onboardingStore } from "../store";
import { failureCopy } from "./connect";
import type { StepContext } from "./context";
import { ConnectedMark, StepBody, StepButton, StepTitle } from "./kit";
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
  const { t, busy, props, advance } = ctx;
  // OpenRouter's hop waits on its row; leaving the step cancels its listener.
  const rows = useRowConnects();
  // Abacus signs in through the page's one sign-in, shown on its row the same way.
  const signIn = useSelector(onboardingStore, (state) => state.signIn);
  const isConnected = (id: string) =>
    connected.has(id) || (id === "abacus" && props.facts.signedIn);
  const waiting = (id: string) =>
    id === "abacus" ? signIn?.status === "pending" : rows.waiting(id);
  const failure = (id: string): string | null => {
    if (id !== "abacus") {
      const error = rows.error(id);
      return error != null ? connectErrorText(t, error) : null;
    }
    if (signIn?.status !== "failed") return null;
    const copy = failureCopy(signIn);
    return t(copy.key, copy.values);
  };
  const connect = (id: string) =>
    id === "abacus"
      ? props.signIn("signin")
      : rows.start(id, {
          run: () => props.transport.client.auth.openRouter.start({}),
          cancel: () =>
            void props.transport.client.auth.openRouter
              .cancel({})
              .catch(() => undefined),
          connected: refresh,
        });
  const cancel = (id: string) =>
    id === "abacus" ? void props.cancelSignIn() : rows.cancel(id);
  return (
    <>
      <StepTitle ref={heading} size="medium">
        {t("onboarding.setupTitleLead")}{" "}
        <span className="onboarding-accent">
          {t("onboarding.setupTitleAccent")}
        </span>
      </StepTitle>
      <StepBody className="mt-1.5">{t("onboarding.setupSubtitle")}</StepBody>
      <div className="mt-5 flex w-full max-w-[640px] flex-col gap-2">
        {ROWS.map((row) => {
          const error = isConnected(row.id) ? null : failure(row.id);
          return (
            <div
              key={row.id}
              className="onboarding-row"
              data-connected={isConnected(row.id)}
              data-provider={row.id}
            >
              <ConnectorMark id={row.mark} size={48} />
              <span className="onboarding-row-title min-w-0 flex-1">
                <span className="mb-1 block text-sm font-semibold">
                  {t(`onboarding.pages.models.${row.id}`)}
                </span>
                <span className="text-muted-foreground text-[13px] font-normal">
                  {t(row.lead)}{" "}
                  <span className="onboarding-accent">{t(row.accent)}</span>
                  {row.tail && <> {t(row.tail)}</>}
                </span>
                {error != null && (
                  <span
                    role="alert"
                    className="text-destructive mt-1 block text-[13px] font-normal"
                  >
                    {error}
                  </span>
                )}
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
              ) : waiting(row.id) ? (
                <ConnectPending
                  cancelClassName="text-muted-foreground h-8 px-3"
                  onCancel={() => cancel(row.id)}
                />
              ) : (
                <StepButton
                  variant="small"
                  disabled={busy}
                  onClick={() => connect(row.id)}
                >
                  {t("onboarding.pages.connectLabel")}
                </StepButton>
              )}
            </div>
          );
        })}
      </div>
      <div className="onboarding-existing mt-4 max-w-[640px]">
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {t("onboarding.setupExistingTitle")}
          </span>
          <span className="onboarding-quiet block">
            {t("onboarding.setupExistingBody")}
          </span>
        </span>
        <OnboardingProviderKey transport={props.transport} saved={refresh} />
      </div>
      <div className="mt-5">
        <StepButton disabled={busy} onClick={advance}>
          {t("onboarding.setupDoneCta")}
        </StepButton>
      </div>
    </>
  );
};
