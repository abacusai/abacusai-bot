/**
 * The filenames git will not hand over in plain text.
 *
 * The Changes panel used to read git's terminal-facing output, which quotes any
 * path it thinks is unusual and escapes the bytes in octal. `café.txt` arrived
 * as `"caf\303\251.txt"`, a tidy-up pass turned the backslashes into slashes,
 * and the panel ended up showing `"caf/303/251.txt"`, a name that does not
 * exist, so its diff was empty and staging it failed. Every accented, CJK or
 * emoji filename behaved that way.
 *
 * These run against real `git` output rather than hand-written strings: the
 * bug was a wrong belief about the format, and a fixture I typed myself would
 * have encoded the same wrong belief.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseNumstatZ, parseStatusZ } from "./git-porcelain";

const ACCENTED = "café.txt";
const CJK = "報告書.md";
const SPACED = "naïve report.md";
/**
 * A name containing what porcelain uses to mean "renamed to", so the parser is
 * shown not to confuse the two. Windows cannot represent it (`>` is one of the
 * characters its filesystem reserves), so there it is simply not among the
 * names tried, rather than failing the whole file at setup.
 */
const ARROW = "a -> b.txt";
const NAMES =
  process.platform === "win32"
    ? [ACCENTED, CJK, SPACED, "plain.txt"]
    : [ACCENTED, CJK, SPACED, ARROW, "plain.txt"];

// Real git spawns; a loaded Windows CI runner can take several seconds per
// call, which flakes the default 5s budget.
const GIT_TIMEOUT = 30_000;

let repo: string;
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "git-porcelain-"));
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
}, GIT_TIMEOUT);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe(
  "reading status for names git will not print plainly",
  { timeout: GIT_TIMEOUT },
  () => {
    beforeAll(() => {
      for (const name of NAMES) {
        writeFileSync(join(repo, name), "one\n");
      }
    }, GIT_TIMEOUT);

    const status = (): ReturnType<typeof parseStatusZ> =>
      parseStatusZ(git("status", "--porcelain", "-uall", "-z"));

    it("confirms git really does quote these names", () => {
      // Guards the premise. If a future git stopped quoting, these tests would
      // still pass while proving nothing.
      const plain = git("status", "--porcelain", "-uall");

      expect(plain).toContain("\\303\\251");
      expect(plain).not.toContain(ACCENTED);
    });

    it.each(NAMES)("reports %s under its real name", (name) => {
      expect(status().map((entry) => entry.path)).toContain(name);
    });

    it("does not invent escape characters in the path", () => {
      for (const entry of status()) {
        expect(entry.path).not.toContain("\\");
        expect(entry.path).not.toMatch(/^"|"$/);
        expect(entry.path).not.toContain("/303/");
      }
    });

    it("marks a new file untracked", () => {
      const entry = status().find((e) => e.path === ACCENTED);

      expect(entry).toMatchObject({
        status: "??",
        stagedStatus: null,
        unstagedStatus: "?",
      });
    });

    it("separates staged from unstaged state", () => {
      git("add", "--", "plain.txt");
      appendFileSync(join(repo, "plain.txt"), "two\n");

      const entry = status().find((e) => e.path === "plain.txt");

      expect(entry?.stagedStatus).toBe("A");
      expect(entry?.unstagedStatus).toBe("M");
    });
  }
);

describe("reading a rename", { timeout: GIT_TIMEOUT }, () => {
  const RENAMED = "rénamed.txt";

  beforeAll(() => {
    git("add", "-A");
    git("commit", "-qm", "init");
    git("mv", ACCENTED, RENAMED);
  }, GIT_TIMEOUT);

  it("reports the file where it is now", () => {
    const paths = parseStatusZ(git("status", "--porcelain", "-uall", "-z")).map(
      (e) => e.path
    );

    expect(paths).toContain(RENAMED);
  });

  it("does not report the path it came from as a change of its own", () => {
    // The origin rides in its own NUL field. Read as a record it would appear
    // as a second, bogus entry with a garbled status.
    const paths = parseStatusZ(git("status", "--porcelain", "-uall", "-z")).map(
      (e) => e.path
    );

    expect(paths).not.toContain(ACCENTED);
  });

  it("counts a renamed file against its new path", () => {
    const entries = parseNumstatZ(
      git("diff", "--numstat", "--find-renames", "-z", "HEAD")
    );

    expect(entries.map((e) => e.path)).toContain(RENAMED);
  });
});

describe("reading numstat counts", { timeout: GIT_TIMEOUT }, () => {
  it("reads additions and deletions for an awkward name", () => {
    appendFileSync(join(repo, SPACED), "extra\n");

    const entry = parseNumstatZ(
      git("diff", "--numstat", "-z", "--", SPACED)
    ).find((e) => e.path === SPACED);

    expect(entry).toEqual({ path: SPACED, additions: 1, deletions: 0 });
  });

  it("leaves a binary file without counts rather than calling it zero", () => {
    // git prints `-` for both. Zero would read as "nothing changed".
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    git("add", "--", "blob.bin");

    const entry = parseNumstatZ(
      git("diff", "--cached", "--numstat", "-z", "--", "blob.bin")
    ).find((e) => e.path === "blob.bin");

    expect(entry).toEqual({
      path: "blob.bin",
      additions: null,
      deletions: null,
    });
  });

  it("returns nothing for an unchanged tree", () => {
    expect(parseNumstatZ("")).toEqual([]);
    expect(parseStatusZ("")).toEqual([]);
  });
});
