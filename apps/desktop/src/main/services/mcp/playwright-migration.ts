/**
 * The browser is built in, so the Playwright connector entries the app once
 * wrote would run a second browser beside it. A one-shot migration drops
 * them in every mode; an entry the user edited is theirs and stays.
 */
import { MCP_MODES } from "@abacus-ai/contract/contracts";

import type {
  McpConfigService,
  McpMode,
  McpServerEntry,
} from "./mcp-config-service";

/** `@playwright/mcp`, bare or at any version or tag. */
const PLAYWRIGHT_PACKAGE = /^@playwright\/mcp(@[\w.-]+)?$/;
/** The only flag the app ever wrote beside the package (`npx -y <pkg>`). */
const APP_WRITTEN_FLAGS = new Set(["-y"]);

/** Exactly what the app wrote: `npx`, the package and its flags, maybe toggled off. */
const isAppWrittenPlaywrightEntry = (entry: McpServerEntry): boolean => {
  const { command, args, disabled, ...rest } = entry;
  if (Object.keys(rest).length > 0 || command !== "npx" || args == null)
    return false;
  if (disabled !== undefined && typeof disabled !== "boolean") return false;
  const packages = args.filter((arg) => PLAYWRIGHT_PACKAGE.test(arg));
  return (
    packages.length === 1 &&
    args.every((arg) => packages.includes(arg) || APP_WRITTEN_FLAGS.has(arg))
  );
};

export type RetiredPlaywrightEntry = { mode: McpMode; name: string };

/** Runs once per install (a marker in the app state); later calls do nothing. */
export const retirePlaywrightEntries = (
  config: McpConfigService,
  log: (line: string) => void = console.log
): RetiredPlaywrightEntry[] => {
  if (config.readState().playwrightEntriesRetired === true) return [];
  const removed: RetiredPlaywrightEntry[] = [];
  for (const mode of MCP_MODES) {
    const user = config.readUserMcp(mode);
    const names = Object.keys(user.mcpServers).filter((name) =>
      isAppWrittenPlaywrightEntry(user.mcpServers[name]!)
    );
    if (names.length === 0) continue;
    for (const name of names) delete user.mcpServers[name];
    config.writeUserMcp(mode, user);
    removed.push(...names.map((name) => ({ mode, name })));
    log(
      `[mcp] retired the Playwright connector in ${mode}: ${names.join(", ")}`
    );
  }
  config.writeState({ ...config.readState(), playwrightEntriesRetired: true });
  return removed;
};
