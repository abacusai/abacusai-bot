import type { WindowChromeMode } from "./window-chrome-options";

// Switch only when loading the new renderer entry, together with its geometry
// consumers. See docs/rewrite/specs/00-window-chrome.md §7 and §11.
export const RENDERER_GENERATION: WindowChromeMode = "legacy";
