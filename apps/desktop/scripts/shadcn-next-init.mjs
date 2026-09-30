#!/usr/bin/env node
/**
 * shadcn init for renderer-next, without ever running `init` in this package
 * (spec 01 §5.1, F3/F4). `init` with a preset re-infers aliases from the
 * project and writes files before anything could fix them; `add` with an
 * existing components.json infers nothing. So:
 *
 * 1. `init --base base --preset b1D0dv74 --yes` runs once in a throwaway
 *    package with the CLI's own Vite layout, through the registry proxy in
 *    record mode, so the snapshot also holds what init fetched.
 * 2. Its CSS and `cn` helper are transplanted into src/renderer-next.
 * 3. This package's components.json is written from the constant below.
 *
 * Asserts on the way: the preset decoded as expected, init wrote only the
 * expected files, and the dependencies it added are exactly the measured init
 * set of §3.1.
 *
 *   node scripts/shadcn-next-init.mjs [--snapshot <dir>] [--keep]
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { run, startRegistryProxy } from "./shadcn-registry-proxy.mjs";

export const SHADCN_VERSION = "4.21.0";
/** Mira with lucide and translucent menus (Codex r2 #1). */
export const PRESET = "b1D0dv74";

const desktop = join(import.meta.dirname, "..");
const next = join(desktop, "src/renderer-next");

/** The dependencies init adds, measured (§3.1). */
export const INIT_DEPENDENCIES = [
  "@base-ui/react",
  "@fontsource-variable/inter",
  "class-variance-authority",
  "cn",
  "lucide-react",
  "shadcn",
  "tw-animate-css",
];

/** The complete registry dependency set: the write gate's allowlist. */
export const REGISTRY_DEPENDENCIES = [
  ...INIT_DEPENDENCIES,
  "@shadcn/react",
  "cmdk",
  "react-resizable-panels",
];

export const COMPONENTS_JSON = {
  $schema: "https://ui.shadcn.com/schema.json",
  style: "base-mira",
  rsc: false,
  tsx: true,
  tailwind: {
    config: "",
    css: "src/renderer-next/styles/app.css",
    baseColor: "neutral",
    cssVariables: true,
    prefix: "",
  },
  iconLibrary: "lucide",
  rtl: false,
  aliases: {
    components: "#next/components",
    utils: "#next/lib/cn",
    ui: "#next/ui",
    lib: "#next/lib",
    hooks: "#next/lib/hooks",
  },
  menuColor: "default-translucent",
  menuAccent: "subtle",
  registries: {},
};

const shadcnBin = join(desktop, "../../node_modules/.bin/shadcn");

const fail = (message) => {
  console.error(`shadcn-next-init: ${message}`);
  process.exit(1);
};

const listFiles = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)];
  });

const deps = (pkg) =>
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();

