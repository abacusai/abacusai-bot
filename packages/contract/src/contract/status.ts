import { eventIterator, type } from "@orpc/contract";

import type { ConnectivitySnapshot, StatusItem } from "../status";
import { query, subscription } from "./base";
import { NoInput } from "./ids";

/**
 * Something on the board changed: read `status.list` again. `connectivity`:
 * the network's state changed: read `status.connectivity` again.
 */
export type StatusEvent = { type: "updated" } | { type: "connectivity" };

/** What is not running and why (the status board); one stream for every surface. */
export const status = {
  list: query.input(NoInput).output(type<StatusItem[]>()),
  /** Whether this computer is online, and if not whose fault it is. */
  connectivity: query.input(NoInput).output(type<ConnectivitySnapshot>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<StatusEvent>())),
};
