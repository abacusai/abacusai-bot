import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { Bot } from "#shared/bots";

import {
  useBotsQuery,
  useCreateBotMutation,
  useDeleteBotMutation,
} from "../../hooks/use-bots";
import { BOT_TEMPLATES } from "../bots/bot-templates";
import { NewBotDialog } from "../bots/new-bot-dialog";

/** The template the first bot is made from. */
export const FIRST_BOT_TEMPLATE_ID = "chief-of-staff";

/**
 * The first bot, a Chief of Staff made from its template the moment onboarding
 * ends. The popup is the bot maker itself, on the bot already made: the fields
 * are the ones the user will edit anyway, so the first look at a bot is the
 * form they will meet every time. Only when there are no bots: a sign-out and
 * back in reruns onboarding.
 */

export const FirstBotDialog = ({
  armed,
  onDone,
}: {
  /** Onboarding finished in this session: the one moment this fires. */
  armed: boolean;
  /** The popup was closed, or there was nothing to show. */
  onDone: () => void;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const botsQuery = useBotsQuery();
  const createBot = useCreateBotMutation();
  const deleteBot = useDeleteBotMutation();
  const [bot, setBot] = useState<Bot | null>(null);
  // One creation per arming, whatever the bots query does meanwhile.
  const startedRef = useRef(false);
  // Set the moment the user presses Create. The dialog calls onClose after a
  // button that returned true, so the close that follows a Create is not a
  // cancel, and must not take the bot back.
  const keptRef = useRef(false);

  useEffect(() => {
    if (!armed) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current || botsQuery.data == null) return;
    startedRef.current = true;
    keptRef.current = false;
    // Only bots the user would call theirs. Linking WhatsApp, Telegram or
    // Discord (which the connectors step, two screens before this, invites
    // them to do) mints a self-lane bot of the app's own, and counting one
    // of those meant almost nobody reached their first bot: the check read
    // "they already have bots" about bots they never made.
    if (botsQuery.data.some((bot) => bot.channel == null)) {
      onDone();
      return;
    }
    const template = BOT_TEMPLATES.find(
      (entry) => entry.id === FIRST_BOT_TEMPLATE_ID
    );
    if (template == null) {
      onDone();
      return;
    }
    createBot
      .mutateAsync({
        name: t(`bots.templates.${template.id}.name`),
        title: template.title,
        description: template.mission,
        persona: template.persona,
        avatarColor: template.avatarColor,
        avatarShape: template.avatarShape,
      })
      .then(setBot)
      // A first bot that could not be made is not worth a popup: the bot
      // maker is right there behind this, and it says nothing was made.
      .catch(onDone);
    // `createBot` and `t` are stable enough; the effect is about `armed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, botsQuery.data, onDone]);

  if (bot == null) return null;

  const close = (): void => {
    setBot(null);
    onDone();
  };

  /**
   * Cancel means no bot. The Chief of Staff is made before the popup so the
   * popup can show it, but a user who closes the form never asked for one,
   * and leaving it in their list is the app deciding for them.
   */
  const cancel = (): void => {
    if (keptRef.current) {
      close();
      return;
    }
    const made = bot.id;
    close();
    deleteBot.mutate(made);
  };

  return (
    <NewBotDialog
      isOpen
      bot={bot}
      title={t("firstBot.title")}
      onClose={cancel}
      onCreated={(saved) => {
        keptRef.current = true;
        close();
        void navigate({ to: "/bots/$botId", params: { botId: saved.id } });
      }}
    />
  );
};
