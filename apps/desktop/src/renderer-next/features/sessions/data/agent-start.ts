import type { AppClient } from "#next/data/transport/types";
import type { SessionRow } from "#shared/contract/rows";
export const agentLifecycle = (
  client: AppClient,
  report: (error: unknown | null) => void
) => {
  let generation = 0;
  let suppressed = false;
  let disposed = false;
  let lastStatus: string | undefined;
  let lastIncarnation: string | null = null;
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
  const restore = async (row: SessionRow, incarnation: string | null) => {
    if (incarnation === null || lastIncarnation === incarnation) return;
    lastIncarnation = incarnation;
    if (row.conversationId)
      await client.agent.switchConversation({
        workspaceId: row.workspaceId,
        sessionId: row.id,
        conversationId: row.conversationId,
      });
  };
  const start = async (row: SessionRow) => {
    cancel();
    const token = generation;
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
        // The relay's ready incarnation is supplied by observe; no invented process identity.
        return;
      } catch (error) {
        if (token !== generation || disposed) return;
        const missing =
          (error as { data?: { reason?: string } }).data?.reason ===
          "workspace-missing";
        if (missing || attempt === 4) {
          report(error);
          return;
        }
        await delay([500, 1000, 2000, 4000][attempt]!);
      }
    }
  };
  return {
    observe(row: SessionRow, exists: boolean, incarnation: string | null) {
      if (disposed || suppressed || !exists) return;
      if (incarnation && incarnation !== lastIncarnation) {
        cancel();
        void restore(row, incarnation).catch(report);
      }
      const changed = lastStatus !== row.status;
      lastStatus = row.status;
      if (changed && (row.status === "stopped" || row.status === "error"))
        void start(row);
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
