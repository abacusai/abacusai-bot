/**
 * What the user sees when a turn stops coming back.
 *
 * A real session went silent for ten minutes and ended with "Agent timed out."
 * — no clue whether the model had stalled or a shell command was wedged, and
 * nothing in the transcript, because a tool that hangs before it starts never
 * emits a card to persist. The last thing the session was seen doing is the
 * only diagnosis available, so it has to survive into the message.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { AgentStatus, type DesktopEvent } from "#shared/agent-types";

import {
  SessionTurnStateService,
  INACTIVITY_TIMEOUT_MINUTES,
} from "./session-turn-state-service";

const WS = "ws-1";
const SESSION = "session-1";
const TIMEOUT_MS = INACTIVITY_TIMEOUT_MINUTES * 60_000;

const toolStart = (
  name: string,
  input: Record<string, unknown>
): DesktopEvent =>
  ({
    type: "event",
    event: {
      type: "tool_execution_start",
      tool: { id: "call-1", name, type: name, input, args: input },
    },
  }) as DesktopEvent;

const statusChange = (status: AgentStatus): DesktopEvent =>
  ({
    type: "event",
    event: { type: "status_changed", status },
  }) as DesktopEvent;

const heartbeat = (runningTools = 1): DesktopEvent =>
  ({ type: "heartbeat", runningTools }) as DesktopEvent;

let onTimeout: ReturnType<
  typeof vi.fn<
    (
      workspaceId: string,
      sessionId: string,
      lastActivity: string | null
    ) => void
  >
>;
let service: SessionTurnStateService;

beforeEach(() => {
  vi.useFakeTimers();
  onTimeout =
    vi.fn<
      (
        workspaceId: string,
        sessionId: string,
        lastActivity: string | null
      ) => void
    >();
  service = new SessionTurnStateService(() => {}, onTimeout);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("background turn detection", () => {
  it("does not treat an idle session as active work", () => {
    expect(service.hasBusyTurn()).toBe(false);

    service.filterDesktopEvent(WS, SESSION, statusChange(AgentStatus.Idle));

    expect(service.hasBusyTurn()).toBe(false);
  });

  it("tracks work from send until the authoritative idle event", () => {
    service.markSent(WS, SESSION);
    expect(service.hasBusyTurn()).toBe(true);

    service.filterDesktopEvent(WS, SESSION, statusChange(AgentStatus.Idle));

    expect(service.hasBusyTurn()).toBe(false);
  });
});

describe("reporting a wedged turn", () => {
  it("names the tool the session was last running", () => {
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      toolStart("bash", { command: 'pkill -f "node server.js"; sleep 1' })
    );

    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(onTimeout).toHaveBeenCalledWith(
      WS,
      SESSION,
      'bash (pkill -f "node server.js"; sleep 1)'
    );
  });

  it("reports the timeout even when nothing announced itself", () => {
    service.markSent(WS, SESSION);

    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(onTimeout).toHaveBeenCalledWith(WS, SESSION, null);
  });

  it("forgets the previous turn activity when a new message is sent", () => {
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      toolStart("bash", { command: "sleep 1" })
    );
    service.markSent(WS, SESSION);

    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(onTimeout).toHaveBeenCalledWith(WS, SESSION, null);
  });
});

describe("waiting on a person is not a wedged agent", () => {
  it("does not time out a session parked on an approval prompt", () => {
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      statusChange(AgentStatus.WaitingForToolPermission)
    );

    vi.advanceTimersByTime(TIMEOUT_MS * 2);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(service.get(WS, SESSION).phase).toBe("waiting_permission");
  });

  it("resumes the clock once the user answers", () => {
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      statusChange(AgentStatus.WaitingForToolPermission)
    );
    vi.advanceTimersByTime(TIMEOUT_MS * 2);
    service.filterDesktopEvent(
      WS,
      SESSION,
      statusChange(AgentStatus.ExecutingTool)
    );

    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

/**
 * The reported bug: a bash crawl that printed nothing for ten minutes was
 * declared wedged and had its turn ended. Silence is not death — the agent
 * says so on a timer for as long as a call is outstanding.
 */
