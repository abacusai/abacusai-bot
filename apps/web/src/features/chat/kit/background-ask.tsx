/**
 * The one ask, under a reply after a result, to keep the app running in the
 * background and open it at login (contract background.ts), so a reminder can
 * still reach the user once the window is closed. Windows and Linux only.
 */
import {
  type BackgroundAskState,
  backgroundAskWanted,
  keepsRunningInBackground,
} from "@abacus-ai/contract/background";
import type { BackgroundAskCard } from "@abacus-ai/contract/contract/rows";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { turnsOf } from "#renderer/lib/bot-turns/turns";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";
import { hiddenUserMessage } from "#renderer/lib/user-message";
import { Button } from "#renderer/ui/button";

import { useHost, useThreadStore } from "../store/selectors";
import { useChatView } from "./context";
import { useTailCardClaim, useTailCards } from "./tail-cards";
import { isLive } from "./upgrade-triggers";

/** Lets the reply's own cards claim the space first, and still comes before the rating line's wait. */
const SETTLE_MS = 1000;

/** The latest turn's last reply, when the user's own message opened it. */
export const backgroundAskTarget = (
  messages: readonly UIMessage[]
): string | null => {
  const turn = turnsOf(messages).at(-1);
  if (turn == null || turn.userIndex < 0) return null;
  if (hiddenUserMessage(messages[turn.userIndex]!)) return null;
  const last = turn.assistantIndices.at(-1);
  return last == null ? null : messages[last]!.id;
};

/**
 * Whether the card shows under `reply`: the reply it was shown under, until
 * answered; else a new ask once the reply settled with no other card on it.
 */
export const backgroundAskShows = (
  card: BackgroundAskCard | null | undefined,
  reply: string,
  fresh: BackgroundAskState & { settled: boolean }
): boolean =>
  card != null
    ? card.reply === reply && !card.answered
    : fresh.settled && backgroundAskWanted({ ...fresh, asked: false });

export const BackgroundAskRow = ({
  messages,
  active,
}: {
  messages: readonly UIMessage[];
  active: boolean;
}) => {
  const { t } = useTranslation();
  const { session, composer, slots } = useChatView();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const db = useDb();
  const prefs = usePrefs();
  const tail = useTailCards(session.threadId);
  const preview = slots.backgroundAskPreview === true;
  const outcome = useThreadStore(session, (state) =>
    state.runs.outcomes.at(-1)
  );
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  const info = useQuery({
    ...transport.orpc.system.info.queryOptions({ input: {} }),
    enabled: IS_ELECTRON && !preview,
  });
  const platform = preview ? "win32" : (info.data?.platform ?? null);
  const desktop = platform === "win32" || platform === "linux";
  const loginKey = transport.orpc.system.loginItem.get.queryKey({ input: {} });
  const login = useQuery({
    ...transport.orpc.system.loginItem.get.queryOptions({ input: {} }),
    enabled: IS_ELECTRON && desktop && !preview,
    retry: false,
  });
  const [settledOn, setSettledOn] = useState<string | null>(null);
  const [answeredHere, setAnsweredHere] = useState<string | null>(null);

  const card = preview ? null : prefs.dismissals.backgroundAsk;
  const reply = backgroundAskTarget(messages);
  const ended = outcome != null && (isLive(outcome) || sentHere);
  const eligible =
    (IS_ELECTRON || preview) &&
    reply != null &&
    !active &&
    composer.readOnly == null &&
    outcome?.kind === "success" &&
    answeredHere !== reply;
  const state: BackgroundAskState = {
    platform,
    keepRunning: keepsRunningInBackground(prefs),
    openAtLogin: preview
      ? false
      : login.isSuccess
        ? login.data.openAtLogin
        : null,
    asked: card != null,
  };
  const candidate =
    eligible && card == null && ended && backgroundAskWanted(state)
      ? reply
      : null;
  // Settled only on a reply no other card took; its own claim comes after.
  const settle = useEffectEvent((id: string) => {
    if (!tail.claimed) setSettledOn(id);
  });
  useEffect(() => {
    if (candidate == null) return;
    const timer = setTimeout(() => settle(candidate), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [candidate]);

  const showing =
    eligible &&
    (preview ||
      backgroundAskShows(card, reply, {
        ...state,
        settled: settledOn === reply,
      }))
      ? reply
      : null;

  const write = (next: BackgroundAskCard): void => {
    if (preview) return;
    void db
      .updatePrefs({ dismissals: { backgroundAsk: next } })
      .catch(() => undefined);
  };
  const funnel = (
    step: "background_ask_shown" | "background_ask_answered",
    detail: string
  ): void => {
    if (preview) return;
    void transport.client.system
      .funnelStep({ step, detail })
      .catch(() => undefined);
  };

  // Recorded when it first comes on screen: it is never asked again.
  const shown = useEffectEvent((id: string) => {
    if (card != null) return;
    write({ reply: id, answered: false });
    funnel("background_ask_shown", platform ?? "unknown");
  });
  useEffect(() => {
    if (showing != null) shown(showing);
  }, [showing]);

  useTailCardClaim(session.threadId, showing);
  if (showing == null) return null;

  const answer = (on: boolean): void => {
    setAnsweredHere(showing);
    write({ reply: showing, answered: true });
    funnel("background_ask_answered", on ? "on" : "later");
    if (!on || preview) return;
    void db
      .updatePrefs({ keepRunningInBackground: true })
      .catch(() => undefined);
    if (state.openAtLogin !== false) return;
    void transport.client.system.loginItem
      .set({ openAtLogin: true })
      .then((value) => cache.setQueryData(loginKey, value))
      .catch(() => undefined);
  };

  return (
    <section
      data-slot="background-ask"
      aria-label={t("chat.backgroundAsk.title")}
      className="bg-background my-2 flex w-full max-w-[520px] items-start gap-3 rounded-2xl border p-3"
    >
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-[10px]"
      >
        <BellRing className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">
            {t("chat.backgroundAsk.title")}
          </h2>
          <p className="text-muted-foreground text-xs leading-snug">
            {t("chat.backgroundAsk.body")}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            className="rounded-full"
            data-action="turn-on"
            onClick={() => answer(true)}
          >
            {t("chat.backgroundAsk.turnOn")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground rounded-full"
            data-action="not-now"
            onClick={() => answer(false)}
          >
            {t("chat.backgroundAsk.notNow")}
          </Button>
        </div>
      </div>
    </section>
  );
};
