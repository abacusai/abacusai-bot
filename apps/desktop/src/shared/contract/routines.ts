import { type } from "@orpc/contract";
import * as v from "valibot";

import { mutation } from "./base";
import { RoutineId } from "./ids";

/**
 * Routine rows and their CRUD are the `db.routines` table; runs are
 * `db.routineRuns`. What stays a procedure is what is not a row write.
 */
export const routines = {
  /** Plain-words edit; long-running, resolves to the routine's reply. */
  editByChat: mutation
    .input(
      v.object({ routineId: RoutineId, text: v.pipe(v.string(), v.nonEmpty()) })
    )
    .output(type<{ reply: string }>()),
  /** `create` marks the run as the test run after setup. */
  run: mutation
    .input(
      v.object({
        id: RoutineId,
        trigger: v.optional(v.picklist(["manual", "create"])),
      })
    )
    .output(type<void>()),
};
