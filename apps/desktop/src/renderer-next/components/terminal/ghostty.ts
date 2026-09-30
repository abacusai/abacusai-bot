import { init, Terminal, FitAddon } from "ghostty-web";
let ready: Promise<void> | null = null;
export const ghosttyReady = (): Promise<void> => (ready ??= init());
export { Terminal, FitAddon };
/** Adapter for the installed 0.4.0; same-size resize deliberately does not paint. */
export const repaint = (terminal: Terminal): void => {
  const internals = terminal as unknown as {
    wasmTerm: Parameters<NonNullable<Terminal["renderer"]>["render"]>[0];
    getViewportY(): number;
  };
  if (
    !terminal.renderer ||
    !internals.wasmTerm ||
    typeof internals.getViewportY !== "function"
  ) {
    if (import.meta.env.DEV)
      throw new Error("ghostty-web 0.4.0 repaint shape changed");
    return;
  }
  terminal.renderer.render(
    internals.wasmTerm,
    true,
    internals.getViewportY(),
    terminal
  );
};
