import type { BrowserWindow } from "electron";

/**
 * Lays the deck out at its own size, not the window's. A hidden window is
 * still clamped to the screen, so on a display narrower than the deck the
 * slides were measured, printed and exported at the screen's width: every
 * viewport-sized deck came out 1024x720 on a 1024-wide display, and a
 * template's narrow-screen breakpoint stacked its .pptx into one column.
 *
 * The override lasts while the debugger stays attached, which is the
 * window's whole life; the .pptx exporter reuses that session. A failure is
 * swallowed: the deck then prints at the window's size, as it did before.
 */
export const pinViewport = async (
  win: Pick<BrowserWindow, "webContents">,
  size: { widthPx: number; heightPx: number }
): Promise<void> => {
  try {
    const tools = win.webContents.debugger;
    if (!tools.isAttached()) tools.attach("1.3");
    await tools.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: size.widthPx,
      height: size.heightPx,
      deviceScaleFactor: 1,
      mobile: false,
    });
  } catch {
    /* printed at the window's size */
  }
};
