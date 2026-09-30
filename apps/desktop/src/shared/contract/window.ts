import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { WindowChromeState } from "../window-chrome-state";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

export type { WindowChromeState };

export interface WindowState {
  fullScreen: boolean;
  focused: boolean;
  maximized: boolean;
}

export type TitlebarDensity = "comfortable" | "compact";

export interface SetDensityResult {
  density: TitlebarDensity;
  /** The legacy generation reads the density only at the next launch. */
  appliesOnRestart: boolean;
}

export type WindowEvent =
  | { type: "state"; state: WindowState }
  /** The native chrome changed: capability, full screen or density. */
  | { type: "chrome"; chrome: WindowChromeState };

/**
 * The caller's own window, found through the port it called on. Over a
 * transport with no window (the WebSocket adapter) these answer `FORBIDDEN`.
 */
export const window = {
  showAbout: mutation.input(NoInput).output(type<void>()),
  state: query.input(NoInput).output(type<WindowState>()),
  /**
   * The window chrome state main serves the legacy renderer on
   * `window:chrome` (spec 00-window-chrome; spec 01 §15.3).
   */
  chrome: query.input(NoInput).output(type<WindowChromeState>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<WindowEvent>())),
  /**
   * The title bar density (spec 05 §31.5 b): `settings:set-titlebar-density`
   * with its side effects (refresh the chrome, publish it, recreate the
   * window on macOS in the wco generation).
   */
  setDensity: mutation
    .input(v.object({ density: v.picklist(["comfortable", "compact"]) }))
    .output(type<SetDensityResult>()),
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
