import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

import { checkDesktopParity } from "./check-desktop-parity.mjs";
export const checkWebBundle = async (
  directory = resolve(import.meta.dirname, "../apps/web/dist")
) => {
  const chunks = JSON.parse(
    readFileSync(
      resolve(directory, "../build-metadata/chunk-sizes.json"),
      "utf8"
    )
  );
  const modules = chunks.flatMap((chunk) =>
    chunk.modules.map((module) => module.id.replaceAll("\\", "/"))
  );
  const web = modules.filter((id) => id.startsWith("<web>/src/"));
  assert.ok(web.length > 100, "Web module guard matched no renderer tree");
  const { assertBrowserImport } = await createJiti(import.meta.url).import(
    "../apps/web/vite.renderer.ts"
  );
  for (const id of modules) assertBrowserImport(id);
  const files = readdirSync(directory, { recursive: true });
  assert.ok(
    !files.some((file) =>
      /(?:\.map$|(?:chunk-sizes|release-build)\.json$)/.test(file)
    ),
    "Private build metadata in browser dist"
  );
  const { classify } = await createJiti(import.meta.url).import(
    "../apps/updater/src/classify.ts"
  );
  const desktop = JSON.parse(
    readFileSync(
      resolve(directory, "../../desktop/dist/renderer/chunk-sizes.json"),
      "utf8"
    )
  );
  assert.ok(
    !desktop
      .flatMap((c) => c.modules)
      .some((m) =>
        /<web>\/src\/(?:features\/shell\/connect\/|platform\/.*\.browser\.)/.test(
          m.id
        )
      ),
    "Browser-only ignored modules in Electron bundle"
  );
  // Query's mutation hooks share one chunk (rendererChunkGroups) that the
  // notch never loads.
  const hooks =
    /[\\/](?:useMutation|useMutationState|mutationObserver)\.[cm]?js$/;
  const mutationChunks = desktop.filter((c) =>
    c.modules.some((m) => hooks.test(m.id))
  );
  assert.equal(
    mutationChunks.length,
    1,
    "Query's mutation hooks split across chunks: check rendererChunkGroups"
  );
  assert.deepEqual(
    mutationChunks[0].modules.map((m) => m.id.split(/[\\/]/).pop()).sort(),
    ["mutationObserver.js", "useMutation.js", "useMutationState.js"],
    "The mutations chunk must hold exactly Query's mutation hooks"
  );
  const byFile = new Map(desktop.map((c) => [c.file, c]));
  const loads = (file, seen = new Set()) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const next of byFile.get(file)?.imports ?? []) loads(next, seen);
    return seen;
  };
  const notch = desktop.find((c) => /(?:^|\/)notch-[^/]*\.js$/.test(c.file));
  assert.ok(notch, "No notch entry chunk in the Electron renderer");
  assert.ok(
    !loads(notch.file).has(mutationChunks[0].file),
    "The notch must not load the mutations chunk"
  );
  for (const module of desktop.flatMap((c) => c.modules)) {
    const path = module.id
      .replace(/^<web>\//, "apps/web/")
      .replace(/^<desktop>\//, "apps/desktop/")
      .replace(/^<contract>\//, "packages/contract/")
      .replace(/^<root>\//, "")
      .split("?")[0];
    if (/^(apps|packages)\//.test(path))
      assert.notEqual(
        classify([path]),
        "none",
        `Classifier ignores shipped module: ${path}`
      );
  }
  const html = readFileSync(resolve(directory, "index.html"), "utf8");
  assert.match(html, /(?:src|href)="\/bot\/assets\//);
  assert.ok(
    !/(?:src|href)="\/assets\//.test(html),
    "Browser assets must use /bot/"
  );
  assert.ok(
    html.indexOf('http-equiv="Content-Security-Policy"') <
      html.indexOf("<script"),
    "CSP must precede scripts"
  );
  assert.match(
    html.replaceAll("&#39;", "'"),
    // Same-origin host proxy; VITE_CONNECT_SRC may append extra sources.
    /connect-src 'self'[ ;]/
  );
  return {
    chunks: chunks.length,
    modules: web.length,
    desktop: checkDesktopParity(
      resolve(directory, "../../desktop/dist/renderer")
    ),
  };
};
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(await checkWebBundle(process.argv[2]));