describe("a tool that runs quietly is not a wedged agent", () => {
  it("does not time out while the agent is still reporting", () => {
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      toolStart("bash", { command: "node crawl.js" })
    );

    // Four times the watchdog's patience, with a heartbeat at half its budget.
    for (let elapsed = 0; elapsed < TIMEOUT_MS * 4; elapsed += TIMEOUT_MS / 2) {
      vi.advanceTimersByTime(TIMEOUT_MS / 2);
      service.filterDesktopEvent(WS, SESSION, heartbeat());
    }

    expect(onTimeout).not.toHaveBeenCalled();
    expect(service.get(WS, SESSION).isBusy).toBe(true);
  });

  it("still times out once the agent stops reporting", () => {
    // The watchdog has to keep working, or a wedged agent parks the session
    // forever with no way out but the Stop button.
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      toolStart("bash", { command: "node crawl.js" })
    );
    vi.advanceTimersByTime(TIMEOUT_MS / 2);
    service.filterDesktopEvent(WS, SESSION, heartbeat());

    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(onTimeout).toHaveBeenCalledWith(WS, SESSION, "bash (node crawl.js)");
  });

  it("keeps the heartbeat out of the transcript", () => {
    // Liveness for the watchdog, not something the user should see — and
    // forwarding it would re-render the transcript on a timer.
    service.markSent(WS, SESSION);

    expect(service.filterDesktopEvent(WS, SESSION, heartbeat())).toBe(false);
  });

  it("does not revive a session the user stopped", () => {
    // A tool already in flight goes on beating after Stop. Treating that as
    // activity would restart the watchdog on a turn that is over.
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      toolStart("bash", { command: "node crawl.js" })
    );
    service.markStopped(WS, SESSION);

    service.filterDesktopEvent(WS, SESSION, heartbeat());
    vi.advanceTimersByTime(TIMEOUT_MS * 2);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(service.get(WS, SESSION).phase).toBe("idle");
  });

  it("does not start a clock on a session parked on an approval", () => {
    // waiting_permission deliberately runs no timer. A heartbeat arriving
    // while the prompt is up must not quietly start one.
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      statusChange(AgentStatus.WaitingForToolPermission)
    );

    service.filterDesktopEvent(WS, SESSION, heartbeat());
    vi.advanceTimersByTime(TIMEOUT_MS * 2);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(service.get(WS, SESSION).phase).toBe("waiting_permission");
  });

  it("does not wake an idle session", () => {
    // Nothing is in flight, so a stray heartbeat has nothing to keep alive.
    service.filterDesktopEvent(WS, SESSION, heartbeat(0));
    vi.advanceTimersByTime(TIMEOUT_MS * 2);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(service.get(WS, SESSION).isBusy).toBe(false);
  });
});

/**
 * "The turn was stopped" has to be true.
 *
 * It was not: the watchdog flipped the phase to idle and said so, but nothing
 * suppressed the turn it had given up on. When the slow tool finally landed,
 * its events were forwarded like any others and the session went busy again —
 * after the user had been told it was over and invited to send a new message.
 */
describe("a turn the watchdog gave up on stays given up on", () => {
  const toolDone = (): DesktopEvent =>
    ({
      type: "event",
      event: {
        type: "tool_execution_complete",
        tool: { id: "call-1", name: "bash", type: "bash", input: {}, args: {} },
        result: { id: "call-1", content: "finally done", rejected: false },
      },
    }) as DesktopEvent;

  const timeOut = (): void => {
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      toolStart("bash", { command: "node crawl.js" })
    );
    vi.advanceTimersByTime(TIMEOUT_MS);
  };

  it("drops the output that arrives after the turn was declared over", () => {
    timeOut();

    expect(service.filterDesktopEvent(WS, SESSION, toolDone())).toBe(false);
  });

  it("does not go busy again when the slow tool finally lands", () => {
    timeOut();

    service.filterDesktopEvent(WS, SESSION, toolDone());
    service.filterDesktopEvent(
      WS,
      SESSION,
      statusChange(AgentStatus.ExecutingTool)
    );

    expect(service.get(WS, SESSION).isBusy).toBe(false);
  });

  it("only reports the timeout once", () => {
    timeOut();

    service.filterDesktopEvent(WS, SESSION, toolDone());
    vi.advanceTimersByTime(TIMEOUT_MS * 3);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("comes back to life when the user sends the next message", () => {
    // Suppression is for the abandoned turn, not the session — the advice in
    // the timeout message ("send a message to pick it back up") has to work.
    timeOut();

    service.markSent(WS, SESSION);
    service.filterDesktopEvent(
      WS,
      SESSION,
      statusChange(AgentStatus.ExecutingTool)
    );

    expect(service.get(WS, SESSION).isBusy).toBe(true);
  });
});