const scaffold = (scratch) => {
  const pkg = {
    name: "shadcn-init-scratch",
    private: true,
    type: "module",
    dependencies: { react: "19.3.0", "react-dom": "19.3.0" },
    devDependencies: {
      "@tailwindcss/vite": "^4.3.3",
      tailwindcss: "^4.3.3",
      vite: "^8.2.1",
      "@vitejs/plugin-react": "6.1.1",
      typescript: "^7.0.2",
    },
  };
  writeFileSync(join(scratch, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify(
      {
        files: [],
        references: [{ path: "./tsconfig.app.json" }],
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      },
      null,
      2
    )
  );
  writeFileSync(
    join(scratch, "tsconfig.app.json"),
    JSON.stringify(
      {
        compilerOptions: {
          jsx: "react-jsx",
          baseUrl: ".",
          paths: { "@/*": ["./src/*"] },
        },
        include: ["src"],
      },
      null,
      2
    )
  );
  writeFileSync(
    join(scratch, "vite.config.ts"),
    [
      'import path from "node:path";',
      'import tailwindcss from "@tailwindcss/vite";',
      'import react from "@vitejs/plugin-react";',
      'import { defineConfig } from "vite";',
      "export default defineConfig({",
      "  plugins: [react(), tailwindcss()],",
      '  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },',
      "});",
      "",
    ].join("\n")
  );
  mkdirSync(join(scratch, "src"), { recursive: true });
  writeFileSync(join(scratch, "src/index.css"), '@import "tailwindcss";\n');
  writeFileSync(join(scratch, "src/main.tsx"), 'import "./index.css";\n');
  writeFileSync(
    join(scratch, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n'
  );
};

const main = async () => {
  const args = process.argv.slice(2);
  const snapshotArg = args.indexOf("--snapshot");
  const snapshotDir =
    snapshotArg === -1
      ? null
      : join(process.cwd(), args[snapshotArg + 1] ?? fail("--snapshot <dir>"));
  const replay = args.includes("--replay");

  const scratch = mkdtempSync(join(tmpdir(), "shadcn-init-"));
  scaffold(scratch);
  const before = new Set(listFiles(scratch));
  const beforeDeps = deps(
    JSON.parse(readFileSync(join(scratch, "package.json"), "utf8"))
  );

  const proxy =
    snapshotDir == null
      ? null
      : await startRegistryProxy({
          mode: replay ? "replay" : "record",
          dir: snapshotDir,
          cli: SHADCN_VERSION,
        });

  try {
    const env = {
      ...process.env,
      ...(proxy == null ? {} : { REGISTRY_URL: proxy.url }),
      npm_config_user_agent: "pnpm/12.8.1 npm/? node/? darwin arm64",
    };
    const { values: decoded } = JSON.parse(
      execFileSync(shadcnBin, ["preset", "decode", PRESET, "--json"], {
        cwd: scratch,
        env,
        encoding: "utf8",
      })
    );
    for (const [key, value] of Object.entries({
      style: "mira",
      baseColor: "neutral",
      iconLibrary: "lucide",
      menuColor: "default-translucent",
    }))
      if (decoded[key] !== value)
        fail(
          `preset ${PRESET} decoded ${key}=${decoded[key]}, expected ${value}`
        );

    // Async: the proxy answers from this same event loop.
    await run(
      shadcnBin,
      ["init", "--base", "base", "--preset", PRESET, "--yes"],
      {
        cwd: scratch,
        env,
      }
    );
  } finally {
    await proxy?.close();
  }

  const componentsJson = JSON.parse(
    readFileSync(join(scratch, "components.json"), "utf8")
  );
  for (const [key, value] of Object.entries({
    style: "base-mira",
    iconLibrary: "lucide",
    menuColor: "default-translucent",
    rtl: false,
  }))
    if (componentsJson[key] !== value)
      fail(`init wrote ${key}=${componentsJson[key]}, expected ${value}`);

  const written = listFiles(scratch).filter(
    (file) =>
      !before.has(file) || file === "src/index.css" || file === "package.json"
  );
  const allowed = new Set([
    "components.json",
    "src/index.css",
    "src/lib/utils.ts",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
  ]);
  const unexpected = written.filter((file) => !allowed.has(file));
  if (unexpected.length > 0)
    fail(`init wrote unexpected files: ${unexpected.join(", ")}`);

  const added = deps(
    JSON.parse(readFileSync(join(scratch, "package.json"), "utf8"))
  ).filter((name) => !beforeDeps.includes(name));
  const expected = [...INIT_DEPENDENCIES].sort();
  if (JSON.stringify(added) !== JSON.stringify(expected))
    fail(`init added ${added.join(", ")}; expected ${expected.join(", ")}`);

  const utils = readFileSync(join(scratch, "src/lib/utils.ts"), "utf8");
  if (!utils.includes('from "cn"'))
    fail("src/lib/utils.ts does not re-export cn");

  mkdirSync(join(next, "styles"), { recursive: true });
  mkdirSync(join(next, "lib"), { recursive: true });
  const css = readFileSync(join(scratch, "src/index.css"), "utf8");
  writeFileSync(join(next, "styles/app.css"), postEditCss(css));
  writeFileSync(join(next, "lib/cn.ts"), utils);
  writeFileSync(
    join(desktop, "components.json"),
    `${JSON.stringify(COMPONENTS_JSON, null, 2)}\n`
  );
  console.log(`shadcn-next-init: transplanted from ${scratch}`);
  if (!args.includes("--keep"))
    rmSync(scratch, { recursive: true, force: true });
};

/**
 * §5.1 step 5: scan only renderer-next and pull in our tokens, keeping every
 * line init wrote. Idempotent.
 */
export const postEditCss = (css) => {
  let out = css.replace(
    /^@import "tailwindcss"[^;]*;/m,
    '@import "tailwindcss" source(none);\n@source "../";'
  );
  if (!out.includes('@import "./tokens.css";')) {
    const lines = out.split("\n");
    let lastImport = -1;
    lines.forEach((line, index) => {
      if (line.startsWith("@import ")) lastImport = index;
    });
    lines.splice(lastImport + 1, 0, '@import "./tokens.css";');
    out = lines.join("\n");
  }
  return out;
};

/** The lines §5.1 step 5 requires app.css to keep. */
export const REQUIRED_CSS_LINES = [
  '@import "tailwindcss" source(none);',
  '@source "../";',
  '@import "tw-animate-css";',
  '@import "shadcn/tailwind.css";',
  '@import "@fontsource-variable/inter";',
  '@import "./tokens.css";',
  "@custom-variant dark (&:is(.dark *));",
  "@theme inline {",
  ":root {",
  ".dark {",
  "@layer base {",
];

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(shadcnBin)) fail(`no shadcn binary at ${shadcnBin}`);
  await main();
}
