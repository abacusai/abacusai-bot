/**
 * Everything the spawned agent imports has to be on disk beside it.
 *
 * The agent is not part of the asar: `extraResources` copies
 * `packages/agent/dist` to `Resources/agent/` and the app spawns `main.js`
 * there as an ordinary Node process. That process resolves bare imports the
 * ordinary way, upwards from its own directory, so it can only ever see
 * `Resources/agent/node_modules`. Nothing in app.asar, and nothing in the
 * repository's own node_modules, is reachable from it.
 *
 * Two ways that has been broken, both of which shipped:
 *
 *   - 1.0.3 shipped `dist/` as tsc output rather than the tsdown bundle. tsc
 *     emits one file per source with every dependency left as a bare import,
 *     so the agent asked for `@earendil-works/pi-coding-agent`. A
 *     devDependency, deliberately never shipped, because the bundler is
 *     supposed to inline it. Every spawn died on ERR_MODULE_NOT_FOUND and the
 *     app could not run a single turn.
 *
 *   - The packages the bundler is told never to inline (they load .node
 *     addons) were not all copied beside the agent. `@earendil-works/pi-tui`
 *     is imported by the chunk every entry point shares, so its absence was
 *     not a missing feature. It was the same total failure to spawn.
 *
 * Neither is visible in a normal test run, a typecheck, or a build that
 * succeeds: the repository's own node_modules resolves all of it, and only the
 * packaged app is missing anything. So this reads what the build actually
 * bundles and what the packaging actually copies, and compares them.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { init, parse } from "es-module-lexer";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const DESKTOP_DIR = path.join(import.meta.dirname, "..", "..");
const REPO_ROOT = path.join(DESKTOP_DIR, "..", "..");
const AGENT_DIST = path.join(REPO_ROOT, "packages", "agent", "dist");
const BUILDER_CONFIG = path.join(DESKTOP_DIR, "electron-builder.yml");

/** `@scope/name/deep/path` -> `@scope/name`; `name/deep` -> `name`. */
const packageOf = (specifier: string): string => {
  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
};

const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith("node:") ||
  builtinModules.includes(packageOf(specifier));

/**
 * Every bare specifier the built agent imports, static and dynamic alike. A
 * dynamic one fails later than a static one rather than less badly. The first
 * time the feature behind it is used, in front of a user.
 */
const bundleImports = async (): Promise<Set<string>> => {
  await init;
  const found = new Set<string>();

  for (const file of fs.readdirSync(AGENT_DIST)) {
    if (!file.endsWith(".js")) continue;

    const source = fs.readFileSync(path.join(AGENT_DIST, file), "utf8");
    const [imports] = parse(source, file);

    for (const entry of imports) {
      const specifier = entry.n;
      if (specifier == null) continue;
      if (specifier.startsWith(".") || path.isAbsolute(specifier)) continue;
      if (isBuiltin(specifier)) continue;

      found.add(packageOf(specifier));
    }
  }

  return found;
};

/** The packages `extraResources` puts under `Resources/agent/node_modules`. */
const shippedPackages = (): Set<string> => {
  const config = parseYaml(fs.readFileSync(BUILDER_CONFIG, "utf8")) as {
    extraResources?: { from?: string; to?: string }[];
  };
  const shipped = new Set<string>();

  for (const entry of config.extraResources ?? []) {
    const to = entry.to?.replace(/\/+$/, "");
    if (to == null) continue;

    const match = /^agent\/node_modules\/(.+)$/.exec(to);
    if (match == null) continue;

    // A scope copied whole (`@ast-grep/`) ships every package inside it.
    const target = match[1]!;
    if (/^@[^/]+$/.test(target)) {
      const from = path.resolve(DESKTOP_DIR, entry.from ?? "");
      for (const name of fs.existsSync(from) ? fs.readdirSync(from) : [])
        shipped.add(`${target}/${name}`);
      continue;
    }

    shipped.add(target);
  }

  return shipped;
};

/** What `name` needs at run time, from its own manifest. */
const dependenciesOf = (name: string): string[] => {
  const manifest = path.join(REPO_ROOT, "node_modules", name, "package.json");
  if (!fs.existsSync(manifest)) return [];

  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
    dependencies?: Record<string, string>;
  };

  return Object.keys(parsed.dependencies ?? {});
};

describe("what the packaged agent can resolve", () => {
  beforeAll(() => {
    // The bundle is the subject, so a stale or missing dist would test nothing.
    if (!fs.existsSync(path.join(AGENT_DIST, "main.js")))
      execFileSync("pnpm", ["--filter", "@abacus-ai/agent", "run", "build"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
  }, 300_000);

  it("bundles the agent rather than emitting it as loose modules", async () => {
    // tsc writing into dist/ is how this last went wrong: one file per source,
    // every dependency bare. The bundle has a handful of entry points and
    // chunks, and imports almost nothing by name.
    const imports = await bundleImports();

    expect(fs.existsSync(path.join(AGENT_DIST, "session.js"))).toBe(false);
    expect(imports).not.toContain("@earendil-works/pi-coding-agent");
  });

  it("ships every package the bundle imports beside the agent", async () => {
    const imports = await bundleImports();
    const shipped = shippedPackages();

    expect([...imports].filter((name) => !shipped.has(name))).toEqual([]);
  });

  it("ships what those packages themselves depend on", () => {
    // Copying a package without its dependencies is the same failure one level
    // down: pi-tui is useless beside the agent without marked.
    const shipped = shippedPackages();
    const missing = [...shipped].flatMap((name) =>
      dependenciesOf(name).filter((dep) => !shipped.has(dep))
    );

    expect(missing).toEqual([]);
  });
});

/**
 * The other half of getting `extraResources` right: not shipping what the
 * agent cannot use. Source maps were 24 MB of the 39 MB copied beside it, and
 * nothing ever read them. The agent is spawned as a plain Node process, with
 * no --enable-source-maps anywhere. The filter is easy to drop during an
 * unrelated edit and impossible to notice, since the app works either way.
 */
describe("what the agent copy leaves behind", () => {
  const agentFilter = (): string[] => {
    const config = parseYaml(fs.readFileSync(BUILDER_CONFIG, "utf8")) as {
      extraResources?: { from?: string; to?: string; filter?: string[] }[];
    };
    const entry = (config.extraResources ?? []).find(
      (candidate) => candidate.to === "agent/"
    );

    return entry?.filter ?? [];
  };

  it.each(["**/*.map", "**/*.d.ts", "**/*.tsbuildinfo", "**/.tsbuildinfo"])(
    "excludes %s",
    (pattern) => {
      expect(agentFilter()).toContain(`!${pattern}`);
    }
  );

  // An exclude-only filter ships nothing at all, which is the same total
  // spawn failure the tests above exist for.
  it("still includes everything else", () => {
    expect(agentFilter()[0]).toBe("**/*");
  });

  it("keeps the entry point the app spawns", () => {
    expect(fs.existsSync(path.join(AGENT_DIST, "main.js"))).toBe(true);
  });
});
