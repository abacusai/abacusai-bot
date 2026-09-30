import { type } from "@orpc/contract";
import * as v from "valibot";

import { mutation, query } from "./base";
import { NoInput } from "./ids";

/**
 * The legacy renderer's durable state (`renderer-state.json`), for the old
 * renderer only: the new one keeps its preferences in `db.prefs`. The
 * synchronous `sendSync` snapshot stays in the legacy preload.
 */
export const durableState = {
  snapshot: query.input(NoInput).output(type<Record<string, string>>()),
  /** A null value removes the key. */
  set: mutation
    .input(v.object({ key: v.string(), value: v.nullable(v.string()) }))
    .output(type<void>()),
  clear: mutation.input(NoInput).output(type<void>()),
};
