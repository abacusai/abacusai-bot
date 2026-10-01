// Explicit memoization owns an imperative controller, including its disposal.
// eslint-disable-next-line no-restricted-imports
import { useEffect, useEffectEvent, useMemo } from "react";

import type { AppClient } from "#renderer/data/transport/types";
import type { SessionRow } from "#shared/contract/rows";
export const agentLifecycle = (
  client: AppClient,
  report: (error: unknown | null) => void,
  identity?: string,
  startOnObserve = true
) => {
  let generation = 0;
  let suppressed = false;
  let disposed = false;
  let lastStatus: string | undefined;
  let lastIncarnation: string | null = null;
  let incarnation: string | null = null;
  let starting: number | null = null;
  let restoring: { incarnation: string; token: number } | null = null;
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const cancel = () => {
    generation++;
    for (const [timer, resolve] of timers) {
      clearTimeout(timer);
      resolve();
    }
    timers.clear();
  };
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.set(timer, resolve);
    });
  const valid = (token: number) =>
    !disposed && !suppressed && token === generation;
  const restore = async (row: SessionRow, token: number) => {
    const ready = incarnation;
    if (
      !valid(token) ||
      ready === null ||
      lastIncarnation === ready ||
      (restoring?.incarnation === ready && restoring.token === token)
    )
      return;
    const attempt = { incarnation: ready, token };
    restoring = attempt;
    try {
      if (row.conversationId)
        await client.agent.switchConversation({
          workspaceId: row.workspaceId,
          sessionId: row.id,
          conversationId: row.conversationId,
        });
      if (valid(token) && incarnation === ready) lastIncarnation = ready;
    } finally {
      if (restoring === attempt) restoring = null;
    }
  };
  const matches = (row: SessionRow) =>
    identity === undefined || identity === `${row.workspaceId}:${row.id}`;
  const start = async (row: SessionRow) => {
    if (!matches(row) || disposed) return;
    cancel();
    const token = generation;
    starting = token;
    report(null);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (disposed || suppressed || token !== generation) return;
      try {
        const result = await client.agent.start({
          workspaceId: row.workspaceId,
          sessionId: row.id,
        });
        if (!result.success)
          throw new Error(result.error ?? "Couldn't start the agent");
        if (token !== generation || disposed) return;
        // Main joins concurrent callers and resolves only after shared readiness.
        // Restore the relay's real incarnation after that promise resolves.
        starting = null;
        try {
          await restore(row, token);
        } catch (error) {
          if (valid(token)) report(error);
        }
        return;
      } catch (error) {
        if (token !== generation || disposed) return;
        const missing =
          (error as { data?: { reason?: string } }).data?.reason ===
          "workspace-missing";
        if (missing || attempt === 4) {
          starting = null;
          report(error);
          return;
        }
        await delay([500, 1000, 2000, 4000][attempt]!);
      }
    }
  };
  return {
    observe(row: SessionRow, exists: boolean, ready: string | null) {
      if (disposed || suppressed || !exists || !matches(row)) return;
      const changed = lastStatus !== row.status;
      lastStatus = row.status;
      const incarnationChanged = incarnation !== ready;
      incarnation = ready;
      if (
        startOnObserve &&
        changed &&
        (row.status === "stopped" || row.status === "error")
      ) {
        void start(row);
      } else if (ready && starting !== generation) {
        if (incarnationChanged) cancel();
        const token = generation;
        void restore(row, token).catch((error) => {
          if (valid(token)) report(error);
        });
      }
    },
    retry(row: SessionRow) {
      suppressed = false;
      void start(row);
    },
    unavailable() {
      cancel();
      lastStatus = undefined;
    },
    stop() {
      suppressed = true;
      cancel();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
};

export const useAgentLifecycle = (
  client: AppClient,
  row: SessionRow,
  report: (error: unknown | null) => void
) => {
  const controller = useMemo(
    () => agentLifecycle(client, report, `${row.workspaceId}:${row.id}`, false),
    [client, row.workspaceId, row.id, report]
  );
  useEffect(() => {
    report(null);
    return () => controller.dispose();
  }, [controller, report]);
  const warm = useEffectEvent(() => {
    if (row.status === "stopped" || row.status === "error")
      controller.retry(row);
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('textarea,[contenteditable="true"]')
      )
        return;
      document.removeEventListener("keydown", onKey);
      warm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [controller]);
  return controller;
};
