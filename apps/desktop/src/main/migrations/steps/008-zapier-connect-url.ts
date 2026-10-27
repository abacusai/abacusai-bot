/**
 * Step 8: Zapier MCP moved to `/api/v1/connect`. The older `/api/mcp/mcp`
 * still completes a sign-in but refuses every token it issued, so a server
 * installed with it sat at "Needs sign-in" forever. Every server entry at the
 * old URL, whatever its name, gets the new one, and a token stored under the
 * old URL moves with it: Zapier accepts it at the new endpoint.
 */
import fs from "node:fs";
import path from "node:path";

import type { MigrationContext, MigrationStep, PlannedWrite } from "../types";

const OLD_URL = "https://mcp.zapier.com/api/mcp/mcp";
const NEW_URL = "https://mcp.zapier.com/api/v1/connect";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value != null && typeof value === "object" && !Array.isArray(value);

/** `mcp-code.json` and the older `mcp.json`: entries under `mcpServers`. */
const moveServers = (parsed: unknown): boolean => {
  if (!isObject(parsed) || !isObject(parsed.mcpServers)) return false;
  let changed = false;
  for (const entry of Object.values(parsed.mcpServers))
    if (isObject(entry) && entry.url === OLD_URL) {
      entry.url = NEW_URL;
      changed = true;
    }
  return changed;
};

/** `mcp-auth.json`: tokens keyed by server URL. A newer sign-in wins. */
const moveToken = (parsed: unknown): boolean => {
  if (!isObject(parsed) || !isObject(parsed.servers)) return false;
  const servers = parsed.servers;
  if (!(OLD_URL in servers)) return false;
  if (!(NEW_URL in servers)) servers[NEW_URL] = servers[OLD_URL];
  delete servers[OLD_URL];
  return true;
};

const TARGETS: { file: string; move(parsed: unknown): boolean }[] = [
  { file: "mcp-code.json", move: moveServers },
  { file: "mcp.json", move: moveServers },
  { file: "mcp-auth.json", move: moveToken },
];

const planTarget = (
  ctx: MigrationContext,
  target: (typeof TARGETS)[number]
): PlannedWrite | null => {
  const dest = path.join(ctx.home, target.file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(dest, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    ctx.log(`zapier connect url: ${target.file} skipped: ${String(error)}`);
    return null;
  }
  if (!target.move(parsed)) return null;
  const staged = path.join(ctx.staging, target.file);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  // Server headers and OAuth tokens; the rename keeps the mode.
  fs.writeFileSync(staged, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: 0o600,
  });
  return { dest, staged, kind: "replace-user" };
};

export const zapierConnectUrl = (): MigrationStep => ({
  id: 8,
  name: "zapier-connect-url",
  plan: async (ctx) => {
    const writes = TARGETS.flatMap((target) => planTarget(ctx, target) ?? []);
    return { writes, removals: [], stats: { rewritten: writes.length } };
  },
});
