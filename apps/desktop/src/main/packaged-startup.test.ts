import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";

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

/** What the main and preload bundles are built from. */
const SOURCES = [
  "src/main",
  "src/preload",
  "../../packages/contract/src",
  "vite.config.ts",
  "package.json",
];

/** The newest modification time under `path` (a file or a directory). */
const newestMtime = (path: string): number => {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path))
    newest = Math.max(newest, newestMtime(join(path, entry)));
  return newest;
};

const sourcesMtime = (): number =>
  Math.max(...SOURCES.map((source) => newestMtime(resolve(DESKTOP, source))));

const bundlesMtime = (): number =>
  Math.min(
    ...BUNDLES.map((bundle) => {
      const file = resolve(DESKTOP, bundle);
      return existsSync(file) ? statSync(file).mtimeMs : 0;
    })
  );

/**
 * Builds when a bundle is missing or older than any source: a `dist` left
 * from before a change proves nothing about that change.
 */
const buildIfStale = (): void => {
  if (bundlesMtime() > sourcesMtime()) return;
  const vite = resolvePackage("vite", DESKTOP);
  if (vite == null) throw new Error("vite is not installed");
  execFileSync(process.execPath, [resolve(vite, "bin/vite.js"), "build"], {
    cwd: DESKTOP,
    stdio: "inherit",
  });
};

/** Where `name` resolves from `from`, the way Node walks up node_modules. */
const resolvePackage = (name: string, from: string): string | undefined => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = resolve(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return dirname(candidate);
    if (dir === dirname(dir)) return undefined;
  }
};

/** Every package electron-builder packs: the production dependency tree. */
const packagedDependencies = (): Set<string> => {
  const packaged = new Set<string>();
  const pending: Array<[string, string]> = Object.keys(
    (
      JSON.parse(readFileSync(resolve(DESKTOP, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies
  ).map((name) => [name, DESKTOP]);
  while (pending.length > 0) {
    const [name, from] = pending.pop()!;
    if (packaged.has(name)) continue;
    const dir = resolvePackage(name, from);
    if (dir == null) continue;
    packaged.add(name);
    const manifest = JSON.parse(
      readFileSync(resolve(dir, "package.json"), "utf8")
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }))
      pending.push([dependency, realpathSync(dir)]);
  }
  return packaged;
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
    // `__require(` too: rolldown's CommonJS shim, which is how a bundled
    // package's own requires come out, and what a `\b` cannot see past.
    /(?:^|[^\w$.])(?:__)?require\(\s*["']([^"'.][^"']*)["']\s*\)/g,
    /\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]!;
      if (!PACKAGE_SPECIFIER.test(specifier)) continue;
      // A usage example in an inlined package's doc comment
      // (` * import { parse } from "partial-json";`) is not an import.
      const lineStart = source.lastIndexOf("\n", match.index) + 1;
      const line = source.slice(lineStart, match.index + 1).trimStart();
      if (line.startsWith("*") || line.startsWith("//")) continue;
      if (specifier.startsWith("node:")) continue;
      if (builtinModules.includes(packageOf(specifier))) continue;
      found.add(specifier);
    }
  }

  return [...found].sort();
};

describe("the packaged bundles", () => {
  it("import nothing the packaged app does not contain", () => {
    buildIfStale();
    // The bundles checked are the ones these sources produce.
    expect(bundlesMtime()).toBeGreaterThan(sourcesMtime());

    // electron-builder packages `files` plus production dependencies and
    // everything they depend on. A devDependency is a build-time thing and is
    // not in the asar, so an import that resolves in `pnpm test` can still be
    // missing in the shipped app; a package inlined from devDependencies still
    // requires its own dependencies at run time, so those must be in the tree.
    const packaged = packagedDependencies();

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
    // A build takes longer than a unit test's default budget.
  }, 600_000);
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
    expect(workflow).toContain("grep -qF '[smoke] renderer ready'");
    expect(workflow).toContain('wait "$pid"');
  });
});
