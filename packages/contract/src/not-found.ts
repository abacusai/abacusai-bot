/**
 * "The thing you named is gone", said by main's services in a form the RPC layer can
 * map to `NOT_FOUND { entity, id }` (spec 00 A.5) without reading prose.
 *
 * Legacy IPC keeps seeing exactly what it saw before: a result's `error`
 * string is the same constant, and a thrown error keeps the plain `Error`
 * name and message (Electron puts `String(error)` into the rejection).
 */
import type { NotFoundEntity } from "./contract/errors";

/** A result object's `error` for a workspace id that is not in the list. */
export const WORKSPACE_NOT_FOUND = "Workspace not found.";

export class EntityNotFoundError extends Error {
  constructor(
    readonly entity: NotFoundEntity,
    readonly id: string,
    message: string
  ) {
    super(message);
  }
}
