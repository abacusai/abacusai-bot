import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { followNotices } from "#renderer/data/queries/live";
import { useCapability } from "#renderer/lib/capabilities";
import type { OpenCommand, OpenTarget } from "#shared/contract";
export const openTargetHref = (target: OpenTarget): string => {
  if (target.kind === "bot")
    return `/bots/${encodeURIComponent(target.botId)}${target.sessionId ? `/chats/${encodeURIComponent(target.sessionId)}` : ""}`;
  if (target.kind === "routine-run")
    return `/routines/${encodeURIComponent(target.routineId)}?run=${encodeURIComponent(target.sessionId)}`;
  return `/sessions/${encodeURIComponent(target.sessionId)}`;
};
/** Navigation and acknowledgement have separate retry boundaries. */
export const openCommandReceiver = (deps: {
  navigate(href: string): Promise<unknown>;
  ack(id: string): Promise<unknown>;
  signal: AbortSignal;
}) => {
  let generation = 0;
  const committed = new Set<string>();
  const acknowledged = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  return (command: OpenCommand): Promise<void> => {
    if (deps.signal.aborted || acknowledged.has(command.id))
      return Promise.resolve();
    const existing = pending.get(command.id);
    if (existing) return existing;
    const token = committed.has(command.id) ? generation : ++generation;
    const work = (async () => {
      if (!committed.has(command.id)) {
        await deps.navigate(openTargetHref(command.target));
        if (deps.signal.aborted || token !== generation) return;
        committed.add(command.id);
      }
      if (deps.signal.aborted) return;
      await deps.ack(command.id);
      acknowledged.add(command.id);
    })();
    pending.set(command.id, work);
    void work.then(
      () => pending.delete(command.id),
      () => pending.delete(command.id)
    );
    return work;
  };
};
/** Newer commands supersede navigation; acknowledgement follows route resolution. */
export const OpenTargetBridge = () => {
  const router = useRouter();
  const { transport } = router.options.context;
  const notch = useCapability("notch");
  useEffect(() => {
    // Only a desktop with a notch companion sends these.
    if (!notch) return;
    const abort = new AbortController();
    const receive = openCommandReceiver({
      signal: abort.signal,
      navigate: (href) => router.navigate({ href }),
      ack: (id) => transport.client.notch.ackOpen({ id }),
    });
    void followNotices(
      transport,
      ({ signal }) => transport.client.notch.openCommands({}, { signal }),
      (command) => {
        void receive(command).catch((error) =>
          console.warn("[notch] open deferred", error)
        );
      },
      abort.signal
    );
    return () => abort.abort();
  }, [router, transport, notch]);
  return null;
};
