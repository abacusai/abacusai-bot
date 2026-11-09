import { eventIterator, type } from "@orpc/contract";

import type { StatusItem } from "../status";
import { query, subscription } from "./base";
import { NoInput } from "./ids";

/** Something on the board changed: read `status.list` again. */
export type StatusEvent = { type: "updated" };

/** What is not running and why (the status board); one stream for every surface. */
export const status = {
  list: query.input(NoInput).output(type<StatusItem[]>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<StatusEvent>())),
};
