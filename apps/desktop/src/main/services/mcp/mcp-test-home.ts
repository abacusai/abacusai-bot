/**
 * A disposable ABACUSAI_BOT_HOME. The service resolves the home directory at
 * import time, so tests must set the env var and re-import behind it.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, vi } from "vitest";

import type { McpConfigService } from "./mcp-config-service";

export interface TempBotHome {
  /** A fresh service bound to this home. */
  loadService: () => Promise<McpConfigService>;
}

/** `seed` is written as `mcp-code.json` before each test. */
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
