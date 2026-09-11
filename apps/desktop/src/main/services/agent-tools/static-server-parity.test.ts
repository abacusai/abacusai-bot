/**
 * Pins the duplicated agent-tool modules to their packages/agent twins.
 *
 * The pairs are intentionally copy-pasted (see each file's header), so drift
 * is silent: nothing imports across the boundary, and a fix landing on one
 * side just quietly never lands on the other. Comparing the files with
 * comments and blank lines stripped makes that drift a test failure while
 * still letting each copy explain itself in its own words.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HERE = import.meta.dirname;
const REPO_ROOT = resolve(HERE, "../../../../../..");

/** Drop block comments, whole-line and trailing `//` comments, blank lines. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    // Trailing comments only after whitespace, so `://` in strings survives.
    .replace(/[ \t]\/\/ .*$/gm, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n");

const strippedPair = (name: string): { desktop: string; agent: string } => ({
  desktop: stripComments(readFileSync(resolve(HERE, `${name}.ts`), "utf8")),
  agent: stripComments(
    readFileSync(resolve(REPO_ROOT, `packages/agent/src/${name}.ts`), "utf8")
  ),
});

describe("duplicated agent-tool modules stay in step", () => {
  it("static-server.ts matches packages/agent/src/static-server.ts", () => {
    const { desktop, agent } = strippedPair("static-server");
    expect(desktop).toBe(agent);
  });

  it("todo-store.ts matches packages/agent/src/todo-store.ts", () => {
    const { desktop, agent } = strippedPair("todo-store");
    expect(desktop).toBe(agent);
  });
});
