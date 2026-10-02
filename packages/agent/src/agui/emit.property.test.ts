/**
 * Stream properties (spec §7.4 items 1, 4-7) over 10,000 seeded random
 * sequences of legacy + internal events, starts, stops and stale settles, fed
 * through the real sink, emitter and run controller.
 *
 * Translator only: runs are opened here directly, so this proves the
 * emitter's output is well formed for any input, not admission, hidden-turn
 * or failure attribution. Those, and preservation of what the session
 * emitted, are host.property.test.ts, over the real AguiHost.
 */
import { describe, expect, it } from "vitest";

import { tagEvent } from "../event-meta.js";
import type { InternalAgentEvent } from "../internal-events.js";
import type { AgentEvent, DesktopEvent } from "../protocol.js";
import { violations } from "./__tests__/invariants.js";
import { noCompat } from "./channel.js";
import { AguiEmitter } from "./emit.js";
import { RunController, type TurnToken } from "./runs.js";
import { HostSink } from "./sink.js";
import type { AguiEvent } from "./wire.js";

/** mulberry32: small, seeded, good enough to explore orderings. */
function rng(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulate(seed: number): { out: AguiEvent[]; pendingMatches: boolean } {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const out: AguiEvent[] = [];
  const sink = new HostSink(noCompat);
  const runs: RunController = new RunController({
    threadId: "t",
    write: (event) => sink.writeAgui(event),
    closeOpenParts: () => emitter.closeOpenParts(),
    model: () => "m",
  });
  const emitter: AguiEmitter = new AguiEmitter({
    threadId: "t",
    incarnation: "i",
    runs,
    approvalTimeoutMs: () => Number.POSITIVE_INFINITY,
    now: () => 0,
    log: () => undefined,
  });

  sink.attach({
    emitter,
    runs,
    write: (line) => out.push(JSON.parse(line) as AguiEvent),
  });

  const agent = (event: AgentEvent): void =>
    sink.emit({ type: "event", event });
  const internal = (event: InternalAgentEvent): void => sink.internal(event);
  const desktop = (event: DesktopEvent): void => sink.emit(event);
  const tokens: TurnToken[] = [];
  const children: string[] = [];
  let msg = 0;
  let call = 0;
  let perm = 0;
  const sessionPending = new Set<string>();

  desktop({ type: "ready", model: "m", mode: "DEFAULT" });

  for (let step = 0; step < 40; step += 1) {
    const sub =
      children.length > 0 && random() < 0.4 ? pick(children) : undefined;
    const tag = <E extends AgentEvent>(event: E): E =>
      sub != null ? tagEvent(event, { subagentRunId: sub }) : event;

    switch (Math.floor(random() * 14)) {
      case 0: {
        if (!runs.isOpen()) {
          const token = runs.mint();

          tokens.push(token);
          runs.open(token, `r${tokens.length}`, { serverInitiated: true });
          runs.setCurrent(token);
        }
        break;
      }
      case 1:
        msg += 1;
        internal({
          type: "message_open",
          key: `msg-${msg}`,
          messageId: `s:${msg}`,
        });
        break;
      case 2:
        agent(
          tag({ type: "text_delta", content: "x", messageId: `msg-${msg}` })
        );
        break;
      case 3:
        agent({ type: "thinking_delta", content: "t" });
        if (random() < 0.5) agent({ type: "thinking_complete" });
        break;
      case 4:
        internal({
          type: "message_close",
          key: `msg-${msg}`,
          stopReason: pick(["stop", "toolUse", "length"]),
        });
        break;
      case 5: {
        call += 1;
        const id = `c${call}`;

        if (random() < 0.5) {
          internal({
            type: "tool_call_start",
            toolCallId: id,
            toolName: "bash",
            rawName: "bash",
          });
          internal({
            type: "tool_call_delta",
            toolCallId: id,
            argumentsDelta: "{}",
          });
          internal({
            type: "tool_call_stop",
            toolCallId: id,
            toolName: "bash",
            arguments: "{}",
          });
        }
        agent(
          tag({
            type: "tool_execution_start",
            tool: { id, name: "bash", type: "bash", input: { command: "ls" } },
          })
        );
        break;
      }
      case 6: {
        const id = `c${1 + Math.floor(random() * Math.max(call, 1))}`;

        agent(
          tag({
            type: "tool_execution_complete",
            tool: { id, name: "bash", type: "bash", input: {} },
            result: { id, content: "ok", rejected: random() < 0.3 },
          })
        );
        break;
      }
      case 7: {
        const id = `sub-${step}-${seed}`;

        children.push(id);
        agent(
          tagEvent(
            { type: "subtask_start", id, kind: "delegate" },
            { parentToolCallId: `c${call}` }
          )
        );
        break;
      }
      case 8: {
        const id = children.pop();

        if (id != null)
          agent({
            type: "subtask_end",
            id,
            status: pick(["completed", "failed"] as const),
          });
        break;
      }
      case 9: {
        perm += 1;
        const id = `perm-${perm}`;

        sessionPending.add(id);
        desktop({
          type: "permission_needed",
          permissionId: id,
          request: {
            type: "generic",
            tool: { id: `c${call}`, name: "bash", type: "bash", input: {} },
            displayName: "x",
            toolName: "bash",
            inputSummary: "",
          },
        });
        break;
      }
      case 10: {
        const id = [...sessionPending][0];

        if (id != null) {
          sessionPending.delete(id);
          if (random() < 0.5)
            agent({ type: "permission_cleared", permissionId: id });
          else
            for (const event of emitter.resolved(id, "accept", "respond"))
              sink.writeAgui(event);
        }
        break;
      }
      case 11: {
        // Stop: cancelling, then the (possibly stale) owner settles.
        const token = runs.openToken();

        runs.markCancelling(token);
        runs.settle(token);
        break;
      }
      case 12:
        // A superseded token settling late must never close the newer run.
        if (tokens.length > 1) runs.settle(tokens[0]);
        break;
      default:
        runs.settle(tokens.at(-1));
        runs.setCurrent(null);
        children.length = 0;
        break;
    }
  }

  runs.settleOpen();

  const pending = emitter
    .pendingItems()
    .map((item) => item.id)
    .sort();

  return {
    out,
    pendingMatches:
      JSON.stringify(pending) === JSON.stringify([...sessionPending].sort()),
  };
}

describe("stream properties", () => {
  it("hold for 10,000 seeded sequences", () => {
    for (let seed = 1; seed <= 10_000; seed += 1) {
      const { out, pendingMatches } = simulate(seed);
      const problems = violations(out);

      if (problems.length > 0 || !pendingMatches) {
        expect({ seed, problems, pendingMatches }).toEqual({
          seed,
          problems: [],
          pendingMatches: true,
        });
      }
    }
  }, 120_000);
});
