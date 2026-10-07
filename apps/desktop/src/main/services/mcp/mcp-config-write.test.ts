/** The options this caller passes; the write itself is tested in the agent. */
import fs from "fs";

import { describe, expect, it, vi } from "vitest";

import { useTempBotHome, writtenServers } from "./mcp-test-home";

const home = useTempBotHome();

describe("a rewrite with nothing new to say", () => {
  it("leaves the file alone rather than renaming onto a session's reader", async () => {
    const service = await home.loadService();
    const filePath = service.writeRuntimeMcp("code", {}, "session-1");
    const renameSync = vi.spyOn(fs, "renameSync");

    service.writeRuntimeMcp("code", {}, "session-1");

    expect(renameSync).not.toHaveBeenCalled();
    expect(writtenServers(filePath)).toEqual(["linear"]);
  });

  it("still writes when the servers actually changed", async () => {
    const service = await home.loadService();
    const filePath = service.writeRuntimeMcp("code", {}, "session-1");

    service.writeRuntimeMcp(
      "code",
      { browser: { url: "http://localhost:9" } },
      "session-1"
    );

    expect(writtenServers(filePath)).toEqual(["browser", "linear"]);
  });
});

describe("the retired browser connector entry", () => {
  it("drops the entry the app wrote, enabled or not, and keeps the rest", async () => {
    const service = await home.loadService();
    for (const pinned of ["@playwright/mcp@0.0.80", "@playwright/mcp@latest"])
      for (const disabled of [undefined, true]) {
        service.writeUserMcp("code", {
          mcpServers: {
            linear: { url: "http://localhost:11" },
            playwright: {
              command: "npx",
              args: ["-y", pinned],
              ...(disabled != null ? { disabled } : {}),
            },
          },
        });

        expect(service.removeRetiredBrowserServer("code")).toBe(true);
        expect(Object.keys(service.readUserMcp("code").mcpServers)).toEqual([
          "linear",
        ]);
        expect(service.removeRetiredBrowserServer("code")).toBe(false);
      }
  });

  it("leaves an entry the user edited alone", async () => {
    const service = await home.loadService();
    for (const playwright of [
      { command: "npx", args: ["-y", "@playwright/mcp@0.0.80", "--headless"] },
      {
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.80"],
        env: { X: "1" },
      },
      { command: "node", args: ["-y", "@playwright/mcp@latest"] },
    ]) {
      service.writeUserMcp("code", { mcpServers: { playwright } });

      expect(service.removeRetiredBrowserServer("code")).toBe(false);
      expect(service.readUserMcp("code").mcpServers.playwright).toEqual(
        playwright
      );
    }
  });
});
