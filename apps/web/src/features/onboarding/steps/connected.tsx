import { Boxes, Brain, Plug } from "lucide-react";
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
      <ul className="mt-6 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { key: "welcomeCapabilityModels", icon: Boxes },
          { key: "welcomeCapabilityMemory", icon: Brain },
          { key: "welcomeCapabilityConnectors", icon: Plug },
        ].map(({ key, icon: Icon }) => (
          <li
            key={key}
            className="onboarding-card flex items-center justify-center gap-2 px-3 py-4 text-sm"
          >
            <Icon
              aria-hidden
              className="text-muted-foreground size-4 shrink-0"
            />
            {t(`onboarding.${key}`)}
          </li>
        ))}
      </ul>
      <div className="mt-7">
        <StepButton disabled={busy} onClick={advance}>
          {t("onboarding.connectedCta")}
        </StepButton>
      </div>
    </>
  );
};
