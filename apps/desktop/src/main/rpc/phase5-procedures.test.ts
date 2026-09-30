/**
 * Spec 05 §31.5's new procedures through the real router and transport:
 * `window.setDensity` (b), `system.loginItem` (c) with its typed Linux
 * refusal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLoginItem } from "../services/system/login-item";
import { connectInProcess, fakeDeps, type FakeDepsOverrides } from "./testing";

const connections: Array<{ closeClient(): void; closeServer(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

const connect = (overrides: FakeDepsOverrides) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const connection = connectInProcess(fakeDeps(overrides));
  connections.push(connection);
  return connection.client;
};

describe("window.setDensity (spec 05 §31.5 b)", () => {
  it("runs the legacy handler's body and answers its result", async () => {
    const setTitlebarDensity = vi.fn(async (density: unknown) => ({
      density: density as "compact",
      appliesOnRestart: false,
    }));
    const client = connect({ app: { setTitlebarDensity } });
    await expect(
      client.window.setDensity({ density: "compact" })
    ).resolves.toEqual({ density: "compact", appliesOnRestart: false });
    expect(setTitlebarDensity).toHaveBeenCalledWith("compact");
  });

  it("refuses a density the schema does not know", async () => {
    const setTitlebarDensity = vi.fn();
    const client = connect({ app: { setTitlebarDensity } });
    await expect(
      client.window.setDensity({ density: "tiny" as never })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(setTitlebarDensity).not.toHaveBeenCalled();
  });
});

describe("system.loginItem (spec 05 §31.5 c)", () => {
  const electronApp = () => {
    let openAtLogin = false;
    return {
      getLoginItemSettings: () => ({ openAtLogin }),
      setLoginItemSettings: (settings: { openAtLogin: boolean }) => {
        openAtLogin = settings.openAtLogin;
      },
    };
  };

  it("reads and writes on macOS", async () => {
    const client = connect({
      app: { loginItem: createLoginItem(electronApp(), "darwin") },
    });
    await expect(client.system.loginItem.get()).resolves.toEqual({
      openAtLogin: false,
    });
    await expect(
      client.system.loginItem.set({ openAtLogin: true })
    ).resolves.toEqual({ openAtLogin: true });
    await expect(client.system.loginItem.get()).resolves.toEqual({
      openAtLogin: true,
    });
  });

  it("is PRECONDITION_FAILED unsupported-platform on Linux", async () => {
    const client = connect({
      app: { loginItem: createLoginItem(electronApp(), "linux") },
    });
    for (const call of [
      () => client.system.loginItem.get(),
      () => client.system.loginItem.set({ openAtLogin: true }),
    ])
      await expect(call()).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        defined: true,
        data: { reason: "unsupported-platform" },
      });
  });
});
