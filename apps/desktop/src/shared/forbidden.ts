/**
 * A refusal main's services say in a form the RPC layer maps to `FORBIDDEN
 * { reason }` (spec 00 A.5) without reading prose: a path outside its
 * checkout (`outside`), a navigation a local-file view does not allow
 * (`local-file`). Legacy IPC never sees one.
 */
export class ForbiddenError extends Error {
  constructor(
    readonly reason: string,
    message: string = reason
  ) {
    super(message);
  }
}
