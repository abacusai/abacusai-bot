import { Store, useStore } from "@tanstack/react-store";
/**
 * A free account's chat on another provider's model: the notice offering
 * RouteLLM, shown right after a failed turn and every 30 minutes
 * (routellm-nudge.ts).
 */
import { Sparkles } from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useChatView } from "../kit/context";
import type { ModelChipBinding } from "../kit/context";
import { useThreadStore } from "../store/selectors";
import { nudgeDueAt, nudgesDone } from "./routellm-nudge";

// Chats with the notice up now; "Keep" takes it down until the next moment.
const showing = new Store<Record<string, boolean>>({});
const setShowing = (threadId: string, on: boolean): void =>
  showing.setState((state) => ({ ...state, [threadId]: on }));

/**
 * The latest turn ended on the cut-off card, which offers RouteLLM - Open
 * itself: the notice stays down meanwhile, and the card is not one of its
 * five showings.
 */
const endedOnCutOff = (
  outcome: { kind: string; error?: unknown } | null
): boolean =>
  outcome?.kind === "error" &&
  (
    (outcome.error as { actions?: Array<{ type?: string }> } | undefined)
      ?.actions ?? []
  ).some((action) => action.type === "cut-off");

type FunnelStep =
  | "routellm_nudge_shown"
  | "routellm_nudge_switched"
  | "routellm_nudge_kept";

export const OtherProviderNotice = ({
  threadId,
  notice,
}: {
  threadId: string;
  notice: NonNullable<ModelChipBinding["otherProvider"]>;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const { session } = useChatView();
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const latest = useThreadStore(
    session,
    (state) => state.runs.outcomes.at(-1) ?? null
  );
  const visible = useStore(showing, (state) => state[threadId] === true);
  // Runs that ended before this chat was on screen are history, not a moment.
  const seenRun = useRef(latest?.runId ?? null);

  const funnel = (step: FunnelStep) =>
    void transport.client.system.funnelStep({ step }).catch(() => undefined);
  const state = {
    nudges: prefs.dismissals.routeLlmNudges,
    at: prefs.dismissals.routeLlmNudgeAt,
    switched: prefs.dismissals.routeLlmSwitched,
  };
  const cutOff = endedOnCutOff(latest);
  const show = useEffectEvent(() => {
    if (visible || cutOff || nudgesDone(state)) return;
    const now = Date.now();
    setShowing(threadId, true);
    funnel("routellm_nudge_shown");
    void updatePrefs({
      dismissals: { routeLlmNudges: state.nudges + 1, routeLlmNudgeAt: now },
    }).catch(() => undefined);
  });

  // Every 30 minutes since it last showed: due now the first time, and not
  // behind a cut-off card (due again once the chat has moved past it).
  const dueAt = visible || cutOff ? null : nudgeDueAt(state);
  useEffect(() => {
    if (dueAt == null) return;
    const timer = window.setTimeout(show, Math.max(0, dueAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [dueAt]);

  // Right after a turn on this model fails.
  useEffect(() => {
    if (latest == null || latest.runId === seenRun.current) return;
    seenRun.current = latest.runId;
    if (latest.kind === "error") show();
  }, [latest]);

  if (!visible || cutOff) return null;
  return (
    <section data-slot="other-provider-notice" className="mb-2">
      <div className="bg-card border-border overflow-hidden rounded-xl border">
        <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
          <Sparkles aria-hidden className="text-primary size-4 shrink-0" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed">
            {t(
              notice.free
                ? "chat.composer.otherProviderFree"
                : "chat.composer.otherProvider",
              { model: notice.model, provider: notice.provider }
            )}
          </p>
          <div className="flex w-40 shrink-0 flex-col gap-1.5">
            <Button
              size="sm"
              className="h-7 w-full rounded-lg"
              onClick={() => {
                funnel("routellm_nudge_switched");
                void updatePrefs({
                  dismissals: { routeLlmSwitched: true },
                }).catch(() => undefined);
                notice.onSwitch();
              }}
            >
              {t("chat.composer.switchToRouteLlm")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-full rounded-lg"
              onClick={() => {
                setShowing(threadId, false);
                funnel("routellm_nudge_kept");
              }}
            >
              {t("chat.composer.keepModel")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};
