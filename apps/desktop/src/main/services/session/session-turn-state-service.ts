import { describeToolCall } from "@abacus-ai/agent/tool-display";
import {
  AgentStatus,
  type DesktopEvent,
} from "@abacus-ai/contract/agent-types";
import type {
  SessionTurnPhase,
  SessionTurnStateSnapshot,
} from "@abacus-ai/contract/contracts";

import { ConnectivityService } from "../connectivity/connectivity-service";
import type { TurnLedger } from "./turn-ledger";

type EmitChange = (snapshot: SessionTurnStateSnapshot) => void;
/** Where the watchdog's deadline is timed: in awake time (ConnectivityService). */
type AwakeClock = Pick<ConnectivityService, "awakeTimeout">;
type OnInactivityTimeout = (
  workspaceId: string,
  sessionId: string,
  lastActivity: string | null
) => void;

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export const INACTIVITY_TIMEOUT_MINUTES = INACTIVITY_TIMEOUT_MS / 60_000;

const isBusyPhase = (phase: SessionTurnPhase): boolean =>
  phase === "pending" ||
  phase === "streaming" ||
  phase === "waiting_permission";

/**
 * Single source of truth for "is this session busy with an agent turn?",
 * updated before dispatching to the CLI so the renderer's cache matches. After
 * a stop, CLI events are suppressed until the agent confirms idle. Only
 * `status_changed: idle` and `error` end the busy phase: `turn_complete` fires
 * after every tool round. A session silent for 10 minutes while busy, or while
 * its turn is still open in the ledger, is forced idle and its turn closed as
 * timed out (not while `waiting_permission`, which waits on a person).
 * The ten minutes are awake minutes: a laptop asleep mid-turn wakes to a
 * whole window, in which the agent recovers or the watchdog acts.
 */
export class SessionTurnStateService {
  private readonly states = new Map<string, SessionTurnStateSnapshot>();
  private readonly suppressedSessions = new Set<string>();
  /** sessionId -> cancel of its watchdog deadline. */
  private readonly activityTimers = new Map<string, () => void>();
  /**
   * sessionId -> the tool the agent last said is running, for the timeout
   * message; none means it was waiting on the model.
   */
  private readonly lastActivity = new Map<string, string>();
  /** Waiting on a stopped session: the agent's idle, its exit, or the next send. */
  private readonly stopWaiters = new Map<
    string,
    Array<(settled: boolean) => void>
  >();

  constructor(
    private readonly emitChange: EmitChange,
    private readonly onInactivityTimeout?: OnInactivityTimeout,
    /** Told every turn's start and ending; see TurnLedger. */
    private readonly ledger?: TurnLedger,
    /** The app's own ConnectivityService, which hears sleep and wake. */
    private readonly clock: AwakeClock = new ConnectivityService()
  ) {}

  get(workspaceId: string, sessionId: string): SessionTurnStateSnapshot {
    const cached = this.states.get(sessionId);
    if (cached != null && cached.workspaceId === workspaceId) return cached;
    return this.makeIdle(workspaceId, sessionId);
  }

  /** Every session's cached state; one never seen is idle and absent. */
  list(): SessionTurnStateSnapshot[] {
    return Array.from(this.states.values());
  }

  /** True only while user-requested work is in flight. Idle CLI processes do not count. */
  /**
   * `exclude`: sessions whose busy state comes from elsewhere (an agui
   * runtime, whose run state the relay holds; spec 07 review r1 #10).
   */
  hasBusyTurn(exclude?: (sessionId: string) => boolean): boolean {
    for (const [sessionId, state] of this.states) {
      if (state.isBusy && exclude?.(sessionId) !== true) return true;
    }
    return false;
  }

  markSent(workspaceId: string, sessionId: string): void {
    this.ledger?.begin(sessionId);
    this.suppressedSessions.delete(sessionId);
    this.releaseStopWaiters(sessionId);
    this.lastActivity.delete(sessionId);
    this.set(workspaceId, sessionId, "pending");
    this.startActivityTimer(workspaceId, sessionId);
  }

