import { init, Terminal, FitAddon, type GhosttyCell } from "ghostty-web";
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
export const terminalTheme = (): {
  background: string;
  foreground: string;
  cursor: string;
} => {
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
  const foreground = read("--foreground", dark ? "#fafafa" : "#0a0a0a");
  return {
    background: read("--background", dark ? "#0a0a0a" : "#ffffff"),
    foreground,
    cursor: foreground,
  };
};

/** Bound the WASM copy and preserve UTF-8 across writes, including retained tails. */
export const writeTerminalData = async (
  terminal: Pick<Terminal, "write">,
  data: string,
  signal?: AbortSignal
): Promise<void> => {
  if (!data) return;
  const bytes = new TextEncoder().encode(data);
  if (bytes.length <= 4096) {
    terminal.write(data);
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    signal?.throwIfAborted();
    terminal.write(bytes.subarray(offset, offset + 4096));
    if (offset % 32768 === 28672)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

/** 0.4 resolves defaults into cell RGB; adapt those cells without replacing the PTY view. */
export const installTerminalTheme = (terminal: Terminal): (() => void) => {
  const renderer = terminal.renderer as unknown as {
    renderLine(cells: GhosttyCell[], y: number, cols: number): void;
    setTheme(theme: { background: string; foreground: string }): void;
  };
  if (typeof renderer?.renderLine !== "function")
    throw new Error("ghostty-web 0.4.0 theme adapter shape changed");
  const original = terminalTheme();
  let current = original;
  const rgb = (hex: string) =>
    [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const background = rgb(original.background);
  const foreground = rgb(original.foreground);
  const renderLine = renderer.renderLine.bind(renderer);
  renderer.renderLine = (cells, y, cols) => {
    const bg = rgb(current.background),
      fg = rgb(current.foreground);
    renderLine(
      cells.map((cell) => ({
        ...cell,
        ...(cell.bg_r === background[0] &&
        cell.bg_g === background[1] &&
        cell.bg_b === background[2]
          ? { bg_r: bg[0]!, bg_g: bg[1]!, bg_b: bg[2]! }
          : {}),
        ...(cell.fg_r === foreground[0] &&
        cell.fg_g === foreground[1] &&
        cell.fg_b === foreground[2]
          ? { fg_r: fg[0]!, fg_g: fg[1]!, fg_b: fg[2]! }
          : {}),
      })),
      y,
      cols
    );
  };
  const observer = new MutationObserver(() => {
    current = terminalTheme();
    terminal.options.theme = current;
    renderer.setTheme(current);
    repaint(terminal);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
  return () => observer.disconnect();
};
