import type { StreamChunk } from "@tanstack/ai";

/**
 * The agent's recorded AG-UI goldens, copied with seqs by
 * `scripts/sync-chat-fixtures.mjs` (spec 02 §11.1). The kit renders what
 * the agent actually emits; R2-T29 keeps the copies equal to the sources.
 */
import { outgoingWords } from "#shared/reply-envelope";

import type { RelayEvent } from "./relay";

const RAW = import.meta.glob<string>("./scenarios/*.agui.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});

const parseScenarioLines = (text: string): RelayEvent[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parsed = JSON.parse(line) as { seq: number; event: StreamChunk };
      return { seq: parsed.seq, event: parsed.event };
    });

export const GOLDEN_NAMES = Object.keys(RAW)
  .map((path) => /\/([^/]+)\.agui\.jsonl$/.exec(path)![1]!)
  .sort();

export const golden = (name: string): RelayEvent[] => {
  const text = RAW[`./scenarios/${name}.agui.jsonl`];
  if (text == null) throw new Error(`chat: no golden named ${name}`);
  const events = parseScenarioLines(text);
  if (name !== "bot-housekeeping") return events;
  const messages = new Map<string, { text: string; first: number }>();
  events.forEach(({ event }, index) => {
    if (event.type !== "TEXT_MESSAGE_CONTENT") return;
    const message = messages.get(event.messageId) ?? { text: "", first: index };
    message.text += event.delta;
    messages.set(event.messageId, message);
  });
  return events.map((entry, index) => {
    const event = entry.event;
    if (event.type !== "TEXT_MESSAGE_CONTENT") return entry;
    const message = messages.get(event.messageId)!;
    return {
      ...entry,
      event: {
        ...event,
        delta: index === message.first ? outgoingWords(message.text) : "",
      },
    };
  });
};

/** The raw copy, for R2-T29's equality check. */
export const goldenText = (name: string): string =>
  RAW[`./scenarios/${name}.agui.jsonl`] ?? "";
