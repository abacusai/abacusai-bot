import { conversationRefFromKey } from "@abacus-ai/contract/conversation-scope";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import { lazy } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { followNotices } from "#renderer/data/queries/live";
import {
  documentSoundPlayer,
  setDocumentSoundPrefs,
} from "#renderer/lib/document-sound";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { isThreadSeen } from "#renderer/lib/navigation/visible-thread";
import { createNotifier } from "#renderer/lib/notify";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { subscribeRunFinished } from "#renderer/lib/run-finished";
const BrowserAskHost = IS_ELECTRON
  ? lazy(() =>
      import("./browser/ask-host").then((m) => ({ default: m.BrowserAskHost }))
    )
  : () => null;
import { followSessionsSources } from "./data/live";
import { useSessionsTransport } from "./data/queries";
import { markSessionUnread } from "./data/unread-store";
import { recordBackgroundPreview } from "./files/preview-bridge";
import { handleSessionRunFinished, notifySessionAsk } from "./notify";
export const SessionsGlobals = ({
  preview,
}: {
  preview: (event: {
    conversationKey?: string;
    path?: string;
    url?: string;
  }) => boolean;
}) => {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
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
    },
  });
  const finished = useEffectEvent(
    (notice: Parameters<typeof handleSessionRunFinished>[1]) =>
      handleSessionRunFinished(deps(), notice)
  );
  const ask = useEffectEvent((id: string, key: string) =>
    notifySessionAsk(deps(), id, key)
  );
  const show = useEffectEvent((event: Parameters<typeof preview>[0]) => {
    if (!preview(event)) recordBackgroundPreview(db, event);
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
      if (!abort.signal.aborted) finished(notice);
    });
    let first = true;
    const waiting = new Set<string>();
    void followNotices(
      transport,
      ({ signal }) => transport.client.ai.attention({}, { signal }),
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
    void followNotices(
      transport,
      ({ signal }) => transport.client.connectors.events({}, { signal }),
      (event) => {
        if (event.type === "request") {
          const ref = conversationRefFromKey(event.request.conversationKey);
          if (ref?.kind === "session")
            ask(ref.sessionId, event.request.requestId);
        }
      },
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.files.events({}, { signal }),
      (event) => {
        if (event.type === "preview-open")
          show({ conversationKey: event.conversationKey, path: event.path });
      },
      abort.signal
    );
    if (IS_ELECTRON)
      void followNotices(
        transport,
        ({ signal }) => transport.client.browser.events({}, { signal }),
        (event) => {
          if (event.type === "open-preview")
            show({ conversationKey: event.conversationKey, url: event.url });
        },
        abort.signal
      );
    void followNotices(
      transport,
      ({ signal }) => transport.client.system.events({}, { signal }),
      (event) => {
        const id = event.metadata.sessionId;
        if (!id) return;
        const row = db.collections.sessions.get(id);
        if (row?.owner?.kind === "bot")
          void navigate({
            to: "/bots/$botId",
            params: { botId: row.owner.botId },
            transition: "nav-lateral",
          });
        else if (row)
          void navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: id },
            transition: "nav-lateral",
          });
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
  }, [transport, db, qc, navigate]);
  return <BrowserAskHost />;
};
