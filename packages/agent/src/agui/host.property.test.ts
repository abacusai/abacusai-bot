/**
 * Host-level properties (spec §7.4 items 1-3, 6, 8, 9), over seeded random
 * command sequences sent through the real AguiHost's stdin: admission,
 * cancel, reset, permission answers (valid, stale and legacy) and queue
 * commands race turns that stream text, run tools, park on permissions and
 * gates, hide housekeeping turns and throw.
 *
 * The emitter-level test (emit.property.test.ts) exercises the translator in
 * isolation; this one derives the expected AG-UI content from what the
 * session actually emitted and asserts it is preserved, not only that the
 * stream is well formed:
 *
 *   - every RUN_STARTED has exactly one terminal (violations());
 *   - acked queued/duplicate/rejected runs never open; started ones open once;
 *   - at most one live (not aborted) session.send at any time;
 *   - every text the session emitted while its run was open, outside a hidden
 *     turn, appears in exactly that run; hidden text never appears; text
 *     emitted with no run open (after the user's run settled) never appears;
 *   - a thrown send ends its own open run in RUN_ERROR with its message, and
 *     no other run ever carries that failure;
 *   - once commands settle, permission.pending equals the session's waiters,
 *     and an answer with a wrong turn never releases one.
 *
 * Superseded events: pi emits nothing for an aborted turn once `stop()` has
 * resolved, and the scripted session honours that, so no "late" event exists
 * to attribute; the emitter's own drop rule is covered in emit.test.ts.
 */
import { describe, expect, it } from "vitest";

import { violations } from "./__tests__/invariants.js";
import {
  scripted,
  toolRequest,
  type Scripted,
  type TurnApi,
} from "./__tests__/scripted-session.js";
import type { AguiEvent, PermissionDescriptor } from "./wire.js";

/** mulberry32. */
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

interface Emitted {
  content: string;
  /** The run open when the session emitted it, if any. */
  runId: string | undefined;
  hidden: boolean;
}

interface Thrown {
  message: string;
  /** The run open when that send started. */
  runId: string | undefined;
}

const flush = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

