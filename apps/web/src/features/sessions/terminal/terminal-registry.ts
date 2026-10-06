import type { Terminal, FitAddon } from "#renderer/components/terminal/ghostty";
export interface TerminalView {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  offset: number | undefined;
  generation: number | null;
  received: number;
  reconnect?: () => void;
  /** Set by the tab while mounted: fit cols/rows to the box and resize the PTY. */
  refit?: () => void;
  disposeTheme(): void;
  /** The colours the terminal paints with now. */
  theme(): Record<string, string>;
}
const views = new Map<string, Promise<TerminalView>>();
export const getTerminalView = (key: string): Promise<TerminalView> => {
  let view = views.get(key);
  if (!view) {
    view = (async () => {
      const {
        ghosttyReady,
        Terminal,
        FitAddon,
        terminalTheme,
        terminalFont,
        installTerminalTheme,
      } = await import("#renderer/components/terminal/ghostty");
      const ghostty = await ghosttyReady();
      await document.fonts?.load('13px "Symbols Nerd Font Mono"');
      await document.fonts?.ready;
      const element = document.createElement("div");
      let self: TerminalView | undefined;
      element.style.cssText = "width:100%;height:100%";
      const term = new Terminal({
        ghostty,
        ...terminalFont(),
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 10000,
        convertEol: false,
        theme: terminalTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      const theme = installTerminalTheme(
        term,
        () => term.open(element),
        () => self?.refit?.()
      );
      self = {
        term,
        fit,
        element,
        offset: undefined,
        generation: null,
        received: 0,
        theme: theme.theme,
        disposeTheme: theme.dispose,
      };
      return self;
    })();
    view = view.catch((error) => {
      views.delete(key);
      throw error;
    });
    views.set(key, view);
  }
  return view;
};
export const disposeTerminalView = (key: string): void => {
  const view = views.get(key);
  views.delete(key);
  void view
    ?.then((v) => {
      v.disposeTheme();
      v.term.dispose();
      v.element.remove();
    })
    .catch(() => {});
};

if (import.meta.env.VITE_UI_GALLERY === "1") {
  (
    window as Window & { __sessionsTerminalTest?: unknown }
  ).__sessionsTerminalTest = {
    snapshot: async (key: string) => {
      const view = await views.get(key);
      if (!view) return null;
      const buffer = view.term.buffer.active;
      return {
        theme: view.theme(),
        offset: view.offset,
        received: view.received,
        generation: view.generation,
        lines: buffer.length,
        text: Array.from(
          { length: buffer.length },
          (_, i) => buffer.getLine(i)?.translateToString(true) ?? ""
        ).join("\n"),
      };
    },
    reconnect: async (key: string) => (await views.get(key))?.reconnect?.(),
  };
}
