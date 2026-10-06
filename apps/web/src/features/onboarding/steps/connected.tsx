/**
 * `connected` (canvas OnboardConnected): the success line, "Welcome to
 * AbacusAI Bot", a 2 × 2 grid of the four promises and "Get started". The
 * browser never offers the models step, so its grid promises chat instead.
 */
import type { Ref } from "react";

import { IS_ELECTRON } from "#renderer/lib/platform";

import type { StepContext } from "./context";
import { StepButton, StepTitle } from "./kit";

const PROMISES = IS_ELECTRON
  ? (["Agent", "Models", "Work", "Local"] as const)
  : (["Agent", "Work", "Local", "Chat"] as const);

const LEAD = {
  Agent: "onboarding.connectedPromiseAgentLead",
  Models: "onboarding.connectedPromiseModelsLead",
  Work: "onboarding.connectedPromiseWorkLead",
  Local: "onboarding.connectedPromiseLocalLead",
  Chat: "onboarding.connectedPromiseChatLead",
} as const;
const TAIL = {
  Agent: "onboarding.connectedPromiseAgent",
  Models: "onboarding.connectedPromiseModels",
  Work: "onboarding.connectedPromiseWork",
  Local: "onboarding.connectedPromiseLocal",
  Chat: null,
} as const;

export const ConnectedStep = ({
  ctx,
  heading,
}: {
  ctx: StepContext;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, advance } = ctx;
  return (
    <>
      <p className="onboarding-success">{t("onboarding.abacusConnected")}</p>
      <StepTitle ref={heading} size="large" className="mt-1.5">
        {t("onboarding.connectedTitleLead")}{" "}
        <span className="onboarding-accent">
          {t("onboarding.connectedTitleName")}
        </span>
      </StepTitle>
      <ul className="mt-7 grid w-full max-w-[640px] grid-cols-1 gap-2 sm:grid-cols-2">
        {PROMISES.map((promise) => (
          <li key={promise} className="onboarding-card px-4 py-3.5">
            <span className="block font-semibold">{t(LEAD[promise])}</span>
            {TAIL[promise] && (
              <span className="onboarding-quiet block">{t(TAIL[promise])}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-8">
        <StepButton disabled={busy} onClick={advance}>
          {t("onboarding.connectedCta")}
        </StepButton>
      </div>
    </>
  );
};
