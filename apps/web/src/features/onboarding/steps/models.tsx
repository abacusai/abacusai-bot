/**
 * `models` (canvas OnboardModels): "Hook up your AI", the provider rows,
 * "Existing subscriptions · Connect later ·
 * Paste a key" and Continue (always enabled: a user may finish with nothing).
 */
import { useRef, useState, type Ref } from "react";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { errorText } from "#renderer/lib/use-app-context";

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
  const openRouter = useOpenRouterHop(props.transport, refresh);
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
      <div className="mt-5 flex w-full max-w-[640px] flex-col gap-2">
        {ROWS.map((row) => (
          <div
            key={row.id}
            className="onboarding-row"
            data-connected={isConnected(row.id)}
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
            ) : row.id === "openrouter" && openRouter.waiting ? (
              <>
                <StepButton variant="small" disabled>
                  {t("phase5.waitingSignIn")}
                </StepButton>
                <StepButton variant="small" onClick={openRouter.cancel}>
                  {t("phase5.cancel")}
                </StepButton>
              </>
            ) : (
              <StepButton
                variant="small"
                disabled={busy}
                onClick={() =>
                  row.id === "abacus"
                    ? props.signIn("signin")
                    : void openRouter.start()
                }
              >
                {t("onboarding.pages.connectLabel")}
              </StepButton>
            )}
          </div>
        ))}
      </div>
      {openRouter.error && (
        <p role="alert" className="onboarding-quiet mt-3 max-w-[640px]">
          {openRouter.error}
        </p>
      )}
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

/**
 * OpenRouter's browser hop, owned by its row rather than the page: the main
 * process keeps the listener open for as long as an account can take to make,
 * so the wait shows on the row with a Cancel, Continue stays live (leaving the
 * step cancels the hop), and a failure says why instead of nothing.
 */
const useOpenRouterHop = (
  transport: StepContext["props"]["transport"],
  refresh: () => Promise<unknown>
) => {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Cancel and each new start, so a superseded hop's answer is dropped.
  const attempt = useRef(0);
  const start = async () => {
    const id = ++attempt.current;
    setWaiting(true);
    setError(null);
    try {
      const result = await transport.client.auth.openRouter.start({});
      if (id !== attempt.current) return;
      if (result.ok) await refresh();
      else if (result.cancelled !== true) setError(result.error);
    } catch (failure) {
      if (id === attempt.current) setError(errorText(failure));
    }
    if (id === attempt.current) setWaiting(false);
  };
  const cancel = () => {
    attempt.current++;
    setWaiting(false);
    void transport.client.auth.openRouter.cancel({}).catch(() => undefined);
  };
  return { waiting, error, start, cancel };
};
