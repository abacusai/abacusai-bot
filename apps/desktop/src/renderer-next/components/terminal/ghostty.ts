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

/** Ghostty accepts hex/rgb; CSS tokens are oklch, resolved by the browser. */
export const terminalTheme = (): { background: string; foreground: string } => {
  const css = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const dark = document.documentElement.classList.contains("dark");
  const read = (key: string, fallback: string) => {
    if (!ctx) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = fallback;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = css.getPropertyValue(key).trim() || fallback;
    ctx.fillRect(0, 0, 1, 1);
    return (
      "#" +
      [...ctx.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
    );
  };
  return {
    background: read("--background", dark ? "#0a0a0a" : "#ffffff"),
    foreground: read("--foreground", dark ? "#fafafa" : "#0a0a0a"),
  };
};
