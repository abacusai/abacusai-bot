/**
 * `done` (canvas OnboardDone): "You're set", the line about the first bot,
 * "Message {bot}" / "New session" (or "New bot" when the step was skipped).
 * The three avatars and the confetti live on the stage.
 */
import type { BotRow } from "@abacus-ai/contract/contract";
import type { Ref } from "react";

import type { StepContext } from "./context";
import { StepBody, StepButton, StepTitle } from "./kit";

export const DoneStep = ({
  ctx,
  bot,
  checkIn,
  heading,
}: {
  ctx: StepContext;
  bot: BotRow | null;
  checkIn: boolean;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, perform } = ctx;
  return (
    <>
      <StepTitle ref={heading}>{t("onboarding.pages.done.title")}</StepTitle>
      <StepBody className="mt-1.5">
        {bot && checkIn
          ? t("onboarding.pages.done.checkIn", { name: bot.name })
          : t("onboarding.pages.done.body")}
      </StepBody>
      <div className="onboarding-actions mt-7">
        <StepButton
          disabled={busy}
          className={bot ? "onboarding-button-success" : undefined}
          onClick={() =>
            void perform(() =>
              props.complete(
                bot ? { to: "bot", botId: bot.id } : { to: "new-bot" }
              )
            )
          }
        >
          {bot
            ? t("onboarding.pages.message", { name: bot.name })
            : t("onboarding.pages.newBot")}
        </StepButton>
        <StepButton
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void perform(() => props.complete({ to: "new-session" }))
          }
        >
          {t("onboarding.pages.newSession")}
        </StepButton>
      </div>
    </>
  );
};
