/**
 * `first-bot` (canvas OnboardFirstBot): the bot row (avatar 40, name, the
 * check-in summary, Edit), "Say hello" / "Take the tour" and the quiet
 * "Start from scratch". The hatching avatar itself lives on the stage.
 */
import type { BotRow } from "@abacus-ai/contract/contract";
import type { Ref } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { Spinner } from "#renderer/components/spinner";
import { useDb } from "#renderer/data/db";
import { resolveLook } from "#renderer/lib/bots/avatar";

import { discardFirstBot, type FirstBotState } from "../first-bot";
import type { StepContext } from "./context";
import { StepBody, StepButton, StepLink, StepTitle } from "./kit";

export const FirstBotStep = ({
  ctx,
  first,
  bot,
  present,
  heading,
}: {
  ctx: StepContext;
  first: FirstBotState;
  bot: BotRow | null;
  /** The bot is still in the collection (or is a gallery preview). */
  present: boolean;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, perform } = ctx;
  const db = useDb();
  const funnel = (step: "first_bot_kept" | "first_bot_cancelled") =>
    props.transport.client.system.funnelStep({ step });
  return (
    <>
      <StepTitle ref={heading}>
        {t("onboarding.pages.first-bot.title")}
      </StepTitle>
      {bot && (
        <StepBody className="mt-1.5 max-w-[520px]">
          {t("onboarding.pages.first-bot.body", { name: bot.name })}
        </StepBody>
      )}
      {first.state === "pending" && (
        <div className="mt-6">
          <Spinner />
        </div>
      )}
      {first.state === "removed" && (
        <>
          <StepBody className="mt-6">{t("onboarding.pages.removed")}</StepBody>
          <div className="mt-4">
            <StepButton
              disabled={busy}
              onClick={() => void props.navigate("done")}
            >
              {t("onboarding.connectorsContinue")}
            </StepButton>
          </div>
        </>
      )}
      {bot && (
        <>
          <div className="onboarding-card mt-6 flex w-full max-w-[520px] items-center gap-3 rounded-[14px] py-3 pr-3 pl-4">
            <BotAvatar
              animate
              look={resolveLook({
                name: bot.name,
                avatarShape: bot.avatarShape,
                avatarColor: bot.avatarColor,
              })}
              size={40}
              mood="wink"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {present ? bot.name : t("onboarding.pages.removed")}
              </span>
              <span className="onboarding-quiet block">
                {t(
                  first.state === "ready" && first.result.checkInRoutineId
                    ? "onboarding.pages.checkIn"
                    : "onboarding.pages.noCheckIn"
                )}
              </span>
            </span>
            <StepButton
              variant="small"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  props.complete({ to: "bot", botId: bot.id, edit: true })
                )
              }
            >
              {t("mcpManagement.edit")}
            </StepButton>
          </div>
          <div className="onboarding-actions mt-7">
            <StepButton
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await funnel("first_bot_kept");
                  await props.navigate("done");
                })
              }
            >
              {t("onboarding.pages.hello")}
            </StepButton>
            <StepButton
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await funnel("first_bot_kept");
                  await props.complete({ to: "bot-tour", botId: bot.id });
                })
              }
            >
              {t("tour.replay")}
            </StepButton>
          </div>
          <div className="mt-3">
            <StepLink
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (first.state !== "ready") return;
                  await discardFirstBot(db, first.result);
                  await funnel("first_bot_cancelled");
                  await props.navigate("done");
                })
              }
            >
              {t("onboarding.pages.scratch")}
            </StepLink>
          </div>
        </>
      )}
    </>
  );
};
