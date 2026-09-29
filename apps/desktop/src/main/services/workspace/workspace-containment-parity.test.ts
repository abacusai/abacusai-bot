/**
 * Pins the two containment rules to each other.
 *
 * `isInsideWorkspace` here and `isInsideDirectory` in
 * packages/agent/src/workspace-path.ts answer the same question (does this
 * path really land inside the workspace?) for the same reason, but they are
 * independent implementations rather than copies: one is async and folds case,
 * the other is sync. Comparing their source would prove nothing, so this drives
 * both through one table of cases and asserts they agree.
 *
 * They guard the same boundary, so a case one of them gets wrong is a hole
 * whichever side has it: the file tree lets an edit through that the agent
 * would have prompted for, or the other way round.
 */
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { isInsideWorkspace } from "./file-tree-service";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");

/**
 * Loaded by path at run time rather than imported: the rule is internal to the
 * agent, and neither package's build graph reaches into the other's sources.
 */
let isInsideDirectory: (candidate: string, directory: string) => boolean;

/** Absolute paths built during setup, keyed by the case that uses them. */
let workspace: string;
let outside: string;
const cases: { name: string; candidate: () => string; expected: boolean }[] = [
  {
    name: "a plain file inside the workspace",
    candidate: () => path.join(workspace, "notes.md"),
    expected: true,
  },
  {
    name: "a nested file inside the workspace",
    candidate: () => path.join(workspace, "src", "deep", "mod.ts"),
    expected: true,
  },
  {
    name: "a file that does not exist yet",
    candidate: () => path.join(workspace, "src", "not-created-yet.ts"),
    expected: true,
  },
  {
    name: "a sibling directory outside the workspace",
    candidate: () => path.join(outside, "secret.txt"),
    expected: false,
  },
  {
    name: "traversal out of the workspace with ..",
    candidate: () => path.join(workspace, "..", "outside", "secret.txt"),
    expected: false,
  },
  {
    name: "traversal that lands back inside the workspace",
    candidate: () => path.join(workspace, "src", "..", "notes.md"),
    expected: true,
  },
  {
    name: "a symlink inside the workspace pointing out of it",
    candidate: () => path.join(workspace, "escape-link"),
    expected: false,
  },
  {
    name: "a file under a symlinked directory pointing out of the workspace",
    candidate: () => path.join(workspace, "escape-dir", "secret.txt"),
    expected: false,
  },
  {
    name: "a dangling symlink whose target is outside the workspace",
    candidate: () => path.join(workspace, "dangling-link"),
    expected: false,
  },
  {
    name: "a dangling symlink whose target is inside the workspace",
    candidate: () => path.join(workspace, "dangling-inside"),
    expected: true,
  },
  {
    name: "the workspace path spelled with different casing",
    candidate: () => path.join(workspace.toUpperCase(), "notes.md"),
    // Only meaningful where the filesystem folds case; see the guard below.
    expected: true,
  },
];

beforeAll(async () => {
  ({ isInsideDirectory } = (await import(
    pathToFileURL(path.join(REPO_ROOT, "packages/agent/src/workspace-path.ts"))
      .href
  )) as { isInsideDirectory: typeof isInsideDirectory });

  // realpath the temp root once: on macOS /tmp is a symlink to /private/tmp,
  // and a workspace reached through a link is a different question than the
  // one these cases are about.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "containment-")));
  workspace = path.join(root, "workspace");
  outside = path.join(root, "outside");

  mkdirSync(path.join(workspace, "src", "deep"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(workspace, "notes.md"), "hi");
  writeFileSync(path.join(workspace, "src", "deep", "mod.ts"), "hi");
  writeFileSync(path.join(outside, "secret.txt"), "hi");

  symlinkSync(
    path.join(outside, "secret.txt"),
    path.join(workspace, "escape-link")
  );
  symlinkSync(outside, path.join(workspace, "escape-dir"));
  // Targets that deliberately do not exist: writing through the link still
  // creates the target, so where the target IS is what the gate must judge.
  symlinkSync(
    path.join(outside, "ghost.txt"),
    path.join(workspace, "dangling-link")
  );
  symlinkSync(
    path.join(workspace, "ghost.txt"),
    path.join(workspace, "dangling-inside")
  );
});

/** True where the filesystem itself folds case, which is what the rule tracks. */
const foldsCase = process.platform === "darwin" || process.platform === "win32";

describe("the two workspace containment rules agree", () => {
  for (const { name, candidate, expected } of cases) {
    const casing = name.endsWith("different casing");

    it.skipIf(casing && !foldsCase)(name, async () => {
      const desktop = await isInsideWorkspace(candidate(), workspace, {
        allowRoot: true,
      });
      const agent = isInsideDirectory(candidate(), workspace);

      expect({ desktop, agent }).toEqual({
        desktop: expected,
        agent: expected,
      });
    });
  }
});
