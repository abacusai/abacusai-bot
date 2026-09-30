/**
 * scripts/check-legacy-renderer-diff.mjs (Claude impl r1 #11): the base is
 * where the rewrite lands (main), never the branch HEAD is on, and a locale
 * change passes only as an addition. The check itself runs in a temporary
 * repository (Codex impl r2 #8): diverging histories, the commit-pinned
 * allow-list, and an edit after the sanctioned commit.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = pathToFileURL(
  resolve(
    import.meta.dirname,
    "../../../scripts/check-legacy-renderer-diff.mjs"
  )
).href;

type Module = {
  resolveBase(
    argv: string[],
    env: Record<string, string | undefined>,
    exists?: (ref: string) => boolean
  ): string;
  localeProblems(file: string, before: object, after: object): string[];
  checkLegacyDiff(options: {
    cwd: string;
    base: string;
    allow: AllowEntry[];
  }): { mergeBase: string; changed: string[]; problems: string[] };
};

type AllowEntry = { path: string; commit: string; why?: string };

const load = async (): Promise<Module> => (await import(script)) as Module;

describe("check-legacy-renderer-diff", () => {
  it("defaults to main, never the rewrite branch", async () => {
    const { resolveBase } = await load();
    expect(resolveBase([], {}, () => true)).toBe("main");
    expect(resolveBase([], {}, (ref) => ref === "origin/main")).toBe(
      "origin/main"
    );
    expect(
      resolveBase([], { GITHUB_BASE_REF: "main" }, (ref) =>
        ref.startsWith("origin/")
      )
    ).toBe("origin/main");
    expect(resolveBase([], { LEGACY_BASE: "abc123" }, () => false)).toBe(
      "abc123"
    );
    expect(resolveBase(["xyz"], {}, () => false)).toBe("xyz");
    expect(() => resolveBase([], {}, () => false)).toThrow(/none of/);
  });

  it("accepts added locale keys and refuses changed or removed ones", async () => {
    const { localeProblems } = await load();
    expect(
      localeProblems("en.json", { a: { b: "x" } }, { a: { b: "x", c: "y" } })
    ).toEqual([]);
    expect(
      localeProblems("en.json", { a: { b: "x", c: "y" } }, { a: { b: "z" } })
    ).toEqual(["en.json: changed a.b", "en.json: removed a.c"]);
  });
});

const ALLOW_FILE = resolve(
  import.meta.dirname,
  "../../../scripts/legacy-renderer-allow.json"
);

/** A throwaway repository with the monorepo's `apps/desktop` layout. */
const tempRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-diff-"));
  const desktop = join(root, "apps/desktop");
  mkdirSync(desktop, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  const write = (path: string, content: string) => {
    const full = join(desktop, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const commit = (message: string): string => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "--short=8", "HEAD");
  };
  git("init", "-q", "-b", "main");
  return { root, desktop, git, write, commit };
};

