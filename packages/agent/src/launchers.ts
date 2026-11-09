/**
 * Shell launchers keep ELECTRON_RUN_AS_NODE local to the app's own Node runs.
 * busybox runs them on Windows too: the trash's (trash.ts) and GNU grep's
 * (grep-launcher.ts) sit first on its PATH, ahead of the applets.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomicSync } from "./atomic-file.js";
import { abacusBotDir } from "./config.js";

export const shellQuote = (text: string): string =>
  `'${text.replace(/'/g, "'\\''")}'`;

/** The line that runs `node` as Node with `args` (shell words) and the launcher's own. */
export function execAsNode(node: string, args: readonly string[]): string {
  return `ELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE; exec ${[shellQuote(node), ...args].join(" ")} "$@"`;
}

/**
 * Keyed by sources so builds do not share launchers. Forward slashes keep
 * Windows shells from treating backslashes as escapes.
 */
export function launcherDir(kind: string, ...sources: string[]): string {
  const key = createHash("sha256")
    .update(sources.join("\n"))
    .digest("hex")
    .slice(0, 16);

  return path.join(abacusBotDir(), kind, key).replaceAll("\\", "/");
}

/** Writes an executable only when its text changes. */
export function writeLauncher(file: string, script: string): void {
  // Atomic, so a command never runs a half-written launcher.
  writeFileAtomicSync(file, script, { mode: 0o755, skipIfUnchanged: true });
}

/** This process's executable, with the forward slashes a launcher needs. */
export const selfNode = (): string => process.execPath.replaceAll("\\", "/");

/**
 * Runs this executable as Node without changing the shell's environment.
 * Null when the launcher cannot be written.
 */
export function nodeLauncher(): string | null {
  const node = selfNode();
  const dir = launcherDir("node", node);
  try {
    writeLauncher(`${dir}/node`, `#!/bin/sh\n${execAsNode(node, [])}\n`);
  } catch (error) {
    process.stderr.write(`[node] launcher not written: ${String(error)}\n`);
    return null;
  }

  return `${dir}/node`;
}

/** A launcher target beside the build at `moduleUrl`: the bundle's `.js`, or the source in tests. */
export function entryBeside(moduleUrl: string, base: string): string | null {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  for (const name of [`${base}.js`, `${base}.ts`]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** `BB_OVERRIDE_APPLETS` with `names` added: busybox's own applets give way to what PATH finds first. */
export function withOverrides(
  current: string | undefined,
  names: readonly string[]
): string {
  const value = current ?? "";
  const separator = value.includes(";") ? "," : ";";
  const missing = names.filter((name) => !value.split(/[;,\s]/).includes(name));

  return missing.length === 0
    ? value
    : `${value}${separator}${missing.join(",")}`;
}
