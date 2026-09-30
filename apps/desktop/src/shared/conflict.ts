/**
 * "Your view of this is stale, or the id is taken", said by a service in a
 * form the RPC layer maps to `CONFLICT { reason }` (spec 00 A.5) without
 * reading prose. Legacy IPC sees exactly what it saw before: the plain
 * `Error` name and the same message.
 */
export class ConflictError extends Error {}
