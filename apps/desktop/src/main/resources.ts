import { join } from "node:path";

import { app } from "electron";

/**
 * The directory holding everything read at run time from outside the asar:
 * deck and PDF assets, the design catalog, seeded skills, and third-party
 * binaries under `vendor/`. `resources/` ships verbatim to `Contents/Resources`,
 * so every caller joins the same subpath in both layouts and only this function
 * knows the root. Anything downloaded rather than committed goes in `vendor/`.
 */
export function resourcesRoot(): string {
  // Packaged, the main process runs from inside app.asar, so a relative path
  // would resolve into the archive rather than beside it.
  return app.isPackaged
    ? process.resourcesPath
    : join(import.meta.dirname, "..", "..", "resources");
}

/** A path inside the resources directory, in either shape of the app. */
export function resourcePath(...segments: string[]): string {
  return join(resourcesRoot(), ...segments);
}

/**
 * The agent ships beside the resources rather than inside them, since it is
 * also published as the `abacusai-bot` CLI; in the workspace it is its own
 * package, the one place the two layouts differ.
 */
const REPO = join(import.meta.dirname, "..", "..", "..", "..");

/** The agent bundle the app spawns, one process per session. */
export function agentEntry(): string {
  return app.isPackaged
    ? resourcePath("agent", "main.js")
    : join(REPO, "packages", "agent", "dist", "main.js");
}

/**
 * The vendored ripgrep/fd binaries. An agent spawned from an installed
 * experience lives under userData and cannot find them beside its bundle, so
 * the spawner appends this directory to the child's PATH.
 */
export function agentVendorDir(): string {
  return app.isPackaged
    ? resourcePath("agent", "vendor")
    : join(REPO, "packages", "agent", "vendor");
}
