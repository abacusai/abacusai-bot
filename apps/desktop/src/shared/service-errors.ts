/**
 * Typed service failures the RPC layer maps onto the contract's error codes
 * (spec 00 A.5; spec 03 §24.4) without reading prose, like `ConflictError`
 * and `EntityNotFoundError`. Legacy IPC sees exactly what it saw before: the
 * plain `Error` name (none of these sets `name`) and the same message.
 */
import type { PreconditionReason } from "./contract/errors";

/** `PRECONDITION_FAILED { reason }`: a limit or a missing prerequisite. */
export class PreconditionError extends Error {
  constructor(
    readonly reason: PreconditionReason,
    message: string
  ) {
    super(message);
  }
}

/** `FORBIDDEN { reason }`: the operation is never allowed on this entity. */
export class ForbiddenError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
  }
}

/** `BAD_REQUEST`: a value the schema cannot rule out (a blank name). */
export class InvalidInputError extends Error {}
