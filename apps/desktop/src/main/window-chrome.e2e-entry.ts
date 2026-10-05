import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { app, BaseWindow, WebContentsView } from "electron";

import { RendererHost } from "./renderer-host";
import { windowChromeOptions } from "./window-chrome-options";
import { hasOverlayGeometry, probeWindowChrome } from "./window-chrome-probe";
import {
  persistLinuxNativeFrame,
  useLinuxNativeFrame,
} from "./window-chrome-settings";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", process.env.CHROME_E2E_HOME!);
app.whenReady().then(async () => {
  const window = new BaseWindow({
    width: 960,
    height: 600,
    show: true,
    ...windowChromeOptions({
      platform: process.platform,
      dark: false,
      reducedTransparency: true,
      overlayHeight: 40,
      linuxMode: "overlay",
    }),
  });
  const host = new RendererHost({
    window,
    backgroundColor: "#fff",
    // Native layout probes must also advance when the desktop occludes the window.
    webPreferences: { backgroundThrottling: false },
    wire: () => {},
    readiness: { wait: async () => "ready" },
  });
  const page = pathToFileURL(process.env.CHROME_E2E_PAGE!).href;
  const geometry = () =>
    host.webContents.executeJavaScript(`(() => {
    const o = navigator.windowControlsOverlay, r = o?.getTitlebarAreaRect(), s = getComputedStyle(document.querySelector('#bar'));
    return { visible: o?.visible ?? false, x: r?.x ?? 0, width: r?.width ?? 0, height: r?.height ?? 0, windowWidth: innerWidth, left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight), toolbar: parseFloat(s.height), events: window.geometryEvents };
  })()`);
  try {
    await host.webContents.loadURL(page);
    await sleep(250);
    const initial = await geometry();
    window.setSize(1040, 660);
    await sleep(250);
    const resized = await geometry();
    window.maximize();
    await sleep(250);
    const maximized = await geometry();
    window.unmaximize();
    await sleep(250);
    window.setFullScreen(true);
    await sleep(900);
    const fullscreen = await geometry();
    window.setFullScreen(false);
    await sleep(900);
    const restored = await geometry();
    const beforeSwap = await geometry();
    const swapped = await host.swap(new URL(page), {
      barrier: "subscriptions",
    });
    // The fake readiness barrier precedes Chromium's geometry event.
    // Wait for the new view's overlay before testing its CSS reservations.
    const geometryDeadline = Date.now() + 5_000;
    let afterSwap = await geometry();
    while (afterSwap.width === 0 && Date.now() < geometryDeadline) {
      await sleep(50);
      afterSwap = await geometry();
    }
    const click = async (x: number, y: number) => {
      host.webContents.sendInputEvent({
        type: "mouseDown",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      host.webContents.sendInputEvent({
        type: "mouseUp",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await sleep(50);
    };
    const popupClicks: string[] = [];
    for (const kind of ["popover", "dialog", "bare"]) {
      await host.webContents.executeJavaScript(
        `window.openPopup(${JSON.stringify(kind)})`
      );
      await click(500, 20);
      popupClicks.push(
        await host.webContents.executeJavaScript("window.lastDismissed")
      );
    }
    const browser = new WebContentsView({
      webPreferences: { backgroundThrottling: false },
    });
    window.contentView.addChildView(browser);
    await browser.webContents.loadURL(
      'data:text/html,<button style="position:fixed;inset:0" onclick="window.clicked=true">browser</button>'
    );
    browser.webContents.setZoomFactor(1.25);
    const browserClicks: boolean[] = [];
    for (const sidebar of [220, 80]) {
      browser.setBounds({ x: sidebar, y: 40, width: 500, height: 300 });
      // Wait for the zoomed viewport itself: occluded windows may never deliver rAF.
      await browser.webContents
        .executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const check = () => {
          const rect = document.querySelector('button').getBoundingClientRect();
          if (innerWidth === 400 && innerHeight === 240 && rect.width === 400 && rect.height === 240) resolve();
          else if (performance.now() >= deadline) reject(new Error('browser viewport did not resize'));
          else setTimeout(check, 10);
        };
        check();
      })`);
      browser.webContents.sendInputEvent({
        type: "mouseDown",
        x: 2,
        y: 2,
        button: "left",
        clickCount: 1,
      });
      browser.webContents.sendInputEvent({
        type: "mouseUp",
        x: 2,
        y: 2,
        button: "left",
        clickCount: 1,
      });
      await sleep(50);
      browserClicks.push(
        await browser.webContents.executeJavaScript("window.clicked === true")
      );
      await browser.webContents.executeJavaScript("window.clicked=false");
    }
    browser.webContents.close();
    let native: unknown = null;
    if (process.platform === "linux") {
      const missing = await probeWindowChrome(async () => null);
      const full = await probeWindowChrome(async () => ({
        visible: true,
        x: 0,
        width: 100,
        height: 40,
        windowWidth: 100,
      }));
      persistLinuxNativeFrame();
      const bounds = window.getBounds();
      const replacement = new BaseWindow({
        ...bounds,
        ...windowChromeOptions({
          platform: "linux",
          dark: false,
          reducedTransparency: true,
          overlayHeight: 40,
          linuxMode: "native-frame",
        }),
      });
      native = {
        missing,
        full,
        persisted: useLinuxNativeFrame(),
        bounds: replacement.getBounds(),
        expected: bounds,
      };
      replacement.close();
    }
    fs.writeFileSync(
      process.env.CHROME_E2E_RESULT!,
      JSON.stringify({
        initial,
        resized,
        maximized,
        fullscreen,
        restored,
        beforeSwap,
        afterSwap,
        swapped,
        popupClicks,
        browserClicks,
        native,
        hasGeometry: hasOverlayGeometry(initial),
      })
    );
    host.webContents.close();
    window.destroy();
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(
      process.env.CHROME_E2E_RESULT!,
      JSON.stringify({ error: String(error) })
    );
    app.exit(1);
  }
});
