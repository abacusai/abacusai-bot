/**
 * Internal facts about a legacy event, kept beside it rather than on it.
 *
 * The AG-UI emitter needs to know which sub-agent an event came from, what
 * produced an error, and which tool call started a sub-agent. None of that may
 * reach the NDJSON/compat bytes, which stay byte-identical to today. A WeakMap
 * keyed by the event object carries it with no field to strip: it is invisible
 * to JSON.stringify and to every existing consumer and test.
 */
import type { AgentEvent, ErrorOrigin } from "./protocol.js";

export interface EventMeta {
  origin?: ErrorOrigin;
  /** The sub-agent (subtask id) this event was forwarded for. */
  subagentRunId?: string;
  /** On subtask_start: the tool call that started the sub-agent. */
  parentToolCallId?: string;
}

const meta = new WeakMap<object, EventMeta>();

/** Attach (merge) internal facts to an event object. Returns the event. */
export function tagEvent<T extends object>(event: T, facts: EventMeta): T {
  meta.set(event, { ...meta.get(event), ...facts });

  return event;
}

export function eventMeta(event: object): EventMeta {
  return meta.get(event) ?? {};
}

/**
 * An emit that stamps everything it forwards as belonging to one sub-agent
 * (spec §3.3.4 `scopeEmit`). A nested scope keeps the innermost owner; the
 * outer id becomes the nested subtask's parent.
 */
export function scopeEmit(
  emit: (event: AgentEvent) => void,
  subagentRunId: string
): (event: AgentEvent) => void {
  return (event) => {
    if (eventMeta(event).subagentRunId == null) {
      tagEvent(event, { subagentRunId });
    }

    emit(event);
  };
}
