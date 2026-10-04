import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const checkWebBundle = (
  directory = resolve(import.meta.dirname, "../apps/web/dist")
) => {
  const chunks = JSON.parse(
    readFileSync(resolve(directory, "chunk-sizes.json"), "utf8")
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
  const html = readFileSync(resolve(directory, "index.html"), "utf8");
  assert.match(html, /(?:src|href)="\/web\/assets\//);
  assert.ok(
    !/(?:src|href)="\/assets\//.test(html),
    "Browser assets must use /web/"
  );
  return { chunks: chunks.length, modules: web.length };
};
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(checkWebBundle(process.argv[2]));