const repos: string[] = [];
afterEach(() => {
  for (const root of repos.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const EN = "src/renderer/locales/en.json";
const APP = "src/renderer/app.tsx";

/** main and the rewrite branch, diverged after one shared commit. */
const diverged = () => {
  const repo = tempRepo();
  repos.push(repo.root);
  repo.write(EN, JSON.stringify({ a: { b: "x" } }));
  repo.write(APP, "export const app = 1;\n");
  repo.commit("base");
  repo.git("checkout", "-q", "-b", "rewrite");
  repo.git("checkout", "-q", "main");
  // Work that lands on main after the branch point: never the branch's diff.
  repo.write(APP, "export const app = 2;\n");
  repo.write("src/renderer/main-only.tsx", "export {};\n");
  repo.commit("main moves on");
  repo.git("checkout", "-q", "rewrite");
  return repo;
};

describe("checkLegacyDiff in a temporary repository (Codex impl r2 #8)", () => {
  it("diffs against the merge-base, so main's own later work is not the branch's", async () => {
    const { checkLegacyDiff } = await load();
    const repo = diverged();
    repo.write(EN, JSON.stringify({ a: { b: "x", c: "added" } }));
    repo.commit("add a locale key");
    const result = checkLegacyDiff({
      cwd: repo.desktop,
      base: "main",
      allow: [],
    });
    expect(result.mergeBase).toBe(repo.git("rev-parse", "HEAD~1"));
    expect(result.mergeBase).not.toBe(repo.git("rev-parse", "HEAD"));
    expect(result.changed).toEqual([EN]);
    expect(result.problems).toEqual([]);
  });

  it("is not vacuous: a branch edit to a component or a changed locale value fails", async () => {
    const { checkLegacyDiff } = await load();
    const repo = diverged();
    repo.write(APP, "export const app = 3;\n");
    repo.write(EN, JSON.stringify({ a: { b: "changed" } }));
    repo.commit("touch the old renderer");
    const { problems } = checkLegacyDiff({
      cwd: repo.desktop,
      base: "main",
      allow: [],
    });
    expect(problems).toEqual([
      `${APP}: only locale JSON may change under src/renderer`,
      `${EN}: changed a.b`,
    ]);
  });

  it("accepts the sanctioned files exactly as the pinned commit left them, and nothing else", async () => {
    const { checkLegacyDiff } = await load();
    // The real allow-list: pinned to a79707f6, the sign-in change.
    const { allow } = JSON.parse(readFileSync(ALLOW_FILE, "utf8")) as {
      allow: AllowEntry[];
    };
    expect(allow.length).toBeGreaterThan(0);
    for (const entry of allow) {
      expect(entry.commit).toBe("a79707f6");
      expect(entry.path).toMatch(/^src\/renderer\//);
    }

    const repo = diverged();
    for (const entry of allow) repo.write(entry.path, `// ${entry.why}\n`);
    const sanctioned = repo.commit("Sign-in: the sanctioned legacy change");
    // The same entries, pinned to this repository's sanctioned commit.
    const pinned = allow.map((entry) => ({ ...entry, commit: sanctioned }));
    expect(
      checkLegacyDiff({ cwd: repo.desktop, base: "main", allow: pinned })
        .problems
    ).toEqual([]);
    // Unlisted, the same files fail: the list is what exempts them.
    expect(
      checkLegacyDiff({ cwd: repo.desktop, base: "main", allow: [] }).problems
    ).toHaveLength(allow.length);
    // A listed path exempts only itself.
    repo.write("src/renderer/components/onboarding/other.tsx", "export {};\n");
    repo.commit("an unlisted neighbour");
    expect(
      checkLegacyDiff({ cwd: repo.desktop, base: "main", allow: pinned })
        .problems
    ).toEqual([
      "src/renderer/components/onboarding/other.tsx: only locale JSON may change under src/renderer",
    ]);
  });

  it("fails a sanctioned file edited again after the pinned commit, committed or not", async () => {
    const { checkLegacyDiff } = await load();
    const repo = diverged();
    const path = "src/renderer/components/onboarding/sign-in-step.tsx";
    repo.write(path, "export const step = 1;\n");
    const sanctioned = repo.commit("sanctioned");
    const allow = [{ path, commit: sanctioned }];
    expect(
      checkLegacyDiff({ cwd: repo.desktop, base: "main", allow }).problems
    ).toEqual([]);

    // An uncommitted edit.
    repo.write(path, "export const step = 2;\n");
    expect(
      checkLegacyDiff({ cwd: repo.desktop, base: "main", allow }).problems
    ).toEqual([`${path}: only locale JSON may change under src/renderer`]);

    // The same edit, committed later.
    repo.commit("unauthorized follow-up");
    expect(
      checkLegacyDiff({ cwd: repo.desktop, base: "main", allow }).problems
    ).toEqual([`${path}: only locale JSON may change under src/renderer`]);
  });
});
