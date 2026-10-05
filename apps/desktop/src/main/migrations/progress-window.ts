/**
 * The migration progress window (spec 00 C.1). Opened only if the runner
 * has not finished within 400 ms, so a fast upgrade never flashes one.
 * Progress is pushed at most 10 times a second, and the window closes when
 * the runner resolves, before the main window is created. It loads a
 * self-contained `data:` page, is not a registered renderer and never gets an
 * RPC port.
 */
import { BrowserWindow } from "electron";

export interface ProgressSurface {
  update(done: number, total: number, label: string): void;
  /** Takes it off screen. */
  close(): void;
  /** Frees it; only once another window exists (see `dispose`). */
  dispose(): void;
}

export interface MigrationProgressOptions {
  /** Creates the window; only called once the delay has passed. */
  open: () => ProgressSurface;
  /** 400 ms. */
  delayMs?: number;
  /** 100 ms (10 updates a second). */
  throttleMs?: number;
}

export interface MigrationProgress {
  report(done: number, total: number, label: string): void;
  /** Closes the window if it opened; later reports are ignored. */
  finish(): void;
  /**
   * Destroys the closed window. Called after the main window exists: with
   * no other window, destroying it would fire `window-all-closed`, which
   * quits the app on Windows and Linux.
   */
  dispose(): void;
}

export const createMigrationProgress = (
  options: MigrationProgressOptions
): MigrationProgress => {
  const throttleMs = options.throttleMs ?? 100;
  let surface: ProgressSurface | null = null;
  let finished = false;
  let latest: [number, number, string] | null = null;
  let lastPush = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | undefined;

  const push = () => {
    trailing = undefined;
    if (surface == null || latest == null) return;
    lastPush = Date.now();
    try {
      surface.update(...latest);
    } catch (error) {
      console.error("[migrations] progress update failed", error);
    }
  };

  const opener = setTimeout(() => {
    if (finished) return;
    try {
      surface = options.open();
    } catch (error) {
      console.error("[migrations] progress window failed to open", error);
      return;
    }
    push();
  }, options.delayMs ?? 400);

  return {
    report(done, total, label) {
      if (finished) return;
      latest = [done, total, label];
      if (surface == null || trailing !== undefined) return;
      const wait = lastPush + throttleMs - Date.now();
      if (wait <= 0) push();
      else trailing = setTimeout(push, wait);
    },
    finish() {
      if (finished) return;
      finished = true;
      clearTimeout(opener);
      if (trailing !== undefined) clearTimeout(trailing);
      try {
        surface?.close();
      } catch (error) {
        console.error("[migrations] progress window failed to close", error);
      }
    },
    dispose() {
      this.finish();
      try {
        surface?.dispose();
      } catch (error) {
        console.error("[migrations] progress window failed to dispose", error);
      }
      surface = null;
    },
  };
};

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char
  );

/** The page: app name, step label, a determinate bar. No external resources. */
export const progressPage = (options: {
  appName: string;
  dark: boolean;
}): string => {
  const fg = options.dark ? "#fafafa" : "#171717";
  const muted = options.dark ? "#a3a3a3" : "#737373";
  const track = options.dark ? "#262626" : "#e5e5e5";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(options.appName)}</title>
<style>
html,body{margin:0;height:100%;background:transparent;color:${fg};font:13px system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}
main{box-sizing:border-box;height:100%;padding:24px 28px;display:flex;flex-direction:column;justify-content:center;gap:10px}
h1{margin:0;font-size:14px;font-weight:600}
p{margin:0;color:${muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track{height:4px;border-radius:2px;background:${track};overflow:hidden}
.bar{height:100%;width:0;background:${fg};transition:width .1s linear}
</style></head><body><main>
<h1>${escapeHtml(options.appName)}</h1>
<p id="label">Updating your data…</p>
<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" id="track"><div class="bar" id="bar"></div></div>
</main><script>
window.setProgress=function(done,total,label){
var pct=total>0?Math.max(0,Math.min(100,Math.round(done/total*100))):0;
document.getElementById("bar").style.width=pct+"%";
document.getElementById("track").setAttribute("aria-valuenow",String(pct));
if(label)document.getElementById("label").textContent=label;
};
</script></body></html>`;
};

/** The real window. */
export const openProgressWindow = (options: {
  appName: string;
  dark: boolean;
  backgroundColor: string;
}): ProgressSurface => {
  const window = new BrowserWindow({
    width: 420,
    height: 140,
    frame: false,
    resizable: false,
    // Closing it would quit the app mid-migration on Windows and Linux
    // (`window-all-closed`): it cannot be closed, minimised or maximised,
    // and stays off the taskbar. `dispose` destroys it.
    closable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: options.backgroundColor,
    title: options.appName,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let ready = false;
  let closed = false;
  let pending: [number, number, string] | null = null;
  // Alt+F4 and the like still ask; only `dispose` ends it.
  window.on("close", (event) => {
    event.preventDefault();
  });
  const send = ([done, total, label]: [number, number, string]) => {
    if (window.isDestroyed()) return;
    void window.webContents
      .executeJavaScript(
        `window.setProgress(${done},${total},${JSON.stringify(label)})`
      )
      .catch(() => undefined);
  };
  window.once("ready-to-show", () => {
    if (closed || window.isDestroyed()) return;
    ready = true;
    window.show();
    if (pending != null) send(pending);
  });
  void window
    .loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(progressPage(options))}`
    )
    .catch(() => undefined);
  return {
    update(done, total, label) {
      pending = [done, total, label];
      if (ready) send(pending);
    },
    close() {
      closed = true;
      ready = false;
      if (!window.isDestroyed()) window.hide();
    },
    dispose() {
      if (!window.isDestroyed()) window.destroy();
    },
  };
};
