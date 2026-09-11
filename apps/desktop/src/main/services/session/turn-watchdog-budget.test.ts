/**
 * The two halves of the turn watchdog, checked against each other.
 *
 * The agent decides how long a tool may take; the desktop decides how long it
 * will wait before calling the agent dead. They live in separate packages that
 * cannot import each other, and nothing made them agree — so they drifted into
 * a state where the second number was smaller than the first and a healthy
 * agent was killed for being slow.
 *
 * How it went wrong, exactly: bash calls are capped at 600s, the watchdog fired
 * at 600s, and the watchdog's clock was reset by the `tool_execution_start`
 * emitted just *before* the command began. The watchdog therefore always
 * reached zero first, and every long bash call died a moment short of its own
 * deadline. `document`, `ppt`, `design` and `delegate_task` were budgeted at
 * 900s, further past the watchdog still.
 *
 * The heartbeat is what reconciles them, so these tests hold it to the job:
 * a quiet tool survives, and a genuinely dead agent still does not.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ToolHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  MAX_VOUCHED_RUNTIME_MS,
} from "@abacus-ai/agent";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { DesktopEvent } from "#shared/agent-types";

import {
  SessionTurnStateService,
  INACTIVITY_TIMEOUT_MINUTES,
} from "./session-turn-state-service";

const WS = "ws-1";
const SESSION = "session-1";
const WATCHDOG_MS = INACTIVITY_TIMEOUT_MINUTES * 60_000;

/**
 * The agent's per-tool budgets, read from source because the desktop cannot
 * import them. Parsed rather than duplicated: a copy here would be the same
 * kind of silent drift this file exists to catch.
 */
