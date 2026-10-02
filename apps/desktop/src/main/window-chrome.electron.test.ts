import { describe, it } from "vitest";

// Deferred by the orchestrator until renderer cut-over. Use the existing
// Node-spawns-Electron harness and register in CONTENDS_FOR_THE_MACHINE.
describe("window chrome Electron integration TODO: BaseWindow + RendererHost", () => {
  it.todo(
    "initial WCO API rect matches env() and clears native buttons on macOS, Windows and overlay Linux"
  );
  it.todo(
    "resize, maximize and fullscreen update geometry without changing the density toolbar height"
  );
  it.todo(
    "RendererHost.swap forwards geometry before and after the new view is revealed"
  );
  it.todo(
    "popover/dialog and backdrops over the toolbar and _bare routes accept clicks and dismiss"
  );
  it.todo(
    "browser view corners receive input after sidebar movement at zoom 1.25"
  );
  it.todo(
    "Linux native-frame controls work and missing/full-width geometry recreates with preserved bounds, route and state"
  );
  it.todo(
    "failed Linux probe persists native-frame and skips overlay on the next start"
  );
});
