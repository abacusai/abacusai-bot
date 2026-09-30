import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { followNotices } from "#next/data/queries/live";
import type { OpenTarget } from "#shared/contract";
export const openTargetHref = (target: OpenTarget): string => {
  if (target.kind === "bot")
    return `/bots/${encodeURIComponent(target.botId)}${target.sessionId ? `/chats/${encodeURIComponent(target.sessionId)}` : ""}`;
  if (target.kind === "routine-run")
    return `/routines/${encodeURIComponent(target.routineId)}?run=${encodeURIComponent(target.sessionId)}`;
  return `/sessions/${encodeURIComponent(target.sessionId)}`;
};
/** Newer commands supersede navigation, but every accepted command is acknowledged after resolution. */
export const OpenTargetBridge = () => {
  const router = useRouter();
  const { transport } = router.options.context;
  useEffect(() => {
    const abort = new AbortController();
    const lifetime = { generation: 0 };
    const acknowledged = new Set<string>();
    void followNotices(
      transport,
      ({ signal }) => transport.client.notch.openCommands({}, { signal }),
      (command) => {
        if (acknowledged.has(command.id)) return;
        lifetime.generation += 1;
        const token = lifetime.generation;
        void router
          .navigate({ href: openTargetHref(command.target) })
          .then(async () => {
            if (abort.signal.aborted || token !== lifetime.generation) return;
            acknowledged.add(command.id);
            await transport.client.notch.ackOpen({ id: command.id });
          })
          .catch((error) => console.warn("[notch] open deferred", error));
      },
      abort.signal
    );
    return () => {
      lifetime.generation += 1;
      abort.abort();
    };
  }, [router, transport]);
  return null;
};
