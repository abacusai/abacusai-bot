/**
 * A directory that stops existing partway through the walk.
 *
 * Between listing a parent and resolving one of its children, a build step, a
 * `git clean` or a watch process can remove it. It is a race, so it cannot be
 * provoked by arranging files on disk; only by making the filesystem call fail
 * at the moment the walk makes it. One vanished directory must cost the caller
 * that directory and nothing else.
 */
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let doomed: string;

beforeEach(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");

  root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-degraded-"));
  doomed = path.join(root, "doomed");

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(doomed, { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real.ts"), "export const kept = 1");
  fs.writeFileSync(path.join(doomed, "gone.ts"), "export const lost = 1");

  vi.resetModules();
});

afterEach(async () => {
  const fs = await import("node:fs");
  fs.rmSync(root, { recursive: true, force: true });
  vi.doUnmock("node:fs");
});

describe("when realpath fails for one directory", () => {
  it("skips that directory and keeps the rest of the scan", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();

      return {
        ...actual,
        default: actual,
        realpathSync: (target: Parameters<typeof actual.realpathSync>[0]) => {
          if (String(target) === doomed)
            throw new Error("ENOENT: no such file or directory");

          return actual.realpathSync(target);
        },
      };
    });

    const { collectFiles } = await import("./workspace-scan.js");
    const result = collectFiles(root, (file) => file.endsWith(".ts"), {
      maxFiles: 100,
      maxDepth: 10,
      timeBudgetMs: 5_000,
    });

    expect(
      result.files.map((file) =>
        path.relative(root, file).split(path.sep).join("/")
      )
    ).toEqual(["src/real.ts"]);
    expect(result.stoppedEarly).toBeNull();
  });
});
