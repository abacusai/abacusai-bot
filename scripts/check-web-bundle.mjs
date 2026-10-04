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
  const denied =
    /\/src\/(?:features\/(?:notch\/|sessions\/(?:device|browser)\/|onboarding\/steps\/local-models\.|settings\/updates\.|shell\/native-presenter\.)|lib\/window-chrome\/|components\/(?:device|browser-surface)\/)/;
  assert.deepEqual(
    web.filter((id) => denied.test(id)),
    [],
    "Electron-only modules in browser bundle"
  );
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
    /connect-src 'self' https:\/\/\*\.preview\.apps\.abacus\.ai wss:\/\/\*\.preview\.apps\.abacus\.ai;/
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
