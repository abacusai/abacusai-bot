import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What the Electron main process is allowed to import from the agent.
 *
 * The agent's index bundles the whole agent, and leaves the packages that load
 * native code external (see @abacus-ai/config/native-packages) because a
 * bundler cannot inline a `.node` addon. Those packages ship beside the asar
 * for the agent's own process to resolve — they are not inside the asar, and
 * the main process runs from inside the asar.
 *
 * So a single barrel import in main is not a size regression. It is an app that
 * does not start:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-tui'
 *   imported from .../app.asar/dist/main/index.js
 *
 * That shipped as 1.0.6, from one line added in good faith. The tsdown config
 * has warned about it in a comment since usage-stats was split out; a comment
 * cannot fail a build, and this can. Every entry below is a leaf module with no
 * agent runtime behind it — add to the list only after checking the same.
 */
const ALLOWED = new Set([
  "@abacus-ai/agent/usage",
  "@abacus-ai/agent/custom-instructions",
  // Checked the same way: its bundle is pi's generated model data and a
  // flattener — two chunks, no import outside `node:module`, and none of the
  // native packages. It reaches that catalog through pi's per-provider data
  // modules rather than the `providers/all` barrel, which drags the agent
  // runtime (streams, diagnostics, ~3 MB) in behind it.
  "@abacus-ai/agent/model-catalog",
  // Checked the same way: busybox's install is node:crypto, node:fs, node:os
  // and node:path, plus two leaf modules of this package that import nothing
  // but node builtins. pi stays on the other side of the split, in
  // posix-shell.ts, which main never imports.
  "@abacus-ai/agent/posix-shell-install",
]);

const MAIN_DIR = resolve(import.meta.dirname);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || entry.endsWith(".test.ts")) return [];
    return [path];
  });

/** Every `@abacus-ai/agent…` specifier this file imports. */
const agentImports = (path: string): string[] =>
  Array.from(
    readFileSync(path, "utf8").matchAll(
      /(?:from|import)\s*\(?\s*["'](@abacus-ai\/agent[^"']*)["']/g
    ),
    (match) => match[1]!
  );

describe("the main process's import surface", () => {
  it("reaches the agent only through leaf entries, never the barrel", () => {
    const offenders = sourceFiles(MAIN_DIR).flatMap((path) =>
      agentImports(path)
        .filter((specifier) => !ALLOWED.has(specifier))
        .map((specifier) => `${path.slice(MAIN_DIR.length + 1)} → ${specifier}`)
    );

    // The bare package name is the one that brings the native externals with
    // it, and it is the one that shipped broken.
    expect(offenders).toEqual([]);
  });

  it("names entries that exist, so the allowlist cannot rot", async () => {
    const { exports } = JSON.parse(
      readFileSync(
        resolve(MAIN_DIR, "../../../../packages/agent/package.json"),
        "utf8"
      )
    ) as { exports: Record<string, unknown> };

    for (const specifier of ALLOWED) {
      expect(exports).toHaveProperty(
        specifier.replace("@abacus-ai/agent", ".")
      );
    }
  });
});
