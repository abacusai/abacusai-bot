/**
 * A temporary ABACUSAI_BOT_HOME for the config tests. The service resolves the
 * home directory at import time, so every test that writes config has to point
 * the env var somewhere disposable and re-import the module behind it.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach } from "vitest";
import { vi } from "vitest";

export interface TempBotHome {
  /** The directory itself, valid inside a test body. */
  path: () => string;
  /** A fresh service bound to this home. */
  loadService: () => Promise<
    InstanceType<typeof import("./mcp-config-service").McpConfigService>
  >;
}

/**
 * Registers the hooks and hands back accessors. `seed` is written as
 * `mcp-code.json` before each test, since a service with no user config is
 * rarely what a test means.
 */
export const useTempBotHome = (
  seed: Record<string, unknown> = {
    mcpServers: { linear: { url: "http://localhost:11" } },
  }
): TempBotHome => {
  let home: string;
  const previousHome = process.env.ABACUSAI_BOT_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-home-"));
    process.env.ABACUSAI_BOT_HOME = home;
    fs.writeFileSync(path.join(home, "mcp-code.json"), JSON.stringify(seed));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
    else process.env.ABACUSAI_BOT_HOME = previousHome;

    fs.rmSync(home, { recursive: true, force: true });
  });

  return {
    path: () => home,
    loadService: async () => {
      vi.resetModules();
      const { McpConfigService } = await import("./mcp-config-service");
      return new McpConfigService();
    },
  };
};

/** The server names in a written runtime config, sorted. */
export const writtenServers = (filePath: string): string[] =>
  Object.keys(
    (
      JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      }
    ).mcpServers
  ).sort();
