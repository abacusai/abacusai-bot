import { conversationRefFromKey } from "@abacus-ai/contract/conversation-scope";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { cueClaim } from "#platform/attention";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import { followNotice } from "#renderer/data/queries/notices";
import { permissionCueKey } from "#renderer/lib/attention/cues";
import { createNotifier, notifyAttention } from "#renderer/lib/notify";
import { platformSystem } from "#renderer/lib/platform-system";
import { createReadinessQueue } from "#renderer/lib/readiness-queue";
import { subscribeRunFinished } from "#renderer/lib/run-finished";
import { createSoundPlayer } from "#renderer/lib/sound";
import { showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";

import { hostedRunFailed, hostedUnread } from "./hosted";
import {
  completionNotice,
  createFireHandler,
  hostedAwayNotice,
  hostedRunNotice,
  remember,
  routineOwns,
} from "./notify";
const seenFires = new WeakMap<object, Set<string>>();
const seenHosted = new WeakMap<object, Set<string>>();
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
  const router = useRouter();
  const { transport, db } = useAppContext();
  const { t } = useTranslation();
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
        document.hasFocus() &&
        Boolean(
          router.matchRoute(
            {
              to: "/sessions/$sessionId",
              params: { sessionId: id },
            },
            { fuzzy: true }
          )
        ),
      isWindowFocused: () => document.hasFocus(),
      prefs: sounds,
      now: () => Date.now(),
      claim: cueClaim(transport),
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
        send: (input) => platformSystem(transport.client).notify(input),
      },
      seenFor(seenNotices, transport)
    );
    const abort = new AbortController();
    const routines = db.collections.routines.subscribeChanges(() => {});
    const sessions = db.collections.sessions.subscribeChanges(() => {});
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
    const hosted = (event: Parameters<typeof fire>[0]) => {
      const notice = hostedRunNotice(
        event,
        db.collections.routines.toArray,
        seenFor(seenHosted, transport)
      );
      if (!notice) return;
      const failed = hostedRunFailed(notice.run);
      if (notice.routineId) hostedUnread.add(notice.routineId, notice.run.id);
      player.play(failed ? "failed" : "done", {
        threadId: notice.routineId ?? notice.run.id,
        dedupeKey: notice.run.id,
        botId: notice.botId,
      });
      notifyAttention(notifier, {
        kind: failed ? "failed" : "done",
        dedupeKey: notice.run.id,
        botId: notice.botId,
        title: notice.name,
        // The server sends the out-of-credits WhatsApp notice itself; this is the in-app one.
        body: t(
          notice.run.status === "payment_required"
            ? "routines.hosted.notifyCredits"
            : failed
              ? "routines.hosted.notifyFailed"
              : "routines.hosted.notifyDone"
        ),
        metadata: {
          kind: "routine",
          routineId: notice.routineId ?? "",
          sessionId: "",
        },
      });
    };
    // What came in while the app was away for over a day: one notice in all.
    const away = (event: Parameters<typeof fire>[0]) => {
      const runs = hostedAwayNotice(
        event,
        db.collections.routines.toArray,
        seenFor(seenHosted, transport)
      );
      if (!runs) return;
      for (const { routineId, run } of runs)
        if (routineId) hostedUnread.add(routineId, run.id);
      notifyAttention(notifier, {
        kind: "done",
        dedupeKey: `away:${runs[0]!.run.id}`,
        botId: null,
        title: t("routines.hosted.awayTitle"),
        body: t("routines.hosted.away", { count: runs.length }),
        metadata: {
          kind: "routine",
          // Opens the latest one's routine.
          routineId: runs.at(-1)!.routineId ?? "",
          sessionId: "",
        },
      });
    };
    // Every routine the agent sets up is the user's to know of.
    const created = (event: Parameters<typeof fire>[0]) => {
      if (event.type !== "created") return;
      if (
        !remember(seenFor(seenHosted, transport), `created:${event.routineId}`)
      )
        return;
      const body = t("routines.createdByAgent", { name: event.name });
      showInfo(body);
      notifyAttention(notifier, {
        kind: "done",
        dedupeKey: `created:${event.routineId}`,
        botId: null,
        title: event.name,
        body,
        metadata: {
          kind: "routine",
          routineId: event.routineId,
          sessionId: "",
        },
      });
    };
    followNotice(
      "routines",
      transport,
      (event) =>
        readiness.run(() => {
          fire(event);
          hosted(event);
          away(event);
          created(event);
        }),
      abort.signal
    );
    const waiting = new Set<string>();
    const attention = (threadId: string, key: string) => {
      const session = db.collections.sessions.get(threadId);
      const routine = db.collections.routines.get(session?.routineId ?? "");
      if (!routineOwns(routine) || !routine) return;
      player.play("needs-you", {
        threadId,
        botId: routine.botId ?? null,
        dedupeKey: key,
      });
      notifyAttention(notifier, {
        kind: "needs-you",
        dedupeKey: key,
        botId: routine.botId ?? null,
        title: routine.name,
        body: t("phase5.routineNeedsYou", { name: routine.name }),
        metadata: {
          kind: "routine",
          routineId: routine.id,
          sessionId: threadId,
        },
      });
    };
    followNotice(
      "attention",
      transport,
      (event) =>
        readiness.run(() => {
          if (event.type === "upsert") {
            const summary = event.item;
            const key = permissionCueKey(summary);
            if (!waiting.has(key)) {
              waiting.add(key);
              attention(summary.threadId, key);
            }
          }
        }),
      abort.signal
    );
    followNotice(
      "connectors",
      transport,
      (event) => {
        if (event.type !== "request") return;
        const ref = conversationRefFromKey(event.request.conversationKey);
        if (ref?.kind === "session")
          readiness.run(() =>
            attention(ref.sessionId, event.request.requestId)
          );
      },
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
          dedupeKey: notice.runId,
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
          metadata: {
            kind: "routine",
            routineId: target.routine.id,
            sessionId: notice.threadId,
          },
        });
      })
    );
    return () => {
      abort.abort();
      routines.unsubscribe();
      sessions.unsubscribe();
      unsubscribe();
      document.removeEventListener("pointerdown", unlock);
      player.dispose();
    };
  }, [transport, db, t, cache, router]);
  return null;
};
