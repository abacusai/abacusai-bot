/**
 * Runs the page snapshot script against real layout: jsdom reports every rect
 * as zero, so Electron is the browser, one process per run with every fixture
 * in a batch. Files carry the payload both ways, since Electron writes noise
 * to stdout and a large write is not atomic through a pipe.
 */
// Default import, then destructure: Electron's own module is CommonJS, and
// under an ESM entry the named bindings come back undefined.
import electron from "electron";

const { app, BrowserWindow } = electron;
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The caller passes the input path and reads `<input>.out.json`. Without an
 * argument there is nothing to snapshot, so exit rather than write
 * `undefined.out.json` into the working directory.
 */
const INPUT_FILE = process.argv[2];

if (INPUT_FILE == null) {
  console.error(
    "usage: electron browser-snapshot-electron-entry.mjs <input.json>"
  );
  process.exit(2);
}

const outputPath = (inputFile) => `${inputFile}.out.json`;

/** Fixed, so a fixture can reason about what is on screen and what is below. */
const VIEWPORT = { width: 1024, height: 768 };

const write = (payload) => {
  try {
    fs.writeFileSync(outputPath(INPUT_FILE), JSON.stringify(payload));
  } catch {
    // Nothing useful left to do: the caller reports the missing file.
  }
};

const fail = (message) => {
  write({ error: message });
  app.exit(1);
};

app.whenReady().then(async () => {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));
  } catch (error) {
    fail(`could not read the input file: ${error.message}`);
    return;
  }

  const window = new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    webPreferences: {
      // The walker must be the only thing with any reach into a fixture.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Otherwise a hidden window is throttled and layout can settle late.
      backgroundThrottling: false,
    },
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-snapshot-"));
  const results = {};

  try {
    for (const [name, html] of Object.entries(input.fixtures)) {
      const file = path.join(dir, `${name.replace(/[^a-z0-9-]/gi, "_")}.html`);
      // A real file, not a data: URL: opaque-origin documents change what
      // stylesheets and CSS.escape do.
      fs.writeFileSync(file, html);

      await window.loadFile(file);
      // Load fires before layout has settled; two frames makes it final.
      await window.webContents.executeJavaScript(
        "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
      );

      try {
        results[name] = {
          ok: true,
          value: await window.webContents.executeJavaScript(input.script),
        };
      } catch (error) {
        results[name] = {
          ok: false,
          error: String(error && error.message ? error.message : error),
        };
      }
    }

    write({ results, viewport: VIEWPORT });
    app.exit(0);
  } catch (error) {
    fail(String(error && error.message ? error.message : error));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir; leave it */
    }
  }
});

// A window closing must not end the run before the results are written.
app.on("window-all-closed", () => {});
