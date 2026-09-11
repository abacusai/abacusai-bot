/**
 * Bringing the app window back after something took the user away from it.
 * Lives outside index.ts so services can call it without importing the entry
 * module. The window is shared only so a connector's login window can name it
 * as `parent`: on macOS a full-screen app is a Space of its own, and a
 * top-level login window would strand the user in a second, empty Space.
 */
import type { BaseWindow, BrowserWindow } from "electron";

let reveal: (() => void) | null = null;
let main: BaseWindow | null = null;

/** Installed by index.ts once the main window exists; cleared when it goes. */
export const setBringToFront = (fn: (() => void) | null): void => {
  reveal = fn;
};

/** Show and focus the main window; a no-op when it is already in front. */
export const bringToFront = (): void => {
  reveal?.();
};

/** Installed by index.ts alongside the reveal; cleared when the window goes. */
export const setMainWindow = (win: BaseWindow | null): void => {
  main = win;
};

/** The live main window for a connector window to hang off, if any. */
export const parentWindow = (): BaseWindow | undefined =>
  main != null && !main.isDestroyed() ? main : undefined;

/**
 * Show a connector's login window over the app as a child of the main window,
 * fitted and centred. Adoption happens at reveal, not construction: connectors
 * boot before the main window exists, and on macOS a hidden window only
 * records its parent; the show is what attaches it.
 *
 * A full-screen app leaves full screen first on macOS. AppKit refuses to
 * attach a child across Spaces, and visibleOnFullScreen turns the whole app
 * into a UIElement (no Dock icon, no menu bar). Full screen is deliberately
 * not restored: a login is a context switch the user asked for.
 */
export const presentAsDialog = (win: BaseWindow): void => {
  const parent = parentWindow();
  if (
    process.platform === "darwin" &&
    parent != null &&
    parent.isFullScreen()
  ) {
    // Adopting or showing mid-transition is where AppKit falls over.
    parent.once("leave-full-screen", () => {
      if (!parent.isDestroyed()) revealDialog(win, parent);
    });
    parent.setFullScreen(false);
    return;
  }
  revealDialog(win, parent);
};

const revealDialog = (
  win: BaseWindow,
  parent: BaseWindow | undefined
): void => {
  if (parent != null) {
    // Unconditional: re-adopting an attached window is a no-op in Electron.
    win.setParentWindow(parent);
    const home = parent.getBounds();
    const own = win.getBounds();
    const width = Math.min(own.width, Math.max(320, home.width - 40));
    const height = Math.min(own.height, Math.max(240, home.height - 40));
    win.setBounds({
      width,
      height,
      x: Math.round(home.x + (home.width - width) / 2),
      y: Math.round(home.y + (home.height - height) / 2),
    });
  }
  if (!win.isVisible()) win.show();
  win.focus();
};

/**
 * Logged by the injected Cancel pill: a console message is the one channel a
 * sandboxed third-party page can reach the main process through.
 */
const CANCEL_MESSAGE = "abacus:cancel-connector-login";

/**
 * "Cancel (esc)" pill pinned to the login window's bottom edge: the frameless
 * window has no other visible exit. Only the pill takes pointer events, so the
 * driver's clicks at page coordinates are never intercepted. Idempotent.
 */
const HINT_JS = `(() => {
  if (document.getElementById('abacus-dismiss-hint')) return;
  const pill = document.createElement('button');
  pill.id = 'abacus-dismiss-hint';
  pill.type = 'button';
  pill.textContent = 'Cancel (esc)';
  pill.style.cssText = [
    'position:fixed', 'bottom:18px', 'left:50%',
    'transform:translateX(-50%)', 'z-index:2147483647',
    'padding:8px 18px', 'border:none', 'border-radius:999px',
    'background:rgba(20,20,20,0.82)', 'color:#fff',
    'font:500 13px system-ui,sans-serif', 'cursor:pointer',
    'box-shadow:0 2px 12px rgba(0,0,0,0.35)',
  ].join(';');
  pill.addEventListener('click', () => console.log('${CANCEL_MESSAGE}'));
  document.body.appendChild(pill);
})();`;

/** The hidden window is the driver's, not the user's. */
const REMOVE_HINT_JS = `(() => {
  const pill = document.getElementById('abacus-dismiss-hint');
  if (pill) pill.remove();
})();`;

/**
 * Let the user out of a frameless login window via Esc, Cmd/Ctrl+W or the
 * injected Cancel pill. Dismissing hides rather than closes, so the page keeps
 * its driver alive, and raises the app: hiding hands focus to whatever the OS
 * pleases. Blur is deliberately not an exit; a user may switch away mid-auth
 * to fetch a password.
 */
export const dismissOnEscape = (win: BrowserWindow): void => {
  const dismiss = (): void => {
    if (!win.isVisible()) return;
    win.hide();
    bringToFront();
  };

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const closeChord =
      input.key.toLowerCase() === "w" && (input.meta || input.control);
    if (input.key !== "Escape" && !closeChord) return;
    if (!win.isVisible()) return;
    event.preventDefault();
    dismiss();
  });

  // Pill in on reveal and on navigation while shown, out on dismiss.
  const inject = (): void => {
    if (!win.isVisible()) return;
    void win.webContents.executeJavaScript(HINT_JS, true).catch(() => {});
  };
  win.on("show", inject);
  win.webContents.on("did-finish-load", inject);
  win.on("hide", () => {
    void win.webContents
      .executeJavaScript(REMOVE_HINT_JS, true)
      .catch(() => {});
  });

  win.webContents.on("console-message", (event) => {
    if (event.message === CANCEL_MESSAGE) dismiss();
  });
};
