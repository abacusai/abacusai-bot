import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { useBotsQuery, useCreateBotMutation } from "../../hooks/use-bots";
import { BOT_TEMPLATES } from "../bots/bot-templates";

/** The template the first bot is made from. */
export const FIRST_BOT_TEMPLATE_ID = "chief-of-staff";

/**
 * The first bot, a Chief of Staff made from its template the moment onboarding
 * ends, with no popup: the user lands in its chat, where it introduces itself
 * and starts on the inbox. Its first runs are on the house (sponsoredFirstRun),
 * so the account's first sight of the product is the drafts, not a bill. Only
 * when there are no bots of the user's own: a sign-out and back in reruns
 * onboarding.
 */
export const FirstBot = ({
  armed,
  onDone,
}: {
  /** Onboarding finished in this session — the one moment this fires. */
  armed: boolean;
  /** The bot was made and opened, or there was nothing to make. */
  onDone: () => void;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const botsQuery = useBotsQuery();
  const createBot = useCreateBotMutation();
  // One creation per arming, whatever the bots query does meanwhile.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!armed) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current || botsQuery.data == null) return;
    startedRef.current = true;
    void (async () => {
      // Decided on a fresh list, not the cache: a list read before sign-in
      // ends is the previous account's, or empty.
      const bots = (await botsQuery.refetch()).data ?? botsQuery.data ?? [];
      // Only bots the user would call theirs. Linking WhatsApp, Telegram or
      // Discord — which the connectors step, two screens before this, invites
      // them to do — mints a self-lane bot of the app's own, and counting one
      // of those meant almost nobody reached their first bot: the check read
      // "they already have bots" about bots they never made.
      if (bots.some((bot) => bot.channel == null)) {
        window.api.reportFunnelStep("first_bot_skipped", "has_bots");
        onDone();
        return;
      }
      const template = BOT_TEMPLATES.find(
        (entry) => entry.id === FIRST_BOT_TEMPLATE_ID
      );
      if (template == null) {
        window.api.reportFunnelStep("first_bot_skipped", "no_template");
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
          sponsoredFirstRun: true,
        })
        .then((made) => {
          // Made and opened in one motion: "shown" and "kept" are the same moment now.
          window.api.reportFunnelStep("first_bot_shown");
          window.api.reportFunnelStep("first_bot_kept");
          onDone();
          void navigate({ to: "/bots/$botId", params: { botId: made.id } });
        })
        // A first bot that could not be made is not worth an error: the bot
        // maker is one click away, and the user was never promised one.
        .catch(() => {
          window.api.reportFunnelStep("first_bot_skipped", "create_failed");
          onDone();
        });
    })();
    // `createBot`, `navigate` and `t` are stable enough; the effect is about `armed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, botsQuery.data, onDone]);

  return null;
};
