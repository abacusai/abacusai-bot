import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useRef, useState } from "react";

import { useDb } from "#next/data/db";
import { usePrefs } from "#next/data/db/prefs";
import { followNotices } from "#next/data/queries/live";
import type { Transport } from "#next/data/transport";
import { applyAttention, emptyAttention } from "#next/lib/attention/events";
import { runFinishedFeed } from "#next/lib/run-finished";
import type { NotchEvent, RunFinishedNotice } from "#shared/contract";
import { conversationRefFromKey } from "#shared/conversation-scope";

import type { NotchInputs } from "./presenter";
import { activeSnoozes, type Snooze } from "./snooze";
export const useNotchInputs = (
  transport: Transport,
  app: { mainFocused: boolean },
  hovered: boolean,
  acks: ReadonlySet<string>,
  snoozed: ReadonlyMap<string, Snooze>
): NotchInputs => {
  const db = useDb();
  const prefs = usePrefs();
  const { data: sessions } = useLiveQuery(db.collections.sessions);
  const { data: bots } = useLiveQuery(db.collections.bots);
  const { data: routines } = useLiveQuery(db.collections.routines);
  const [attention, setAttention] = useState(emptyAttention);
  const [asks, setAsks] = useState<NotchInputs["asks"]>([]);
  const [notices, setNotices] = useState<
    { notice: RunFinishedNotice; age: number }[]
  >([]);
  const [now, setNow] = useState(Date.now);
  const clock = useRef({
    at: now,
    visible: document.visibilityState === "visible",
  });
  useEffect(() => {
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => {
        setAttention(emptyAttention());
        return transport.client.ai.attention({}, { signal });
      },
      (event) => setAttention((state) => applyAttention(state, event)),
      abort.signal
    );
    const stopFinished = runFinishedFeed(transport).subscribe((notice) =>
      setNotices((state) =>
        [
          ...state.filter((n) => n.notice.threadId !== notice.threadId),
          { notice, age: 0 },
        ].slice(-500)
      )
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.connectors.events({}, { signal }),
      (event) => {
        if (event.type === "snapshot" || event.type === "request") {
          const requests =
            event.type === "snapshot" ? event.requests : [event.request];
          const next = requests.flatMap((request) => {
            const ref = conversationRefFromKey(request.conversationKey);
            return ref?.kind === "session"
              ? [
                  {
                    id: request.requestId,
                    sessionId: ref.sessionId,
                    since: Date.now(),
                  },
                ]
              : [];
          });
          setAsks((state) =>
            event.type === "snapshot"
              ? next
              : [
                  ...state.filter((a) => !next.some((b) => b.id === a.id)),
                  ...next,
                ]
          );
        } else if (event.type === "cleared")
          setAsks((state) => state.filter((a) => a.id !== event.requestId));
      },
      abort.signal
    );
    const tick = () => {
      const now = Date.now();
      setNow(now);
      const elapsed = clock.current.visible ? now - clock.current.at : 0;
      clock.current.at = now;
      if (elapsed)
        setNotices((state) =>
          state.map((n) => ({ ...n, age: n.age + elapsed }))
        );
    };
    let timer: ReturnType<typeof setInterval> | null = null;
    let epoch = 0;
    const visibility = () => {
      tick();
      clock.current.visible = document.visibilityState === "visible";
      if (timer) clearInterval(timer);
      timer = clock.current.visible ? setInterval(tick, 1000) : null;
      void transport.client.notch
        .visibility({ documentVisible: clock.current.visible, epoch })
        .catch(() => undefined);
    };
    void followNotchEvents(
      transport,
      (event) => {
        if (event.type === "visibility-request") {
          epoch = event.epoch;
          visibility();
        }
      },
      abort.signal
    );
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      abort.abort();
      stopFinished();
      document.removeEventListener("visibilitychange", visibility);
      if (timer) clearInterval(timer);
    };
  }, [transport]);
  return {
    now,
    sessions: sessions ?? [],
    bots: bots ?? [],
    routines: routines ?? [],
    summaries: attention.items,
    asks,
    notices,
    prefs,
    mainFocused: app.mainFocused,
    hovered,
    acks,
    snoozed: activeSnoozes(
      snoozed,
      now,
      (id) => attention.items.get(id)?.firstDescriptorId
    ),
  };
};
export const followNotchEvents = (
  transport: Transport,
  receive: (event: NotchEvent) => void,
  signal: AbortSignal
) =>
  followNotices(
    transport,
    ({ signal }) => transport.client.notch.events({}, { signal }),
    receive,
    signal
  );
