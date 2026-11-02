/**
 * What the user sees when a turn stops coming back.
 *
 * A real session went silent for ten minutes and ended with "Agent timed out.",
 * with no clue whether the model had stalled or a shell command was wedged, and
 * nothing in the transcript, because a tool that hangs before it starts never
 * emits a card to persist. The last thing the session was seen doing is the
 * only diagnosis available, so it has to survive into the message.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  AgentStatus,
  type DesktopEvent,
} from "@abacus-ai/contract/agent-types";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  SessionTurnStateService,
  INACTIVITY_TIMEOUT_MINUTES,
} from "./session-turn-state-service";
import { TurnAbandoner, type TurnAbandonerPorts } from "./turn-abandoner";
import { TurnLedger } from "./turn-ledger";

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
 * declared wedged and had its turn ended. Silence is not death. The agent
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
    // Liveness for the watchdog, not something the user should see, and
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

  it("settles a stop once the agent confirms idle, and not before", async () => {
    service.markSent(WS, SESSION);
    service.markStopped(WS, SESSION);
    let settled = false;
    const waiting = service
      .stopSettled(SESSION, 60_000)
      .then((result) => (settled = result));

    service.filterDesktopEvent(WS, SESSION, toolStart("bash", {}));
    await Promise.resolve();
    expect(settled).toBe(false);

    service.filterDesktopEvent(WS, SESSION, statusChange(AgentStatus.Idle));
    await waiting;
    expect(settled).toBe(true);
  });

  it("settles a stop when the agent process closes, with no idle to wait for", async () => {
    service.markSent(WS, SESSION);
    service.markStopped(WS, SESSION);
    const waiting = service.stopSettled(SESSION, 60_000);
    service.markClosed(WS, SESSION);
    await expect(waiting).resolves.toBe(true);
    // Nothing stopped: nothing to wait for.
    await expect(service.stopSettled("other", 60_000)).resolves.toBe(true);
  });

  it("gives up waiting on a stop at its deadline", async () => {
    service.markSent(WS, SESSION);
    service.markStopped(WS, SESSION);
    const waiting = service.stopSettled(SESSION, 1_000);
    vi.advanceTimersByTime(1_000);
    await expect(waiting).resolves.toBe(false);
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
 * its events were forwarded like any others and the session went busy again,
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
    // Suppression is for the abandoned turn, not the session. The advice in
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

describe("abandoning a turn", () => {
  const abandoner = (overrides: Partial<TurnAbandonerPorts> = {}) => {
    const calls: string[] = [];
    const ports: TurnAbandonerPorts = {
      clearQueue: () => (calls.push("clear"), true),
      stopTurn: () => (calls.push("stop"), true),
      markStopped: (workspaceId, sessionId) => {
        calls.push("mark");
        service.markStopped(workspaceId, sessionId);
      },
      stopSettled: (sessionId, deadlineMs) =>
        service.stopSettled(sessionId, deadlineMs),
      closeSession: async () => {
        calls.push("close");
      },
      log: () => {},
      settleMs: 1_000,
      ...overrides,
    };
    return { turns: new TurnAbandoner(ports), calls };
  };

  it("returns at once when there is no agent, and refuses sends begun before it", async () => {
    const { turns, calls } = abandoner({ stopTurn: () => false });
    const epoch = turns.epoch(SESSION);
    await expect(turns.abandon(WS, SESSION)).resolves.toBe("no-agent");
    expect(calls).toEqual(["clear", "mark"]);
    expect(turns.stillCurrent(SESSION, epoch)).toBe(false);
    expect(turns.stillCurrent(SESSION, turns.epoch(SESSION))).toBe(true);
  });

  it("waits for the agent to go idle, waiting only once the stop was sent", async () => {
    const settled = vi.fn(service.stopSettled.bind(service));
    const { turns, calls } = abandoner({
      stopTurn: () => {
        calls.push("stop");
        expect(settled).not.toHaveBeenCalled();
        return true;
      },
      stopSettled: settled,
    });
    service.markSent(WS, SESSION);
    const done = turns.abandon(WS, SESSION);
    await Promise.resolve();
    service.filterDesktopEvent(WS, SESSION, statusChange(AgentStatus.Idle));
    await expect(done).resolves.toBe("settled");
    expect(calls).toEqual(["clear", "mark", "stop"]);
  });

  it("closes a session that never stops, and is done even if the close fails", async () => {
    const { turns, calls } = abandoner({
      closeSession: async () => {
        calls.push("close");
        throw new Error("never closed");
      },
    });
    service.markSent(WS, SESSION);
    const done = turns.abandon(WS, SESSION);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBe("closed");
    expect(calls).toEqual(["clear", "mark", "stop", "close"]);
  });
});

describe("every turn closes once, with how it ended", () => {
  let records: Array<{ kind: string; cause?: string }>;
  let lines: string[];
  let ledgered: SessionTurnStateService;
  const event = (e: Record<string, unknown>): DesktopEvent =>
    ({ type: "event", event: e }) as DesktopEvent;
  const feed = (message: DesktopEvent): void => {
    ledgered.filterDesktopEvent(WS, SESSION, message);
  };

  beforeEach(() => {
    records = [];
    lines = [];
    const ledger = new TurnLedger({
      now: () => Date.now(),
      log: (line) => lines.push(line),
    });
    ledger.onClose((record) => records.push(record));
    ledgered = new SessionTurnStateService(() => {}, onTimeout, ledger);
  });

  it("takes the agent's own outcome off its closing turn_complete", () => {
    ledgered.markSent(WS, SESSION);
    feed(event({ type: "error", error: { cause: "rate_limited" } }));
    feed(
      event({
        type: "turn_complete",
        outcome: { kind: "failed", cause: "rate_limited" },
      })
    );
    feed(statusChange(AgentStatus.Idle));

    expect(records).toEqual([
      expect.objectContaining({ kind: "failed", cause: "rate_limited" }),
    ]);
    expect(lines).toEqual([
      expect.stringMatching(
        /^\[session-\] turn outcome failed cause=rate_limited ms=\d+$/
      ),
    ]);
  });

  it("judges an older agent's turn by what it streamed", () => {
    ledgered.markSent(WS, SESSION);
    feed(statusChange(AgentStatus.Idle));
    ledgered.markSent(WS, SESSION);
    feed(event({ type: "text_delta", content: "Hello" }));
    feed(statusChange(AgentStatus.Idle));

    expect(records).toEqual([
      expect.objectContaining({ kind: "failed", cause: "empty" }),
      expect.objectContaining({ kind: "reply" }),
    ]);
  });

  it("closes a watchdog's turn as timed out, naming what ran, and only once", () => {
    ledgered.markSent(WS, SESSION);
    feed(toolStart("bash", { command: "npm install" }));
    vi.advanceTimersByTime(TIMEOUT_MS + 1);
    // The Stop that follows, and the agent's late idle, are the same ending.
    ledgered.markStopped(WS, SESSION);
    feed(statusChange(AgentStatus.Idle));

    expect(records).toEqual([
      expect.objectContaining({
        kind: "timed_out",
        cause: "bash (npm install)",
      }),
    ]);
  });

  it("closes a stopped turn, and one whose agent went away", () => {
    ledgered.markSent(WS, SESSION);
    ledgered.markStopped(WS, SESSION);
    ledgered.markSent(WS, SESSION);
    ledgered.markClosed(WS, SESSION);

    expect(records.map((record) => record.kind)).toEqual([
      "stopped",
      "agent_exited",
    ]);
  });

  it("fails a turn whose message reached no agent with why, not as an exit", () => {
    // A start that ran out of time is killed; its close comes after.
    ledgered.markSent(WS, SESSION);
    ledgered.markUndelivered(WS, SESSION, "agent_start_timeout");
    ledgered.markClosed(WS, SESSION);
    ledgered.markSent(WS, SESSION);
    ledgered.markUndelivered(WS, SESSION, "undeliverable");

    expect(records).toEqual([
      expect.objectContaining({ kind: "failed", cause: "agent_start_timeout" }),
      expect.objectContaining({ kind: "failed", cause: "undeliverable" }),
    ]);
    expect(ledgered.get(WS, SESSION).isBusy).toBe(false);
  });

  it("a message sent into a running turn does not open a second one", () => {
    ledgered.markSent(WS, SESSION);
    ledgered.markSent(WS, SESSION);
    feed(event({ type: "text_delta", content: "Both answered" }));
    feed(statusChange(AgentStatus.Idle));

    expect(records).toHaveLength(1);
  });

  it("carries the reported error, actions and all, on a failed close", () => {
    ledgered.markSent(WS, SESSION);
    const error = {
      message: "Out of credits",
      cause: "credits_exhausted",
      actions: [{ type: "upgrade-abacus" }],
    };
    feed(event({ type: "error", error }));
    feed(statusChange(AgentStatus.Idle));

    expect(records).toEqual([
      expect.objectContaining({ kind: "failed", error }),
    ]);
  });

  it("an error with no idle after it is still closed, by the watchdog", () => {
    ledgered.markSent(WS, SESSION);
    feed(statusChange(AgentStatus.Streaming));
    feed(event({ type: "error", error: { message: "boom" } }));
    expect(records).toEqual([]);

    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(records).toEqual([expect.objectContaining({ kind: "timed_out" })]);
  });

  it("closes on the next start a turn the app closed under, with the chat it owed", () => {
    const journal = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turn-journal-")),
      "turns-open.json"
    );
    const before = new TurnLedger({ journal: () => journal });
    before.annotate(SESSION, {
      platform: "whatsapp",
      chatId: "c1",
      owner: false,
      userName: "Ana",
    });
    before.begin(SESSION);
    // The app goes away here: no idle, no Stop, no close.

    const after = new TurnLedger({ journal: () => journal });
    const heard: Array<{ kind: string; channel?: unknown }> = [];
    after.onClose((record) => heard.push(record));
    after.recover();

    expect(heard).toEqual([
      expect.objectContaining({
        kind: "app_closed",
        channel: expect.objectContaining({ chatId: "c1", userName: "Ana" }),
      }),
    ]);
    // Once: a second start finds nothing left open.
    const again: string[] = [];
    const third = new TurnLedger({ journal: () => journal });
    third.onClose((record) => again.push(record.kind));
    third.recover();
    expect(again).toEqual([]);
  });

  it("keeps a turn journaled until its close's listeners have run", () => {
    const journal = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turn-journal-")),
      "turns-open.json"
    );
    const ledger = new TurnLedger({ journal: () => journal });
    let journaledWhileHeard: unknown = null;
    ledger.onClose(() => {
      journaledWhileHeard = JSON.parse(fs.readFileSync(journal, "utf8"));
    });
    ledger.begin(SESSION);
    ledger.end(SESSION, "stopped");

    // A crash inside a listener replays the close on the next start.
    expect(journaledWhileHeard).toEqual([
      expect.objectContaining({ sessionId: SESSION }),
    ]);
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toEqual([]);
  });

  it("leaves a turn open through a quit, for the next start to close", () => {
    const journal = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "turn-journal-")),
      "turns-open.json"
    );
    const ledger = new TurnLedger({ journal: () => journal });
    const heard: string[] = [];
    ledger.onClose((record) => heard.push(record.kind));
    ledger.begin(SESSION);
    ledger.appClosing();
    // The agent stopped by the quit.
    ledger.end(SESSION, "agent_exited");
    expect(heard).toEqual([]);

    const next = new TurnLedger({ journal: () => journal });
    next.onClose((record) => heard.push(record.kind));
    next.recover();
    expect(heard).toEqual(["app_closed"]);
  });

  it("a session cleared away ends its open turn", () => {
    ledgered.markSent(WS, SESSION);
    ledgered.clearSession(SESSION);

    expect(records).toEqual([expect.objectContaining({ kind: "stopped" })]);
  });
});
