/**
 * A chat app's login window shown before its page has drawn anything. The
 * site boots blank (white, then dark) for as long as it takes, twenty seconds
 * for Discord, and a blank window reads as a broken one. While a revealed
 * window's page shows neither its login nor the signed-in app, the app's own
 * cover sits over it: a spinner and the same Cancel pill. The connector's
 * login poll lifts it the moment the page has either, and it never stays
 * longer than COVER_MAX_MS, so a page this does not recognise is never hidden
 * for good. Only a login reveal is covered; a page the connector presents for
 * other reasons (an authorize page, a bot's chat) is shown as it is.
 */
import { type BrowserWindow, WebContentsView } from "electron";

import {
  exitsOn,
  injectCancelPill,
  presentAsDialog,
} from "../../bring-to-front";

/** The longest a page stays under the cover, whatever it shows. */
export const COVER_MAX_MS = 45_000;

/** What a connector's login poll read off its page. */
export interface LoginPageRead {
  loggedIn: boolean;
  loginVisible?: boolean;
}

const COVER_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
:root { color-scheme: light dark; }
html, body { margin: 0; height: 100%; background: Canvas; }
body { display: flex; align-items: center; justify-content: center; }
.spin { width: 28px; height: 28px; border-radius: 50%;
  border: 3px solid color-mix(in srgb, CanvasText 18%, transparent);
  border-top-color: color-mix(in srgb, CanvasText 70%, transparent);
  animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
</style></head><body><div class="spin" role="progressbar" aria-busy="true"></div></body></html>`;

/** Whether each window's page has shown a login or the app since it last started loading. */
const drawn = new WeakMap<BrowserWindow, boolean>();
const covers = new WeakMap<BrowserWindow, WebContentsView>();
const watched = new WeakSet<BrowserWindow>();
const deadlines = new WeakMap<BrowserWindow, ReturnType<typeof setTimeout>>();

const fit = (win: BrowserWindow, view: WebContentsView): void => {
  const { width, height } = win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });
};

const uncover = (win: BrowserWindow): void => {
  const timer = deadlines.get(win);
  if (timer != null) clearTimeout(timer);
  deadlines.delete(win);
  const view = covers.get(win);
  if (view == null) return;
  covers.delete(win);
  if (!win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
};

const cover = (win: BrowserWindow): void => {
  if (covers.has(win)) return;
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
    },
  });
  // Esc and Cancel on the cover leave the same way they do on the page.
  exitsOn(view.webContents, win);
  view.webContents.on("did-finish-load", () =>
    injectCancelPill(view.webContents)
  );
  void view.webContents
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(COVER_HTML)}`)
    .catch(() => {});
  win.contentView.addChildView(view);
  fit(win, view);
  covers.set(win, view);
  const timer = setTimeout(() => uncover(win), COVER_MAX_MS);
  timer.unref?.();
  deadlines.set(win, timer);
};

const watch = (win: BrowserWindow): void => {
  if (watched.has(win)) return;
  watched.add(win);
  // A new document starts blank, whatever the last one showed.
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) drawn.set(win, false);
  });
  win.on("resize", () => {
    const view = covers.get(win);
    if (view != null) fit(win, view);
  });
  // Put away: the next reveal judges the page afresh.
  win.on("hide", () => uncover(win));
  win.on("closed", () => uncover(win));
};

/**
 * Show a login window over the app (presentAsDialog), covered while its page
 * has not yet shown a login or the signed-in app.
 */
export const presentLogin = (win: BrowserWindow): void => {
  watch(win);
  if (drawn.get(win) !== true) cover(win);
  presentAsDialog(win);
};

/**
 * One login poll's reading of `win`'s page. A login or the signed-in app on
 * it lifts the cover; anything else only records that the page is not there
 * yet, and never covers a window already shown.
 */
export const loginPageRead = (
  win: BrowserWindow | null,
  read: LoginPageRead | null
): void => {
  if (win == null || win.isDestroyed() || read == null) return;
  const ready = read.loggedIn || read.loginVisible === true;
  drawn.set(win, ready);
  if (ready) uncover(win);
};
