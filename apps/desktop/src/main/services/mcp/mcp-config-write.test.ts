/**
 * How the runtime MCP config asks to be written.
 *
 * The write itself — staging, the rename, waiting out a reader that holds the
 * file open — belongs to `@abacus-ai/agent/atomic-file` and is tested there.
 * What matters here is the option this caller passes: a connector starting or
 * stopping rewrites every live session's config, and none of that file's
 * content depends on connectors, so almost every one of those rewrites has
 * nothing to say. Making them anyway is what put a rename on top of the
 * sessions reading the same files.
 */
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
