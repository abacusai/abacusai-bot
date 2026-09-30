import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

export interface WindowState {
  fullScreen: boolean;
  focused: boolean;
  maximized: boolean;
}

export type WindowEvent = { type: "state"; state: WindowState };

/**
 * The caller's own window, found through the port it called on. Over a
 * transport with no window (the WebSocket adapter) these answer `FORBIDDEN`.
 */
export const window = {
  showAbout: mutation.input(NoInput).output(type<void>()),
  state: query.input(NoInput).output(type<WindowState>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<WindowEvent>())),
  /** User-input beacon, fire-and-forget; a renderer swap defers while it is recent. */
  activity: mutation.input(NoInput).output(type<void>()),
  /**
   * The swap readiness barrier (spec 00 A.4.6): `subscriptions` once the
   * transport, the shell's tables and the visible thread are live and the
   * first commit happened; `failed` when one of them could not be.
   */
  ready: mutation
    .input(
      v.variant("barrier", [
        v.object({ barrier: v.literal("subscriptions") }),
        v.object({ barrier: v.literal("failed"), reason: v.string() }),
      ])
    )
    .output(type<void>()),
};
