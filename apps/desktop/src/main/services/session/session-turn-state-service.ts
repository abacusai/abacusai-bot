import { AgentStatus, type DesktopEvent } from "#shared/agent-types";
import type {
  SessionTurnPhase,
  SessionTurnStateSnapshot,
} from "#shared/contracts";

type EmitChange = (snapshot: SessionTurnStateSnapshot) => void;
type OnInactivityTimeout = (
  workspaceId: string,
  sessionId: string,
  lastActivity: string | null
) => void;

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export const INACTIVITY_TIMEOUT_MINUTES = INACTIVITY_TIMEOUT_MS / 60_000;

/** Longest tool summary worth carrying into a timeout message. */
const ACTIVITY_SUMMARY_MAX = 120;

/**
 * What a tool call was doing, short enough for an error banner, e.g.
 * `edit (server/app.js)`. A wedged turn is diagnosed from this line alone:
 * a tool that hangs before it starts emits no card to persist.
 */
const describeTool = (tool: {
  name?: unknown;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
}): string | null => {
  const name =
    typeof tool.name === "string" && tool.name.length > 0 ? tool.name : null;
  if (name == null) return null;
  const input = tool.input ?? tool.args ?? {};
  const detail = input.command ?? input.path ?? input.url;
  if (typeof detail !== "string" || detail.length === 0) return name;
  const flat = detail.replace(/\s+/g, " ").trim();
  const clipped =
    flat.length > ACTIVITY_SUMMARY_MAX
      ? `${flat.slice(0, ACTIVITY_SUMMARY_MAX)}…`
      : flat;
  return `${name} (${clipped})`;
};

const isBusyPhase = (phase: SessionTurnPhase): boolean =>
  phase === "pending" ||
  phase === "streaming" ||
  phase === "waiting_permission";

/**
 * Single source of truth for "is this session busy with an agent turn?",
 * updated before dispatching to the CLI so the renderer's cache matches. After
 * a stop, CLI events are suppressed until the agent confirms idle. Only
 * `status_changed: idle` and `error` end a turn: `turn_complete` fires after
 * every tool round. A busy session silent for 10 minutes is forced idle (not
 * while `waiting_permission`, which waits on a person).
 */
export class SessionTurnStateService {
  private readonly states = new Map<string, SessionTurnStateSnapshot>();
  private readonly suppressedSessions = new Set<string>();
  private readonly activityTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** sessionId -> what the session was last seen doing, for the timeout message. */
  private readonly lastActivity = new Map<string, string>();

  constructor(
    private readonly emitChange: EmitChange,
    private readonly onInactivityTimeout?: OnInactivityTimeout
  ) {}

  get(workspaceId: string, sessionId: string): SessionTurnStateSnapshot {
    const cached = this.states.get(sessionId);
    if (cached != null && cached.workspaceId === workspaceId) return cached;
    return this.makeIdle(workspaceId, sessionId);
  }

  /** True only while user-requested work is in flight. Idle CLI processes do not count. */
  hasBusyTurn(): boolean {
    for (const state of this.states.values()) {
      if (state.isBusy) return true;
    }
    return false;
  }

  markSent(workspaceId: string, sessionId: string): void {
    this.suppressedSessions.delete(sessionId);
    this.lastActivity.delete(sessionId);
    this.set(workspaceId, sessionId, "pending");
    this.startActivityTimer(workspaceId, sessionId);
  }

  markStopped(workspaceId: string, sessionId: string): void {
    this.suppressedSessions.add(sessionId);
    this.clearActivityTimer(sessionId);
    this.set(workspaceId, sessionId, "idle");
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
    // Liveness only: a quiet build is otherwise indistinguishable from a wedged
    // agent. Resets the timer and stops; forwarding would re-render on a timer.
    if (message.type === "heartbeat") {
      this.resetActivityTimer(workspaceId, sessionId);

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
        // The cache is already idle from markStopped; forwarding re-renders.
        return false;
      }
      return false;
    }

    // Any event from the CLI counts as activity — reset the inactivity timer.
    this.resetActivityTimer(workspaceId, sessionId);

    if (
      event?.type === "tool_execution_start" ||
      event?.type === "tool_requested"
    ) {
      const summary = describeTool(
        event.tool as {
          name?: unknown;
          input?: Record<string, unknown>;
          args?: Record<string, unknown>;
        }
      );
      if (summary != null) this.lastActivity.set(sessionId, summary);
    }

    if (message.type === "permission_needed") {
      this.set(workspaceId, sessionId, "waiting_permission");
    } else if (event?.type === "status_changed") {
      const phase = this.statusToPhase(event.status);
      if (phase != null) this.set(workspaceId, sessionId, phase);
    } else if (event?.type === "error") {
      this.set(workspaceId, sessionId, "error");
    }
    // turn_complete intentionally ignored — see class JSDoc.

    return true;
  }

  clearSession(sessionId: string): void {
    this.clearActivityTimer(sessionId);
    this.states.delete(sessionId);
    this.suppressedSessions.delete(sessionId);
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
    if (!isBusyPhase(phase) || phase === "waiting_permission") {
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
      setTimeout(() => {
        this.activityTimers.delete(sessionId);
        const lastActivity = this.lastActivity.get(sessionId) ?? null;
        // Same treatment as Stop: the tail of a slow tool must not flow back in
        // and make a timed-out session busy again.
        this.markStopped(workspaceId, sessionId);
        this.onInactivityTimeout?.(workspaceId, sessionId, lastActivity);
      }, INACTIVITY_TIMEOUT_MS)
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
    const timer = this.activityTimers.get(sessionId);
    if (timer != null) {
      clearTimeout(timer);
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
