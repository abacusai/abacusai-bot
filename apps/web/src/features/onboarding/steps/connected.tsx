import type { Ref } from "react";

import type { StepContext } from "./context";
import { StepBody, StepButton, StepTitle } from "./kit";

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
      <StepTitle ref={heading}>
        {t("onboarding.connectedTitleLead")}{" "}
        <span className="onboarding-accent">
          {t("onboarding.connectedTitleName")}
        </span>
      </StepTitle>
      <StepBody className="mt-2">{t("onboarding.abacusConnected")}</StepBody>
      <div className="mt-7">
        <StepButton disabled={busy} onClick={advance}>
          {t("onboarding.connectedCta")}
        </StepButton>
      </div>
    </>
  );
};
