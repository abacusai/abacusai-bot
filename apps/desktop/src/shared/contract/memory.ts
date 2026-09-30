import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { BotMemoryView, MemorySnapshot } from "../contracts";
import { mutation, query, subscription } from "./base";
import { BotId, NoInput } from "./ids";

export const MemoryTargetIdSchema = v.picklist(["memory", "user", "remember"]);

/** A memory file changed: re-read `memory.bots`. Rows ride `db.memories`. */
export type MemoryEvent = { type: "changed" };

/**
 * Entries are the `db.memories` table (one row per entry, deletes validated
 * against the clicked row). What rows cannot hold stays here.
 */
export const memory = {
  customInstructions: {
    /** The user's standing instructions, never the agent's words. */
    get: query.input(NoInput).output(type<string>()),
    /** Returns what is now stored. */
    set: mutation.input(v.object({ text: v.string() })).output(type<string>()),
  },
  forgetAll: mutation
    .input(v.object({ target: MemoryTargetIdSchema }))
    .output(type<MemorySnapshot>()),
  /** `noteDays` and bots with no entries, which entry rows cannot show. */
  bots: query.input(NoInput).output(type<BotMemoryView[]>()),
  clearBot: mutation
    .input(v.object({ botId: BotId }))
    .output(type<BotMemoryView[]>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<MemoryEvent>())),
};