  markStopped(workspaceId: string, sessionId: string): void {
    // A Stop; the watchdog and a closed process have closed theirs already.
    this.ledger?.end(sessionId, "stopped");
    this.suppressedSessions.add(sessionId);
    this.clearActivityTimer(sessionId);
    this.set(workspaceId, sessionId, "idle");
  }

  /**
   * The agent process is gone: nothing more will settle its stop. One that
   * never came up ended no turn: the start that spawned it retries, or ends
   * the turn as not started (markNotStarted).
   */
  markClosed(workspaceId: string, sessionId: string, started = true): void {
    if (started) {
      this.ledger?.end(sessionId, "agent_exited");
      this.markStopped(workspaceId, sessionId);
    }
    this.releaseStopWaiters(sessionId);
  }

  /** No agent took the message: its start failed twice, or the send was refused. */
  markNotStarted(workspaceId: string, sessionId: string): void {
    this.ledger?.end(sessionId, "not_started");
    this.markStopped(workspaceId, sessionId);
    this.releaseStopWaiters(sessionId);
  }

  /**
   * True once a stopped session has settled (the agent confirmed idle, its
   * process closed, or the next send went out); false at the deadline.
   * Call after markStopped.
   */
  stopSettled(sessionId: string, deadlineMs: number): Promise<boolean> {
    if (!this.suppressedSessions.has(sessionId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.stopWaiters.get(sessionId) ?? [];
        this.stopWaiters.set(
          sessionId,
          waiters.filter((waiter) => waiter !== settle)
        );
        resolve(false);
      }, deadlineMs);
      timer.unref?.();
      const settle = (settled: boolean): void => {
        clearTimeout(timer);
        resolve(settled);
      };
      const waiters = this.stopWaiters.get(sessionId) ?? [];
      waiters.push(settle);
      this.stopWaiters.set(sessionId, waiters);
    });
  }

  private releaseStopWaiters(sessionId: string): void {
    const waiters = this.stopWaiters.get(sessionId) ?? [];
    this.stopWaiters.delete(sessionId);
    for (const settle of waiters) settle(true);
  }

  /**
   * Updates the phase from a raw NDJSON message and returns whether to forward
   * it. Only `event` and `permission_needed` are gated; out-of-band traffic
   * is never part of a turn and always passes.
   */
  filterDesktopEvent(
    workspaceId: string,
    sessionId: string,
    message: DesktopEvent
  ): boolean {
    // Liveness only: a quiet build, or a model writing a long tool call, is
    // otherwise indistinguishable from a wedged agent. Resets the timer and
    // stops; forwarding would re-render on a timer.
    if (message.type === "heartbeat") {
      this.resetActivityTimer(workspaceId, sessionId);
      // What the agent says is running now; none is the model writing.
      if (message.tool != null) this.lastActivity.set(sessionId, message.tool);
      else this.lastActivity.delete(sessionId);

      return false;
    }

    const isTurnTraffic =
      message.type === "event" || message.type === "permission_needed";
    if (!isTurnTraffic) {
      // Out-of-band traffic still proves the CLI is alive; count it so a tool
      // that only emits MCP logs does not trip the timeout.
      this.resetActivityTimer(workspaceId, sessionId);
      return true;
    }

    const event = message.type === "event" ? message.event : null;

    if (this.suppressedSessions.has(sessionId)) {
      // After stop, drop everything until the agent confirms idle. Errors here
      // are side-effects of the user's own stop click, not failures to banner.
      if (
        event?.type === "status_changed" &&
        event.status === AgentStatus.Idle
      ) {
        this.suppressedSessions.delete(sessionId);
        this.releaseStopWaiters(sessionId);
        // The cache is already idle from markStopped; forwarding re-renders.
        return false;
      }
      return false;
    }

    // Any event from the CLI counts as activity.
    this.resetActivityTimer(workspaceId, sessionId);
    this.ledger?.observe(sessionId, message);

    if (
      event?.type === "tool_execution_start" ||
      event?.type === "tool_requested"
    ) {
      const summary = describeToolCall(
        event.tool as {
          name?: unknown;
          input?: Record<string, unknown>;
          args?: Record<string, unknown>;
        }
      );
      if (summary != null) this.lastActivity.set(sessionId, summary);
    } else if (event?.type === "tool_execution_complete") {
      // Done: a sibling still running is named by the next heartbeat.
      this.lastActivity.delete(sessionId);
    }

    if (message.type === "permission_needed") {
      this.set(workspaceId, sessionId, "waiting_permission");
    } else if (event?.type === "status_changed") {
      const phase = this.statusToPhase(event.status);
      if (phase != null) this.set(workspaceId, sessionId, phase);
    } else if (event?.type === "error") {
      this.set(workspaceId, sessionId, "error");
    }
    // turn_complete intentionally ignored. See class JSDoc.

    return true;
  }

  clearSession(sessionId: string): void {
    // The session is gone: a turn still open in it ends with it.
    this.ledger?.end(sessionId, "stopped");
    this.clearActivityTimer(sessionId);
    this.states.delete(sessionId);
    this.suppressedSessions.delete(sessionId);
    this.releaseStopWaiters(sessionId);
    this.lastActivity.delete(sessionId);
  }

  private set(
    workspaceId: string,
    sessionId: string,
    phase: SessionTurnPhase
  ): void {
    const prev = this.states.get(sessionId);
    if (
      prev != null &&
      prev.phase === phase &&
      prev.workspaceId === workspaceId
    ) {
      return;
    }
    // An approval waits on a person and has its own budget in the agent;
    // timing it here would declare a timeout with the prompt still on screen.
    // A turn the ledger still holds open (an error with no idle after it) is
    // still timed: the watchdog is what closes it if nothing else does.
    const turnOpen = this.ledger?.isOpen(sessionId) === true;
    if ((!isBusyPhase(phase) && !turnOpen) || phase === "waiting_permission") {
      this.clearActivityTimer(sessionId);
    } else if (prev?.phase === "waiting_permission") {
      this.startActivityTimer(workspaceId, sessionId);
    }
    const next: SessionTurnStateSnapshot = {
      sessionId,
      workspaceId,
      phase,
      isBusy: isBusyPhase(phase),
      updatedAt: new Date().toISOString(),
    };
    this.states.set(sessionId, next);
    this.emitChange(next);
  }

  private startActivityTimer(workspaceId: string, sessionId: string): void {
    this.clearActivityTimer(sessionId);
    this.activityTimers.set(
      sessionId,
      this.clock.awakeTimeout(INACTIVITY_TIMEOUT_MS, () => {
        this.activityTimers.delete(sessionId);
        const lastActivity = this.lastActivity.get(sessionId) ?? null;
        this.ledger?.end(sessionId, "timed_out", lastActivity ?? undefined);
        // Same treatment as Stop: the tail of a slow tool must not flow back in
        // and make a timed-out session busy again.
        this.markStopped(workspaceId, sessionId);
        this.onInactivityTimeout?.(workspaceId, sessionId, lastActivity);
      })
    );
  }

  private resetActivityTimer(workspaceId: string, sessionId: string): void {
    const state = this.states.get(sessionId);
    if (
      state == null ||
      !isBusyPhase(state.phase) ||
      state.phase === "waiting_permission"
    )
      return;
    this.startActivityTimer(workspaceId, sessionId);
  }

  private clearActivityTimer(sessionId: string): void {
    const cancel = this.activityTimers.get(sessionId);
    if (cancel != null) {
      cancel();
      this.activityTimers.delete(sessionId);
    }
  }

  private statusToPhase(status: AgentStatus): SessionTurnPhase | null {
    switch (status) {
      case AgentStatus.Streaming:
      case AgentStatus.ExecutingTool:
      case AgentStatus.Submitted:
        return "streaming";
      case AgentStatus.WaitingForToolPermission:
        return "waiting_permission";
      case AgentStatus.Idle:
        return "idle";
      default:
        return null;
    }
  }

  private makeIdle(
    workspaceId: string,
    sessionId: string
  ): SessionTurnStateSnapshot {
    return {
      sessionId,
      workspaceId,
      phase: "idle",
      isBusy: false,
      updatedAt: new Date().toISOString(),
    };
  }
}
