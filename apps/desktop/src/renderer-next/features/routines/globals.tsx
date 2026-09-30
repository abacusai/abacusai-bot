import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_PREFS } from "#next/data/db/prefs";
import { followNotices } from "#next/data/queries/live";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { createNotifier, notifyAttention } from "#next/lib/notify";
import { createReadinessQueue } from "#next/lib/readiness-queue";
import { subscribeRunFinished } from "#next/lib/run-finished";
import { createSoundPlayer } from "#next/lib/sound";
import { useAppContext } from "#next/lib/use-app-context";
import { conversationRefFromKey } from "#shared/conversation-scope";

import { routineConnectorThreads } from "./attention";
import { routineOwns } from "./notify";
import { completionNotice, createFireHandler } from "./notify";
const seenFires = new WeakMap<object, Set<string>>();
const seenNotices = new WeakMap<object, Set<string>>();
const seenFor = (map: WeakMap<object, Set<string>>, key: object) => {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
};
export const RoutinesGlobals = () => {
  const { transport, db } = useAppContext();
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const settings = useQuery(
    transport.orpc.settings.notifications.get.queryOptions({ input: {} })
  );
  const cache = useQueryClient();
  void settings;
  useEffect(() => {
    const sounds = () =>
      db.collections.prefs.get("app")?.sounds ?? DEFAULT_PREFS.sounds;
    const player = createSoundPlayer({
      isThreadVisible: (id) =>
        document.hasFocus() && window.location.hash.includes(id),
      isWindowFocused: () => document.hasFocus(),
      prefs: sounds,
      now: () => Date.now(),
    });
    const unlock = () => player.unlock();
    document.addEventListener("pointerdown", unlock);
    const notifier = createNotifier(
      {
        isWindowFocused: () => document.hasFocus(),
        notificationsEnabled: () =>
          cache.getQueryData<{ enabled: boolean }>(
            transport.orpc.settings.notifications.get.queryKey({ input: {} })
          )?.enabled ?? true,
        sounds,
        now: () => new Date(),
        send: (input) => transport.client.system.notify(input),
      },
      seenFor(seenNotices, transport)
    );
    const abort = new AbortController();
    const readiness = createReadinessQueue(
      () =>
        Promise.all([
          db.collections.routines.preload(),
          db.collections.sessions.preload(),
        ]),
      abort.signal
    );
    const fire = createFireHandler(
      () => db.collections.routines.toArray,
      (id, botId) => player.play("routine-fired", { threadId: id, botId }),
      seenFor(seenFires, transport)
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.routines.events({}, { signal }),
      (event) => readiness.run(() => fire(event)),
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.system.events({}, { signal }),
      (event) =>
        readiness.run(() => {
          const session = db.collections.sessions.get(
            event.metadata.sessionId ?? ""
          );
          const routine = db.collections.routines.get(session?.routineId ?? "");
          if (session && routineOwns(routine) && routine)
            void navigate({
              to: "/routines/$routineId",
              params: { routineId: routine.id },
              search: { run: session.id },
              transition: "nav-forward",
            });
        }),
      abort.signal
    );
    const waiting = new Set<string>();
    const attention = (threadId: string, key: string) => {
      const session = db.collections.sessions.get(threadId);
      const routine = db.collections.routines.get(session?.routineId ?? "");
      if (!routineOwns(routine) || !routine) return;
      player.play("needs-you", { threadId, botId: routine.botId ?? null });
      notifyAttention(notifier, {
        kind: "needs-you",
        dedupeKey: key,
        botId: routine.botId ?? null,
        title: routine.name,
        body: t("phase5.routineNeedsYou", { name: routine.name }),
        metadata: { sessionId: threadId },
      });
    };
    void followNotices(
      transport,
      ({ signal }) => transport.client.ai.attention({}, { signal }),
      (event) =>
        readiness.run(() => {
          if (event.type === "upsert") {
            const summary = event.item;
            const key = `${summary.threadId}:${summary.incarnation}:${summary.oldestAt}`;
            if (!waiting.has(key)) {
              waiting.add(key);
              attention(summary.threadId, key);
            }
          }
        }),
      abort.signal
    );
    const requests = new Map<string, string>();
    void followNotices(
      transport,
      ({ signal }) => transport.client.connectors.events({}, { signal }),
      (event) =>
        readiness.run(() => {
          const put = (r: import("#shared/contracts").ConnectorRequest) => {
            const ref = conversationRefFromKey(r.conversationKey);
            if (ref?.kind === "session")
              requests.set(r.requestId, ref.sessionId);
          };
          if (event.type === "snapshot") {
            requests.clear();
            event.requests.forEach(put);
          }
          if (event.type === "request") {
            put(event.request);
            const thread = requests.get(event.request.requestId);
            if (thread) attention(thread, event.request.requestId);
          }
          if (event.type === "cleared") requests.delete(event.requestId);
          routineConnectorThreads.setState(() => [
            ...new Set(requests.values()),
          ]);
        }),
      abort.signal
    );
    const unsubscribe = subscribeRunFinished(transport, (notice) =>
      readiness.run(() => {
        const target = completionNotice(
          notice,
          db.collections.routines.toArray
        );
        if (!target) return;
        player.play(target.kind, {
          threadId: notice.threadId,
          botId: target.routine.botId ?? null,
        });
        notifyAttention(notifier, {
          kind: target.kind,
          dedupeKey: notice.runId,
          botId: target.routine.botId ?? null,
          title: target.routine.name,
          body: t(
            target.kind === "failed"
              ? "phase5.routineFailed"
              : "phase5.routineDone"
          ),
          metadata: { sessionId: notice.threadId },
        });
      })
    );
    return () => {
      abort.abort();
      unsubscribe();
      document.removeEventListener("pointerdown", unlock);
      player.dispose();
    };
  }, [transport, db, t, cache, navigate]);
  return null;
};
