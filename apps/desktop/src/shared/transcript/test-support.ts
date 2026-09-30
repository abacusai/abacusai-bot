/**
 * Test helpers for the v1 → v2 mapper (C-T1, C-T2, and the main-side step
 * and thread-store tests): stable key ordering and provenance walks.
 */
import type { UIMessage } from "@tanstack/ai";

import type { SegmentProvenance } from "./v1-to-ui-messages";

export const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  return value;
};

/** Pretty JSON with sorted keys and a trailing newline, as goldens are kept. */
export const stableJson = (value: unknown): string =>
  `${JSON.stringify(sortKeys(value), null, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The id every input segment is traced under: its own `id`, or the mapper's
 * positional fallback (`segment-<i>`, `<groupId>:<j>` for group members).
 */
export const inputSegmentIds = (segments: readonly unknown[]): string[] => {
  const ids: string[] = [];
  const walk = (value: unknown, fallback: string) => {
    const id =
      isRecord(value) && typeof value.id === "string" ? value.id : fallback;
    ids.push(id);
    if (
      isRecord(value) &&
      value.type === "tool_group" &&
      Array.isArray(value.tools)
    )
      value.tools.forEach((member, index) => walk(member, `${id}:${index}`));
  };
  segments.forEach((segment, index) => walk(segment, `segment-${index}`));
  return ids;
};

export interface ProvenanceHit {
  entry: SegmentProvenance;
  /** The message whose parts `entry.partIndex` indexes (null: a subagent's close frame). */
  message: UIMessage | null;
}

/** Every provenance entry in the messages, sub-agent children included. */
export const provenance = (messages: readonly UIMessage[]): ProvenanceHit[] => {
  const hits: ProvenanceHit[] = [];
  const walk = (list: readonly UIMessage[]) => {
    for (const message of list) {
      const entries = (
        message.metadata as { abacus?: { segments?: SegmentProvenance[] } }
      )?.abacus?.segments;
      for (const entry of entries ?? []) hits.push({ entry, message });
      for (const part of message.parts) {
        if (part.type !== "subagent") continue;
        const close = (
          part.subagent.metadata as
            | { abacus?: { segments?: SegmentProvenance[] } }
            | undefined
        )?.abacus?.segments;
        for (const entry of close ?? []) hits.push({ entry, message: null });
        walk(part.subagent.messages);
      }
    }
  };
  walk(messages);
  return hits;
};
