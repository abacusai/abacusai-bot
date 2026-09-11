/**
 * Pins the desktop memory store to the CLI's twin.
 *
 * This pair is duplicated like static-server and todo-store, but it is not a
 * textual copy: the desktop side adds the UI-facing list/forget methods and the
 * two have been refactored differently, so comparing source would fail on
 * shape rather than behaviour. What has to match is what a model sees — the
 * same limits, the same refusals, the same wording, and bytes on disk either
 * side can read — because one store is written by both surfaces and a model
 * that learned this tool in the app must not meet a different one in the
 * terminal.
 *
 * Each case runs against both implementations, each with its own home, and the
 * results and the resulting file are compared.
 */
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { MemoryAction, MemoryResult, MemoryTarget } from "./memory-store";
import { applyMemoryAction as desktopApply } from "./memory-store";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");

type Apply = (
  target: MemoryTarget,
  action: MemoryAction,
  input: { content?: string; match?: string }
) => Promise<MemoryResult>;

interface Step {
  action: MemoryAction;
  content?: string;
  match?: string;
  target?: MemoryTarget;
}

/**
 * Loaded by path at run time rather than imported: neither package's build
 * graph reaches into the other's sources.
 */
let agentApply: Apply;

beforeAll(async () => {
  ({ applyMemoryAction: agentApply } = (await import(
    pathToFileURL(path.join(REPO_ROOT, "packages/agent/src/memory-store.ts"))
      .href
  )) as { applyMemoryAction: Apply });
});

const previousHome = process.env.ABACUSAI_BOT_HOME;

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
});

/** Run one sequence against one implementation in a home of its own. */
const run = async (
  apply: Apply,
  steps: Step[]
): Promise<{
  results: MemoryResult[];
  files: Record<string, string | null>;
}> => {
  const home = mkdtempSync(path.join(tmpdir(), "memory-parity-"));
  process.env.ABACUSAI_BOT_HOME = home;

  // Awaited one at a time: the steps are a sequence, and running them at once
  // would have them contend for the store lock rather than build on each other.
  const results: MemoryResult[] = [];
  for (const step of steps) {
    results.push(
      await apply(step.target ?? "memory", step.action, {
        content: step.content,
        match: step.match,
      })
    );
  }

  const read = (name: string): string | null => {
    try {
      return fs.readFileSync(path.join(home, "memories", name), "utf8");
    } catch {
      return null;
    }
  };

  return {
    results,
    files: { "MEMORY.md": read("MEMORY.md"), "USER.md": read("USER.md") },
  };
};

const cases: { name: string; steps: Step[] }[] = [
  {
    name: "adding entries",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      { action: "add", content: "tests live beside the code" },
    ],
  },
  {
    name: "adding the same entry twice is a no-op, not an error",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      { action: "add", content: "the build needs Node 22" },
    ],
  },
  {
    name: "adding to the user store keeps the two stores apart",
    steps: [
      {
        action: "add",
        content: "prefers short commit messages",
        target: "user",
      },
      { action: "add", content: "the build needs Node 22" },
    ],
  },
  {
    name: "an entry over the character limit is refused",
    steps: [{ action: "add", content: "x".repeat(2_500) }],
  },
  {
    name: "an entry containing the delimiter is refused",
    steps: [{ action: "add", content: "before\n§\nafter" }],
  },
  {
    name: "an empty entry is refused",
    steps: [{ action: "add", content: "   " }],
  },
  {
    name: "replacing by a unique fragment",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      { action: "add", content: "tests live beside the code" },
      {
        action: "replace",
        match: "Node 22",
        content: "the build needs Node 24",
      },
    ],
  },
  {
    name: "replacing by an ambiguous fragment is refused",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      { action: "add", content: "the build is slow" },
      { action: "replace", match: "the build", content: "something else" },
    ],
  },
  {
    name: "replacing by a fragment that matches nothing is refused",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      { action: "replace", match: "nothing like this", content: "x" },
    ],
  },
  {
    name: "replacing with an empty fragment is refused",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      { action: "replace", match: "  ", content: "x" },
    ],
  },
  {
    name: "replacing with content over the limit is refused",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      { action: "replace", match: "Node 22", content: "y".repeat(2_500) },
    ],
  },
  {
    name: "fragment matching ignores case",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      {
        action: "replace",
        match: "node 22",
        content: "the build needs Node 24",
      },
    ],
  },
  {
    name: "removing by fragment",
    steps: [
      { action: "add", content: "the build needs Node 22" },
      { action: "add", content: "tests live beside the code" },
      { action: "remove", match: "beside" },
    ],
  },
  {
    name: "removing something that is not there is refused",
    steps: [{ action: "remove", match: "never stored" }],
  },
  {
    name: "a write that would overflow the store is refused",
    steps: Array.from({ length: 11 }, (_, index) => ({
      action: "add" as const,
      content: `${index} ${"z".repeat(1_900)}`,
    })),
  },
];

describe("the two memory stores behave identically", () => {
  for (const { name, steps } of cases) {
    it(name, async () => {
      const desktop = await run(desktopApply as Apply, steps);
      const agent = await run(agentApply, steps);

      expect(desktop).toEqual(agent);
    });
  }
});
