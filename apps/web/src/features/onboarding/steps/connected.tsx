import { Bot, Laptop, Plug, Sparkles } from "lucide-react";
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
      <ul className="divide-border mt-5 w-full max-w-[520px] divide-y text-left">
        {[
          { key: "Agent", icon: Bot },
          { key: "Models", icon: Sparkles },
          { key: "Work", icon: Plug },
          { key: "Local", icon: Laptop },
        ].map(({ key, icon: Icon }) => (
          <li key={key} className="flex items-center gap-3 py-2">
            <span className="bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-xl">
              <Icon
                aria-hidden
                className="text-primary size-5"
                strokeWidth={1.75}
              />
            </span>
            <span className="text-muted-foreground text-sm leading-5">
              <strong className="text-foreground font-semibold">
                {t(`onboarding.connectedPromise${key}Lead`)}
              </strong>{" "}
              {t(`onboarding.connectedPromise${key}`)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-5">
        <StepButton disabled={busy} onClick={advance}>
          {t("onboarding.connectedCta")}
        </StepButton>
      </div>
    </>
  );
};
