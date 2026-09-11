/**
 * Renderer state policy, enforced.
 *
 * Each experience renderer runs on its own origin, so window.localStorage
 * and sessionStorage silently reset on every renderer swap. Nothing in the
 * renderer touches them directly: durable state goes through
 * lib/durable-storage (main-process owned; it survives swaps, foundation
 * updates, and relaunches), and everything else must be derived state or
 * view-transient state a swap may discard.
 *
 * Tests are exempt: they exercise the localStorage fallback deliberately.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RENDERER = path.resolve(import.meta.dirname, "..");

// The one module allowed to touch the origin's storage (fallback, migration,
// legacy wipe).
const ALLOWED = new Set(["lib/durable-storage.ts"]);

const USAGE = /(?:window\.)?(?:localStorage|sessionStorage)\s*[.[]/;

// Forward slashes on every platform, so ALLOWED matches on Windows too.
const relative = (file: string): string =>
  path.relative(RENDERER, file).split(path.sep).join("/");

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];

    return [full];
  });

describe("renderer storage", () => {
  it("goes through durable-storage, never the origin's own", () => {
    const violations = sourceFiles(RENDERER)
      .filter((file) => !ALLOWED.has(relative(file)))
      .flatMap((file) => {
        const lines = readFileSync(file, "utf-8").split("\n");

        return lines
          .map((line, index) => ({ index, line }))
          .filter(({ line }) => USAGE.test(line))
          .map(
            ({ index, line }) =>
              `${relative(file)}:${index + 1}: ${line.trim()}`
          );
      });

    expect(violations).toEqual([]);
  });
});