async function sequence(seed: number): Promise<string[]> {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const emitted: Emitted[] = [];
  const thrown: Thrown[] = [];
  const gates = new Set<string>();
  const asked = new Set<string>();
  const running = new Set<TurnApi>();
  const problems: string[] = [];
  let host: Scripted | undefined;
  const openRun = (): string | undefined => host?.host.runs.openRunId();

  const script = async (api: TurnApi): Promise<void> => {
    const n = api.index;
    const runId = openRun();
    let hidden = false;
    // Admission: no other send may still be live (not aborted) now.
    const live = [...running].filter((other) => !other.aborted()).length;

    if (live > 0) problems.push(`send ${n} started beside ${live} live sends`);
    running.add(api);
    try {
      const steps = 1 + Math.floor(random() * 6);

      for (let k = 0; k < steps && !api.aborted(); k += 1) {
        switch (Math.floor(random() * 8)) {
          case 0:
          case 1: {
            const content = `t${n}-${k}`;

            emitted.push({ content, runId: openRun(), hidden });
            api.agent({ type: "text_delta", content, messageId: `msg-${n}` });
            break;
          }
          case 2: {
            const id = `c${n}-${k}`;
            const tool = toolRequest(id, "read", { path: id });

            api.agent({ type: "tool_execution_start", tool });
            api.agent({
              type: "tool_execution_complete",
              tool,
              result: { id, content: "ok", rejected: false },
            });
            break;
          }
          case 3: {
            const gate = `g${n}-${k}`;

            gates.add(gate);
            await api.gate(gate);
            break;
          }
          case 4: {
            const id = `perm-${n}-${k}`;

            asked.add(id);
            await api.ask(id, {
              type: "generic",
              tool: toolRequest(id, "thing", {}),
              displayName: "Thing",
              toolName: "thing",
              inputSummary: "",
            });
            asked.delete(id);
            break;
          }
          case 5:
            if (!hidden && random() < 0.5) {
              // Housekeeping: the user's reply is over.
              api.settled();
              hidden = true;
              api.internal({
                type: "hidden_turn",
                phase: "start",
                customType: "h",
              });
            }
            break;
          case 6:
            if (random() < 0.3 && !hidden) {
              const message = `boom${n}`;

              thrown.push({ message, runId });
              throw new Error(message);
            }
            break;
          default:
            await Promise.resolve();
        }
      }
    } finally {
      if (hidden) {
        api.internal({ type: "hidden_turn", phase: "end", customType: "h" });
      }
      running.delete(api);
    }
  };

  host = await scripted(async (api) => {
    // An aborted turn is no longer live: its remaining steps emit nothing.
    await script(api);
  });

  const s = host;
  const acks = (): Array<{ runId: string; status: string }> =>
    s.custom<{ runId: string; status: string }>("run.ack");
  const pendingItems = (): PermissionDescriptor[] =>
    s.custom<{ items: PermissionDescriptor[] }>("permission.pending").at(-1)
      ?.items ?? [];
  let runs = 0;
  const sendRun = (): void => {
    runs += 1;
    const runId =
      random() < 0.15 && runs > 1 ? `run-${runs - 1}` : `run-${runs}`;

    s.send({
      type: "run",
      input: {
        threadId: "t-1",
        runId,
        messages: [{ id: `u-${runs}`, role: "user", content: `ask ${runs}` }],
        tools: [],
        context: [],
        state: {},
      },
    });
  };
  /** A turn starter racing the Stop or reset just written. */
  const race = (step: number): void => {
    if (random() < 0.6) {
      if (random() < 0.5) sendRun();
      else s.send({ type: "send", message: `racing ${step}` });
    }
  };

  for (let step = 0; step < 30; step += 1) {
    const roll = random();

    if (roll < 0.2) {
      sendRun();
    } else if (roll < 0.3) {
      s.send({ type: "send", message: `legacy ${step}` });
    } else if (roll < 0.36) {
      s.send({ type: "enqueue", message: `queued ${step}`, hidden: false });
    } else if (roll < 0.4) {
      s.send({ type: "dequeue" });
    } else if (roll < 0.47) {
      s.send(
        random() < 0.5
          ? { type: "cancel", runId: openRun() ?? "gone" }
          : { type: "cancel", runId: "stale" }
      );
      race(step);
    } else if (roll < 0.5) {
      s.send({ type: "stop" });
      race(step);
    } else if (roll < 0.53) {
      s.send({ type: "reset_conversation" });
      race(step);
    } else if (roll < 0.68) {
      const items = pendingItems();

      if (items.length > 0) {
        const item = pick(items);
        const lineage = item.metadata.abacus.lineage;
        const wrongTurn = random() < 0.25;

        s.send({
          type: "permission.respond",
          lineage: wrongTurn
            ? { ...lineage, turnSeq: lineage.turnSeq + 1 }
            : lineage,
          decision: "accept",
        });
        if (wrongTurn) {
          await flush();
          if (s.session.answers.some((a) => a.permissionId === item.id)) {
            problems.push(`${item.id}: a wrong turn released its waiter`);
          }
        }
      }
    } else if (roll < 0.72) {
      const items = pendingItems();

      if (items.length > 0) {
        s.send({
          type: "permission_response",
          permissionId: pick(items).id,
          decision: "reject",
        });
      }
    } else if (roll < 0.9) {
      if (gates.size > 0) {
        const gate = pick([...gates]);

        gates.delete(gate);
        s.session.open(gate);
      }
    }

    await flush();

    // Quiescent: the store the renderer sees is the session's own.
    const store = pendingItems()
      .map((item) => item.id)
      .sort();
    const waiters = [...asked].filter((id) =>
      s.session.hasPendingPermission(id)
    );

    if (JSON.stringify(store) !== JSON.stringify(waiters.sort())) {
      problems.push(
        `step ${step}: pending ${JSON.stringify(store)} but waiters ${JSON.stringify(waiters)}`
      );
    }
  }

  // Let everything finish: open every gate, answer every card.
  for (let round = 0; round < 200; round += 1) {
    for (const gate of gates) s.session.open(gate);
    gates.clear();
    for (const item of pendingItems()) {
      s.send({
        type: "permission.respond",
        lineage: item.metadata.abacus.lineage,
        decision: "accept",
      });
    }
    await flush(10);
    if (
      s.session.inFlight === 0 &&
      !s.host.runs.isOpen() &&
      pendingItems().length === 0
    ) {
      break;
    }
  }
  await s.close();

  const events = s.events();

  problems.push(...violations(events));

  // Acks: queued/duplicate/rejected never open; started opens exactly once.
  const started = new Map<string, number>();

  for (const event of events) {
    if (event.type === "RUN_STARTED") {
      started.set(event.runId, (started.get(event.runId) ?? 0) + 1);
    }
  }
  for (const ack of acks()) {
    const opened = started.get(ack.runId) ?? 0;

    if (ack.status === "started" && opened !== 1) {
      problems.push(`${ack.runId}: started, opened ${opened} times`);
    }
  }
  for (const ack of acks()) {
    if (
      ack.status !== "started" &&
      !acks().some((a) => a.runId === ack.runId && a.status === "started") &&
      started.has(ack.runId)
    ) {
      problems.push(`${ack.runId}: ${ack.status} but a run opened`);
    }
  }

  // Admission held through every Stop and reset: nothing prompted the
  // session while it was aborting or being replaced.
  for (const text of s.session.sentDuringAbort) {
    problems.push(`"${text}" was sent while an abort was landing`);
  }

  // Preservation, run by run.
  const runOf = new Map<AguiEvent, string>();
  let current: string | undefined;

  for (const event of events) {
    if (event.type === "RUN_STARTED") current = event.runId;
    if (current != null) runOf.set(event, current);
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      current = undefined;
    }
  }
  const textIn = new Map<string, string>();

  for (const event of events) {
    if (event.type === "TEXT_MESSAGE_CONTENT") {
      textIn.set((event as { delta: string }).delta, runOf.get(event) ?? "");
    }
  }
  for (const item of emitted) {
    const at = textIn.get(item.content);

    if (item.hidden || item.runId == null) {
      if (at != null) problems.push(`${item.content}: should not appear`);
    } else if (at !== item.runId) {
      problems.push(
        `${item.content}: emitted in ${item.runId}, found in ${at ?? "nothing"}`
      );
    }
  }

  // Failures stay with the send that threw.
  const errors = events.filter((event) => event.type === "RUN_ERROR") as Array<
    AguiEvent & { message: string; metadata: { tanstack: { runId: string } } }
  >;

  for (const error of errors) {
    const owner = thrown.find((t) => t.message === error.message);

    if (owner != null && owner.runId !== error.metadata.tanstack.runId) {
      problems.push(
        `${error.message} (from ${owner.runId}) failed ${error.metadata.tanstack.runId}`
      );
    }
  }
  // A send throws only while live and before housekeeping, so its own run
  // is open: it must end in exactly that failure.
  for (const t of thrown) {
    if (
      !errors.some(
        (error) =>
          error.message === t.message &&
          error.metadata.tanstack.runId === t.runId
      )
    ) {
      problems.push(`${t.message}: its run ${t.runId} did not end in it`);
    }
  }

  if (problems.length > 0 && process.env.HOST_PROPERTY_DEBUG === "1") {
    console.log(
      events
        .map((event) =>
          event.type === "CUSTOM"
            ? `CUSTOM:${event.name} ${JSON.stringify(event.value).slice(0, 120)}`
            : `${event.type} ${JSON.stringify(event).slice(0, 160)}`
        )
        .join("\n")
    );
    console.log(JSON.stringify(emitted));
  }

  return problems.map((problem) => `seed ${seed}: ${problem}`);
}

describe("host properties over random command sequences", () => {
  it("holds for 300 seeded sequences", async () => {
    const problems: string[] = [];

    const seeds = Number(process.env.HOST_PROPERTY_SEEDS ?? 300);

    const first = Number(process.env.HOST_PROPERTY_FIRST ?? 1);

    for (let seed = first; seed < first + seeds; seed += 1) {
      problems.push(...(await sequence(seed)));
    }

    expect(problems).toEqual([]);
  }, 120_000);
});
