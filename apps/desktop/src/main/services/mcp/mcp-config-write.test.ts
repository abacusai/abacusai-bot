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

describe("retiring the Playwright connector entries the app wrote", () => {
  const retire = async () => {
    const { retirePlaywrightEntries } = await import("./playwright-migration");
    const { MCP_MODES } = await import("@abacus-ai/contract/contracts");
    return { retirePlaywrightEntries, MCP_MODES };
  };
  const appWritten = [
    { command: "npx", args: ["-y", "@playwright/mcp@0.0.80"] },
    { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    { command: "npx", args: ["@playwright/mcp"], disabled: true },
  ];

  it("drops them in every mode, keeps the rest, and logs what went", async () => {
    const service = await home.loadService();
    const { retirePlaywrightEntries, MCP_MODES } = await retire();
    for (const mode of MCP_MODES)
      service.writeUserMcp(mode, {
        mcpServers: {
          linear: { url: "http://localhost:11" },
          ...Object.fromEntries(
            appWritten.map((entry, index) => [`playwright-${index}`, entry])
          ),
        },
      });
    const log = vi.fn();

    const removed = retirePlaywrightEntries(service, log);

    for (const mode of MCP_MODES) {
      expect(Object.keys(service.readUserMcp(mode).mcpServers)).toEqual([
        "linear",
      ]);
      expect(log).toHaveBeenCalledWith(
        `[mcp] retired the Playwright connector in ${mode}: playwright-0, playwright-1, playwright-2`
      );
    }
    expect(removed).toHaveLength(appWritten.length * MCP_MODES.length);
  });

  it("leaves an entry the user edited alone", async () => {
    const service = await home.loadService();
    const { retirePlaywrightEntries } = await retire();
    const edited = {
      extraArg: {
        command: "npx",
        args: ["-y", "@playwright/mcp", "--headless"],
      },
      env: {
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.80"],
        env: { X: "1" },
      },
      command: { command: "node", args: ["-y", "@playwright/mcp@latest"] },
      otherPackage: { command: "npx", args: ["-y", "@playwright/mcp-extra"] },
    };
    service.writeUserMcp("code", { mcpServers: edited });

    expect(retirePlaywrightEntries(service, vi.fn())).toEqual([]);
    expect(service.readUserMcp("code").mcpServers).toEqual(edited);
  });

  it("runs once: an entry added after the first run stays", async () => {
    const service = await home.loadService();
    const { retirePlaywrightEntries } = await retire();
    retirePlaywrightEntries(service, vi.fn());
    service.writeUserMcp("code", {
      mcpServers: { playwright: appWritten[0]! },
    });
    const log = vi.fn();

    const restarted = await home.loadService();
    expect(retirePlaywrightEntries(restarted, log)).toEqual([]);
    expect(Object.keys(restarted.readUserMcp("code").mcpServers)).toEqual([
      "playwright",
    ]);
    expect(log).not.toHaveBeenCalled();
  });
});
