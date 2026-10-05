import { oc } from "@orpc/contract";

import { COMMON_ERRORS } from "./errors";

/**
 * What a procedure is to the renderer. `query` goes through
 * `orpc.<path>.queryOptions`, `mutation` through `mutationOptions`, and
 * `subscription` is an event iterator.
 */
export type ProcedureKind = "query" | "mutation" | "subscription";

export interface ProcedureMeta {
  kind?: ProcedureKind;
}

/** Every contract procedure starts here, so every one carries the error map. */
export const base = oc.$meta<ProcedureMeta>({}).errors(COMMON_ERRORS);

export const query = base.meta({ kind: "query" });
export const mutation = base.meta({ kind: "mutation" });
export const subscription = base.meta({ kind: "subscription" });
