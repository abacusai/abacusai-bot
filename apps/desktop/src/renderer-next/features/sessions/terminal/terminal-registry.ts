import {
  ghosttyReady,
  Terminal,
  FitAddon,
} from "#next/components/terminal/ghostty";
export interface TerminalView {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  offset: number | undefined;
  generation: number | null;
  received: number;
  reconnect?: () => void;
}
const views = new Map<string, Promise<TerminalView>>();
export const getTerminalView = (key: string): Promise<TerminalView> => {
  let view = views.get(key);
  if (!view) {
    view = (async () => {
      await ghosttyReady();
      await document.fonts?.ready;
      const element = document.createElement("div");
      element.style.cssText = "width:100%;height:100%";
      const term = new Terminal({
        fontSize: 13,
        fontFamily: '"JetBrains Mono Variable", monospace',
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 10000,
        convertEol: false,
        theme: {
          background: getComputedStyle(document.documentElement)
            .getPropertyValue("--background")
            .trim(),
          foreground: getComputedStyle(document.documentElement)
            .getPropertyValue("--foreground")
            .trim(),
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      return {
        term,
        fit,
        element,
        offset: undefined,
        generation: null,
        received: 0,
      };
    })();
    views.set(key, view);
  }
  return view;
};
export const disposeTerminalView = (key: string): void => {
  const view = views.get(key);
  views.delete(key);
  void view?.then((v) => {
    v.term.dispose();
    v.element.remove();
  });
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
