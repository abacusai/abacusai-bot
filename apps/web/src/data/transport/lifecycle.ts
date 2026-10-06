/**
 * Connection state shared by every transport (spec 09 D2). A MessagePort
 * (Electron) or an in-process channel is `"open"` and then `"closed"` for
 * good. The browser's host transport also reports `"connecting"` (before its
 * first socket) and `"reconnecting"` (between sockets); each socket it opens
 * is a new `generation`. `"closed"` is always terminal. Consumers follow it
 * with `untilOpen` (`data/queries/notices.ts`).
 */
import { ORPCError } from "@orpc/client";

export type TransportState = "connecting" | "open" | "reconnecting" | "closed";

/**
 * The call never reached the host: it waited for a connection past its
 * deadline, or the transport closed while it waited. Unlike an error after
 * dispatch, nothing was sent, so a retry cannot duplicate it.
 */
export const HOST_UNAVAILABLE = "HOST_UNAVAILABLE";

export const hostUnavailable = (message: string): ORPCError<string, unknown> =>
  new ORPCError(HOST_UNAVAILABLE, { message });

export const isHostUnavailable = (error: unknown): boolean =>
  error instanceof ORPCError && error.code === HOST_UNAVAILABLE;
