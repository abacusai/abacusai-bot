import type { Terminal, FitAddon } from "#renderer/components/terminal/ghostty";
export interface TerminalView {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  offset: number | undefined;
  generation: number | null;
  /** The tab's `terminal.start` while it is on its way; `generation` once it settled. */
  starting?: Promise<unknown>;
  reconnect?: () => void;
  /** Set by the tab while mounted: fit cols/rows to the box and resize the PTY. */
  refit?: () => void;
  disposeTheme(): void;
  /** The colours the terminal paints with now. */
  theme(): Record<string, string>;
}
/** Clear: screen and scrollback go, and the shell redraws its prompt (Ctrl+L). */
export const clearTerminal = (term: Terminal): void => {
  const buffer = term.buffer.active;
  const line =
    buffer
      .getLine(buffer.length - term.rows + buffer.cursorY)
      ?.translateToString(true) ?? "";
  // Command Prompt has no Ctrl+L: at its prompt, its own cls, after Esc
  // drops anything typed (sent apart, or ConPTY reads Esc+c as Alt+C).
  const cmd =
    document.documentElement.dataset.platform === "win32" &&
    /^[A-Za-z]:\\[^>]*>/.test(line);
  term.clear();
  term.write("\x1b[3J");
  if (!cmd) return term.input("\x0c", true);
  if (line.endsWith(">") && buffer.cursorX === line.length)
    return term.input("cls\r", true);
  term.input("\x1b", true);
  setTimeout(() => term.input("cls\r", true), 150);
};
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
        fixSelectionText,
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
      fixSelectionText(term);
      self = {
        term,
        fit,
        element,
        offset: undefined,
        generation: null,
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
/** The view a tab already has, without making one (a hidden tab has none). */
export const peekTerminalView = (key: string): Promise<TerminalView> | null =>
  views.get(key) ?? null;
/**
 * Closes a tab's shell in main, whatever generation it reached: one still
 * starting is waited for, so closing a tab never leaves its shell behind.
 */
export const closeTerminalView = async (
  key: string,
  close: (generation: number) => Promise<unknown>,
  /** Main's generation for a shell this window never showed (an agent's). */
  running?: number
): Promise<void> => {
  const view = await views.get(key)?.catch(() => null);
  await view?.starting?.catch(() => {});
  const generation = view?.generation ?? running;
  if (generation != null) await close(generation);
  disposeTerminalView(key);
};
/**
 * A conversation left the screen: its terminals' screens go (main keeps each
 * shell and its scrollback, replayed when the tab is shown again). `keep`
 * spares a tab whose shell exited, the one place its last output lives.
 */
export const disposeConversationViews = (
  conversationKey: string,
  keep: (id: string) => boolean
): void => {
  const prefix = `${conversationKey}:`;
  for (const key of views.keys())
    if (key.startsWith(prefix) && !keep(key.slice(prefix.length)))
      disposeTerminalView(key);
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
