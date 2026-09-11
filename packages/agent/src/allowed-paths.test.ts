import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { ALLOWED_PATHS_ENV, allowedPathsFromEnv } from "./allowed-paths.js";

describe("pre-allowed paths from the host", () => {
  it("reads absolute directories, and ignores what is not one", () => {
    const env = {
      [ALLOWED_PATHS_ENV]: [
        "/home/me/.abacusai-bot/routines/job-1",
        " ",
        "relative/dir",
        "/tmp/x/../y",
      ].join(path.delimiter),
    };
    // Resolved the way the function resolves them, so the expectation holds
    // on Windows too, where an absolute POSIX path gains a drive letter.
    expect(allowedPathsFromEnv(env)).toEqual([
      path.resolve("/home/me/.abacusai-bot/routines/job-1"),
      path.resolve("/tmp/y"),
    ]);
  });

  it("is empty when the host set nothing", () => {
    expect(allowedPathsFromEnv({})).toEqual([]);
  });
});
