import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("../config/settings", () => ({
  readSettings: () => ({ apiKeys: { ABACUS_API_KEY: "test-key" } }),
}));
vi.mock("../diagnostics/client-environment", () => ({
  clientEnvironment: () => ({}),
}));
vi.mock("./device-id", () => ({ deviceId: () => "test-device" }));
const { DebugSyncService } = await import("./debug-sync-service");
const originalHome = process.env.ABACUSAI_BOT_HOME;
let home: string;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

it("yields before reading histories and bounds offline catch-up uploads", async () => {
  vi.useFakeTimers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sync-startup-"));
  process.env.ABACUSAI_BOT_HOME = home;
  fs.mkdirSync(path.join(home, "threads"));
  for (let i = 0; i < 100; i++)
    fs.writeFileSync(path.join(home, "threads", `${i}.json`), "{}");
  const readTranscript = vi.fn((id: string) => ({
    sessionId: id,
    segments: [
      {
        id: `${id}-text`,
        type: "text",
        source: "user",
        at: 1,
        content: "hello",
      },
    ],
  }));
  const uploads = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", uploads);
  const service = new DebugSyncService({
    readTranscript: readTranscript as never,
    clientVersion: "1",
  });
  service.sweepOnStartup();
  service.sweepOnStartup();
  expect(readTranscript).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(uploads).toHaveBeenCalledTimes(2);
  expect(readTranscript).toHaveBeenCalledTimes(2);
});
