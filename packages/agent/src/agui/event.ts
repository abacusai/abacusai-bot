/**
 * The single checked constructor for AG-UI events (spec §2.3). Built on
 * `@ag-ui/core`'s `EventType` enum, so every event is assignable to the
 * canonical `Event` union (and TanStack's `StreamChunk`) with no casts.
 */
import {
  EventType,
  type BaseEvent,
  type Event as AguiCoreEvent,
  type EventPayloadOf,
} from "@ag-ui/core";

import type {
  AguiEvent,
  CustomName,
  CustomValues,
  EmittedType,
} from "./wire.js";

/** Clock for `timestamp`; swapped by tests for deterministic fixtures. */
let clock: () => number = () => Date.now();

export function setEventClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

export function aguiEvent<T extends EmittedType>(
  type: T,
  payload: EventPayloadOf<T> &
    Partial<Pick<BaseEvent, "metadata" | "subagentRunId">>
): Extract<AguiCoreEvent, { type: T }> {
  return { type, ...payload, timestamp: clock() } as unknown as Extract<
    AguiCoreEvent,
    { type: T }
  >;
}

export function custom<N extends CustomName>(
  name: N,
  value: CustomValues[N]
): AguiEvent {
  return aguiEvent(EventType.CUSTOM, { name, value });
}

/** Custom names that may appear outside an open run (*S* in §2.3). */
export const SESSION_SCOPED_CUSTOM: ReadonlySet<string> = new Set<CustomName>([
  "session.ready",
  "session.cleared",
  "wire.hello",
  "wire.compat_lost",
  "agent.status",
  "agent.heartbeat",
  "agent.error",
  "agent.notification",
  "run.ack",
  "permission.requested",
  "permission.resolved",
  "permission.cleared",
  "permission.response_rejected",
  "permission.pending",
  "queue.updated",
  "skills.loaded",
  "mcp.servers",
  "mcp.server_logs",
]);

/** Whether an event may only appear inside an open run. */
export function isRunScoped(event: AguiEvent): boolean {
  switch (event.type) {
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
      return false;
    case EventType.CUSTOM:
      return !SESSION_SCOPED_CUSTOM.has(event.name);
    default:
      return true;
  }
}

/** One stdout line. */
export function serialize(event: AguiEvent): string {
  return `${JSON.stringify(event)}\n`;
}
