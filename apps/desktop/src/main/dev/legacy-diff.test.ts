/**
 * scripts/check-legacy-renderer-diff.mjs (Claude impl r1 #11): the base is
 * where the rewrite lands (main), never the branch HEAD is on, and a locale
 * change passes only as an addition.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

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
};

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
