import { type } from "@orpc/contract";
import * as v from "valibot";

import { mutation, query } from "./base";
import { NoInput } from "./ids";

/**
 * "Use from the web": this desktop serving the AbacusAI Bot web app's coding
 * view (sessions, terminals, files) for its own signed-in account.
 */
export interface WebRunnerState {
  enabled: boolean;
  status: "off" | "signed-out" | "connecting" | "connected" | "unavailable";
  /** Coding views attached right now. */
  views: number;
}

export const webRunner = {
  state: query.input(NoInput).output(type<WebRunnerState>()),
  /** Changes arrive on `system.events` as `web-runner`. */
  setEnabled: mutation
    .input(v.object({ enabled: v.boolean() }))
    .output(type<WebRunnerState>()),
};
