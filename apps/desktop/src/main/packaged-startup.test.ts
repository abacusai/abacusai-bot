import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Whether the packaged app can load what it imports.
 *
 * The packaged main process runs from inside app.asar, which contains this
 * app's own bundles and its production dependencies, and nothing else. An
 * import of anything outside that set is not a slow start or a missing feature:
 * the process dies at module load, before a line of our code runs, and Electron
 * shows "A JavaScript error occurred in the main process" over an app that
 * never opens. There is no in-app recovery and no log, because logging has not
 * started yet.
 *
 * 1.0.5 and 1.0.6 shipped exactly that, from one import of the agent's barrel
 * that dragged in a package which ships BESIDE the asar for the agent's own
 * process. Typecheck was green, every unit suite was green, and the smoke test
 * that launches the packaged app was green too. It watched the pid, and a
 * process sitting on a fatal dialog keeps its pid.
 *
 * So this reads the built bundles and resolves every bare import against what
 * is actually packaged. It needs no Electron and no display: it is the check
 * that fails in seconds, in every pull request, rather than on a user's machine.
 */

const DESKTOP = resolve(import.meta.dirname, "../..");

/** Provided by the runtime rather than by the package. */
const RUNTIME_PROVIDED = new Set([
  "electron",
  "electron/main",
  "electron/common",
]);

const BUNDLES = ["dist/main/index.js", "dist/preload/index.cjs"];

const buildIfNeeded = (): void => {
  if (BUNDLES.every((bundle) => existsSync(resolve(DESKTOP, bundle)))) return;
  execFileSync("pnpm", ["exec", "vite", "build"], {
    cwd: DESKTOP,
    stdio: "inherit",
  });
};

/** The package a specifier belongs to: `@scope/name/sub` → `@scope/name`. */
const packageOf = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
};

/**
 * A bare package specifier and nothing else: `pkg`, `@scope/pkg`, `pkg/sub`.
 *
 * The bundles are megabytes of code containing every string the app can print,
 * and an import pattern loose enough to span a newline will eventually match
 * one of them. Anything that is not shaped like a package name is not one.
 */
const PACKAGE_SPECIFIER = /^@?[\w.-]+(?:\/[\w.-]+)*$/;

const bareImports = (source: string): string[] => {
  const found = new Set<string>();
  const patterns = [
    /(?:^|[\s;{}(])(?:import|export)\s*(?:[\w*{},\s]*?\s*from\s*)?["']([^"'.][^"']*)["']/g,
    /\brequire\(\s*["']([^"'.][^"']*)["']\s*\)/g,
    /\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]!;
      if (!PACKAGE_SPECIFIER.test(specifier)) continue;
      if (specifier.startsWith("node:")) continue;
      if (builtinModules.includes(packageOf(specifier))) continue;
      found.add(specifier);
    }
  }

  return [...found].sort();
};

describe("the packaged bundles", () => {
  it("import nothing the packaged app does not contain", () => {
    buildIfNeeded();

    const { dependencies } = JSON.parse(
      readFileSync(resolve(DESKTOP, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    // electron-builder packages `files` plus production dependencies. A
    // devDependency is a build-time thing and is not in the asar, so an import
    // that resolves in `pnpm test` can still be missing in the shipped app.
    const packaged = new Set(Object.keys(dependencies));

    const unresolvable = BUNDLES.flatMap((bundle) =>
      bareImports(readFileSync(resolve(DESKTOP, bundle), "utf8"))
        .filter(
          (specifier) =>
            !RUNTIME_PROVIDED.has(specifier) &&
            !packaged.has(packageOf(specifier))
        )
        .map((specifier) => `${bundle} → ${specifier}`)
    );

    expect(unresolvable).toEqual([]);
  });
});

describe("the smoke test that launches it", () => {
  const workflow = readFileSync(
    resolve(DESKTOP, "../../.github/workflows/ci.yml"),
    "utf8"
  );
  const marker = /const SMOKE_TEST_READY = "([^"]+)"/.exec(
    readFileSync(resolve(DESKTOP, "src/main/index.ts"), "utf8")
  )?.[1];

  it("greps for the marker this app actually prints", () => {
    // Two files, one string. Drift either way and the smoke test stops being a
    // check: it either fails every build or passes every one.
    expect(marker).toBeTruthy();
    expect(workflow).toContain(marker!);
  });

  it("runs the app in the mode that makes it print one", () => {
    expect(workflow).toContain("ABACUSAI_BOT_SMOKE_TEST=1");
  });

  it("treats a missing marker as a failure, not a pass", () => {
    expect(workflow).toContain("never reported that it started");
  });
});
