/**
 * `BotsGlobals`: the bots area's document-wide subscriptions, mounted once
 * by the shell route (the sidebar is not always mounted, but unread, cues
 * and needs-you must follow every bot): the notice streams of `data/live`,
 * `ai.runFinished` for unread/cues/notifications, and the `waiting_permission`
 * level for needs-you.
 */
import { getEventMeta } from "@orpc/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#next/data/db";
import { usePrefs } from "#next/data/db/prefs";
import { followNotices } from "#next/data/queries/live";
import { isThreadSeen } from "#next/lib/navigation/visible-thread";
import { createNotifier } from "#next/lib/notify";
import { createSoundPlayer, type SoundPlayer } from "#next/lib/sound";
import type { PrefsRow } from "#shared/contract/rows";

import { followBotsSources } from "./data/live";
import { useAllSessions } from "./data/queries";
import { useBotsTransport } from "./data/transport";
import { botsUnreadStore } from "./data/unread-store";
import {
  handleRunFinished,
  handleWaiting,
  newlyWaiting,
  type BotsWatcherDeps,
} from "./notify";

let player: SoundPlayer | null = null;
let soundPrefs: PrefsRow["sounds"] = { enabled: true, perEvent: {} };

/** The document's player (one AudioContext, unlocked on first pointerdown). */
const soundPlayer = (): SoundPlayer => {
  player ??= createSoundPlayer({
    isThreadVisible: (threadId) => isThreadSeen(threadId, () => true),
    isWindowFocused: () => document.hasFocus(),
    prefs: () => soundPrefs,
    now: () => Date.now(),
  });
  return player;
};

export const BotsGlobals = () => {
  const { t } = useTranslation();
  const transport = useBotsTransport();
  const queryClient = useQueryClient();
  const db = useDb();
  const prefs = usePrefs();
  const sessions = useAllSessions();
  const notifications = useQuery(
    transport.orpc.settings.notifications.get.queryOptions({ input: {} })
  );
  useEffect(() => {
    soundPrefs = prefs.sounds;
  }, [prefs.sounds]);
  const notificationsOn = useRef(true);
  useEffect(() => {
    notificationsOn.current = notifications.data?.enabled ?? true;
  }, [notifications.data?.enabled]);

  const deps = useRef<BotsWatcherDeps | null>(null);
  useEffect(() => {
    deps.current = {
      bots: () => db.collections.bots.toArray,
      routines: () => db.collections.routines.toArray,
      seen: (threadId) => isThreadSeen(threadId),
      unread: botsUnreadStore,
      play: (cue, options) => soundPlayer().play(cue, options),
      notifier: createNotifier({
        isWindowFocused: () => document.hasFocus(),
        notificationsEnabled: () => notificationsOn.current,
        sounds: () => soundPrefs,
        now: () => new Date(),
        send: (input) => transport.client.system.notify(input),
      }),
      labels: {
        done: (bot) => ({
          title: bot,
          body: t("bots.notify.doneBody"),
        }),
        needsYou: (bot) => ({
          title: t("bots.notify.needsYouTitle", { name: bot }),
          body: t("bots.notify.needsYouBody"),
        }),
      },
    };
  }, [db, transport, t]);

  useEffect(() => {
    const abort = new AbortController();
    followBotsSources(
      { transport, queryClient, collections: db.collections },
      abort.signal
    );
    let lastEventId: string | undefined;
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.ai.runFinished(
          lastEventId == null ? {} : { lastEventId },
          { signal }
        ),
      (notice) => {
        // A reopened stream resumes after the last notice seen (§24.11).
        lastEventId = getEventMeta(notice as object)?.id ?? lastEventId;
        if (deps.current != null) handleRunFinished(deps.current, notice);
      },
      abort.signal
    );
    void db.collections.routines.preload().catch(() => undefined);
    const unlock = (): void => soundPlayer().unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => {
      abort.abort();
      window.removeEventListener("pointerdown", unlock);
    };
  }, [transport, queryClient, db]);

  const waiting = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const { next, entered } = newlyWaiting(
      waiting.current ?? new Map(),
      sessions
    );
    // The first snapshot is the state at boot, not a change.
    const first = waiting.current == null;
    waiting.current = next;
    if (first || deps.current == null) return;
    for (const session of entered) handleWaiting(deps.current, session);
  }, [sessions]);

  return null;
};