const toolBudgetSeconds = (): Record<string, number> => {
  const source = readFileSync(
    resolve(
      import.meta.dirname,
      "../../../../../../packages/agent/src/extensions/tool-timeouts.ts"
    ),
    "utf8"
  );
  const block = source.slice(
    source.indexOf("const BUDGETS"),
    source.indexOf("const DEFAULT_BUDGET_SECONDS")
  );
  const budgets: Record<string, number> = {};
  for (const [, name, seconds] of block.matchAll(
    /^\s*([a-z_]+):\s*\{\s*seconds:\s*(\d+)/gm
  )) {
    budgets[name] = Number(seconds);
  }

  return budgets;
};

describe("the budgets the two packages have to agree on", () => {
  it("finds the agent budgets it is checking", () => {
    // Guards the parse itself: a silently empty table would make every
    // assertion below vacuously true.
    const budgets = toolBudgetSeconds();

    expect(Object.keys(budgets).length).toBeGreaterThan(5);
    expect(budgets.bash).toBeGreaterThan(0);
  });

  it("beats many times over within the watchdog window", () => {
    // One beat per window would make a single dropped or delayed message fatal.
    expect(WATCHDOG_MS / HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(10);
  });

  it("still has tools budgeted to outlast the watchdog", () => {
    // The condition that caused the bug is deliberately still true: a document
    // build may legitimately take 900s against a 600s watchdog. This asserts
    // the hazard exists, so the coverage test below cannot pass vacuously if
    // someone later trims every budget under the watchdog.
    const overrunning = Object.entries(toolBudgetSeconds())
      .filter(([, seconds]) => seconds * 1_000 >= WATCHDOG_MS)
      .map(([tool]) => tool);

    expect(overrunning.length).toBeGreaterThan(0);
  });

  it("vouches for longer than the slowest tool can legitimately take", () => {
    // Read from the same table rather than hardcoded: if someone raises the
    // document budget past the vouching limit, honest builds start getting cut
    // off and this is what says so.
    const longest = Math.max(...Object.values(toolBudgetSeconds())) * 1_000;

    expect(MAX_VOUCHED_RUNTIME_MS).toBeGreaterThan(longest);
  });

  it("gives up on a call long before the watchdog would be unreachable", () => {
    // The vouching limit plus the watchdog is the worst case for noticing a
    // tool that hung and cannot be killed. Keep it to something a person would
    // wait out rather than force-quit.
    expect(MAX_VOUCHED_RUNTIME_MS + WATCHDOG_MS).toBeLessThanOrEqual(
      45 * 60_000
    );
  });

  it("beats several times inside the budget of every long-running tool", () => {
    // Short tools (read_output at 15s) finish before the watchdog cares and
    // need no beat at all. The ones that matter are those that can still be
    // working when the watchdog runs out — each must have reported many times
    // by then.
    const longRunning = Object.entries(toolBudgetSeconds()).filter(
      ([, seconds]) => seconds * 1_000 >= WATCHDOG_MS / 2
    );

    expect(longRunning.length).toBeGreaterThan(0);

    for (const [tool, seconds] of longRunning) {
      expect(
        (seconds * 1_000) / HEARTBEAT_INTERVAL_MS,
        `${tool} (${seconds}s) must report many times before the watchdog gives up`
      ).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("the agent and the watchdog, wired together", () => {
  let service: SessionTurnStateService;
  let onTimeout: ReturnType<
    typeof vi.fn<
      (
        workspaceId: string,
        sessionId: string,
        lastActivity: string | null
      ) => void
    >
  >;
  let heartbeat: ToolHeartbeat;

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
    // The real wiring: what the agent emits is what the desktop filters.
    heartbeat = new ToolHeartbeat((event) => {
      service.filterDesktopEvent(WS, SESSION, event as DesktopEvent);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    heartbeat.clear();
  });

  const startSilentTool = (command: string): void => {
    service.markSent(WS, SESSION);
    service.filterDesktopEvent(WS, SESSION, {
      type: "event",
      event: {
        type: "tool_execution_start",
        tool: {
          id: "call-1",
          name: "bash",
          type: "bash",
          input: { command },
          args: { command },
        },
      },
    } as DesktopEvent);
    heartbeat.started("call-1");
  };

  it("carries a silent bash call past the watchdog that used to kill it", () => {
    // The reported failure, at the size it was reported: a crawl printing
    // nothing, for longer than the watchdog's patience.
    startSilentTool("node crawl.js");

    vi.advanceTimersByTime(WATCHDOG_MS * 2);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(service.get(WS, SESSION).isBusy).toBe(true);
  });

  it("carries the longest-budgeted tool to the end of its budget", () => {
    const longest = Math.max(...Object.values(toolBudgetSeconds()));
    startSilentTool("node build.js");

    vi.advanceTimersByTime(longest * 1_000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("lets the watchdog fire once the agent genuinely stops", () => {
    // The other half of the contract. If a heartbeat could keep a turn alive
    // after the agent died, the watchdog would be decorative.
    startSilentTool("node crawl.js");
    vi.advanceTimersByTime(WATCHDOG_MS / 2);

    heartbeat.clear(); // the agent process dies mid-call
    vi.advanceTimersByTime(WATCHDOG_MS);

    expect(onTimeout).toHaveBeenCalledWith(WS, SESSION, "bash (node crawl.js)");
  });

  it("lets the watchdog fire on a tool that hung and cannot be killed", () => {
    // `document`, `ppt`, `design`, `delegate_task` and `browser_task` have no
    // native timeout — the budget extension can warn one has overrun but not
    // stop it. Vouching for such a call forever would leave the session
    // unendable except by pressing Stop, so the vouching runs out and the
    // watchdog takes over.
    startSilentTool("node build.js");

    vi.advanceTimersByTime(
      MAX_VOUCHED_RUNTIME_MS + WATCHDOG_MS + HEARTBEAT_INTERVAL_MS
    );

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("lets the watchdog fire once the call finishes and the turn stalls", () => {
    // A tool that ends normally stops the heartbeat. If the agent then wedges
    // between tool calls, the watchdog is the only thing that notices.
    startSilentTool("node crawl.js");
    vi.advanceTimersByTime(WATCHDOG_MS / 2);
    heartbeat.ended("call-1");

    vi.advanceTimersByTime(WATCHDOG_MS);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
