import { app } from "electron";

import type { WindowChromeMode } from "./window-chrome-options";

// Switch only when loading the new renderer entry, together with its geometry
// consumers. See docs/rewrite/specs/00-window-chrome.md §7 and §11.
export const DEFAULT_RENDERER_GENERATION: WindowChromeMode = "wco";

/**
 * The generation this process runs (spec 01 §3.6): the default above, or
 * `legacy` or `wco` when `ABACUSBOT_RENDERER_GENERATION=legacy` is set in an unpackaged app
 * (development and screenshot runs). Packaged builds ignore the variable.
 */
export const resolveRendererGeneration = (
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  fallback: WindowChromeMode = DEFAULT_RENDERER_GENERATION
): WindowChromeMode => {
  if (!isPackaged) {
    if (env.ABACUSBOT_RENDERER_GENERATION === "legacy") return "legacy";
    if (env.ABACUSBOT_RENDERER_GENERATION === "wco") return "wco";
  }
  return fallback;
};

export const RENDERER_GENERATION: WindowChromeMode = resolveRendererGeneration(
  process.env,
  app.isPackaged
);
