/**
 * Abandons an agent turn for a caller that gave up on it (the hosted phone
 * lane): drops what the agent queued, stops the turn, and resolves only once
 * the session is idle or closed, within a deadline. Past it, the session is
 * closed, which kills the agent process if it must. A send that began before
 * the abandon is refused at its dispatch, so nothing slips in behind the stop.
 */

/** How long a stopped turn may take to wind down before its session is closed. */
export const ABANDON_SETTLE_MS = 30_000;

export interface TurnAbandonerPorts {
  clearQueue: (workspaceId: string, sessionId: string) => boolean;
  /** False when there is no agent to tell. */
  stopTurn: (workspaceId: string, sessionId: string) => boolean;
  markStopped: (workspaceId: string, sessionId: string) => void;
  stopSettled: (sessionId: string, deadlineMs: number) => Promise<boolean>;
  /** Closes the session's agent process, escalating to a kill; rejects if it never closes. */
  closeSession: (workspaceId: string, sessionId: string) => Promise<void>;
  log?: (line: string) => void;
  settleMs?: number;
}

export type AbandonOutcome = "no-agent" | "settled" | "closed";

export class TurnAbandoner {
  private readonly epochs = new Map<string, number>();

  constructor(private readonly ports: TurnAbandonerPorts) {}

  /** Taken when a send begins; `stillCurrent` says whether it may still go out. */
  epoch(sessionId: string): number {
    return this.epochs.get(sessionId) ?? 0;
  }

  stillCurrent(sessionId: string, epoch: number): boolean {
    return this.epoch(sessionId) === epoch;
  }

  async abandon(
    workspaceId: string,
    sessionId: string
  ): Promise<AbandonOutcome> {
    this.epochs.set(sessionId, this.epoch(sessionId) + 1);
    const { ports } = this;
    ports.clearQueue(workspaceId, sessionId);
    ports.markStopped(workspaceId, sessionId);
    if (!ports.stopTurn(workspaceId, sessionId)) return "no-agent";
    if (await ports.stopSettled(sessionId, ports.settleMs ?? ABANDON_SETTLE_MS))
      return "settled";
    const log = ports.log ?? console.warn;
    log(`[agent] ${sessionId} did not stop in time; closing its session`);
    try {
      await ports.closeSession(workspaceId, sessionId);
    } catch (error) {
      log(
        `[agent] ${sessionId} close failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return "closed";
  }
}
