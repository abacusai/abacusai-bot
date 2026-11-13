import {
  conversationRefFromKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import { BrowserAskHost } from "#platform/ask-host";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { followNotice } from "#renderer/data/queries/notices";
import {
  documentSoundPlayer,
  setDocumentSoundPrefs,
} from "#renderer/lib/document-sound";
import { isThreadSeen } from "#renderer/lib/navigation/visible-thread";
import { createNotifier } from "#renderer/lib/notify";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { subscribeRunFinished } from "#renderer/lib/run-finished";

import { followSessionsSources } from "./data/live";
import { useSessionsTransport } from "./data/queries";
import { markSessionUnread } from "./data/unread-store";
import { adoptAgentBrowser } from "./dock/agent-browser";
import { recordBackgroundPreview } from "./files/preview-bridge";
import { handleSessionRunFinished, notifySessionAsk } from "./notify";
interface PreviewEvent {
  conversationKey?: string;
  path?: string;
  url?: string;
  id?: string;
}
export const SessionsGlobals = ({
  preview,
}: {
  preview: (event: PreviewEvent) => false | Promise<boolean>;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const db = useDb();
  const prefs = usePrefs();
  const qc = useQueryClient();
  const notifications = useQuery(
    transport.orpc.settings.notifications.get.queryOptions({ input: {} })
  );
  useEffect(() => setDocumentSoundPrefs(prefs.sounds), [prefs.sounds]);
  const latest = useRef({ prefs, notifications });
  useEffect(() => {
    latest.current = { prefs, notifications };
  }, [prefs, notifications]);
  const notifier = useRef<ReturnType<typeof createNotifier> | null>(null);
  useEffect(() => {
    notifier.current = createNotifier({
      isWindowFocused: () => document.hasFocus(),
      notificationsEnabled: () =>
        latest.current.notifications.data?.enabled ?? true,
      sounds: () => latest.current.prefs.sounds,
      now: () => new Date(),
      send: (input) => platformSystem(transport.client).notify(input),
    });
  }, [transport]);
  const deps = () => ({
    sessions: () => db.collections.sessions.toArray,
    seen: isThreadSeen,
    mark: markSessionUnread,
    player: documentSoundPlayer(),
    notifier: {
      notify: (
        notice: Parameters<ReturnType<typeof createNotifier>["notify"]>[0]
      ) => notifier.current?.notify(notice) ?? false,
    },
    labels: {
      done: t("sessions.notify.done"),
      needsYou: t("sessions.notify.needsYou"),
      failed: (name: string) =>
        name.trim() === "" || name === "Untitled"
          ? t("sessions.notify.failedPlain")
          : t("sessions.notify.failed", { name }),
      failedBody: t("sessions.notify.failedBody"),
    },
  });
  const finished = useEffectEvent(
    (notice: Parameters<typeof handleSessionRunFinished>[1]) =>
      handleSessionRunFinished(deps(), notice)
  );
  const ask = useEffectEvent((id: string, key: string) =>
    notifySessionAsk(deps(), id, key)
  );
  const show = useEffectEvent((event: PreviewEvent) => {
    const drawn = preview(event);
    // No pane of that conversation is mounted: main keeps the target until
    // one mounts; meanwhile its session gets the tab and the unread mark.
    if (drawn === false) recordBackgroundPreview(db, event);
    // Once the page drew (or failed to): main forgets it and tells the agent.
    else if (event.id != null && event.conversationKey != null) {
      const { id, conversationKey } = event;
      void drawn
        .then((shown) =>
          transport.client.files.previewHandled({
            conversationKey: conversationKey as ConversationKey,
            id,
            shown,
          })
        )
        .catch(() => undefined);
    }
  });
  useEffect(() => {
    const abort = new AbortController();
    followSessionsSources(transport, db.collections, qc, abort.signal);
    const ready = async () => {
      while (!abort.signal.aborted) {
        try {
          await db.collections.sessions.preload();
          return;
        } catch {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 250);
            abort.signal.addEventListener("abort", done, { once: true });
          });
        }
      }
    };
    const snapshots = ready();
    const unsub = subscribeRunFinished(transport, async (notice) => {
      await snapshots;
      if (abort.signal.aborted) return;
      finished(notice);
      // The turn spent credits: refresh the pill now, not on the next poll.
      if (notice.outcome !== "cancelled")
        void qc.invalidateQueries({
          queryKey: transport.orpc.account.abacus.queryKey(),
        });
    });
    let first = true;
    const waiting = new Set<string>();
    followNotice(
      "attention",
      transport,
      (event) => {
        if (event.type === "snapshot") {
          waiting.clear();
          for (const item of event.items) waiting.add(item.threadId);
          first = false;
        } else if (event.type === "remove") waiting.delete(event.threadId);
        else {
          if (!first && !waiting.has(event.item.threadId))
            ask(
              event.item.threadId,
              `${event.item.threadId}:${event.item.oldestAt}`
            );
          waiting.add(event.item.threadId);
        }
      },
      abort.signal
    );
    followNotice(
      "connectors",
      transport,
      (event) => {
        if (event.type === "request") {
          const ref = conversationRefFromKey(event.request.conversationKey);
          if (ref?.kind === "session")
            ask(ref.sessionId, event.request.requestId);
        }
      },
      abort.signal
    );
    followNotice(
      "files",
      transport,
      (event) => {
        if (event.type === "preview-open")
          show({
            conversationKey: event.conversationKey,
            path: event.path,
            ...(event.id == null ? {} : { id: event.id }),
          });
      },
      abort.signal
    );
    if (IS_ELECTRON)
      followNotice(
        "browser",
        transport,
        (event) => {
          if (event.type === "open-preview")
            show({ conversationKey: event.conversationKey, url: event.url });
          else if (event.type === "runtime-materialized")
            adoptAgentBrowser(db, event, isThreadSeen);
        },
        abort.signal
      );
    const unlock = () => documentSoundPlayer().unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => {
      unsub();
      abort.abort();
      window.removeEventListener("pointerdown", unlock);
    };
  }, [transport, db, qc]);
  return <BrowserAskHost />;
};
