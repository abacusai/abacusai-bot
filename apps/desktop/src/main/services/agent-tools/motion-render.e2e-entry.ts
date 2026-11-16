/**
 * Runs inside a real Electron for motion-render.electron.test.ts: renders the
 * plans it is given through the real renderer and preload, and reports.
 */
import fs from "node:fs";

import { app } from "electron";

import { renderMotion, type RenderMotionRequest } from "./motion-agent";

app.on("window-all-closed", () => undefined);
app.whenReady().then(async () => {
  const plans = JSON.parse(
    fs.readFileSync(process.env.MOTION_E2E_PLANS!, "utf8")
  ) as Array<RenderMotionRequest & { software?: boolean }>;
  const results: unknown[] = [];
  for (const { software, ...plan } of plans) {
    try {
      results.push(
        await renderMotion(plan, {
          preload: process.env.MOTION_E2E_PRELOAD!,
          ...(software === true ? { software } : {}),
        })
      );
    } catch (error) {
      results.push({ error: (error as Error).message });
    }
  }
  fs.writeFileSync(process.env.MOTION_E2E_RESULT!, JSON.stringify(results));
  app.quit();
});
