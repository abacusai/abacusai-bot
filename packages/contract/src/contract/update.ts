import { eventIterator, type } from "@orpc/contract";

import type { UpdateStatus } from "../update";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

export const update = {
  /** `{ success: false, error }` from the updater becomes an error. */
  check: mutation.input(NoInput).output(type<void>()),
  install: mutation.input(NoInput).output(type<void>()),
  status: query.input(NoInput).output(type<UpdateStatus>()),
  /** The first yield is the current status. */
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<UpdateStatus>())),
};
