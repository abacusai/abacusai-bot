/**
 * The relay's event ids and control yields (spec 00 A.3, 00-agent-agui
 * "Implementation notes (main relay)", spec 02 §14.3-§14.4). The only place
 * that knows how an event id is spelled, so a change to the resume point
 * (an epoch prefix, say) is one edit here.
 */
import { getEventMeta } from "@orpc/client";
import type { StreamChunk } from "@tanstack/ai";

/** `CUSTOM abacus.subscribed` / `abacus.resync`: no event id, never dispatched. */
export type ControlEvent =
  | { kind: "subscribed"; epoch?: string }
  | { kind: "resync"; epoch?: string };

const controlValue = (event: StreamChunk): Record<string, unknown> => {
  const value = (event as { value?: unknown }).value;
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
};

export const controlOf = (event: StreamChunk): ControlEvent | null => {
  if (event.type !== "CUSTOM") return null;
  const name = (event as { name?: string }).name;
  if (name !== "abacus.subscribed" && name !== "abacus.resync") return null;
  const epoch = controlValue(event).epoch;
  return {
    kind: name === "abacus.subscribed" ? "subscribed" : "resync",
    ...(typeof epoch === "string" ? { epoch } : {}),
  };
};

/**
 * The relay seq of an event, from its oRPC event id (`String(seq)`), or
 * null for a control yield or an id this renderer cannot read.
 */
export const eventSeq = (event: StreamChunk): number | null => {
  const id = getEventMeta(event as object)?.id;
  if (id == null) return null;
  const tail = id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
  const seq = Number(tail);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
};

/** `ai.subscribe`'s `lastEventId` for "everything after `seq`". */
export const resumePoint = (seq: number): string => String(seq);
