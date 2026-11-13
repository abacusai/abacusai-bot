import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  MemoryChangeView,
  MemoryProjectView,
  MemoryWithheldView,
} from "../contracts";
import { mutation, query, subscription } from "./base";
import { NoInput, SessionId } from "./ids";
import type { MemoryRow } from "./rows";

/** Something in the memory folder changed: re-read what is not a row. */
export type MemoryEvent = { type: "changed" };

const ProjectSlug = v.pipe(v.string(), v.nonEmpty());

/** Where a note goes: about you, or one project by its slug. */
const MemoryScopeSchema = v.variant("scope", [
  v.object({ scope: v.literal("you") }),
  v.object({ scope: v.literal("project"), project: ProjectSlug }),
]);

export const MemoryNoteTypeSchema = v.picklist([
  "profile",
  "rule",
  "preference",
  "fact",
  "decision",
  "reference",
  "status",
  "card",
]);

export const MemorySaveInputSchema = v.intersect([
  MemoryScopeSchema,
  v.object({
    /** An existing note's name updates it; absent or new creates one. */
    name: v.optional(v.pipe(v.string(), v.nonEmpty())),
    type: MemoryNoteTypeSchema,
    text: v.string(),
    description: v.optional(v.string()),
    /** YYYY-MM-DD; status notes only. */
    expires: v.optional(v.string()),
  }),
]);

/**
 * Notes are the `db.memories` table (one row per note; delete by id). The
 * page's writes and what rows cannot hold are here. A refused save is
 * BAD_REQUEST carrying the one-line reason.
 */
export const memory = {
  customInstructions: {
    /** The user's standing instructions, never the agent's words. */
    get: query.input(NoInput).output(type<string>()),
    /** Returns what is now stored. */
    set: mutation.input(v.object({ text: v.string() })).output(type<string>()),
  },
  projects: query.input(NoInput).output(type<MemoryProjectView[]>()),
  /** The project a chat works in: its own folder or bot, or the one it opened. */
  chatProject: query
    .input(v.object({ sessionId: SessionId }))
    .output(type<MemoryProjectView | null>()),
  save: mutation.input(MemorySaveInputSchema).output(type<MemoryRow>()),
  /** Every note of the scope; a project's card is reset, not deleted. */
  clear: mutation.input(MemoryScopeSchema).output(type<null>()),
  /** The last changes, newest first. */
  history: query.input(NoInput).output(type<MemoryChangeView[]>()),
  /** Restores the file as it was before; CONFLICT when it changed since. */
  undo: mutation
    .input(v.object({ id: v.pipe(v.string(), v.nonEmpty()) }))
    .output(type<null>()),
  /** Old entries the move into the memory folder left behind as likely secrets. */
  withheld: query.input(NoInput).output(type<MemoryWithheldView[]>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<MemoryEvent>())),
};
