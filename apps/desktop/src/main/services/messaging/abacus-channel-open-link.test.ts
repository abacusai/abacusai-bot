import { expect, it, vi } from "vitest";
const window = vi.hoisted(() => ({
  loadURL: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  on: vi.fn(),
  webContents: {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp" },
  BrowserWindow: class {
    constructor() {
      return window;
    }
  },
}));
vi.mock("../../bring-to-front", () => ({ parentWindow: () => null }));
import { AbacusChannelsConnector } from "./abacus-channels-connector";
it("desktop pending links open a native window and return void", () => {
  const connector = new AbacusChannelsConnector(
    {} as never,
    "discord",
    "electron"
  );
  const url = "https://discord.com/oauth2/authorize?client_id=fixture";
  (connector as any).link = { status: "pending", deepLink: url };
  expect(connector.openLink()).toBeUndefined();
  expect(window.loadURL).toHaveBeenCalledWith(url);
});
