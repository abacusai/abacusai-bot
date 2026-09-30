/**
 * Synthetic threads for the Electron chat gates (spec 02 §13: R2-T16's
 * Electron half, R2-T31). Dev-only: reached through the gallery's `bench-*`
 * fixtures (`bench.tsx`), never from production code.
 *
 * Completed history is folded once by a real `StreamProcessor` (as main folds
 * its transcript), so the kit hydrates exactly what the processor produces;
 * active runs stay as seq-numbered events the relay replays through
 * `joinRun`.
 */
import {
  StreamProcessor,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { restoreInboundChunk } from "@tanstack/ai/client";

import * as b from "../builders";
import type { RelayEvent } from "../relay";

export interface BenchThread {
  /** Completed transcript (`FakeRelay` history). */
  history: UIMessage[];
  /** Events in the relay log (an active run, or nothing). */
  events: RelayEvent[];
}

const fold = (events: readonly StreamChunk[]): UIMessage[] => {
  const processor = new StreamProcessor();
  for (const event of events)
    processor.processChunk(restoreInboundChunk(structuredClone(event)));
  return processor.getMessages();
};

const seqd = (events: readonly StreamChunk[], from = 1): RelayEvent[] =>
  events.map((event, index) => ({ seq: from + index, event }));

/** Markdown with the costly shapes: code, a table, inline and display math. */
const richMarkdown = (i: number): string =>
  [
    `### Step ${i}`,
    "",
    `The change touches **${i % 7} files**; the cost grows as $O(n \\log n)$ in files, and $x_{${i}}^2 + y^2 = r^2$ holds.`,
    "",
    "```ts",
    `export const step${i} = (input: readonly number[]): number =>`,
    "  input.reduce((sum, value) => sum + value * value, 0);",
    "```",
    "",
    "| File | Added | Removed |",
    "|---|---:|---:|",
    `| src/a${i}.ts | ${i % 40} | ${i % 9} |`,
    `| src/b${i}.ts | ${(i * 3) % 40} | ${(i * 5) % 9} |`,
    "",
    "$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$",
    "",
    `- one [link](https://example.com/${i})`,
    "- two `inline code`",
  ].join("\n");

const toolsFor = (
  runId: string,
  messageId: string,
  count: number
): StreamChunk[] => {
  const events: StreamChunk[] = [];
  for (let t = 0; t < count; t += 1) {
    const id = `${runId}:c${t}`;
    const kind = t % 3;
    if (kind === 0) {
      events.push(
        ...b.toolCall(id, "bash", messageId, { command: `npm test -- ${t}` }),
        b.toolResult(id, {
          text: `ok ${t}`,
          terminal: { output: `PASS src/${t}.test.ts\n` },
        })
      );
    } else if (kind === 1) {
      events.push(
        ...b.toolCall(id, "read", messageId, { path: `src/file-${t}.ts` }),
        b.toolResult(id, { text: `export const v${t} = ${t};\n` })
      );
    } else {
      events.push(
        ...b.toolCall(id, "grep", messageId, { pattern: `needle${t}` }),
        b.toolResult(id, { text: `${t} matches` })
      );
    }
  }
  return events;
};

/**
 * R2-T31(a): `messages` messages (user/assistant turns), `toolRows` tool
 * calls spread over the assistant messages, and `subagents` sub-agent cards.
 */
export const richThread = ({
  messages = 1000,
  toolRows = 1500,
  subagents = 5,
}: {
  messages?: number;
  toolRows?: number;
  subagents?: number;
} = {}): BenchThread => {
  const turns = Math.floor(messages / 2);
  const perTurn = Math.floor(toolRows / turns);
  let extra = toolRows - perTurn * turns;
  const events: StreamChunk[] = [];
  const base = Date.now() - turns * 60_000;
  for (let turn = 0; turn < turns; turn += 1) {
    const runId = `r${turn}`;
    const assistant = `a${turn}`;
    const at = base + turn * 60_000;
    events.push(b.runStarted(runId, { timestamp: at }));
    events.push(
      ...b.text(`u${turn}`, "user", `Question ${turn}: what changed here?`)
    );
    events.push(b.textStart(assistant));
    const tools = perTurn + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    events.push(...toolsFor(runId, assistant, tools));
    const cardIndex = turns - 1 - turn;
    if (cardIndex >= 0 && cardIndex < subagents) {
      const call = `${runId}:delegate`;
      const sub = `${runId}:sub`;
      events.push(
        ...b.toolCall(call, "delegate_task", assistant, {
          task: `Audit package ${cardIndex}`,
        }),
        b.subagentStarted(
          sub,
          "delegate",
          `Audit package ${cardIndex}`,
          call,
          assistant
        ),
        ...b.toolCall(
          `${sub}:t1`,
          "ls",
          "",
          { path: `packages/p${cardIndex}` },
          { subagentRunId: sub }
        ),
        b.toolResult(
          `${sub}:t1`,
          { text: "src\npackage.json" },
          { subagentRunId: sub }
        ),
        ...b.text(`${sub}:final`, "assistant", "No issues.", {
          subagentRunId: sub,
        }),
        b.subagentFinished(sub, "No issues."),
        b.toolResult(call, { text: "No issues." })
      );
    }
    events.push(
      b.textDelta(assistant, richMarkdown(turn)),
      b.textEnd(assistant)
    );
    events.push(b.runFinished(runId, "success", { timestamp: at + 30_000 }));
  }
  return { history: fold(events), events: [] };
};

/**
 * R2-T31(b): an active run whose replay is `events` events producing
 * `messages` messages (START + CONTENT per message, END for the rest).
 */
export const activeReplay = ({
  events: total = 800,
  messages = 350,
}: { events?: number; messages?: number } = {}): BenchThread => {
  const runId = "r-live";
  const out: StreamChunk[] = [b.runStarted(runId, { timestamp: Date.now() })];
  const ends = total - 1 - messages * 2;
  if (ends < 0 || ends > messages)
    throw new Error(`bench: ${total} events cannot make ${messages} messages`);
  for (let i = 0; i < messages; i += 1) {
    const id = `m${i}`;
    out.push(
      b.textStart(id, i === 0 || i % 7 === 0 ? "user" : "assistant"),
      b.textDelta(id, `Replayed message ${i}: ${"lorem ipsum ".repeat(4)}`)
    );
    if (i < ends) out.push(b.textEnd(id));
  }
  return { history: [], events: seqd(out) };
};

/** R2-T31(c) and R2-T16's window: one assistant message with `tools` calls. */
export const hugeToolMessage = (tools = 3000): BenchThread => {
  const runId = "r-tools";
  const events: StreamChunk[] = [
    b.runStarted(runId, { timestamp: Date.now() - 120_000 }),
    ...b.text("u-tools", "user", "Run every check."),
    b.textStart("a-tools"),
    ...toolsFor(runId, "a-tools", tools),
    b.textDelta("a-tools", "All checks ran."),
    b.textEnd("a-tools"),
    b.runFinished(runId, "success", { timestamp: Date.now() - 1000 }),
  ];
  // Some history above it, so the window has earlier rows too.
  const before = richThread({ messages: 40, toolRows: 20, subagents: 0 });
  return { history: [...before.history, ...fold(events)], events: [] };
};

/**
 * R2-T16 (Electron) loader cases: a thread whose only run is active, with its
 * echo and some streamed text already in the relay log.
 */
export const onlyActiveRun = (): BenchThread => {
  const runId = "r-only";
  return {
    history: [],
    events: seqd([
      b.runStarted(runId, { timestamp: Date.now() - 5000 }),
      ...b.text("u-only", "user", "Echoed before the loader committed"),
      b.textStart("a-only"),
      b.textDelta("a-only", "Streamed so far: the first paragraph. "),
      b.textDelta("a-only", "And the second sentence arrived too."),
    ]),
  };
};

/** R2-T31(d): the events of one live run streaming `bytes` of Markdown. */
export const streamingRun = (
  bytes = 20 * 1024,
  delta = 120
): { start: StreamChunk[]; deltas: StreamChunk[]; end: StreamChunk[] } => {
  const runId = "r-stream";
  const id = "a-stream";
  let source = "";
  for (let i = 0; source.length < bytes; i += 1)
    source += `${richMarkdown(i)}\n\n`;
  source = source.slice(0, bytes);
  const deltas: StreamChunk[] = [];
  for (let at = 0; at < source.length; at += delta)
    deltas.push(b.textDelta(id, source.slice(at, at + delta)));
  return {
    start: [
      b.runStarted(runId, { timestamp: Date.now() }),
      ...b.text("u-stream", "user", "Write the long answer."),
      b.textStart(id),
    ],
    deltas,
    end: [b.textEnd(id), b.runFinished(runId)],
  };
};
