/**
 * Spec 07 review r1 #10: keep-awake (and every `hasActiveAgentTurn` reader)
 * follows the relay's AG-UI run state for an agui runtime, whatever order
 * stdout (AG-UI) and fd 3 (compat, which drives main's turn state) deliver
 * in; the relay announces each busy change so keep-awake re-evaluates.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentStatus, type DesktopEvent } from "#shared/agent-types";

import { AguiRelayService } from "../agui/relay-service";
import { agentTurnBusy } from "./agent-busy";
import type { AgentWire } from "./cli-manager-service";
import { SessionTurnStateService } from "./session-turn-state-service";
import { ThreadStore } from "./thread-store";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-busy-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const setup = () => {
  const runtime = {};
  const relay = new AguiRelayService({
    host: {
      workspaceOf: () => "w",
      runtime: () => ({ wire: "agui", status: "running" }),
      start: async () => true,
      send: () => runtime,
      markSent: () => undefined,
      markStopped: () => undefined,
    },
    files: new ThreadStore({ home: () => home, log: () => undefined }),
    log: () => undefined,
  });
  const turnState = new SessionTurnStateService(() => undefined);
  const wires = new Map<string, AgentWire>([
    ["agui-1", "agui"],
    ["nd-1", "ndjson"],
  ]);
  const changes: boolean[] = [];
  relay.onBusyChange((busy) => changes.push(busy));
  const busy = () =>
    agentTurnBusy({
      relay,
      turnState,
      wireOf: (sessionId) => wires.get(sessionId) ?? null,
    });
  const agui = (event: Record<string, unknown>) =>
    relay.ingest("agui-1", event, { wire: "agui", runtime });
  const compat = (sessionId: string, status: AgentStatus) =>
    turnState.filterDesktopEvent("w", sessionId, {
      type: "event",
      event: { type: "status_changed", status },
    } as unknown as DesktopEvent);
  agui({
    type: "CUSTOM",
    name: "wire.hello",
    value: { protocol: 1, wire: "agui", compat: "fd", incarnation: "i" },
  });
  return { relay, turnState, busy, agui, compat, changes };
};

const START = { type: "RUN_STARTED", threadId: "agui-1", runId: "r1" };
const END = {
  type: "RUN_FINISHED",
  threadId: "agui-1",
  runId: "r1",
  outcome: { type: "success" },
};

describe("agent busy follows the relay for agui runtimes (both pipe orderings)", () => {
  it("stdout first: the run starts busy before compat says so, and ends idle while compat still says busy", () => {
    const { busy, agui, compat, changes } = setup();
    agui(START);
    expect(busy()).toBe(true);
    compat("agui-1", AgentStatus.Streaming);
    agui(END);
    // Compat's idle has not arrived yet: the relay's terminal decides.
    expect(busy()).toBe(false);
    compat("agui-1", AgentStatus.Idle);
    expect(busy()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("fd 3 first: compat says idle before the terminal, and the run stays busy until it", () => {
    const { busy, agui, compat, changes } = setup();
    compat("agui-1", AgentStatus.Streaming);
    // Compat's busy alone is not an agui run.
    expect(busy()).toBe(false);
    agui(START);
    compat("agui-1", AgentStatus.Idle);
    expect(busy()).toBe(true);
    agui(END);
    expect(busy()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("an ndjson runtime still counts through main's turn state", () => {
    const { busy, compat } = setup();
    compat("nd-1", AgentStatus.Streaming);
    expect(busy()).toBe(true);
    compat("nd-1", AgentStatus.Idle);
    expect(busy()).toBe(false);
  });

  it("an admission in flight is busy before its run starts; a crash ends it", async () => {
    const { relay, busy, agui, changes } = setup();
    const sent = relay
      .send({
        threadId: "agui-1",
        runId: "r2",
        messages: [
          { id: "u", role: "user", parts: [{ type: "text", content: "hi" }] },
        ],
      })
      .catch(() => undefined);
    expect(busy()).toBe(true);
    agui({
      type: "CUSTOM",
      name: "run.ack",
      value: { runId: "r2", status: "started" },
    });
    agui({ type: "RUN_STARTED", threadId: "agui-1", runId: "r2" });
    relay.failActiveRun("agui-1", "inactivity_timeout", "quiet");
    await sent;
    expect(busy()).toBe(false);
    expect(changes.at(-1)).toBe(false);
  });
});
