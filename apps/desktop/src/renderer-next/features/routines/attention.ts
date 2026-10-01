import { Store } from "@tanstack/react-store";
/** Pending connector asks, separate from the turn’s waiting-permission level. */
export const routineConnectorThreads = new Store<string[]>([]);
