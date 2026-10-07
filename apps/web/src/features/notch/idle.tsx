import { ExternalLink, MessageCircle, Mic, Pause, Play } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { isCheckInRoutine } from "#renderer/lib/bots/check-in";
import { useNotch } from "#renderer/notch-context";

import { NotchAction, useNotchMotion } from "./controls";

export const IdleView = () => {
  const { db, message, transport } = useNotch();
  const { t } = useTranslation();
  const animation = useNotchMotion();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const bot = db.collections.bots.toArray.find((bot) => bot.channel == null);
  const routine = bot
    ? db.collections.routines.toArray.find((routine) =>
        isCheckInRoutine(routine, bot.id)
      )
    : null;
  // The switch flips at once; a refusal rolls the row back and says so.
  const toggle = () => {
    if (!routine || busy) return;
    setError(false);
    void db.collections.routines
      .update(routine.id, (draft) => {
        draft.enabled = !routine.enabled;
      })
      .isPersisted.promise.catch(() => setError(true));
  };
  const launch = async (call: boolean) => {
    if (!bot || busy) return;
    setBusy(true);
    setError(false);
    try {
      await message(bot.id, call);
    } catch {
      setError(true);
    }
    setBusy(false);
  };
  return (
    <motion.div {...animation} className="notch-idle">
      <h2>{bot?.name ?? t("notch.wings.idle")}</h2>
      {bot && (
        <div className="notch-idle-actions">
          <NotchAction
            label={t("notch.actions.message")}
            disabled={busy}
            onClick={() => void launch(false)}
            data-primary
          >
            <MessageCircle aria-hidden />
          </NotchAction>
          <NotchAction
            label={t("notch.actions.call")}
            variant="ghost"
            disabled={busy}
            onClick={() => void launch(true)}
          >
            <Mic aria-hidden />
          </NotchAction>
          {routine && (
            <NotchAction
              label={t(
                routine.enabled ? "notch.actions.pause" : "notch.actions.resume"
              )}
              variant="ghost"
              disabled={busy}
              onClick={toggle}
            >
              {routine.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
            </NotchAction>
          )}
          <NotchAction
            label={t("notch.actions.open")}
            variant="ghost"
            onClick={() =>
              void transport.client.notch.openInApp({
                kind: "bot",
                botId: bot.id,
              })
            }
          >
            <ExternalLink aria-hidden />
          </NotchAction>
        </div>
      )}
      {error && <p role="alert">{t("notch.reply.openFailed")}</p>}
    </motion.div>
  );
};
