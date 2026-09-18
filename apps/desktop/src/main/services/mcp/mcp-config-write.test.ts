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
