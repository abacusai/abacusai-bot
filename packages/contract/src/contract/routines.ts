import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  HostedRoutineRun,
  RoutineRunner,
  RoutineTrigger,
} from "../routines";
import { mutation, query, subscription } from "./base";
import { NoInput, RoutineId } from "./ids";

/**
 * A routine fired and its session started (spec 05 §31.5 j): the
 * `routine-fired` cue's source. A notice, not a row diff: there is no
 * snapshot, so a (re)subscription plays nothing old; consumers dedupe by
 * `attemptId`.
 */
export type RoutinesEvent =
  | {
      type: "run-started";
      routineId: string;
      attemptId: string;
      trigger: RoutineTrigger;
      startedAt: number;
    }
  /**
   * A hosted routine's run finished on the server (its result already went
   * out). Consumers dedupe by `run.id`.
   */
  | { type: "hosted-run"; run: HostedRoutineRun }
  /**
   * Hosted runs that finished while the app was closed for over a day: told
   * as one summary, not one notice each.
   */
  | { type: "hosted-away"; runs: HostedRoutineRun[] }
  /**
   * The agent set up a routine; the user hears of every one. It may wait for
   * their approval first (`pendingApproval`).
   */
  | {
      type: "created";
      routineId: string;
      name: string;
      pendingApproval: boolean;
    };

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
  /** A hosted routine's recent runs, newest first, from the server. */
  hostedRuns: query
    .input(v.object({ id: RoutineId }))
    .output(type<HostedRoutineRun[]>()),
  /**
   * Which runners a new routine can have here: `hosted` when the server keeps
   * routines, and the one a routine that names none gets.
   */
  runners: query
    .input(NoInput)
    .output(type<{ hosted: boolean; default: RoutineRunner }>()),
  /**
   * Re-read the account's hosted routines into the table; `hosted` says
   * whether the server runs them right now.
   */
  refreshHosted: mutation.input(NoInput).output(type<{ hosted: boolean }>()),
  /**
   * Ask the server to send the owner a fresh approval link (on WhatsApp, or
   * by email) for a hosted routine waiting on them; `sent` is false when it
   * waits on nothing.
   */
  approvalLink: mutation
    .input(v.object({ id: RoutineId }))
    .output(type<{ sent: boolean }>()),
  /** Lossless-actionable, no snapshot. */
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<RoutinesEvent>())),
};
