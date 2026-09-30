/**
 * A refusal main's services say in a form the RPC layer maps to `FORBIDDEN
 * { reason }` (spec 00 A.5): a path outside its checkout (`outside`), a
 * navigation a local-file view does not allow (`local-file`). One class with
 * `service-errors.ts`, re-exported here for the checkout and browser code.
 */
export { ForbiddenError } from "./service-errors";
