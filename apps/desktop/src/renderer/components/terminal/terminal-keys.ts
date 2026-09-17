/**
 * The font the grid is measured from, and the keys a terminal is expected to
 * answer. Apart from the panel because the terminal itself lives in
 * terminal-views.ts now; the panel only puts it on screen.
 */
import { Terminal as GhosttyTerminal } from "ghostty-web";

import { isMacOS } from "../../lib/window-chrome";

/**
 * The terminal paints on a canvas, so it measures one cell at startup and
 * assumes every glyph matches. Measuring before the webfont has loaded gives
 * the fallback's metrics and a grid that no longer lines up once the real font
 * arrives, so the font is awaited rather than raced.
 */
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Keys that produce no input, so pressing one must not jump to the prompt. */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
]);

/**
 * The shortcuts a terminal is expected to have. Copy and paste need spelling
 * out because the grid is painted rather than laid out: the browser has no
 * DOM selection to copy, and Ctrl+C has to stay SIGINT on Windows and Linux,
 * which is why the copy there is Ctrl+Shift+C.
 *
 * Returning true means the terminal must not also treat the key as input.
 */
export const installShortcuts = (term: GhosttyTerminal): void => {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return false;

    // Scrolling the history, from the keyboard, the way every terminal does.
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === "PageUp") {
        term.scrollPages(-1);
        return true;
      }
      if (event.key === "PageDown") {
        term.scrollPages(1);
        return true;
      }
    }

    const copyChord = isMacOS
      ? event.metaKey && !event.shiftKey && event.key.toLowerCase() === "c"
      : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c";
    if (copyChord) {
      // With nothing selected, macOS Cmd+C is a no-op and Ctrl+C must reach
      // the shell, so the key is handed back rather than swallowed.
      if (!term.hasSelection()) return false;
      void navigator.clipboard?.writeText(term.getSelection());
      return true;
    }

    const pasteChord = isMacOS
      ? event.metaKey && !event.shiftKey && event.key.toLowerCase() === "v"
      : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "v";
    if (pasteChord) {
      // `paste` brackets the text where the shell asked for it, so a pasted
      // newline does not run the command by itself.
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text.length > 0) term.paste(text);
        })
        .catch(() => {
          // Denied or empty: the browser's own paste event still works.
        });
      return true;
    }

    // Anything that will produce input belongs at the prompt: typing while
    // scrolled up used to echo somewhere off-screen. The modifiers are listed
    // so a bare Shift does not count as typing.
    if (!MODIFIER_KEYS.has(event.key)) term.scrollToBottom();

    return false;
  });
};
