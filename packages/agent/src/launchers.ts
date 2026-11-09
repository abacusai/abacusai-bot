/**
 * `#!/bin/sh` launchers that run this app's binary as Node. ELECTRON_RUN_AS_NODE
 * is set for the launcher's own exec only, so it never reaches what a command
 * starts (child-env.ts). busybox runs them too, so they work on Windows.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

import { writeFileAtomicSync } from "./atomic-file.js";
import { abacusBotDir } from "./config.js";

export const shellQuote = (text: string): string =>
  `'${text.replace(/'/g, "'\\''")}'`;

/** The line that runs `node` as Node with `args` (shell words) and the launcher's own. */
export function execAsNode(node: string, args: readonly string[]): string {
  return `ELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE; exec ${[shellQuote(node), ...args].join(" ")} "$@"`;
}

/**
 * The directory for one set of launchers under the app home, keyed by what
 * they were made from so two builds never share one. Forward slashes: the
 * Windows shell drops unquoted backslashes.
 */
export function launcherDir(kind: string, ...sources: string[]): string {
  const key = createHash("sha256")
    .update(sources.join("\n"))
    .digest("hex")
    .slice(0, 16);

  return path.join(abacusBotDir(), kind, key).replaceAll("\\", "/");
}

/** Writes each script into `dir` as an executable, only when its text changed. Throws when it cannot. */
export function writeLaunchers(
  dir: string,
  scripts: Readonly<Record<string, string>>
): void {
  // Atomic, so a command never runs a half-written launcher.
  for (const [name, script] of Object.entries(scripts))
    writeFileAtomicSync(path.join(dir, name), script, {
      mode: 0o755,
      skipIfUnchanged: true,
    });
}

/** This process's executable, with the forward slashes a launcher needs. */
export const selfNode = (): string => process.execPath.replaceAll("\\", "/");

/**
 * This process's executable behind a launcher, so the shell can run it as
 * Node without ELECTRON_RUN_AS_NODE in its environment. Null when the
 * launcher cannot be written.
 */
export function nodeLauncher(): string | null {
  const node = selfNode();
  const dir = launcherDir("node", node);
  try {
    writeLaunchers(dir, { node: `#!/bin/sh\n${execAsNode(node, [])}\n` });
  } catch (error) {
    process.stderr.write(`[node] launcher not written: ${String(error)}\n`);
    return null;
  }

  return `${dir}/node`;
}
