/**
 * Point the agent's search tools at the ripgrep and fd binaries the app ships.
 * pi otherwise downloads them from GitHub on first search and has no JS
 * fallback, so an offline or rate-limited machine gets no `grep` at all. The
 * directory is APPENDED to PATH: a user's own rg/fd keeps winning, for `bash`
 * as much as for these tools, and the shipped copies are only the fallback.
 */
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeLauncher } from "./launchers.js";

/**
 * The package's `vendor/` directory: beside the bundle when packaged, one level
 * above dist/ in the workspace (tsdown clears dist on every build). Neither
 * existing is valid (a source checkout); callers then fall back to PATH.
 */
export function bundledToolsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = join(here, "vendor");
  return existsSync(packaged) ? packaged : join(here, "..", "vendor");
}

/**
 * Add the shipped binaries to PATH. Returns whether they were there to add.
 * Idempotent, so a subagent inheriting this environment does not grow a PATH
 * entry per generation.
 */
export function useBundledTools(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = bundledToolsDir()
): boolean {
  if (!existsSync(dir)) return false;

  const current = env.PATH ?? "";
  if (current.split(delimiter).includes(dir)) return true;

  env.PATH = current === "" ? dir : `${current}${delimiter}${dir}`;

  return true;
}

/** The libraries the agent's own Node scripts `require`, built beside the bundle. */
export function scriptModulesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "modules");
}

/**
 * Lets the shell run Node scripts on this app's own runtime, which every
 * machine has: ABACUSAI_BOT_NODE names a launcher that runs this process's
 * executable as Node (launchers.ts) and NODE_PATH reaches the bundled
 * libraries. Idempotent.
 */
export function useScriptRuntime(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = scriptModulesDir(),
  node: string | null = nodeLauncher()
): boolean {
  if (!existsSync(dir) || node == null) return false;

  env.ABACUSAI_BOT_NODE = node;
  const current = env.NODE_PATH ?? "";
  if (!current.split(delimiter).includes(dir))
    env.NODE_PATH = current === "" ? dir : `${dir}${delimiter}${current}`;

  return true;
}
